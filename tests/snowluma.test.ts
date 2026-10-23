import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { scryptSync } from 'node:crypto'
import { readSnowLumaLogin } from '../src/main/snowluma'
import { writeJson } from '../src/main/core'
import { Engine } from '../src/main/engine'
import { Store } from '../src/main/store'

let root: string
let home: string
let logFile: string
const password = '0123456789abcdef'
const nextPassword = 'fedcba9876543210'
async function credentials(value = password, mustChangePassword = true) {
  const salt = Buffer.alloc(16, 7)
  await writeJson(path.join(home, 'config', 'webui.json'), {
    passwordSalt: salt.toString('hex'),
    passwordHash: scryptSync(value, salt, 64).toString('hex'),
    mustChangePassword,
  })
}
const line = (value: string) =>
  `\x1b[32m[INFO] [WebUI] initial credentials: user=admin password=${value}\x1b[0m\r\n`

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-snowluma-'))
  home = path.join(root, 'snowluma')
  logFile = path.join(root, 'snowluma-local.log')
})
afterEach(async () => {
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-snowluma-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})

describe('SnowLuma initial WebUI credentials', () => {
  it('reads the real 2.1.1 terminal format, including ANSI colours and CRLF', async () => {
    await credentials()
    await fs.writeFile(logFile, 'QQ message password=unrelated\n' + line(password))
    expect(await readSnowLumaLogin(home, logFile)).toMatchObject({
      state: 'ready',
      username: 'admin',
      password,
    })
  })
  it('waits for delayed startup output and then returns the generated password', async () => {
    expect((await readSnowLumaLogin(home, logFile)).state).toBe('waiting')
    await credentials()
    await fs.writeFile(logFile, 'starting...\n')
    expect((await readSnowLumaLogin(home, logFile)).state).toBe('waiting')
    await fs.appendFile(logFile, line(password).slice(0, -12))
    expect((await readSnowLumaLogin(home, logFile)).state).toBe('waiting')
    await fs.appendFile(logFile, line(password).slice(-12))
    expect(await readSnowLumaLogin(home, logFile)).toHaveProperty('password', password)
  })
  it('uses the latest password after a restart and rejects a stale or different installation', async () => {
    await credentials(nextPassword)
    await fs.writeFile(logFile, line(password))
    expect(await readSnowLumaLogin(home, logFile)).not.toHaveProperty('password')
    await fs.appendFile(logFile, line(nextPassword))
    expect(await readSnowLumaLogin(home, logFile)).toHaveProperty('password', nextPassword)
  })
  it('stops exposing the initial password after the user changes it', async () => {
    await credentials(password, false)
    await fs.writeFile(logFile, line(password))
    const result = await readSnowLumaLogin(home, logFile)
    expect(result.state).toBe('changed')
    expect(result).not.toHaveProperty('password')
  })
  it('handles missing and corrupt config without leaking file contents', async () => {
    expect((await readSnowLumaLogin('', logFile)).state).toBe('unavailable')
    await credentials()
    await fs.writeFile(path.join(home, 'config', 'webui.json'), `{"password":"${password}"`)
    const result = await readSnowLumaLogin(home, logFile)
    expect(result.state).toBe('unavailable')
    expect(JSON.stringify(result)).not.toContain(password)
  })
  it('limits reads of large local logs and still finds recent credentials', async () => {
    await credentials()
    await fs.writeFile(logFile, 'x'.repeat(300 * 1024) + '\n' + line(password))
    expect(await readSnowLumaLogin(home, logFile)).toHaveProperty('password', password)
  })
  it('recovers credentials after reopening the assistant without adding them to snapshots or logs', async () => {
    await credentials()
    await fs.writeFile(logFile, line(password))
    const store = new Store(root, { encrypt: (s) => Buffer.from(s), decrypt: (b) => b.toString() })
    await store.init()
    await store.save({ ...store.settings, snowlumaPath: home })
    const engine = new Engine(
      store,
      {},
      () => {},
      async () => {},
    )
    expect(await engine.snowlumaLogin()).toHaveProperty('password', password)
    expect(JSON.stringify(await engine.snapshot())).not.toContain(password)
    expect(engine.logs).toEqual([])
    expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).not.toContain(password)
  })
})
