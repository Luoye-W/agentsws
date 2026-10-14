/**
 * background 里广告那一半的「经纪人」（WP313）：设置页要状态、记同意。不碰 `chrome.*`（都注入）。
 */

import type { ActionPlatform } from '@agentsws/browser-action'
import { adsConsent } from '../local-client'
import type { AdsPanelStatus } from '../messages'
import type { KeyValueStore } from '../storage'
import { readSettings } from '../storage'
import { ADS_PLATFORMS, adsConnected, type PermissionsLike } from './permissions'
import { readAdsStatus } from './poller'

/** 风险告知文案的版本（决策 562；真源在公共模块，与本机服务同一个串）。 */
export { ADS_CONSENT_TEXT_VERSION } from '@agentsws/browser-action'

export interface AdsBrokerDeps {
  store: KeyValueStore
  perms: PermissionsLike
  fetch?: typeof globalThis.fetch | undefined
}

export async function adsPanelStatus(deps: AdsBrokerDeps): Promise<AdsPanelStatus> {
  const settings = await readSettings(deps.store)
  const connected = {} as Record<ActionPlatform, boolean>
  for (const p of ADS_PLATFORMS) connected[p] = await adsConnected(deps.perms, p)
  const s = await readAdsStatus(deps.store)
  return {
    paired: settings.token !== undefined,
    connected,
    ...(s.last_poll_at === undefined ? {} : { last_poll_at: s.last_poll_at }),
    ...(s.note === undefined ? {} : { note: s.note }),
    ...(s.needs_consent === undefined ? {} : { needs_consent: s.needs_consent }),
    ...(s.running === undefined ? {} : { running: s.running }),
    ...(s.last_result === undefined ? {} : { last_result: s.last_result }),
  }
}

/** 权限给了之后记同意。没配对 / 连不上就照实说（权限留着，下次连上再记）。 */
export async function recordAdsConsent(
  deps: AdsBrokerDeps,
  platform: ActionPlatform,
  text_version: string,
): Promise<{ ok: boolean; message: string }> {
  const settings = await readSettings(deps.store)
  if (settings.token === undefined)
    return { ok: false, message: '先和这台电脑上的 Agents 工坊配对，再连接广告后台。' }
  const out = await adsConsent(
    {
      port: settings.port,
      token: settings.token,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    },
    { platform, text_version },
  )
  if (out.ok) return { ok: true, message: '连上了。批过的广告动作会在这里执行。' }
  return { ok: false, message: out.message }
}
