import type { PrivacyErasedEvent, PrivacyErasedPayload } from '@agentsws/contracts'

export type { PrivacyErasedEvent, PrivacyErasedPayload }

/** 21 §4 墓碑：数据层不依赖 kernel；`erase` 返回事件对象，由调用方写事件日志。 */
export const EVENT_SCHEMA_VERSION = 1
