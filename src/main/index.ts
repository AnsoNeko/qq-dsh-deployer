import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  shell,
  Tray,
  Menu,
  nativeImage,
} from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Store } from './store'
import { Engine } from './engine'
import { AppUpdates } from './updates'
import { projects } from '../shared/projects'
import { json, redact, redactDiagnostics } from './core'
import type { DeployRequest, OpenTarget, Settings } from '../shared/types'

let window: BrowserWindow | null = null
let tray: Tray | null = null
let engine: Engine
let quitting = false
const settingsSchema = z
  .object({
    installRoot: z.string().min(3).max(1000),
    dshHome: z.string().min(3).max(1000),
    nodePath: z.string().max(1000),
    harnessPath: z.string().max(1000),
    snowlumaPath: z.string().max(1000),
    bridgePath: z.string().max(1000),
    qqPath: z.string().max(1000),
    pwshPath: z.string().max(1000),
    dshUrl: z.string().max(500),
    httpUrl: z.string().max(500),
    wsUrl: z.string().max(500),
    consolePort: z.number().int(),
    ownerQQ: z.string().max(20),
    groups: z.string().max(10000),
    friends: z.string().max(10000),
    model: z.string().min(1).max(200),
    proxy: z.string().max(500),
    snowlumaAuthorized: z.boolean(),
    firstRun: z.boolean(),
    registerPwshPath: z.boolean(),
  })
  .strict()
const requestSchema = z
  .object({
    actions: z
      .array(z.enum(['node', 'powershell', 'harness', 'snowluma', 'bridge', 'plugins']))
      .min(1)
      .max(6),
    acceptUnverified: z.boolean(),
  })
  .strict()
const isDev = !app.isPackaged && !!process.env.ELECTRON_RENDERER_URL
const dataRoot = process.env.QQDSH_DATA_DIR
  ? path.resolve(process.env.QQDSH_DATA_DIR)
  : path.join(process.env.LOCALAPPDATA || app.getPath('userData'), 'QQDshDeployer')
