/**
 * 「默认不碰」的区域（决策 557，10-14 Luoye 改：**默认不碰，用户可在设置里逐项放开，放开后一律 L1**）。
 *
 * 两道判断：
 *
 * 1. **页面**：每打开一页、每点一下之前，看当前网址落没落进某个区域（{@link zoneOfUrl}）。
 *    落进了而这件活没被允许进 → 停、交给人（{@link zoneGate}）。
 * 2. **动作**：动作本身就要进某个区域（比如「删除广告系列」），在计划里写 `zones`；
 *    进队时本机服务核对：用户放开了 + 审批是 L1，才把它写进 `zones_allowed`（{@link allowedZonesFor}）。
 *
 * 网址规则照两家后台公开帮助页里的写法整理，**没有对真站核过**（本单纪律不许打开真实后台）。
 * 真站首跑时要逐条对一次（报告里列为要定的事）。宁可多拦：认错了最多是停下交给人。
 */

import type { ActionPlatform, GuardedZoneId } from './types.js'

export interface GuardedZone {
  id: GuardedZoneId
  /** 设置页上的名字（两三个字；说明进 tooltip）。 */
  label: string
  /** 网址规则：主机名 + 路径（不分大小写）。 */
  urls: { platform: ActionPlatform; host: RegExp; path: RegExp }[]
}

const GOOGLE = /^ads\.google\.com$/iu
const META_ANY = /^(www\.|business\.|adsmanager\.)?facebook\.com$/iu

/** 十个区域，顺序就是设置页上的顺序。 */
export const GUARDED_ZONES: readonly GuardedZone[] = [
  {
    id: 'payment',
    label: '付款',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/billing\/(payment|paymentmethods)/iu },
      { platform: 'meta_ads', host: META_ANY, path: /(payment[_-]?methods|\/payments\b)/iu },
    ],
  },
  {
    id: 'billing',
    label: '账单',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/billing(\/|$)/iu },
      { platform: 'meta_ads', host: META_ANY, path: /(billing|\/invoices?\b)/iu },
    ],
  },
  {
    id: 'balance',
    label: '余额',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/billing\/(summary|transactions)/iu },
      { platform: 'meta_ads', host: META_ANY, path: /(prepay|add[_-]?funds|\/balance\b)/iu },
    ],
  },
  {
    id: 'users',
    label: '用户与权限',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/(accountaccess|access)/iu },
      {
        platform: 'meta_ads',
        host: META_ANY,
        path: /\/settings\/(people|partners|system[_-]users)/iu,
      },
    ],
  },
  {
    id: 'business_settings',
    label: '商务设置',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/(settings\/account|preferences)/iu },
      {
        platform: 'meta_ads',
        host: META_ANY,
        path: /^\/(settings|latest\/settings|business_info)/iu,
      },
    ],
  },
  {
    id: 'verification',
    label: '验证',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /verification/iu },
      { platform: 'meta_ads', host: META_ANY, path: /(verification|security[_-]center)/iu },
    ],
  },
  {
    id: 'appeal',
    label: '申诉',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/(policymanager|appeals?)/iu },
      {
        platform: 'meta_ads',
        host: META_ANY,
        path: /(account[_-]?quality|business[_-]support[_-]home|appeal)/iu,
      },
    ],
  },
  {
    id: 'new_account',
    label: '新建账户',
    urls: [
      {
        platform: 'google_ads',
        host: GOOGLE,
        path: /^\/(aw\/)?(signup|nav\/createaccount|aw\/overview\/createaccount)/iu,
      },
      {
        platform: 'meta_ads',
        host: META_ANY,
        path: /(ad[_-]?accounts?\/(new|create)|create[_-]ad[_-]account)/iu,
      },
    ],
  },
  {
    id: 'pixel_conversion',
    label: '像素与转化',
    urls: [
      { platform: 'google_ads', host: GOOGLE, path: /^\/aw\/conversions/iu },
      {
        platform: 'meta_ads',
        host: META_ANY,
        path: /(events[_-]?manager|\/pixels?\b|\/datasets?\b)/iu,
      },
    ],
  },
  {
    id: 'delete_campaign',
    label: '删除系列',
    // 删除不是一个「页面」，是一个动作：靠计划里的 `zones` 管，网址上不认。
    urls: [],
  },
]

