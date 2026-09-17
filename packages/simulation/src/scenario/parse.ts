/**
 * 场景文件解析与 schema 校验（26 §1）。
 *
 * 校验是"只认声明过的键"：多写一个键就报错，少写必填键也报错——
 * 场景文件是回归基线，静默忽略一个拼错的键等于静默关掉一条断言。
 */
import { readFileSync } from 'node:fs'
import type {
  ChangeKind,
  ProductLineRule,
  RangeRef,
  StorefrontPlatform,
  WorkspaceVertical,
} from '@agentsws/contracts'
import { STOREFRONT_PLATFORMS } from '@agentsws/contracts'
import { parse as parseYaml } from 'yaml'
import { ScenarioSchemaError } from '../errors.js'
import { parseDuration, parseRange } from './duration.js'
import type {
  InvariantName,
  Scenario,
  ScenarioActor,
  ScenarioEvent,
  ScenarioExpected,
  ScenarioStandIns,
  ScenarioTxnPolicy,
  Tier,
} from './types.js'
import { INVARIANT_NAMES } from './types.js'

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)

function fail(source: string, path: string, message: string): never {
  throw new ScenarioSchemaError(source, path, message)
}

function known(source: string, path: string, o: Rec, keys: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !keys.includes(k))
  if (extra.length > 0) fail(source, path, `未知字段：${extra.join(', ')}（只认已声明的键）`)
}

function str(source: string, path: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) fail(source, path, '必须是非空字符串')
  return v
}

function optStr(source: string, path: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(source, path, '必须是字符串')
  return v
}

function num(source: string, path: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(source, path, '必须是数值')
  return v
}

function strList(source: string, path: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    fail(source, path, '必须是字符串数组')
  }
  return v as string[]
}

function optStrList(source: string, path: string, v: unknown): string[] | undefined {
  return v === undefined || v === null ? undefined : strList(source, path, v)
}

const NUMERIC_RE = /^(>=|<=|==|>|<)\s*-?\d+(\.\d+)?$/

/** 必填布尔（DSL 里只有 `chat.human_takeover.on` 用得着）。 */
function requireBool(source: string, path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') fail(source, path, '必须是 true / false')
  return value
}

/** WP57：聊天计划的五种动作（`support-core/chat/types.ts` 的冻结面）。 */
const CHAT_ACTIONS: readonly string[] = [
  'answer',
  'collect_info',
  'human_review',
  'assist',
  'handoff',
]

const RANGE_KINDS = ['store', 'department', 'account', 'market', 'product_line'] as const
const LINE_PARENT_KINDS = ['store', 'account', 'market'] as const

/** `{ kind, id }`（44 §3 的五种范围）。 */
function rangeRef(source: string, path: string, v: unknown): RangeRef {
  if (!isRec(v)) fail(source, path, '必须是 { kind, id }')
  known(source, path, v, ['kind', 'id'])
  const kind = str(source, `${path}.kind`, v.kind)
  if (!(RANGE_KINDS as readonly string[]).includes(kind))
    fail(source, `${path}.kind`, `范围种类只能是 ${RANGE_KINDS.join(' / ')}`)
  return { kind: kind as RangeRef['kind'], id: str(source, `${path}.id`, v.id) }
}

function rangeList(source: string, path: string, v: unknown): RangeRef[] {
  if (!Array.isArray(v)) fail(source, path, '必须是列表')
  return v.map((item, i) => rangeRef(source, `${path}[${i}]`, item))
}

/** 产品线判据：三种平台各一套字段（44 G2）。 */
function lineRule(source: string, path: string, v: unknown): ProductLineRule {
  if (!isRec(v)) fail(source, path, '必须是对象')
  const platform = str(source, `${path}.platform`, v.platform)
  if (platform === 'manual') {
    known(source, path, v, ['platform', 'product_ids'])
    return {
      platform: 'manual',
      product_ids: strList(source, `${path}.product_ids`, v.product_ids),
    }
  }
  if (platform === 'amazon') {
    known(source, path, v, ['platform', 'asins', 'sku_prefixes', 'brand'])
    const asins = optStrList(source, `${path}.asins`, v.asins)
    const prefixes = optStrList(source, `${path}.sku_prefixes`, v.sku_prefixes)
    const brand = optStr(source, `${path}.brand`, v.brand)
    return {
      platform: 'amazon',
      ...(asins === undefined ? {} : { asins }),
      ...(prefixes === undefined ? {} : { sku_prefixes: prefixes }),
      ...(brand === undefined ? {} : { brand }),
    }
  }
  if (platform !== 'shopify')
    fail(source, `${path}.platform`, 'platform 只能是 shopify / amazon / manual')
  known(source, path, v, ['platform', 'collection_ids', 'tags', 'vendors', 'product_types'])
  const collections = optStrList(source, `${path}.collection_ids`, v.collection_ids)
  const tags = optStrList(source, `${path}.tags`, v.tags)
  const vendors = optStrList(source, `${path}.vendors`, v.vendors)
  const types = optStrList(source, `${path}.product_types`, v.product_types)
  return {
    platform: 'shopify',
    ...(collections === undefined ? {} : { collection_ids: collections }),
    ...(tags === undefined ? {} : { tags }),
    ...(vendors === undefined ? {} : { vendors }),
    ...(types === undefined ? {} : { product_types: types }),
  }
}

function numeric(source: string, path: string, v: unknown): number | string {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) return v.trim()
  fail(source, path, '必须是数值或比较式（>=0.6 / <=20000 / ==0）')
}

const EVENT_KEYS = [
  'inbound.email',
  'actor.decide',
  'clock.advance',
  'inject.fault',
  'model.outage',
  'inject.budget',
  'routine.start',
  'learning.start',
  'reconcile.run',
  'process.restart',
  // WP38 认领与撞车（40 §3）
  'work.todo',
  'work.pool',
  'work.claim',
  'work.idle_sweep',
  // WP39 秘书 Agent（41 §1）
  'secretary.profile',
  'secretary.ask',
  'secretary.meet',
  'secretary.meet_decide',
  'secretary.route',
  // WP69 岗位是任务主入口（54）
  'position.staff',
  'position.open',
  // WP44 店铺操作（08 §2.3 读走原生 Action、写走 Backend）
  'shop.price_change',
  'shop.theme_push',
  'shop.theme_publish',
  // WP64 邮件营销与订单履约（51 §2.3 / §2.4）
  'fulfillment.sweep',
  'fulfillment.mark_shipped',
  'email.unsubscribe',
  'email.campaign_send',
  // WP72 社媒运营（56 §2 / §4）
  'social.post',
  'social.reply',
  'community.broadcast',
  // WP73 社群组那三条写动作（56 §6）
  'community.approve_member',
  'community.moderate',
  'community.rules_edit',
  // WP76 设计岗位（58 §1）
  'design.request',
  'design.variants',
  'design.pick',
  // WP67 红人营销（48 §5.1）
  'kol.outreach',
  'kol.collaboration',
  'kol.tracked_link',
  'kol.affiliate_order',
  'kol.attribution',
  // WP68 campaign 向导与公共库（48 §5.2 / §5.3）
  'kol.creator',
  'kol.campaign',
  'kol.public_creator',
  'kol.public_reveal',
  // WP63 店铺管理与内容与博客（51 §2.1 / §2.2）
  'shop.publish_product',
  'content.blog_post',
  'store.daily_report',
  // WP47 范围模型（44）
  'org.range_group',
  'org.product_line',
  'org.assign_range',
  'org.scope_check',
  // WP51 首次设置与同事发现（46）
  'org.first_run',
  'org.platform_check',
  'org.join_request',
  // WP50 个人用 → 公司用（45）
  'org.personal',
  'org.join',
  // WP65 品牌是顶层（52 O1 / O2）
  'org.brand',
  'org.brand_check',
  // WP56 知识溯源链（48 §4 #6）
  'knowledge.source_sync',
  // WP57 网站在线客服（48 §4 #11 的实时车道）
  'chat.visitor_message',
  'chat.human_takeover',
] as const

