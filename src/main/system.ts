import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { exists } from './core'

export async function command(
  exe: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    signal?: AbortSignal
    timeout?: number
    onLine?: (s: string) => void
    onSpawn?: (p: ChildProcess) => void
    windowsVerbatimArguments?: boolean
  } = {},
): Promise<string> {
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
      windowsVerbatimArguments: options.windowsVerbatimArguments,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let finished = false
    const stop = () => {
      if (child.pid)
        spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
      else child.kill()
    }
    const timer = setTimeout(() => {
      stop()
      finish(new Error(`操作超时：${path.basename(exe)}`))
    }, options.timeout ?? 30000)
    const abort = () => {
      stop()
      finish(new Error('操作已取消'))
    }
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abort)
      error ? reject(error) : resolve(output.trim())
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (b: Buffer) => {
        const s = b.toString('utf8')
        output = (output + s).slice(-300000)
        options.onLine?.(s.trim())
      })
    child.on('error', (e) => finish(e))
    child.on('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`${path.basename(exe)} 返回 ${code}：${output.slice(-3000)}`),
      ),
    )
    options.onSpawn?.(child)
    if (options.signal?.aborted) abort()
  })
}
export function powershell(
  script: string,
  env: NodeJS.ProcessEnv = {},
  timeout = 30000,
): Promise<string> {
  return command(
    path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    ),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); $ErrorActionPreference="Stop"; ' +
        script,
    ],
    {
      timeout,
      env: {
        ...process.env,
        PSModulePath: path.join(
          process.env.SystemRoot || 'C:\\Windows',
          'System32/WindowsPowerShell/v1.0/Modules',
        ),
        ...env,
      },
    },
  )
}
export async function where(name: string): Promise<string[]> {
  try {
    return (await command('where.exe', [name], { timeout: 5000 })).split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}
export interface ProcessInfo {
  pid: number
  parent: number
  path: string
  name: string
}
export async function processes(): Promise<ProcessInfo[]> {
  const raw = await powershell(
    'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "(qq|harness|deepseek|snowluma|node|electron)" } | ForEach-Object { @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; path=[string]$_.ExecutablePath; name=[string]$_.Name} } | ConvertTo-Json -Compress',
    {},
    15000,
  )
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}
export async function inventory(): Promise<{ name: string; path: string; version: string }[]> {
  const raw = await powershell(
    '$roots=@("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*","HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"); Get-ItemProperty -Path $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match "(Harness|DeepSeek|QQ|SnowLuma|Node.js|Git)" } | ForEach-Object { @{name=[string]$_.DisplayName; path=[string]$_.InstallLocation; version=[string]$_.DisplayVersion} } | ConvertTo-Json -Compress',
  )
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}
export async function fileVersion(file: string): Promise<string | undefined> {
  try {
    return (
      (
        await powershell(
          '(Get-Item -LiteralPath $env:QQDSH_FILE).VersionInfo.ProductVersion',
          { QQDSH_FILE: file },
          10000,
        )
      ).trim() || undefined
    )
  } catch {
    return undefined
  }
}
export async function harnessPorts(file: string, all: ProcessInfo[]): Promise<number[]> {
  const pids = new Set(
    all.filter((p) => p.path && p.path.toLowerCase() === file.toLowerCase()).map((p) => p.pid),
  )
  for (let i = 0; i < 5; i++) for (const p of all) if (pids.has(p.parent)) pids.add(p.pid)
  if (!pids.size) return []
  const raw = await powershell(
    '$ids=$env:QQDSH_PIDS.Split(",") | ForEach-Object { [int]$_ }; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ids -contains $_.OwningProcess -and $_.LocalAddress -in @("127.0.0.1","::1") } | Select-Object -ExpandProperty LocalPort -Unique | ConvertTo-Json -Compress',
    { QQDSH_PIDS: [...pids].join(',') },
    12000,
  )
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : [parsed]
}
export async function desktopCli(harness: string): Promise<string | null> {
  const root = path.dirname(harness)
  for (const p of [
    path.join(root, 'resources/runtime/cli/bin/dsh.cmd'),
    path.join(root, 'resources/runtime/cli/dsh.cmd'),
  ])
    if (await exists(p)) return p
  return null
}
export async function runDesktopCli(
  cli: string,
  pluginPaths: string[],
  options: Parameters<typeof command>[2] = {},
): Promise<string> {
  const all = [cli, ...pluginPaths]
  if (all.some((p) => /["\r\n\0]/.test(p))) throw new Error('命令路径包含无效字符')
  const env = { ...process.env, ...options.env, QQDSH_CLI: cli } as NodeJS.ProcessEnv
  pluginPaths.forEach((p, i) => {
    env[`QQDSH_LINK${i}`] = `link:${p.replace(/\\/g, '/')}`
  })
  return command(
    process.env.ComSpec || 'cmd.exe',
    [
      '/d',
      '/v:off',
      '/s',
      '/c',
      `""%QQDSH_CLI%" plugin --profile desktop add ${pluginPaths.map((_, i) => `"%QQDSH_LINK${i}%"`).join(' ')}"`,
    ],
    { ...options, env, windowsVerbatimArguments: true },
  )
}
export async function commitDesktopPatch(
  cli: string,
  node: string,
  helper: string,
  payload: string,
  options: Parameters<typeof command>[2] = {},
): Promise<string> {
  if ([cli, node, helper, payload].some((v) => /["\r\n\0]/.test(v)))
    throw new Error('命令路径包含无效字符')
  return command(
    process.env.ComSpec || 'cmd.exe',
    [
      '/d',
      '/v:off',
      '/s',
      '/c',
      '""%QQDSH_CLI%" plugin --profile desktop exec "%QQDSH_NODE%" "%QQDSH_HELPER%" "%QQDSH_PAYLOAD%""',
    ],
    {
      ...options,
      windowsVerbatimArguments: true,
      env: {
        ...process.env,
        ...options.env,
        QQDSH_CLI: cli,
        QQDSH_NODE: node,
        QQDSH_HELPER: helper,
        QQDSH_PAYLOAD: payload,
      },
    },
  )
}
export async function findFile(root: string, names: string[], depth = 2): Promise<string | null> {
  if (!root || !(await exists(root))) return null
  for (const name of names) {
    const p = path.join(root, name)
    if (await exists(p)) return p
  }
  if (depth <= 0) return null
  for (const item of await fs.readdir(root, { withFileTypes: true }))
    if (
      item.isDirectory() &&
      !item.isSymbolicLink() &&
      !['node_modules', 'resources', 'config', 'logs', 'state'].includes(item.name)
    ) {
      const found = await findFile(path.join(root, item.name), names, depth - 1)
      if (found) return found
    }
  return null
}
