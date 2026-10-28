import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import semver from 'semver'
import { assertDirectory, atomicWrite, exists, json, writeJson } from './core'
import { command, powershell, where } from './system'
import { download } from './network'
import catalog from '../shared/tts-catalog.json'
import { downloadModelScript, synthesizeScript } from './tts-scripts'
import type { Settings, TtsGpu, TtsPlan, TtsScan } from '../shared/types'

export const ttsSteps = [
  { id: 'tts-scan', title: '重新扫描设备与独立安装目录' },
  { id: 'tts-runtime', title: '安装独立 Python 3.12 环境' },
  { id: 'tts-packages', title: '安装 PyTorch 与 Qwen3-TTS 依赖' },
  { id: 'tts-model', title: '下载固定版本模型并校验 SHA-256' },
  { id: 'tts-verify', title: '离线加载模型、生成测试语音与接入说明' },
]
const markerName = '.qqdsh-tts.json'
const GiB = 1024 ** 3

function within(parent: string, child: string): boolean {
  const rel = path.relative(parent.toLowerCase(), child.toLowerCase())
  return !rel || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}
async function canonical(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error
    const parent = path.dirname(target)
    if (parent === target) throw error
    return path.join(await canonical(parent), path.basename(target))
  }
}
export async function validateTtsRoot(s: Settings, dataRoot: string): Promise<string> {
  const root = assertDirectory(s.ttsRoot)
  if (/["%\r\n]/.test(root) || root.startsWith('\\\\'))
    throw new Error('语音模型请选择不含引号、百分号的本机独立目录')
  const resolved = await canonical(root)
  const data = await canonical(path.resolve(dataRoot))
  if (within(resolved, data)) throw new Error('语音模型目录不能覆盖助手数据目录')
  const protectedPaths = [
    s.installRoot,
    s.dshHome,
    s.bridgePath,
    s.snowlumaPath,
    ...[s.harnessPath, s.nodePath, s.pwshPath, s.qqPath]
      .filter(Boolean)
      .map((p) => path.dirname(p)),
  ]
  for (const item of protectedPaths.filter(Boolean)) {
    const protectedRoot = await canonical(path.resolve(item))
    if (within(protectedRoot, resolved) || within(resolved, protectedRoot))
      throw new Error('语音模型目录必须独立于已有组件与 dsh 数据目录，不能相同或互相包含')
  }
  // Reject junctions inside a managed deployment too, before executing any tools there.
  if (await exists(root)) {
    const marker = await json(path.join(root, markerName))
    const entries = await fs.readdir(root)
    if (entries.length && (marker?.owner !== 'qqdsh-tts' || marker?.modelId !== catalog.modelId))
      throw new Error('语音目录已有非助手管理的内容，请选择新的空目录')
    for (const entry of [
      'tools',
      'runtime',
      '.venv',
      'model',
      'cache',
      'tmp',
      'model/speech_tokenizer',
      '.venv/Scripts',
      'tools/uv.exe',
      '.venv/Scripts/python.exe',
      markerName,
      'runtime.json',
      'model-manifest.json',
      'constraints.txt',
      'requirements-resolved.txt',
      'download-model.py',
      'synthesize.py',
      'README.md',
      'sample.wav',
    ]) {
      const child = path.join(root, entry)
      if (!(await exists(child))) continue
      if ((await fs.lstat(child)).isSymbolicLink() || !within(resolved, await fs.realpath(child)))
        throw new Error('语音目录含外部链接，请选择新的独立目录')
    }
    if (marker?.state === 'ready')
      throw new Error('此目录已有完成的语音部署，已保留。重新部署请选择新的空目录')
  }
  return root
}

export function parseNvidia(raw: string): TtsGpu[] {
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      const fields = line.split(',').map((v) => v.trim())
      if (fields.length !== 6) return []
      const [index, name, memory, free, driver, compute] = fields
      const gpu = {
        index: Number(index),
        name,
        memoryMiB: Number(memory),
        freeMiB: Number(free),
        driver,
        compute: Number(compute),
      }
      return [gpu.index, gpu.memoryMiB, gpu.freeMiB, gpu.compute].every(Number.isFinite) &&
        gpu.index >= 0 &&
        gpu.memoryMiB > 0
        ? [gpu]
        : []
    })
}
export function assessTts(scan: TtsScan): TtsScan {
  if (scan.platform !== 'win32' || scan.arch !== 'x64')
    scan.blockers.push('当前仅支持 Windows x64 原生部署')
  if (scan.ramGiB < 16) scan.blockers.push('内存不足 16 GiB，低于助手的保守部署阈值')
  if (scan.diskFreeGiB === undefined) scan.blockers.push('无法确认目标磁盘剩余空间，请检查目录权限')
  else if (scan.diskFreeGiB < 25)
    scan.blockers.push('目标磁盘可用空间不足 25 GiB，无法容纳环境、权重和安装缓存')
  const compatible = scan.gpus
    .filter(
      (g) =>
        g.memoryMiB >= 8192 &&
        g.compute >= 7 &&
        semver.gte(semver.coerce(g.driver) || '0.0.0', '572.61.0'),
    )
    .sort((a, b) => b.freeMiB - a.freeMiB)
  const gpu = compatible[0]
  if (scan.mode === 'auto') {
    if (!gpu)
      scan.blockers.push(
        '未发现满足助手建议的 NVIDIA GPU（显存 ≥8 GiB、计算能力 ≥7.0、驱动 ≥572.61）；可更新驱动或显式选择 CPU 模式重新扫描',
      )
    else {
      scan.device = `cuda:${gpu.index}`
      if (gpu.freeMiB < 7168)
        scan.blockers.push('所选 GPU 当前空闲显存不足 7 GiB，请关闭占用显卡的程序后重新扫描')
      if (gpu.memoryMiB < 12288)
        scan.warnings.push('显存低于 12 GiB，长文本可能耗尽显存；请分段合成')
    }
  } else {
    scan.device = 'cpu'
    if (scan.ramGiB < 24) scan.blockers.push('CPU 模式建议至少 24 GiB 内存，当前低于助手部署阈值')
    scan.warnings.push('CPU 模式采用 float32，合成可能非常慢；不保证实时语音体验')
  }
  if (scan.availableRamGiB < 8) scan.blockers.push('当前可用内存不足 8 GiB，请关闭其他程序后重试')
  scan.warnings.push(
    '硬件阈值为助手保守部署策略，并非官方最低要求；实际可用性以最后的模型加载与短语音测试为准',
  )
  return scan
}

