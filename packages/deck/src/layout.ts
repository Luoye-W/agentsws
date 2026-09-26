/**
 * WP96（09-18 设计画布《卡片排版一览》）：卡的**主体排版**只有十一种。
 *
 * 为什么把它放进投影层而不是前端：六端（工作台 / IM 卡片 / Pet / 移动 …）拿的是
 * 同一张 `DeckCard`，"这张卡长什么样"必须和"这张卡是什么"一起下发，否则每端各写
 * 一份 `switch (kind)`，第十二种 kind 出现时要改六处。
 *
 * 表**写在这一处**，而且是**全的**：`DeckKind` 与 `ChangeKind` 的每一个成员都要在
 * 这里有个去处，`layout.test.ts` 钉着这件事（漏一个就红）。
 *
 * 通用头（岗位 · 类 胶囊 / 等待时长 / 提案人头像）与通用页脚（按钮行 + 右下 → 圆钮）
 * **不在这十一种里**——它们全类共用，由渲染层给。
 */
import type { ChangeKind } from '@agentsws/contracts'
import type { DeckKind } from './types.js'

/**
 * 十一种主体排版。
 *
 * - `outbound` 出站文案：正文整段 + 芯片（回信 / 回评论 / 开发信 / 邀评）
 * - `change` 改动：before / after 双格 + 一句依据（改价 / 改预算 / 调库存 / 改群规）
 * - `publish` 发布：左预览右说明 + 排期 + 受众数（上架 / 发帖 / 群发 / 上线）
 * - `money` 金钱：大金额 + 键值对（退款 / 补发 / 折扣码 / 合作预算）
 * - `choice` 选择：单选列表，不猜（路由拿不准 / 合并建议 / 同名对照 / 计划）
 * - `variants` 变体：缩略图格，人点一张
 * - `aftermath` 事后决定：键值对 +「恢复 / 先停着」（系统已经做了，问要不要改）
 * - `person` 人物：头像 + 资料摘要 + 规则匹配（入群 / 建联对象 / 放人进工作区）
 * - `handoff` 转交 / 认领：原话 + 分类依据 + 认领
 * - `takeover` 接管：一句发生了什么 + 打开浏览器（Agent 不重试）
 * - `policy` 策略：配置 diff（改额度 / 改职责定义 / 装卸应用 / 升级）
 */
export type DeckLayout =
  | 'outbound'
  | 'change'
  | 'publish'
  | 'money'
  | 'choice'
  | 'variants'
  | 'aftermath'
  | 'person'
  | 'handoff'
  | 'takeover'
  | 'policy'

export const DECK_LAYOUTS: readonly DeckLayout[] = [
  'outbound',
  'change',
  'publish',
  'money',
  'choice',
  'variants',
  'aftermath',
  'person',
  'handoff',
  'takeover',
  'policy',
]

/**
 * `DeckKind` → 排版。
 *
 * `staged_change` 不在这张表里：它是一个口袋，真正决定排版的是账本里那条
 * `ChangeKind`（下面那张表）。
 */
export const LAYOUT_BY_KIND: Record<Exclude<DeckKind, 'staged_change'>, DeckLayout> = {
  outbound_draft: 'outbound',
  // 知识确认改的是一张事实卡的写法：before / after 就是它的全部内容
  knowledge_update: 'change',
  skill_promotion: 'policy',
  skill_lesson: 'policy',
  claim: 'handoff',
  policy_change: 'policy',
  home_suggestion: 'choice',
  scheduled_task: 'policy',
  app_install: 'policy',
  app_upgrade: 'policy',
  app_uninstall: 'policy',
  upstream_upgrade: 'policy',
  // 同名对照 = 画布 ⑤ 明写的那一种：两个候选，人点一个，不猜
  join_mapping: 'choice',
  // 机器停在这儿了，要人上手（浏览器登录态失效那一类）
  dev_handoff_result: 'takeover',
  ai_question: 'choice',
  daily_plan: 'choice',
  review: 'choice',
  // 46 I3：放不放这个人进来——头像 + 资料摘要 + 规则匹配
  membership: 'person',
  // WP96 起日报不再进审批队列（见 `NOT_A_CARD`），排版留着是为了这张表是全的
  daily_report: 'aftermath',
  // 一次 campaign 的产出是**一批人**，卡面问的是"这批人你认不认"
  kol_campaign: 'person',
  // WP144：「让它在接下来 N 分钟操作这台电脑？」——一句话的是非题
  computer_use: 'policy',
  // WP154：搜索报告（每日 5 件事 / 每周收入 / 每周 AI 可见度）同日报，不进队列（`NOT_A_CARD`）
  seo_report: 'aftermath',
  // WP154：这个词写不写一页——一道是非题
  seo_topic: 'choice',
  system_alert: 'aftermath',
  digest: 'aftermath',
}

/**
 * `ChangeKind` → 排版（`staged_change` 专用）。
 *
 * 分类的依据是**人看这张卡时要回答的问题**，不是它改了哪张表：
 * 退款问"这笔钱给不给"（金额当主体），改价问"从多少到多少"（双格当主体），
 * 上架问"这个东西要不要露出去、什么时候、给谁看"（预览 + 排期当主体）。
 */
