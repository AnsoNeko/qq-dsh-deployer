import { app, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import path from 'node:path'
import semver from 'semver'
import { download, remoteJson } from './network'
import { cleanVersion } from './core'
import { releaseRepository } from '../shared/projects'
import type { AppUpdate } from '../shared/types'

export class AppUpdates {
  status: AppUpdate
  private busy = false
  private portableFile?: string
  constructor(
    private root: string,
    private change: (s: AppUpdate) => void,
    private log: (s: string) => void,
  ) {
    this.status = {
      state: 'idle',
      current: app.getVersion(),
      mode: !app.isPackaged
        ? 'development'
        : process.env.PORTABLE_EXECUTABLE_FILE
          ? 'portable'
          : 'installer',
      detail: '通过 GitHub 最新正式 Release 检查软件更新',
    }
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.allowDowngrade = false
    autoUpdater.disableWebInstaller = true
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: releaseRepository.owner,
      repo: releaseRepository.repo,
      private: false,
    })
    autoUpdater.on('checking-for-update', () =>
      this.set({ state: 'checking', detail: '正在查询 GitHub 最新正式 Release…' }),
    )
    autoUpdater.on('update-not-available', (info) =>
      this.set({ state: 'current', latest: info.version, detail: '当前已是最新正式版本' }),
    )
    autoUpdater.on('update-available', (info) =>
      this.set({
        state: 'downloading',
        latest: info.version,
        percent: 0,
        detail: '发现新版，正在从 GitHub 自动下载…',
      }),
    )
    autoUpdater.on('download-progress', (p) =>
      this.set({
        state: 'downloading',
        percent: Math.round(p.percent),
        detail: '正在下载并校验更新包…',
      }),
    )
    autoUpdater.on('update-downloaded', (info) =>
      this.set({
        state: 'downloaded',
        latest: info.version,
        percent: 100,
        detail: '新版已下载并通过摘要校验，可以重启安装',
      }),
    )
    autoUpdater.on('error', (error) =>
      this.set({ state: 'error', detail: `检查 / 下载更新失败：${error.message}` }),
    )
  }
  private set(patch: Partial<AppUpdate>): void {
    this.status = { ...this.status, ...patch }
    this.change(this.status)
  }
  async check(): Promise<void> {
    if (this.busy || this.status.state === 'downloading') return
    if (!app.isPackaged) {
      this.set({ state: 'idle', detail: '开发模式不下载应用更新；请使用安装版或便携版验证更新' })
      return
    }
    this.busy = true
    try {
      this.set({ state: 'checking', detail: '正在查询 GitHub 最新正式 Release…' })
      if (this.status.mode === 'installer') {
        await autoUpdater.checkForUpdates()
        return
      }
      const latest = await remoteJson(
        `https://api.github.com/repos/${releaseRepository.owner}/${releaseRepository.repo}/releases/latest`,
      )
      const version = cleanVersion(latest.tag_name)
      if (latest.draft || latest.prerelease || !version || !semver.valid(version))
        throw new Error('Release 版本信息无效')
      if (!semver.gt(version, app.getVersion())) {
        this.set({ state: 'current', latest: version, detail: '当前已是最新正式版本' })
        return
      }
      const asset = latest.assets?.find(
        (a: any) => a.name === `QQDshDeployer-${version}-x64-Portable.exe`,
      )
      const prefix = `https://github.com/${releaseRepository.owner}/${releaseRepository.repo}/releases/download/`
      if (
        !asset?.browser_download_url?.startsWith(prefix) ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')
      )
        throw new Error('GitHub Release 缺少带 SHA-256 摘要的便携版附件')
      this.set({
        state: 'downloading',
        latest: version,
        percent: 0,
        detail: '正在自动下载新版便携包…',
      })
      const file = path.join(this.root, 'updates', asset.name)
      await download(
        asset.browser_download_url,
        file,
        asset.digest.slice(7),
        '',
        AbortSignal.timeout(1800000),
        (percent) => this.set({ percent }),
      )
      this.portableFile = file
      this.set({
        state: 'downloaded',
        percent: 100,
        detail: '新版便携包已下载并校验；打开文件夹，退出本程序后替换原 EXE',
      })
    } catch (error: any) {
      this.set({ state: 'error', detail: error.message })
      this.log(`应用更新：${error.message}`)
    } finally {
      this.busy = false
    }
  }
  async install(): Promise<void> {
    if (this.status.state !== 'downloaded') throw new Error('尚无已校验完成的更新包')
    if (this.status.mode === 'portable' && this.portableFile) {
      shell.showItemInFolder(this.portableFile)
      return
    }
    if (this.status.mode !== 'installer') throw new Error('当前运行方式不支持重启安装')
    autoUpdater.quitAndInstall(false, true)
  }
}
