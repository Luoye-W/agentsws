/**
 * 05 §1 §2 的 schema 校验（schemastery）。
 *
 * 两层校验：
 * 1. schemastery 负责类型 / 枚举 / 必填，错误里自带 `$.scopes[0].domain` 这样的字段路径；
 * 2. `collectUnknownKeys` 负责拒绝未声明字段——权限配置里一个拼错的键被静默忽略比报错危险得多。
 *    05 §5 示例里的 `agent_max_sensitivity` 已于 31 §3.3 撤销，因此它现在会被当作未知字段拒掉。
 */
import { MAX_QUICK_PROMPTS, MAX_TASK_EXAMPLES } from '@agentsws/contracts'
import Schema from '@deepseek-ai/schemastery'

type Node = Schemastery

/**
 * schemastery 给 `Schema.object` 预置了 `default = {}`，会把"整个字段缺省"变成"空对象"再校验内部必填项。
 * 可选的嵌套对象必须先把这个默认值清掉，否则 `mandate.window` 不写就会报 `window.max_count` 缺失。
 */
const optionalObject = <T extends Node>(schema: T): T => schema.default(undefined as never) as T

const str = () => Schema.string().required()
const bool = () => Schema.boolean().required()
const num = () => Schema.number().required()

const SENSITIVITY = Schema.union(['public', 'internal', 'confidential', 'restricted'] as const)
const DATA_DOMAIN = Schema.union([
  'customer',
  'order',
  'shipment',
  'product',
  'inventory',
  'store_config',
  'content',
  'discount',
  'campaign',
  'analytics',
  'asset',
  'knowledge',
  'creator',
  // WP67（48 §5.1）：红人营销的五个新域，与契约的 `DataDomain` 同步。
  // 一个域一把闸：找人那一块谁都看得见（`platform_account`），联系方式只有建联
  // 那一步碰得到（`creator_contact`，confidential），预算与条款是钱（`collaboration`）。
  'platform_account',
  'creator_contact',
  'collaboration',
  'deliverable',
  'tracked_link',
  'ad_account',
  'social_account',
  'review',
  'finance',
  'approval',
  'skill',
  'policy',
  'event_log',
] as const)
const OPERATION = Schema.union(['read', 'stage', 'approve', 'agent_auto'] as const)
const RANGE = Schema.union(['own', 'assigned', 'workspace'] as const)
const LEVEL = Schema.union(['L1', 'L2', 'L3'] as const)

const NAME = Schema.object({ zh: str(), en: str() }).required()

const SCOPE = Schema.object({
  domain: DATA_DOMAIN.required(),
  ops: Schema.array(OPERATION).required().min(1),
  range: RANGE.required(),
  max_sensitivity: SENSITIVITY.required(),
})

const CAP = Schema.union([
  Schema.number(),
  Schema.boolean(),
  Schema.string(),
  Schema.array(Schema.string()),
])

const MANDATE = Schema.object({
  caps: Schema.dict(CAP).required(),
  per_change_limits: optionalObject(
    Schema.object({
      max_items: Schema.number(),
      no_repeat_target_field: Schema.boolean(),
    }),
  ),
  window: optionalObject(
    Schema.object({
      max_count: num(),
      per: Schema.union(['day', 'week'] as const).required(),
    }),
  ),
}).required()

const ROUTE_TO = Schema.union([
  Schema.const('role_holder'),
  Schema.const('scope_manager'),
  Schema.const('owner'),
  Schema.object({ role: str() }),
]).required()

const WRITE_ACTION = Schema.object({
  id: str(),
  target: DATA_DOMAIN.required(),
  kind: Schema.union([
    'staged_change',
    'outbound_message',
    'publish',
    'config_change',
  ] as const).required(),
  mandate: MANDATE,
  requires_record_read: Schema.boolean(),
  protected_fields: Schema.array(Schema.string()),
  review_cannot_be_disabled: Schema.boolean(),
  route_to: ROUTE_TO,
})

const AUTOMATION_SPEC = Schema.object({
  ceiling: LEVEL.required(),
  initial: LEVEL.required(),
  hard_ceiling: Schema.boolean(),
  promotion: Schema.object({
    adoption_rate_min: num().min(0).max(1),
    window_weeks: num().min(0),
    min_samples: num().min(0),
  }).required(),
  demotion_triggers: Schema.array(
    Schema.union(['customer_complaint', 'guardrail_hit', 'manual'] as const),
  ).required(),
})

const CONNECTOR = Schema.object({
  kind: str(),
  required: bool(),
  grants: Schema.array(Schema.string()).required(),
  ownership: Schema.union(['workspace', 'person'] as const).required(),
})

