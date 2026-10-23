import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Engine } from '../src/main/engine'
import { Store } from '../src/main/store'
import { writeJson } from '../src/main/core'
let root: string
let engine: Engine
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-task-'))
  const store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
  engine = new Engine(
    store,
    {
      powershell: { version: '7.6.8', url: 'https://github.com/PowerShell/PowerShell' },
      bridge: { version: '0.2.1-r1' },
    },
    () => {},
    async () => {},
  )
  await engine.init()
  store.settings.dshHome = path.join(root, '.dsh')
  vi.spyOn(engine, 'scan').mockResolvedValue([])
})
afterEach(async () => {
  engine.cancel()
  vi.restoreAllMocks()
  await new Promise((r) => setTimeout(r, 100))
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-task-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { force: true, recursive: true })
})
describe('deployment task lifecycle', () => {
  it('waits for the user, resumes and persists completion', async () => {
    vi.spyOn(engine as any, 'perform').mockImplementation(async (_id, signal) =>
      engine.wait('等待测试用户', signal as AbortSignal),
    )
    await engine.deploy({ actions: ['powershell'], acceptUnverified: false })
    await vi.waitFor(() => expect(engine.task?.state).toBe('waiting'))
    engine.resume()
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(JSON.parse(await fs.readFile(path.join(root, 'task.json'), 'utf8')).state).toBe('done')
  })
  it('cancels a waiting step without continuing installation', async () => {
    vi.spyOn(engine as any, 'perform').mockImplementation(async (_id, signal) =>
      engine.wait('等待用户', signal as AbortSignal),
    )
    await engine.deploy({ actions: ['powershell'], acceptUnverified: false })
    await vi.waitFor(() => expect(engine.task?.state).toBe('waiting'))
    engine.cancel()
    await vi.waitFor(() => expect(engine.task?.state).toBe('cancelled'))
    expect(engine.task?.steps[0].state).toBe('cancelled')
  })
  it('retries a failed step and rejects overlapping deployments', async () => {
    const perform = vi
      .spyOn(engine as any, 'perform')
      .mockRejectedValueOnce(new Error('network failed'))
      .mockResolvedValue(undefined)
    await engine.deploy({ actions: ['powershell'], acceptUnverified: false })
    await expect(
      engine.deploy({ actions: ['powershell'], acceptUnverified: false }),
    ).rejects.toThrow('已有任务')
    await vi.waitFor(() => expect(engine.task?.state).toBe('failed'))
    await engine.retry()
    await vi.waitFor(() => expect(engine.task?.state).toBe('done'))
    expect(perform).toHaveBeenCalledTimes(2)
  })
  it('saves deployment preferences without overwriting an existing bridge ACL', async () => {
    engine.store.settings.bridgePath = path.join(root, 'existing bridge')
    await writeJson(path.join(engine.store.settings.bridgePath, 'package.json'), {
      version: '0.2.1-r1',
    })
    const file = path.join(engine.store.settings.bridgePath, 'config.json')
    const old = { allow: { groups: ['1234567'] }, ownerQQ: '7654321', custom: true }
    await writeJson(file, old)
    await engine.saveConfig({
      settings: { ...engine.store.settings, registerPwshPath: false },
      applyBridge: false,
    })
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(old)
  })
})
