import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { atomicWrite, exists, json, safeChild, writeJson } from './core'
import { sha256 } from './network'
import type { BackupInfo, Settings } from '../shared/types'

interface Backup {
  id: string
  createdAt: string
  label: string
  files: { target: string; copy: string; existed: boolean; afterHash?: string }[]
}
export class Store {
  private knownBackupTargets = new Set<string>()
  settings!: Settings
  secrets: { httpToken?: string; wsToken?: string } = {}
  constructor(
    readonly root: string,
    private cipher: { encrypt(s: string): Buffer; decrypt(b: Buffer): string },
  ) {}
  async init(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true })
    this.settings = {
      installRoot: path.join(this.root, 'components'),
      dshHome: process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
      nodePath: '',
      harnessPath: '',
      snowlumaPath: '',
      bridgePath: '',
      qqPath: '',
      pwshPath: '',
      registerPwshPath: true,
      dshUrl: 'http://127.0.0.1:3080',
      httpUrl: 'http://127.0.0.1:3000',
      wsUrl: 'ws://127.0.0.1:3001',
      consolePort: 3100,
      ownerQQ: '',
      groups: '',
      friends: '',
      model: 'deepseek-flash',
      proxy: '',
      snowlumaAuthorized: false,
      firstRun: true,
      ...(await json(path.join(this.root, 'settings.json'))),
    }
    const secrets = await fs.readFile(path.join(this.root, 'secrets.bin')).catch(() => null)
    this.settings.pwshPath ||= ''
    this.settings.registerPwshPath ??= true
    if (secrets)
      this.secrets = JSON.parse(
        this.cipher.decrypt(Buffer.from(secrets.toString('utf8'), 'base64')),
      )
  }
  async save(settings: Settings, secrets = this.secrets): Promise<void> {
    // Encrypt first; if OS protection is unavailable do not silently store plaintext.
    const encrypted = this.cipher.encrypt(JSON.stringify(secrets))
    await atomicWrite(path.join(this.root, 'secrets.bin'), encrypted.toString('base64'))
    // The disk representation is base64; init normalizes it before decrypting.
    await writeJson(path.join(this.root, 'settings.json'), settings)
    this.settings = settings
    this.secrets = secrets
  }
  async createBackup(label: string, files: string[]): Promise<Backup> {
    const id = crypto.randomUUID()
    const folder = path.join(this.root, 'backups', id)
    await fs.mkdir(folder, { recursive: true })
    const b: Backup = { id, label, createdAt: new Date().toISOString(), files: [] }
    for (const [i, target] of [...new Set(files.map((f) => path.resolve(f)))].entries()) {
      this.knownBackupTargets.add(path.resolve(target).toLowerCase())
      const present = await exists(target)
      const copy = `${i}.bak`
      if (present) await fs.copyFile(target, path.join(folder, copy))
      b.files.push({ target, copy, existed: present })
    }
    await writeJson(path.join(folder, 'manifest.json'), b)
    return b
  }
  async finishBackup(b: Backup): Promise<void> {
    for (const item of b.files)
      item.afterHash = (await exists(item.target)) ? await sha256(item.target) : 'missing'
    await writeJson(path.join(this.root, 'backups', b.id, 'manifest.json'), b)
  }
  async backups(): Promise<BackupInfo[]> {
    const dir = path.join(this.root, 'backups')
    if (!(await exists(dir))) return []
    const found = await Promise.all(
      (await fs.readdir(dir))
        .filter((n) => /^[a-f0-9-]{36}$/.test(n))
        .map((n) => json<Backup>(path.join(dir, n, 'manifest.json'))),
    )
    return found
      .filter((b): b is Backup => !!b)
      .map(({ id, createdAt, label }) => ({ id, createdAt, label }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async restore(id: string, force = false): Promise<void> {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('备份编号无效')
    const folder = safeChild(path.join(this.root, 'backups'), id)
    const b = await json<Backup>(path.join(folder, 'manifest.json'))
    if (!b) throw new Error('备份不存在')
    for (const file of b.files) {
      if (!this.allowedBackupTarget(file.target))
        throw new Error('备份目标不属于当前配置范围，拒绝恢复')
      const current = (await exists(file.target)) ? await sha256(file.target) : 'missing'
      if (!force && file.afterHash && current !== file.afterHash)
        throw new Error('备份后文件已被修改，保留当前修改；请手动核对备份')
      if (file.existed && !(await exists(safeChild(folder, file.copy))))
        throw new Error('备份内容不完整')
    }
    if (!force)
      await this.createBackup(
        '恢复前快照',
        b.files.map((f) => f.target),
      )
    for (const file of b.files) {
      if (file.existed)
        await atomicWrite(file.target, await fs.readFile(safeChild(folder, file.copy), 'utf8'))
      else await fs.rm(file.target, { force: true })
    }
  }
  allowedBackupTarget(target: string): boolean {
    if (this.knownBackupTargets.has(path.resolve(target).toLowerCase())) return true
    const s = this.settings
    const allowed = [
      path.join(s.dshHome, 'profiles/desktop/cordis.patch.yml'),
      path.join(s.dshHome, 'profiles/desktop/package.json'),
      path.join(s.dshHome, 'profiles/desktop/pnpm-lock.yaml'),
      path.join(s.dshHome, 'profiles/desktop/pnpm-workspace.yaml'),
    ]
    if (s.bridgePath)
      allowed.push(
        path.join(s.bridgePath, 'config.json'),
        path.join(s.bridgePath, 'state/mode.json'),
      )
    return allowed.some((p) => path.resolve(p).toLowerCase() === path.resolve(target).toLowerCase())
  }
}
