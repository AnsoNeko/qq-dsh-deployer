import path from 'node:path'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import semver from 'semver'
import yaml from 'js-yaml'

export const exists = async (p: string): Promise<boolean> =>
  !!p &&
  fs.access(p).then(
    () => true,
    () => false,
  )
export async function json<T = any>(p: string): Promise<T | null> {
  try {
    return JSON.parse((await fs.readFile(p, 'utf8')).replace(/^\uFEFF/, ''))
  } catch (e: any) {
    if (e.code === 'ENOENT') return null
    throw new Error(`无法读取 JSON：${p}（${e.message}）`)
  }
}
export async function atomicWrite(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temp, content, { mode: 0o600 })
  try {
    await fs.rename(temp, file)
  } catch (e) {
    await fs.rm(temp, { force: true })
    throw e
  }
}
export const writeJson = (p: string, v: unknown) =>
  atomicWrite(p, JSON.stringify(v, null, 2) + '\n')
export function cleanVersion(s = ''): string | undefined {
  return s.match(/\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?/)?.[0]
}
export function newer(current?: string, latest?: string): boolean {
  return !!(semver.valid(current) && semver.valid(latest) && semver.gt(latest!, current!))
}
export function compatible(harness?: string, bridge?: string): string {
  if (!harness || !bridge) return '版本未知，待验证'
  return ['0.2.0-rc.2', '0.2.1-rc.2'].includes(harness) && bridge === '0.2.1-r1'
    ? '上游声明适配 · 本机消息往返待实测'
    : '未列入已声明适配组合，待验证'
}
export function redact(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [已隐藏]')
    .replace(
      /((?:authorization|access[_-]?token|authToken|wsToken|httpToken|consoleToken|api[_-]?key|password|passwd|secret|cookie|signingKey)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\r\n]+)/gi,
      '$1[已隐藏]',
    )
    .replace(/([?&](?:token|key|auth|password|access_token)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/(token[^\r\n]{0,12})(?:[A-Za-z0-9_-]{4,}…)/gi, '$1[已隐藏]')
}
export function redactDiagnostics(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === 'string') {
    let result = redact(value)
    for (const secret of secrets) if (secret) result = result.replaceAll(secret, '[已隐藏]')
    return result
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnostics(item, secrets))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /token|cookie|password|credential|secret|apiKey/i.test(key)
          ? '[已隐藏]'
          : redactDiagnostics(item, secrets),
      ]),
    )
  return value
}
export function localUrl(value: string, protocols = ['http:', 'https:']): string {
  const u = new URL(value)
  if (
    !protocols.includes(u.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw new Error('服务地址必须为不含凭据的本机地址')
  return u.href.replace(/\/$/, '')
}
export function assertDirectory(target: string): string {
  const p = path.resolve(target)
  if (!path.isAbsolute(target) || p === path.parse(p).root || /[\x00-\x1f]/.test(p))
    throw new Error('请选择有效的绝对目录，不能使用磁盘根目录')
  return p
}
export function safeChild(root: string, relative: string): string {
  const dest = path.resolve(root, relative)
  const rel = path.relative(path.resolve(root), dest)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('路径超出目标目录')
  return dest
}
export const parseQQs = (s: string) =>
  [...new Set(s.split(/[\s,，;；]+/).filter(Boolean))].map((v) => {
    if (!/^\d{5,15}$/.test(v)) throw new Error(`QQ 号或群号格式不正确：${v}`)
    return v
  })
export function mergeBridgeConfig(
  old: any,
  values: {
    dshUrl: string
    httpUrl: string
    wsUrl: string
    ownerQQ: string
    groups: string
    friends: string
    model: string
    consolePort: number
    snowlumaPath: string
  },
  httpToken?: string,
  wsToken?: string,
): any {
  const result = structuredClone(old ?? {})
  result.dsh = {
    ...result.dsh,
    baseUrl: localUrl(values.dshUrl),
    model: values.model,
    authToken: '',
    allowRemote: false,
  }
  result.snowluma = {
    ...result.snowluma,
    httpUrl: localUrl(values.httpUrl),
    wsUrl: localUrl(values.wsUrl, ['ws:', 'wss:']),
    homeDir: values.snowlumaPath,
    followDiscoveredEndpoint: false,
    ...(httpToken !== undefined ? { accessToken: httpToken } : {}),
    ...(wsToken !== undefined ? { wsAccessToken: wsToken } : {}),
  }
  result.ownerQQ = values.ownerQQ
  result.allow = {
    ...result.allow,
    groups: parseQQs(values.groups),
    private: parseQQs(values.friends),
  }
  result.allowAllWhenEmpty = false
  result.consolePort = values.consolePort
  result.agentPreset ||= 'qq-chat'
  result.socialV2 = {
    ...result.socialV2,
    agentPreset: result.socialV2?.agentPreset || 'qq-chat-v2',
  }
  return result
}
export function mergeMcp(original: string, bridge: string, node: string): string {
  const doc: any = yaml.load(original.replace(/^\uFEFF/, '')) ?? []
  if (!Array.isArray(doc)) throw new Error('Harness patch 必须是 YAML 操作数组，已停止修改')
  const ids = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe']
  const next = doc
    .map((operation: any) => {
      if (!operation || !Array.isArray(operation.insert)) return operation
      return {
        ...operation,
        insert: operation.insert.filter((entry: any) => !ids.includes(entry?.id)),
      }
    })
    .filter(
      (operation: any) =>
        !Array.isArray(operation?.insert) ||
        operation.insert.length ||
        Object.keys(operation).length > 1,
    )
  const names = ['snowluma', 'snowluma-host', 'web-search-safe']
  const scripts = ['mcp-snowluma-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js']
  next.push({
    insert: ids.map((id, i) => ({
      id,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        serverName: names[i],
        transport: 'stdio',
        command: node,
        args: [path.join(bridge, 'src', scripts[i])],
        ...(i === 0 ? { toolCallTimeoutMs: 725000 } : {}),
      },
    })),
  })
  return yaml.dump(next, { lineWidth: -1, noRefs: true })
}
export interface OneBotEndpoint {
  account: string
  file: string
  httpUrl: string
  wsUrl: string
  httpToken: string
  wsToken: string
}
export async function readOneBot(home: string): Promise<OneBotEndpoint[]> {
  const dir = path.join(home, 'config')
  if (!(await exists(dir))) return []
  const files = (await fs.readdir(dir)).filter((f) => /^onebot(?:_\d+)?\.json$/i.test(f)).sort()
  const result: OneBotEndpoint[] = []
  for (const file of files) {
    const config = await json(path.join(dir, file))
    const nets = config?.networks
    const http = nets?.httpServers?.find((v: any) => v.enabled !== false)
    const ws = nets?.wsServers?.find((v: any) => v.enabled !== false)
    if (!http || !ws) continue
    const host = (h: string) => (['0.0.0.0', '::', ''].includes(h || '') ? '127.0.0.1' : h)
    try {
      result.push({
        account: /_(\d+)/.exec(file)?.[1] || '',
        file: path.join(dir, file),
        httpUrl: localUrl(`http://${host(http.host)}:${http.port}`),
        wsUrl: localUrl(`ws://${host(ws.host)}:${ws.port}`, ['ws:']),
        httpToken: http.accessToken || '',
        wsToken: ws.accessToken || '',
      })
    } catch {
      /* remote listeners are never adopted */
    }
  }
  return result
}
