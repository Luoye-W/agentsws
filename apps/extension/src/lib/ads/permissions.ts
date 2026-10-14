/**
 * 两家广告后台的**可选权限**（决策 551 / docs/101 §1.4）：装插件时不要，用户点「连接」时才弹窗申请；
 * 老用户升级不会弹「新权限」警告。下载（`downloads`）也是可选的，跟着一起申请。
 *
 * `chrome.permissions` 注入进来（测试塞假的）。`request` 只能在用户点按钮的那一刻调（设置页里），
 * service worker 里调会被浏览器拒。
 */

import { type ActionPlatform, ADS_HOST_PERMISSIONS } from '@agentsws/browser-action'

export const ADS_PLATFORMS: readonly ActionPlatform[] = ['google_ads', 'meta_ads']

export const ADS_PLATFORM_LABEL: Record<ActionPlatform, string> = {
  google_ads: 'Google 广告',
  meta_ads: 'Meta 广告',
}

export interface PermissionsLike {
  contains(p: chrome.permissions.Permissions): Promise<boolean>
  request(p: chrome.permissions.Permissions): Promise<boolean>
  remove(p: chrome.permissions.Permissions): Promise<boolean>
}

const want = (platform: ActionPlatform): chrome.permissions.Permissions => ({
  origins: [...ADS_HOST_PERMISSIONS[platform]],
  permissions: ['downloads'],
})

/** 这家连上了没有（站点权限都在才算）。 */
export async function adsConnected(
  perms: PermissionsLike,
  platform: ActionPlatform,
): Promise<boolean> {
  return perms.contains({ origins: [...ADS_HOST_PERMISSIONS[platform]] })
}

/** 已经连上的那几家（领活时只报这几家）。 */
export async function connectedPlatforms(perms: PermissionsLike): Promise<ActionPlatform[]> {
  const out: ActionPlatform[] = []
  for (const p of ADS_PLATFORMS) if (await adsConnected(perms, p)) out.push(p)
  return out
}

/** 点「连接」：申请这家的站点权限 + 下载。用户在弹窗里点了拒绝就回 false。 */
export function requestAds(perms: PermissionsLike, platform: ActionPlatform): Promise<boolean> {
  return perms.request(want(platform))
}

/** 点「断开」：把这家的站点权限还回去（下载权限另一家还要用就留着）。 */
export async function removeAds(perms: PermissionsLike, platform: ActionPlatform): Promise<void> {
  await perms.remove({ origins: [...ADS_HOST_PERMISSIONS[platform]] })
  const others = ADS_PLATFORMS.filter((p) => p !== platform)
  let stillUsed = false
  for (const p of others) if (await adsConnected(perms, p)) stillUsed = true
  if (!stillUsed) await perms.remove({ permissions: ['downloads'] })
}

/** 真的那一个。 */
export function chromePermissions(): PermissionsLike {
  return {
    contains: (p) => chrome.permissions.contains(p),
    request: (p) => chrome.permissions.request(p),
    remove: (p) => chrome.permissions.remove(p),
  }
}