const EXPECTED_KEYS = [
  'calls_tool',
  'first_tool',
  'never_calls',
  'staged_change_kinds',
  'no_applied_changes_before',
  'approval_items',
  'reply_omits',
  'reply_includes_any',
  'memory_contains',
  'max_tool_calls',
  'metrics',
  'run_failed_codes',
  'notifications_to',
  'blocked_rules',
  'event_types',
  'approval_kinds',
  'scheduled_handlers',
  'prompt_includes_any',
  'lessons_filtered',
  'lessons_pooled',
  'escalated_tiers',
  'escalated_to',
  'sampled',
  'auto_approved',
  'judge_min_score',
  'assignments_not_unioned',
  'routed_to',
  // WP69（54 §2）：岗位内路由落到了哪几条职责
  'position_routed_to',
  'secretary_kinds',
  'scope_disjoint',
  // WP62（51 §1 N0）
  'platform_unsupported',
  // WP64（51 §2.3 / §2.4）
  'overdue_orders',
  'campaign_send',
  // WP67（48 §5.1）
  'kol_outreach',
  'kol_collaboration',
  'kol_attribution',
  // WP68（48 §5.2 / §5.3）
  'kol_campaign',
  'kol_reveal',
  // WP76（58 §1）
  'design_request',
  'design_variants',
  'design_pick',
  // WP72（56 §2 / §4）
  'social_post',
  'social_reply',
  'community_handoff',
  'community_broadcast',
  // WP73（56 §6）
  'community_membership',
  'community_moderation',
  'community_rules',
  'social_calendar',
  // WP57
  'chat_actions',
  'chat_assist',
  // WP55（48 §4 L3 #2 #3）
  'sub_channel',
  'gates_failed',
  // WP63（51 §2.1 数据日报）
  'daily_reports',
  'daily_report_figures',
] as const

function parseActor(source: string, name: string, raw: unknown): ScenarioActor {
  if (!isRec(raw)) fail(source, `actors.${name}`, '必须是对象')
  known(source, `actors.${name}`, raw, ['approve'])
  const approve = raw.approve
  if (!isRec(approve)) fail(source, `actors.${name}.approve`, '必须是对象')
  known(source, `actors.${name}.approve`, approve, ['policy', 'latency', 'reject_rules', 'lane'])
  const policy = str(source, `actors.${name}.approve.policy`, approve.policy)
  const latency = optStr(source, `actors.${name}.approve.latency`, approve.latency)
  if (latency !== undefined) parseRange(latency)
  const lane = optStr(source, `actors.${name}.approve.lane`, approve.lane)
  if (lane !== undefined && !['mine', 'scope', 'unclaimed'].includes(lane)) {
    fail(source, `actors.${name}.approve.lane`, 'lane 只能是 mine / scope / unclaimed')
  }
  return {
    policy,
    ...(latency === undefined ? {} : { latency }),
    ...(approve.reject_rules === undefined
      ? {}
      : {
          reject_rules: strList(
            source,
            `actors.${name}.approve.reject_rules`,
            approve.reject_rules,
          ),
        }),
    ...(lane === undefined ? {} : { lane: lane as 'mine' | 'scope' | 'unclaimed' }),
  }
}

