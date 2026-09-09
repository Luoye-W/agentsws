/**
 * 展示层错误：`code` 用 28 §2 的统一码表，`reason` 是这一层自己的细分原因，
 * 前端按 reason 决定提示语（i18n key = `deck.error.<reason>`）。
 */
import type { ErrorCode } from '@agentsws/contracts'

export type DeckErrorReason =
  /** 选择题卡裸 approve（36 §2.1） */
  | 'OPTION_REQUIRED'
  /** 选了一个卡上没有的选项 */
  | 'UNKNOWN_OPTION'
  /** instruct 抽屉必须先选作用域（36 §2.1） */
  | 'SCOPE_REQUIRED'
  /** 14 §4：reject / redirect 的 reason 必填 */
  | 'REASON_REQUIRED'
  /** 这张卡当前状态下没有这个动作 */
  | 'ACTION_NOT_AVAILABLE'
  /** 乐观并发：卡片已被更新（14 §5 revision+1 即旧 token 失效） */
  | 'VERSION_MISMATCH'
  /** 未注册的组件 / 命名查询（29 原则 ①） */
  | 'UNKNOWN_COMPONENT'
  | 'UNKNOWN_QUERY'
  /** payload 不满足组件的 payload_schema（29 §2） */
  | 'PAYLOAD_INVALID'
  /** 数字块超过上限（36 §3：≤ 6 / 岗位） */
  | 'TOO_MANY_TILES'
  | 'UNKNOWN_TILE'

const STATUS: Record<DeckErrorReason, ErrorCode> = {
  OPTION_REQUIRED: 'invalid_input',
  UNKNOWN_OPTION: 'invalid_input',
  SCOPE_REQUIRED: 'invalid_input',
  REASON_REQUIRED: 'invalid_input',
  ACTION_NOT_AVAILABLE: 'invalid_input',
  VERSION_MISMATCH: 'conflict',
  UNKNOWN_COMPONENT: 'invalid_input',
  UNKNOWN_QUERY: 'not_found',
  PAYLOAD_INVALID: 'invalid_input',
  TOO_MANY_TILES: 'invalid_input',
  UNKNOWN_TILE: 'invalid_input',
}

export class DeckError extends Error {
  readonly code: ErrorCode
  readonly reason: DeckErrorReason
  readonly details?: unknown

  constructor(reason: DeckErrorReason, message: string, details?: unknown) {
    super(message)
    this.name = 'DeckError'
    this.reason = reason
    this.code = STATUS[reason]
    if (details !== undefined) this.details = details
  }
}

export function errorCodeFor(reason: DeckErrorReason): ErrorCode {
  return STATUS[reason]
}
