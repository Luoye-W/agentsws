/**
 * WP415（自查 R1 / R3，决策 1236–1238）：**执行器登记表**——哪一类卡在生产里有真执行器。
 *
 * 以前没有这张表：`server.ts` 里那条执行链一路问下去，谁都不认的卡掉进内存空桩，空桩回 ok，
 * 卡上就写「办好了」。现在：
 *
 * - 出卡时按这张表算「这一步接没接通」（`wiringOfItem`）：没接通的卡上不出「通过」，只有「知道了」；
 * - 「这条职责能做什么」按这张表标「还没接通」（`kindWiring` → 职责详情的 `actions[].wired`）；
 * - 执行链里谁也不认的卡，生产形态下回「没做：还没接通」（`fallback.ts`），绝不写成功；
 * - 执行器回 ok 但没说回读结论的，按这里登记的 `readback` 补一句（`readbackFor`）。
 *
 * **加真执行器的人（WP416–421 各组）照这个顺序做**：① 在 `server.ts` 的 `backendApply` 链上接上处理器；
 * ② 在下面 `CHANGE_EXECUTORS` 里加一行（kinds + 什么样的卡它接 + 有没有回读）；③ 守卫测试
 * `wp415-honest-guard.test.ts` 会自动把这类卡从「没接通」名单里拿掉——不用改测试。
 *
 * 判据只看卡自己带的东西（`kind` / `after` / `target`），不查库、不问连接：连接断了、插件没开这类
 * 「这一次做不成」由执行器自己回 failed（照实写原因），不在出卡时猜。
 */
import type {
  ApprovalItem,
  ChangeKind,
  ExecutionMode,
  ExecutionReadback,
  ExecutionWiring,
  ObjectRef,
} from '@agentsws/contracts'
import { DEMO_EXECUTION_TEXT, NOT_WIRED_TEXT } from '@agentsws/contracts'
import type { BackendResult } from '@agentsws/txn'
import { SANDBOX_ID_PREFIX } from '../kol-sandbox.js'
import { OWN_SUB_SOURCE } from '../own-sub-queue.js'
import { SHOP_VIA } from '../shop-ops.js'

/** 判一张卡归不归某个执行器时看的那几格（账本条目与 `staged_change` 审批项的 payload 都有）。 */
export interface ChangeLike {
  kind: string
  after?: unknown
  target?: ObjectRef
}

/**
 * 执行后怎么确认：
 * - `verified`：执行器自己读回核对（对不上就回 unknown / failed，所以回 ok 就是核对过）；
 * - `local`：写的是本机库（合作阶段、B2B 库），写完即是；
 * - `queued`：交给插件 / 浏览器去做，结局晚些回报——回 ok 只代表「交出去了」；
 * - `none`：发出去了 / 改了，但没有读回的口子。
 */
export type ReadbackKind = 'verified' | 'local' | 'queued' | 'none'

