import fs from 'node:fs/promises'
import path from 'node:path'
import { json } from './core'
import type { BridgeLogin } from '../shared/types'

export const validConsoleToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value)

export async function readBridgeLogin(home: string, fallbackPort: number): Promise<BridgeLogin> {
  if (!home) return { state: 'waiting', detail: '请先安装或选择 QQ Bridge 目录。' }
  try {
    const config = await json(path.join(home, 'config.json'))
    const port = config?.consolePort ?? fallbackPort
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      return { state: 'unavailable', detail: 'QQ Bridge 控制台端口无效，请检查连接配置。' }
    const configured = typeof config?.consoleToken === 'string' ? config.consoleToken.trim() : ''
    const token = validConsoleToken(configured)
      ? configured
      : (await fs.readFile(path.join(home, 'state/console-token'), 'utf8').catch(() => '')).trim()
    if (!validConsoleToken(token))
      return { state: 'waiting', detail: '等待 QQ Bridge 首次启动生成控制台访问令牌。' }
    return {
      state: 'ready',
      token,
      consoleUrl: `http://127.0.0.1:${port}`,
      detail: '通过助手启动或打开控制台会自动带入此令牌，也可复制后手动登录。',
    }
  } catch {
    return {
      state: 'unavailable',
      detail: '无法读取 QQ Bridge 控制台令牌，请检查安装目录和文件权限。',
    }
  }
}
