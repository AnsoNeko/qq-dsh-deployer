import { useEffect, useState } from 'react'
import { FolderOpen, LoaderCircle, RefreshCw, Volume2 } from 'lucide-react'
import type { Settings, TtsPlan, TtsScan } from '../../shared/types'

export function AdvancedTtsPanel({
  settings,
  active,
  busy,
  change,
  save,
  run,
  latestScan,
}: {
  settings: Settings
  active: boolean
  busy: string
  change: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  save: () => Promise<void>
  run: (name: string, fn: () => Promise<unknown>, success?: string) => Promise<void>
  latestScan?: TtsScan
}) {
  const [plan, setPlan] = useState<TtsPlan | null>(null)
  const [accept, setAccept] = useState(false)
  useEffect(() => {
    if (!latestScan) return
    setPlan((previous) =>
      previous && previous.scan.root === latestScan.root && previous.scan.mode === latestScan.mode
        ? { ...previous, scan: latestScan }
        : previous,
    )
    if (latestScan.blockers.length) setAccept(false)
  }, [latestScan?.scannedAt])
  const api = window.deployer
  const valid = plan?.scan.root === settings.ttsRoot && plan.scan.mode === settings.ttsMode
  const scan = valid ? plan.scan : undefined
  function invalidate() {
    setPlan(null)
    setAccept(false)
  }
  return (
    <div className="tts-panel">
      <div className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              <Volume2 size={17} /> 本地语音合成
            </h2>
            <span>Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice · 可选进阶功能</span>
          </div>
          <span className="tag">仅部署</span>
        </div>
        <div className="tts-body">
          <div className="callout">
            <Volume2 size={18} />
            <div>
              助手负责安装模型、独立运行环境和短语音测试。完成后将目录中的 README.md 交给已部署的
              dsh，由你自行配置 QQ鱼接入。
            </div>
          </div>
          <label className="field">
            <span>语音模型独立安装目录</span>
            <div className="input-action">
              <input
                aria-label="语音模型独立安装目录"
                value={settings.ttsRoot}
                disabled={active || !!busy}
                onChange={(e) => {
                  change('ttsRoot', e.target.value)
                  invalidate()
                }}
              />
              <button
                type="button"
                aria-label="选择语音模型独立安装目录"
                disabled={active || !!busy}
                onClick={() =>
                  void run('tts-path', async () => {
                    const root = await api.choosePath('directory')
                    if (root) {
                      change('ttsRoot', root)
                      invalidate()
                    }
                  })
                }
              >
                <FolderOpen size={16} />
              </button>
            </div>
            <small>
              请选择空目录；与原组件目录、dsh
              数据目录不能相同或互相包含。Python、依赖、模型、缓存均存放于此。
            </small>
          </label>
          <label className="field">
            <span>部署运行模式</span>
            <select
              aria-label="部署运行模式"
              value={settings.ttsMode}
              disabled={active || !!busy}
              onChange={(e) => {
                change('ttsMode', e.target.value as Settings['ttsMode'])
                invalidate()
              }}
            >
              <option value="auto">NVIDIA GPU 加速（推荐，需扫描确认）</option>
              <option value="cpu">CPU 模式（显式选择，合成可能很慢）</option>
            </select>
            <small>
              自动安装独立 Python 3.12；GPU 版使用 CUDA 12.8 PyTorch。下载代理沿用“连接配置”。
            </small>
          </label>
          <div className="tts-actions">
            <button
              className="btn primary"
              disabled={active || !!busy}
              onClick={() =>
                void run('tts-scan', async () => {
                  invalidate()
                  await save()
                  setPlan(await api.scanTts())
                })
              }
            >
              {busy === 'tts-scan' ? (
                <LoaderCircle size={15} className="spin" />
              ) : (
                <RefreshCw size={15} />
              )}
              扫描设备并预览部署
            </button>
            <button
              className="btn"
              disabled={!!busy || active}
              onClick={() => void run('tts-open', () => api.open('tts'))}
            >
              <FolderOpen size={15} />
              打开模型目录
            </button>
          </div>
        </div>
      </div>
      {scan && plan && (
        <div className="panel">
          <div className="panel-heading">
            <div>
              <h2>设备扫描与部署预览</h2>
              <span>
                扫描时间：{new Date(scan.scannedAt).toLocaleString()} · 开始安装前会再次检查设备
              </span>
            </div>
            <span className={`badge ${scan.blockers.length ? 'error' : 'ok'}`}>
              {scan.installed ? '已有部署记录' : scan.blockers.length ? '需处理' : '可部署'}
            </span>
          </div>
          <div className="tts-body">
            <dl className="tts-facts">
              <dt>系统 / CPU</dt>
              <dd>
                {scan.platform} {scan.arch} · {scan.cpu}
              </dd>
              <dt>内存</dt>
              <dd>
                {scan.ramGiB.toFixed(1)} GiB · 当前可用 {scan.availableRamGiB.toFixed(1)} GiB
              </dd>
              <dt>目标磁盘</dt>
              <dd>可用 {scan.diskFreeGiB?.toFixed(1) ?? '未知'} GiB · 部署预留 25 GiB</dd>
              <dt>显卡与驱动</dt>
              <dd>
                {scan.gpus.length
                  ? scan.gpus.map((g) => (
                      <div key={g.index}>
                        GPU {g.index}：{g.name} · {(g.memoryMiB / 1024).toFixed(1)} GiB（空闲{' '}
                        {(g.freeMiB / 1024).toFixed(1)} GiB）· 驱动 {g.driver}
                      </div>
                    ))
                  : '未检测到可查询的 NVIDIA GPU'}
              </dd>
              <dt>运行设备</dt>
              <dd>{scan.device}</dd>
              <dt>已有安装</dt>
              <dd>{scan.installationDetail}</dd>
              <dt>模型下载量</dt>
              <dd>约 {plan.downloadGiB.toFixed(2)} GiB，另需下载 Python / PyTorch 与依赖</dd>
              <dt>目标目录</dt>
              <dd>
                <code>{scan.root}</code>
              </dd>
              <dt>模型提交</dt>
              <dd>
                <code>{plan.revision}</code>
              </dd>
            </dl>
            {scan.blockers.map((text) => (
              <div key={text} className="callout error">
                <div>{text}</div>
              </div>
            ))}
            {scan.warnings.map((text) => (
              <div key={text} className="callout">
                <div>{text}</div>
              </div>
            ))}
            <details>
              <summary>下载来源与安装步骤</summary>
              <ol>
                {plan.steps.map((step) => (
                  <li key={step.id}>{step.title}</li>
                ))}
              </ol>
              <ul>
                {plan.sources.map((source) => (
                  <li key={source}>
                    <code>{source}</code>
                  </li>
                ))}
              </ul>
              <p>
                固定模型提交及 SHA-256；uv 引导程序校验 SHA-256；Python 由 uv 校验并安装；依赖从
                PyPI / PyTorch 官方索引下载，实际版本记录在 requirements-resolved.txt。
              </p>
            </details>
            <label className="check-line">
              <input
                type="checkbox"
                checked={accept}
                disabled={active || !!busy || !!scan.blockers.length}
                onChange={(e) => setAccept(e.target.checked)}
              />
              我已查看硬件和下载提示，确认独立部署；完成后通过 dsh 自行接入
            </label>
            <button
              className="btn primary"
              disabled={!accept || !!scan.blockers.length || active || !!busy}
              onClick={() => void run('tts-deploy', () => api.deployTts(true))}
            >
              开始部署语音模型
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