/** 用户的设置：每个区域放没放开。**全部默认关**。 */
export type GuardedZoneSettings = Record<GuardedZoneId, boolean>

export const GUARDED_ZONE_IDS: readonly GuardedZoneId[] = GUARDED_ZONES.map((z) => z.id)

export function defaultZoneSettings(): GuardedZoneSettings {
  return Object.fromEntries(GUARDED_ZONE_IDS.map((id) => [id, false])) as GuardedZoneSettings
}

/** 从存的那一份读回来：认不得的键丢掉，缺的补成关。 */
export function normalizeZoneSettings(raw: unknown): GuardedZoneSettings {
  const out = defaultZoneSettings()
  if (typeof raw !== 'object' || raw === null) return out
  for (const id of GUARDED_ZONE_IDS) {
    if ((raw as Record<string, unknown>)[id] === true) out[id] = true
  }
  return out
}

export function isGuardedZoneId(value: string): value is GuardedZoneId {
  return (GUARDED_ZONE_IDS as readonly string[]).includes(value)
}

/**
 * 认网址时的先后：窄的先认（付款、余额都在「账单」那一片下面；人员在「商务设置」下面），
 * 这样用户只放开了「账单」时，余额页照样停。
 */
const MATCH_ORDER: readonly GuardedZoneId[] = [
  'payment',
  'balance',
  'users',
  'verification',
  'appeal',
  'new_account',
  'pixel_conversion',
  'business_settings',
  'billing',
  'delete_campaign',
]

/** 这个网址落在哪个区域里（不在任何区域里回 `undefined`）。 */
export function zoneOfUrl(url: string): GuardedZoneId | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  const pathAndQuery = `${u.pathname}${u.search}`
  for (const id of MATCH_ORDER) {
    const zone = GUARDED_ZONES.find((z) => z.id === id)
    if (zone === undefined) continue
    for (const rule of zone.urls) {
      if (rule.host.test(u.hostname) && rule.path.test(pathAndQuery)) return zone.id
    }
  }
  return undefined
}

export function zoneLabel(id: GuardedZoneId): string {
  return GUARDED_ZONES.find((z) => z.id === id)?.label ?? id
}

/** 页面这一道：进了区域而这件活没被允许 → 停。 */
export function zoneGate(
  url: string,
  allowed: readonly GuardedZoneId[],
): { ok: true } | { ok: false; zone: GuardedZoneId; why: string } {
  const zone = zoneOfUrl(url)
  if (zone === undefined || allowed.includes(zone)) return { ok: true }
  return {
    ok: false,
    zone,
    why: `到了「${zoneLabel(zone)}」页面，这里默认不碰，已停下交给你。`,
  }
}

/**
 * 动作这一道（进队时本机服务问）：计划要进的区域，**每一个**都要用户放开了、并且审批是 L1。
 * 有一个不满足就整件不进队，回人话。
 */
export function allowedZonesFor(
  planZones: readonly GuardedZoneId[],
  settings: GuardedZoneSettings,
  approvalLevel: 'L1' | 'L2' | 'L3' | undefined,
): { ok: true; zones: GuardedZoneId[] } | { ok: false; why: string } {
  if (planZones.length === 0) return { ok: true, zones: [] }
  const closed = planZones.filter((z) => !settings[z])
  if (closed.length > 0)
    return {
      ok: false,
      why: `这件事要进「${closed.map(zoneLabel).join('、')}」，默认不碰。要交给 AI，先在设置里放开。`,
    }
  if (approvalLevel !== 'L1')
    return { ok: false, why: '放开的区域一律要你逐条点头（L1），这张卡的级别不够。' }
  return { ok: true, zones: [...new Set(planZones)] }
}
