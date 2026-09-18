/**
 * WP100（09-18 设计画布《卡片排版一览》）：卡面上那两处**文案**的派发表。
 *
 * 与 `layout.ts` 挨着放是有意的——它们是同一件事的两半：`layout.ts` 说"这张卡长
 * 什么样"，这里说"这张卡上的字怎么写"。两张表都在投影层（六端同一份），
 * 前端不许自己 `switch (kind)` 拼中文。
 *
 * 两张表：
 *
 * 1. {@link LAYOUT_VERBS} —— **按排版分的主次动词**。WP96 之后十一种卡的按钮行
 *    一律是"批准 / 驳回 / 指导"，而画布上它们各说各的话：出站文案卡上写着
 *    **发送**，变体卡上写着**就这张**，接管卡上写着**打开浏览器**。按钮上的字
 *    是人按下去之前唯一读的东西，十一种卡共用三个动词等于把"这一下会发生什么"
 *    从界面上抹掉。
 * 2. {@link CATEGORY_BY_KIND} / {@link CATEGORY_BY_CHANGE} —— **头一行那个类别写人话**。
 *    "网站运营 · 变更待批"说的是账本里的枚举名；人要看的是"网站运营 · 改价"。
 *
 * **动作语义一个字没改**：这里出的只有 i18n 键，`approve` 还是 `approve`，
 * 路由、审批状态机、`available_actions` 全不受影响——换的是按钮上的字与它的位置。
 * 中英两份文案在 `apps/workstation/src/lib/i18n.ts`（`verb.*` / `category.*`）。
 */
import type { ChangeKind } from '@agentsws/contracts'
import type { DeckLayout } from './layout.js'
import type { DeckAction, DeckKind } from './types.js'

/** 能出现在按钮上的动作（`open` 不在：它是右下角那个 → 圆钮，不是动词）。 */
export type DeckVerb = Exclude<DeckAction, 'open'>

export interface LayoutVerbs {
  /** 主动词：动作行左起第一个，实心按钮。 */
  primary: DeckVerb
  /**
   * 次动词：跟在主动词后面，描边按钮。
   *
   * 不在这里的动作（多半是 `instruct` 与 `snooze`）**不消失**，它们收进页脚
   * 那个 `···` 更多菜单——"指导"在大多数卡上是第三选择，占着第三个按钮位
   * 会把"这一下会发生什么"挤掉。
   */
  secondary: readonly DeckVerb[]
}

/**
 * 十一种排版各自的主次动词（画布逐条抄下来的）。
 *
 * | 排版 | 主 | 次 |
 * |---|---|---|
 * | `outbound` | 发送 | 改一下 / 不发 |
 * | `change` | 批准 | 改一下 / 驳回 |
 * | `publish` | 批准发布 | 改时间 / 驳回 |
 * | `money` | 批准退款（按 kind 换：批准补发 / 批准发码 / 批准合作） | 改金额 / 驳回 |
 * | `choice` | 就这条 | 都不是 |
 * | `variants` | 就这张 | 都不行，再来 |
 * | `aftermath` | 恢复（按 kind 换：恢复投放 / 解除禁言） | 先停着 |
 * | `person` | 通过 | 拒绝 |
 * | `handoff` | 认领 | 转给别人 / 不是客户问题 |
 * | `takeover` | 打开浏览器 | 放弃这一步 |
 * | `policy` | 批准 | 驳回 |
 *
 * 主动词全是 `approve` 不是偷懒：五动作矩阵只有那五个（36 §2.1），
 * "发送""认领""打开浏览器"是**同一个决定**的不同说法——语义在动作上，
 * 说法在这张表上。
 */
export const LAYOUT_VERBS: Record<DeckLayout, LayoutVerbs> = {
  outbound: { primary: 'approve', secondary: ['instruct', 'reject'] },
  change: { primary: 'approve', secondary: ['instruct', 'reject'] },
  publish: { primary: 'approve', secondary: ['instruct', 'reject'] },
  money: { primary: 'approve', secondary: ['instruct', 'reject'] },
  choice: { primary: 'approve', secondary: ['reject'] },
  variants: { primary: 'approve', secondary: ['reject'] },
  aftermath: { primary: 'approve', secondary: ['reject'] },
  person: { primary: 'approve', secondary: ['reject'] },
  handoff: { primary: 'approve', secondary: ['instruct', 'reject'] },
  takeover: { primary: 'approve', secondary: ['reject'] },
  policy: { primary: 'approve', secondary: ['reject'] },
}

/**
 * 主动词按 kind 再分一层的那两种排版。
 *
 * 金钱卡上"批准"是一句废话——批准**什么**？退款、补发、发码、合作，钱的去处
 * 完全不同；事后决定卡同理（"恢复"什么：投放还是那个被禁言的人）。
 * 表里没登记的 kind 回退到 `verb.<layout>.approve` 那个通用说法。
 */
const PRIMARY_BY_KIND: Partial<Record<DeckLayout, Record<string, string>>> = {
  money: {
    refund: 'verb.money.approve.refund',
    reship: 'verb.money.approve.reship',
    goodwill_credit: 'verb.money.approve.goodwill_credit',
    discount_code: 'verb.money.approve.discount_code',
    kol_affiliate_code: 'verb.money.approve.discount_code',
    promotion: 'verb.money.approve.promotion',
    kol_collaboration: 'verb.money.approve.kol_collaboration',
  },
  aftermath: {
    pause_ad: 'verb.aftermath.approve.pause_ad',
    community_moderation: 'verb.aftermath.approve.community_moderation',
  },
}