const SKILL_REF = Schema.object({
  name: str(),
  min_version: Schema.string(),
  tier: Schema.union(['open', 'premium'] as const).required(),
  load: Schema.union(['always', 'on_demand'] as const).required(),
})

const HOME_BLOCK = Schema.object({
  id: str(),
  placement: Schema.union(['queue', 'alert', 'focus', 'digest', 'role_view'] as const).required(),
  component: str(),
  query: str(),
  default_order: num(),
  pinnable: bool(),
  adaptive: bool(),
})

const NOTIFICATION = Schema.object({
  event: str(),
  mode: Schema.union(['immediate', 'queue', 'digest'] as const).required(),
  recipients: Schema.array(
    Schema.union(['role_holder', 'scope_manager', 'owner'] as const),
  ).required(),
  escalate_after_hours: Schema.number(),
  digest_schedule: Schema.string(),
})

const GROUNDING = Schema.object({
  name: str(),
  intent_terms: Schema.array(Schema.string()).required(),
  cue_terms: Schema.array(Schema.string()).required(),
  tool: str(),
  prefetch: bool(),
})

/**
 * WP84（54 §1 第 6 行）：快捷提示与示例任务。
 *
 * 两个都是**可选**字段：不填的职责一切照旧，首页那张卡上只是没有这几个按钮。
 * 条数上限由 `Schema.array(...).max(n)` 挡；**id 唯一**由 `checkRoleExtras` 在
 * schemastery 之后补一刀——schemastery 管得了"每一条长什么样"，管不了"这几条之间别重名"。
 */
const QUICK_PROMPT = Schema.object({
  id: str().pattern(/^[a-z][a-z0-9_]*$/),
  label: NAME,
  prompt: str(),
  kind: Schema.union(['start_task', 'ask', 'review'] as const).required(),
})

const TASK_EXAMPLE = Schema.object({
  id: str().pattern(/^[a-z][a-z0-9_]*$/),
  title: NAME,
  description: str(),
  expected_output: str(),
})

const HANDOVER = Schema.object({
  transfers: Schema.array(
    Schema.union([
      'open_work_items',
      'context',
      'home_blocks',
      'queue_lane',
      'scheduled_tasks',
    ] as const),
  ).required(),
  fallback: Schema.union(['owner', 'scope_manager'] as const).required(),
  revoke_context_on_removal: bool(),
}).required()

/** 05 §1 RoleDefinition。 */
export const ROLE_SCHEMA: Node = Schema.object({
  id: str().pattern(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/),
  version: str().pattern(/^\d+\.\d+\.\d+$/),
  domain: Schema.union([
    'dtc',
    'amz',
    'social',
    'kol',
    'ads',
    'design',
    'dev',
    'common',
  ] as const).required(),
  name: NAME,
  description: str(),
  scopes: Schema.array(SCOPE).required(),
  connectors: Schema.array(CONNECTOR).required(),
  actions: Schema.array(WRITE_ACTION).required(),
  automation: Schema.dict(AUTOMATION_SPEC).required(),
  skills: Schema.array(SKILL_REF).required(),
  home_blocks: Schema.array(HOME_BLOCK).required(),
  notifications: Schema.array(NOTIFICATION).required(),
  grounding: Schema.array(GROUNDING),
  /**
   * WP63（51 §2.1 异常卡）：这条职责判「不正常」用的那几个数。
   *
   * 为什么不写死在代码里：什么叫「销售骤降」，卖家具的和卖快消的不是一个数。
   * 为什么不放进 `mandate.caps`：caps 是**额度**（越权就拦），阈值只决定
   * 要不要出一张提醒卡，拦不住任何人。
   */
  thresholds: Schema.dict(Schema.number()),
  /** WP84：首页岗位卡下的快捷提示（≤ MAX_QUICK_PROMPTS 条，id 在本职责内唯一）。 */
  quick_prompts: Schema.array(QUICK_PROMPT).max(MAX_QUICK_PROMPTS),
  /** WP84：指导抽屉顶部的示例任务（≤ MAX_TASK_EXAMPLES 条，id 在本职责内唯一）。 */
  task_examples: Schema.array(TASK_EXAMPLE).max(MAX_TASK_EXAMPLES),
  /**
   * WP82（55 §3）：这条职责的浏览器只许打开哪些站（`*.youtube.com` 这种通配也认）。
   *
   * 不填 = 这条职责开不了浏览器（空白名单一律拒）。格式在 `checkRoleExtras` 里
   * 再查一道：schemastery 只知道"是一串字符串"，判不出"youtube.com/channels"
   * 这种带路径的写法——而那种写法永远匹配不上任何 host，等于静默失效。
   */
  browser_scope: Schema.array(Schema.string()),
  persona: Schema.string(),
  handover: HANDOVER,
  requires: Schema.array(Schema.string()),
}).required()