export const LAYOUT_BY_CHANGE: Record<ChangeKind, DeckLayout> = {
  // ── ④ 金钱：一个大金额 + 额度与依据 ────────────────────────────────
  refund: 'money',
  reship: 'money',
  goodwill_credit: 'money',
  discount_code: 'money',
  promotion: 'money',
  kol_affiliate_code: 'money',
  // 合作 = 样品 + 佣金 + 现金上限，人真正要点头的是那个上限
  kol_collaboration: 'money',

  // ── ① 出站文案：正文整段给人看 ────────────────────────────────────
  review_reply: 'outbound',
  review_invite: 'outbound',
  kol_outreach: 'outbound',

  // ── ③ 发布：左预览右说明，排期时间与受众数必现 ─────────────────────
  publish_product: 'publish',
  unpublish_product: 'publish',
  publish_post: 'publish',
  social_post: 'publish',
  community_post: 'publish',
  community_broadcast: 'publish',
  campaign_send: 'publish',
  press_release: 'publish',
  publish_theme: 'publish',
  asset_publish: 'publish',
  email_template_edit: 'publish',
  create_campaign: 'publish',
  merge_pr: 'publish',
  deploy: 'publish',

  // ── ② 改动：before / after 双格 + 一句依据 ─────────────────────────
  price_change: 'change',
  listing_edit: 'change',
  collection_edit: 'change',
  inventory_adjust: 'change',
  budget_change: 'change',
  bid_change: 'change',
  negative_keyword: 'change',
  creative_swap: 'change',
  segment_edit: 'change',
  flow_edit: 'change',
  social_profile_edit: 'change',
  community_rules: 'change',
  address_change: 'change',
  split_order: 'change',
  create_fulfillment: 'change',
  cancel_order: 'change',
  kol_tracked_link: 'change',
  kol_deliverable_review: 'change',
  store_setup: 'change',
  theme_install: 'change',
  app_config: 'change',
  app_install: 'change',
  dns_change: 'change',
  payment_config: 'change',
  tax_config: 'change',
  domain_config: 'change',
  design_request: 'change',
  design_brief: 'change',
  // WP154：改一页的元信息 / 加小节 / 调内链——人要看的就是改前改后那两格
  page_seo_edit: 'change',
  page_section_add: 'change',
  internal_link_edit: 'change',

  // ── ⑥ 变体：缩略图格，人点一张 ────────────────────────────────────
  design_variant: 'variants',

  // ── ⑦ 事后决定：系统已经做了，问要不要改回来 ───────────────────────
  pause_ad: 'aftermath',
  community_moderation: 'aftermath',
  // WP96 起检查单不再进审批队列（见 `NOT_A_CARD`）：它是一次只读巡检的结果
  launch_check: 'aftermath',

  // ── ⑧ 人物：头像 + 资料摘要 + 规则匹配 ────────────────────────────
  community_membership: 'person',

  // ── ⑨ 转交 / 认领：原话 + 分类依据 + 认领 ─────────────────────────
  mention_triage: 'handoff',
}

/** 兜底：表里没有的（第十二种 kind 出现那天）走改动卡，它的双格对任何 diff 都成立。 */
export const DEFAULT_LAYOUT: DeckLayout = 'change'

/**
 * 这张卡该用哪种排版。
 *
 * @param kind 卡型
 * @param changeKind `staged_change` 的账本条目类型（`payload.kind`）；别的卡不用传
 */
export function layoutFor(kind: DeckKind, changeKind?: string): DeckLayout {
  if (kind === 'staged_change') {
    if (changeKind === undefined) return DEFAULT_LAYOUT
    return LAYOUT_BY_CHANGE[changeKind as ChangeKind] ?? DEFAULT_LAYOUT
  }
  return LAYOUT_BY_KIND[kind as Exclude<DeckKind, 'staged_change'>] ?? DEFAULT_LAYOUT
}

/**
 * 09-18 定：**只有要人决定的才是卡**（36 §2）。
 *
 * 这三样不再进审批队列，改成岗位面板里的块：
 * - `daily_report`（WP63 店铺日报）→ 面板**报表块**，看完即过
 * - `launch_check`（WP77 上线检查单）→ 面板**报表块**
 * - `system_alert`（像素异常 / 库存告急 / 负面预警 / 超期未发）→ 通知 + 面板**告警块**
 *
 * 它们**引出的决定**照旧出卡：恢复投放（⑦）、补货（②）、回应舆情（①）——
 * 那些是真要人点头的，这三样不是。
 *
 * 判断写在 deck 层（而不是各服务各写一遍）的理由与 `layoutFor` 一样：六端同一份。
 */
export const NOT_A_CARD = {
  kinds: ['daily_report', 'system_alert', 'seo_report'] as const,
  changeKinds: ['launch_check'] as const,
}

/** 这条审批项还该不该进人的队列？（`false` = 它只进面板块与通知） */
export function isQueueCard(kind: DeckKind, changeKind?: string): boolean {
  if ((NOT_A_CARD.kinds as readonly string[]).includes(kind)) return false
  if (kind === 'staged_change' && changeKind !== undefined) {
    return !(NOT_A_CARD.changeKinds as readonly string[]).includes(changeKind)
  }
  return true
}