/**
 * 这个动作在这张卡上写什么字（回的是 **i18n 键**，不是中文）。
 *
 * 两种动作回 `undefined`（它们不按排版分）：`open` 不是动词（它是右下角那个
 * → 圆钮），`snooze` 在哪张卡上都是同一句"稍后"——一件"我现在判断不了"的事，
 * 没有十一种说法。渲染层那时用通用动词 `action.<动作>`。
 *
 * @param layout 卡的主体排版
 * @param action 五动作之一
 * @param kind `staged_change` 的账本条目类型，或别的卡的 `DeckKind`；用来给
 *   金钱卡与事后决定卡的主动词再分一层
 */
export function verbKey(layout: DeckLayout, action: DeckAction, kind?: string): string | undefined {
  if (action === 'open' || action === 'snooze') return undefined
  const verbs = LAYOUT_VERBS[layout]
  if (action === verbs.primary && kind !== undefined) {
    const specific = PRIMARY_BY_KIND[layout]?.[kind]
    if (specific !== undefined) return specific
  }
  return `verb.${layout}.${action}`
}

/** 这个动作在这张卡上是主动词、次动词，还是收进 `···` 的那一档。 */
export function verbRank(layout: DeckLayout, action: DeckAction): 'primary' | 'secondary' | 'more' {
  const verbs = LAYOUT_VERBS[layout]
  if (action === verbs.primary) return 'primary'
  return (verbs.secondary as readonly DeckAction[]).includes(action) ? 'secondary' : 'more'
}

/**
 * `DeckKind` → 头一行那个**类别人话**（i18n 键的后缀）。
 *
 * `staged_change` 不在这张表里：它在界面上从来不该以"变更待批"的样子出现，
 * 真正的类别在账本那条 `ChangeKind` 上（下面那张表）。
 */
export const CATEGORY_BY_KIND: Partial<Record<DeckKind, string>> = {
  outbound_draft: 'reply',
  knowledge_update: 'knowledge',
  skill_promotion: 'skill_promotion',
  skill_lesson: 'skill_lesson',
  claim: 'handoff',
  policy_change: 'policy',
  home_suggestion: 'home_tip',
  scheduled_task: 'schedule',
  app_install: 'app_install',
  app_upgrade: 'app_upgrade',
  app_uninstall: 'app_uninstall',
  upstream_upgrade: 'upstream',
  join_mapping: 'name_match',
  dev_handoff_result: 'takeover',
  ai_question: 'routing',
  daily_plan: 'plan',
  review: 'recap',
  membership: 'join',
  kol_campaign: 'creator_list',
  digest: 'digest',
}

/** `ChangeKind` → 类别人话（`staged_change` 专用；画布头一行写的就是这一列）。 */
export const CATEGORY_BY_CHANGE: Partial<Record<ChangeKind, string>> = {
  // 钱
  refund: 'refund',
  reship: 'reship',
  goodwill_credit: 'goodwill_credit',
  discount_code: 'discount_code',
  promotion: 'promotion',
  kol_affiliate_code: 'affiliate_code',
  kol_collaboration: 'collaboration',
  // 出站文案
  review_reply: 'review_reply',
  review_invite: 'review_invite',
  kol_outreach: 'outreach',
  // 发布
  publish_product: 'publish_product',
  unpublish_product: 'unpublish_product',
  publish_post: 'publish_post',
  social_post: 'publish_post',
  community_post: 'community_post',
  community_broadcast: 'broadcast',
  campaign_send: 'campaign_send',
  press_release: 'press_release',
  publish_theme: 'publish_theme',
  asset_publish: 'asset_publish',
  email_template_edit: 'email_template',
  create_campaign: 'create_campaign',
  merge_pr: 'merge_pr',
  deploy: 'deploy',
  // 改动
  price_change: 'price_change',
  listing_edit: 'listing_edit',
  collection_edit: 'collection_edit',
  inventory_adjust: 'inventory',
  budget_change: 'budget_change',
  bid_change: 'bid_change',
  negative_keyword: 'negative_keyword',
  creative_swap: 'creative_swap',
  segment_edit: 'segment_edit',
  flow_edit: 'flow_edit',
  social_profile_edit: 'profile_edit',
  community_rules: 'community_rules',
  address_change: 'address_change',
  split_order: 'split_order',
  create_fulfillment: 'fulfillment',
  cancel_order: 'cancel_order',
  kol_tracked_link: 'tracked_link',
  kol_deliverable_review: 'deliverable_review',
  store_setup: 'store_setup',
  theme_install: 'theme_install',
  app_config: 'app_config',
  app_install: 'app_install',
  dns_change: 'dns',
  payment_config: 'payment_config',
  tax_config: 'tax_config',
  domain_config: 'domain_config',
  design_request: 'design_request',
  design_brief: 'design_brief',
  // 变体 / 事后 / 人 / 转交
  design_variant: 'variants',
  pause_ad: 'after_stop_loss',
  community_moderation: 'after_moderation',
  launch_check: 'launch_check',
  community_membership: 'join',
  mention_triage: 'handoff',
}

/**
 * 头一行那个类别写什么字（回的是 **i18n 键**）。
 *
 * 两张表都没登记时回 `undefined`——渲染层那时退回原来的写法（`kind.<kind>`，
 * 也就是"变更待批"那一类枚举名）。**回退比编一个类别名好**：第十二种 kind
 * 出现那天，卡面上说的是一句不好看的实话，而不是一句好看的错话。
 */
export function categoryKey(kind: DeckKind, changeKind?: string): string | undefined {
  if (kind === 'staged_change') {
    if (changeKind === undefined) return undefined
    const hit = CATEGORY_BY_CHANGE[changeKind as ChangeKind]
    return hit === undefined ? undefined : `category.${hit}`
  }
  const hit = CATEGORY_BY_KIND[kind]
  return hit === undefined ? undefined : `category.${hit}`
}
