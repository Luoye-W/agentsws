/**
 * 05 §1 §2 的 schema 校验（schemastery）。
 *
 * 两层校验：
 * 1. schemastery 负责类型 / 枚举 / 必填，错误里自带 `$.scopes[0].domain` 这样的字段路径；
 * 2. `collectUnknownKeys` 负责拒绝未声明字段——权限配置里一个拼错的键被静默忽略比报错危险得多。
 *    05 §5 示例里的 `agent_max_sensitivity` 已于 31 §3.3 撤销，因此它现在会被当作未知字段拒掉。
 */
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
