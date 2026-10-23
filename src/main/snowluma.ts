import fs from 'node:fs/promises'
import path from 'node:path'
import { scrypt, timingSafeEqual } from 'node:crypto'
import { stripVTControlCharacters } from 'node:util'
import type { SnowLumaLogin } from '../shared/types'

async function readTail(file: string, limit: number): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(Math.min(size, limit))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, Math.max(0, size - limit))
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

// v2.1.1 prints this credential only to stdout; config/webui.json stores a salted hash.
// Read the existing local log so detached services keep logging after the assistant exits.
// Never return an old password after rotation or a password from another installation.
export async function readSnowLumaLogin(home: string, logFile: string): Promise<SnowLumaLogin> {
  if (!home) return { state: 'unavailable', detail: '请先安装 SnowLuma 或指定已有安装目录。' }
  try {
    const configFile = path.join(home, 'config', 'webui.json')
    const config = JSON.parse((await readTail(configFile, 65536)).replace(/^\uFEFF/, ''))
    if (config.mustChangePassword === false)
      return { state: 'changed', detail: '已设置后台密码，请使用你在 SnowLuma 中设置的密码登录。' }
    if (
      config.mustChangePassword !== true ||
      typeof config.passwordHash !== 'string' ||
      !/^[a-f0-9]{128}$/i.test(config.passwordHash) ||
      typeof config.passwordSalt !== 'string' ||
      !/^[a-f0-9]{32}$/i.test(config.passwordSalt)
    )
      return { state: 'unavailable', detail: '无法识别 SnowLuma 后台凭据配置，请检查安装目录。' }

    const output = stripVTControlCharacters(await readTail(logFile, 256 * 1024))
    const matches = [
      ...output.matchAll(/initial credentials: user=admin password=([a-f0-9]{16})(?=\s|$)/gi),
    ]
    const password = matches.at(-1)?.[1]
    if (password) {
      const hash = await new Promise<Buffer>((resolve, reject) =>
        scrypt(
          password,
          Buffer.from(config.passwordSalt, 'hex'),
          64,
          { N: 16384, r: 8, p: 1 },
          (error, key) => (error ? reject(error) : resolve(key)),
        ),
      )
      if (timingSafeEqual(hash, Buffer.from(config.passwordHash, 'hex')))
        return {
          state: 'ready',
          username: 'admin',
          password,
          detail: '复制初始密码登录后台，再按提示设置新密码、完成协议确认和 QQ 登录。',
        }
    }
    return {
      state: 'waiting',
      detail: '尚未读取到有效的初始密码。请通过助手启动 SnowLuma；若仍未改密，重启后会生成新密码。',
    }
  } catch (error: any) {
    return {
      state: error.code === 'ENOENT' ? 'waiting' : 'unavailable',
      detail:
        error.code === 'ENOENT'
          ? '等待 SnowLuma 生成初始密码，请先通过助手启动网关。生成后会自动显示在这里。'
          : '暂时无法读取后台凭据，请检查 SnowLuma 目录和本机日志的读取权限后刷新。',
    }
  }
}
