/**
 * WP328：Reddit 的**可选站点权限**——装插件、升级插件都不要，用户在设置页点「连接 Reddit」时才弹窗申请
 * （与 WP313 广告后台同一套做法）。WP329（写）也认这一份。
 */
import { REDDIT_HOST_PERMISSIONS } from '@agentsws/browser-action'
import type { PermissionsLike } from '../ads/permissions'

const WANT: chrome.permissions.Permissions = { origins: [...REDDIT_HOST_PERMISSIONS] }

export function redditConnected(perms: PermissionsLike): Promise<boolean> {
  return perms.contains(WANT)
}

/** 只能在用户点按钮的那一刻调（设置页里）。 */
export function requestReddit(perms: PermissionsLike): Promise<boolean> {
  return perms.request(WANT)
}

export async function removeReddit(perms: PermissionsLike): Promise<void> {
  await perms.remove(WANT)
}
