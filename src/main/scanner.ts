import fs from 'node:fs/promises'
import path from 'node:path'
import semver from 'semver'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
import { cleanVersion, compatible, exists, json, readOneBot } from './core'
import { command, fileVersion, findFile, harnessPorts, inventory, processes, where } from './system'
import { localRpc, probeBridge, probeOneBot, probeWs, remoteJson } from './network'
import { readBridgeLogin } from './bridge'
import type { Candidate, ComponentId, ComponentResult, Settings } from '../shared/types'

const names: Record<ComponentId, string> = {
  node: 'Node.js',
  npm: 'npm',
  git: 'Git',
  powershell: 'PowerShell 7',
  qq: 'QQ 客户端',
  harness: 'Harness 桌面版',
  snowluma: 'SnowLuma',
  bridge: 'QQ Bridge',
  plugins: 'Preset 与 MCP',
}
export class Scanner {
  results: ComponentResult[] = []
  discovered = { node: '', harness: '', snowluma: '', bridge: '', qq: '', dshUrl: '' }
  constructor(
    private log: (s: string) => void,
    private secrets: () => { httpToken?: string; wsToken?: string },
  ) {}
  async scan(s: Settings): Promise<ComponentResult[]> {
    const [regs, all] = await Promise.all([
      inventory().catch((e) => {
        this.log(`注册表检测受限：${e.message}`)
        return []
      }),
      processes().catch((e) => {
        this.log(`进程检测受限：${e.message}`)
        return []
      }),
    ])
    const root = s.installRoot
    const local = process.env.LOCALAPPDATA || ''
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const candidates: Record<string, Candidate[]> = {}
    const gather = async (
      id: string,
      supplied: string,
      proposed: string[],
      fileNames?: string[],
    ) => {
      const arr: Candidate[] = []
      for (const item of [supplied, ...proposed]) {
        if (!item) continue
        const resolved =
          fileNames && !(await fs.stat(item).catch(() => null))?.isFile()
            ? await findFile(item, fileNames, 1)
            : (await exists(item))
              ? item
              : null
        if (resolved && !arr.some((v) => v.path.toLowerCase() === resolved.toLowerCase()))
          arr.push({
            path: resolved,
            evidence: item === supplied ? '手动选择 / 已保存' : '安装目录 / 注册表 / PATH / 进程',
          })
      }
      candidates[id] = arr
      return arr[0]?.path || ''
    }
    const node = await gather('node', s.nodePath, [
      path.join(root, 'node/node.exe'),
      ...(await where('node.exe')),
    ])
    const harness = await gather(
      'harness',
      s.harnessPath,
      [
        ...all.filter((p) => /harness|deepseek/i.test(p.name)).map((p) => p.path),
        ...regs.filter((v) => /harness/i.test(v.name)).map((v) => v.path),
        path.join(local, 'Programs/DeepSeek Harness'),
        path.join(local, 'Programs/deepseek-harness'),
        path.join(pf, 'DeepSeek Harness'),
      ],
      ['DeepSeek Harness.exe', 'deepseek-harness.exe', 'Harness.exe'],
    )
    const qq = await gather(
      'qq',
      s.qqPath,
      [
        ...all.filter((p) => /^qq.exe$/i.test(p.name)).map((p) => p.path),
        ...regs.filter((v) => /^QQ|腾讯QQ/i.test(v.name)).map((v) => v.path),
        path.join(pf, 'Tencent/QQNT'),
        path.join(pf, 'Tencent/QQ'),
      ],
      ['QQ.exe'],
    )
    const snowLauncher = await gather(
      'snowluma',
      s.snowlumaPath,
      [path.join(root, 'snowluma'), process.env.SNOWLUMA_HOME || '', 'C:\\SnowLuma'],
      ['launcher.bat'],
    )
    const snow = snowLauncher ? path.dirname(snowLauncher) : ''
    const bridgeFile = await gather(
      'bridge',
      s.bridgePath,
      [path.join(root, 'qq-bridge')],
      ['src/bridge.js'],
    )
    const bridge = bridgeFile ? path.dirname(path.dirname(bridgeFile)) : ''
    candidates.snowluma = (candidates.snowluma || []).map((c) => ({
      ...c,
      path: path.dirname(c.path),
    }))
    candidates.bridge = (candidates.bridge || []).map((c) => ({
      ...c,
      path: path.dirname(path.dirname(c.path)),
    }))
    this.discovered = { node, harness, qq, snowluma: snow, bridge, dshUrl: '' }
    const result: ComponentResult[] = []
    const add = (id: ComponentId, data: Partial<ComponentResult>) =>
      result.push({
        id,
        name: names[id],
        state: 'missing',
        detail: '未发现安装，可手动指定路径',
        evidence: [],
        candidates: candidates[id] || [],
        ...data,
      })
    let nv: string | undefined
    if (node) {
      try {
        nv = cleanVersion(await command(node, ['--version'], { timeout: 6000 }))
        add('node', {
          path: node,
          version: nv,
          state: nv && semver.gte(nv, '22.13.0') ? 'ok' : 'error',
          detail:
            nv && semver.gte(nv, '22.13.0')
              ? '满足桥接运行要求（≥22.13）'
              : '版本低于桥接要求，建议安装专用运行时',
          evidence: ['node --version'],
        })
      } catch (e: any) {
        add('node', { path: node, state: 'error', detail: e.message })
      }
    } else add('node', {})
    const npmCli = node ? path.join(path.dirname(node), 'node_modules/npm/bin/npm-cli.js') : ''
    if (await exists(npmCli)) {
      try {
        add('npm', {
          path: npmCli,
          version: cleanVersion(await command(node, [npmCli, '--version'], { timeout: 7000 })),
          state: 'ok',
          detail: '可用于安装桥接依赖',
          evidence: ['与所选 Node.js 配套的 npm'],
        })
      } catch (e: any) {
        add('npm', { state: 'error', detail: e.message })
      }
    } else add('npm', {})
    const git = (await where('git.exe'))[0]
    add(
      'git',
      git
        ? {
            path: git,
            version: cleanVersion(await command(git, ['--version']).catch(() => '')),
            state: 'ok',
            detail: '可选依赖；部署使用归档文件，无需 Git',
            optional: true,
          }
        : { optional: true, detail: '可选依赖；归档部署不需要安装 Git' },
    )
    add(
      'qq',
      qq
        ? {
            path: qq,
            version: cleanVersion(await fileVersion(qq)),
            state: all.some((p) => p.path?.toLowerCase() === qq.toLowerCase())
              ? 'waiting'
              : 'stopped',
            detail: '客户端已发现；登录状态以 OneBot 检查为准',
            evidence: ['客户端文件版本 / 进程路径'],
          }
        : {},
    )
    const pwsh = await gather('powershell', s.pwshPath, [
      path.join(root, 'powershell7/pwsh.exe'),
      ...(await where('pwsh.exe')),
      path.join(pf, 'PowerShell/7/pwsh.exe'),
    ])
    if (pwsh) {
      try {
        const version = cleanVersion(
          await command(
            pwsh,
            ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'],
            { timeout: 8000 },
          ),
        )
        add('powershell', {
          path: pwsh,
          version,
          state: version && semver.gte(version, '7.0.0') ? 'ok' : 'error',
          optional: true,
          detail: '可供 AI 和终端通过 pwsh 调用；已启动的 AI 需重启后继承 PATH',
          evidence: ['$PSVersionTable.PSVersion'],
        })
      } catch (e: any) {
        add('powershell', { path: pwsh, state: 'error', detail: e.message, optional: true })
      }
    } else
      add('powershell', {
        optional: true,
        detail: '可选增强：安装 PowerShell 7，方便 AI 使用 pwsh',
      })
    let hv = harness ? cleanVersion(await fileVersion(harness)) : undefined
    if (harness) {
      const ports: number[] = await harnessPorts(harness, all).catch((): number[] => [])
      let live = false
      let problem = ''
      const home = s.dshHome
      const cred = await fs.readFile(path.join(home, '.credentials.yaml'), 'utf8').catch(() => '')
      // Authentication is delegated to upstream's client, never guessed from old launch logs.
      for (const url of [...new Set([...ports.map((p) => `http://127.0.0.1:${p}`), s.dshUrl])]) {
        try {
          const api = await loadBridgeApi(bridge, home, url)
          if (!api) {
            if (ports.includes(Number(new URL(url).port))) {
              this.discovered.dshUrl = url
              problem = cred
                ? '已发现端口，安装桥接后验证 API 身份'
                : '服务已发现，等待 Harness 完成首次登录'
            }
            continue
          }
          const presets = await api.agentPresets.list()
          if (!presets) continue
          this.discovered.dshUrl = url
          live = true
          break
        } catch (e: any) {
          problem = e.message
        }
      }
      const running = all.some((p) => p.path?.toLowerCase() === harness.toLowerCase())
      add('harness', {
        path: harness,
        version: hv,
        state: live ? 'ok' : running ? 'waiting' : 'stopped',
        detail: live
          ? `已验证 Harness API · ${this.discovered.dshUrl}`
          : running
            ? `运行中 · ${problem || 'API 尚未就绪'}`
            : '已安装，尚未启动',
        evidence: [
          '官方程序文件版本',
          '进程关联的本机监听端口',
          ...(live ? ['已鉴权的 agentPresets/list'] : []),
        ],
      })
    } else add('harness', {})
    const bv = bridge ? (await json(path.join(bridge, 'package.json')))?.version : undefined
    if (snow) {
      const snowPkg = await json(path.join(snow, 'package.json')).catch(() => null)
      const endpoints = await readOneBot(snow).catch((e) => {
        this.log(e.message)
        return []
      })
      const chosen =
        endpoints.find((e) => e.account === s.ownerQQ) ||
        endpoints.find((e) => e.httpUrl === s.httpUrl) ||
        endpoints[0]
      const health = await probeOneBot(
        chosen?.httpUrl || s.httpUrl,
        chosen?.httpToken || this.secrets().httpToken || '',
      )
      let wsError = ''
      if (health.state === 'ok')
        try {
          await probeWs(chosen?.wsUrl || s.wsUrl, chosen?.wsToken || this.secrets().wsToken || '')
        } catch (e: any) {
          wsError = `HTTP 正常，WS 异常：${e.message}`
        }
      add('snowluma', {
        path: snow,
        version:
          snowPkg?.version ||
          /v?(\d+\.\d+\.\d+)/.exec(snow)?.[1] ||
          (await json(path.join(snow, '.qqdsh-install.json')))?.version,
        state:
          health.state === 'error' && !endpoints.length
            ? 'waiting'
            : wsError
              ? 'error'
              : health.state,
        detail: wsError || health.detail,
        compatibility: '网关版本兼容及实际消息往返待实测',
        evidence: [
          'OneBot get_login_info / get_status',
          '独立 WebSocket 握手',
          `${endpoints.length} 份本机端点配置`,
        ],
      })
      if (health.account) {
        const q = result.find((r) => r.id === 'qq')
        if (q && health.state === 'ok') {
          q.state = 'ok'
          q.detail = `网关确认 QQ ${health.account} 已登录`
        }
      }
    } else add('snowluma', {})
    if (bridge) {
      const config = await json(path.join(bridge, 'config.json')).catch(() => null)
      const deps = await exists(path.join(bridge, 'node_modules/js-yaml'))
      let detail = !config
        ? '配置文件缺失'
        : !deps
          ? '依赖未安装完整'
          : '文件及依赖就绪，尚未验证桥接控制台'
      let state: ComponentResult['state'] = !config || !deps ? 'error' : 'stopped'
      if (config && deps) {
        const login = await readBridgeLogin(bridge, s.consolePort)
        if (login.state === 'ready') {
          const health = await probeBridge(login.consoleUrl, login.token)
          state = health.state
          detail = health.detail
        } else {
          state = login.state === 'unavailable' ? 'error' : 'stopped'
          detail = login.detail
        }
      }
      add('bridge', {
        path: bridge,
        version: bv,
        state,
        detail,
        compatibility: compatible(hv, bv),
        evidence: ['package.json / node_modules / config.json', '本机控制台身份字段'],
      })
    } else add('bridge', {})
    const pkg = await json(path.join(s.dshHome, 'profiles/desktop/package.json')).catch(() => null)
    const patch = await fs
      .readFile(path.join(s.dshHome, 'profiles/desktop/cordis.patch.yml'), 'utf8')
      .catch(() => '')
    const bundles = pkg?.dsh?.profile?.bundles || []
    const registered = ['qq-mode-console', 'qq-agent-presets'].every((n) => bundles.includes(n))
    const mcp = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe'].every((n) =>
      patch.includes(n),
    )
    const links = await Promise.all(
      ['qq-mode-console', 'qq-agent-presets'].map((n) =>
        exists(path.join(s.dshHome, 'profiles/desktop/node_modules', n, 'package.json')),
      ),
    )
    add('plugins', {
      state: registered && mcp && links.every(Boolean) ? 'waiting' : 'missing',
      detail:
        registered && mcp && links.every(Boolean)
          ? '注册与路径就绪；重启 Harness 后验证实际加载'
          : 'desktop 配置中的 preset / MCP / 包链接不完整',
      evidence: ['desktop profile 的 bundle 注册', 'MCP 条目及插件路径'],
    })
    if (bridge && this.discovered.dshUrl && registered && mcp && links.every(Boolean)) {
      try {
        const api = await loadBridgeApi(bridge, s.dshHome, this.discovered.dshUrl)
        const raw = await api.agentPresets.list()
        const text = JSON.stringify(raw)
        if (text.includes('qq-chat') && text.includes('qq-chat-v2')) {
          const p = result.find((v) => v.id === 'plugins')!
          p.state = 'ok'
          p.detail = 'Harness API 已确认两套 QQ preset；MCP 静态挂载已检查，工具调用待实测'
        }
      } catch {}
    }
    this.results = result
    return result
  }
  async updates(proxy: string): Promise<ComponentResult[]> {
    const endpoints: Partial<Record<ComponentId, string>> = {
      bridge: 'https://api.github.com/repos/Derpyu520/qq-bridge/releases/latest',
      snowluma: 'https://api.github.com/repos/SnowLuma/SnowLuma/releases/latest',
      node: 'https://nodejs.org/dist/index.json',
      npm: 'https://registry.npmjs.org/npm/latest',
      git: 'https://api.github.com/repos/git-for-windows/git/releases/latest',
      powershell: 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest',
    }
    await Promise.all(
      this.results.map(async (result) => {
        const endpoint = endpoints[result.id]
        if (!endpoint) return
        try {
          const data = await remoteJson(endpoint, proxy)
          result.latest =
            result.id === 'node'
              ? cleanVersion(data.find((v: any) => v.lts)?.version)
              : cleanVersion(data.tag_name || data.version)
          delete result.updateError
        } catch (e: any) {
          result.updateError = e.message
        }
      }),
    )
    return this.results
  }
}
export async function loadBridgeApi(_bridge: string, home: string, url: string): Promise<any> {
  const doc: any = yaml.load(await fs.readFile(path.join(home, '.credentials.yaml'), 'utf8'))
  const record = doc?.records?.['client-connection/browser-session']
  const secret =
    record?.kind === 'grant' && record?.payload?.version === 1
      ? Buffer.from(record.payload.secret || '', 'base64url')
      : null
  if (!secret || secret.length !== 32)
    throw new Error('Harness 本机签名凭据尚未就绪，请完成首次启动')
  const authority = new URL(url).host
  const issuedAt = Date.now()
  const body = Buffer.from(
    JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3600000 }),
  ).toString('base64url')
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url')
  const cookie = `dsh-auth-${crypto.createHash('sha256').update(authority).digest('base64url')}=v1.${body}.${signature}`
  return {
    agentPresets: {
      list: async () => {
        const rpcId = crypto.randomUUID()
        const method = 'agentPresets/list'
        const response = await localRpc(url, 'api/' + method, '', 2500, cookie, {
          type: 'client-request',
          rpcId,
          method,
          payload: { args: {} },
        })
        if (
          response.type !== 'server-response' ||
          response.rpcId !== rpcId ||
          response.result?.ok !== true
        )
          throw new Error('Harness API 身份或 preset 查询失败')
        return response.result.value
      },
    },
  }
}