export interface ChangeExecutorSpec {
  /** 执行器名（报告、日志里用）。 */
  id: string
  kinds: readonly ChangeKind[]
  readback: ReadbackKind
  /** 这类卡里它只接哪一种（不给 = 这几类全接）。 */
  accepts?: (change: ChangeLike) => boolean
  /** 一句人话：它是怎么做的（报告里列）。 */
  label: string
  /**
   * 不在执行链上另有处理器、由这里直接回 ok 的两种（`inlineApply`）：
   * - `record`：事在出卡那一刻已经办了（落了需求单 / 出了图 / 跑了检查），批这张卡只是记一笔；
   * - `deferred`：批了以后由排期 / 群发那一拍按「已批」去做（`social-service` 的 `publishDue` /
   *   `broadcastDue`），执行链这里只回「交出去了」。
   */
  inline?: 'record' | 'deferred'
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * 生产里真有执行器的那几类（与 `server.ts` 的 `backendApply` 链一一对应，顺序也一样）。
 *
 * 只登记「真去做事」的：内存空桩、只在 demo 替身里有的都不算。
 */
export const CHANGE_EXECUTORS: readonly ChangeExecutorSpec[] = [
  {
    id: 'kol.outreach_sandbox',
    kinds: ['kol_outreach'],
    readback: 'local',
    // 发给演练红人的那一封进演练收件箱（真红人的那一封归下一行）
    accepts: (c) => str(rec(c.after).creator_id)?.startsWith(SANDBOX_ID_PREFIX) === true,
    label: '演练红人：投进演练收件箱',
  },
  {
    // WP416：真红人的开发信经已连邮箱发、读回 outbox 确认服务商收下才算（演练红人那一封在上一行先接走）
    id: 'kol.outreach_mail',
    kinds: ['kol_outreach'],
    readback: 'verified',
    label: '红人开发信：经已连邮箱发出、读回确认',
  },
  {
    // WP416：新建合作卡（不带 collaboration_id；议价卡归下一行）批了才落库、读回核对
    id: 'kol.collaboration_create',
    kinds: ['kol_collaboration'],
    readback: 'local',
    accepts: (c) =>
      rec(c.after).collaboration_id === undefined && c.target?.type === 'collaboration',
    label: '红人库：新建合作批了才落库',
  },
  {
    // WP416：交付物验收结论人批了才落库、读回核对
    id: 'kol.deliverable_review',
    kinds: ['kol_deliverable_review'],
    readback: 'local',
    accepts: (c) => c.target?.type === 'deliverable',
    label: '红人库：验收结论落库',
  },
  {
    id: 'kol.collaboration',
    kinds: ['kol_collaboration', 'kol_sample', 'kol_payment'],
    readback: 'local',
    accepts: (c) => str(rec(c.after).collaboration_id) !== undefined,
    label: '红人库：合作条件 / 寄样 / 付款落库',
  },
  {
    id: 'pr.reddit_external_post',
    kinds: ['community_post'],
    readback: 'queued',
    accepts: (c) => c.target?.type === 'external_post',
    label: 'Reddit 外部发帖：插件填好、人点发送',
  },
  {
    id: 'social.own_sub_moderation',
    kinds: ['community_moderation'],
    readback: 'none',
    accepts: (c) => rec(c.after).source === OWN_SUB_SOURCE,
    label: '自家版版务：经 Reddit 出口执行',
  },
  {
    id: 'social.moderation',
    kinds: ['community_moderation'],
    readback: 'none',
    accepts: (c) => rec(c.after).source !== OWN_SUB_SOURCE,
    label: '社群版务：经渠道适配器执行',
  },
  {
    id: 'pr.google_alerts',
    kinds: ['google_alert_change'],
    readback: 'queued',
    label: 'Google 提醒：你的浏览器去建',
  },
  {
    id: 'b2b.store',
    kinds: ['b2b_record', 'b2b_quote', 'b2b_sample', 'b2b_list_import', 'b2b_account_transfer'],
    readback: 'local',
    label: 'B2B 库：落库',
  },
  {
    id: 'b2b.mail',
    kinds: ['b2b_reply', 'b2b_outreach'],
    readback: 'none',
    label: 'B2B 询盘回复 / 开发信：经已连邮箱发出',
  },
  {
    id: 'ads.extension',
    kinds: [
      'ads_sheet',
      'ads_activate',
      'ads_undo',
      'create_campaign',
      'budget_change',
      'pause_ad',
    ],
    readback: 'queued',
    label: '广告：插件在你自己的后台里执行',
  },
  {
    id: 'site.theme_publish',
    kinds: ['publish_theme'],
    readback: 'none',
    label: '换线上主题：服务端跑 theme publish',
  },
  {
    // WP421：新闻稿草稿批了 → 定稿（人改过的正文回写）、读回「已批」；要分发的那种还没接通（不登记）
    id: 'pr.press_release_finalize',
    kinds: ['press_release'],
    readback: 'verified',
    accepts: (c) => c.target?.type === 'press_release' && rec(c.after).distributed !== true,
    label: '新闻稿：定稿落库、读回核对',
  },
  {
    // WP421：定稿入库——素材改「已定稿」、需求单交付、回给下单方，读回核对
    id: 'design.asset_publish',
    kinds: ['asset_publish'],
    readback: 'verified',
    label: '设计定稿入库：落库、读回核对',
  },
  {
    id: 'design.record',
    kinds: ['design_request', 'design_brief', 'design_variant'],
    readback: 'local',
    inline: 'record',
    label: '设计需求单 / brief / 出图：出卡时已落库，批了只记一笔',
  },
  {
    id: 'site.launch_check_record',
    kinds: ['launch_check'],
    readback: 'local',
    inline: 'record',
    label: '上线检查单：检查出卡时已跑完，批了只记一笔',
  },
  {
    id: 'social.scheduled',
    kinds: ['social_post', 'community_broadcast'],
    readback: 'queued',
    inline: 'deferred',
    label: '社媒排期 / 群发：批了由排期那一拍按渠道发',
  },
  {
    id: 'shop.ops',
    kinds: [
      'listing_edit',
      'price_change',
      'collection_edit',
      'discount_code',
      'store_setup',
      // WP417（客服 A24–A26）：退款 / 补发 / 改收货地址经店铺授权那一套改订单、读回核对
      'refund',
      'reship',
      'address_change',
      // WP418（建站 B4 / B5 / B10）：库存加减 / 全站自动折扣 / 标发货与回填单号（政策走 store_setup）
      'inventory_adjust',
      'promotion',
      'create_fulfillment',
      // WP446（docs/109 §4.4）：建站改网址跳转
      'url_redirect',
    ],
    readback: 'verified',
    // 只有经店铺工具出的卡（带 `via: shop_admin`）才走 Shopify 后台；别的路出的同类卡没有去处
    // WP446：卡上那一格是 `_via`（`shop-ops.ts` 的 `toCard` 把给执行器的键改名成 `_` 开头）——两种都认，
    // 只认 `via` 时经店铺工具出的真卡全被判成「还没接通」
    accepts: (c) => rec(c.after).via === SHOP_VIA || rec(c.after)._via === SHOP_VIA,
    label: 'Shopify 后台：改完读回核对',
  },
]

/** 这张卡（账本条目 / 卡上的 payload）归哪个执行器；谁都不认 = `undefined`。 */
export function executorOf(change: ChangeLike): ChangeExecutorSpec | undefined {
  return CHANGE_EXECUTORS.find(
    (s) => (s.kinds as readonly string[]).includes(change.kind) && (s.accepts?.(change) ?? true),
  )
}

/**
 * 这一类卡（只看 kind）接没接通——给「这条职责能做什么」用：
 * `wired` 全接、`partly` 只接一部分（例如只接经店铺工具出的那种）、`not_wired` 一条都没有。
 */
export function kindWiring(kind: string): 'wired' | 'partly' | 'not_wired' {
  const specs = CHANGE_EXECUTORS.filter((s) => (s.kinds as readonly string[]).includes(kind))
  if (specs.length === 0) return 'not_wired'
  return specs.some((s) => s.accepts === undefined) ? 'wired' : 'partly'
}

/**
 * 卡上那一格「这一步接没接通」。只判 `staged_change`（改动卡）——对外发信的卡要看渠道连没连，
 * 那是执行那一刻的事（渠道接不住就照实回「没发出去」）。
 *
 * - `memory`（测试）：不标；
 * - `demo`：没有真执行器的卡标「演示」（照常能点，空桩走一遍）；
 * - `live`：没有真执行器的卡标「还没接通」（卡上不出「通过」）。
 */
export function wiringOfItem(
  item: Pick<ApprovalItem, 'kind' | 'payload'>,
  mode: ExecutionMode,
): ExecutionWiring | undefined {
  if (mode === 'memory' || item.kind !== 'staged_change') return undefined
  const p = rec(item.payload)
  const kind = str(p.kind)
  if (kind === undefined) return undefined
  const target = rec(p.target)
  const ref =
    typeof target.type === 'string' && typeof target.id === 'string'
      ? ({ type: target.type, id: target.id } as ObjectRef)
      : undefined
  if (executorOf({ kind, after: p.after, ...(ref === undefined ? {} : { target: ref }) }))
    return undefined
  return mode === 'demo'
    ? { state: 'demo', reason: DEMO_EXECUTION_TEXT.zh }
    : { state: 'not_wired', reason: NOT_WIRED_TEXT.zh }
}

/**
 * 执行器回 ok 却没说回读结论时，按登记补一句：`verified` / `local` → 核对过；`queued` / `none` → 没能回读。
 * 不是登记过的执行器（空桩、测试注入）不补——那一类由兜底自己说。
 */
export function readbackFor(change: ChangeLike, res: BackendResult): ExecutionReadback | undefined {
  if (res.status !== 'ok' || res.readback !== undefined) return res.readback
  // WP117：演练红人那一路（进演练收件箱）不是真发——照「演示」算
  if (res.execution_id?.startsWith('ex_sandbox_') === true) return 'demo'
  const spec = executorOf(change)
  if (spec === undefined) return undefined
  return spec.readback === 'verified' || spec.readback === 'local' ? 'verified' : 'unverified'
}

/** `inline` 执行器的执行 id 前缀（发出记录不按它记一行：真发的那一拍自己记）。 */
export const INLINE_EXECUTION_PREFIX = 'inline_'

/**
 * 登记成 `inline` 的那几类在执行链上的处理器：直接回 ok（`record` 已核对、`deferred` 没能回读）。
 * 别的回 `undefined`，掉回执行链。
 */
export function inlineApply(change: ChangeLike & { id: string }): BackendResult | undefined {
  const spec = executorOf(change)
  if (spec?.inline === undefined) return undefined
  return {
    status: 'ok',
    execution_id: `${INLINE_EXECUTION_PREFIX}${spec.inline}_${change.id}`,
    readback: spec.inline === 'record' ? 'verified' : 'unverified',
  }
}

/**
 * 职责模板里动作 id 与 ChangeKind 对不上、`changeKindOf` 也接不上的那几个（只给「这条职责能做什么」用；
 * 不改 `@agentsws/roles` 那张表——那张表管额度与风险，改了会动到自动化档位）。
 */
const ACTION_KIND_EXTRA: Readonly<Record<string, ChangeKind>> = {
  stage_outreach: 'kol_outreach',
  stage_collaboration: 'kol_collaboration',
  stage_deliverable_review: 'kol_deliverable_review',
  stage_affiliate_code: 'kol_affiliate_code',
  stage_tracked_link: 'kol_tracked_link',
  stage_post: 'social_post',
  stage_profile_edit: 'social_profile_edit',
  stage_broadcast: 'community_broadcast',
  stage_rules_edit: 'community_rules',
  stage_email_template: 'email_template_edit',
  run_launch_checklist: 'launch_check',
}

/**
 * 「这条职责能做什么」那一行接没接通（WP415 / 决策 1230：做不到的标「还没接通」，不整条隐藏）。
 *
 * 认不出 ChangeKind 的动作（对外发信那一类、配置类）回 `undefined`——那一类接没接通要看渠道连没连，
 * 不在这里猜。
 */
export function actionWiring(
  action_id: string,
  changeKindOf: (id: string) => ChangeKind | undefined,
): { change_kind: ChangeKind; wired: 'wired' | 'partly' | 'not_wired' } | undefined {
  const kind = ACTION_KIND_EXTRA[action_id] ?? changeKindOf(action_id)
  if (kind === undefined) return undefined
  return { change_kind: kind, wired: kindWiring(kind) }
}
