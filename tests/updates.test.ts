import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
const state = vi.hoisted(() => ({ packaged: true, opened: '', checked: 0, installed: 0 }))
vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return state.packaged
    },
    getVersion: () => '0.1.0',
  },
  shell: { showItemInFolder: (p: string) => (state.opened = p) },
}))
vi.mock('electron-updater', () => {
  const updater = new EventEmitter() as any
  updater.setFeedURL = vi.fn()
  updater.checkForUpdates = async () => {
    state.checked++
    return null
  }
  updater.quitAndInstall = () => state.installed++
  return { autoUpdater: updater }
})
vi.mock('../src/main/network', () => ({ remoteJson: vi.fn(), download: vi.fn() }))
import { autoUpdater } from 'electron-updater'
import { remoteJson, download } from '../src/main/network'
import { AppUpdates } from '../src/main/updates'
beforeEach(() => {
  state.packaged = true
  state.opened = ''
  state.checked = 0
  state.installed = 0
  autoUpdater.removeAllListeners()
  delete process.env.PORTABLE_EXECUTABLE_FILE
  vi.mocked(remoteJson).mockReset()
  vi.mocked(download).mockReset()
})
describe('GitHub app update policies', () => {
  it('does not mutate development installations', async () => {
    state.packaged = false
    const manager = new AppUpdates(
      'cache',
      () => {},
      () => {},
    )
    await manager.check()
    expect(state.checked).toBe(0)
    expect(manager.status.mode).toBe('development')
  })
  it('configures stable GitHub NSIS auto-download and only installs after an explicit request', async () => {
    const manager = new AppUpdates(
      'cache',
      () => {},
      () => {},
    )
    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'AnsoNeko', repo: 'qq-dsh-deployer', provider: 'github' }),
    )
    expect(autoUpdater.autoDownload).toBe(true)
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false)
    await manager.check()
    expect(state.checked).toBe(1)
    await expect(manager.install()).rejects.toThrow('尚无')
    const info = {
      version: '0.2.0',
      files: [],
      path: 'setup.exe',
      sha512: 'fixture',
      releaseDate: new Date().toISOString(),
    }
    autoUpdater.emit('update-available', info)
    expect(manager.status.state).toBe('downloading')
    autoUpdater.emit('download-progress', {
      percent: 44.5,
      total: 100,
      transferred: 44.5,
      delta: 44.5,
      bytesPerSecond: 100,
    })
    expect(manager.status.percent).toBe(45)
    autoUpdater.emit('update-downloaded', { ...info, downloadedFile: 'setup.exe' })
    expect(state.installed).toBe(0)
    await manager.install()
    expect(state.installed).toBe(1)
  })
  it('automatically downloads and verifies the matching portable release asset', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'tool.exe'
    vi.mocked(remoteJson).mockResolvedValue({
      tag_name: 'v0.2.0',
      assets: [
        {
          name: 'QQDshDeployer-0.2.0-x64-Portable.exe',
          browser_download_url:
            'https://github.com/AnsoNeko/qq-dsh-deployer/releases/download/v0.2.0/portable.exe',
          digest: 'sha256:' + 'a'.repeat(64),
        },
      ],
    })
    vi.mocked(download).mockResolvedValue('a'.repeat(64))
    const manager = new AppUpdates(
      'cache',
      () => {},
      () => {},
    )
    await manager.check()
    expect(download).toHaveBeenCalledWith(
      expect.stringContaining('AnsoNeko/qq-dsh-deployer'),
      expect.stringContaining('Portable.exe'),
      'a'.repeat(64),
      '',
      expect.anything(),
      expect.any(Function),
    )
    expect(manager.status.state).toBe('downloaded')
    await manager.install()
    expect(state.opened).toContain('Portable.exe')
    expect(state.installed).toBe(0)
  })
  it('rejects a portable update without a trustworthy artifact digest', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'tool.exe'
    vi.mocked(remoteJson).mockResolvedValue({
      tag_name: 'v0.2.0',
      assets: [
        {
          name: 'QQDshDeployer-0.2.0-x64-Portable.exe',
          browser_download_url: 'https://attacker.example/portable.exe',
        },
      ],
    })
    const manager = new AppUpdates(
      'cache',
      () => {},
      () => {},
    )
    await manager.check()
    expect(manager.status.state).toBe('error')
    expect(download).not.toHaveBeenCalled()
  })
  it('does not downgrade or install prereleases', async () => {
    process.env.PORTABLE_EXECUTABLE_FILE = 'tool.exe'
    vi.mocked(remoteJson).mockResolvedValue({ tag_name: 'v0.0.9', assets: [] })
    const manager = new AppUpdates(
      'cache',
      () => {},
      () => {},
    )
    await manager.check()
    expect(manager.status.state).toBe('current')
    vi.mocked(remoteJson).mockResolvedValue({
      tag_name: 'v0.3.0-rc.1',
      prerelease: true,
      assets: [],
    })
    await manager.check()
    expect(manager.status.state).toBe('error')
    expect(download).not.toHaveBeenCalled()
  })
})
