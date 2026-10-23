import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import yaml from 'js-yaml'
const root = path.resolve(import.meta.dirname, '..')
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const version = pkg.version
const filenames = [
  `QQDshDeployer-${version}-x64-Setup.exe`,
  `QQDshDeployer-${version}-x64-Portable.exe`,
  `QQDshDeployer-${version}-x64-Setup.exe.blockmap`,
  'latest.yml',
]
const lines = []
for (const name of filenames) {
  const bytes = await fs.readFile(path.join(root, 'dist', name))
  lines.push(`${crypto.createHash('sha256').update(bytes).digest('hex')}  ${name}`)
}
const metadata = yaml.load(await fs.readFile(path.join(root, 'dist/latest.yml'), 'utf8'))
const setup = await fs.readFile(path.join(root, 'dist', filenames[0]))
if (
  metadata.version !== version ||
  metadata.path !== filenames[0] ||
  metadata.sha512 !== crypto.createHash('sha512').update(setup).digest('base64')
)
  throw new Error('Auto-update metadata does not match the release installer')
await fs.writeFile(path.join(root, 'dist/SHA256SUMS.txt'), lines.join('\n') + '\n')
console.log(
  `RELEASE_READY ${version}: ${filenames.length} payloads + SHA256SUMS.txt; latest.yml verified`,
)
