/**
 * WP251（决策 91）：一轮运行「卡在缺连接 / 缺凭据上」的结构化标记。
 *
 * WP244 的「卡住了」部分靠认 AI 最后那句话（「没接上 / 交不出来 / 没权限」）——会误判：
 * AI 说「Shopify 还没连上，所以先用公开数据查了一版」也被算成卡住；反过来 AI 没明说的也漏掉。
 * 现在改成看**工具真回了什么**：宿主执行器回 `not_connected`（或缺凭据那几种）时，运行时把
 * 「哪个工具、缺哪个连接」记在这一轮上，收尾时写一条带 `blocked` 的时间线事件。
 *
 * 认的只是**机器码**（工具回执的 `reason` 开头那个词，或回执数据里 `{ ok: false, reason }`），
 * 不认人话——人话是给模型和人看的，机器码才是工具对「为什么做不了」的正式回答。
 */
import type { MatterRunBlock } from '@agentsws/contracts'
import type { ToolExecution } from '@agentsws/stand-ins'

/** 没连上（`not_connected：这个工作区还没有连上店铺后台…` 这种也认——认的是开头那个码）。 */
const NOT_CONNECTED = /^\s*not[_ ]connected\b/i
/** 缺凭据 / 凭据坏了（钥匙没填、过期、被拒）——人要做的事和「没连上」一样：去连接页补上。 */
const MISSING_CREDENTIAL =
  /^\s*(?:missing[_ ]credentials?|no[_ ]credentials?|no[_ ]key|missing[_ ]api[_ ]key|missing cloud workspace token|needs[_ ]developer[_ ]token|bad[_ ]credentials|token[_ ]stale|account[_ ]token[_ ]invalid|unauthenticated)\b/i

/** 一个机器码 → 卡在哪一种（不是这两种就是 `undefined`）。 */
export function blockReasonOf(code: unknown): MatterRunBlock['reason'] | undefined {
  if (typeof code !== 'string') return undefined
  if (NOT_CONNECTED.test(code)) return 'not_connected'
  if (MISSING_CREDENTIAL.test(code)) return 'missing_credential'
  return undefined
}

/**
 * 一次工具回执是不是「缺连接 / 缺凭据」。
 *
 * - 没跑成（`error` / `blocked`）：看 `reason`；
 * - 跑成了但数据里说做不了（渠道适配器的 `{ ok: false, reason: 'not_connected' }`）：看数据。
 *   降级成功的（比如红人搜索没连渠道、回了本地库）`ok` 不是 `false`，不算。
 */
export function blockedByTool(
  res: Pick<ToolExecution, 'status' | 'reason' | 'data'>,
): MatterRunBlock['reason'] | undefined {
  if (res.status !== 'ok') return blockReasonOf(res.reason)
  const data = res.data
  if (data === null || typeof data !== 'object') return undefined
  const rec = data as { ok?: unknown; reason?: unknown }
  return rec.ok === false ? blockReasonOf(rec.reason) : undefined
}

/** 一轮运行里攒下的卡点（同一个工具撞几次只记一次）。 */
export class RunBlockLog {
  readonly #tools = new Set<string>()
  readonly #connections = new Set<string>()
  #reason: MatterRunBlock['reason'] | undefined

  /** 记一笔：哪个工具、哪一种、缺哪几个连接（认不出就给空）。 */
  note(tool: string, reason: MatterRunBlock['reason'], connections: readonly string[]): void {
    this.#tools.add(tool)
    for (const c of connections) if (c.trim() !== '') this.#connections.add(c.trim())
    // 「没连上」比「缺凭据」更根本：两样都撞上时说没连上
    if (this.#reason === undefined || reason === 'not_connected') this.#reason = reason
  }

  /** 这一轮卡住了没有；卡住了回标记。 */
  block(): MatterRunBlock | undefined {
    if (this.#reason === undefined) return undefined
    return {
      reason: this.#reason,
      connections: [...this.#connections],
      tools: [...this.#tools],
    }
  }
}

/** 时间线上那一句人话（标记本身在 `blocked` 里）。 */
export function blockedLine(block: MatterRunBlock): string {
  const what = block.connections.length > 0 ? block.connections.join('、') : undefined
  if (block.reason === 'missing_credential')
    return what === undefined
      ? '这次卡在缺凭据上：去「连接」页把钥匙补上，再让它接着做。'
      : `这次卡在缺凭据上（${what}）：去「连接」页补上，再让它接着做。`
  return what === undefined
    ? '这次卡在缺连接上：去「连接」页连上，再让它接着做。'
    : `这次卡在缺连接上（${what}）：去「连接」页连上，再让它接着做。`
}
