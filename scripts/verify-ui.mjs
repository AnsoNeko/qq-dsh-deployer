import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { scryptSync } from 'node:crypto'
import net from 'node:net'
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
  // Synthetic upstream output exercises the real credential IPC without starting QQ or SnowLuma.
  const snowHome = path.join(data, 'SnowLuma 测试')
  const snowPassword = '0123456789abcdef'
  const salt = Buffer.alloc(16, 7)
  const snowConfig = {
    passwordHash: scryptSync(snowPassword, salt, 64).toString('hex'),
    passwordSalt: salt.toString('hex'),
    mustChangePassword: true,
  }
  await fs.mkdir(path.join(snowHome, 'config'), { recursive: true })
  await fs.writeFile(path.join(snowHome, 'config', 'webui.json'), JSON.stringify(snowConfig))
  await fs.writeFile(
    path.join(data, 'snowluma-local.log'),
    `[INFO] [WebUI] initial credentials: user=admin password=${snowPassword}\r\n`,
  )
  await page.evaluate(async (home) => {
    const snapshot = await window.deployer.snapshot()
    await window.deployer.saveConfig({
      settings: { ...snapshot.settings, snowlumaPath: home },
      applyBridge: false,
    })
  }, snowHome)
  await page.getByRole('button', { name: '运行管理 启动与健康状态' }).click()
  const login = page.getByRole('region', { name: 'SnowLuma 后台登录' })
  await login.getByRole('button', { name: '复制初始密码', exact: true }).waitFor()
  check(
    'SnowLuma initial password is shown through real IPC',
    (await login.getByLabel('后台初始密码', { exact: true }).inputValue()) === snowPassword,
  )
  const previousClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await login.getByRole('button', { name: '复制初始密码', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '初始密码已复制' }).waitFor()
    check(
      'SnowLuma initial password can be copied',
      (await app.evaluate(({ clipboard }) => clipboard.readText())) === snowPassword,
    )
  } finally {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), previousClipboard)
  }
  await login.scrollIntoViewIfNeeded()
  await capture('09-snowluma-login.png')
  const snapshot = await page.evaluate(() => window.deployer.snapshot())
  const waitingSnapshot = {
    ...snapshot,
    task: {
      id: 'snowluma-ui-fixture',
      title: '部署 SnowLuma',
      state: 'waiting',
      startedAt: new Date().toISOString(),
      steps: [{ id: 'snowluma', title: '安装 SnowLuma', state: 'waiting', detail: '等待后台登录' }],
    },
  }
  await app.evaluate(({ BrowserWindow }, value) => {
    BrowserWindow.getAllWindows()[0].webContents.send('deployer:change', value)
  }, waitingSnapshot)
  await page.getByRole('button', { name: '快速部署 按需补齐组件' }).click()
  await login.getByLabel('后台初始密码', { exact: true }).waitFor()
  check('SnowLuma waiting deployment exposes login credentials', await login.isVisible())
  await login.scrollIntoViewIfNeeded()
  await capture('10-snowluma-deploy-login.png')
  await fs.writeFile(
    path.join(snowHome, 'config', 'webui.json'),
    JSON.stringify({ ...snowConfig, mustChangePassword: false }),
  )
  await login.getByText('已设置后台密码', { exact: false }).waitFor()
  check(
    'SnowLuma password disappears after password change',
    (await login.getByLabel('后台初始密码', { exact: true }).count()) === 0,
  )
  check(
    'SnowLuma password is excluded from snapshots',
    !JSON.stringify(snapshot).includes(snowPassword),
  )
  check(
    'SnowLuma password is excluded from activity logs',
    !(await fs.readFile(path.join(data, 'activity.log'), 'utf8')).includes(snowPassword),
  )
  // A tiny local bridge fixture verifies the real process launch, token generation,
  // clipboard, authenticated browser URL and environment sync without sending QQ messages.
  const bridgeHome = path.join(data, 'QQ Bridge 测试')
  const bridgeToken = 'fixture-bridge-console-token-0123456789'
  const nextBridgeToken = 'fixture-rotated-console-token-9876543210'
  const listener = net.createServer()
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const bridgePort = listener.address().port
  await new Promise((resolve) => listener.close(resolve))
  await fs.mkdir(path.join(bridgeHome, 'src'), { recursive: true })
  await fs.mkdir(path.join(bridgeHome, 'node_modules/js-yaml'), { recursive: true })
  await fs.writeFile(
    path.join(bridgeHome, 'package.json'),
    JSON.stringify({ name: 'qqdsh-bridge-fixture', type: 'module', version: '0.2.1-r1' }),
  )
  await fs.writeFile(
    path.join(bridgeHome, 'config.json'),
    JSON.stringify({
      consolePort: bridgePort,
      ownerQQ: '123456789',
      allow: { groups: ['987654321'], private: [] },
      dsh: { baseUrl: 'http://127.0.0.1:3080', model: 'deepseek-flash' },
      snowluma: { httpUrl: 'http://127.0.0.1:3000', wsUrl: 'ws://127.0.0.1:3001' },
      custom: 'preserved-by-sync',
    }),
  )
  await fs.writeFile(
    path.join(bridgeHome, 'src/bridge.js'),
    `
import fs from 'node:fs';
import http from 'node:http';
const config = JSON.parse(fs.readFileSync('config.json', 'utf8'));
fs.mkdirSync('state', {recursive:true});
if (!fs.existsSync('state/console-token')) fs.writeFileSync('state/console-token', ${JSON.stringify(bridgeToken)});
http.createServer((req,res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const token = fs.readFileSync('state/console-token', 'utf8').trim();
  if ((url.searchParams.get('token') || req.headers['x-console-token']) !== token) {res.writeHead(401);res.end('requires console token');return;}
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify(url.pathname === '/api/status' ? {dshReady:true,mode:'chat',snowluma:{connected:true,degraded:false}} : {authenticated:true}));
}).listen(config.consolePort, '127.0.0.1');
`,
  )
  await page.evaluate(
    async ({ bridgeHome, node, bridgePort }) => {
      const current = await window.deployer.snapshot()
      await window.deployer.saveConfig({
        settings: {
          ...current.settings,
          bridgePath: bridgeHome,
          nodePath: node,
          consolePort: bridgePort,
        },
        applyBridge: false,
      })
    },
    { bridgeHome, node: process.execPath, bridgePort },
  )
  await page.getByRole('button', { name: '运行管理 启动与健康状态' }).click()
  const bridgeLogin = page.getByRole('region', { name: 'QQ Bridge 控制台登录' })
  await bridgeLogin.getByText('等待 QQ Bridge 首次启动', { exact: false }).waitFor()
  await app.evaluate(({ shell }) => {
    globalThis.__qqdshOriginalOpenExternal = shell.openExternal
    shell.openExternal = async (url) => {
      globalThis.__qqdshOpenedUrl = url
    }
  })
  await page.evaluate(() => window.deployer.service('bridge', 'start'))
  await bridgeLogin.getByRole('button', { name: '复制控制台令牌', exact: true }).waitFor()
  check(
    'bridge first-start token is shown through real IPC',
    (await bridgeLogin.getByLabel('控制台访问令牌', { exact: true }).inputValue()) === bridgeToken,
  )
  const openedUrl = await app.evaluate(() => globalThis.__qqdshOpenedUrl)
  check(
    'starting bridge automatically opens an authenticated console URL',
    new URL(openedUrl).searchParams.get('token') === bridgeToken && (await fetch(openedUrl)).ok,
  )
  check(
    'bridge authentication remains required',
    (await fetch(`http://127.0.0.1:${bridgePort}`)).status === 401,
  )
  const clipboardBeforeBridge = await app.evaluate(({ clipboard }) => clipboard.readText())
  try {
    await bridgeLogin.getByRole('button', { name: '复制控制台令牌', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: '控制台令牌已复制' }).waitFor()
    check(
      'bridge token can be copied through native clipboard',
      (await app.evaluate(({ clipboard }) => clipboard.readText())) === bridgeToken,
    )
  } finally {
    await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), clipboardBeforeBridge)
  }
  await fs.writeFile(path.join(bridgeHome, 'state/console-token'), nextBridgeToken)
  await page.waitForFunction(
    async (value) => (await window.deployer.bridgeLogin()).token === value,
    nextBridgeToken,
  )
  await bridgeLogin.getByRole('button', { name: '自动登录 QQ Bridge 控制台', exact: true }).click()
  await page.waitForTimeout(200)
  const rotatedUrl = await app.evaluate(() => globalThis.__qqdshOpenedUrl)
  check(
    'opening console reads the current rotated token',
    new URL(rotatedUrl).searchParams.get('token') === nextBridgeToken &&
      (await fetch(rotatedUrl)).ok,
  )
  await fs.writeFile(path.join(snowHome, 'launcher.bat'), '@echo off\r\n')
  await fs.writeFile(
    path.join(snowHome, 'config/onebot_5555555.json'),
    JSON.stringify({
      networks: {
        httpServers: [
          { host: '127.0.0.1', port: bridgePort + 2, accessToken: 'fixture-http-token' },
        ],
        wsServers: [{ host: '127.0.0.1', port: bridgePort + 3, accessToken: 'fixture-ws-token' }],
      },
    }),
  )
  await page.getByRole('button', { name: '检测并应用实际配置', exact: true }).click()
  await page
    .getByRole('alert')
    .filter({ hasText: '实际连接配置已同步' })
    .waitFor({ timeout: 60000 })
  const synchronized = await page.evaluate(() => window.deployer.snapshot())
  check(
    'environment sync persists actual OneBot addresses',
    synchronized.settings.httpUrl === `http://127.0.0.1:${bridgePort + 2}` &&
      synchronized.settings.wsUrl === `ws://127.0.0.1:${bridgePort + 3}`,
  )
  const syncedBridgeConfig = JSON.parse(
    await fs.readFile(path.join(bridgeHome, 'config.json'), 'utf8'),
  )
  check(
    'environment sync preserves bridge ACL and unrelated config',
    syncedBridgeConfig.custom === 'preserved-by-sync' &&
      syncedBridgeConfig.ownerQQ === '123456789' &&
      syncedBridgeConfig.allow.groups[0] === '987654321',
  )
  await page.getByRole('button', { name: '连接配置 账号与访问范围' }).click()
  check(
    'automatic configuration updates are reflected in the form',
    (await page.getByLabel('OneBot HTTP 地址', { exact: false }).inputValue()) ===
      synchronized.settings.httpUrl,
  )
  check(
    'bridge token is excluded from general snapshots and activity logs',
    !JSON.stringify(synchronized).includes(nextBridgeToken) &&
      !(await fs.readFile(path.join(data, 'activity.log'), 'utf8')).includes(nextBridgeToken),
  )
  await page.getByRole('button', { name: '运行管理 启动与健康状态' }).click()
  await bridgeLogin.scrollIntoViewIfNeeded()
  await capture('11-bridge-console-login.png')
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
  const page = app.windows()[0]
  if (page)
    await page
      .evaluate(async () => {
        const snapshot = await window.deployer.snapshot()
        if (snapshot.owned.bridge) await window.deployer.service('bridge', 'stop')
      })
      .catch(() => {})
  await app
    .evaluate(({ shell }) => {
      if (globalThis.__qqdshOriginalOpenExternal)
        shell.openExternal = globalThis.__qqdshOriginalOpenExternal
    })
    .catch(() => {})
  await app.close()
}
