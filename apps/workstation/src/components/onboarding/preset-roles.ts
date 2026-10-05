/**
 * 第 ② 步分析出来的东西 → 第 ③ 步的**推荐**（70 §5；WP234 起只推荐、不预勾）。
 *
 * WP121b 时这里叫「预勾」：官网 → 勾上网站运营与客服，社媒链接 → 勾上对应渠道。
 * Luoye 10-05 定：分析出来的、AI 推荐的，**都只是「推荐」小标签，用户点了才算选上**；
 * 什么信息都没有就一条不推。于是这张对照表原样留着，产出从「勾选」改成「推荐 + 理由」：
 *
 * | ② 里看到 | 推荐 |
 * |---|---|
 * | 官网 | 网站运营那几条（Shopify 说得更确定）+ 网站客服、网站在线客服 |
 * | Amazon listing / 店铺 | Amazon 客服 |
 * | 社媒链接 | 社媒运营里**对应那几条渠道**（认不出来的平台一条都不推） |
 *
 * 纯函数，与界面分开：它错了的后果是新用户第一眼看到的推荐是别人的活。
 */
import type { BrandIntakeRun, OnboardingPositionView } from '@/lib/api'

/** 一条推荐：哪条职责、为什么（引用的原话依据，没有就不带）。 */
export interface DutyRecommendation {
  role_id: string
  reason: string
  quote?: string
}

/** 社媒平台 → 社媒运营里的哪条渠道职责。认不出来的平台一条都不推。 */
const SOCIAL_ROLE: Record<string, string> = {
  // WP191（docs/86 §5）：Meta 拆成两条，各推各的
  instagram: 'social.instagram',
  facebook: 'social.facebook',
  threads: 'social.threads',
  tiktok: 'social.tiktok',
  youtube: 'social.youtube',
  x: 'social.x',
  linkedin: 'social.linkedin',
}

const PLATFORM_LABEL: Record<string, string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  threads: 'Threads',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  x: 'X',
  linkedin: 'LinkedIn',
}

/** 网站运营 / 客服在种子表里的 id（`apps/server/src/org.ts`）。 */
const WEB_OPS = 'web-ops'
const SITE_CARE = ['dtc.support', 'dtc.live-chat']
const AMAZON_CARE = 'amz.support'

export interface RecommendInput {
  run?: BrandIntakeRun
  /** 类别目录（第 ③ 步「按类别浏览」那一份）——目录里没有的职责不推。 */
  positions: OnboardingPositionView[]
}

/**
 * 按第 ② 步的结果出推荐。没有分析结果（走了「还没有网站」旁路）就**一条都不推**——
 * 凭空推几条比不推更糟：用户会以为那是系统知道点什么。
 */
export function recommendFromIntake({ run, positions }: RecommendInput): DutyRecommendation[] {
  if (run === undefined) return []
  const known = new Set(
    positions.flatMap((p) => p.roles.filter((r) => r.planned !== true).map((r) => r.id)),
  )
  const out: DutyRecommendation[] = []
  const push = (role_id: string, reason: string): void => {
    if (known.has(role_id) && !out.some((r) => r.role_id === role_id)) out.push({ role_id, reason })
  }
  const kinds = new Set(run.inputs.map((i) => i.kind))
  const website = kinds.has('website')
  const amazon = kinds.has('amazon_listing') || kinds.has('amazon_storefront')
  // 官网 = 有一个自己的店要运营；Shopify 只是让这一条更确定，不是它的前提
  if (website) {
    const shopify = run.profile.storefront_platform?.value === 'shopify'
    const reason = shopify ? '官网分析：店是 Shopify 搭的' : '官网分析：你有自己的网站'
    for (const p of positions)
      if (p.id === WEB_OPS) for (const r of p.roles) if (r.planned !== true) push(r.id, reason)
    for (const id of SITE_CARE) push(id, '官网分析：网站上的客户要有人答')
  }
  if (amazon) push(AMAZON_CARE, '分析到你在 Amazon 上卖')
  for (const link of run.profile.social_links?.value ?? []) {
    const id = SOCIAL_ROLE[link.platform]
    const label = PLATFORM_LABEL[link.platform]
    if (id !== undefined && label !== undefined) push(id, `官网上挂着你的 ${label}`)
  }
  return out
}

/** AI 的推荐排在前面；两边都推了同一条就留 AI 那句（它引的是用户原话）。 */
export function mergeRecommendations(
  ai: readonly DutyRecommendation[],
  intake: readonly DutyRecommendation[],
): DutyRecommendation[] {
  const out = [...ai]
  for (const r of intake) if (!out.some((x) => x.role_id === r.role_id)) out.push(r)
  return out
}
