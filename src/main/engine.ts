import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { Store } from './store'
import { Scanner } from './scanner'
import {
  assertDirectory,
  atomicWrite,
  exists,
  json,
  localUrl,
  mergeBridgeConfig,
  mergeMcp,
  parseQQs,
  readOneBot,
  redact,
  writeJson,
} from './core'
import {
  command,
  commitDesktopPatch,
  desktopCli,
  fileVersion,
  findFile,
  powershell,
  processes,
  runDesktopCli,
} from './system'
import { download } from './network'
import type {
  AppUpdate,
  ComponentResult,
  ConfigInput,
  DeployAction,
  DeployPlan,
  DeployRequest,
  LogEntry,
  Settings,
  Snapshot,
  Task,
} from '../shared/types'

export class Engine {
  scanner: Scanner
  logs: LogEntry[] = []
  task: Task | null = null
  appUpdate?: AppUpdate
  version = '0.1.0'
  owned: Partial<Record<'bridge' | 'snowluma' | 'harness', ChildProcess>> = {}
  private aborter?: AbortController
  private waiter?: () => void
  private request?: DeployRequest
  private scanning = false
  private mutating = false
  private bridgeRollback?: { target: string; previous: string }
  constructor(
    readonly store: Store,
    readonly catalog: any,
    private changed: (snapshot: Snapshot) => void,
    private openExternal: (url: string) => Promise<void>,
  ) {
    this.scanner = new Scanner(
      (s) => this.log(s, 'warn'),
      () => this.store.secrets,
    )
  }
  async init(): Promise<void> {
    await this.store.init()
    const previous = await json<Task>(path.join(this.store.root, 'task.json'))
    if (previous) {
      this.task = previous
      if (['running', 'waiting'].includes(previous.state)) {
        previous.state = 'failed'
        previous.error = '上次任务被中断，请重新预览部署；已完成组件可通过检测复用'
      }
    }
    this.log('部署助手已就绪。先检测本机环境，再选择需要执行的操作。')
  }
  async snapshot(): Promise<Snapshot> {
    return {
      settings: this.store.settings,
      components: this.scanner.results,
      task: this.task,
      logs: this.logs.slice(-400),
      tokenPresent: { http: !!this.store.secrets.httpToken, ws: !!this.store.secrets.wsToken },
      backups: await this.store.backups(),
      owned: Object.fromEntries(
        Object.entries(this.owned)
          .filter(([, p]) => p?.pid && p.exitCode === null)
          .map(([id, p]) => [id, p!.pid]),
      ),
      version: this.version,
      appUpdate: this.appUpdate,
    }
  }
  private notificationPending = false
  emit(): void {
    if (this.notificationPending) return
    this.notificationPending = true
    setTimeout(() => {
      this.notificationPending = false
      this.snapshot()
        .then((v) => this.changed(v))
        .catch(() => {})
    }, 60)
  }
  log(message: string, level: LogEntry['level'] = 'info'): void {
    let safe = redact(message)
    for (const secret of Object.values(this.store.secrets))
      if (secret) safe = safe.replaceAll(secret, '[已隐藏]')
    const item: LogEntry = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      level,
      message: safe.slice(0, 12000),
    }
    this.logs.push(item)
    if (this.logs.length > 600) this.logs.shift()
    fs.appendFile(path.join(this.store.root, 'activity.log'), JSON.stringify(item) + '\n').catch(
      () => {},
    )
    this.emit()
  }
  async scan(): Promise<ComponentResult[]> {
    if (this.scanning) return this.scanner.results
    this.scanning = true
    try {
      const result = await this.scanner.scan(this.store.settings)
      this.log(
        `环境检测完成：${result.filter((r) => r.state === 'ok').length}/${result.length} 项正常`,
      )
      return result
    } finally {
      this.scanning = false
      this.emit()
    }
  }
  async updates(): Promise<ComponentResult[]> {
    if (!this.scanner.results.length) await this.scan()
    const result = await this.scanner.updates(this.store.settings.proxy)
    this.log('官方版本查询完成；查询失败的组件已单独标记')
    this.emit()
    return result
  }
  private resolveSettings(s = this.store.settings): Settings {
    const d = this.scanner.discovered
    return {
      ...s,
      nodePath: s.nodePath || d.node,
      harnessPath: s.harnessPath || d.harness,
      snowlumaPath: s.snowlumaPath || d.snowluma,
      bridgePath: s.bridgePath || d.bridge,
      qqPath: s.qqPath || d.qq,
      dshUrl: d.dshUrl || s.dshUrl,
    }
  }
  async saveConfig(input: ConfigInput): Promise<Settings> {
    if (this.mutating || (this.task && ['running', 'waiting'].includes(this.task.state)))
      throw new Error('部署任务进行中，完成或取消后再保存配置')
    this.mutating = true
    try {
      const s = this.validateSettings(input.settings)
      const secrets = {
        ...this.store.secrets,
        ...(input.httpToken !== undefined ? { httpToken: input.httpToken } : {}),
        ...(input.wsToken !== undefined ? { wsToken: input.wsToken } : {}),
      }
      const bridge = s.bridgePath || this.scanner.discovered.bridge
      if (
        input.applyBridge !== false &&
        bridge &&
        (await exists(path.join(bridge, 'package.json')))
      ) {
        const file = path.join(bridge, 'config.json')
        const old = (await json(file)) || (await json(path.join(bridge, 'config.example.json')))
        const next = mergeBridgeConfig(old, s, secrets.httpToken, secrets.wsToken)
        const backup = await this.store.createBackup('保存桥接配置', [file])
        try {
          await writeJson(file, next)
          await this.store.finishBackup(backup)
        } catch (e) {
          await this.store.restore(backup.id, true)
          throw e
        }
      }
      if (input.applyBridge !== false) s.firstRun = false
      await this.store.save(s, secrets)
      this.log(
        input.applyBridge === false
          ? '部署选项已保存；桥接配置未修改'
          : '连接配置已保存；现有会话和其他插件配置已保留',
      )
      return s
    } finally {
      this.mutating = false
      this.emit()
    }
  }
  validateSettings(s: Settings): Settings {
    assertDirectory(s.installRoot)
    assertDirectory(s.dshHome)
    localUrl(s.dshUrl)
    localUrl(s.httpUrl)
    localUrl(s.wsUrl, ['ws:', 'wss:'])
    parseQQs(s.groups)
    parseQQs(s.friends)
    if (s.ownerQQ && !/^\d{5,15}$/.test(s.ownerQQ)) throw new Error('管理员 QQ 号格式不正确')
    if (s.consolePort < 1024 || s.consolePort > 65535 || !Number.isInteger(s.consolePort))
      throw new Error('控制台端口应为 1024–65535')
    if (s.proxy) {
      const u = new URL(s.proxy)
      if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
        throw new Error('代理需为不含账号密码的 HTTP(S) 地址')
    }
    for (const value of [
      s.nodePath,
      s.pwshPath,
      s.harnessPath,
      s.snowlumaPath,
      s.bridgePath,
      s.qqPath,
    ])
      if (value && (!path.isAbsolute(value) || /["\x00-\x1f]/.test(value)))
        throw new Error('安装位置必须为不含引号或控制字符的绝对路径')
    return { ...s }
  }
  async importConfig(): Promise<Settings> {
    if (this.task && ['running', 'waiting'].includes(this.task.state))
      throw new Error('请先完成或取消部署任务')
    const s = this.resolveSettings()
    const cfg = s.bridgePath ? await json(path.join(s.bridgePath, 'config.json')) : null
    if (cfg) {
      s.dshUrl = this.scanner.discovered.dshUrl || cfg.dsh?.baseUrl || s.dshUrl
      s.httpUrl = cfg.snowluma?.httpUrl || s.httpUrl
      s.wsUrl = cfg.snowluma?.wsUrl || s.wsUrl
      s.snowlumaPath = cfg.snowluma?.homeDir || s.snowlumaPath
      s.ownerQQ = String(cfg.ownerQQ || '')
      s.groups = (cfg.allow?.groups || []).join(', ')
      s.friends = (cfg.allow?.private || []).join(', ')
      s.model = cfg.dsh?.model || s.model
      s.consolePort = cfg.consolePort || s.consolePort
    }
    const endpoints = s.snowlumaPath ? await readOneBot(s.snowlumaPath) : []
    const selected =
      endpoints.find((e) => e.httpUrl === s.httpUrl) ||
      (endpoints.length === 1 ? endpoints[0] : undefined)
    if (endpoints.length > 1 && !selected)
      throw new Error('发现多个 QQ 账号配置，请先填写目标 OneBot HTTP 地址再导入')
    if (selected) {
      s.httpUrl = selected.httpUrl
      s.wsUrl = selected.wsUrl
    }
    this.validateSettings(s)
    await this.store.save(s, {
      ...this.store.secrets,
      ...(selected
        ? { httpToken: selected.httpToken, wsToken: selected.wsToken }
        : cfg?.snowluma?.accessToken
          ? { httpToken: cfg.snowluma.accessToken }
          : {}),
    })
    this.log('已导入安装位置、现有白名单及本机端点；令牌已加密保存，界面不回显')
    this.emit()
    return s
  }
  async preview(request: DeployRequest): Promise<DeployPlan> {
    const s = this.validateSettings(this.resolveSettings())
    const order: DeployAction[] = ['powershell', 'node', 'harness', 'snowluma', 'bridge', 'plugins']
    const selected = new Set(request.actions)
    if (!selected.size) throw new Error('请至少选择一个部署项目')
    if (
      (selected.has('bridge') || selected.has('plugins')) &&
      (!s.nodePath || this.scanner.results.find((r) => r.id === 'node')?.state !== 'ok')
    )
      selected.add('node')
    const actions = order.filter((id) => selected.has(id))
    const labels = {
      node: '安装专用 Node.js',
      powershell: '安装 PowerShell 7',
      harness: '安装官方 Harness 桌面版',
      snowluma: '安装 SnowLuma',
      bridge: '部署 / 更新 QQ Bridge',
      plugins: '安装 desktop preset 与 MCP',
    }
    const dirs = {
      node: path.join(s.installRoot, 'node'),
      powershell: path.join(s.installRoot, 'powershell7'),
      harness: '官方安装向导选择的目录',
      snowluma: path.join(s.installRoot, 'snowluma'),
      bridge: path.join(s.installRoot, 'qq-bridge'),
      plugins: path.join(s.dshHome, 'profiles/desktop'),
    }
    const warnings = ['只有实际完成登录与 QQ 消息往返，才算全链路验收通过。']
    if (actions.includes('snowluma')) {
      if (!s.snowlumaAuthorized)
        throw new Error('请在连接配置中确认 SnowLuma 自动部署的书面授权范围')
      warnings.push('SnowLuma 2.1.1 与当前桥接组合待实测；首次协议、密码和 QQ 登录由你完成。')
    }
    if (actions.includes('plugins'))
      warnings.push('修改 desktop 插件前必须完全退出 Harness；文件与锁文件将备份。')
    if (actions.includes('powershell') && s.registerPwshPath)
      warnings.push('PowerShell 7 将加入当前用户 PATH。已有终端及 AI 程序需重启后继承新 PATH。')
    const items = actions.map((id) => ({
      id,
      title: labels[id],
      version: this.catalog[id]?.version || this.catalog.bridge.version,
      source: this.catalog[id]?.url || '所选 Harness 安装内的官方 dsh 命令 + 已下载桥接',
      destination: dirs[id],
      changes:
        id === 'plugins'
          ? [
              '安装 qq-mode-console 与 qq-agent-presets',
              '合并三个 MCP 条目，保留其他插件',
              '新实例初始化 reserved2，保留已有运行模式',
            ]
          : id === 'bridge'
            ? [
                '使用精确提交及锁文件安装依赖',
                '保留 config.json、state、roles、audio',
                '失败恢复上一版程序',
              ]
            : id === 'powershell'
              ? [
                  '微软官方 ZIP，校验 SHA-256',
                  s.registerPwshPath
                    ? '追加当前用户 PATH，保留已有条目'
                    : '仅安装独立目录，不修改 PATH',
                ]
              : ['校验 SHA-256 后安装', '复用已有数据，保留用户交互步骤'],
    }))
    return { request: { ...request, actions }, items, warnings }
  }
  async deploy(request: DeployRequest, resume = false): Promise<void> {
    if (this.mutating || (this.task && ['running', 'waiting'].includes(this.task.state)))
      throw new Error('已有任务运行中')
    const plan = await this.preview(request)
    if (plan.request.actions.includes('snowluma') && !request.acceptUnverified)
      throw new Error('请确认版本待实测提示后再开始')
    this.request = plan.request
    const previous = resume ? this.task : null
    this.task = {
      id: crypto.randomUUID(),
      title: '快速部署',
      state: 'running',
      startedAt: new Date().toISOString(),
      steps: plan.items.map((v) => ({
        id: v.id,
        title: v.title,
        state: previous?.steps.find((p) => p.id === v.id)?.state === 'done' ? 'done' : 'pending',
      })),
    }
    this.aborter = new AbortController()
    this.emit()
    void this.runTask()
  }
  private async persistTask(): Promise<void> {
    if (this.task) await writeJson(path.join(this.store.root, 'task.json'), this.task)
    this.emit()
  }
  private async runTask(): Promise<void> {
    const task = this.task!
    const signal = this.aborter!.signal
    try {
      for (const step of task.steps) {
        signal.throwIfAborted()
        if (step.state === 'done') continue
        step.state = 'running'
        step.detail = ''
        await this.persistTask()
        this.log(step.title)
        const progress = (n: number) => {
          step.progress = n
          this.emit()
        }
        await this.perform(step.id as DeployAction, signal, progress)
        step.state = 'done'
        step.progress = 100
        await this.persistTask()
      }
      this.bridgeRollback = undefined
      task.state = 'done'
      this.log('所选部署步骤已完成。登录、连接检查与 QQ 消息往返仍需分别验证。')
    } catch (e: any) {
      task.state = signal.aborted ? 'cancelled' : 'failed'
      task.error = redact(e.message || String(e))
      const step = task.steps.find((v) => ['running', 'waiting'].includes(v.state))
      if (step) {
        step.state = signal.aborted ? 'cancelled' : 'failed'
        step.detail = task.error
      }
      if (this.bridgeRollback) {
        const r = this.bridgeRollback
        try {
          await this.stopOwned('bridge')
          if (await exists(r.target)) await fs.rename(r.target, r.target + '.failed-' + Date.now())
          if (await exists(r.previous)) await fs.rename(r.previous, r.target)
          this.log('已恢复上一版 QQ Bridge 程序及数据', 'warn')
          const b = task.steps.find((s) => s.id === 'bridge')
          if (b) b.state = 'pending'
        } catch (rollback: any) {
          this.log(`程序恢复需手动处理：${rollback.message}`, 'error')
        }
        this.bridgeRollback = undefined
      }
      this.log(task.error, task.state === 'cancelled' ? 'warn' : 'error')
    } finally {
      this.waiter = undefined
      await this.persistTask()
      await this.scan().catch((e) => this.log(e.message, 'warn'))
    }
  }
  async wait(detail: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const step = this.task!.steps.find((s) => s.state === 'running' || s.state === 'waiting')!
    step.state = 'waiting'
    step.detail = detail
    this.task!.state = 'waiting'
    await this.persistTask()
    this.log(detail, 'warn')
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        this.waiter = undefined
        reject(new Error('操作已取消'))
      }
      this.waiter = () => {
        signal.removeEventListener('abort', abort)
        resolve()
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    signal.throwIfAborted()
    step.state = 'running'
    this.task!.state = 'running'
    await this.persistTask()
  }
  resume(): void {
    if (!this.waiter) throw new Error('当前没有等待确认的步骤')
    const resolve = this.waiter
    this.waiter = undefined
    resolve()
  }
  cancel(): void {
    this.aborter?.abort()
    this.log('已请求取消；正在停止当前下载或安装子进程', 'warn')
  }
  async retry(): Promise<void> {
    if (!this.request) throw new Error('应用重启后请重新预览部署')
    await this.deploy(this.request, true)
  }
  private async perform(
    id: DeployAction,
    signal: AbortSignal,
    progress: (n: number) => void,
  ): Promise<void> {
    const s = this.resolveSettings()
    await this.store.save(s)
    const options = {
      signal,
      timeout: 900000,
      onLine: (line: string) => this.log(line),
      env: {
        ...process.env,
        DSH_HOME: s.dshHome,
        ...(s.proxy ? { HTTPS_PROXY: s.proxy, HTTP_PROXY: s.proxy } : {}),
      },
    }
    if (id === 'plugins') {
      await this.installPlugins(signal, options)
      return
    }
    const source = this.catalog[id]
    const ext = id === 'harness' ? 'exe' : 'zip'
    const archive = path.join(this.store.root, 'downloads', `${id}-${source.version}.${ext}`)
    await download(source.url, archive, source.sha256, s.proxy, signal, progress)
    if (id === 'harness') {
      const signature = JSON.parse(
        await powershell(
          '$s=Get-AuthenticodeSignature -LiteralPath $env:QQDSH_FILE; @{status=[string]$s.Status; thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
          { QQDSH_FILE: archive },
        ),
      )
      if (signature.status !== 'Valid' || signature.thumbprint !== source.signerThumbprint)
        throw new Error('Harness 官方签名验证失败，安装程序未启动')
      await command(archive, [], { ...options, timeout: 3600000 })
      await this.scan()
      while (!this.scanner.discovered.harness) {
        await this.wait(
          '请完成 Harness 官方安装向导；如安装在自定义位置，可取消后指定路径，再继续部署。',
          signal,
        )
        await this.scan()
      }
      await this.store.save(this.resolveSettings())
      return
    }
    const staging = path.join(s.installRoot, '.staging', `${id}-${crypto.randomUUID()}`)
    await extractZip(archive, staging, signal)
    const expected =
      id === 'node'
        ? ['node.exe']
        : id === 'powershell'
          ? ['pwsh.exe']
          : id === 'snowluma'
            ? ['launcher.bat']
            : ['src/bridge.js']
    const found = await findFile(staging, expected, 3)
    if (!found) throw new Error('官方归档内容与安装清单不一致')
    const sourceDir = id === 'bridge' ? path.dirname(path.dirname(found)) : path.dirname(found)
    const target = path.join(
      s.installRoot,
      { node: 'node', powershell: 'powershell7', snowluma: 'snowluma', bridge: 'qq-bridge' }[id],
    )
    if ((await exists(target)) && !(await exists(path.join(target, '.qqdsh-install.json'))))
      throw new Error(
        `目录已有非工具管理的内容，已保留：${target}。请换安装目录，或仅导入并修复配置。`,
      )
    if (id === 'bridge') {
      const old = s.bridgePath || target
      if (await exists(path.join(old, 'config.json')))
        await fs.copyFile(path.join(old, 'config.json'), path.join(sourceDir, 'config.json'))
      for (const dir of ['state', 'roles', 'audio'])
        if (await exists(path.join(old, dir)))
          await fs.cp(path.join(old, dir), path.join(sourceDir, dir), {
            recursive: true,
            dereference: false,
          })
      const npmCli = path.join(path.dirname(s.nodePath), 'node_modules/npm/bin/npm-cli.js')
      if (!(await exists(s.nodePath)) || !(await exists(npmCli)))
        throw new Error('请先安装可用的 Node.js 和 npm')
      await command(s.nodePath, [npmCli, 'ci', '--omit=dev', '--no-audit', '--no-fund'], {
        ...options,
        cwd: sourceDir,
        env: { ...options.env, PATH: path.dirname(s.nodePath) + path.delimiter + process.env.PATH },
      })
      const bridgeEntry = path.join(sourceDir, 'src/bridge.js')
      const originalEntry = await fs.readFile(bridgeEntry, 'utf8')
      const anchor =
        /(new SnowLumaWebSocketClient\(\{\s*url: cfg\.snowluma\.wsUrl,\s*accessToken: )cfg\.snowluma\.accessToken \|\| undefined/
      if (!anchor.test(originalEntry))
        throw new Error('桥接独立 WS 令牌适配锚点不匹配，未替换现有程序')
      await atomicWrite(
        bridgeEntry,
        originalEntry.replace(
          anchor,
          '$1cfg.snowluma.wsAccessToken || cfg.snowluma.accessToken || undefined',
        ),
      )
    }
    if (id === 'node') {
      const version = await command(path.join(sourceDir, 'node.exe'), ['--version'])
      if (!version.includes(source.version)) throw new Error('Node.js 解压后版本不符')
    }
    if (id === 'powershell') {
      const version = await command(path.join(sourceDir, 'pwsh.exe'), [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.ToString()',
      ])
      if (version !== source.version) throw new Error('PowerShell 解压后版本不符')
    }
    if (id === 'snowluma' && (await exists(target)))
      throw new Error(
        '已有 SnowLuma 安装将保留；首版不覆盖网关账号数据，请使用官方界面升级或选择新目录',
      )
    if (id === 'bridge' && (await portBusy(s.consolePort))) {
      if (!this.owned.bridge) throw new Error('桥接控制台端口已占用，请先退出外部桥接实例')
      await this.stopOwned('bridge')
    }
    const previous = target + '.previous-' + Date.now()
    if (await exists(target)) await renameRetry(target, previous)
    try {
      await renameRetry(sourceDir, target)
      await writeJson(path.join(target, '.qqdsh-install.json'), {
        version: source.version,
        sha256: source.sha256,
        installedAt: new Date().toISOString(),
        ...(id === 'bridge' ? { adapter: 'split-ws-token-v1' } : {}),
      })
      if (id === 'node') s.nodePath = path.join(target, 'node.exe')
      if (id === 'powershell') {
        s.pwshPath = path.join(target, 'pwsh.exe')
        if (s.registerPwshPath) await registerUserPath(target)
      }
      if (id === 'snowluma') s.snowlumaPath = target
      if (id === 'bridge') {
        s.bridgePath = target
        if (await exists(previous)) this.bridgeRollback = { target, previous }
        await this.ensureBridgeConfig(s)
      }
      await this.store.save(s)
    } catch (e) {
      if (await exists(target)) await renameRetry(target, target + '.failed-' + Date.now())
      if (await exists(previous)) await renameRetry(previous, target)
      throw e
    }
    if (id === 'snowluma') {
      await this.startService('snowluma')
      await this.openExternal('http://127.0.0.1:5099')
      await this.wait(
        'SnowLuma 已解压并启动。请在官方 WebUI 完成协议确认、密码设置与 QQ 登录，确认 OneBot HTTP/WS 已开启后继续。',
        signal,
      )
      const endpoints = await readOneBot(target)
      const endpoint =
        endpoints.find((e) => e.httpUrl === s.httpUrl) ||
        (endpoints.length === 1 ? endpoints[0] : undefined)
      if (!endpoint) throw new Error('尚未发现唯一的 OneBot 配置；请完成登录后在连接配置中导入端点')
      s.httpUrl = endpoint.httpUrl
      s.wsUrl = endpoint.wsUrl
      await this.store.save(s, {
        ...this.store.secrets,
        httpToken: endpoint.httpToken,
        wsToken: endpoint.wsToken,
      })
    }
  }
  private async ensureBridgeConfig(s: Settings): Promise<void> {
    const file = path.join(s.bridgePath, 'config.json')
    const existing = await json(file)
    const old = existing || (await json(path.join(s.bridgePath, 'config.example.json')))
    const preserve = s.firstRun && existing
    const values = preserve
      ? {
          ...s,
          ownerQQ: String(existing.ownerQQ || ''),
          groups: (existing.allow?.groups || []).join(','),
          friends: (existing.allow?.private || []).join(','),
          model: existing.dsh?.model || s.model,
          consolePort: existing.consolePort || s.consolePort,
          httpUrl: existing.snowluma?.httpUrl || s.httpUrl,
          wsUrl: existing.snowluma?.wsUrl || s.wsUrl,
        }
      : s
    await writeJson(
      file,
      mergeBridgeConfig(old, values, this.store.secrets.httpToken, this.store.secrets.wsToken),
    )
    const mode = path.join(s.bridgePath, 'state/mode.json')
    if (!(await exists(mode))) await writeJson(mode, { mode: 'reserved2', closedAgentPreset: '' })
  }
  private async installPlugins(
    signal: AbortSignal,
    options: Parameters<typeof command>[2],
  ): Promise<void> {
    const s = this.resolveSettings()
    if (!s.bridgePath || !s.harnessPath || !s.nodePath)
      throw new Error('请先安装或指定 Harness、Node.js 和 QQ Bridge')
    const profile = path.join(s.dshHome, 'profiles/desktop')
    if (!(await exists(path.join(profile, 'package.json'))))
      throw new Error('请先启动一次官方 Harness 桌面版，完成初始化后完全退出')
    while (
      (await processes()).some(
        (p) => p.path && p.path.toLowerCase() === s.harnessPath.toLowerCase(),
      )
    )
      await this.wait(
        '请通过 Harness 托盘菜单完全退出程序；关闭窗口可能仍在后台运行。退出后点击继续。',
        signal,
      )
    const cli = await desktopCli(s.harnessPath)
    if (!cli) throw new Error('未发现此 Harness 安装内的官方 dsh.cmd；请安装受支持的官方桌面版')
    const patchFile = path.join(profile, 'cordis.patch.yml')
    const original = await fs.readFile(patchFile, 'utf8').catch((e) => {
      if (e.code === 'ENOENT') return ''
      throw e
    })
    const merged = mergeMcp(original, s.bridgePath, s.nodePath)
    const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml'].map(
      (n) => path.join(profile, n),
    )
    files.push(path.join(s.bridgePath, 'config.json'), path.join(s.bridgePath, 'state/mode.json'))
    await this.store.save(s)
    const backup = await this.store.createBackup('安装 desktop 插件与 MCP', files)
    try {
      await command(
        s.nodePath,
        [path.join(s.bridgePath, 'scripts/build-agent-preset-patches.mjs')],
        { ...options, cwd: s.bridgePath },
      )
      await runDesktopCli(
        cli,
        [
          path.join(s.bridgePath, 'plugins/qq-mode-console'),
          path.join(s.bridgePath, 'plugins/qq-agent-presets'),
        ],
        { ...options, env: { ...options?.env, DSH_HOME: s.dshHome } },
      )
      // pnpm exec remains inside the official CLI's profile transaction boundary.
      const operations = path.join(this.store.root, 'operations')
      await fs.mkdir(operations, { recursive: true })
      const helper = path.join(operations, 'commit-patch.mjs')
      const payload = path.join(operations, `${crypto.randomUUID()}.json`)
      await atomicWrite(
        helper,
        `import fs from 'node:fs/promises'; import crypto from 'node:crypto'; import path from 'node:path';\nconst p=JSON.parse(await fs.readFile(process.argv[2],'utf8'));\nif(path.resolve(p.target)!==path.resolve(process.cwd(),'cordis.patch.yml')) throw new Error('Profile path mismatch');\nconst old=await fs.readFile(p.target,'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e});\nif(crypto.createHash('sha256').update(old).digest('hex')!==p.before) throw new Error('Harness patch changed concurrently');\nawait fs.writeFile(p.target+'.qqdsh-tmp',p.content); await fs.rename(p.target+'.qqdsh-tmp',p.target);\n`,
      )
      await writeJson(payload, {
        target: patchFile,
        before: crypto.createHash('sha256').update(original).digest('hex'),
        content: merged,
      })
      try {
        await commitDesktopPatch(cli, s.nodePath, helper, payload, {
          ...options,
          env: { ...options?.env, DSH_HOME: s.dshHome },
        })
        await this.ensureBridgeConfig(s)
      } finally {
        await fs.rm(payload, { force: true })
      }
      await this.store.finishBackup(backup)
      this.log('插件和 MCP 已配置。请启动 Harness 并重新检测实际 preset 加载状态。')
    } catch (e) {
      await this.store
        .restore(backup.id, true)
        .catch((error) => this.log(`配置恢复失败：${error.message}`, 'error'))
      throw e
    }
  }
  async service(
    id: 'bridge' | 'snowluma' | 'harness',
    action: 'start' | 'stop' | 'restart',
  ): Promise<void> {
    if (this.task && ['running', 'waiting'].includes(this.task.state))
      throw new Error('请先完成或取消部署任务')
    if (action === 'stop' || action === 'restart') await this.stopOwned(id)
    if (action === 'start' || action === 'restart') await this.startService(id)
    this.emit()
  }
  async stopOwned(id: 'bridge' | 'snowluma' | 'harness'): Promise<void> {
    const child = this.owned[id]
    if (!child?.pid || child.exitCode !== null) {
      this.log('此进程未由部署助手启动，请通过官方界面退出', 'warn')
      return
    }
    await command('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 10000 })
    delete this.owned[id]
    this.log(`${id} 已停止`)
    this.emit()
  }
  async startService(id: 'bridge' | 'snowluma' | 'harness'): Promise<void> {
    if (this.owned[id]?.exitCode === null) {
      this.log(`${id} 已由助手启动`)
      return
    }
    const s = this.resolveSettings()
    let exe = ''
    let args: string[] = []
    let cwd: string
    if (id === 'harness') {
      exe = s.harnessPath
      cwd = path.dirname(exe)
    } else if (id === 'bridge') {
      if (!s.bridgePath || !s.nodePath) throw new Error('请先指定桥接和 Node.js 路径')
      if (await portBusy(s.consolePort)) throw new Error('桥接控制台端口已占用，请检查已有实例')
      if (!s.ownerQQ || ![...parseQQs(s.groups), ...parseQQs(s.friends)].length)
        throw new Error('请先填写管理员 QQ 和至少一个白名单群 / 好友')
      await this.ensureBridgeConfig(s)
      exe = s.nodePath
      args = [path.join(s.bridgePath, 'src/bridge.js')]
      cwd = s.bridgePath
    } else {
      if (!s.snowlumaPath) throw new Error('请先指定 SnowLuma 目录')
      const bundledNode = await findFile(s.snowlumaPath, ['node.exe'], 2)
      exe = bundledNode || s.nodePath
      if (!exe) throw new Error('SnowLuma 未发现配套 Node.js，请安装专用 Node.js')
      await command(exe, [path.join(s.snowlumaPath, 'check-node-version.cjs')], {
        cwd: s.snowlumaPath,
      })
      args = [path.join(s.snowlumaPath, 'index.mjs')]
      cwd = s.snowlumaPath
    }
    if (!exe || !(await exists(exe))) throw new Error('启动程序不存在，请重新检测或指定路径')
    const logFile = path.join(this.store.root, `${id}-local.log`)
    const output = await fs.open(logFile, 'a', 0o600)
    const child = spawn(exe, args, {
      cwd,
      windowsHide: true,
      detached: true,
      shell: false,
      env: {
        ...process.env,
        DSH_HOME: s.dshHome,
        PATH: (s.nodePath ? path.dirname(s.nodePath) + path.delimiter : '') + process.env.PATH,
      },
      stdio: ['ignore', output.fd, output.fd],
    })
    await output.close()
    child.unref()
    this.owned[id] = child
    // Keep third-party output outside exported diagnostics: it may contain chats, login URLs or initial passwords.
    this.log(`${id} 详细输出保存在本机 ${id}-local.log，不进入诊断导出。可从数据目录查看。`)
    child.on('error', (e) => this.log(`${id} 启动失败：${e.message}`, 'error'))
    child.on('exit', (code) => {
      delete this.owned[id]
      this.log(`${id} 进程已退出（${code}）`, code === 0 ? 'info' : 'warn')
    })
    await this.store.save(s)
    this.log(`${id} 启动请求已提交；健康状态请重新检测`)
  }
  async restore(id: string): Promise<void> {
    if (this.task && ['running', 'waiting'].includes(this.task.state))
      throw new Error('请先完成或取消部署任务')
    const s = this.resolveSettings()
    if (
      this.owned.bridge?.exitCode === null ||
      (await processes()).some(
        (p) => p.path && p.path.toLowerCase() === s.harnessPath.toLowerCase(),
      )
    )
      throw new Error('请先停止桥接并完全退出 Harness，再恢复配置')
    await this.store.restore(id)
    this.log('配置备份已恢复，请重启服务后检测')
    this.emit()
  }
}

export async function extractZip(file: string, dest: string, signal: AbortSignal): Promise<void> {
  assertDirectory(dest)
  signal.throwIfAborted()
  await fs.mkdir(dest, { recursive: true })
  await powershell(
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; $root=[IO.Path]::GetFullPath($env:QQDSH_DEST).TrimEnd("\\")+"\\"; $zip=[IO.Compression.ZipFile]::OpenRead($env:QQDSH_ARCHIVE); try { foreach($e in $zip.Entries) { $p=[IO.Path]::GetFullPath([IO.Path]::Combine($root,$e.FullName)); if(-not $p.StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw "Archive path escapes destination" }; if(($e.ExternalAttributes -band 0xF0000000) -eq 0xA0000000) { throw "Archive symbolic link refused" } } } finally { $zip.Dispose() }; [IO.Compression.ZipFile]::ExtractToDirectory($env:QQDSH_ARCHIVE,$env:QQDSH_DEST)',
    { QQDSH_ARCHIVE: file, QQDSH_DEST: dest },
    180000,
  )
  signal.throwIfAborted()
}
export async function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(true))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(false)))
  })
}
export async function renameRetry(source: string, destination: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(source, destination)
      return
    } catch (error: any) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || i >= 9) throw error
      await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)))
    }
  }
}
export async function registerUserPath(directory: string): Promise<void> {
  assertDirectory(directory)
  await powershell(
    '$dir=$env:QQDSH_PWSH; $old=[string][Environment]::GetEnvironmentVariable("Path","User"); $parts=@($old.Split(";",[StringSplitOptions]::RemoveEmptyEntries)); if(-not ($parts | Where-Object { $_.TrimEnd("\\") -ieq $dir.TrimEnd("\\") })) { [Environment]::SetEnvironmentVariable("Path",(($parts + $dir) -join ";"),"User") }',
    { QQDSH_PWSH: directory },
  )
  if (
    !(process.env.PATH || '')
      .split(path.delimiter)
      .some((v) => v.toLowerCase() === directory.toLowerCase())
  )
    process.env.PATH = (process.env.PATH || '') + path.delimiter + directory
}
