/**
 * WP236：一次运行被停下来（没动静太久 / 跑满时长 / 人点了停）时，**让人看见**、**已经干的不丢**。
 *
 * 10-06 Windows 真机：Reddit 研究任务 60 秒被静默 `run.cancelled`，时间线上什么都没有——
 * 模型已经取回了六次 Reddit 数据、说过几句过程话，全丢了，用户只看到「没反应」。
 *
 * 这里收两样东西拼成「部分结果」挂到事项上：
 * 1. 模型已经说过的话（`text.delta` 攒起来）；
 * 2. 已经取回的数据摘要（宿主执行器真回来的那几次工具：工具人话名 + 关键入参 + 几条 + 前几个标题）。
 * 再配一句人话（停的原因）与「接着跑」按钮（界面上按 `MatterEvent.stopped` 出）。
 */
import type { RunCancelReason, RunTimeLimits } from '@agentsws/contracts'
import { toolWordZh } from '@agentsws/stand-ins'

/** 过程话最多留这么多字（时间线是给人看的，不是会话日志）。 */
const MAX_TEXT_CHARS = 1500
/** 摘要最多列这么多次工具。 */
const MAX_TOOL_LINES = 12
/** 每次工具最多列几个标题。 */
const MAX_TITLES = 3

interface HostToolEntry {
  tool: string
  input: Record<string, unknown>
  status: 'ok' | 'error' | 'blocked'
  data?: unknown
}

/** 一次运行的现场记录（开跑建、收尾丢）。 */
export class PartialRunLog {
  readonly #text: string[] = []
  readonly #tools: HostToolEntry[] = []

  text(delta: string): void {
    this.#text.push(delta)
  }

  hostTool(entry: HostToolEntry): void {
    this.#tools.push(entry)
  }

  /** 模型说过的话（拼好、去空白；没有就是空串）。 */
  said(): string {
    const all = this.#text.join('').trim()
    return all.length > MAX_TEXT_CHARS ? `${all.slice(0, MAX_TEXT_CHARS)}…` : all
  }

  /** 已经取回的数据，一行一次（只列成功回来的）。 */
  fetched(): string[] {
    return this.#tools
      .filter((t) => t.status === 'ok')
      .slice(0, MAX_TOOL_LINES)
      .map((t) => toolLine(t))
  }

  /** 拼给时间线的部分结果（markdown）；什么都没有就 `undefined`。 */
  digest(): string | undefined {
    const said = this.said()
    const fetched = this.fetched()
    if (said === '' && fetched.length === 0) return undefined
    const parts: string[] = []
    if (said !== '') parts.push(said)
    if (fetched.length > 0)
      parts.push(['**已经取回的数据**', ...fetched.map((l) => `- ${l}`)].join('\n'))
    return parts.join('\n\n')
  }
}

const KEY_INPUTS = ['query', 'subreddit', 'post_url', 'url', 'name', 'id'] as const

function toolLine(t: HostToolEntry): string {
  const what = toolWordZh(t.tool)
  const key = KEY_INPUTS.map((k) => t.input[k]).find((v) => typeof v === 'string' && v !== '')
  const head = key === undefined ? what : `${what}「${String(key).slice(0, 80)}」`
  const data = (t.data ?? {}) as Record<string, unknown>
  const items = Array.isArray(data.items) ? (data.items as Record<string, unknown>[]) : undefined
  if (items === undefined) return head
  if (items.length === 0) {
    const missing = typeof data.missing === 'string' ? `（${data.missing.slice(0, 60)}）` : ''
    return `${head}：没取到${missing}`
  }
  const titles = items
    .map((i) => (typeof i.title === 'string' ? i.title : typeof i.name === 'string' ? i.name : ''))
    .filter((s) => s !== '')
    .slice(0, MAX_TITLES)
    .map((s) => (s.length > 60 ? `${s.slice(0, 60)}…` : s))
  return titles.length === 0
    ? `${head}：${items.length} 条`
    : `${head}：${items.length} 条，如${titles.map((s) => `「${s}」`).join('、')}`
}

/** 停下来那一句人话。`partial` = 下面有没有已经查到的东西。 */
export function stoppedLine(
  reason: RunCancelReason,
  limits: RunTimeLimits,
  partial: boolean,
): string {
  const head =
    reason === 'idle_timeout'
      ? `这次太久没有动静（${minutes(limits.idle_timeout_seconds)}），被停了`
      : reason === 'max_duration'
        ? `这次跑太久被停了（超过 ${minutes(limits.max_duration_seconds)}上限）`
        : '这次被停下了'
  return partial
    ? `${head}：已经查到的部分在下面，点「接着跑」可以接着做。`
    : `${head}，还没拿到可用的结果；点「接着跑」可以再来一次。`
}

function minutes(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} 分钟` : `${seconds} 秒`
}
