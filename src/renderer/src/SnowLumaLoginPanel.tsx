import { useEffect, useRef, useState } from 'react'
import { Copy, ExternalLink, RefreshCw } from 'lucide-react'
import type { SnowLumaLogin } from '../../shared/types'

export function SnowLumaLoginPanel({
  onOpen,
  onCopy,
  reveal = false,
}: {
  onOpen(): void
  onCopy(): void
  reveal?: boolean
}) {
  const panel = useRef<HTMLDivElement>(null)
  const [login, setLogin] = useState<SnowLumaLogin | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    if (reveal) panel.current?.scrollIntoView({ block: 'nearest' })
  }, [reveal, login?.state])
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = await window.deployer.snowlumaLogin()
        if (!disposed) setLogin(value)
      } catch {
        if (!disposed) setLogin({ state: 'unavailable', detail: '读取后台凭据失败，请稍后刷新。' })
      } finally {
        if (!disposed) timer = setTimeout(read, 2000)
      }
    }
    void read()
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [refresh])
  return (
    <div ref={panel} className="snowluma-login" role="region" aria-label="SnowLuma 后台登录">
      <h3>SnowLuma 后台登录</h3>
      <p role="status">{login?.detail || '正在读取后台初始密码…'}</p>
      {login?.state === 'ready' && (
        <>
          <p>登录账号：{login.username}</p>
          <label className="field">
            <span>后台初始密码</span>
            <input aria-label="后台初始密码" readOnly value={login.password} spellCheck={false} />
          </label>
        </>
      )}
      <div className="snowluma-login-actions">
        {login?.state === 'ready' && (
          <button className="btn primary" onClick={onCopy}>
            <Copy size={14} />
            复制初始密码
          </button>
        )}
        <button className="btn" onClick={onOpen}>
          <ExternalLink size={14} />
          打开 SnowLuma 后台
        </button>
        <button className="btn ghost" onClick={() => setRefresh((v) => v + 1)}>
          <RefreshCw size={14} />
          刷新密码
        </button>
      </div>
    </div>
  )
}
