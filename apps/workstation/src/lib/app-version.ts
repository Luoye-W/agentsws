/**
 * WP426（Luoye 10-19「在哪里能看到我装的版本」）：工坊现在是哪个版本。
 *
 * - 桌面壳里：壳桥上的 `version`（安装包版本，0.2.1-beta.3 这种）；
 * - 普通浏览器里（没有壳）：服务端 `/v1/health` 报的版本（桌面壳起服务进程时把安装包版本交给它）。
 *
 * 不写死任何一个版本号。
 */
import { useQuery } from '@tanstack/react-query'
import { getServerVersion } from './api'

/** 桌面壳桥上的版本（没有壳 / 旧壳没给 = undefined）。 */
export function desktopVersion(): string | undefined {
  const w = globalThis.window as unknown as { agentsws?: { version?: unknown } } | undefined
  const v = w?.agentsws?.version
  return typeof v === 'string' && v !== '' ? v : undefined
}

export function useAppVersion(): { version: string | undefined; source: 'desktop' | 'server' } {
  const desktop = desktopVersion()
  const server = useQuery({
    queryKey: ['server-version'],
    queryFn: getServerVersion,
    enabled: desktop === undefined,
    retry: false,
    staleTime: 5 * 60_000,
  })
  return desktop === undefined
    ? { version: server.data, source: 'server' }
    : { version: desktop, source: 'desktop' }
}
