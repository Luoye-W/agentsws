import type { EventEnvelope } from '@agentsws/contracts'

export interface PrivacyErasedPayload {
  subject: { collection: string; id: string }
  key_id: string
  destroyed_at: string
  /** 被密钥销毁波及的 PII 字段名（内容不再可解密）。 */
  erased_fields: string[]
}

/**
 * 21 §4 墓碑。数据层**不直接依赖 kernel 的 EventLog**：`erase` 返回这个对象，
 * 由调用方 append 进事件日志（`EventLog.append` 只需 Omit<..., 'id' | 'at'>，多带一个 `at` 无碍，
 * 而备份恢复后的 `replayTombstones` 需要原始 `at`）。
 */
export type PrivacyErasedEvent = Omit<EventEnvelope<'privacy.erased', PrivacyErasedPayload>, 'id'>

export const EVENT_SCHEMA_VERSION = 1