export async function scanTts(s: Settings, dataRoot: string): Promise<TtsPlan> {
  const scan: TtsScan = {
    scannedAt: new Date().toISOString(),
    root: s.ttsRoot,
    mode: s.ttsMode,
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus()[0]?.model || '未知',
    ramGiB: os.totalmem() / GiB,
    availableRamGiB: os.freemem() / GiB,
    gpus: [],
    device: 'cpu',
    blockers: [],
    warnings: [],
    installed: false,
    installationDetail: '尚未完成部署',
  }
  const marker = await json(path.join(s.ttsRoot, markerName)).catch(() => null)
  if (marker?.owner === 'qqdsh-tts' && marker?.state === 'ready') {
    scan.installed = true
    scan.installationDetail = '部署记录显示已通过离线短语音测试；运行入口见目录内 README.md'
  } else if (marker?.owner === 'qqdsh-tts')
    scan.installationDetail = '上次部署未完成，可重新扫描后复用下载继续安装'
  try {
    await validateTtsRoot(s, dataRoot)
  } catch (e: any) {
    scan.blockers.push(e.message)
  }
  let ancestor = path.resolve(s.ttsRoot)
  while (!(await exists(ancestor)) && path.dirname(ancestor) !== ancestor)
    ancestor = path.dirname(ancestor)
  try {
    const disk = await fs.statfs(ancestor)
    scan.diskFreeGiB = (disk.bavail * disk.bsize) / GiB
    // Access check without creating any files during the read-only scan.
    await fs.access(ancestor, fs.constants.W_OK)
  } catch {
    scan.blockers.push('目标目录不可写或无法读取磁盘信息')
  }
  const nvidia =
    (await where('nvidia-smi.exe'))[0] ||
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/nvidia-smi.exe')
  try {
    scan.gpus = parseNvidia(
      await command(
        nvidia,
        [
          '--query-gpu=index,name,memory.total,memory.free,driver_version,compute_cap',
          '--format=csv,noheader,nounits',
        ],
        { timeout: 10000 },
      ),
    )
  } catch {
    scan.warnings.push('NVIDIA 驱动检测未成功；AMD / Intel GPU 暂不自动配置加速')
  }
  return {
    scan: assessTts(scan),
    modelId: catalog.modelId,
    revision: catalog.revision,
    downloadGiB: catalog.files.reduce((n, file) => n + file.bytes, 0) / GiB,
    sources: [
      catalog.uv.url,
      'https://github.com/astral-sh/python-build-standalone',
      'https://pypi.org/project/qwen-tts/0.1.1/',
      'https://download.pytorch.org/whl/',
      `https://huggingface.co/${catalog.modelId}/tree/${catalog.revision}`,
    ],
    steps: ttsSteps,
  }
}

