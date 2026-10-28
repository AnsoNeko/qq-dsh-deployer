import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/main/store'
import { Engine } from '../src/main/engine'
import { json, writeJson } from '../src/main/core'
import * as tts from '../src/main/tts'
import * as system from '../src/main/system'
import catalog from '../src/shared/tts-catalog.json'
import type { TtsPlan, TtsScan } from '../src/shared/types'

let root: string
let store: Store
let engine: Engine
const healthy = (): TtsScan => ({
  scannedAt: new Date().toISOString(),
  root: store.settings.ttsRoot,
  mode: store.settings.ttsMode,
  platform: 'win32',
  arch: 'x64',
  cpu: 'fixture',
  ramGiB: 32,
  availableRamGiB: 20,
  diskFreeGiB: 100,
  device: 'cpu',
  blockers: [],
  warnings: [],
  gpus: [
    {
      index: 1,
      name: 'NVIDIA fixture',
      memoryMiB: 16384,
      freeMiB: 12000,
      driver: '580.10',
      compute: 8.9,
    },
  ],
  installed: false,
  installationDetail: 'fixture',
})
const plan = (): TtsPlan => ({
  scan: tts.assessTts(healthy()),
  modelId: catalog.modelId,
  revision: catalog.revision,
  downloadGiB: 4.2,
  sources: [],
  steps: tts.ttsSteps,
})

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-tts-'))
  store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  engine = new Engine(
    store,
    {},
    () => {},
    async () => {},
  )
  await engine.init()
  store.settings.dshHome = path.join(root, 'dsh')
})
afterEach(async () => {
  engine.cancel()
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 120))
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-tts-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})

describe('TTS device assessment and directory isolation', () => {
  it('selects an actual GPU index and rejects busy GPU, old driver, unknown disk and ARM', () => {
    expect(tts.assessTts(healthy())).toMatchObject({ device: 'cuda:1', blockers: [] })
    const busy = healthy()
    busy.gpus[0].freeMiB = 1024
    expect(tts.assessTts(busy).blockers.join()).toContain('空闲显存')
    const old = healthy()
    old.gpus[0].driver = '551.00'
    expect(tts.assessTts(old).blockers.join()).toContain('NVIDIA')
    const disk = healthy()
    delete disk.diskFreeGiB
    disk.arch = 'arm64'
    expect(tts.assessTts(disk).blockers).toHaveLength(2)
  })
  it('never silently falls back to CPU and requires enough free RAM for explicit CPU mode', () => {
    const noGpu = healthy()
    noGpu.gpus = []
    expect(tts.assessTts(noGpu).blockers.join()).toContain('显式选择 CPU')
    const cpu = healthy()
    cpu.mode = 'cpu'
    cpu.gpus = []
    expect(tts.assessTts(cpu)).toMatchObject({ device: 'cpu', blockers: [] })
    const low = healthy()
    low.mode = 'cpu'
    low.ramGiB = 16
    low.availableRamGiB = 4
    expect(tts.assessTts(low).blockers).toHaveLength(2)
  })
  it('ignores malformed nvidia-smi values instead of treating unknown memory as valid', () => {
    expect(
      tts.parseNvidia(
        '0, RTX fixture, 16384, 10000, 580.10, 8.9\n1, bad, [N/A], 9, 580.10, 8.9\nerror',
      ),
    ).toHaveLength(1)
  })
  it('uses a separate default and does not create the model directory while scanning', async () => {
    vi.spyOn(system, 'where').mockResolvedValue([])
    vi.spyOn(system, 'command').mockRejectedValue(new Error('no NVIDIA'))
    const result = await tts.scanTts(store.settings, root)
    expect(result.scan.root).toBe(path.join(root, 'advanced/qwen3-tts'))
    expect(await fs.stat(result.scan.root).catch(() => null)).toBeNull()
  })
  it.each(['installRoot', 'dshHome', 'bridgePath', 'snowlumaPath'] as const)(
    'rejects overlapping %s paths in both directions',
    async (key) => {
      store.settings[key] = path.join(root, 'protected')
      store.settings.ttsRoot = path.join(root, 'protected/tts')
      await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('独立')
      store.settings.ttsRoot = path.join(root, 'protected')
      store.settings[key] = path.join(root, 'protected/nested')
      await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('独立')
    },
  )
  it('preserves arbitrary existing files and completed installations', async () => {
    await fs.mkdir(store.settings.ttsRoot, { recursive: true })
    const file = path.join(store.settings.ttsRoot, 'my-data.txt')
    await fs.writeFile(file, 'preserve')
    await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('非助手管理')
    await writeJson(path.join(store.settings.ttsRoot, '.qqdsh-tts.json'), {
      owner: 'qqdsh-tts',
      modelId: catalog.modelId,
      state: 'ready',
    })
    await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('已有完成')
    expect(await fs.readFile(file, 'utf8')).toBe('preserve')
  })
  it('resolves directory junctions before checking overlap', async () => {
    await fs.mkdir(store.settings.installRoot, { recursive: true })
    const alias = path.join(root, 'alias')
    await fs.symlink(store.settings.installRoot, alias, 'junction')
    store.settings.ttsRoot = path.join(alias, 'tts')
    await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('独立')
    await fs.unlink(alias)
  })
  it('rejects linked managed model subdirectories before downloading into them', async () => {
    await fs.mkdir(path.join(store.settings.ttsRoot, 'model'), { recursive: true })
    await writeJson(path.join(store.settings.ttsRoot, '.qqdsh-tts.json'), {
      owner: 'qqdsh-tts',
      modelId: catalog.modelId,
      state: 'installing',
    })
    const outside = path.join(root, 'outside')
    await fs.mkdir(outside)
    const alias = path.join(store.settings.ttsRoot, 'model/speech_tokenizer')
    await fs.symlink(outside, alias, 'junction')
    await expect(tts.validateTtsRoot(store.settings, root)).rejects.toThrow('外部链接')
    await fs.unlink(alias)
  })
})

