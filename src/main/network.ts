import https from 'node:https'
import http from 'node:http'
import fs from 'node:fs/promises'
import { createWriteStream, createReadStream } from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { HttpsProxyAgent } from 'https-proxy-agent'
import { localUrl } from './core'
import WebSocket from 'ws'

const allowed = [
  'github.com',
  'codeload.github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'nodejs.org',
  'registry.npmjs.org',
  'download.deepseek.com',
  'www.deepseek.com',
]
export function request(
  url: string,
  proxy = '',
  signal?: AbortSignal,
  redirects = 0,
): Promise<http.IncomingMessage> {
  const u = new URL(url)
  if (u.protocol !== 'https:' || u.username || u.password || !allowed.includes(u.hostname))
    throw new Error('下载来源不在官方允许清单中')
  if (redirects > 8) throw new Error('下载重定向过多')
  return new Promise((resolve, reject) => {
    const req = https.get(
      u,
      {
        agent: proxy ? new HttpsProxyAgent(proxy) : undefined,
        signal,
        headers: { 'User-Agent': 'QQDshDeployer/0.1', Accept: 'application/vnd.github+json' },
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode || 0) && res.headers.location) {
          res.resume()
          Promise.resolve()
            .then(() =>
              request(new URL(res.headers.location!, u).href, proxy, signal, redirects + 1),
            )
            .then(resolve, reject)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`官方来源 HTTP ${res.statusCode}`))
          return
        }
        res.setTimeout(60000, () => res.destroy(new Error('下载连接长时间无数据')))
        resolve(res)
      },
    )
    req.setTimeout(20000, () => req.destroy(new Error('连接超时')))
    req.on('error', reject)
  })
}
export async function remoteJson(url: string, proxy = ''): Promise<any> {
  const response = await request(url, proxy, AbortSignal.timeout(20000))
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response) {
    bytes += chunk.length
    if (bytes > 5000000) {
      response.destroy()
      throw new Error('更新响应过大')
    }
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString())
}
export async function sha256(file: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}
export async function download(
  url: string,
  dest: string,
  hash: string,
  proxy: string,
  signal: AbortSignal,
  progress: (n: number) => void,
): Promise<void> {
  if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('发行清单未锁定校验值，禁止执行下载内容')
  await fs.mkdir(path.dirname(dest), { recursive: true })
  if (await fs.stat(dest).catch(() => null)) {
    if ((await sha256(dest)) === hash) {
      progress(100)
      return
    }
    await fs.rm(dest)
  }
  const part = dest + '.part'
  try {
    const response = await request(url, proxy, signal)
    const size = Number(response.headers['content-length'])
    let bytes = 0
    let last = 0
    response.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (Date.now() - last > 300) {
        progress(size ? Math.min(99, Math.floor((bytes / size) * 100)) : 0)
        last = Date.now()
      }
    })
    await pipeline(response, createWriteStream(part), { signal })
    if ((await sha256(part)) !== hash) throw new Error('SHA-256 校验失败，文件未执行')
    await fs.rename(part, dest)
    progress(100)
  } finally {
    await fs.rm(part, { force: true }).catch(() => {})
  }
}
export async function localRpc(
  base: string,
  endpoint: string,
  token = '',
  timeout = 2500,
  cookie = '',
  body: unknown = {},
): Promise<any> {
  const url = new URL(localUrl(base) + '/' + endpoint)
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(cookie ? { cookie } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let n = 0
        res.on('data', (b: Buffer) => {
          n += b.length
          if (n > 2000000) {
            res.destroy(new Error('本地服务响应过大'))
            return
          }
          chunks.push(b)
        })
        res.on('error', reject)
        res.on('end', () => {
          if (res.statusCode === 401 || res.statusCode === 403) {
            reject(new Error('鉴权失败（401/403），请核对令牌或 Harness 登录状态'))
            return
          }
          if (res.statusCode === 426) {
            reject(new Error('HTTP 地址指向了 WebSocket 端口（426）'))
            return
          }
          if (!res.statusCode || res.statusCode >= 400) {
            reject(new Error(`本地服务 HTTP ${res.statusCode}`))
            return
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()))
          } catch {
            reject(new Error('响应不是有效 JSON，可能连接到了其他服务'))
          }
        })
      },
    )
    req.setTimeout(timeout, () => req.destroy(new Error('本地服务连接超时')))
    req.on('error', reject)
    req.end(JSON.stringify(body))
  })
}
export async function probeOneBot(
  base: string,
  token: string,
): Promise<{ state: 'ok' | 'waiting' | 'error'; detail: string; account?: string }> {
  try {
    const login = await localRpc(base, 'get_login_info', token)
    if (login.status !== 'ok' || login.retcode !== 0 || !login.data?.user_id)
      throw new Error('OneBot 未返回有效登录账号')
    const status = await localRpc(base, 'get_status', token)
    if (status.status !== 'ok' || status.retcode !== 0) throw new Error('OneBot 状态查询失败')
    if (status.data?.online === false)
      return {
        state: 'waiting',
        detail: '网关可连接，QQ 尚未登录或已离线',
        account: String(login.data.user_id),
      }
    if (status.data?.good === false)
      return {
        state: 'error',
        detail: '网关已连接，但 QQ 接收链路退化（good=false）',
        account: String(login.data.user_id),
      }
    return {
      state: 'ok',
      detail: `QQ ${login.data.user_id} 已登录 · ${status.data?.good === true ? '上游健康' : '上游健康状态未知'} · 消息往返待实测`,
      account: String(login.data.user_id),
    }
  } catch (e: any) {
    return { state: 'error', detail: e.message }
  }
}
export function probeWs(url: string, token: string): Promise<void> {
  localUrl(url, ['ws:', 'wss:'])
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      handshakeTimeout: 3000,
    })
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new Error('WebSocket 连接超时'))
    }, 3500)
    ws.once('open', () => {
      clearTimeout(timer)
      ws.close()
      resolve()
    })
    ws.once('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
