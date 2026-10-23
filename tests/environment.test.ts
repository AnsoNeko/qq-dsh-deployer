import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Engine } from '../src/main/engine'
import { Store } from '../src/main/store'
import { writeJson } from '../src/main/core'
import type { ComponentResult } from '../src/shared/types'

let root: string
let engine: Engine
let configFile: string
const old = {
  ownerQQ: '1234567',
  allow: { groups: ['7654321'], private: ['9876543'] },
  consoleToken: 'preserved-console-token',
  consolePort: 44000,
  dsh: {
    baseUrl: 'http://127.0.0.1:3080',
    authToken: 'preserved-dsh-token',
    model: 'custom-model',
    custom: true,
  },
  snowluma: {
    httpUrl: 'http://127.0.0.1:3000',
    wsUrl: 'ws://127.0.0.1:3001',
    accessToken: 'old-http',
    wsAccessToken: 'old-ws',
    custom: true,
  },
  roles: { custom: true },
  socialV2: { agentPreset: 'qq-chat-v2' },
  custom: { nested: ['retained'] },
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-env-'))
  const store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  engine = new Engine(
    store,
    { powershell: { version: '7.6.8', url: 'https://github.com/PowerShell/PowerShell' } },
    () => {},
    async () => {},
  )
  await engine.init()
  Object.assign(store.settings, {
    bridgePath: path.join(root, 'bridge'),
    snowlumaPath: path.join(root, 'snow'),
    dshHome: path.join(root, '.dsh'),
  })
  configFile = path.join(store.settings.bridgePath, 'config.json')
  await writeJson(configFile, old)
  await writeJson(path.join(store.settings.snowlumaPath, 'config/onebot_5555555.json'), {
    networks: {
      httpServers: [{ host: '127.0.0.1', port: 41700, accessToken: 'new-http' }],
      wsServers: [{ host: '127.0.0.1', port: 41701, accessToken: 'new-ws' }],
    },
  })
  engine.scanner.discovered.dshUrl = 'http://127.0.0.1:45678'
  vi.spyOn(engine.scanner, 'scan').mockResolvedValue([
    { id: 'harness', state: 'ok', path: path.join(root, 'Harness.exe') },
  ] as ComponentResult[])
})
afterEach(async () => {
  vi.restoreAllMocks()
  await new Promise((resolve) => setTimeout(resolve, 100))
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-env-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
describe('detected environment application', () => {
  it('automatically scans and applies verified connections as the last deployment step', async () => {
    vi.spyOn(engine as any, 'perform').mockResolvedValue(undefined)
    await engine.deploy({ actions: ['powershell'], acceptUnverified: false })
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(engine.task?.steps.at(-1)).toMatchObject({ id: 'sync-environment', state: 'done' })
    const next = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(next.dsh.baseUrl).toBe('http://127.0.0.1:45678')
    expect(next.dsh.authToken).toBe(old.dsh.authToken)
    expect(next.dsh.model).toBe(old.dsh.model)
    for (const key of ['ownerQQ', 'allow', 'consoleToken', 'roles', 'socialV2', 'custom'])
      expect(next[key]).toEqual((old as any)[key])
    expect(next.snowluma).toMatchObject({
      httpUrl: 'http://127.0.0.1:41700',
      wsUrl: 'ws://127.0.0.1:41701',
      accessToken: 'new-http',
      wsAccessToken: 'new-ws',
      custom: true,
    })
    expect(engine.store.settings.dshUrl).toBe(next.dsh.baseUrl)
    expect(engine.store.settings.httpUrl).toBe(next.snowluma.httpUrl)
    expect(engine.store.settings.consolePort).toBe(44000)
    expect(engine.store.settings.ownerQQ).toBe(old.ownerQQ)
    expect(engine.store.settings.model).toBe(old.dsh.model)
    expect(engine.store.secrets).toEqual({ httpToken: 'new-http', wsToken: 'new-ws' })
    expect(
      (await engine.store.backups()).some((item) => item.label === '自动应用实际连接配置'),
    ).toBe(true)
    const publicData = JSON.stringify(await engine.snapshot())
    for (const secret of ['new-http', 'new-ws', old.consoleToken])
      expect(publicData).not.toContain(secret)
  })
  it('never replaces the Harness address using an unverified listener', async () => {
    vi.mocked(engine.scanner.scan).mockResolvedValue([
      { id: 'harness', state: 'waiting' },
    ] as ComponentResult[])
    await engine.syncEnvironment()
    expect(engine.store.settings.dshUrl).toBe(old.dsh.baseUrl)
    expect(JSON.parse(await fs.readFile(configFile, 'utf8')).dsh.baseUrl).toBe(old.dsh.baseUrl)
  })
  it('restarts Harness after plugin installation and waits for verified API before finishing', async () => {
    engine.catalog.bridge = { version: 'fixture', url: 'https://github.com/Derpyu520/qq-bridge' }
    vi.spyOn(engine as any, 'perform').mockResolvedValue(undefined)
    const start = vi.spyOn(engine, 'startService').mockResolvedValue(undefined)
    vi.mocked(engine.scanner.scan).mockImplementation(async () => {
      const results = [{ id: 'harness', state: 'waiting' }] as ComponentResult[]
      engine.scanner.results = results
      return results
    })
    await engine.deploy({ actions: ['plugins'], acceptUnverified: false })
    await vi.waitFor(() => expect(engine.task?.state).toBe('waiting'))
    expect(start).toHaveBeenCalledWith('harness')
    expect(engine.task?.steps.at(-1)).toMatchObject({ id: 'sync-environment', state: 'waiting' })
    vi.mocked(engine.scanner.scan).mockImplementation(async () => {
      const results = [{ id: 'harness', state: 'ok' }] as ComponentResult[]
      engine.scanner.results = results
      return results
    })
    engine.resume()
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(engine.store.settings.dshUrl).toBe('http://127.0.0.1:45678')
  })
  it('does not guess between multiple accounts or use the administrator QQ as the bot account', async () => {
    await writeJson(path.join(engine.store.settings.snowlumaPath, 'config/onebot_1234567.json'), {
      networks: { httpServers: [{ port: 41800 }], wsServers: [{ port: 41801 }] },
    })
    engine.store.settings.ownerQQ = '1234567'
    await engine.syncEnvironment()
    const next = JSON.parse(await fs.readFile(configFile, 'utf8'))
    expect(next.snowluma).toEqual(old.snowluma)
    expect(engine.logs.some((item) => item.message.includes('无法唯一匹配'))).toBe(true)
    expect(engine.store.secrets).toEqual({})
  })
  it('restores the original bridge bytes if encrypted settings cannot be saved', async () => {
    const bytes = await fs.readFile(configFile, 'utf8')
    vi.spyOn(engine.store, 'save').mockRejectedValue(
      new Error('OS credential encryption unavailable'),
    )
    await expect(engine.syncEnvironment()).rejects.toThrow('encryption unavailable')
    expect(await fs.readFile(configFile, 'utf8')).toBe(bytes)
    expect(engine.store.settings.dshUrl).toBe(old.dsh.baseUrl)
  })
  it('restarts an assistant-owned bridge after updating its connection settings', async () => {
    engine.owned.bridge = { pid: 123, exitCode: null } as any
    const stop = vi.spyOn(engine, 'stopOwned').mockImplementation(async () => {
      delete engine.owned.bridge
    })
    const start = vi.spyOn(engine, 'startService').mockResolvedValue(undefined)
    await engine.syncEnvironment()
    expect(stop).toHaveBeenCalledWith('bridge')
    expect(start).toHaveBeenCalledWith('bridge')
  })
  it('shares in-flight scan results instead of returning stale results', async () => {
    let finish!: (result: ComponentResult[]) => void
    vi.mocked(engine.scanner.scan).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const first = engine.scan()
    const second = engine.scan()
    const results = [{ id: 'harness', state: 'ok' }] as ComponentResult[]
    finish(results)
    expect(await first).toEqual(results)
    expect(await second).toEqual(results)
    expect(engine.scanner.scan).toHaveBeenCalledOnce()
  })
  it('cancels the final scan without applying partially detected config', async () => {
    vi.spyOn(engine as any, 'perform').mockResolvedValue(undefined)
    let finish!: (result: ComponentResult[]) => void
    vi.mocked(engine.scanner.scan).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    await engine.deploy({ actions: ['powershell'], acceptUnverified: false })
    await vi.waitFor(() => expect(engine.task?.steps.at(-1)?.state).toBe('running'))
    engine.cancel()
    finish([{ id: 'harness', state: 'ok' }] as ComponentResult[])
    await vi.waitFor(() => expect(engine.task?.state).toBe('cancelled'))
    expect(JSON.parse(await fs.readFile(configFile, 'utf8'))).toEqual(old)
  })
})
