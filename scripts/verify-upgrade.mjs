import { _electron as electron } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'

const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const previousInstaller = process.env.QQDSH_PREVIOUS_INSTALLER
if (!previousInstaller || !path.isAbsolute(previousInstaller))
  throw new Error('Set QQDSH_PREVIOUS_INSTALLER to the previous official Setup.exe')
const base = path.join(root, '.cache/upgrade-' + crypto.randomUUID())
const installDir = path.join(base, 'installed')
const data = path.join(base, 'data')
const dsh = path.join(base, 'dsh')
const exe = path.join(installDir, 'QQ大肥鱼部署助手.exe')
const report = { fromInstaller: path.basename(previousInstaller), version, checks: [], errors: [] }
const env = { ...process.env, QQDSH_DATA_DIR: data, DSH_HOME: dsh, QQDSH_SKIP_UPDATE_CHECK: '1' }
delete env.ELECTRON_RUN_AS_NODE
const check = (name, value) => {
  assert.ok(value, name)
  report.checks.push(name)
  console.log('PASS ' + name)
}
const run = (file, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, env, windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${path.basename(file)} exited ${code}`)),
    )
  })
const preflight = () =>
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference="Stop"; if(Get-Process -Name "QQ大肥鱼部署助手" -ErrorAction SilentlyContinue) { throw "Existing deployer process; upgrade test refused" }; if(Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "QQ大肥鱼部署助手" }) { throw "Existing user installation; upgrade test refused" }',
    ],
    { stdio: 'pipe' },
  )
const digest = async (file) =>
  crypto
    .createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex')
let app
let uninstall
async function closeApp() {
  const process = app.process()
  const closed =
    process.exitCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => process.once('exit', resolve))
  await app.close()
  app = undefined
  await Promise.race([
    closed,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Test application has not exited')), 15000)
      timer.unref()
    }),
  ])
  // Windows may still be releasing executable image sections after the process exits.
  await new Promise((resolve) => setTimeout(resolve, 1500))
}
try {
  preflight()
  assert.ok(path.resolve(installDir).startsWith(root + path.sep))
  await fs.mkdir(base, { recursive: true })
  await run(previousInstaller, ['/S', '/D=' + installDir])
  uninstall = (await fs.readdir(installDir)).find((name) => /^Uninstall.*\.exe$/i.test(name))
  assert.ok(uninstall)
  app = await electron.launch({ executablePath: exe, env, cwd: root, timeout: 60000 })
  let page = await app.firstWindow()
  await page.getByRole('heading', { name: '环境总览', exact: true }).waitFor()
  const old = await page.evaluate(() => window.deployer.snapshot())
  check('previous official installed app starts as 0.1.3', old.version === '0.1.3')
  await page.evaluate(async () => {
    const current = await window.deployer.snapshot()
    await window.deployer.saveConfig({
      settings: { ...current.settings, ownerQQ: '123456789', groups: '987654321' },
      httpToken: 'upgrade-test-http-token',
      wsToken: 'upgrade-test-ws-token',
      applyBridge: false,
    })
  })
  await closeApp()
  const component = path.join(data, 'components/qq-bridge/config.json')
  const profile = path.join(dsh, 'profiles/desktop/cordis.patch.yml')
  await fs.mkdir(path.dirname(component), { recursive: true })
  await fs.mkdir(path.dirname(profile), { recursive: true })
  await fs.writeFile(component, '{"preserve":"component-user-config"}\n')
  await fs.writeFile(profile, '# preserve user dsh profile\n')
  const preserved = [
    path.join(data, 'settings.json'),
    path.join(data, 'secrets.bin'),
    component,
    profile,
  ]
  const hashes = await Promise.all(preserved.map(digest))
  await run(path.join(root, `dist/QQDshDeployer-${version}-x64-Setup.exe`), [
    '/S',
    '/D=' + installDir,
  ])
  check('new NSIS installer upgrades the same isolated installation', !!(await fs.stat(exe)))
  uninstall = (await fs.readdir(installDir)).find((name) => /^Uninstall.*\.exe$/i.test(name))
  assert.ok(uninstall)
  for (let launch = 0; launch < 2; launch++) {
    app = await electron.launch({ executablePath: exe, env, cwd: root, timeout: 60000 })
    page = await app.firstWindow()
    await page.getByRole('heading', { name: '环境总览', exact: true }).waitFor()
    const current = await page.evaluate(() => window.deployer.snapshot())
    check(
      `upgraded app starts with expected version (launch ${launch + 1})`,
      current.version === version,
    )
    check(
      `old settings and encrypted credentials remain usable (launch ${launch + 1})`,
      current.settings.ownerQQ === '123456789' &&
        current.settings.groups === '987654321' &&
        current.tokenPresent.http &&
        current.tokenPresent.ws,
    )
    check(
      `old settings gain isolated TTS defaults (launch ${launch + 1})`,
      current.settings.ttsRoot === path.join(data, 'advanced/qwen3-tts') &&
        current.settings.ttsMode === 'auto',
    )
    await page.getByRole('button', { name: '进阶功能 本地语音模型部署' }).click()
    await page.getByRole('heading', { name: '本地语音合成', exact: true }).waitFor()
    check(
      `new advanced screen loads after upgrade (launch ${launch + 1})`,
      !!(await page.getByLabel('语音模型独立安装目录', { exact: true }).inputValue()),
    )
    await closeApp()
  }
  check(
    'upgrade preserves settings, credentials, component and dsh config bytes',
    JSON.stringify(await Promise.all(preserved.map(digest))) === JSON.stringify(hashes),
  )
  await run(path.join(installDir, uninstall), ['/S'])
  uninstall = undefined
  for (let n = 0; n < 60 && (await fs.stat(exe).catch(() => null)); n++)
    await new Promise((resolve) => setTimeout(resolve, 250))
  check('test uninstall removes its own executable', !(await fs.stat(exe).catch(() => null)))
  check(
    'uninstall retains independent user configuration',
    JSON.stringify(await Promise.all(preserved.map(digest))) === JSON.stringify(hashes),
  )
  preflight()
} catch (error) {
  report.errors.push(error.message)
  throw error
} finally {
  await app?.close().catch(() => {})
  if (uninstall)
    await run(path.join(installDir, uninstall), ['/S']).catch((error) =>
      report.errors.push('Cleanup: ' + error.message),
    )
  await fs.mkdir(path.join(root, 'output/acceptance'), { recursive: true })
  await fs.writeFile(
    path.join(root, 'output/acceptance/upgrade.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(
    'UPGRADE_ACCEPTANCE_RESULT ' +
      JSON.stringify({ checks: report.checks.length, errors: report.errors }),
  )
}
