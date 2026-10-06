/**
 * WP238（Luoye 10-06 Windows 真机）：一条取数路由**现在走得通哪一级**。
 *
 * 岗位页「连上这 N 个就能开工」与面板上「还没连接 Reddit」两处都问这一句：
 * 读 Reddit 已经能经接口中台（或本机只读浏览器）取到，就别再催人去连 Reddit API。
 * 判据只有一份，放在这里——两处各写一份迟早一个说缺、一个说不缺。
 *
 * - `workshop`（接口中台）：这台机器关联了 Agents 工坊账号就算通（这一级扣积分；
 *   云上某项能力临时关了是运行时那一跳的事，照实报「没取到」，不在这里预判）；
 * - `browser_readonly`：本机装了只读浏览器、而且找得到浏览器就算通（托管实例这一路本来就停用）。
 */
import type { DataSourceLevel, ReadonlyBrowserStatus } from '@agentsws/contracts'
import {
  CONNECTION_READ_ROUTES,
  connectionDirectoryEntry,
  firstUsableReadLevel,
  REDDIT_READ_ROUTE_KEY,
} from '@agentsws/contracts'
import type { DataSourceId } from '@agentsws/deck'
import { dataSourcesOfService } from '@agentsws/deck'
import type { CloudAssembly } from './cloud.js'

export function readRouteLevelOf(
  cloud: Pick<CloudAssembly, 'redditReadRoute' | 'linked'>,
  browser: { status(): ReadonlyBrowserStatus } | undefined,
): (route: string) => DataSourceLevel | undefined {
  return (route) => {
    if (route !== REDDIT_READ_ROUTE_KEY) return undefined
    return firstUsableReadLevel(cloud.redditReadRoute(), (level) => {
      if (level === 'workshop') return cloud.linked()
      if (level === 'browser_readonly')
        return browser !== undefined && browser.status().state !== 'no_browser'
      return false
    })
  }
}

/**
 * 面板那一头：哪几个数据源没连也有路取数（`social_reddit` ← `reddit` 卡 ← `reddit.read` 路由）。
 * 只认两级：接口中台、本机浏览器只读——别的级在面板上没有对应的那句话。
 */
export function readViaSources(
  levelOf: (route: string) => DataSourceLevel | undefined,
): Partial<Record<DataSourceId, 'workshop' | 'browser_readonly'>> {
  const out: Partial<Record<DataSourceId, 'workshop' | 'browser_readonly'>> = {}
  for (const [kind, { route }] of Object.entries(CONNECTION_READ_ROUTES)) {
    const level = levelOf(route)
    if (level !== 'workshop' && level !== 'browser_readonly') continue
    const service = connectionDirectoryEntry(kind)?.service ?? kind
    for (const source of dataSourcesOfService(service)) out[source] = level
  }
  return out
}
