import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleAlert,
  CircleHelp,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Fish,
  FolderOpen,
  LayoutDashboard,
  LoaderCircle,
  Play,
  Plug,
  Power,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Square,
  Terminal,
  Wrench,
  X,
  XCircle,
} from 'lucide-react'
import type {
  ComponentResult,
  DeployAction,
  DeployPlan,
  Health,
  Page,
  Settings,
  Snapshot,
} from '../../shared/types'
import { projects, releaseRepository } from '../../shared/projects'
import { SnowLumaLoginPanel } from './SnowLumaLoginPanel'
import { BridgeLoginPanel } from './BridgeLoginPanel'
import { AdvancedTtsPanel } from './AdvancedTtsPanel'

const nav: { id: Page; label: string; sub: string; icon: typeof Activity }[] = [
  { id: 'overview', label: '环境总览', sub: '检查安装与连接', icon: LayoutDashboard },
  { id: 'deploy', label: '快速部署', sub: '按需补齐组件', icon: ArrowDownToLine },
  { id: 'advanced', label: '进阶功能', sub: '本地语音模型部署', icon: Wrench },
  { id: 'config', label: '连接配置', sub: '账号与访问范围', icon: Settings2 },
  { id: 'services', label: '运行管理', sub: '启动与健康状态', icon: Activity },
  { id: 'logs', label: '日志诊断', sub: '定位与恢复问题', icon: FileText },
]
const status: Record<Health, { text: string; icon: typeof Circle }> = {
  ok: { text: '正常', icon: CheckCircle2 },
  missing: { text: '未安装', icon: Circle },
  stopped: { text: '未运行', icon: Square },
  waiting: { text: '待完成', icon: CircleAlert },
  error: { text: '需处理', icon: XCircle },
  unknown: { text: '待验证', icon: CircleHelp },
}
const deployOptions: { id: DeployAction; title: string; sub: string; version: string }[] = [
  {
    id: 'powershell',
    title: 'PowerShell 7',
    sub: '为 AI 和终端提供现代 pwsh 环境',
    version: '7.6.8',
  },
  { id: 'node', title: 'Node.js + npm', sub: '桥接所需的独立运行时', version: '24.22.1' },
  { id: 'harness', title: 'Harness 桌面版', sub: 'DeepSeek 官方桌面程序', version: '0.2.1-rc.2' },
  { id: 'snowluma', title: 'SnowLuma', sub: 'QQ 与 OneBot 的连接网关', version: '2.1.1 · 待实测' },
  { id: 'bridge', title: 'QQ Bridge', sub: '将 QQ 消息接入 Harness', version: '0.2.1-r1' },
  {
    id: 'plugins',
    title: '聊天预设与 MCP',
    sub: '安装到 Harness desktop 配置',
    version: '跟随桥接版本',
  },
]
function Badge({ state }: { state: Health }) {
  const Icon = status[state].icon
  return (
    <span className={`badge ${state}`}>
      <Icon size={13} />
      {status[state].text}
    </span>
  )
}
function Button({
  children,
  primary,
  ghost,
  loading,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  primary?: boolean
  ghost?: boolean
  loading?: boolean
}) {
  return (
    <button
      {...props}
      disabled={props.disabled || loading}
      className={`btn ${primary ? 'primary' : ''} ${ghost ? 'ghost' : ''} ${props.className || ''}`}
    >
      {loading && <LoaderCircle size={15} className="spin" />}
      {children}
    </button>
  )
}
function Field({ label, note, children }: { label: string; note?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {note && <small>{note}</small>}
    </label>
  )
}
function Callout({ children, tone = 'info' }: { children: ReactNode; tone?: string }) {
  return (
    <div className={`callout ${tone}`}>
      <CircleAlert size={17} />
      <div>{children}</div>
    </div>
  )
}

