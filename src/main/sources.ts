import semver from 'semver'
import { cleanVersion } from './core'
import { download, remoteJson, remoteText } from './network'
import { powershell } from './system'

export interface ComponentSource {
  version: string
  url: string
  sha256: string
  publisher?: string
  signerThumbprint?: string
}

async function verifyHarness(file: string, source: ComponentSource): Promise<string> {
  const signature = JSON.parse(
    await powershell(
      '$f=Get-Item -LiteralPath $env:QQDSH_FILE; $s=Get-AuthenticodeSignature -LiteralPath $env:QQDSH_FILE; @{status=[string]$s.Status; publisher=$s.SignerCertificate.Subject; thumbprint=$s.SignerCertificate.Thumbprint; version=$f.VersionInfo.ProductVersion} | ConvertTo-Json -Compress',
      { QQDSH_FILE: file },
    ),
  )
  const knownSigner =
    (source.signerThumbprint &&
      signature.thumbprint?.toUpperCase() === source.signerThumbprint.toUpperCase()) ||
    (source.publisher && signature.publisher === source.publisher)
  if (signature.status !== 'Valid' || !knownSigner)
    throw new Error('Harness 官方签名验证失败，安装程序未启动')
  const version = cleanVersion(signature.version)
  if (!version || !semver.valid(version) || !semver.valid(source.version))
    throw new Error('Harness 安装包版本无法确认，安装程序未启动')
  if (semver.lt(version, source.version))
    throw new Error('Harness 官方安装包版本低于内置版本，安装程序未启动')
  return version
}

async function officialDigest(
  id: string,
  source: ComponentSource,
  proxy: string,
  signal: AbortSignal,
): Promise<string> {
  const url = new URL(source.url)
  if (id === 'node' && url.origin === 'https://nodejs.org') {
    const match = url.pathname.match(/^\/dist\/(v[^/]+)\/([^/]+)$/)
    if (match) {
      const sums = await remoteText(
        `https://nodejs.org/dist/${match[1]}/SHASUMS256.txt`,
        proxy,
        signal,
      )
      for (const line of sums.split(/\r?\n/)) {
        const entry = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i)
        if (entry && entry[2] === match[2]) return entry[1].toLowerCase()
      }
    }
  }
  const repositories: Record<string, string> = {
    powershell: 'PowerShell/PowerShell',
    snowluma: 'SnowLuma/SnowLuma',
  }
  const match = url.pathname.match(/^\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/([^/]+)$/)
  if (url.origin === 'https://github.com' && match && match[1] === repositories[id]) {
    const release = await remoteJson(
      `https://api.github.com/repos/${match[1]}/releases/tags/${match[2]}`,
      proxy,
      signal,
    )
    const asset = release.assets?.find(
      (item: any) => item.browser_download_url === source.url && item.state === 'uploaded',
    )
    if (
      release.tag_name === decodeURIComponent(match[2]) &&
      !release.draft &&
      /^sha256:[a-f0-9]{64}$/i.test(asset?.digest || '')
    )
      return asset.digest.slice(7).toLowerCase()
  }
  throw new Error('未取得对应文件的官方 SHA-256，请更新部署助手或稍后重试')
}

export async function downloadComponent(
  id: string,
  source: ComponentSource,
  dest: string,
  proxy: string,
  signal: AbortSignal,
  progress: (n: number) => void,
  log: (message: string) => void,
): Promise<ComponentSource> {
  let harnessVersion: string | undefined
  const sha256 = await download(source.url, dest, source.sha256, proxy, signal, progress, {
    fresh: id === 'harness',
    verifyChanged: async (file, actualHash) => {
      log(`${id} 下载内容与内置摘要不同，正在核验官方更新…`)
      try {
        if (
          id === 'harness' &&
          source.url === 'https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe'
        ) {
          harnessVersion = await verifyHarness(file, source)
        } else {
          const expected = await officialDigest(id, source, proxy, signal)
          if (actualHash !== expected)
            throw new Error('下载文件与官方当前 SHA-256 不一致，可能下载损坏，请重试')
        }
      } catch (error) {
        signal.throwIfAborted()
        throw new Error(
          `组件更新验证失败，文件未执行：${error instanceof Error ? error.message : String(error)}`,
        )
      }
      log(`${id} 已通过官方更新验证，继续安装；SHA-256：${actualHash}`)
    },
  })
  if (id === 'harness') {
    harnessVersion ??= await verifyHarness(dest, source)
    signal.throwIfAborted()
    log(`Harness 安装包签名有效，实际版本：${harnessVersion}；兼容性以环境检测结果为准`)
  }
  return { ...source, sha256, version: harnessVersion || source.version }
}
