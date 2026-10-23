import { afterEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'
import { WebSocketServer } from 'ws'
import { probeBridge, probeOneBot, probeWs } from '../src/main/network'
import { loadBridgeApi } from '../src/main/scanner'
const servers: http.Server[] = []
const roots: string[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections()
    await new Promise<void>((r) => s.close(() => r()))
  }
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-health-'))
      throw new Error('Unsafe cleanup')
    await fs.rm(root, { force: true, recursive: true })
  }
})
async function server(handler: http.RequestListener) {
  const s = http.createServer(handler)
  servers.push(s)
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return { server: s, url: `http://127.0.0.1:${(s.address() as any).port}` }
}
describe('actual loopback protocol probes', () => {
  it.each([
    {
      dshReady: false,
      connected: true,
      degraded: false,
      state: 'waiting',
      detail: '未连接 Harness',
    },
    {
      dshReady: true,
      connected: false,
      degraded: false,
      state: 'waiting',
      detail: '等待 SnowLuma',
    },
    { dshReady: true, connected: true, degraded: true, state: 'error', detail: '上游退化' },
    { dshReady: true, connected: true, degraded: false, state: 'ok', detail: '已连接' },
  ])(
    'authenticates bridge status and reports $state',
    async ({ dshReady, connected, degraded, state, detail }) => {
      const { url } = await server((req, res) => {
        expect(req.url).toBe('/api/status')
        expect(req.headers['x-console-token']).toBe('bridge-console-secret')
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ mode: 'chat', dshReady, snowluma: { connected, degraded } }))
      })
      const result = await probeBridge(url, 'bridge-console-secret')
      expect(result.state).toBe(state)
      expect(result.detail).toContain(detail)
    },
  )
  it('reports bridge authentication failure and rejects another service on the console port', async () => {
    const auth = await server((_req, res) => {
      res.statusCode = 401
      res.end('{}')
    })
    expect((await probeBridge(auth.url, 'wrong')).detail).toContain('令牌鉴权失败')
    const other = await server((_req, res) => res.end(JSON.stringify({ mode: 'unrelated' })))
    expect((await probeBridge(other.url, '')).state).toBe('error')
  })
  it.each([
    { online: true, good: true, state: 'ok' },
    { online: false, good: true, state: 'waiting' },
    { online: true, good: false, state: 'error' },
  ])('distinguishes health $state', async ({ online, good, state }) => {
    const { url } = await server((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          status: 'ok',
          retcode: 0,
          data: req.url === '/get_login_info' ? { user_id: 1234567 } : { online, good },
        }),
      )
    })
    expect((await probeOneBot(url, '')).state).toBe(state)
  })
  it('detects 401 and mistaken WS ports', async () => {
    const auth = await server((_req, res) => {
      res.statusCode = 401
      res.end('{}')
    })
    expect((await probeOneBot(auth.url, 'wrong')).detail).toContain('鉴权失败')
    const wsPort = await server((_req, res) => {
      res.statusCode = 426
      res.end('{}')
    })
    expect((await probeOneBot(wsPort.url, '')).detail).toContain('WebSocket')
  })
  it('separately validates the WebSocket handshake', async () => {
    const { server: s, url } = await server((_req, res) => res.end('{}'))
    const ws = new WebSocketServer({
      server: s,
      verifyClient: (info: { req: http.IncomingMessage }) =>
        info.req.headers.authorization === 'Bearer ws-only',
    })
    await expect(probeWs(url.replace('http:', 'ws:'), 'ws-only')).resolves.toBeUndefined()
    await expect(probeWs(url.replace('http:', 'ws:'), 'http-only')).rejects.toThrow()
    await new Promise<void>((r) => ws.close(() => r()))
  })
  it('discovers changed Harness ports and validates signed RPC identity', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-health-'))
    roots.push(home)
    const secret = crypto.randomBytes(32)
    await fs.writeFile(
      path.join(home, '.credentials.yaml'),
      yaml.dump({
        records: {
          'client-connection/browser-session': {
            kind: 'grant',
            payload: { version: 1, secret: secret.toString('base64url') },
          },
        },
      }),
    )
    const { url } = await server((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        const request = JSON.parse(raw)
        const cookie = req.headers.cookie || ''
        const token = cookie.slice(cookie.indexOf('=') + 1).split('.')
        const payload = JSON.parse(Buffer.from(token[1], 'base64url').toString())
        const valid =
          token[2] === crypto.createHmac('sha256', secret).update(token[1]).digest('base64url') &&
          payload.authority === req.headers.host &&
          req.url === '/api/agentPresets/list' &&
          request.type === 'client-request' &&
          request.method === 'agentPresets/list' &&
          request.payload?.args &&
          typeof request.payload.args === 'object' &&
          Object.keys(request.payload.args).length === 0
        res.statusCode = valid ? 200 : 401
        res.end(
          JSON.stringify({
            type: 'server-response',
            rpcId: request.rpcId,
            result: { ok: !!valid, value: { presets: [{ id: 'qq-chat' }, { id: 'qq-chat-v2' }] } },
          }),
        )
      })
    })
    const api = await loadBridgeApi('', home, url)
    expect(await api.agentPresets.list()).toEqual({
      presets: [{ id: 'qq-chat' }, { id: 'qq-chat-v2' }],
    })
  })
})