/** 05 §2 Position。 */
export const POSITION_SCHEMA: Node = Schema.object({
  id: str(),
  version: str().pattern(/^\d+\.\d+\.\d+$/),
  name: NAME,
  roles: Schema.array(Schema.object({ role: str(), default: bool() })).required(),
}).required()

/**
 * WP84：schemastery 之后的那一刀——**`quick_prompts` / `task_examples` 的 id 在本职责内唯一**。
 *
 * 为什么非查不可：这两个 id 是界面上的 React key，也是以后"这条快捷提示被点了几次"
 * 的统计口径。重名不会报错，只会让两条里的一条静默消失——和 05 §5 那个拼错的键
 * 一样的毛病，所以照 `collectUnknownKeys` 的办法，宁可加载时就拒。
 *
 * 回 `undefined` = 没问题；回一条 `{ field, message }` = 第一处重名（字段路径照 schemastery 的写法）。
 */
export function checkRoleExtras(data: unknown): { field: string; message: string } | undefined {
  if (!isPlainObject(data)) return undefined
  for (const key of ['quick_prompts', 'task_examples'] as const) {
    const list = data[key]
    if (!Array.isArray(list)) continue
    const seen = new Set<string>()
    for (const [i, item] of list.entries()) {
      const id = isPlainObject(item) ? item.id : undefined
      if (typeof id !== 'string') continue
      if (seen.has(id)) return { field: `${key}[${i}].id`, message: `duplicate id: ${id}` }
      seen.add(id)
    }
  }
  const scope = data.browser_scope
  if (Array.isArray(scope)) {
    for (const [i, item] of scope.entries()) {
      if (typeof item !== 'string') continue
      const bad = badBrowserScope(item)
      if (bad !== undefined) return { field: `browser_scope[${i}]`, message: bad }
    }
  }
  return undefined
}

/**
 * WP82：一条 `browser_scope` 写得对不对。
 *
 * 只允许 `example.com` 与 `*.example.com` 两种形状。写成 `https://example.com`、
 * `example.com/channels`、`example.com:443` 都拒——它们永远匹配不上
 * `hostAllowed()` 拿到的那个 hostname，加载时不拒的话就是**静默失效**：
 * 白名单看着填了，实际上这条职责一个站都打不开（05 §5 那个拼错的键同一个毛病）。
 */
function badBrowserScope(raw: string): string | undefined {
  const value = raw.trim()
  if (value === '') return 'browser_scope 里不能有空串'
  if (value.includes('/') || value.includes(':')) return `只写域名，不要协议 / 路径 / 端口：${raw}`
  const host = value.startsWith('*.') ? value.slice(2) : value
  if (host === '' || host.includes('*')) return `通配只能写在最前面（*.example.com）：${raw}`
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(host))
    return `不是一个域名：${raw}`
  return undefined
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const join = (path: string, key: string) => (path ? `${path}.${key}` : key)

/** 沿 schemastery 的 schema 树走一遍数据，收集未声明的键。 */
export function collectUnknownKeys(
  data: unknown,
  node: Node,
  path = '',
  out: string[] = [],
): string[] {
  if (data === undefined || data === null) return out
  switch (node.type) {
    case 'object': {
      if (!isPlainObject(data)) return out
      const dict = node.dict ?? {}
      for (const [key, value] of Object.entries(data)) {
        const child = dict[key]
        if (!child) out.push(join(path, key))
        else collectUnknownKeys(value, child, join(path, key), out)
      }
      return out
    }
    case 'array': {
      if (!Array.isArray(data) || !node.inner) return out
      const inner = node.inner as Node
      for (const [i, item] of data.entries()) collectUnknownKeys(item, inner, `${path}[${i}]`, out)
      return out
    }
    case 'dict': {
      if (!isPlainObject(data) || !node.inner) return out
      for (const [key, value] of Object.entries(data))
        collectUnknownKeys(value, node.inner as Node, join(path, key), out)
      return out
    }
    case 'union': {
      // 数据此前已通过校验，因此必有一个分支能接住它；只查那个分支。
      for (const branch of node.list ?? []) {
        try {
          branch(data)
        } catch {
          continue
        }
        return collectUnknownKeys(data, branch, path, out)
      }
      return out
    }
    case 'transform':
      return node.inner ? collectUnknownKeys(data, node.inner as Node, path, out) : out
    default:
      return out
  }
}