describe('independent TTS task lifecycle', () => {
  it('requires a successful current scan, acknowledgement and unexpired settings', async () => {
    await expect(engine.deployTts(true)).rejects.toThrow('先扫描')
    vi.spyOn(tts, 'scanTts').mockImplementation(async () => plan())
    await engine.scanTts()
    await expect(engine.deployTts(false)).rejects.toThrow('确认')
    store.settings.ttsMode = 'cpu'
    await expect(engine.deployTts(true)).rejects.toThrow('先扫描')
    await engine.scanTts()
    ;(engine as any).ttsPlan.scan.scannedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    await expect(engine.deployTts(true)).rejects.toThrow('有效期')
  })
  it('rescans at execution, prevents overlap and never synchronizes bridge or dsh', async () => {
    vi.spyOn(tts, 'scanTts').mockImplementation(async () => plan())
    const install = vi.spyOn(tts, 'installTtsStage').mockResolvedValue(undefined)
    const synchronize = vi.spyOn(engine as any, 'applyDetectedEnvironment')
    const bridge = path.join(root, 'bridge/config.json')
    const dsh = path.join(root, 'dsh/profiles/desktop/cordis.patch.yml')
    await writeJson(bridge, { preserved: 'bridge' })
    await fs.mkdir(path.dirname(dsh), { recursive: true })
    await fs.writeFile(dsh, 'preserved dsh')
    await engine.scanTts()
    await engine.deployTts(true)
    await expect(engine.deployTts(true)).rejects.toThrow('已有任务')
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(install.mock.calls.map((args) => args[0])).toEqual(
      tts.ttsSteps.slice(1).map((step) => step.id),
    )
    expect(tts.scanTts).toHaveBeenCalledTimes(3)
    expect(synchronize).not.toHaveBeenCalled()
    expect(await json(bridge)).toEqual({ preserved: 'bridge' })
    expect(await fs.readFile(dsh, 'utf8')).toBe('preserved dsh')
  })
  it('stops before downloads when available hardware changes after preview', async () => {
    const scan = vi.spyOn(tts, 'scanTts').mockResolvedValueOnce(plan())
    const blocked = plan()
    blocked.scan.blockers.push('GPU now busy')
    scan.mockResolvedValue(blocked)
    const install = vi.spyOn(tts, 'installTtsStage').mockResolvedValue(undefined)
    await engine.scanTts()
    await engine.deployTts(true)
    await vi.waitFor(() => expect(engine.task?.state).toBe('failed'))
    expect(install).not.toHaveBeenCalled()
    expect(engine.task?.error).toContain('GPU now busy')
  })
  it('cancels an installation and retries with a fresh scan and all verification steps', async () => {
    vi.spyOn(tts, 'scanTts').mockImplementation(async () => plan())
    const install = vi
      .spyOn(tts, 'installTtsStage')
      .mockImplementationOnce(async (_id, _s, _r, _d, signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }),
        )
      })
      .mockResolvedValue(undefined)
    await engine.scanTts()
    await engine.deployTts(true)
    await vi.waitFor(() => expect(install).toHaveBeenCalledOnce())
    engine.cancel()
    await vi.waitFor(() => expect(engine.task?.state).toBe('cancelled'))
    await engine.retry()
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(install.mock.calls.at(-1)?.[0]).toBe('tts-verify')
  })
  it('records success only after actual nonempty sample generation', async () => {
    vi.spyOn(system, 'command').mockRejectedValueOnce(new Error('CUDA failed'))
    await expect(
      tts.installTtsStage(
        'tts-verify',
        store.settings,
        root,
        'cuda:1',
        new AbortController().signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow('CUDA failed')
    expect((await json(path.join(store.settings.ttsRoot, '.qqdsh-tts.json'))).state).toBe(
      'installing',
    )
    vi.mocked(system.command).mockImplementation(async () => {
      await fs.writeFile(path.join(store.settings.ttsRoot, 'sample.wav'), Buffer.alloc(100))
      return 'generated'
    })
    await tts.installTtsStage(
      'tts-verify',
      store.settings,
      root,
      'cpu',
      new AbortController().signal,
      () => {},
      () => {},
    )
    expect((await json(path.join(store.settings.ttsRoot, '.qqdsh-tts.json'))).state).toBe('ready')
    expect(await fs.readFile(path.join(store.settings.ttsRoot, 'README.md'), 'utf8')).toContain(
      '不存在预先配置的 HTTP API',
    )
  })
})
