import type { Iso8601, ObjectRef, PersonId, RoleId, WorkspaceId } from './common.js'

/** 18 §2 入站。parts.text 已 fencing；raw_ref 指向受控原始材料区。 */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'image' | 'file'; ref: string; mime?: string; name?: string }
  | { type: 'card'; payload: unknown }

export type ChannelName =
  | 'email'
  | 'whatsapp'
  | 'meta_dm'
  | 'feishu'
  | 'wecom'
  | 'shopify_webhook'
  | 'meta_webhook'
  | 'tiktok_webhook'
  | 'form'
  | 'api'

export interface InboundEvent {
  id: string
  schema_version: 1
  workspace_id: WorkspaceId
  channel: ChannelName
  kind: 'message' | 'system_event'
  received_at: Iso8601
  occurred_at: Iso8601
  dedupe_key: string
  actor?: { external_id: string; display?: string; resolved?: ObjectRef }
  thread?: { external_id: string; resolved?: ObjectRef }
  parts: MessagePart[]
  raw_ref: string
  routing: { role_id?: RoleId; work_item_id?: string; confidence: number }
  secrets_scrubbed: boolean
}

/** 渠道适配器（dsh-channels 契约的子集 + 我们的扩展）。send 内部委托 Connect，不持有 token。 */
export interface ChannelAdapter {
  name: ChannelName
  capabilities(): {
    text: boolean
    image: boolean
    file: boolean
    card: boolean
    thread: boolean
    streaming: boolean
  }
  start(handler: (raw: unknown) => Promise<void>): Promise<void>
  stop(): Promise<void>
  toInbound(
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<Omit<InboundEvent, 'id' | 'routing' | 'secrets_scrubbed'>>
  send(
    thread: { external_id: string },
    parts: MessagePart[],
    opts: { connect_token: string; connection?: string; idempotency_key: string },
  ): Promise<{ external_id: string; template_used?: boolean }>
  health(): Promise<{ ok: boolean; detail?: string }>
}

export interface InboundPipeline {
  ingest(
    channel: ChannelName,
    raw: unknown,
    workspace_id: WorkspaceId,
  ): Promise<{ event?: InboundEvent; deduped: boolean }>
  deadLetters(workspace_id: WorkspaceId): Promise<InboundEvent[]>
}

/** 18 §3 投递。回调只带 token 与动作。 */
export type DeliveryChannel =
  | 'workstation'
  | 'feishu_card'
  | 'wecom_card'
  | 'dingtalk_card'
  | 'email'
export interface DeliveryProvider {
  channel: DeliveryChannel
  deliver(
    item: {
      id: string
      title: string
      summary: string
      view: 'full' | 'redacted'
      decision_token: string
      actions: string[]
    },
    to: PersonId,
  ): Promise<{ external_id?: string }>
  refresh(external_id: string, state: string): Promise<void>
  parseCallback(
    payload: unknown,
  ): { item_id: string; decision_token: string; action: string } | undefined
}
