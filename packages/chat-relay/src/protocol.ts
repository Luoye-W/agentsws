/**
 * 转发器协议（WP124）。转发器与「对面是谁」之间只有这一种话：
 * 商家本机（免费两档）或托管实例（收费档，同一份 `apps/server`）主动外连进来，
 * 带着配对密钥握手；之后访客消息从这条连接下去，回复从这条连接回来。
 *
 * 三条铁律（docs/72 §6.3，写成验收）：
 * 1. **协议带版本号**：握手时双方各报各的支持区间，取交集里最大的那个；
 *    交集为空就是 `version_mismatch`，谁也不猜谁的格式。
 * 2. **打字信号只承载布尔**（FR-035）：载荷里不得有输入框内容、字符数、片段；
 *    `parseClientFrame` 直接拒——隐私红线不依赖客户端自律。
 * 3. **一次话轮恰好一条回复**：转发器给每条访客消息编一个 `turn`；
 *    回复必须带它，第二条同 `turn` 的回复被判 `turn_already_answered` 丢弃。
 *    （被废弃的生成照常在**发起生成的那一侧**计费——转发器看不见钱。）
 *
 * 另一条形状纪律（FR-047）：访客侧 `POST /message` 只确认收到，
 * 回复从 SSE / 这条长连接异步回去——接收与投递解耦，Workers 的请求
 * 生命周期扛不住同步等一个 60 秒的话轮。
 */

import type {
  HelloRejectReason,
  RelayClientFrame,
  RelayPeerKind,
  RelayServerFrame,
  RelayWidgetConfig,
} from '@agentsws/contracts'

/** 当前协议版本。改了帧的形状就 +1；老客户端握手时会拿到 mismatch 与支持区间。 */
export const RELAY_PROTOCOL_VERSION = 1

/** 心跳间隔（毫秒）。本机侧在这段时间里没收到任何帧就该发 `ping`。 */
export const RELAY_HEARTBEAT_MS = 15_000

/*
 * WP164：帧与挂件配置的形状挪进了契约（`@agentsws/contracts` 的 chat-relay.ts），
 * 开源侧与官方托管转发器之间只认那一份。这里原名重导出，调用方一个字不用改。
 */
export type { HelloRejectReason, RelayPeerKind, RelayWidgetConfig }

/** 对面（本机 / 托管实例）→ 转发器。 */
export type ClientFrame = RelayClientFrame

/** 转发器 → 对面。 */
export type RelayFrame = RelayServerFrame

/** 两个版本集合的兼容判定：取交集里最大的；空交集即不兼容。 */
export function negotiateVersion(
  supported: readonly number[],
  offered: number,
): number | undefined {
  return supported.includes(offered) ? offered : undefined
}

/** 打字帧的合法键。多一个键都算带自由文本——直接拒。 */
const TYPING_KEYS = new Set(['type', 'session', 'active'])

/**
 * 解析对面上来的一个帧。
 *
 * 返回 `undefined` = 不是合法帧（调用方应回 `error` 或直接断）。
 * `typing` 帧在这里被**结构性**限死成布尔：带任何多余键（哪怕是个空字符串）
 * 都解析失败——校验发生在服务端，不是约定。
 */
export function parseClientFrame(raw: string): ClientFrame | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const frame = value as Record<string, unknown>
  switch (frame.type) {
    case 'hello': {
      if (typeof frame.protocol_version !== 'number') return undefined
      if (typeof frame.workspace !== 'string' || frame.workspace === '') return undefined
      if (typeof frame.pairing !== 'string' || frame.pairing === '') return undefined
      if (frame.peer !== 'server' && frame.peer !== 'hosted') return undefined
      return {
        type: 'hello',
        protocol_version: frame.protocol_version,
        workspace: frame.workspace,
        pairing: frame.pairing,
        peer: frame.peer,
        ...(isWidgetConfig(frame.config) ? { config: frame.config } : {}),
      }
    }
    case 'config':
      return isWidgetConfig(frame.config)
        ? { type: 'config', config: frame.config as RelayWidgetConfig }
        : undefined
    case 'reply': {
      if (typeof frame.session !== 'string' || frame.session === '') return undefined
      if (typeof frame.turn !== 'string' || frame.turn === '') return undefined
      if (typeof frame.message_id !== 'string' || frame.message_id === '') return undefined
      if (typeof frame.text !== 'string' || frame.text === '') return undefined
      return {
        type: 'reply',
        session: frame.session,
        turn: frame.turn,
        message_id: frame.message_id,
        text: frame.text,
      }
    }
    case 'note': {
      if (typeof frame.session !== 'string' || frame.session === '') return undefined
      if (typeof frame.message_id !== 'string' || frame.message_id === '') return undefined
      if (typeof frame.text !== 'string' || frame.text === '') return undefined
      return {
        type: 'note',
        session: frame.session,
        message_id: frame.message_id,
        text: frame.text,
      }
    }
    case 'typing': {
      // FR-035：只收布尔。多一个键 = 带自由文本 = 拒。
      for (const key of Object.keys(frame)) {
        if (!TYPING_KEYS.has(key)) return undefined
      }
      if (typeof frame.session !== 'string' || frame.session === '') return undefined
      if (typeof frame.active !== 'boolean') return undefined
      return { type: 'typing', session: frame.session, active: frame.active }
    }
    case 'pull_offline':
      return { type: 'pull_offline' }
    case 'ping':
      return { type: 'ping' }
    default:
      return undefined
  }
}

function isWidgetConfig(value: unknown): value is RelayWidgetConfig {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.enabled === 'boolean' && typeof c.accent === 'string' && typeof c.greeting === 'string'
  )
}

/** 序列化一个要发给对面的帧。 */
export function encodeRelayFrame(frame: RelayFrame): string {
  return JSON.stringify(frame)
}