export function ttsEnvironment(root: string, proxy: string): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) =>
        !/^(UV_|PIP_|PYTHON|HF_|HUGGING|TRANSFORMERS_|VIRTUAL_ENV$|CONDA|CUDA_VISIBLE_DEVICES$)/i.test(
          key,
        ),
    ),
  )
  return {
    ...env,
    UV_NO_CONFIG: '1',
    UV_NATIVE_TLS: 'true',
    UV_CACHE_DIR: path.join(root, 'cache/uv'),
    UV_PYTHON_INSTALL_DIR: path.join(root, 'runtime'),
    UV_PYTHON_INSTALL_BIN: '0',
    UV_PYTHON_INSTALL_REGISTRY: '0',
    PYTHONUTF8: '1',
    PYTHONNOUSERSITE: '1',
    HF_HOME: path.join(root, 'cache/huggingface'),
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_XET: '1',
    TMP: path.join(root, 'tmp'),
    TEMP: path.join(root, 'tmp'),
    ...(proxy ? { HTTPS_PROXY: proxy, HTTP_PROXY: proxy } : {}),
  }
}

export async function installTtsStage(
  id: string,
  s: Settings,
  dataRoot: string,
  device: string,
  signal: AbortSignal,
  log: (s: string) => void,
  progress: (n: number) => void,
): Promise<void> {
  const root = await validateTtsRoot(s, dataRoot)
  signal.throwIfAborted()
  await fs.mkdir(root, { recursive: true })
  await writeJson(path.join(root, markerName), {
    owner: 'qqdsh-tts',
    modelId: catalog.modelId,
    revision: catalog.revision,
    state: 'installing',
  })
  for (const dir of ['tools', 'cache', 'tmp'])
    await fs.mkdir(path.join(root, dir), { recursive: true })
  const uv = path.join(root, 'tools/uv.exe')
  const python = path.join(root, '.venv/Scripts/python.exe')
  const env = ttsEnvironment(root, s.proxy)
  const options = { cwd: root, env, signal, timeout: 3600000, onLine: log }
  if (id === 'tts-runtime') {
    const archive = path.join(root, 'cache/uv.zip')
    await download(catalog.uv.url, archive, catalog.uv.sha256, s.proxy, signal, progress)
    // Fixed signed-by-digest archive with a known uv.exe entry; no arbitrary extraction paths.
    await powershell(
      'Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::OpenRead($env:QQDSH_ARCHIVE); try { $entry=$zip.GetEntry("uv.exe"); if(-not $entry) { throw "uv.exe missing" }; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$env:QQDSH_UV,$true) } finally { $zip.Dispose() }',
      { QQDSH_ARCHIVE: archive, QQDSH_UV: uv },
    )
    signal.throwIfAborted()
    await command(uv, ['python', 'install', catalog.python, '--no-bin', '--no-registry'], options)
    const base = await command(
      uv,
      ['python', 'find', '--managed-python', '--system', catalog.python],
      {
        ...options,
        onLine: undefined,
      },
    )
    if (!within(path.join(root, 'runtime'), path.resolve(base)))
      throw new Error('Python 路径不属于独立语音环境')
    if (!(await exists(python)))
      await command(uv, ['venv', '--python', base, path.join(root, '.venv')], options)
  } else if (id === 'tts-packages') {
    const index = `https://download.pytorch.org/whl/${device === 'cpu' ? 'cpu' : 'cu128'}`
    await command(
      uv,
      [
        'pip',
        'install',
        '--python',
        python,
        '--index-url',
        index,
        `torch==${catalog.torch}`,
        `torchaudio==${catalog.torchaudio}`,
      ],
      options,
    )
    await atomicWrite(
      path.join(root, 'constraints.txt'),
      `torch==${catalog.torch}\ntorchaudio==${catalog.torchaudio}\nhuggingface-hub==${catalog.huggingfaceHub}\n`,
    )
    await command(
      uv,
      [
        'pip',
        'install',
        '--python',
        python,
        '--index-url',
        'https://pypi.org/simple',
        '--constraint',
        path.join(root, 'constraints.txt'),
        `qwen-tts==${catalog.qwenTts}`,
        `huggingface-hub==${catalog.huggingfaceHub}`,
      ],
      options,
    )
    await command(uv, ['pip', 'check', '--python', python], options)
    const resolved = await command(uv, ['pip', 'freeze', '--python', python], {
      ...options,
      onLine: undefined,
    })
    await atomicWrite(path.join(root, 'requirements-resolved.txt'), resolved + '\n')
  } else if (id === 'tts-model') {
    await writeJson(path.join(root, 'model-manifest.json'), catalog)
    await atomicWrite(path.join(root, 'download-model.py'), downloadModelScript)
    await command(python, [path.join(root, 'download-model.py')], options)
  } else if (id === 'tts-verify') {
    await writeJson(path.join(root, 'runtime.json'), {
      modelId: catalog.modelId,
      revision: catalog.revision,
      device,
      attention: 'sdpa',
      automaticIntegration: false,
    })
    await atomicWrite(path.join(root, 'synthesize.py'), synthesizeScript)
    await command(python, [path.join(root, 'synthesize.py')], {
      ...options,
      env: { ...env, HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' },
    })
    signal.throwIfAborted()
    if ((await fs.stat(path.join(root, 'sample.wav'))).size <= 44)
      throw new Error('测试语音为空，部署未通过验收')
    await atomicWrite(path.join(root, 'README.md'), ttsReadme(root, device))
    await writeJson(path.join(root, markerName), {
      owner: 'qqdsh-tts',
      modelId: catalog.modelId,
      revision: catalog.revision,
      state: 'ready',
      verifiedAt: new Date().toISOString(),
      device,
      acceptance: 'offline-short-synthesis',
      python: catalog.python,
      qwenTts: catalog.qwenTts,
      torch: catalog.torch,
    })
  } else throw new Error('未知语音部署步骤')
}

export function ttsReadme(root: string, device: string): string {
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'"
  return `# 本地语音部署交接\n\n模型：${catalog.modelId}\n\n模型提交：${catalog.revision}\n\n运行设备：${device}；注意力：SDPA；CPU float32，GPU 自动选择 bf16/fp16。\n\n此目录独立于 QQ 组件与 dsh。助手仅完成部署与短音频验证，未注册服务、未开启端口、未改写 dsh 或桥接配置。\n\n## 交给已部署的 dsh\n\n请在 dsh 中提供本 README 路径，让 dsh 根据实际 QQ 鱼接入方式调用下方 Python 入口。不存在预先配置的 HTTP API。不要将本地路径当作语音服务 URL。\n\nPowerShell 调用示例（输入 UTF-8 文本文件，输出 WAV）：\n\n\`\`\`powershell\n& ${quote(path.join(root, '.venv/Scripts/python.exe'))} ${quote(path.join(root, 'synthesize.py'))} --text-file ${quote(path.join(root, 'input.txt'))} --output ${quote(path.join(root, 'output.wav'))} --speaker Vivian --language Chinese\n\`\`\`\n\n先创建 input.txt 并写入待朗读内容。调用程序时用独立参数数组传入路径和内容，避免拼接聊天内容到 shell 命令。支持 --instruct、--speaker、--language；默认最多生成 256 个 token，长文本请分段，每次调用会重新加载模型。不要并发启动多个推理进程。\n\n试听 sample.wav 可检查部署时生成的短音频；这不代表 QQ 消息链路或 dsh 接入已通过测试。\n\nruntime.json 保存设备配置；requirements-resolved.txt 记录实际依赖。模型加载强制离线，模型权重和语音 tokenizer 已 SHA-256 校验。重新部署请使用新的空目录，保留旧环境。\n\n官方项目：https://github.com/QwenLM/Qwen3-TTS\n\n模型：https://huggingface.co/${catalog.modelId}\n\n模型与 Qwen3-TTS 使用 Apache-2.0 许可，其余组件遵循各自许可。\n`
}
