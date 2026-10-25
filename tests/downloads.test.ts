import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { download } from '../src/main/network'
import { downloadComponent, type ComponentSource } from '../src/main/sources'
import { powershell } from '../src/main/system'

vi.mock('../src/main/system', () => ({ powershell: vi.fn() }))

const digest = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
const harness: ComponentSource = {
  version: '0.2.1-rc.2',
  url: 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe',
  sha256: digest('old installer'),
  publisher: 'CN=Official Publisher',
  signerThumbprint: 'OLD-CERT',
}
const powershellSource: ComponentSource = {
  version: '7.6.8',
  url: 'https://github.com/PowerShell/PowerShell/releases/download/v7.6.8/PowerShell-7.6.8-win-x64.zip',
  sha256: digest('old archive'),
}
let root: string
let dest: string
let controller: AbortController
let responses: Map<string, string | Error>
let requested: string[]

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-download-'))
  dest = path.join(root, 'payload')
  controller = new AbortController()
  responses = new Map()
  requested = []
  vi.mocked(powershell)
    .mockReset()
    .mockResolvedValue(
      JSON.stringify({
        status: 'Valid',
        publisher: harness.publisher,
        thumbprint: 'NEW-CERT',
        version: '0.2.2',
      }),
    )
  vi.spyOn(https, 'get').mockImplementation(((
    url: URL,
    _options: unknown,
    receive: (res: unknown) => void,
  ) => {
    requested.push(url.href)
    const req = new EventEmitter() as any
    req.setTimeout = () => req
    queueMicrotask(() => {
      const body = responses.get(url.href)
      if (body === undefined || body instanceof Error) {
        req.emit('error', body || new Error('Unexpected URL: ' + url.href))
        return
      }
      const res = Readable.from([Buffer.from(body)]) as any
      res.statusCode = 200
      res.headers = { 'content-length': Buffer.byteLength(body) }
      res.setTimeout = () => res
      receive(res)
    })
    return req
  }) as typeof https.get)
})

afterEach(async () => {
  vi.restoreAllMocks()
  if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('qqdsh-download-'))
    throw new Error('Unsafe cleanup')
  await fs.rm(root, { recursive: true, force: true })
})

const run = (id: string, source: ComponentSource, progress = vi.fn(), log = vi.fn()) =>
  downloadComponent(id, source, dest, '', controller.signal, progress, log)

async function expectNoPayload() {
  expect(await fs.stat(dest).catch(() => null)).toBeNull()
  expect(await fs.stat(dest + '.part').catch(() => null)).toBeNull()
}

describe('download integrity and cache', () => {
  it('keeps strict verification for callers without a component policy', async () => {
    responses.set(harness.url, 'new installer')
    await expect(
      download(harness.url, dest, harness.sha256, '', controller.signal, vi.fn()),
    ).rejects.toThrow('SHA-256')
    await expectNoPayload()
  })

  it('reuses a matching fixed-version cache without querying metadata', async () => {
    await fs.writeFile(dest, 'old archive')
    const source = { ...powershellSource, sha256: powershellSource.sha256.toUpperCase() }
    expect((await run('powershell', source)).sha256).toBe(powershellSource.sha256)
    expect(requested).toEqual([])
  })

  it('discards stale fixed-version cache and downloads a valid replacement', async () => {
    await fs.writeFile(dest, 'damaged cache')
    responses.set(powershellSource.url, 'old archive')
    await run('powershell', powershellSource)
    expect(await fs.readFile(dest, 'utf8')).toBe('old archive')
    expect(requested).toEqual([powershellSource.url])
  })

  it('does not promote a changed payload after cancellation during verification', async () => {
    responses.set(harness.url, 'new installer')
    vi.mocked(powershell).mockImplementation(async () => {
      controller.abort()
      return JSON.stringify({ status: 'Valid', publisher: harness.publisher, version: '0.2.2' })
    })
    await expect(run('harness', harness)).rejects.toThrow()
    await expectNoPayload()
  })
})

