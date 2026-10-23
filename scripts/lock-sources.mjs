import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
const root = path.resolve(import.meta.dirname, '..')
const catalogPath = path.join(root, 'resources/catalog.json')
const catalog = JSON.parse(await fs.readFile(catalogPath, 'utf8'))
await fs.mkdir(path.join(root, '.cache'), { recursive: true })
for (const [id, filename] of [
  ['bridge', 'bridge.zip'],
  ['harness', 'harness.exe'],
]) {
  const file = path.join(root, '.cache', filename)
  if (!(await fs.stat(file).catch(() => null))) {
    console.log(`Downloading official ${id}…`)
    const response = await fetch(catalog[id].url, { signal: AbortSignal.timeout(600000) })
    if (!response.ok || !response.body) throw new Error(`${id}: HTTP ${response.status}`)
    const temp = file + '.part'
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temp))
    await fs.rename(temp, file)
  }
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  catalog[id].sha256 = hash.digest('hex')
  if (id === 'harness') {
    const metadata = JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$ErrorActionPreference="Stop"; $f=Get-Item -LiteralPath $env:QQDSH_LOCK_FILE; $s=Get-AuthenticodeSignature -LiteralPath $env:QQDSH_LOCK_FILE; @{version=$f.VersionInfo.ProductVersion; signature=[string]$s.Status; publisher=$s.SignerCertificate.Subject; thumbprint=$s.SignerCertificate.Thumbprint} | ConvertTo-Json -Compress',
        ],
        {
          env: {
            ...process.env,
            PSModulePath: path.join(
              process.env.SystemRoot,
              'System32/WindowsPowerShell/v1.0/Modules',
            ),
            QQDSH_LOCK_FILE: file,
          },
          encoding: 'utf8',
        },
      ),
    )
    if (metadata.signature !== 'Valid')
      throw new Error(`Official installer signature is ${metadata.signature}; refusing to lock`)
    catalog[id].version = metadata.version
    catalog[id].publisher = metadata.publisher
    catalog[id].signerThumbprint = metadata.thumbprint
  }
  console.log(`${id} locked: ${catalog[id].version} ${catalog[id].sha256}`)
}
await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + '\n')
