import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { readBridgeLogin } from '../src/main/bridge'
import { Engine } from '../src/main/engine'
import { Store } from '../src/main/store'
import { writeJson } from '../src/main/core'

let root: string
let bridge: string
let engine: Engine
let opened: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>
const servers: http.Server[] = []
const token = '0123456789abcdef0123456789abcdef0123456789abcdef'
const manual = 'manually-configured-console-token'
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-bridge-'))
  bridge = path.join(root, 'bridge')
  opened = vi.fn(async (_url: string) => {})
  const store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  engine = new Engine(store, {}, () => {}, opened)
  await engine.init()
  store.settings.bridgePath = bridge
  vi.spyOn(engine, 'scan').mockResolvedValue([])
})
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 100))
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-bridge-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
async function fileToken(value = token) {
  await fs.mkdir(path.join(bridge, 'state'), { recursive: true })
  await fs.writeFile(path.join(bridge, 'state/console-token'), value)
}
describe('bridge console access', () => {
  it('prefers a valid configured token and uses the actual configured console port', async () => {
    await fileToken()
    await writeJson(path.join(bridge, 'config.json'), { consoleToken: manual, consolePort: 45001 })
    expect(await readBridgeLogin(bridge, 3100)).toMatchObject({
      state: 'ready',
      token: manual,
      consoleUrl: 'http://127.0.0.1:45001',
    })
  })
  it('falls back to the generated token for an invalid manual token and reads rotations', async () => {
    await writeJson(path.join(bridge, 'config.json'), {
      consoleToken: 'invalid',
      consolePort: 45001,
    })
    expect((await engine.bridgeLogin()).state).toBe('waiting')
    await fileToken(token + '\r\n')
    expect(await engine.bridgeLogin()).toHaveProperty('token', token)
    await fileToken(manual)
    expect(await engine.bridgeLogin()).toHaveProperty('token', manual)
  })
  it('never exposes malformed tokens or corrupt config contents', async () => {
    await fileToken('invalid token with spaces')
    expect(await engine.bridgeLogin()).not.toHaveProperty('token')
    await fs.writeFile(path.join(bridge, 'config.json'), `{"consoleToken":"${token}`)
    const result = await engine.bridgeLogin()
    expect(result.state).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain(token)
    expect((await readBridgeLogin('', 3100)).state).toBe('waiting')
  })
  it('opens a token-authenticated loopback URL without adding credentials to snapshots or logs', async () => {
    await fileToken()
    await engine.openBridgeConsole()
    const url = new URL(opened.mock.calls[0][0])
    expect(url.origin).toBe('http://127.0.0.1:3100')
    expect(url.searchParams.get('token')).toBe(token)
    expect(JSON.stringify(await engine.snapshot())).not.toContain(token)
    expect(await fs.readFile(path.join(root, 'activity.log'), 'utf8')).not.toContain(token)
    opened.mockRejectedValue(new Error('failed to open ' + url.href))
    await expect(engine.openBridgeConsole()).rejects.toThrow('无法打开 QQ Bridge 控制台')
  })
  it('waits for first-start token generation and automatically logs in after service start', async () => {
    const server = http.createServer((req, res) => {
      expect(req.headers['x-console-token']).toBe(token)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ dshReady: false, mode: 'chat' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    await writeJson(path.join(bridge, 'config.json'), { consolePort: port })
    vi.spyOn(engine, 'startService').mockImplementation(async () => {
      setTimeout(() => {
        void fileToken()
      }, 50)
    })
    await engine.service('bridge', 'start')
    const url = new URL(opened.mock.calls[0][0])
    expect(url.port).toBe(String(port))
    expect(url.searchParams.get('token')).toBe(token)
  })
})