app.setPath('userData', path.join(dataRoot, 'browser'))
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    window?.show()
    window?.focus()
  })
  app
    .whenReady()
    .then(start)
    .catch(async (e: Error) => {
      await dialog.showMessageBox({ type: 'error', title: '部署助手启动失败', message: e.message })
      app.exit(1)
    })
}
async function start(): Promise<void> {
  const resources = app.isPackaged
    ? path.join(process.resourcesPath, 'catalog')
    : path.join(app.getAppPath(), 'resources')
  const catalog = await json(path.join(resources, 'catalog.json'))
  if (!catalog) throw new Error('发行清单缺失')
  const store = new Store(dataRoot, {
    encrypt: (s) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error('Windows 凭据加密不可用，未保存敏感信息')
      return safeStorage.encryptString(s)
    },
    decrypt: (b) => safeStorage.decryptString(b),
  })
  engine = new Engine(
    store,
    catalog,
    (snapshot) => {
      if (window && !window.isDestroyed()) window.webContents.send('deployer:change', snapshot)
    },
    (url) => shell.openExternal(url),
  )
  await engine.init()
  engine.version = app.getVersion()
  const updater = new AppUpdates(
    dataRoot,
    (status) => {
      engine.appUpdate = status
      engine.emit()
    },
    (s) => engine.log(s, 'warn'),
  )
  engine.appUpdate = updater.status
  const handlers: Record<string, (arg?: any) => any> = {
    snapshot: () => engine.snapshot(),
    scan: () => engine.scan(),
    updates: () => engine.updates(),
    checkAppUpdate: () => updater.check(),
    installAppUpdate: async () => {
      if (engine.task && ['running', 'waiting'].includes(engine.task.state))
        throw new Error('请先完成或取消部署任务，再安装应用更新')
      await updater.install()
    },
    openProject: async (id) => {
      const project = projects.find((p) => p.id === id)
      if (!project) throw new Error('未知项目链接')
      await shell.openExternal(project.url)
    },
    saveConfig: (input) => {
      const v = z
        .object({
          settings: settingsSchema,
          httpToken: z.string().max(4000).optional(),
          wsToken: z.string().max(4000).optional(),
          applyBridge: z.boolean().optional(),
        })
        .strict()
        .parse(input)
      return engine.saveConfig(v)
    },
    importConfig: () => engine.importConfig(),
    choosePath: async (kind) => {
      z.enum(['file', 'directory']).parse(kind)
      const result = await dialog.showOpenDialog(window!, {
        title: kind === 'file' ? '选择程序文件' : '选择安装目录',
        properties: [kind === 'file' ? 'openFile' : 'openDirectory'],
      })
      return result.canceled ? null : result.filePaths[0]
    },
    preview: (v) => engine.preview(requestSchema.parse(v) as DeployRequest),
    deploy: (v) => engine.deploy(requestSchema.parse(v) as DeployRequest),
    cancel: () => engine.cancel(),
    resume: () => engine.resume(),
    retry: () => engine.retry(),
    service: (v) => {
      const p = z
        .object({
          id: z.enum(['bridge', 'snowluma', 'harness']),
          action: z.enum(['start', 'stop', 'restart']),
        })
        .strict()
        .parse(v)
      return engine.service(p.id, p.action)
    },
    restore: (id) => engine.restore(z.string().uuid().parse(id)),
    open: (target) =>
      openTarget(
        z.enum(['harness', 'snowluma', 'bridge', 'qq', 'data', 'docs', 'snow-docs']).parse(target),
      ),
    exportDiagnostics: async () => {
      const file = await dialog.showSaveDialog(window!, {
        title: '导出脱敏诊断',
        defaultPath: 'QQDsh诊断.json',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      })
      if (file.canceled || !file.filePath) return null
      const s = await engine.snapshot()
      // Never export configuration contents, credentials, arbitrary upstream response bodies, or chat state.
      const safe = {
        generatedAt: new Date().toISOString(),
        version: s.version,
        platform: process.platform,
        architecture: process.arch,
        components: s.components,
        task: s.task,
        logs: s.logs,
        acceptance: { realQQRoundTrip: '待用户实测' },
      }
      const content = JSON.stringify(redactDiagnostics(safe, Object.values(store.secrets)), null, 2)
      await fs.writeFile(file.filePath, content, { encoding: 'utf8', mode: 0o600 })
      return file.filePath
    },
  }
  for (const [name, fn] of Object.entries(handlers))
    ipcMain.handle(`deployer:${name}`, async (event, arg) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error('IPC 来源无效')
      try {
        return await fn(arg)
      } catch (e: any) {
        engine.log(e.message || String(e), 'error')
        throw new Error(redact(e.message || String(e)))
      }
    })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '软件',
        submenu: [
          {
            label: '关于软件',
            accelerator: 'F1',
            click: () => window?.webContents.send('deployer:command', 'about'),
          },
          {
            label: '检查软件更新',
            click: () => {
              window?.webContents.send('deployer:command', 'updates')
              void updater.check()
            },
          },
          { type: 'separator' },
          {
            label: '退出',
            click: () => {
              if (!engine.task || !['running', 'waiting'].includes(engine.task.state)) {
                quitting = true
                app.quit()
              } else window?.show()
            },
          },
        ],
      },
      {
        label: '编辑',
        submenu: [
          { role: 'undo', label: '撤销' },
          { role: 'redo', label: '重做' },
          { type: 'separator' },
          { role: 'cut', label: '剪切' },
          { role: 'copy', label: '复制' },
          { role: 'paste', label: '粘贴' },
          { role: 'selectAll', label: '全选' },
        ],
      },
    ]),
  )
  window = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: '大肥鱼 QQ 部署助手',
    icon: path.join(resources, 'icon.png'),
    backgroundColor: '#f5f7f8',
    autoHideMenuBar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev
      ? process.env.ELECTRON_RENDERER_URL!
      : pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
    if (!url.startsWith(allowed)) event.preventDefault()
  })
  window.webContents.session.setPermissionRequestHandler((_web, _permission, callback) =>
    callback(false),
  )
  window.once('ready-to-show', () => window?.show())
  window.on('close', (event) => {
    if (!quitting && engine.task && ['running', 'waiting'].includes(engine.task.state)) {
      event.preventDefault()
      window?.hide()
      if (!tray) createTray()
    }
  })
  window.on('closed', () => {
    window = null
    if (!engine.task || !['running', 'waiting'].includes(engine.task.state)) app.quit()
  })
  if (isDev) await window.loadURL(process.env.ELECTRON_RENDERER_URL!)
  else await window.loadFile(path.join(__dirname, '../renderer/index.html'))
  if (app.isPackaged && process.env.QQDSH_SKIP_UPDATE_CHECK !== '1') {
    const timer = setTimeout(() => void updater.check(), 10000)
    timer.unref()
  }
}
function createTray(): void {
  const resources = app.isPackaged
    ? path.join(process.resourcesPath, 'catalog')
    : path.join(app.getAppPath(), 'resources')
  tray = new Tray(
    nativeImage.createFromPath(path.join(resources, 'icon.png')).resize({ width: 20, height: 20 }),
  )
  tray.setToolTip('大肥鱼 QQ 部署助手 · 任务仍在进行')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开部署助手', click: () => window?.show() },
      {
        label: '取消任务并退出',
        click: () => {
          engine.cancel()
          quitting = true
          setTimeout(() => app.quit(), 1500)
        },
      },
    ]),
  )
  tray.on('click', () => window?.show())
}
async function openTarget(target: OpenTarget): Promise<void> {
  const s = engine.store.settings
  if (target === 'docs') {
    await shell.openExternal('https://github.com/Derpyu520/qq-bridge')
    return
  }
  if (target === 'snow-docs') {
    await shell.openExternal('https://github.com/SnowLuma/SnowLuma/blob/main/EULA.md')
    return
  }
  if (target === 'data') {
    const error = await shell.openPath(dataRoot)
    if (error) throw new Error(error)
    return
  }
  if (target === 'qq') {
    const p = s.qqPath || engine.scanner.discovered.qq
    if (!p) throw new Error('请先指定 QQ 客户端路径')
    const error = await shell.openPath(p)
    if (error) throw new Error(error)
    return
  }
  if (target === 'harness') {
    await engine.service('harness', 'start')
    return
  }
  if (target === 'snowluma') {
    await shell.openExternal('http://127.0.0.1:5099')
    return
  }
  await shell.openExternal(`http://127.0.0.1:${s.consolePort}`)
}
app.on('before-quit', () => {
  quitting = true
})
app.on('window-all-closed', () => {
  if (!engine?.task || !['running', 'waiting'].includes(engine.task.state)) app.quit()
})
