import { _electron as electron } from 'playwright'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
import yaml from 'js-yaml'

const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const latest = await fetch('https://api.github.com/repos/AnsoNeko/qq-dsh-deployer/releases/latest')
assert.equal(latest.status, 200)
const release = await latest.json()
assert.equal(release.tag_name, 'v' + version)
assert.equal(release.draft, false)
assert.equal(release.prerelease, false)
const names = [
  `QQDshDeployer-${version}-x64-Setup.exe`,
  `QQDshDeployer-${version}-x64-Portable.exe`,
  `QQDshDeployer-${version}-x64-Setup.exe.blockmap`,
  'latest.yml',
  'SHA256SUMS.txt',
]
for (const name of names) {
  const local = await fs.readFile(path.join(root, 'dist', name))
  const asset = release.assets.find((entry) => entry.name === name)
  assert.ok(asset, name)
  assert.equal(asset.size, local.length, name)
  assert.equal(
    asset.digest,
    'sha256:' + crypto.createHash('sha256').update(local).digest('hex'),
    name,
  )
}
const metadataResponse = await fetch(
  `https://github.com/AnsoNeko/qq-dsh-deployer/releases/download/v${version}/latest.yml`,
)
assert.equal(metadataResponse.status, 200)
const metadata = yaml.load(await metadataResponse.text())
assert.equal(metadata.version, version)
assert.equal(metadata.path, names[0])
const expected = crypto
  .createHash('sha512')
  .update(await fs.readFile(path.join(root, 'dist', names[0])))
  .digest('base64')
assert.equal(metadata.sha512, expected)
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-published-'))
const env = {
  ...process.env,
  QQDSH_DATA_DIR: data,
  DSH_HOME: path.join(data, 'dsh'),
  QQDSH_SKIP_UPDATE_CHECK: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  executablePath: path.join(root, 'dist/win-unpacked/QQ大肥鱼部署助手.exe'),
  cwd: root,
  env,
  timeout: 60000,
})
try {
  const page = await app.firstWindow()
  await page.getByRole('heading', { name: '环境总览', exact: true }).waitFor()
  await page.evaluate(() => window.deployer.checkAppUpdate())
  const status = (await page.evaluate(() => window.deployer.snapshot())).appUpdate
  assert.equal(status.current, version)
  assert.equal(status.latest, version)
  assert.equal(status.state, 'current', status.detail)
  await fs.mkdir(path.join(root, 'output/acceptance'), { recursive: true })
  const report = {
    at: new Date().toISOString(),
    release: release.html_url,
    assets: names,
    metadata: 'verified',
    appUpdate: status,
  }
  await fs.writeFile(
    path.join(root, 'output/acceptance/published-release.json'),
    JSON.stringify(report, null, 2),
  )
  console.log('PUBLISHED_RELEASE_RESULT ' + JSON.stringify(report))
} finally {
  await app.close()
}
