import { localUrl, type OneBotEndpoint } from './core'
import type { Settings } from '../shared/types'

export function selectOneBotEndpoint(
  endpoints: OneBotEndpoint[],
  httpUrl: string,
): OneBotEndpoint | undefined {
  // ownerQQ is the administrator, not necessarily the gateway's bot account.
  const matches = endpoints.filter((endpoint) => endpoint.httpUrl === httpUrl)
  if (matches.length === 1) return matches[0]
  return endpoints.length === 1 ? endpoints[0] : undefined
}

export function mergeDetectedConnections(
  old: any,
  settings: Settings,
  harnessVerified: boolean,
  endpoint?: OneBotEndpoint,
): any {
  const next = structuredClone(old)
  if (harnessVerified) next.dsh = { ...next.dsh, baseUrl: localUrl(settings.dshUrl) }
  if (endpoint)
    next.snowluma = {
      ...next.snowluma,
      homeDir: settings.snowlumaPath,
      httpUrl: localUrl(endpoint.httpUrl),
      wsUrl: localUrl(endpoint.wsUrl, ['ws:', 'wss:']),
      accessToken: endpoint.httpToken,
      wsAccessToken: endpoint.wsToken,
    }
  return next
}
