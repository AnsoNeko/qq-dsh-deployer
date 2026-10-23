import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import {
  cleanVersion,
  compatible,
  localUrl,
  mergeBridgeConfig,
  mergeMcp,
  newer,
  parseQQs,
  readOneBot,
  redact,
  redactDiagnostics,
  safeChild,
  writeJson,
} from '../src/main/core'
import { Store } from '../src/main/store'
import { request, sha256 } from '../src/main/network'
import { runDesktopCli, command } from '../src/main/system'
let root: string
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-unit-'))
})
afterEach(async () => {
  if (
    path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) ||
    !path.basename(root).startsWith('qqdsh-unit-')
  )
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})
describe('versions and boundaries', () => {
  it('orders prereleases without calling every latest release compatible', () => {
    expect(cleanVersion('v24.19.0')).toBe('24.19.0')
    expect(newer('0.2.1-rc.1', '0.2.1-rc.2')).toBe(true)
    expect(newer('unknown', '2.0.0')).toBe(false)
    expect(compatible('0.2.1-rc.2', '0.2.1-r1')).toContain('上游声明')
    expect(compatible('0.3.0', '0.2.1-r1')).toContain('待验证')
  })
  it('rejects remote services, credentials, path traversal and invalid QQs', () => {
    expect(() => localUrl('http://example.com')).toThrow()
    expect(() => localUrl('http://user:secret@localhost:3000')).toThrow()
    expect(() => localUrl('http://127.0.0.1:3000?token=x')).toThrow()
    expect(() => safeChild(root, '../escape')).toThrow()
    expect(() => parseQQs('12345,invalid')).toThrow()
    expect(parseQQs('12345，12345 67890')).toEqual(['12345', '67890'])
    expect(() => request('https://attacker.example/tool.exe')).toThrow()
    expect(() => request('http://github.com/tool.exe')).toThrow()
  })
})
describe('preserving real configuration', () => {
  it('merges MCP by id, preserves unrelated and nested entries, and is idempotent', () => {
    const old = yaml.dump([
      {
        insert: [
          { id: 'user-plugin', name: 'custom', config: { deep: ['a', 'b'] } },
          { id: 'mcp-snowluma', config: { old: true } },
        ],
      },
      { replace: { other: { entries: [] } } },
    ])
    const merged = mergeMcp(old, 'D:\\中文 空格\\bridge', 'C:\\Program Files\\nodejs\\node.exe')
    expect(mergeMcp(merged, 'D:\\中文 空格\\bridge', 'C:\\Program Files\\nodejs\\node.exe')).toBe(
      merged,
    )
    const data: any = yaml.load(merged)
    expect(data[0].insert).toEqual([
      { id: 'user-plugin', name: 'custom', config: { deep: ['a', 'b'] } },
    ])
    expect(data[1].replace.other.entries).toEqual([])
    expect(data[2].insert).toHaveLength(3)
    expect(data[2].insert[0].config.command).toContain('Program Files')
    expect(() => mergeMcp('invalid: [', root, 'node')).toThrow()
    expect(() => mergeMcp('object: true', root, 'node')).toThrow()
  })
  it('preserves roles and unrelated bridge fields, and keeps empty ACL closed', () => {
    const old = {
      custom: { retain: true },
      snowluma: { accessToken: 'existing', custom: 1 },
      socialV2: { role: 'user-role' },
      deny: { groups: ['10000'] },
    }
    const result = mergeBridgeConfig(old, {
      dshUrl: 'http://127.0.0.1:44001',
      httpUrl: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      ownerQQ: '12345',
      groups: '',
      friends: '',
      model: 'deepseek-flash',
      consolePort: 3100,
      snowlumaPath: root,
    })
    expect(result.custom).toEqual(old.custom)
    expect(result.deny).toEqual(old.deny)
    expect(result.socialV2.role).toBe('user-role')
    expect(result.snowluma.accessToken).toBe('existing')
    expect(result.allowAllWhenEmpty).toBe(false)
    expect(result.allow.groups).toEqual([])
    expect(result.dsh.baseUrl).toContain('44001')
    expect(old).not.toHaveProperty('allow')
  })
  it('reads separate HTTP and WS credentials including the new global file', async () => {
    await writeJson(path.join(root, 'config/onebot_12345.json'), {
      networks: {
        httpServers: [{ host: '0.0.0.0', port: 3000, accessToken: 'http-credential' }],
        wsServers: [{ host: '127.0.0.1', port: 3001, accessToken: 'ws-credential' }],
      },
    })
    await writeJson(path.join(root, 'config/onebot.json'), {
      networks: {
        httpServers: [{ host: '127.0.0.1', port: 3010, accessToken: 'global-http' }],
        wsServers: [{ host: '127.0.0.1', port: 3011, accessToken: 'global-ws' }],
      },
    })
    const endpoints = await readOneBot(root)
    expect(endpoints).toHaveLength(2)
    expect(endpoints.find((e) => e.account === '12345')).toMatchObject({
      httpUrl: 'http://127.0.0.1:3000',
      httpToken: 'http-credential',
      wsToken: 'ws-credential',
    })
    expect(endpoints.some((e) => e.httpToken === 'global-http')).toBe(true)
  })
})
describe('secrets and backup restoration', () => {
  const cipher = {
    encrypt: (s: string) => Buffer.from([...Buffer.from(s)].map((b) => b ^ 93)),
    decrypt: (b: Buffer) => Buffer.from([...b].map((c) => c ^ 93)).toString(),
  }
  it('roundtrips encrypted credentials and never writes tokens into settings', async () => {
    const store = new Store(root, cipher)
    await store.init()
    await store.save(store.settings, {
      httpToken: 'PRIVATE_HTTP_TOKEN',
      wsToken: 'PRIVATE_WS_TOKEN',
    })
    expect(await fs.readFile(path.join(root, 'settings.json'), 'utf8')).not.toContain('PRIVATE')
    expect(await fs.readFile(path.join(root, 'secrets.bin'), 'utf8')).not.toContain('PRIVATE')
    const reloaded = new Store(root, cipher)
    await reloaded.init()
    expect(reloaded.secrets).toEqual(store.secrets)
  })
  it('restores exact original config and refuses to overwrite later user edits', async () => {
    const store = new Store(root, cipher)
    await store.init()
    store.settings.dshHome = path.join(root, '独立 DSH')
    const file = path.join(store.settings.dshHome, 'profiles/desktop/cordis.patch.yml')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const old = '# 用户注释\r\n- insert: []\r\n'
    await fs.writeFile(file, old)
    const b = await store.createBackup('test', [file])
    await fs.writeFile(file, '- insert: [{id: new}]')
    await store.finishBackup(b)
    await store.restore(b.id)
    expect(await fs.readFile(file, 'utf8')).toBe(old)
    const c = await store.createBackup('second', [file])
    await fs.writeFile(file, 'managed')
    await store.finishBackup(c)
    await fs.writeFile(file, 'user modified')
    await expect(store.restore(c.id)).rejects.toThrow('已被修改')
    expect(await fs.readFile(file, 'utf8')).toBe('user modified')
  })
  it('redacts structured, URL and bearer credentials', () => {
    const clean = redact(
      'authorization: Bearer secret-value\n{"accessToken":"TOPSECRET", "password": "P@ssword"}\nhttp://localhost?token=QUERYSECRET\napi_key=KEYSECRET',
    )
    for (const secret of ['secret-value', 'TOPSECRET', 'P@ssword', 'QUERYSECRET', 'KEYSECRET'])
      expect(clean).not.toContain(secret)
  })
  it('keeps diagnostic exports valid JSON while hiding embedded credentials', () => {
    const safe = redactDiagnostics(
      {
        logs: [{ message: 'accessToken="PRIVATE"' }],
        nested: { password: 'PASSWORD' },
        detail: 'custom saved credential ABCDEF',
      },
      ['ABCDEF'],
    )
    const serialized = JSON.stringify(safe)
    expect(() => JSON.parse(serialized)).not.toThrow()
    for (const secret of ['PRIVATE', 'PASSWORD', 'ABCDEF']) expect(serialized).not.toContain(secret)
  })
  it('calculates real archive hashes', async () => {
    const p = path.join(root, 'archive')
    await fs.writeFile(p, 'abc')
    expect(await sha256(p)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
describe('Windows process invocation', () => {
  it('preserves spaces, Chinese, ampersands and percent signs in desktop CLI arguments', async () => {
    const dir = path.join(root, '中文 & spaces %wow% !')
    await fs.mkdir(dir)
    const cli = path.join(dir, 'dsh.cmd')
    await fs.writeFile(
      cli,
      '@echo off\r\n"%QQDSH_TEST_NODE%" -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n',
    )
    const output = await runDesktopCli(
      cli,
      [path.join(dir, 'plugin one'), path.join(dir, 'plugin two')],
      { env: { ...process.env, QQDSH_TEST_NODE: process.execPath } },
    )
    expect(output).toContain('desktop')
    expect(output).toContain('link:' + path.join(dir, 'plugin one').replace(/\\/g, '/'))
    expect(output).toContain('%wow%')
  })
  it('cancels an owned long-running process', async () => {
    const controller = new AbortController()
    const operation = command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      signal: controller.signal,
      onSpawn: () => controller.abort(),
    })
    await expect(operation).rejects.toThrow('取消')
  })
})
