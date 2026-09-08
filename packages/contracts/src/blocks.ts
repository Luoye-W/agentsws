import type { PersonId, RangeRef } from './common.js'

/** 29 积木：组件只来自注册表；查询以本人身份在服务端执行；数字不经模型手。 */
export type Placement = 'queue' | 'alert' | 'focus' | 'digest' | 'role_view'
export interface ComponentDef {
  name: string
  payload_schema: unknown
  actions?: { id: string; label: string; endpoint: string }[]
  version: string
}
export interface NamedQuery {
  name: string
  params_schema: unknown
  executor: 'sql_readonly' | 'service'
  sql?: string
  service?: string
  returns: unknown
  acl: 'actor'
}
export interface Block {
  id: string
  placement: Placement
  component: string
  query: { name: string; params: Record<string, unknown> }
  refresh?: { every_seconds?: number; on_events?: string[] }
  pinnable: boolean
  adaptive: boolean
  source: 'role' | 'package' | 'user' | 'agent'
}
export interface CustomCard extends Block {
  owner: PersonId
  created_from: { conversation_id: string; message_ref?: string }
  shared_to?: RangeRef[]
}
export interface BlockRegistry {
  registerComponent(def: ComponentDef): void
  registerQuery(q: NamedQuery): void
  components(): ComponentDef[]
  queries(): NamedQuery[]
  validateBlock(b: Block): { ok: boolean; errors: string[] }
}
