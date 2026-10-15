/**
 * WP348（决策 887）：**插件在广告后台里看到的账户**——配置卡「广告账户」的方案只认它（不让 AI 猜）。
 *
 * 插件领活时顺手看一眼开着的广告后台标签页的网址（有站点权限才看得见，不要 `tabs` 权限），
 * 从网址里认出账户编号，随领活一起报给本机服务。只认编号，不读页面、不碰登录。
 * 插件与本机服务共用，所以一个 `node:` 都不许出现。
 */
import type { AdsPlatform } from '../types.js'

export interface AdsAccountHint {
  platform: AdsPlatform
  /** Google：10 位客户编号（不带横杠）；Meta：广告账户编号（不带 `act_`）。 */
  id: string
  /** Google 网址里的 `ocid`（有就带上）。 */
  ocid?: string
}

/** 一个后台网址 → 账户（认不出回 `undefined`）。 */
export function adsAccountHintOfUrl(raw: string): AdsAccountHint | undefined {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:') return undefined
  if (u.hostname === 'ads.google.com') {
    const id = (u.searchParams.get('__c') ?? '').replace(/[\s-]/gu, '')
    if (!/^\d{10}$/u.test(id)) return undefined
    const ocid = u.searchParams.get('ocid') ?? undefined
    return {
      platform: 'google_ads',
      id,
      ...(ocid === undefined || !/^\d{1,20}$/u.test(ocid) ? {} : { ocid }),
    }
  }
  if (u.hostname === 'adsmanager.facebook.com' || u.hostname === 'business.facebook.com') {
    const id = (u.searchParams.get('act') ?? '').replace(/^act_/iu, '')
    return /^\d{5,20}$/u.test(id) ? { platform: 'meta_ads', id } : undefined
  }
  return undefined
}

/** 一串 → 领活时带的那一格（`google_ads:1234567890:111,meta_ads:123456`；去重、最多 6 个）。 */
export function formatAdsAccountHints(hints: readonly AdsAccountHint[]): string {
  const out: string[] = []
  for (const h of hints) {
    const s = `${h.platform}:${h.id}${h.ocid === undefined ? '' : `:${h.ocid}`}`
    if (!out.includes(s)) out.push(s)
  }
  return out.slice(0, 6).join(',')
}

/** 领活时带的那一格 → 一串（认不出的丢掉）。 */
export function parseAdsAccountHints(raw: string | undefined): AdsAccountHint[] {
  const out: AdsAccountHint[] = []
  for (const part of (raw ?? '').split(',').slice(0, 6)) {
    const [platform, id, ocid] = part.trim().split(':')
    if (platform !== 'google_ads' && platform !== 'meta_ads') continue
    if (id === undefined || !(platform === 'google_ads' ? /^\d{10}$/u : /^\d{5,20}$/u).test(id))
      continue
    out.push({
      platform,
      id,
      ...(ocid === undefined || !/^\d{1,20}$/u.test(ocid) ? {} : { ocid }),
    })
  }
  return out
}
