/** 移植自 KOLAgents `src/components/influencer/creator-display.ts` @ 88d74b2c（Luoye 的产品，非模板代码）。 */
/**
 * 红人卡与红人详情共用的展示小工具（纯函数：没有 React、没有 i18n）。同一个粉丝数、同一个互动率，
 * 卡上和详情里只有一种写法——KOLAgents 那一份的规矩，原样搬：缺的数写「—」，不写 0、不写 NaN。
 *
 * 改的地方：
 * - 工坊的账号行是 `followers` / `engagement_rate`（0–1）一格，没有 KOLAgents 那两层
 *   （账号行 + 打分快照）的兜底，`avgViewsOf` 改成读「存入红人池」那一份主页资料的平均播放；
 * - `creatorProfileUrl` 不用拼：工坊的账号行一定带 `url`；
 * - `pickPrimaryAccount` 照 KOLAgents `@/influencer/primary-account` 的默认那条（粉丝最多的那个），
 *   工坊还没有「人手指定主平台」那一格，所以只有默认这一条；
 * - 封面图那一个（`contentThumbnailUrl`）不搬：工坊的壳不加载外站图片（见决策 1762）。
 */
import type { KolCreatorDetailData, KolCreatorProfileData } from '@/lib/api'

/** 1.2M / 21.3k / 258；不是数就是「—」。 */
export function formatCount(value: number | undefined | null): string {
  if (value === undefined || value === null || !Number.isFinite(value)) return '—'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  return String(value)
}

/** 0–1 的互动率 → `6.2%`；没有就「—」。 */
export function formatEngagementRate(rate: number | undefined | null): string {
  return rate === undefined || rate === null || !Number.isFinite(rate)
    ? '—'
    : `${(rate * 100).toFixed(1)}%`
}

/** 0–1 的比 → `3.4%`（体检的播放 / 粉丝比、点赞率）。 */
export function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`
}

/** 美分 → `$1,200`（两位有效数字，估算看着像估算，不像报价——同插件 `roundedDollars`）。 */
export function formatCents(cents: number): string {
  const dollars = cents / 100
  if (dollars <= 0) return '$0'
  const rounded =
    dollars < 10
      ? Math.round(dollars)
      : (() => {
          const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(dollars)) - 1)
          return Math.round(dollars / magnitude) * magnitude
        })()
  return `$${new Intl.NumberFormat('en-US').format(rounded)}`
}

/** `2026-10-23T…` → `2026-10-23`。 */
export function dayOf(iso: string | undefined): string {
  return iso === undefined ? '—' : iso.slice(0, 10)
}

type Account = KolCreatorDetailData['accounts'][number]

/** 主平台：粉丝最多的那个账号（同粉丝取先来的）。 */
export function pickPrimaryAccount(accounts: readonly Account[]): Account | undefined {
  return accounts.reduce<Account | undefined>(
    (best, a) => (best === undefined || (a.followers ?? -1) > (best.followers ?? -1) ? a : best),
    undefined,
  )
}

/** 主平台排第一，其余照原顺序（平台徽章串、分平台表、近期作品都按这个排）。 */
export function personAccounts(accounts: readonly Account[]): Account[] {
  const primary = pickPrimaryAccount(accounts)
  return primary === undefined ? [] : [primary, ...accounts.filter((a) => a.id !== primary.id)]
}

/**
 * 全网粉丝合计（**未去重**——同一个人可能两边都关注，合计不是触达）。
 * `counted` = 有粉丝数的账号几个；一个都没有时 `total` 没意义，界面写「—」。
 */
export function totalFollowers(accounts: readonly Account[]): { total: number; counted: number } {
  let total = 0
  let counted = 0
  for (const a of accounts) {
    if (a.followers === undefined) continue
    total += a.followers
    counted += 1
  }
  return { total, counted }
}

/** 平均播放：只有存入红人池时记下的那一份有（近期作品的平均）。 */
export function avgViewsOf(profile: KolCreatorProfileData | undefined): number | undefined {
  return profile?.avg_views
}

/** 地区码 → 国旗（`DE` → 🇩🇪）；不是两位字母就没有。 */
export function countryFlag(code: string | undefined): string | undefined {
  if (code === undefined || !/^[A-Za-z]{2}$/.test(code)) return undefined
  const up = code.toUpperCase()
  return String.fromCodePoint(...[...up].map((c) => 0x1f1e6 + (c.codePointAt(0) as number) - 65))
}
