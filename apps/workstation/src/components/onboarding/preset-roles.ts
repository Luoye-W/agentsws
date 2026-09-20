/**
 * 按第 ② 步分析出来的东西，**预勾**第 ③ 步的岗位（70 §5，WP121b）。
 *
 * 纯函数，与界面分开：这张对照表是一条产品判断，值得单独钉一组用例——
 * 它错了的后果不是"少画一个勾"，是新用户第一次进工作台时面对的是别人的岗位。
 *
 * | ② 里看到 | 预勾 |
 * |---|---|
 * | 官网（尤其 Shopify） | 网站运营、客服 |
 * | Amazon listing / 店铺 | 客服（里面含 Amazon 客服那条职责） |
 * | 社媒链接 | 社媒运营里**对应那几条渠道**职责 |
 *
 * 两条判断写在这里：
 *
 * 1. **社媒勾的是职责不是岗位。** 「社媒运营」整岗是九条渠道；一个首页上挂着
 *    Instagram 与 TikTok 的品牌，不该因此被塞进 Reddit、Discord、微博。
 *    勾到具体渠道之后向导会问"这个自定义岗位叫什么"——所以顺手把名字也预填成
 *    那个岗位的名字，用户不必替一件我们替他决定的事起名。
 * 2. **预勾不是替用户决定**，只是把最可能的那几个先摆上。每一条都能去掉，
 *    岗位列表照常全列。
 */
import type { RolePick } from '@/components/onboarding/role-picker'
import type { BrandIntakeProfile, BrandIntakeRun, OnboardingPositionView } from '@/lib/api'

/** 社媒平台 → 社媒运营里的哪条渠道职责。认不出来的平台一条都不勾。 */
const SOCIAL_ROLE: Record<string, string> = {
  instagram: 'social.meta',
  facebook: 'social.meta',
  tiktok: 'social.tiktok',
  youtube: 'social.youtube',
  x: 'social.x',
}

/** 网站运营 / 客服 / 社媒运营这三个岗位在种子表里的 id（`apps/server/src/org.ts`）。 */
const WEB_OPS = 'web-ops'
const CUSTOMER_CARE = 'customer-care'
const SOCIAL_MEDIA = 'social-media'

function has(positions: OnboardingPositionView[], id: string): boolean {
  return positions.some((p) => p.id === id)
}

export interface PresetInput {
  run?: BrandIntakeRun
  positions: OnboardingPositionView[]
}

/**
 * 预勾。没有分析结果（走了「还没有网站」旁路）就**一条都不勾**——
 * 凭空勾几个岗位比不勾更糟：用户会以为那是系统知道点什么。
 */
export function presetPick({ run, positions }: PresetInput): RolePick {
  const empty: RolePick = { position_ids: [], role_ids: [], custom_position_name: '' }
  if (run === undefined) return empty

  const profile: BrandIntakeProfile = run.profile
  const kinds = new Set(run.inputs.map((i) => i.kind))
  const position_ids: string[] = []

  const website = kinds.has('website')
  const amazon = kinds.has('amazon_listing') || kinds.has('amazon_storefront')

  // 官网 = 有一个自己的店要运营；Shopify 只是让这一条更确定，不是它的前提
  if (website && has(positions, WEB_OPS)) position_ids.push(WEB_OPS)
  // 官网或 Amazon 都要有人答客户的问题（Amazon 客服是客服岗里的一条职责）
  if ((website || amazon) && has(positions, CUSTOMER_CARE)) position_ids.push(CUSTOMER_CARE)

  const social = positions.find((p) => p.id === SOCIAL_MEDIA)
  const role_ids = [
    ...new Set(
      (profile.social_links?.value ?? [])
        .map((link) => SOCIAL_ROLE[link.platform])
        .filter((id): id is string => id !== undefined)
        .filter((id) => (social?.roles ?? []).some((r) => r.id === id)),
    ),
  ]

  return {
    position_ids,
    role_ids,
    // 只勾了渠道职责时向导会问岗位名字——预填成「社媒运营」，不让人替我们的决定起名
    custom_position_name: role_ids.length === 0 ? '' : (social?.name ?? ''),
  }
}
