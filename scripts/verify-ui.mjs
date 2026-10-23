import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
const root = path.resolve(import.meta.dirname, '..')
const output = path.join(root, 'output/playwright')
await fs.mkdir(output, { recursive: true })
const data = await fs.mkdtemp(path.join(os.tmpdir(), 'qqdsh-ui-'))
const executablePath = process.env.QQDSH_VERIFY_EXE
const env = {
  ...process.env,
  QQDSH_DATA_DIR: data,
  DSH_HOME: path.join(data, '独立 DSH 数据'),
  QQDSH_SKIP_UPDATE_CHECK: '1',
}
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({
  ...(executablePath ? { executablePath, args: [] } : { args: [root] }),
  cwd: root,
  env,
  timeout: 60000,
})
const report = {
  executable: executablePath || 'development build',
  dataDirectory: data,
  checks: [],
  screenshots: [],
  errors: [],
}
const check = (name, value) => {
  assert.ok(value, name)
  report.checks.push(name)
  console.log('PASS ' + name)
}
try {
  const page = await app.firstWindow({ timeout: 60000 })
  page.on('pageerror', (error) => report.errors.push(error.message))
  await page.getByRole('heading', { name: '环境总览', exact: true }).waitFor()
  await page.getByRole('button', { name: '开始环境检测', exact: true }).waitFor()
  const capture = async (name) => {
    const file = path.join(output, name)
    await page.screenshot({ path: file })
    report.screenshots.push(file)
  }
  check(
    'packaged renderer and preload load',
    await page.evaluate(() => !!window.deployer && typeof window.deployer.preview === 'function'),
  )
  check(
    'renderer has no Node integration',
    await page.evaluate(() => typeof window.require === 'undefined'),
  )
  const menuLabels = await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()?.items.flatMap((item) => [
      item.label,
      ...(item.submenu?.items.map((child) => child.label) || []),
    ]),
  )
  check(
    'native software menu exposes About and update checks',
    menuLabels.includes('关于软件') && menuLabels.includes('检查软件更新'),
  )
  await page.getByRole('button', { name: '关于软件', exact: true }).click()
  const about = page.getByRole('dialog')
  await about.waitFor()
  check('About identifies developer 安索', (await about.innerText()).includes('开发者：安索'))
  check(
    'About contains explicit upstream links',
    (await about.getByRole('link', { name: 'Electron', exact: true }).getAttribute('href')) ===
      'https://github.com/electron/electron',
  )
  check(
    'GitHub update controls are present',
    await about.getByRole('button', { name: '检查软件更新', exact: true }).isVisible(),
  )
  await capture(executablePath ? 'packaged-about.png' : '00-about.png')
  await page.keyboard.press('Escape')
  await about.waitFor({ state: 'hidden' })
  await capture(executablePath ? 'packaged-overview.png' : '01-overview.png')
  await page.getByRole('button', { name: '连接配置 账号与访问范围' }).click()
  const owner = page.getByLabel('管理员 QQ', { exact: true })
  await owner.fill('123456789')
  await page.getByLabel('允许回应的群号', { exact: false }).fill('987654321')
  await page.getByRole('button', { name: '运行管理 启动与健康状态' }).click()
  await page.getByRole('heading', { name: '运行管理', exact: true }).waitFor()
  await capture('02-services.png')
  await page.getByRole('button', { name: '连接配置 账号与访问范围' }).click()
  check('unsaved configuration survives navigation', (await owner.inputValue()) === '123456789')
  await page.getByRole('button', { name: '保存连接配置', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '连接配置已保存' }).waitFor()
  check(
    'configuration persists through real IPC',
    (await page.evaluate(() => window.deployer.snapshot())).settings.ownerQQ === '123456789',
  )
  await capture('03-config.png')
  await page.getByRole('button', { name: '快速部署 按需补齐组件' }).click()
  for (const label of await page.locator('.deploy-option').all()) {
    const text = await label.innerText()
    await label.getByRole('checkbox').setChecked(text.includes('PowerShell 7'))
  }
  await page.getByRole('button', { name: '预览部署变更', exact: true }).click()
  await page.getByRole('heading', { name: '即将执行的变更' }).waitFor()
  check(
    'PowerShell install preview uses Microsoft release and exact hash catalog',
    (await page.locator('.plan-item').innerText()).includes('7.6.8'),
  )
  check(
    'execution requires review acknowledgement',
    await page.getByRole('button', { name: '开始部署', exact: true }).isDisabled(),
  )
  await capture('04-powershell-preview.png')
  await page.getByRole('button', { name: '环境总览 检查安装与连接' }).click()
  await page.getByRole('button', { name: '检测环境', exact: true }).click()
  await page.locator('.component-row').first().waitFor({ timeout: 60000 })
  check(
    'read-only scan returns actual components',
    (await page.locator('.component-row').count()) === 9,
  )
  check(
    'scan reports installed system Node version',
    (await page.locator('.component-wrap').filter({ hasText: 'Node.js' }).innerText()).includes(
      '24.',
    ),
  )
  await capture('05-detected.png')
  await page.setViewportSize({ width: 960, height: 690 })
  await capture('06-narrow.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await capture('07-mobile-render-preview.png')
  check(
    'narrow responsive preview has no document overflow',
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  )
  await page.setViewportSize({ width: 1280, height: 820 })
  await page.getByRole('button', { name: '日志诊断 定位与恢复问题' }).click()
  await capture('08-logs.png')
  const bad = await page.evaluate(async () => {
    try {
      await window.deployer.service('bridge', 'start')
      return false
    } catch {
      return true
    }
  })
  check('starting absent service returns actionable error', bad)
  check('no renderer exceptions', report.errors.length === 0)
  // All changes above are confined to a dedicated temporary tool-data directory.
  await fs.writeFile(
    path.join(output, executablePath ? 'packaged-report.json' : 'report.json'),
    JSON.stringify(report, null, 2),
  )
  console.log(
    `UI_ACCEPTANCE_RESULT ${JSON.stringify({ checks: report.checks.length, errors: report.errors, output })}`,
  )
} catch (error) {
  report.errors.push(error.message)
  const pages = app.windows()
  if (pages[0])
    await pages[0].screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  await fs.writeFile(path.join(output, 'failure-report.json'), JSON.stringify(report, null, 2))
  throw error
} finally {
  await app.close()
}