describe('mutable official Harness installer', () => {
  it('accepts an official update and certificate renewal, records the actual version and hash', async () => {
    responses.set(harness.url, 'new installer')
    const log = vi.fn()
    const result = await run('harness', harness, vi.fn(), log)
    expect(result).toMatchObject({ version: '0.2.2', sha256: digest('new installer') })
    expect(harness.version).toBe('0.2.1-rc.2')
    expect(await fs.readFile(dest, 'utf8')).toBe('new installer')
    expect(log).toHaveBeenCalledWith(expect.stringContaining('已通过官方更新验证'))
  })

  it('refreshes the latest URL even when the old installer is cached', async () => {
    await fs.writeFile(dest, 'old installer')
    responses.set(harness.url, 'new installer')
    expect((await run('harness', harness)).version).toBe('0.2.2')
    expect(requested).toEqual([harness.url])
  })

  it.each([
    {
      status: 'HashMismatch',
      publisher: harness.publisher,
      thumbprint: 'OLD-CERT',
      version: '0.2.2',
    },
    { status: 'NotSigned', publisher: harness.publisher, version: '0.2.2' },
    { status: 'Valid', publisher: 'CN=Other Publisher', thumbprint: 'OTHER', version: '0.2.2' },
    { status: 'Valid', publisher: harness.publisher, version: '0.1.0' },
    { status: 'Valid', publisher: harness.publisher, version: '' },
  ])('rejects untrusted or unsuitable installer metadata: %j', async (signature) => {
    responses.set(harness.url, 'new installer')
    vi.mocked(powershell).mockResolvedValue(JSON.stringify(signature))
    await expect(run('harness', harness)).rejects.toThrow('文件未执行')
    await expectNoPayload()
  })

  it('still validates Authenticode when the built-in hash matches', async () => {
    responses.set(harness.url, 'old installer')
    vi.mocked(powershell).mockResolvedValue(JSON.stringify({ status: 'NotSigned' }))
    await expect(run('harness', harness)).rejects.toThrow('签名验证失败')
  })
})

describe('official updated checksums', () => {
  const metadataUrl = 'https://api.github.com/repos/PowerShell/PowerShell/releases/tags/v7.6.8'
  const release = (
    digestValue: string | null = 'sha256:' + digest('new archive'),
    url = powershellSource.url,
  ) =>
    JSON.stringify({
      tag_name: 'v7.6.8',
      draft: false,
      assets: [{ state: 'uploaded', browser_download_url: url, digest: digestValue }],
    })

  it('verifies a replaced GitHub release asset against its exact official release digest', async () => {
    responses.set(powershellSource.url, 'new archive')
    responses.set(metadataUrl, release())
    expect((await run('powershell', powershellSource)).sha256).toBe(digest('new archive'))
    expect(requested).toEqual([powershellSource.url, metadataUrl])
  })

  it.each([
    ['wrong digest', release('sha256:' + digest('different file'))],
    ['missing digest', release(null)],
    ['wrong asset', release(undefined, powershellSource.url + '.other')],
    ['unavailable metadata', new Error('HTTP 403')],
  ])('rejects %s and removes partial downloads', async (_name, metadata) => {
    responses.set(powershellSource.url, 'new archive')
    responses.set(metadataUrl, metadata)
    const progress = vi.fn()
    await expect(run('powershell', powershellSource, progress)).rejects.toThrow('文件未执行')
    expect(progress).not.toHaveBeenCalledWith(100)
    await expectNoPayload()
  })

  it('uses the matching Node.js version and filename in SHASUMS256.txt', async () => {
    const source = {
      version: '24.22.1',
      url: 'https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip',
      sha256: digest('old node'),
    }
    responses.set(source.url, 'new node')
    responses.set(
      'https://nodejs.org/dist/v24.22.1/SHASUMS256.txt',
      `${digest('other')}  node-v24.22.1-linux-x64.tar.xz\r\n${digest('new node')}  node-v24.22.1-win-x64.zip\r\n`,
    )
    expect((await run('node', source)).sha256).toBe(digest('new node'))
  })

  it('keeps immutable bridge commit archives pinned', async () => {
    const source = {
      version: '0.2.1-r1',
      url: 'https://codeload.github.com/Derpyu520/qq-bridge/zip/abc123',
      sha256: digest('old bridge'),
    }
    responses.set(source.url, 'changed bridge')
    await expect(run('bridge', source)).rejects.toThrow('未取得对应文件的官方 SHA-256')
    await expectNoPayload()
    expect(requested).toEqual([source.url])
  })
})