export default function App() {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [draft, setDraft] = useState<Settings | null>(null)
  const [page, setPage] = useState<Page>('overview')
  const [busy, setBusy] = useState('')
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selected, setSelected] = useState<DeployAction[]>([
    'powershell',
    'node',
    'harness',
    'snowluma',
    'bridge',
    'plugins',
  ])
  const [plan, setPlan] = useState<DeployPlan | null>(null)
  const [accept, setAccept] = useState(false)
  const [tokens, setTokens] = useState({ http: '', ws: '' })
  const [query, setQuery] = useState('')
  const [logLevel, setLogLevel] = useState('all')
  const [about, setAbout] = useState(false)
  const closeAbout = useRef<HTMLButtonElement>(null)
  const initialized = useRef(false)
  const dirty = useRef(false)
  const [isDirty, setIsDirty] = useState(false)
  const logEnd = useRef<HTMLDivElement>(null)
  const api = window.deployer
  useEffect(() => {
    if (!api) return
    const update = (s: Snapshot) => {
      setSnap(s)
      if (!initialized.current || !dirty.current) {
        setDraft(s.settings)
        initialized.current = true
      }
    }
    api
      .snapshot()
      .then(update)
      .catch((e) => setToast({ text: e.message, error: true }))
    return api.onChange(update)
  }, [])
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), toast.error ? 10000 : 4500)
      return () => clearTimeout(timer)
    }
  }, [toast])
  useEffect(() => api?.onCommand(() => setAbout(true)), [])
  useEffect(() => {
    if (!about) return
    const previous = document.activeElement as HTMLElement | null
    closeAbout.current?.focus()
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAbout(false)
      if (event.key === 'Tab') {
        const nodes = Array.from(
          document.querySelectorAll<HTMLElement>(
            '.about-dialog button:not(:disabled), .about-dialog a[href]',
          ),
        )
        const first = nodes[0]
        const last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      previous?.focus()
    }
  }, [about])
  async function run(name: string, fn: () => Promise<unknown>, success?: string) {
    if (busy) return
    setBusy(name)
    try {
      await fn()
      if (success) setToast({ text: success, error: false })
      if (api) setSnap(await api.snapshot())
    } catch (e: any) {
      setToast({
        text: e.message.replace(/^Error invoking remote method '[^']+': Error: /, ''),
        error: true,
      })
    } finally {
      setBusy('')
    }
  }
  function change<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((s) => (s ? { ...s, [key]: value } : null))
    dirty.current = true
    setIsDirty(true)
    setPlan(null)
  }
  async function choose(key: keyof Settings, kind: 'file' | 'directory') {
    const value = await api.choosePath(kind)
    if (value) change(key, value)
  }
  async function save(applyBridge = true) {
    if (!draft) return
    const result = await api.saveConfig({
      settings: draft,
      applyBridge,
      ...(tokens.http ? { httpToken: tokens.http } : {}),
      ...(tokens.ws ? { wsToken: tokens.ws } : {}),
    })
    setDraft(result)
    setTokens({ http: '', ws: '' })
    dirty.current = false
    setIsDirty(false)
  }
  const scanning = busy === 'scan'
  const active = !!snap?.task && ['running', 'waiting'].includes(snap.task.state)
  const components = snap?.components || []
  const blockers = components.filter((r) => !r.optional && ['missing', 'error'].includes(r.state))
  const ready = components.filter((r) => r.state === 'ok').length
  const task = snap?.task
  const isTtsTask = !!task?.steps.some((step) => step.id.startsWith('tts-'))
  if (!api)
    return (
      <div className="boot">
        <Fish size={42} />
        <h2>请使用 Electron 启动部署助手</h2>
        <p>在项目目录运行 npm run dev，或打开 Windows EXE。</p>
      </div>
    )
  if (!snap || !draft)
    return (
      <div className="boot">
        <LoaderCircle className="spin" size={32} />
        <p>正在加载本机配置…</p>
        {toast && <p className="error-text">{toast.text}</p>}
      </div>
    )
  const title = nav.find((n) => n.id === page)!
  const snowlumaLoginPanel = (
    <SnowLumaLoginPanel
      key={snap.settings.snowlumaPath}
      reveal={page === 'deploy'}
      onOpen={() => void run('open-snowluma', () => api.open('snowluma'))}
      onCopy={() =>
        void run('copy-snowluma-password', () => api.copySnowLumaPassword(), '初始密码已复制')
      }
    />
  )
  const bridgeLoginPanel = (
    <BridgeLoginPanel
      key={snap.settings.bridgePath}
      onOpen={() => void run('open-bridge', () => api.open('bridge'))}
      onCopy={() => void run('copy-bridge-token', () => api.copyBridgeToken(), '控制台令牌已复制')}
    />
  )
  const pathField = (
    label: string,
    key: keyof Settings,
    kind: 'file' | 'directory',
    placeholder: string,
  ) => (
    <Field key={key} label={label}>
      <div className="input-action">
        <input
          value={String(draft[key])}
          onChange={(e) => change(key, e.target.value as never)}
          placeholder={placeholder}
        />
        <button type="button" aria-label={`选择${label}`} onClick={() => void choose(key, kind)}>
          <FolderOpen size={16} />
        </button>
      </div>
    </Field>
  )

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Fish size={27} />
          </div>
          <div>
            <strong>大肥鱼</strong>
            <span>QQ 部署助手</span>
          </div>
          <span className="version">BETA</span>
        </div>
        <div className="nav-label">工作台</div>
        <nav aria-label="主导航">
          {nav.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <item.icon size={19} />
              <div>
                <strong>{item.label}</strong>
                <span>{item.sub}</span>
              </div>
              {page === item.id && <span className="nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <ShieldCheck size={17} />
            <div>
              <strong>本机部署 · 本地管理</strong>
              <span>配置与凭据保存在你的电脑</span>
            </div>
          </div>
          <button className="help-link" onClick={() => void run('docs', () => api.open('docs'))}>
            <BookOpen size={15} />
            上游项目文档
            <ExternalLink size={12} />
          </button>
          <div className="sidebar-version">
            Windows x64 <span>v{snap.version}</span>
          </div>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            工作台
            <ChevronRight size={13} />
            <span>{title.label}</span>
          </div>
          <div className="topbar-right">
            {snap.appUpdate?.state === 'downloading' || snap.appUpdate?.state === 'downloaded' ? (
              <button className="update-entry" onClick={() => setAbout(true)}>
                <Download size={13} />
                {snap.appUpdate.state === 'downloaded'
                  ? '新版已就绪'
                  : `更新下载 ${snap.appUpdate.percent || 0}%`}
              </button>
            ) : null}
            <span className="local-indicator" />
            本机环境
            <span className="separator" />
            <button className="text-link" onClick={() => setAbout(true)}>
              <CircleHelp size={14} />
              关于软件
            </button>
            <button
              className="icon-btn"
              aria-label="打开数据目录"
              onClick={() => void run('data', () => api.open('data'))}
            >
              <FolderOpen size={17} />
            </button>
          </div>
        </header>
        <main>
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {page === 'overview'
                  ? 'ENVIRONMENT'
                  : page === 'deploy'
                    ? 'DEPLOYMENT'
                    : page === 'advanced'
                      ? 'LOCAL VOICE'
                      : page === 'config'
                        ? 'CONNECTION'
                        : page === 'services'
                          ? 'RUNTIME'
                          : 'DIAGNOSTICS'}
              </div>
              <h1>{title.label}</h1>
              <p>
                {page === 'overview'
                  ? '从环境到连接，一眼掌握大肥鱼的部署状态。'
                  : page === 'deploy'
                    ? '只安装你需要的组件，每一步都有据可查。'
                    : page === 'advanced'
                      ? '扫描设备后，独立部署 Qwen3-TTS 本地语音模型。'
                      : page === 'config'
                        ? '连接你的 Harness 与 QQ，明确机器人可以回应的范围。'
                        : page === 'services'
                          ? '集中管理服务，区分启动状态与实际连接健康。'
                          : '查看运行记录、导出诊断，或恢复之前的配置。'}
              </p>
            </div>
            <div className="heading-actions">
              {page === 'overview' || page === 'services' ? (
                <Button
                  primary
                  loading={scanning}
                  disabled={!!busy}
                  onClick={() => void run('scan', () => api.scan())}
                >
                  <RefreshCw size={15} />
                  检测环境
                </Button>
              ) : page === 'config' ? (
                <Button
                  primary
                  disabled={!!busy || active}
                  loading={busy === 'save'}
                  onClick={() => void run('save', () => save(), '配置已保存')}
                >
                  <Check size={16} />
                  保存配置{isDirty && <span className="unsaved-dot" />}
                </Button>
              ) : page === 'logs' ? (
                <Button
                  disabled={!!busy}
                  onClick={() =>
                    void run('export', async () => {
                      const file = await api.exportDiagnostics()
                      if (file) setToast({ text: `已导出：${file}`, error: false })
                    })
                  }
                >
                  <Download size={15} />
                  导出诊断
                </Button>
              ) : page === 'advanced' ? null : (
                <Button ghost onClick={() => setPage('config')}>
                  设置安装位置
                  <ArrowRight size={15} />
                </Button>
              )}
            </div>
          </div>

          <section hidden={page !== 'overview'} aria-label="环境总览">
            <div className="summary-grid">
              <div className="summary-item">
                <div className="summary-icon teal">
                  <Plug size={21} />
                </div>
                <div>
                  <span>正常组件</span>
                  <strong>
                    {components.length ? ready : '—'}
                    <small>/ {components.length || '待检测'}</small>
                  </strong>
                </div>
              </div>
              <div className="summary-item">
                <div className="summary-icon amber">
                  <Wrench size={21} />
                </div>
                <div>
                  <span>待处理项目</span>
                  <strong>
                    {components.length ? blockers.length : '—'}
                    <small>{components.length ? '项阻塞' : '先检测环境'}</small>
                  </strong>
                </div>
              </div>
              <div className="summary-item">
                <div className="summary-icon slate">
                  <ShieldCheck size={21} />
                </div>
                <div>
                  <span>QQ 消息往返</span>
                  <strong className="text-value">待实测</strong>
                  <small className="summary-foot">完成登录后由你发送测试消息</small>
                </div>
              </div>
            </div>
            {components.length > 0 && blockers.length > 0 && (
              <div className="next-step">
                <div>
                  <CircleAlert size={19} />
                  <div>
                    <strong>还有 {blockers.length} 项需要处理</strong>
                    <p>
                      {blockers
                        .slice(0, 3)
                        .map((r) => r.name)
                        .join('、')}
                      {blockers.length > 3 ? '等' : ''}，可以前往快速部署按需补齐。
                    </p>
                  </div>
                </div>
                <Button onClick={() => setPage('deploy')}>
                  前往部署
                  <ArrowRight size={15} />
                </Button>
              </div>
            )}
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>组件与连接</h2>
                  <span>安装、运行、鉴权分别检查</span>
                </div>
                <Button
                  ghost
                  disabled={!!busy || !components.length}
                  loading={busy === 'updates'}
                  onClick={() => void run('updates', () => api.updates())}
                >
                  <RefreshCw size={14} />
                  检查官方版本
                </Button>
              </div>
              {!components.length ? (
                <div className="empty-state">
                  <div className="empty-orbit">
                    <Search size={30} />
                  </div>
                  <h3>先了解这台电脑的环境</h3>
                  <p>检测已有软件、版本与连接状态。检测过程不会安装或修改软件。</p>
                  <Button
                    primary
                    loading={scanning}
                    disabled={!!busy}
                    onClick={() => void run('scan', () => api.scan())}
                  >
                    开始环境检测
                    <ArrowRight size={15} />
                  </Button>
                  <div className="empty-list">
                    <span>Harness</span>
                    <span>SnowLuma</span>
                    <span>QQ Bridge</span>
                    <span>PowerShell 7</span>
                  </div>
                </div>
              ) : (
                <div className="component-table">
                  <div className="table-header">
                    <span>组件</span>
                    <span>当前版本 / 官方最新</span>
                    <span>状态</span>
                    <span>操作</span>
                  </div>
                  {components.map((item) => (
                    <div
                      key={item.id}
                      className={`component-wrap ${expanded === item.id ? 'expanded' : ''}`}
                    >
                      <div className="component-row">
                        <div className="component-name">
                          <div className={`component-symbol ${item.state === 'ok' ? 'good' : ''}`}>
                            {item.id === 'powershell' ||
                            item.id === 'node' ||
                            item.id === 'npm' ||
                            item.id === 'git' ? (
                              <Terminal size={18} />
                            ) : (
                              <Plug size={18} />
                            )}
                          </div>
                          <div>
                            <strong>
                              {item.name}
                              {item.optional && <em>可选</em>}
                            </strong>
                            <p>{item.detail}</p>
                          </div>
                        </div>
                        <div className="component-version">
                          <code>{item.version || '未识别'}</code>
                          <span>
                            {item.latest
                              ? `最新 ${item.latest}`
                              : item.updateError
                                ? '查询失败'
                                : '未查询'}
                          </span>
                        </div>
                        <Badge state={item.state} />
                        <button
                          className="details-btn"
                          aria-expanded={expanded === item.id}
                          onClick={() => setExpanded((v) => (v === item.id ? null : item.id))}
                        >
                          详情
                          <ChevronDown size={14} />
                        </button>
                      </div>
                      {expanded === item.id && (
                        <div className="component-details">
                          <dl>
                            <dt>安装位置</dt>
                            <dd>{item.path || '尚未发现，可在连接配置中指定'}</dd>
                            <dt>检测依据</dt>
                            <dd>{item.evidence.join(' · ') || '尚无可用安装证据'}</dd>
                            {item.compatibility && (
                              <>
                                <dt>兼容说明</dt>
                                <dd>{item.compatibility}</dd>
                              </>
                            )}
                            {item.updateError && (
                              <>
                                <dt>查询异常</dt>
                                <dd>{item.updateError}</dd>
                              </>
                            )}
                          </dl>
                          {item.candidates.length > 1 && (
                            <Field label="发现多份安装 · 选择需要管理的版本">
                              <select
                                value={item.path}
                                onChange={(e) => {
                                  const keys: Record<string, keyof Settings> = {
                                    node: 'nodePath',
                                    powershell: 'pwshPath',
                                    qq: 'qqPath',
                                    harness: 'harnessPath',
                                    bridge: 'bridgePath',
                                    snowluma: 'snowlumaPath',
                                  }
                                  const key = keys[item.id]
                                  if (key) {
                                    change(key, e.target.value)
                                    setPage('config')
                                  }
                                }}
                              >
                                {item.candidates.map((c) => (
                                  <option key={c.path} value={c.path}>
                                    {c.path}
                                  </option>
                                ))}
                              </select>
                            </Field>
                          )}
                          <Button ghost onClick={() => setPage('config')}>
                            调整配置
                            <ArrowRight size={13} />
                          </Button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="foot-note">
              <ShieldCheck size={15} />
              <span>版本更新与兼容通过分开展示；组件就绪后，仍需完成一次真实 QQ 消息往返。</span>
            </div>
          </section>

          <section hidden={page !== 'deploy'} aria-label="快速部署">
            <div className="workflow">
              <span className="current">
                <b>1</b>选择组件
              </span>
              <i />
              <span className={plan ? 'current' : ''}>
                <b>2</b>检查变更
              </span>
              <i />
              <span className={active ? 'current' : ''}>
                <b>3</b>部署与验证
              </span>
            </div>
            <div className="deploy-layout">
              <div className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>按需安装</h2>
                    <span>不会直接覆盖已有的系统环境</span>
                  </div>
                  <span className="muted">已选 {selected.length} 项</span>
                </div>
                <div className="deploy-options">
                  {deployOptions.map((option) => {
                    const installed = components.find((c) => c.id === option.id)
                    return (
                      <label
                        key={option.id}
                        className={`deploy-option ${selected.includes(option.id) ? 'checked' : ''}`}
                      >
                        <input
                          type="checkbox"
                          checked={selected.includes(option.id)}
                          disabled={active}
                          onChange={() => {
                            setSelected((v) =>
                              v.includes(option.id)
                                ? v.filter((id) => id !== option.id)
                                : [...v, option.id],
                            )
                            setPlan(null)
                          }}
                        />
                        <div>
                          <strong>{option.title}</strong>
                          <p>{option.sub}</p>
                        </div>
                        <div className="option-meta">
                          <code>{option.version}</code>
                          {installed?.path && <span>检测到已有安装</span>}
                        </div>
                      </label>
                    )
                  })}
                </div>
                <div className="deploy-settings">
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={draft.registerPwshPath}
                      onChange={(e) => change('registerPwshPath', e.target.checked)}
                      disabled={active}
                    />
                    将专用 PowerShell 7 加入当前用户 PATH
                  </label>
                  <small>供新终端和 AI 调用 pwsh；已启动的程序需要重启。</small>
                  {selected.includes('snowluma') && (
                    <label className="check-line authorization">
                      <input
                        type="checkbox"
                        checked={draft.snowlumaAuthorized}
                        disabled={active}
                        onChange={(e) => change('snowlumaAuthorized', e.target.checked)}
                      />
                      我已有覆盖本次 SnowLuma 自动下载部署用途的书面授权
                    </label>
                  )}
                </div>
              </div>
              <aside className="deploy-aside">
                <div className="panel side-panel">
                  <div className="panel-heading">
                    <h2>部署位置</h2>
                    <FolderOpen size={17} />
                  </div>
                  <p className="path-text">{draft.installRoot}</p>
                  <Button ghost onClick={() => void choose('installRoot', 'directory')}>
                    更换目录
                    <ChevronRight size={14} />
                  </Button>
                  <hr />
                  <h3>过程可见，可随时取消</h3>
                  <ul className="check-list">
                    <li>
                      <Check size={14} />
                      官方下载与 SHA-256 校验
                    </li>
                    <li>
                      <Check size={14} />
                      修改配置前自动备份
                    </li>
                    <li>
                      <Check size={14} />
                      登录与协议由你完成
                    </li>
                    <li>
                      <Check size={14} />
                      失败后保留诊断记录
                    </li>
                  </ul>
                </div>
                <Button
                  primary
                  className="full-width"
                  disabled={!!busy || active || !selected.length}
                  loading={busy === 'preview'}
                  onClick={() =>
                    void run('preview', async () => {
                      await save(false)
                      setPlan(await api.preview({ actions: selected, acceptUnverified: false }))
                      setAccept(false)
                    })
                  }
                >
                  预览部署变更
                  <ArrowRight size={16} />
                </Button>
              </aside>
            </div>
            {plan && (
              <div className="panel preview-panel">
                <div className="panel-heading">
                  <div>
                    <h2>即将执行的变更</h2>
                    <span>核对版本与目录后开始</span>
                  </div>
                  <span className="badge waiting">
                    <ShieldCheck size={13} />
                    等待确认
                  </span>
                </div>
                <div className="plan-items">
                  {plan.items.map((item) => (
                    <div key={item.id} className="plan-item">
                      <div>
                        <strong>{item.title}</strong>
                        <code>{item.version}</code>
                      </div>
                      <p>{item.destination}</p>
                      <small>{item.changes.join(' · ')}</small>
                      <details>
                        <summary>查看下载来源</summary>
                        <p className="source-url">{item.source}</p>
                      </details>
                    </div>
                  ))}
                </div>
                <div className="preview-footer">
                  {plan.warnings.map((w) => (
                    <p key={w}>
                      <CircleAlert size={14} />
                      {w}
                    </p>
                  ))}
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={accept}
                      onChange={(e) => setAccept(e.target.checked)}
                    />
                    我已核对上述变更，理解待实测与用户操作步骤
                  </label>
                  <Button
                    primary
                    disabled={!accept || active || !!busy}
                    loading={busy === 'deploy'}
                    onClick={() =>
                      void run('deploy', () =>
                        api.deploy({ ...plan.request, acceptUnverified: true }),
                      )
                    }
                  >
                    <Play size={15} />
                    开始部署
                  </Button>
                </div>
              </div>
            )}
          </section>
          <section hidden={page !== 'advanced'} aria-label="进阶功能">
            <AdvancedTtsPanel
              settings={draft}
              active={active}
              busy={busy}
              change={change}
              save={() => save(false)}
              run={run}
              latestScan={snap.ttsScan}
            />
          </section>
          <section hidden={page !== (isTtsTask ? 'advanced' : 'deploy')} aria-label="部署任务">
            {task && (
              <div className="panel task-panel">
                <div className="panel-heading">
                  <div>
                    <h2>部署步骤</h2>
                    <span>
                      {task.state === 'done'
                        ? isTtsTask
                          ? '模型已通过短语音测试，请将模型目录 README.md 交给 dsh 接入'
                          : '所选安装步骤完成，连接及消息往返仍需验证'
                        : task.state === 'failed'
                          ? '遇到问题，可修复后重试'
                          : '操作与输出实时更新'}
                    </span>
                  </div>
                  {task.state === 'failed' || task.state === 'cancelled' ? (
                    <Button disabled={!!busy} onClick={() => void run('retry', () => api.retry())}>
                      <RefreshCw size={14} />
                      重试未完成步骤
                    </Button>
                  ) : null}
                </div>
                <div className="task-steps">
                  {task.steps.map((step, i) => (
                    <div key={step.id} className={`task-step ${step.state}`}>
                      <div className="step-symbol">
                        {step.state === 'done' ? (
                          <Check size={16} />
                        ) : step.state === 'running' ? (
                          <LoaderCircle className="spin" size={16} />
                        ) : step.state === 'failed' ? (
                          <X size={16} />
                        ) : (
                          i + 1
                        )}
                      </div>
                      <div>
                        <strong>{step.title}</strong>
                        <p>
                          {step.detail ||
                            (step.state === 'done'
                              ? '此步骤已完成'
                              : step.state === 'running'
                                ? '正在执行…'
                                : '等待执行')}
                        </p>
                        {step.state === 'running' && typeof step.progress === 'number' && (
                          <progress max="100" value={step.progress} />
                        )}
                      </div>
                      <span>
                        {step.state === 'done'
                          ? '完成'
                          : step.state === 'waiting'
                            ? '等待操作'
                            : step.state === 'running'
                              ? isTtsTask && typeof step.progress !== 'number'
                                ? '执行中'
                                : `${step.progress || 0}%`
                              : step.state === 'failed'
                                ? '失败'
                                : step.state === 'cancelled'
                                  ? '已取消'
                                  : ''}
                      </span>
                    </div>
                  ))}
                </div>
                {task.error && <Callout tone="error">{task.error}</Callout>}
                {page === 'deploy' &&
                  task.steps.some((step) => step.id === 'snowluma' && step.state === 'waiting') &&
                  snowlumaLoginPanel}
                {page === 'deploy' &&
                  task.steps.some((step) => step.id === 'bridge' && step.state === 'done') &&
                  bridgeLoginPanel}
              </div>
            )}
          </section>

          <section hidden={page !== 'config'} aria-label="连接配置">
            <div className="config-top">
              <Callout>
                优先导入已有配置，保留现有白名单和模型设置。令牌只在本机加密保存，不会回显到界面。
              </Callout>
              <Button
                disabled={!!busy || active}
                loading={busy === 'import'}
                onClick={() =>
                  void run(
                    'import',
                    async () => {
                      const s = await api.importConfig()
                      setDraft(s)
                      setTokens({ http: '', ws: '' })
                      setIsDirty(false)
                      dirty.current = false
                    },
                    '已有配置及端点已导入',
                  )
                }
              >
                <Download size={15} />
                导入已有配置
              </Button>
            </div>
            <div className="panel config-section">
              <div className="section-title">
                <div className="number-label">01</div>
                <div>
                  <h2>连接与账号</h2>
                  <p>指定本机服务地址与机器人可回应的范围</p>
                </div>
              </div>
              <div className="form-grid">
                <Field
                  label="Harness 服务地址"
                  note="桌面版端口可能变化；环境检测会从所选进程发现实际端口"
                >
                  <input value={draft.dshUrl} onChange={(e) => change('dshUrl', e.target.value)} />
                </Field>
                <Field label="模型标识" note="需为 Harness 中已配置的可用模型">
                  <input value={draft.model} onChange={(e) => change('model', e.target.value)} />
                </Field>
                <Field label="OneBot HTTP 地址">
                  <input
                    value={draft.httpUrl}
                    onChange={(e) => change('httpUrl', e.target.value)}
                  />
                </Field>
                <Field label="OneBot WebSocket 地址">
                  <input value={draft.wsUrl} onChange={(e) => change('wsUrl', e.target.value)} />
                </Field>
                <Field
                  label="HTTP 令牌"
                  note={
                    snap.tokenPresent.http
                      ? '已有已加密令牌；留空保留原值'
                      : '可从 SnowLuma 配置导入'
                  }
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={tokens.http}
                    placeholder={
                      snap.tokenPresent.http ? '已保存 · 不回显' : '输入 HTTP accessToken'
                    }
                    onChange={(e) => {
                      setTokens((t) => ({ ...t, http: e.target.value }))
                      setIsDirty(true)
                    }}
                  />
                </Field>
                <Field
                  label="WebSocket 令牌"
                  note={
                    snap.tokenPresent.ws
                      ? '已有已加密令牌；HTTP 与 WS 令牌可能不同'
                      : 'HTTP 与 WS 令牌分别处理'
                  }
                >
                  <input
                    type="password"
                    autoComplete="off"
                    value={tokens.ws}
                    placeholder={
                      snap.tokenPresent.ws ? '已保存 · 不回显' : '输入 WebSocket accessToken'
                    }
                    onChange={(e) => {
                      setTokens((t) => ({ ...t, ws: e.target.value }))
                      setIsDirty(true)
                    }}
                  />
                </Field>
                <Field label="管理员 QQ">
                  <input
                    value={draft.ownerQQ}
                    inputMode="numeric"
                    placeholder="你的 QQ 号"
                    onChange={(e) => change('ownerQQ', e.target.value)}
                  />
                </Field>
                <Field label="桥接控制台端口">
                  <input
                    type="number"
                    min="1024"
                    max="65535"
                    value={draft.consolePort}
                    onChange={(e) => change('consolePort', Number(e.target.value))}
                  />
                </Field>
                <Field label="允许回应的群号" note="多个群号使用逗号或空格分隔">
                  <textarea
                    value={draft.groups}
                    placeholder="填写允许机器人回应的群号"
                    onChange={(e) => change('groups', e.target.value)}
                  />
                </Field>
                <Field label="允许回应的好友 QQ" note="空白名单不会放行所有人">
                  <textarea
                    value={draft.friends}
                    placeholder="填写允许机器人回应的好友 QQ"
                    onChange={(e) => change('friends', e.target.value)}
                  />
                </Field>
              </div>
            </div>
            <div className="panel config-section">
              <div className="section-title">
                <div className="number-label">02</div>
                <div>
                  <h2>安装与配置位置</h2>
                  <p>留空的程序路径会在检测时自动发现；手动选择优先</p>
                </div>
              </div>
              <div className="form-grid">
                {pathField('组件安装目录', 'installRoot', 'directory', '工具专用组件目录')}
                {pathField('Harness 数据目录', 'dshHome', 'directory', '通常为用户目录下的 .dsh')}
                {pathField('Harness 程序', 'harnessPath', 'file', '选择官方桌面版 EXE')}
                {pathField('QQ 程序', 'qqPath', 'file', '选择 QQ.exe')}
                {pathField(
                  'SnowLuma 目录',
                  'snowlumaPath',
                  'directory',
                  '包含 launcher.bat 的目录',
                )}
                {pathField(
                  'QQ Bridge 目录',
                  'bridgePath',
                  'directory',
                  '包含 src/bridge.js 的目录',
                )}
                {pathField('Node.js 程序', 'nodePath', 'file', '选择 node.exe')}
                {pathField('PowerShell 7 程序', 'pwshPath', 'file', '选择 pwsh.exe')}
              </div>
            </div>
            <div className="panel config-section">
              <div className="section-title">
                <div className="number-label">03</div>
                <div>
                  <h2>下载与部署选项</h2>
                  <p>官方来源下载，按授权范围部署</p>
                </div>
              </div>
              <div className="form-grid">
                <Field
                  label="HTTP(S) 代理（可选）"
                  note="仅用于下载和安装进程，不改变系统代理；不填写账号密码"
                >
                  <input
                    value={draft.proxy}
                    placeholder="http://127.0.0.1:7890"
                    onChange={(e) => change('proxy', e.target.value)}
                  />
                </Field>
                <div>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={draft.registerPwshPath}
                      onChange={(e) => change('registerPwshPath', e.target.checked)}
                    />
                    安装 PowerShell 7 时加入用户 PATH
                  </label>
                  <small className="muted">已运行的 AI / 终端需要重启后使用新 PATH。</small>
                </div>
              </div>
              <label className="check-line authorization">
                <input
                  type="checkbox"
                  checked={draft.snowlumaAuthorized}
                  onChange={(e) => change('snowlumaAuthorized', e.target.checked)}
                />
                已有覆盖本次 SnowLuma 自动下载部署用途的书面授权
              </label>
              <Button ghost onClick={() => void run('license', () => api.open('snow-docs'))}>
                查看 SnowLuma 许可
                <ExternalLink size={12} />
              </Button>
            </div>
            <div className="save-footer">
              <span>{isDirty ? '有未保存的修改 · 切换页面会保留' : '配置已同步'}</span>
              <Button
                primary
                disabled={!!busy || active}
                loading={busy === 'save'}
                onClick={() => void run('save', () => save(), '连接配置已保存')}
              >
                <Check size={15} />
                保存连接配置
              </Button>
            </div>
          </section>

          <section hidden={page !== 'services'} aria-label="运行管理">
            <div className="config-top">
              <Callout>
                部署完成后会自动扫描并应用实际配置；Harness
                端口或网关配置变化后，也可在这里重新同步。
              </Callout>
              <Button
                disabled={!!busy || active || isDirty}
                loading={busy === 'sync-environment'}
                onClick={() =>
                  void run('sync-environment', () => api.syncEnvironment(), '实际连接配置已同步')
                }
              >
                <RefreshCw size={14} />
                检测并应用实际配置
              </Button>
            </div>
            <Callout>
              启动请求成功不代表链路健康。登录状态与消息接收情况，请通过重新检测和真实 QQ 测试确认。
            </Callout>
            <div className="service-grid">
              {(['harness', 'snowluma', 'bridge'] as const).map((id) => {
                const component = components.find((c) => c.id === id)
                const owned = !!snap.owned[id]
                return (
                  <div key={id} className="panel service-card">
                    <div className="service-heading">
                      <div className="service-icon">
                        <Plug size={22} />
                      </div>
                      <Badge state={component?.state || 'unknown'} />
                    </div>
                    <h2>
                      {id === 'harness'
                        ? 'Harness 桌面版'
                        : id === 'snowluma'
                          ? 'SnowLuma 网关'
                          : 'QQ Bridge'}
                    </h2>
                    <p>{component?.detail || '尚未检测，请先检查本机环境'}</p>
                    <div className="service-owner">
                      <span className={owned ? 'owner-dot yes' : 'owner-dot'} />
                      {owned ? `由助手启动 · PID ${snap.owned[id]}` : '未记录助手启动的进程'}
                    </div>
                    <div className="service-actions">
                      <Button
                        primary
                        disabled={!!busy || active}
                        onClick={() => void run(`start-${id}`, () => api.service(id, 'start'))}
                      >
                        <Play size={14} />
                        启动
                      </Button>
                      <Button
                        disabled={!!busy || active || !owned}
                        onClick={() => void run(`restart-${id}`, () => api.service(id, 'restart'))}
                      >
                        <RefreshCw size={14} />
                        重启
                      </Button>
                      <Button
                        disabled={!!busy || active || !owned}
                        onClick={() => void run(`stop-${id}`, () => api.service(id, 'stop'))}
                      >
                        <Square size={14} />
                        停止
                      </Button>
                    </div>
                    <button
                      className="text-link"
                      onClick={() => void run(`open-${id}`, () => api.open(id))}
                    >
                      打开{id === 'harness' ? '官方程序' : '控制台'}
                      <ExternalLink size={13} />
                    </button>
                  </div>
                )
              })}
            </div>
            {page === 'services' && <div className="panel">{snowlumaLoginPanel}</div>}
            {page === 'services' && <div className="panel">{bridgeLoginPanel}</div>}
            <div className="panel acceptance">
              <ShieldCheck size={24} />
              <div>
                <h2>最后一步：在 QQ 中确认一次完整往返</h2>
                <p>
                  完成登录与白名单配置 → 启动 Harness 和桥接 → 在允许的群或私聊发送消息 → 确认 AI
                  回复。
                </p>
                <span className="badge unknown">
                  <CircleHelp size={13} />
                  真实消息往返待用户实测
                </span>
              </div>
            </div>
          </section>

          <section hidden={page !== 'logs'} aria-label="日志诊断">
            <div className="panel">
              <div className="panel-heading">
                <div>
                  <h2>运行日志</h2>
                  <span>凭据已隐藏，不采集聊天内容作为诊断附件</span>
                </div>
                <div className="log-tools">
                  <div className="search-box">
                    <Search size={14} />
                    <input
                      aria-label="搜索日志"
                      placeholder="搜索日志内容"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <select
                    aria-label="日志级别"
                    value={logLevel}
                    onChange={(e) => setLogLevel(e.target.value)}
                  >
                    <option value="all">全部级别</option>
                    <option value="error">错误</option>
                    <option value="warn">提醒</option>
                    <option value="info">信息</option>
                  </select>
                </div>
              </div>
              <div className="log-view" role="log">
                {snap.logs
                  .filter(
                    (l) =>
                      (logLevel === 'all' || l.level === logLevel) &&
                      l.message.toLowerCase().includes(query.toLowerCase()),
                  )
                  .map((log) => (
                    <div key={log.id} className={`log-line ${log.level}`}>
                      <time>{new Date(log.at).toLocaleTimeString('zh-CN', { hour12: false })}</time>
                      <span className="log-level">
                        {log.level === 'error' ? '错误' : log.level === 'warn' ? '提醒' : '信息'}
                      </span>
                      <span>{log.message}</span>
                    </div>
                  ))}
                {!snap.logs.length && (
                  <div className="empty-log">尚无日志，操作后会在这里显示。</div>
                )}
                <div ref={logEnd} />
              </div>
            </div>
            <div className="panel backup-panel">
              <div className="panel-heading">
                <div>
                  <h2>配置备份</h2>
                  <span>文件已被后续修改时，恢复会停止并保留当前内容</span>
                </div>
                <Button ghost onClick={() => void run('data', () => api.open('data'))}>
                  <FolderOpen size={14} />
                  打开数据目录
                </Button>
              </div>
              {snap.backups.length ? (
                snap.backups.slice(0, 12).map((b) => (
                  <div className="backup-row" key={b.id}>
                    <div>
                      <strong>{b.label}</strong>
                      <span>{new Date(b.createdAt).toLocaleString('zh-CN')}</span>
                    </div>
                    <Button
                      disabled={!!busy || active}
                      onClick={() => {
                        if (
                          window.confirm(
                            '恢复前请停止桥接并完全退出 Harness。确定恢复这份配置备份？',
                          )
                        )
                          void run('restore', () => api.restore(b.id), '配置已恢复，请重启后检测')
                      }}
                    >
                      恢复配置
                    </Button>
                  </div>
                ))
              ) : (
                <div className="small-empty">修改桥接配置或安装插件后，这里会出现备份记录。</div>
              )}
            </div>
          </section>
        </main>
        <footer className={`taskbar ${active ? 'has-task' : ''}`}>
          <div className="taskbar-status">
            {active ? (
              <LoaderCircle size={16} className={task?.state === 'waiting' ? '' : 'spin'} />
            ) : task?.state === 'failed' ? (
              <CircleAlert size={16} />
            ) : (
              <CheckCircle2 size={16} />
            )}
            <div>
              <strong>
                {active
                  ? task?.state === 'waiting'
                    ? '等待你的操作'
                    : '部署任务进行中'
                  : task?.state === 'done'
                    ? isTtsTask
                      ? '语音模型部署完成 · 通过 dsh 自行接入'
                      : '安装步骤完成 · 请继续验证连接'
                    : task?.state === 'failed'
                      ? '部署遇到问题'
                      : '准备就绪'}
              </strong>
              <span>
                {active
                  ? task?.steps.find((s) => ['running', 'waiting'].includes(s.state))?.detail ||
                    task?.steps.find((s) => s.state === 'running')?.title
                  : '本地管理 · 官方来源 · 操作可追溯'}
              </span>
            </div>
          </div>
          <div className="taskbar-actions">
            {active && task?.state === 'waiting' && (
              <Button
                primary
                disabled={!!busy}
                onClick={() => void run('resume', () => api.resume())}
              >
                已完成，继续
                <ArrowRight size={14} />
              </Button>
            )}
            {active && (
              <Button disabled={!!busy} onClick={() => void run('cancel', () => api.cancel())}>
                取消任务
              </Button>
            )}
            {task && (
              <button
                className="text-link"
                onClick={() => setPage(isTtsTask ? 'advanced' : 'deploy')}
              >
                查看步骤
                <ChevronRight size={13} />
              </button>
            )}
            <button className="text-link" onClick={() => setPage('logs')}>
              <Terminal size={14} />
              日志
            </button>
          </div>
        </footer>
      </div>
      {about && (
        <div
          className="modal-backdrop"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAbout(false)
          }}
        >
          <div
            className="about-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="about-title"
          >
            <div className="about-header">
              <div className="brand-icon">
                <Fish size={28} />
              </div>
              <div>
                <h2 id="about-title">关于大肥鱼 QQ 部署助手</h2>
                <p>
                  v{snap.version} · 开发者：<strong>安索</strong>
                </p>
              </div>
              <button
                ref={closeAbout}
                className="icon-btn"
                aria-label="关闭关于软件"
                onClick={() => setAbout(false)}
              >
                <X size={19} />
              </button>
            </div>
            <div className="about-scroll">
              <div className="app-update-panel">
                <div>
                  <h3>软件更新</h3>
                  <p>{snap.appUpdate?.detail || '从 GitHub 最新正式 Release 检查更新'}</p>
                  {snap.appUpdate?.latest && (
                    <small>
                      当前 {snap.version} · 最新 {snap.appUpdate.latest}
                    </small>
                  )}
                  {snap.appUpdate?.state === 'downloading' && (
                    <progress max="100" value={snap.appUpdate.percent || 0} />
                  )}
                </div>
                <div className="update-actions">
                  <Button
                    loading={snap.appUpdate?.state === 'checking'}
                    disabled={!!busy || snap.appUpdate?.state === 'downloading'}
                    onClick={() => void run('app-update', () => api.checkAppUpdate())}
                  >
                    <RefreshCw size={14} />
                    检查软件更新
                  </Button>
                  {snap.appUpdate?.state === 'downloaded' && (
                    <Button
                      primary
                      disabled={active || !!busy}
                      onClick={() => void run('install-app-update', () => api.installAppUpdate())}
                    >
                      {snap.appUpdate.mode === 'portable' ? '打开新版位置' : '重启安装新版'}
                      <ArrowRight size={14} />
                    </Button>
                  )}
                </div>
              </div>
              <p className="about-intro">
                感谢以下项目。蓝色项目名称可打开对应源码仓库；第三方组件适用其各自许可。
              </p>
              <div className="project-list">
                {projects.map((project) => (
                  <div className="project-row" key={project.id}>
                    <div>
                      <a
                        href={project.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(event) => {
                          event.preventDefault()
                          void run('project', () => api.openProject(project.id))
                        }}
                      >
                        {project.name}
                        <ExternalLink size={12} />
                      </a>
                      <p>{project.role}</p>
                    </div>
                    <span>{project.license}</span>
                  </div>
                ))}
              </div>
              <p className="about-footer-note">
                SnowLuma
                单独列为第三方组件，采用源码可见非商业许可；自动化部署须在相关书面授权范围内使用。项目与腾讯、DeepSeek、微软等无隶属或官方背书关系。
              </p>
            </div>
            <div className="about-bottom">
              <a
                href={releaseRepository.url + '/releases/latest'}
                onClick={(event) => {
                  event.preventDefault()
                  void run('repository', () => api.openProject('repository'))
                }}
              >
                GitHub · AnsoNeko/qq-dsh-deployer
                <ExternalLink size={12} />
              </a>
              <span>MIT License</span>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div role="alert" className={`toast ${toast.error ? 'error' : ''}`}>
          {toast.error ? <CircleAlert size={19} /> : <CheckCircle2 size={19} />}
          <span>{toast.text}</span>
          <button aria-label="关闭提示" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  )
}
