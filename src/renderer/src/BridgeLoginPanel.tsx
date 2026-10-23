import { useEffect, useState } from 'react'
import { Copy, ExternalLink, RefreshCw } from 'lucide-react'
import type { BridgeLogin } from '../../shared/types'

export function BridgeLoginPanel({ onCopy, onOpen }: { onCopy(): void; onOpen(): void }) {
  const [login, setLogin] = useState<BridgeLogin | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout>
    const read = async () => {
      try {
        const value = await window.deployer.bridgeLogin()
        if (!disposed) setLogin(value)
      } catch {
        if (!disposed)
          setLogin({ state: 'unavailable', detail: '读取控制台令牌失败，请稍后刷新。' })
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
    <div className="snowluma-login" role="region" aria-label="QQ Bridge 控制台登录">
      <h3>QQ Bridge 控制台登录</h3>
      <p role="status">{login?.detail || '正在读取控制台访问令牌…'}</p>
      {login?.state === 'ready' && (
        <label className="field">
          <span>控制台访问令牌</span>
          <input aria-label="控制台访问令牌" readOnly value={login.token} spellCheck={false} />
        </label>
      )}
      <div className="snowluma-login-actions">
        {login?.state === 'ready' && (
          <>
            <button className="btn primary" onClick={onCopy}>
              <Copy size={14} />
              复制控制台令牌
            </button>
            <button className="btn" onClick={onOpen}>
              <ExternalLink size={14} />
              自动登录 QQ Bridge 控制台
            </button>
          </>
        )}
        <button className="btn ghost" onClick={() => setRefresh((value) => value + 1)}>
          <RefreshCw size={14} />
          刷新令牌
        </button>
      </div>
    </div>
  )
}
