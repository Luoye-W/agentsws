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
 *    （以前还顺手把"自定义岗位叫什么"预填成「社媒运营」，WP142 去掉了，见下。）
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

/** 网站运营 / 客服 / 社媒运营 / 红人营销这几个岗位在种子表里的 id（`apps/server/src/org.ts`）。 */
const WEB_OPS = 'web-ops'
const CUSTOMER_CARE = 'customer-care'
const SOCIAL_MEDIA = 'social-media'
const KOL_MARKETING = 'kol-marketing'

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
    /*
     * WP142（docs/78 第 7 步）：**不再预填「社媒运营」**。那一格问的是"你自己勾的这几条
     * 合成的岗位叫什么"，而预勾是我们替他勾的——他还没开口，框里已经有个名字了，
     * 看着像系统替他起好了一个他没要的岗位。空着，占位字写「我的岗位」。
     */
    custom_position_name: '',
  }
}

/**
 * WP142（Fable 定，docs/78 §1 #7）：第 ③ 步之前问一句「你这次主要想让它干什么」。
 *
 * 网址只看得出"有官网 / 有 Amazon / 有社媒"，看不出"这个人是来找红人的"——
 * 于是红人营销从来不会被预勾，而来内测的朋友一大半是冲红人来的。所以直接问，
 * 按答案勾岗位。可多选；默认就是网址预勾出来的那个样子（勾了客服就是「客服」）。
 */
export type Purpose = 'kol' | 'care'

export const PURPOSE_POSITION: Readonly<Record<Purpose, string>> = {
  kol: KOL_MARKETING,
  care: CUSTOMER_CARE,
}

export const PURPOSES: readonly Purpose[] = ['kol', 'care']

/** 这台机器上问得出哪几个（岗位没装就不问那一项）。 */
export function availablePurposes(positions: OnboardingPositionView[]): Purpose[] {
  return PURPOSES.filter((p) => has(positions, PURPOSE_POSITION[p]))
}

/** 现在的勾选对应哪几个目的（默认值就从预勾读出来）。 */
export function purposesOf(pick: RolePick): Purpose[] {
  return PURPOSES.filter((p) => pick.position_ids.includes(PURPOSE_POSITION[p]))
}

/**
 * 按目的改勾选：选中的目的对应的岗位勾上，没选的去掉；**别的岗位与单勾的职责不动**
 * （网站运营、社媒渠道那几条是网址预勾的，与这一问无关）。
 */
export function applyPurposes(
  pick: RolePick,
  purposes: readonly Purpose[],
  positions: OnboardingPositionView[],
): RolePick {
  const managed = new Set(PURPOSES.map((p) => PURPOSE_POSITION[p]))
  const kept = pick.position_ids.filter((id) => !managed.has(id))
  const wanted = PURPOSES.filter((p) => purposes.includes(p))
    .map((p) => PURPOSE_POSITION[p])
    .filter((id) => has(positions, id))
  return { ...pick, position_ids: [...kept, ...wanted] }
}
