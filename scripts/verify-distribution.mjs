import { chromium } from 'playwright'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
const root = path.resolve(import.meta.dirname, '..')
const { version } = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const base = path.join(root, '.cache/distribution-' + crypto.randomUUID())
if (!base.startsWith(root + path.sep)) throw new Error('Test path escaped workspace')
await fs.mkdir(base, { recursive: true })
await fs.mkdir(path.join(root, 'output/acceptance'), { recursive: true })
const report = { startedAt: new Date().toISOString(), root: base, checks: [], errors: [] }
const env = {
  ...process.env,
  QQDSH_DATA_DIR: path.join(base, 'data'),
  DSH_HOME: path.join(base, 'dsh'),
  QQDSH_SKIP_UPDATE_CHECK: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const run = (exe, args, extraEnv = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: { ...env, ...extraEnv },
      cwd: root,
      windowsHide: true,
      stdio: 'pipe',
    })
    let output = ''
    child.stdout.on('data', (b) => {
      output += b
      process.stdout.write(b)
    })
    child.stderr.on('data', (b) => {
      output += b
      process.stderr.write(b)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0
        ? resolve(output)
        : reject(new Error(`${path.basename(exe)} exited ${code}: ${output.slice(-1000)}`)),
    )
  })
const check = (name) => {
  report.checks.push(name)
  console.log('PASS ' + name)
}
const registered = () => {
  const value = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '$ErrorActionPreference="Stop"; [Console]::OutputEncoding=[Text.UTF8Encoding]::new(); @(Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*" -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq "QQ大肥鱼部署助手" } | Select-Object -ExpandProperty InstallLocation) | ConvertTo-Json -Compress',
    ],
    {
      env: {
        ...env,
        PSModulePath: path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
      },
      encoding: 'utf8',
    },
  ).trim()
  return value ? JSON.parse(value) : []
}
let uninstall
try {
  const runningApps = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      '@(Get-Process -Name "QQ大肥鱼部署助手" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8' },
  ).trim()
  if (runningApps && runningApps !== '[]')
    throw new Error(
      'Existing deployer process detected; refusing NSIS acceptance because its close-app logic can stop an active portable app',
    )
  const existing = registered()
  if (existing.length)
    throw new Error(
      'Existing user installation detected; refusing installer acceptance over user state',
    )
  const installDir = path.join(base, 'installed')
  await run(path.join(root, `dist/QQDshDeployer-${version}-x64-Setup.exe`), [
    '/S',
    '/D=' + installDir,
  ])
  const installedExe = path.join(installDir, 'QQ大肥鱼部署助手.exe')
  await fs.access(installedExe)
  check('NSIS installs into an isolated workspace directory')
  uninstall = (await fs.readdir(installDir)).find((f) => /^Uninstall.*\.exe$/i.test(f))
  if (!uninstall) throw new Error('Uninstaller not found')
  check('NSIS produces an uninstaller')
  await run(process.execPath, ['scripts/verify-ui.mjs'], { QQDSH_VERIFY_EXE: installedExe })
  check('installed executable passes real Electron UI acceptance')
  await run(path.join(installDir, uninstall), ['/S'])
  for (let i = 0; i < 60 && (await fs.stat(installedExe).catch(() => null)); i++)
    await new Promise((r) => setTimeout(r, 250))
  if (await fs.stat(installedExe).catch(() => null))
    throw new Error('Uninstaller did not remove test installation')
  if (registered().length) throw new Error('Test uninstall registration remains')
  uninstall = null
  check('uninstaller removes test executable and registration')
  const server = net.createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  await new Promise((r) => server.close(r))
  const portable = spawn(
    path.join(root, `dist/QQDshDeployer-${version}-x64-Portable.exe`),
    [`--remote-debugging-port=${port}`],
    {
      env: { ...env, QQDSH_DATA_DIR: path.join(base, 'portable-data') },
      windowsHide: true,
      stdio: 'ignore',
    },
  )
  let browser
  try {
    let ready = false
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`)
        if (res.ok) {
          ready = true
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 250))
    }
    if (!ready) throw new Error('Portable application did not expose its test-only CDP endpoint')
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = browser.contexts()[0].pages()[0]
    await page.getByRole('heading', { name: '环境总览', exact: true }).waitFor()
    if (!(await page.evaluate(() => !!window.deployer))) throw new Error('Portable preload missing')
    await page.screenshot({ path: path.join(root, 'output/playwright/portable-overview.png') })
    check('portable launcher extracts and opens the actual app with preload and assets')
    await page.close()
    await browser.close()
    browser = null
  } finally {
    await browser?.close().catch(() => {})
    if (portable.exitCode === null)
      await run('taskkill.exe', ['/PID', String(portable.pid), '/T', '/F']).catch(() => {})
  }
} catch (error) {
  report.errors.push(error.message)
  throw error
} finally {
  if (uninstall) {
    const file = path.join(base, 'installed', uninstall)
    await run(file, ['/S']).catch((error) => report.errors.push('Cleanup: ' + error.message))
  }
  report.finishedAt = new Date().toISOString()
  await fs.writeFile(
    path.join(root, 'output/acceptance/distribution.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(
    'DISTRIBUTION_ACCEPTANCE_RESULT ' +
      JSON.stringify({ checks: report.checks.length, errors: report.errors }),
  )
}