function parseEvent(source: string, index: number, raw: unknown): ScenarioEvent {
  const path = `events[${index}]`
  if (!isRec(raw)) fail(source, path, '必须是对象')
  known(source, path, raw, ['at', ...EVENT_KEYS])
  const at = str(source, `${path}.at`, raw.at)
  const present = EVENT_KEYS.filter((k) => raw[k] !== undefined)
  if (present.length !== 1 || present[0] === undefined) {
    fail(source, path, `每条事件必须且只能带一个动作键（${EVENT_KEYS.join(' / ')}）`)
  }
  const key = present[0]
  const body = raw[key]
  if (!isRec(body)) fail(source, `${path}.${key}`, '必须是对象')

  switch (key) {
    case 'inbound.email': {
      known(source, `${path}.${key}`, body, [
        'from',
        'thread',
        'subject',
        'body_ref',
        'body',
        'message_id',
      ])
      if (body.body_ref === undefined && body.body === undefined) {
        fail(source, `${path}.${key}`, 'body_ref 与 body 至少给一个')
      }
      return {
        at,
        type: 'inbound.email',
        inbound: {
          from: str(source, `${path}.${key}.from`, body.from),
          thread: str(source, `${path}.${key}.thread`, body.thread),
          ...(body.subject === undefined
            ? {}
            : { subject: str(source, `${path}.${key}.subject`, body.subject) }),
          ...(body.body_ref === undefined
            ? {}
            : { body_ref: str(source, `${path}.${key}.body_ref`, body.body_ref) }),
          ...(body.body === undefined
            ? {}
            : { body: str(source, `${path}.${key}.body`, body.body) }),
          ...(body.message_id === undefined
            ? {}
            : { message_id: str(source, `${path}.${key}.message_id`, body.message_id) }),
        },
      }
    }
    case 'actor.decide': {
      known(source, `${path}.${key}`, body, ['who', 'item', 'action', 'reason', 'option'])
      const action = str(source, `${path}.${key}.action`, body.action)
      if (!['approve', 'approve_edited', 'reject'].includes(action)) {
        fail(source, `${path}.${key}.action`, 'action 只能是 approve / approve_edited / reject')
      }
      return {
        at,
        type: 'actor.decide',
        decide: {
          who: str(source, `${path}.${key}.who`, body.who),
          item: str(source, `${path}.${key}.item`, body.item),
          action: action as 'approve' | 'approve_edited' | 'reject',
          ...(body.reason === undefined
            ? {}
            : { reason: str(source, `${path}.${key}.reason`, body.reason) }),
          ...(body.option === undefined
            ? {}
            : { option: str(source, `${path}.${key}.option`, body.option) }),
        },
      }
    }
    case 'clock.advance': {
      known(source, `${path}.${key}`, body, [])
      return { at, type: 'clock.advance', advance: {} }
    }
    case 'knowledge.source_sync': {
      known(source, `${path}.${key}`, body, ['ref', 'content'])
      return {
        at,
        type: 'knowledge.source_sync',
        source_sync: {
          ref: str(source, `${path}.${key}.ref`, body.ref),
          content: str(source, `${path}.${key}.content`, body.content),
        },
      }
    }
    case 'reconcile.run': {
      known(source, `${path}.${key}`, body, [])
      return { at, type: 'reconcile.run', reconcile: {} }
    }
    case 'process.restart': {
      known(source, `${path}.${key}`, body, [])
      return { at, type: 'process.restart', restart: {} }
    }
    case 'work.todo': {
      known(source, `${path}.${key}`, body, [
        'who',
        'title',
        'order',
        'collision',
        'distinct_reason',
      ])
      const collision = optStr(source, `${path}.${key}.collision`, body.collision)
      if (collision !== undefined && !['join', 'handoff', 'force'].includes(collision)) {
        fail(source, `${path}.${key}.collision`, 'collision 只能是 join / handoff / force')
      }
      return {
        at,
        type: 'work.todo',
        todo: {
          who: str(source, `${path}.${key}.who`, body.who),
          title: str(source, `${path}.${key}.title`, body.title),
          ...(body.order === undefined
            ? {}
            : { order: str(source, `${path}.${key}.order`, body.order) }),
          ...(collision === undefined
            ? {}
            : { collision: collision as 'join' | 'handoff' | 'force' }),
          ...(body.distinct_reason === undefined
            ? {}
            : {
                distinct_reason: str(
                  source,
                  `${path}.${key}.distinct_reason`,
                  body.distinct_reason,
                ),
              }),
        },
      }
    }
    case 'work.pool': {
      known(source, `${path}.${key}`, body, ['title', 'source'])
      return {
        at,
        type: 'work.pool',
        pool: {
          title: str(source, `${path}.${key}.title`, body.title),
          ...(body.source === undefined
            ? {}
            : { source: str(source, `${path}.${key}.source`, body.source) }),
        },
      }
    }
    case 'work.claim': {
      known(source, `${path}.${key}`, body, ['who', 'title'])
      return {
        at,
        type: 'work.claim',
        claim: {
          who: str(source, `${path}.${key}.who`, body.who),
          title: str(source, `${path}.${key}.title`, body.title),
        },
      }
    }
    case 'org.range_group': {
      known(source, `${path}.${key}`, body, ['id', 'name', 'members'])
      return {
        at,
        type: 'org.range_group',
        range_group: {
          id: str(source, `${path}.${key}.id`, body.id),
          name: str(source, `${path}.${key}.name`, body.name),
          members: rangeList(source, `${path}.${key}.members`, body.members ?? []),
        },
      }
    }
    case 'org.product_line': {
      known(source, `${path}.${key}`, body, ['id', 'name', 'parent', 'rule'])
      return {
        at,
        type: 'org.product_line',
        product_line: {
          id: str(source, `${path}.${key}.id`, body.id),
          name: str(source, `${path}.${key}.name`, body.name),
          parent: rangeRef(source, `${path}.${key}.parent`, body.parent),
          rule: lineRule(source, `${path}.${key}.rule`, body.rule),
        },
      }
    }
    case 'org.assign_range': {
      known(source, `${path}.${key}`, body, ['who', 'role', 'ranges', 'range_groups'])
      const groups = optStrList(source, `${path}.${key}.range_groups`, body.range_groups)
      return {
        at,
        type: 'org.assign_range',
        assign_range: {
          who: str(source, `${path}.${key}.who`, body.who),
          role: str(source, `${path}.${key}.role`, body.role),
          ...(body.ranges === undefined
            ? {}
            : { ranges: rangeList(source, `${path}.${key}.ranges`, body.ranges) }),
          ...(groups === undefined ? {} : { range_groups: groups }),
        },
      }
    }
    // WP65（52 O1）：开一个品牌工作区，并往里放几样真东西
    case 'org.brand': {
      known(source, `${path}.${key}`, body, [
        'id',
        'name',
        'who',
        'role',
        'card',
        'fact',
        'connection',
        // WP66（52 O3）：这个品牌自己那一套模型设置
        'model',
      ])
      const card = optStr(source, `${path}.${key}.card`, body.card)
      const fact = optStr(source, `${path}.${key}.fact`, body.fact)
      const connection = optStr(source, `${path}.${key}.connection`, body.connection)
      const model = optStr(source, `${path}.${key}.model`, body.model)
      return {
        at,
        type: 'org.brand',
        brand: {
          id: str(source, `${path}.${key}.id`, body.id),
          name: str(source, `${path}.${key}.name`, body.name),
          who: str(source, `${path}.${key}.who`, body.who),
          role: str(source, `${path}.${key}.role`, body.role),
          ...(card === undefined ? {} : { card }),
          ...(fact === undefined ? {} : { fact }),
          ...(connection === undefined ? {} : { connection }),
          ...(model === undefined ? {} : { model }),
        },
      }
    }
    // WP65（52 O2）：这个人在这个品牌里看得到什么
    case 'org.brand_check': {
      known(source, `${path}.${key}`, body, ['brand', 'who'])
      return {
        at,
        type: 'org.brand_check',
        brand_check: {
          brand: str(source, `${path}.${key}.brand`, body.brand),
          who: str(source, `${path}.${key}.who`, body.who),
        },
      }
    }
    case 'org.personal': {
      known(source, `${path}.${key}`, body, [
        'who',
        'workspace',
        'role',
        'range_groups',
        'product_lines',
      ])
      const groups = body.range_groups
      const lines = body.product_lines
      if (groups !== undefined && !Array.isArray(groups))
        fail(source, `${path}.${key}.range_groups`, '必须是列表')
      if (lines !== undefined && !Array.isArray(lines))
        fail(source, `${path}.${key}.product_lines`, '必须是列表')
      return {
        at,
        type: 'org.personal',
        personal: {
          who: str(source, `${path}.${key}.who`, body.who),
          workspace: str(source, `${path}.${key}.workspace`, body.workspace),
          role: str(source, `${path}.${key}.role`, body.role),
          ...(groups === undefined
            ? {}
            : {
                range_groups: (groups as unknown[]).map((g, i) => {
                  const at2 = `${path}.${key}.range_groups[${i}]`
                  if (!isRec(g)) fail(source, at2, '必须是对象')
                  known(source, at2, g, ['id', 'name', 'members'])
                  return {
                    id: str(source, `${at2}.id`, g.id),
                    name: str(source, `${at2}.name`, g.name),
                    members: rangeList(source, `${at2}.members`, g.members ?? []),
                  }
                }),
              }),
          ...(lines === undefined
            ? {}
            : {
                product_lines: (lines as unknown[]).map((l, i) => {
                  const at2 = `${path}.${key}.product_lines[${i}]`
                  if (!isRec(l)) fail(source, at2, '必须是对象')
                  known(source, at2, l, ['id', 'name', 'parent', 'rule'])
                  return {
                    id: str(source, `${at2}.id`, l.id),
                    name: str(source, `${at2}.name`, l.name),
                    parent: rangeRef(source, `${at2}.parent`, l.parent),
                    rule: lineRule(source, `${at2}.rule`, l.rule),
                  }
                }),
              }),
        },
      }
    }
    case 'org.join': {
      known(source, `${path}.${key}`, body, ['who', 'from', 'decisions'])
      const decisions = body.decisions
      if (decisions !== undefined && !Array.isArray(decisions))
        fail(source, `${path}.${key}.decisions`, '必须是列表')
      const RESOLUTIONS = [
        'merge_union',
        'adopt_company',
        'keep_both',
        'create_in_company',
        'skip',
      ] as const
      return {
        at,
        type: 'org.join',
        join: {
          who: str(source, `${path}.${key}.who`, body.who),
          from: str(source, `${path}.${key}.from`, body.from),
          ...(decisions === undefined
            ? {}
            : {
                decisions: (decisions as unknown[]).map((d, i) => {
                  const at2 = `${path}.${key}.decisions[${i}]`
                  if (!isRec(d)) fail(source, at2, '必须是对象')
                  known(source, at2, d, ['unique_key', 'chosen', 'name_choice'])
                  const chosen = str(source, `${at2}.chosen`, d.chosen)
                  if (!(RESOLUTIONS as readonly string[]).includes(chosen))
                    fail(source, `${at2}.chosen`, `只能是 ${RESOLUTIONS.join(' / ')}`)
                  const name = optStr(source, `${at2}.name_choice`, d.name_choice)
                  if (name !== undefined && name !== 'company' && name !== 'personal')
                    fail(source, `${at2}.name_choice`, '只能是 company / personal')
                  return {
                    unique_key: str(source, `${at2}.unique_key`, d.unique_key),
                    chosen: chosen as (typeof RESOLUTIONS)[number],
                    ...(name === undefined ? {} : { name_choice: name }),
                  }
                }),
              }),
        },
      }
    }
    case 'org.scope_check': {
      known(source, `${path}.${key}`, body, ['who', 'role'])
      return {
        at,
        type: 'org.scope_check',
        scope_check: {
          who: str(source, `${path}.${key}.who`, body.who),
          role: str(source, `${path}.${key}.role`, body.role),
        },
      }
    }
    case 'org.first_run': {
      known(source, `${path}.${key}`, body, ['side', 'who', 'legal_name', 'domain', 'discoverable'])
      const domain = optStr(source, `${path}.${key}.domain`, body.domain)
      const discoverable = body.discoverable
      if (discoverable !== undefined && typeof discoverable !== 'boolean') {
        fail(source, `${path}.${key}.discoverable`, '必须是 true / false')
      }
      return {
        at,
        type: 'org.first_run',
        first_run: {
          side: str(source, `${path}.${key}.side`, body.side),
          who: str(source, `${path}.${key}.who`, body.who),
          legal_name: str(source, `${path}.${key}.legal_name`, body.legal_name),
          ...(domain === undefined ? {} : { domain }),
          ...(discoverable === undefined ? {} : { discoverable }),
        },
      }
    }
    // WP62（51 §1 N0）：这个人这条职责在当前平台下"看得见什么、点得动什么"
    case 'org.platform_check': {
      known(source, `${path}.${key}`, body, ['who', 'role'])
      return {
        at,
        type: 'org.platform_check',
        platform_check: {
          who: str(source, `${path}.${key}.who`, body.who),
          role: str(source, `${path}.${key}.role`, body.role),
        },
      }
    }
    case 'org.join_request': {
      known(source, `${path}.${key}`, body, ['from', 'to', 'name', 'email'])
      return {
        at,
        type: 'org.join_request',
        join_request: {
          from: str(source, `${path}.${key}.from`, body.from),
          to: str(source, `${path}.${key}.to`, body.to),
          name: str(source, `${path}.${key}.name`, body.name),
          email: str(source, `${path}.${key}.email`, body.email),
        },
      }
    }
    case 'shop.price_change': {
      known(source, `${path}.${key}`, body, ['who', 'product', 'price', 'graphql', 'note'])
      return {
        at,
        type: 'shop.price_change',
        price_change: {
          who: str(source, `${path}.${key}.who`, body.who),
          product: str(source, `${path}.${key}.product`, body.product),
          price: num(source, `${path}.${key}.price`, body.price),
          ...(body.graphql === undefined
            ? {}
            : { graphql: str(source, `${path}.${key}.graphql`, body.graphql) }),
          ...(body.note === undefined
            ? {}
            : { note: str(source, `${path}.${key}.note`, body.note) }),
        },
      }
    }
    // WP64（51 §2.4）：超期未发的巡检与标记发货
    case 'fulfillment.sweep': {
      known(source, `${path}.${key}`, body, ['who'])
      return {
        at,
        type: 'fulfillment.sweep',
        sweep: { who: str(source, `${path}.${key}.who`, body.who) },
      }
    }
    case 'fulfillment.mark_shipped': {
      known(source, `${path}.${key}`, body, ['who', 'order', 'carrier', 'tracking', 'level'])
      const shipLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (shipLevel !== undefined && !['L1', 'L2', 'L3'].includes(shipLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'fulfillment.mark_shipped',
        ship: {
          who: str(source, `${path}.${key}.who`, body.who),
          carrier: str(source, `${path}.${key}.carrier`, body.carrier),
          tracking: str(source, `${path}.${key}.tracking`, body.tracking),
          ...(body.order === undefined
            ? {}
            : { order: str(source, `${path}.${key}.order`, body.order) }),
          ...(shipLevel === undefined ? {} : { level: shipLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    // WP64（51 §2.3）：退订与群发
    case 'email.unsubscribe': {
      known(source, `${path}.${key}`, body, ['email'])
      return {
        at,
        type: 'email.unsubscribe',
        unsubscribe: { email: str(source, `${path}.${key}.email`, body.email) },
      }
    }
    case 'email.campaign_send': {
      known(source, `${path}.${key}`, body, ['who', 'campaign', 'note', 'level'])
      const sendLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (sendLevel !== undefined && !['L1', 'L2', 'L3'].includes(sendLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'email.campaign_send',
        campaign_send: {
          who: str(source, `${path}.${key}.who`, body.who),
          campaign: str(source, `${path}.${key}.campaign`, body.campaign),
          ...(body.note === undefined
            ? {}
            : { note: str(source, `${path}.${key}.note`, body.note) }),
          ...(sendLevel === undefined ? {} : { level: sendLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    // WP76（58 §1）：设计岗位那三件事
    case 'design.request': {
      known(source, `${path}.${key}`, body, ['who', 'from', 'title', 'need', 'specs'])
      return {
        at,
        type: 'design.request',
        design_request: {
          who: str(source, `${path}.${key}.who`, body.who),
          from: str(source, `${path}.${key}.from`, body.from),
          title: str(source, `${path}.${key}.title`, body.title),
          need: str(source, `${path}.${key}.need`, body.need),
          ...(body.specs === undefined
            ? {}
            : { specs: strList(source, `${path}.${key}.specs`, body.specs) }),
        },
      }
    }
    case 'design.variants': {
      known(source, `${path}.${key}`, body, ['who', 'brief_id', 'n', 'image_model', 'level'])
      const vLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (vLevel !== undefined && !['L1', 'L2', 'L3'].includes(vLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'design.variants',
        design_variants: {
          who: str(source, `${path}.${key}.who`, body.who),
          ...(body.brief_id === undefined
            ? {}
            : { brief_id: str(source, `${path}.${key}.brief_id`, body.brief_id) }),
          ...(body.n === undefined ? {} : { n: num(source, `${path}.${key}.n`, body.n) }),
          ...(body.image_model === undefined
            ? {}
            : { image_model: requireBool(source, `${path}.${key}.image_model`, body.image_model) }),
          ...(vLevel === undefined ? {} : { level: vLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'design.pick': {
      known(source, `${path}.${key}`, body, ['who', 'asset_id', 'level', 'without_pick'])
      const pLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (pLevel !== undefined && !['L1', 'L2', 'L3'].includes(pLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'design.pick',
        design_pick: {
          who: str(source, `${path}.${key}.who`, body.who),
          ...(body.asset_id === undefined
            ? {}
            : { asset_id: str(source, `${path}.${key}.asset_id`, body.asset_id) }),
          ...(pLevel === undefined ? {} : { level: pLevel as 'L1' | 'L2' | 'L3' }),
          ...(body.without_pick === undefined
            ? {}
            : { without_pick: requireBool(source, `${path}.${key}.without_pick`, body.without_pick) }),
        },
      }
    }
    // WP72（56 §2 / §4）：社媒运营那三件事
    case 'social.post': {
      known(source, `${path}.${key}`, body, ['who', 'channel', 'body', 'scheduled_at', 'level'])
      const postLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (postLevel !== undefined && !['L1', 'L2', 'L3'].includes(postLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'social.post',
        post: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          body: str(source, `${path}.${key}.body`, body.body),
          ...(body.scheduled_at === undefined
            ? {}
            : { scheduled_at: str(source, `${path}.${key}.scheduled_at`, body.scheduled_at) }),
          ...(postLevel === undefined ? {} : { level: postLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'social.reply': {
      known(source, `${path}.${key}`, body, [
        'who',
        'channel',
        'author',
        'text',
        'draft',
        'surface',
        'level',
      ])
      const surface = optStr(source, `${path}.${key}.surface`, body.surface)
      if (surface !== undefined && !['comment', 'thread', 'dm'].includes(surface)) {
        fail(source, `${path}.${key}.surface`, 'surface 只能是 comment / thread / dm')
      }
      const replyLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (replyLevel !== undefined && !['L1', 'L2', 'L3'].includes(replyLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'social.reply',
        reply: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          author: str(source, `${path}.${key}.author`, body.author),
          text: str(source, `${path}.${key}.text`, body.text),
          draft: str(source, `${path}.${key}.draft`, body.draft),
          ...(surface === undefined ? {} : { surface: surface as 'comment' | 'thread' | 'dm' }),
          ...(replyLevel === undefined ? {} : { level: replyLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'community.broadcast': {
      known(source, `${path}.${key}`, body, ['who', 'channel', 'body', 'members', 'level'])
      const bcLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (bcLevel !== undefined && !['L1', 'L2', 'L3'].includes(bcLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'community.broadcast',
        broadcast: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          body: str(source, `${path}.${key}.body`, body.body),
          members: strList(source, `${path}.${key}.members`, body.members),
          ...(bcLevel === undefined ? {} : { level: bcLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    // WP73（56 §6）：社群组那三条写动作
    case 'community.approve_member': {
      known(source, `${path}.${key}`, body, ['who', 'channel', 'member', 'answers', 'level'])
      const lvl = optStr(source, `${path}.${key}.level`, body.level)
      if (lvl !== undefined && !['L1', 'L2', 'L3'].includes(lvl)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'community.approve_member',
        approve_member: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          member: str(source, `${path}.${key}.member`, body.member),
          ...(body.answers === undefined
            ? {}
            : { answers: strList(source, `${path}.${key}.answers`, body.answers) }),
          ...(lvl === undefined ? {} : { level: lvl as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'community.moderate': {
      known(source, `${path}.${key}`, body, [
        'who',
        'channel',
        'target',
        'action',
        'reason',
        'level',
      ])
      const action = str(source, `${path}.${key}.action`, body.action)
      if (!['warn', 'delete_post', 'mute', 'ban', 'permanent_ban'].includes(action)) {
        fail(
          source,
          `${path}.${key}.action`,
          'action 只能是 warn / delete_post / mute / ban / permanent_ban',
        )
      }
      const modLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (modLevel !== undefined && !['L1', 'L2', 'L3'].includes(modLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'community.moderate',
        moderate: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          target: str(source, `${path}.${key}.target`, body.target),
          action: action as 'warn' | 'delete_post' | 'mute' | 'ban' | 'permanent_ban',
          ...(body.reason === undefined
            ? {}
            : { reason: str(source, `${path}.${key}.reason`, body.reason) }),
          ...(modLevel === undefined ? {} : { level: modLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'community.rules_edit': {
      known(source, `${path}.${key}`, body, ['who', 'channel', 'rules', 'level'])
      const rulesLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (rulesLevel !== undefined && !['L1', 'L2', 'L3'].includes(rulesLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'community.rules_edit',
        rules_edit: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          rules: str(source, `${path}.${key}.rules`, body.rules),
          ...(rulesLevel === undefined ? {} : { level: rulesLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    // WP67（48 §5.1）：红人营销那几件事
    case 'kol.outreach': {
      known(source, `${path}.${key}`, body, ['who', 'creator', 'draft'])
      return {
        at,
        type: 'kol.outreach',
        outreach: {
          who: str(source, `${path}.${key}.who`, body.who),
          creator: str(source, `${path}.${key}.creator`, body.creator),
          draft: str(source, `${path}.${key}.draft`, body.draft),
        },
      }
    }
    case 'kol.collaboration': {
      known(source, `${path}.${key}`, body, ['who', 'creator', 'budget', 'level'])
      const collabLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (collabLevel !== undefined && !['L1', 'L2', 'L3'].includes(collabLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'kol.collaboration',
        collaboration: {
          who: str(source, `${path}.${key}.who`, body.who),
          creator: str(source, `${path}.${key}.creator`, body.creator),
          budget: num(source, `${path}.${key}.budget`, body.budget),
          ...(collabLevel === undefined ? {} : { level: collabLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'kol.tracked_link': {
      known(source, `${path}.${key}`, body, ['who', 'creator', 'code'])
      return {
        at,
        type: 'kol.tracked_link',
        tracked_link: {
          who: str(source, `${path}.${key}.who`, body.who),
          creator: str(source, `${path}.${key}.creator`, body.creator),
          code: str(source, `${path}.${key}.code`, body.code),
        },
      }
    }
    case 'kol.affiliate_order': {
      known(source, `${path}.${key}`, body, ['order', 'code'])
      return {
        at,
        type: 'kol.affiliate_order',
        affiliate_order: {
          order: str(source, `${path}.${key}.order`, body.order),
          code: str(source, `${path}.${key}.code`, body.code),
        },
      }
    }
    case 'kol.attribution': {
      known(source, `${path}.${key}`, body, ['who'])
      return {
        at,
        type: 'kol.attribution',
        attribution: { who: str(source, `${path}.${key}.who`, body.who) },
      }
    }
    // WP68（48 §5.2 / §5.3）：campaign 向导与云端公共库
    case 'kol.creator': {
      known(source, `${path}.${key}`, body, [
        'channel',
        'handle',
        'followers',
        'engagement_rate',
        'category',
      ])
      return {
        at,
        type: 'kol.creator',
        creator: {
          channel: str(source, `${path}.${key}.channel`, body.channel),
          handle: str(source, `${path}.${key}.handle`, body.handle),
          followers: num(source, `${path}.${key}.followers`, body.followers),
          ...(body.engagement_rate === undefined
            ? {}
            : {
                engagement_rate: num(
                  source,
                  `${path}.${key}.engagement_rate`,
                  body.engagement_rate,
                ),
              }),
          ...(body.category === undefined
            ? {}
            : { category: str(source, `${path}.${key}.category`, body.category) }),
        },
      }
    }
    case 'kol.campaign': {
      known(source, `${path}.${key}`, body, ['who', 'goal', 'budget', 'channels', 'headcount'])
      const channels = body.channels
      if (!Array.isArray(channels) || channels.length === 0)
        fail(source, `${path}.${key}.channels`, 'channels 要是一个非空数组')
      return {
        at,
        type: 'kol.campaign',
        campaign: {
          who: str(source, `${path}.${key}.who`, body.who),
          goal: str(source, `${path}.${key}.goal`, body.goal),
          budget: num(source, `${path}.${key}.budget`, body.budget),
          channels: (channels as unknown[]).map((c, i) =>
            str(source, `${path}.${key}.channels[${i}]`, c),
          ),
          headcount: num(source, `${path}.${key}.headcount`, body.headcount),
        },
      }
    }
    case 'kol.public_creator': {
      known(source, `${path}.${key}`, body, [
        'channel',
        'handle',
        'followers',
        'engagement_rate',
        'email',
      ])
      return {
        at,
        type: 'kol.public_creator',
        public_creator: {
          channel: str(source, `${path}.${key}.channel`, body.channel),
          handle: str(source, `${path}.${key}.handle`, body.handle),
          followers: num(source, `${path}.${key}.followers`, body.followers),
          ...(body.engagement_rate === undefined
            ? {}
            : {
                engagement_rate: num(
                  source,
                  `${path}.${key}.engagement_rate`,
                  body.engagement_rate,
                ),
              }),
          ...(body.email === undefined
            ? {}
            : { email: str(source, `${path}.${key}.email`, body.email) }),
        },
      }
    }
    case 'kol.public_reveal': {
      known(source, `${path}.${key}`, body, ['who', 'channel', 'handle', 'topup'])
      return {
        at,
        type: 'kol.public_reveal',
        public_reveal: {
          who: str(source, `${path}.${key}.who`, body.who),
          channel: str(source, `${path}.${key}.channel`, body.channel),
          handle: str(source, `${path}.${key}.handle`, body.handle),
          ...(body.topup === undefined
            ? {}
            : { topup: num(source, `${path}.${key}.topup`, body.topup) }),
        },
      }
    }
    case 'shop.publish_product': {
      known(source, `${path}.${key}`, body, ['who', 'product', 'publish', 'level', 'note'])
      const level = optStr(source, `${path}.${key}.level`, body.level)
      if (level !== undefined && !['L1', 'L2', 'L3'].includes(level)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'shop.publish_product',
        publish_product: {
          who: str(source, `${path}.${key}.who`, body.who),
          product: str(source, `${path}.${key}.product`, body.product),
          ...(body.publish === undefined
            ? {}
            : { publish: requireBool(source, `${path}.${key}.publish`, body.publish) }),
          ...(level === undefined ? {} : { level: level as 'L1' | 'L2' | 'L3' }),
          ...(body.note === undefined
            ? {}
            : { note: str(source, `${path}.${key}.note`, body.note) }),
        },
      }
    }
    case 'content.blog_post': {
      known(source, `${path}.${key}`, body, ['who', 'title', 'publish', 'article', 'body'])
      return {
        at,
        type: 'content.blog_post',
        blog_post: {
          who: str(source, `${path}.${key}.who`, body.who),
          title: str(source, `${path}.${key}.title`, body.title),
          ...(body.publish === undefined
            ? {}
            : { publish: requireBool(source, `${path}.${key}.publish`, body.publish) }),
          ...(body.article === undefined
            ? {}
            : { article: str(source, `${path}.${key}.article`, body.article) }),
          ...(body.body === undefined
            ? {}
            : { body: str(source, `${path}.${key}.body`, body.body) }),
        },
      }
    }
    case 'store.daily_report': {
      known(source, `${path}.${key}`, body, ['who'])
      return {
        at,
        type: 'store.daily_report',
        daily_report: { who: str(source, `${path}.${key}.who`, body.who) },
      }
    }
    case 'shop.theme_push': {
      known(source, `${path}.${key}`, body, ['who', 'name'])
      return {
        at,
        type: 'shop.theme_push',
        theme_push: {
          who: str(source, `${path}.${key}.who`, body.who),
          name: str(source, `${path}.${key}.name`, body.name),
        },
      }
    }
    case 'shop.theme_publish': {
      known(source, `${path}.${key}`, body, ['who', 'theme', 'level'])
      const themeLevel = optStr(source, `${path}.${key}.level`, body.level)
      if (themeLevel !== undefined && !['L1', 'L2', 'L3'].includes(themeLevel)) {
        fail(source, `${path}.${key}.level`, 'level 只能是 L1 / L2 / L3')
      }
      return {
        at,
        type: 'shop.theme_publish',
        theme_publish: {
          who: str(source, `${path}.${key}.who`, body.who),
          ...(body.theme === undefined
            ? {}
            : { theme: str(source, `${path}.${key}.theme`, body.theme) }),
          ...(themeLevel === undefined ? {} : { level: themeLevel as 'L1' | 'L2' | 'L3' }),
        },
      }
    }
    case 'secretary.profile': {
      known(source, `${path}.${key}`, body, ['who', 'field', 'level'])
      const level = str(source, `${path}.${key}.level`, body.level)
      if (!['self', 'colleagues', 'workspace'].includes(level))
        fail(source, `${path}.${key}.level`, 'level 只能是 self / colleagues / workspace')
      return {
        at,
        type: 'secretary.profile',
        profile: {
          who: str(source, `${path}.${key}.who`, body.who),
          field: str(source, `${path}.${key}.field`, body.field),
          level,
        },
      }
    }
    case 'secretary.ask': {
      known(source, `${path}.${key}`, body, ['who', 'about', 'question'])
      return {
        at,
        type: 'secretary.ask',
        ask: {
          who: str(source, `${path}.${key}.who`, body.who),
          about: str(source, `${path}.${key}.about`, body.about),
          question: str(source, `${path}.${key}.question`, body.question),
        },
      }
    }
    case 'secretary.meet': {
      known(source, `${path}.${key}`, body, ['who', 'with', 'slot', 'minutes', 'title'])
      return {
        at,
        type: 'secretary.meet',
        meet: {
          who: str(source, `${path}.${key}.who`, body.who),
          with: str(source, `${path}.${key}.with`, body.with),
          slot: str(source, `${path}.${key}.slot`, body.slot),
          ...(body.minutes === undefined
            ? {}
            : { minutes: num(source, `${path}.${key}.minutes`, body.minutes) }),
          ...(body.title === undefined
            ? {}
            : { title: str(source, `${path}.${key}.title`, body.title) }),
        },
      }
    }
    case 'secretary.meet_decide': {
      known(source, `${path}.${key}`, body, ['who', 'action'])
      const action = str(source, `${path}.${key}.action`, body.action)
      if (action !== 'accept' && action !== 'decline')
        fail(source, `${path}.${key}.action`, 'action 只能是 accept / decline')
      return {
        at,
        type: 'secretary.meet_decide',
        decide_meet: { who: str(source, `${path}.${key}.who`, body.who), action },
      }
    }
    case 'secretary.route': {
      known(source, `${path}.${key}`, body, ['who', 'text'])
      return {
        at,
        type: 'secretary.route',
        route: {
          who: str(source, `${path}.${key}.who`, body.who),
          text: str(source, `${path}.${key}.text`, body.text),
        },
      }
    }
    // ── WP69（54）：岗位是任务主入口 ──
    case 'position.staff': {
      known(source, `${path}.${key}`, body, ['who', 'position'])
      return {
        at,
        type: 'position.staff',
        staff: {
          who: str(source, `${path}.${key}.who`, body.who),
          position: str(source, `${path}.${key}.position`, body.position),
        },
      }
    }
    case 'position.open': {
      known(source, `${path}.${key}`, body, ['who', 'position', 'text'])
      return {
        at,
        type: 'position.open',
        open_at_position: {
          who: str(source, `${path}.${key}.who`, body.who),
          position: str(source, `${path}.${key}.position`, body.position),
          text: str(source, `${path}.${key}.text`, body.text),
        },
      }
    }
    case 'chat.visitor_message': {
      known(source, `${path}.${key}`, body, ['visitor', 'text'])
      return {
        at,
        type: 'chat.visitor_message',
        chat_message: {
          visitor: str(source, `${path}.${key}.visitor`, body.visitor),
          text: str(source, `${path}.${key}.text`, body.text),
        },
      }
    }
    case 'chat.human_takeover': {
      known(source, `${path}.${key}`, body, ['visitor', 'on'])
      return {
        at,
        type: 'chat.human_takeover',
        chat_takeover: {
          on: requireBool(source, `${path}.${key}.on`, body.on),
          ...(body.visitor === undefined
            ? {}
            : { visitor: str(source, `${path}.${key}.visitor`, body.visitor) }),
        },
      }
    }
    case 'work.idle_sweep': {
      known(source, `${path}.${key}`, body, ['idle_days'])
      return {
        at,
        type: 'work.idle_sweep',
        idle: {
          ...(body.idle_days === undefined
            ? {}
            : { idle_days: num(source, `${path}.${key}.idle_days`, body.idle_days) }),
        },
      }
    }
    case 'inject.fault': {
      known(source, `${path}.${key}`, body, ['action', 'code', 'times'])
      const code = body.code
      if (code !== 429 && code !== 500 && code !== 'timeout') {
        fail(source, `${path}.${key}.code`, 'code 只能是 429 / 500 / timeout')
      }
      return {
        at,
        type: 'inject.fault',
        fault: {
          action: str(source, `${path}.${key}.action`, body.action),
          code,
          times: num(source, `${path}.${key}.times`, body.times),
        },
      }
    }
    case 'routine.start': {
      known(source, `${path}.${key}`, body, ['plan_hour', 'review_hour'])
      return {
        at,
        type: 'routine.start',
        routine: {
          ...(body.plan_hour === undefined
            ? {}
            : { plan_hour: num(source, `${path}.${key}.plan_hour`, body.plan_hour) }),
          ...(body.review_hour === undefined
            ? {}
            : { review_hour: num(source, `${path}.${key}.review_hour`, body.review_hour) }),
        },
      }
    }
    case 'learning.start': {
      known(source, `${path}.${key}`, body, ['propose_hour', 'propose_minute'])
      return {
        at,
        type: 'learning.start',
        learning: {
          ...(body.propose_hour === undefined
            ? {}
            : { propose_hour: num(source, `${path}.${key}.propose_hour`, body.propose_hour) }),
          ...(body.propose_minute === undefined
            ? {}
            : {
                propose_minute: num(source, `${path}.${key}.propose_minute`, body.propose_minute),
              }),
        },
      }
    }
    case 'model.outage': {
      known(source, `${path}.${key}`, body, ['duration'])
      const duration = optStr(source, `${path}.${key}.duration`, body.duration)
      if (duration !== undefined) parseDuration(duration)
      return { at, type: 'model.outage', outage: duration === undefined ? {} : { duration } }
    }
    default: {
      known(source, `${path}.${key}`, body, [
        'workspace_daily_base',
        'workspace_monthly_base',
        'assignment_daily_base',
      ])
      return {
        at,
        type: 'inject.budget',
        budget: {
          ...(body.workspace_daily_base === undefined
            ? {}
            : {
                workspace_daily_base: num(
                  source,
                  `${path}.${key}.workspace_daily_base`,
                  body.workspace_daily_base,
                ),
              }),
          ...(body.workspace_monthly_base === undefined
            ? {}
            : {
                workspace_monthly_base: num(
                  source,
                  `${path}.${key}.workspace_monthly_base`,
                  body.workspace_monthly_base,
                ),
              }),
          ...(body.assignment_daily_base === undefined
            ? {}
            : {
                assignment_daily_base: num(
                  source,
                  `${path}.${key}.assignment_daily_base`,
                  body.assignment_daily_base,
                ),
              }),
        },
      }
    }
  }
}

/**
 * 一块**结构化断言**（`expected.kol_outreach` 那一类）的通用解析。
 *
 * WP72 补的这一刀修的是一个**真洞**：这几块的键早就在 `EXPECTED_KEYS` 里
 * （所以 `known()` 放行），却从来没有人把它们抄进 `out`——于是场景里写的
 * `kol_outreach: { rewritten: true }` 一路被静默丢掉，断言等于没写。
 * 一条永远为真的断言比没有断言更糟：它让人以为那件事验过了。
 *
 * `spec` 说每一格是什么形状：`bool` / `str` / `strs` / `num`（数值断言，
 * 允许 `'>=1'` 这种写法）。不认识的键当场报错——拼错一个字段名不该被忽略。
 */
function shaped(
  source: string,
  key: string,
  raw: unknown,
  spec: Record<string, 'bool' | 'str' | 'strs' | 'num'>,
): Record<string, unknown> | undefined {
  if (raw === undefined) return undefined
  const path = `expected.${key}`
  if (!isRec(raw)) fail(source, path, '必须是对象')
  known(source, path, raw, Object.keys(spec))
  const out: Record<string, unknown> = {}
  for (const [name, kind] of Object.entries(spec)) {
    const v = raw[name]
    if (v === undefined) continue
    const at = `${path}.${name}`
    out[name] =
      kind === 'bool'
        ? requireBool(source, at, v)
        : kind === 'str'
          ? str(source, at, v)
          : kind === 'strs'
            ? strList(source, at, v)
            : numeric(source, at, v)
  }
  return out
}

function parseExpected(source: string, raw: unknown): ScenarioExpected {
  if (raw === undefined || raw === null) return {}
  if (!isRec(raw)) fail(source, 'expected', '必须是对象')
  known(source, 'expected', raw, EXPECTED_KEYS)
  const out: ScenarioExpected = {}
  const calls = optStrList(source, 'expected.calls_tool', raw.calls_tool)
  if (calls !== undefined) out.calls_tool = calls
  const first = optStr(source, 'expected.first_tool', raw.first_tool)
  if (first !== undefined) out.first_tool = first
  const never = optStrList(source, 'expected.never_calls', raw.never_calls)
  if (never !== undefined) out.never_calls = never
  const kinds = optStrList(source, 'expected.staged_change_kinds', raw.staged_change_kinds)
  if (kinds !== undefined) out.staged_change_kinds = kinds as ChangeKind[]
  const before = optStr(source, 'expected.no_applied_changes_before', raw.no_applied_changes_before)
  if (before !== undefined) out.no_applied_changes_before = before
  if (raw.approval_items !== undefined) {
    const ai = raw.approval_items
    if (!isRec(ai)) fail(source, 'expected.approval_items', '必须是对象')
    known(source, 'expected.approval_items', ai, ['kind', 'count', 'children'])
    out.approval_items = {
      kind: str(source, 'expected.approval_items.kind', ai.kind),
      ...(ai.count === undefined
        ? {}
        : { count: numeric(source, 'expected.approval_items.count', ai.count) }),
      ...(ai.children === undefined
        ? {}
        : { children: strList(source, 'expected.approval_items.children', ai.children) }),
    }
  }
  const omits = optStrList(source, 'expected.reply_omits', raw.reply_omits)
  if (omits !== undefined) out.reply_omits = omits
  const includes = optStrList(source, 'expected.reply_includes_any', raw.reply_includes_any)
  if (includes !== undefined) out.reply_includes_any = includes
  const mem = optStrList(source, 'expected.memory_contains', raw.memory_contains)
  if (mem !== undefined) out.memory_contains = mem
  if (raw.max_tool_calls !== undefined) {
    out.max_tool_calls = num(source, 'expected.max_tool_calls', raw.max_tool_calls)
  }
  if (raw.metrics !== undefined) {
    const m = raw.metrics
    if (!isRec(m)) fail(source, 'expected.metrics', '必须是对象')
    const metrics: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(m)) metrics[k] = numeric(source, `expected.metrics.${k}`, v)
    out.metrics = metrics
  }
  const codes = optStrList(source, 'expected.run_failed_codes', raw.run_failed_codes)
  if (codes !== undefined) out.run_failed_codes = codes
  const notified = optStrList(source, 'expected.notifications_to', raw.notifications_to)
  if (notified !== undefined) out.notifications_to = notified
  const blocked = optStrList(source, 'expected.blocked_rules', raw.blocked_rules)
  if (blocked !== undefined) out.blocked_rules = blocked
  const routedTo = optStrList(source, 'expected.routed_to', raw.routed_to)
  if (routedTo !== undefined) out.routed_to = routedTo
  // WP69（54 §2）：岗位内路由落到了哪几条职责
  const positionRoutedTo = optStrList(source, 'expected.position_routed_to', raw.position_routed_to)
  if (positionRoutedTo !== undefined) out.position_routed_to = positionRoutedTo
  const secretaryKinds = optStrList(source, 'expected.secretary_kinds', raw.secretary_kinds)
  if (secretaryKinds !== undefined) out.secretary_kinds = secretaryKinds
  const disjoint = optStrList(source, 'expected.scope_disjoint', raw.scope_disjoint)
  if (disjoint !== undefined) out.scope_disjoint = disjoint
  // WP62（51 §1 N0）：这几个人该在面板、工具、首次设置清单三处都被明确告知"平台还没接"
  const platformUnsupported = optStrList(
    source,
    'expected.platform_unsupported',
    raw.platform_unsupported,
  )
  if (platformUnsupported !== undefined) out.platform_unsupported = platformUnsupported
  // WP57：这几轮聊天各判成了什么（按顺序），以及求助超时各做了几次
  const chatActions = optStrList(source, 'expected.chat_actions', raw.chat_actions)
  if (chatActions !== undefined) {
    for (const a of chatActions) {
      if (!CHAT_ACTIONS.includes(a)) {
        fail(
          source,
          'expected.chat_actions',
          `聊天只有五种动作：${CHAT_ACTIONS.join(' / ')}；不是 ${a}`,
        )
      }
    }
    out.chat_actions = chatActions
  }
  if (raw.chat_assist !== undefined) {
    const a = raw.chat_assist
    if (!isRec(a)) fail(source, 'expected.chat_assist', '必须是对象')
    const counts: Record<string, number | string> = {}
    for (const [name, v] of Object.entries(a)) {
      if (!['reminder', 'email_follow_up'].includes(name)) {
        fail(source, 'expected.chat_assist', `只有 reminder / email_follow_up：${name}`)
      }
      counts[name] = numeric(source, `expected.chat_assist.${name}`, v)
    }
    out.chat_assist = counts
  }
  if (raw.sub_channel !== undefined) {
    out.sub_channel = str(source, 'expected.sub_channel', raw.sub_channel)
  }
  const gatesFailed = optStrList(source, 'expected.gates_failed', raw.gates_failed)
  if (gatesFailed !== undefined) out.gates_failed = gatesFailed
  // WP63（51 §2.1 数据日报）：出了几张日报卡、卡面上那几个数
  if (raw.daily_reports !== undefined) {
    out.daily_reports = numeric(source, 'expected.daily_reports', raw.daily_reports)
  }
  if (raw.daily_report_figures !== undefined) {
    const f = raw.daily_report_figures
    if (!isRec(f)) fail(source, 'expected.daily_report_figures', '必须是对象')
    const figures: Record<string, number | string> = {}
    for (const [name, v] of Object.entries(f)) {
      if (!['sales', 'orders', 'low_stock', 'pending'].includes(name)) {
        fail(
          source,
          'expected.daily_report_figures',
          `只有 sales / orders / low_stock / pending：${name}`,
        )
      }
      figures[name] = numeric(source, `expected.daily_report_figures.${name}`, v)
    }
    out.daily_report_figures = figures
  }
  const eventTypes = optStrList(source, 'expected.event_types', raw.event_types)
  if (eventTypes !== undefined) out.event_types = eventTypes
  if (raw.approval_kinds !== undefined) {
    const k = raw.approval_kinds
    if (!isRec(k)) fail(source, 'expected.approval_kinds', '必须是对象')
    const kinds: Record<string, number | string> = {}
    for (const [name, v] of Object.entries(k)) {
      kinds[name] = numeric(source, `expected.approval_kinds.${name}`, v)
    }
    out.approval_kinds = kinds
  }
  const handlers = optStrList(source, 'expected.scheduled_handlers', raw.scheduled_handlers)
  if (handlers !== undefined) out.scheduled_handlers = handlers
  const promptIncludes = optStrList(source, 'expected.prompt_includes_any', raw.prompt_includes_any)
  if (promptIncludes !== undefined) out.prompt_includes_any = promptIncludes
  const lessonsFiltered = optStrList(source, 'expected.lessons_filtered', raw.lessons_filtered)
  if (lessonsFiltered !== undefined) out.lessons_filtered = lessonsFiltered
  if (raw.lessons_pooled !== undefined) {
    out.lessons_pooled = numeric(source, 'expected.lessons_pooled', raw.lessons_pooled)
  }
  const tiersEscalated = optStrList(source, 'expected.escalated_tiers', raw.escalated_tiers)
  if (tiersEscalated !== undefined) {
    for (const t of tiersEscalated) {
      if (!['scope_manager', 'owner'].includes(t)) {
        fail(source, 'expected.escalated_tiers', `升级链只有 scope_manager / owner：${t}`)
      }
    }
    out.escalated_tiers = tiersEscalated
  }
  const escalatedTo = optStrList(source, 'expected.escalated_to', raw.escalated_to)
  if (escalatedTo !== undefined) out.escalated_to = escalatedTo
  if (raw.sampled !== undefined) out.sampled = numeric(source, 'expected.sampled', raw.sampled)
  if (raw.auto_approved !== undefined) {
    out.auto_approved = numeric(source, 'expected.auto_approved', raw.auto_approved)
  }
  if (raw.judge_min_score !== undefined) {
    const v = num(source, 'expected.judge_min_score', raw.judge_min_score)
    if (v < 0 || v > 1) fail(source, 'expected.judge_min_score', '必须在 [0, 1]')
    out.judge_min_score = v
  }
  const notUnioned = optStrList(
    source,
    'expected.assignments_not_unioned',
    raw.assignments_not_unioned,
  )
  if (notUnioned !== undefined) out.assignments_not_unioned = notUnioned

  /*
   * 结构化断言（WP64 / WP67 / WP68 / WP72 那几块）。
   *
   * WP72 之前这几块**一个都没抄进来**（见 {@link shaped} 的注释）——写了等于没写。
   * 现在一次补齐，顺序照 `EXPECTED_KEYS`。
   */
  const shapes: Record<string, Record<string, 'bool' | 'str' | 'strs' | 'num'>> = {
    overdue_orders: { count: 'num', worst_days: 'num' },
    campaign_send: {
      requested_level: 'str',
      auto_approved: 'bool',
      audience_size: 'num',
      suppressed_removed: 'num',
      stated_on_card: 'bool',
    },
    kol_outreach: {
      forbidden_hits: 'strs',
      rewritten: 'bool',
      auto_approved: 'bool',
      suppressed_removed: 'num',
    },
    kol_collaboration: { requested_level: 'str', auto_approved: 'bool', budget: 'num' },
    kol_attribution: { matched: 'num', unmatched: 'num', revenue: 'num', basis: 'strs' },
    kol_campaign: {
      picks: 'num',
      allowed_channels: 'strs',
      blocked_channels: 'strs',
      created: 'num',
    },
    /*
     * `kol_reveal` **故意还没接上**。
     *
     * 接上去当场红一条：`public-library-reveal-charges-credits.yml` 写着
     * `first_refused: true`（一分钱没充那一次该被拦），而世界里那一次**取到了**
     * ——钱包有免费额度，所以"钱不够"根本没发生。
     *
     * 那是 WP68 的语义问题（该不该有免费额度、免费额度下这条题要验什么），
     * 不是 WP72 能定的。所以这一条原地留着，记进 docs/35 等 Luoye 定：
     * 是钱包该拦，还是那句断言该改。改完把这一格接上来，一行的事。
     */
    // WP72（56 §2 / §4）
    social_post: {
      requested_level: 'str',
      auto_approved: 'bool',
      scheduled_at: 'str',
      stated_on_card: 'bool',
    },
    social_reply: {
      triage: 'str',
      commitment_hits: 'strs',
      rewritten: 'bool',
      auto_approved: 'bool',
    },
    community_handoff: {
      triage: 'str',
      routed_to: 'str',
      answered_by_social: 'bool',
      held: 'bool',
    },
    community_broadcast: {
      requested_level: 'str',
      auto_approved: 'bool',
      audience: 'num',
      suppressed_removed: 'num',
      stated_on_card: 'bool',
    },
    // WP73（56 §6）
    community_membership: {
      requested_level: 'str',
      auto_approved: 'bool',
      answers_on_card: 'bool',
    },
    community_moderation: {
      action: 'str',
      requested_level: 'str',
      auto_approved: 'bool',
    },
    community_rules: {
      requested_level: 'str',
      auto_approved: 'bool',
      stated_on_card: 'bool',
    },
    social_calendar: {
      conflict_kinds: 'strs',
      stated_on_card: 'bool',
    },
  }
  const bag = out as unknown as Record<string, unknown>
  for (const [key, spec] of Object.entries(shapes)) {
    const parsed = shaped(source, key, raw[key], spec)
    if (parsed !== undefined) bag[key] = parsed
  }
  return out
}

const TIER_NAMES = ['fast', 'realistic', 'soak'] as const

function parsePolicy(source: string, raw: unknown): ScenarioTxnPolicy {
  if (!isRec(raw)) fail(source, 'policy', '必须是对象')
  known(source, 'policy', raw, ['escalation_hours', 'sampling_rate', 'expiry_days'])
  const out: ScenarioTxnPolicy = {}
  if (raw.escalation_hours !== undefined) {
    const e = raw.escalation_hours
    if (!isRec(e)) fail(source, 'policy.escalation_hours', '必须是对象')
    known(source, 'policy.escalation_hours', e, ['scope_manager', 'owner'])
    out.escalation_hours = {
      ...(e.scope_manager === undefined
        ? {}
        : { scope_manager: num(source, 'policy.escalation_hours.scope_manager', e.scope_manager) }),
      ...(e.owner === undefined
        ? {}
        : { owner: num(source, 'policy.escalation_hours.owner', e.owner) }),
    }
  }
  if (raw.sampling_rate !== undefined) {
    const v = num(source, 'policy.sampling_rate', raw.sampling_rate)
    if (v < 0 || v > 1) fail(source, 'policy.sampling_rate', '必须在 [0, 1]')
    out.sampling_rate = v
  }
  if (raw.expiry_days !== undefined) {
    const d = raw.expiry_days
    if (!isRec(d)) fail(source, 'policy.expiry_days', '必须是对象')
    const days: Record<string, number> = {}
    for (const [k, v] of Object.entries(d)) days[k] = num(source, `policy.expiry_days.${k}`, v)
    out.expiry_days = days
  }
  return out
}

/** 从 YAML 文本解析一条场景。 */
export function parseScenario(text: string, source = '<string>'): Scenario {
  let doc: unknown
  try {
    doc = parseYaml(text)
  } catch (error) {
    fail(source, '', `YAML 解析失败：${(error as Error).message}`)
  }
  if (!isRec(doc)) fail(source, '', '场景文件必须是一个对象')
  known(source, '', doc, [
    'id',
    'version',
    'dataset',
    'actors',
    'stand_ins',
    'clock',
    'events',
    'expected',
    'invariants',
    'rubric',
    'hidden',
    'control_for',
    'policy',
    'tiers',
  ])

  const id = str(source, 'id', doc.id)
  if (doc.version !== 1) fail(source, 'version', '目前只支持 version: 1')

  if (!isRec(doc.dataset)) fail(source, 'dataset', '必须是对象')
  known(source, 'dataset', doc.dataset, ['pack', 'seed', 'vertical', 'storefront_platform'])
  const verticalRaw = optStr(source, 'dataset.vertical', doc.dataset.vertical)
  if (verticalRaw !== undefined && verticalRaw !== 'goods' && verticalRaw !== 'digital') {
    fail(source, 'dataset.vertical', '只认 goods / digital（不写 = 跟 pack 的 workspace.yml）')
  }
  const vertical: WorkspaceVertical | undefined = verticalRaw
  // WP62（51 §1 N0）：这条场景跑在哪个网站平台上（不写 = 跟 pack 的 workspace.yml）
  const platformRaw = optStr(source, 'dataset.storefront_platform', doc.dataset.storefront_platform)
  if (platformRaw !== undefined && !STOREFRONT_PLATFORMS.some((p) => p.id === platformRaw)) {
    fail(
      source,
      'dataset.storefront_platform',
      `只认 ${STOREFRONT_PLATFORMS.map((p) => p.id).join(' / ')}（不写 = 跟 pack 的 workspace.yml）`,
    )
  }
  const storefront_platform = platformRaw as StorefrontPlatform | undefined
  const dataset = {
    pack: str(source, 'dataset.pack', doc.dataset.pack),
    seed: num(source, 'dataset.seed', doc.dataset.seed),
    ...(vertical === undefined ? {} : { vertical }),
    ...(storefront_platform === undefined ? {} : { storefront_platform }),
  }

  const actors: Record<string, ScenarioActor> = {}
  if (doc.actors !== undefined && doc.actors !== null) {
    if (!isRec(doc.actors)) fail(source, 'actors', '必须是对象')
    for (const [name, raw] of Object.entries(doc.actors))
      actors[name] = parseActor(source, name, raw)
  }

  if (!isRec(doc.stand_ins)) fail(source, 'stand_ins', '必须是对象')
  known(source, 'stand_ins', doc.stand_ins, ['provider', 'model', 'clock', 'delivery'])
  const model = str(source, 'stand_ins.model', doc.stand_ins.model)
  if (!['stub', 'replay', 'real'].includes(model)) {
    fail(source, 'stand_ins.model', 'model 只能是 stub / replay / real')
  }
  const stand_ins: ScenarioStandIns = {
    provider: str(source, 'stand_ins.provider', doc.stand_ins.provider) as 'mock_open_connector',
    model: model as ScenarioStandIns['model'],
    clock: str(source, 'stand_ins.clock', doc.stand_ins.clock) as 'virtual',
    delivery: str(source, 'stand_ins.delivery', doc.stand_ins.delivery) as 'inbox',
  }
  if (stand_ins.provider !== 'mock_open_connector') {
    fail(source, 'stand_ins.provider', 'v1 只有 mock_open_connector')
  }
  if (stand_ins.clock !== 'virtual') fail(source, 'stand_ins.clock', 'v1 只有 virtual')
  if (stand_ins.delivery !== 'inbox') fail(source, 'stand_ins.delivery', 'v1 只有 inbox')

  if (!isRec(doc.clock)) fail(source, 'clock', '必须是对象')
  known(source, 'clock', doc.clock, ['start'])
  const start = str(source, 'clock.start', doc.clock.start)
  if (!Number.isFinite(Date.parse(start))) fail(source, 'clock.start', '不是合法的 ISO-8601 时刻')

  if (!Array.isArray(doc.events)) fail(source, 'events', '必须是数组')
  const events = doc.events.map((e, i) => parseEvent(source, i, e))

  const invariantsRaw =
    doc.invariants === undefined ? [] : strList(source, 'invariants', doc.invariants)
  for (const name of invariantsRaw) {
    if (!(INVARIANT_NAMES as readonly string[]).includes(name)) {
      fail(source, 'invariants', `未知不变量：${name}（只有 ${INVARIANT_NAMES.join(' / ')}）`)
    }
  }

  const rubric = optStr(source, 'rubric', doc.rubric)
  const control_for = optStr(source, 'control_for', doc.control_for)
  let tiers: Tier[] | undefined
  if (doc.tiers !== undefined) {
    const list = strList(source, 'tiers', doc.tiers)
    for (const t of list) {
      if (!(TIER_NAMES as readonly string[]).includes(t)) {
        fail(source, 'tiers', `未知运行档：${t}（只有 ${TIER_NAMES.join(' / ')}）`)
      }
    }
    tiers = list as Tier[]
  }
  if (doc.hidden !== undefined && typeof doc.hidden !== 'boolean') {
    fail(source, 'hidden', '必须是布尔值')
  }

  return {
    id,
    version: 1,
    dataset,
    actors,
    stand_ins,
    clock: { start: new Date(Date.parse(start)).toISOString() },
    events,
    expected: parseExpected(source, doc.expected),
    invariants: invariantsRaw as InvariantName[],
    ...(doc.policy === undefined ? {} : { policy: parsePolicy(source, doc.policy) }),
    ...(tiers === undefined ? {} : { tiers }),
    ...(rubric === undefined ? {} : { rubric }),
    ...(doc.hidden === true ? { hidden: true } : {}),
    ...(control_for === undefined ? {} : { control_for }),
    source,
  }
}

/** 从文件读一条场景。 */
export function loadScenario(file: string): Scenario {
  return parseScenario(readFileSync(file, 'utf8'), file)
}
