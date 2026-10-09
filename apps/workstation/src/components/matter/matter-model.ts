/**
 * WP264：事项页 v2（对话式）——时间线怎么排、页头状态怎么判、输入框给不给建议。全是纯函数，组件只管画。
 *
 * 排法（docs/design/matter/README §3）：
 * - 你说的（`human_message`）在右边气泡；AI 说的（`agent_message`）在左边；
 * - 「预览好了」（`preview`）嵌进紧跟着的那条 AI 消息里（结果卡）；后面没有 AI 消息就自己一条；
 * - 审批 / 选择（`card`）内嵌成能直接批的卡；路由还没定职责时那一条是选择卡；
 * - 卡在缺连接（`blocked`）**是最新一条时是卡**，后来接着做了就缩成一行灰字；
 * - 跑了一次 / 跑完了 / 路由 / 换职责 / 停下 / 别的系统话缩成居中一行灰字（决策 182：默认全收起）；
 *   跑完了的那次只出摘要那一行（开跑那条 `run` 不再单出），正在跑的那次在最底下单独画；
 * - 同一天只出一次日期分隔。
 */
import type { MatterEvent, MatterLiveRun, MatterRunDigest } from '@agentsws/contracts'

export type SysVariant = 'route' | 'run' | 'digest' | 'blocked' | 'stopped' | 'failed' | 'plain'

export type MatterItem =
  | { kind: 'day'; key: string; at: string }
  | { kind: 'me'; key: string; event: MatterEvent }
  | { kind: 'ai'; key: string; event?: MatterEvent; preview?: MatterEvent }
  | { kind: 'sys'; key: string; event: MatterEvent; variant: SysVariant }
  | { kind: 'card'; key: string; event: MatterEvent }
  | { kind: 'choice'; key: string; event: MatterEvent }
  | { kind: 'blocked'; key: string; event: MatterEvent }

export type MatterState = 'running' | 'doing' | 'awaiting' | 'blocked' | 'done'

/** 本地日期（YYYY-M-D），按它判「同一天只出一次」。 */
export function dayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

/** 后面有没有人接着做过（人又说了一句 / 又跑了一次）——卡住的那条就不再是卡。 */
function movedOnAfter(timeline: readonly MatterEvent[], index: number): boolean {
  return timeline.slice(index + 1).some((e) => e.kind === 'human_message' || e.kind === 'run')
}

/** 最近那条卡住了、还没人接着做（页头「卡住了」与输入框那条固定建议都看它）。 */
export function openBlock(timeline: readonly MatterEvent[]): MatterEvent | undefined {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const e = timeline[i] as MatterEvent
    if (e.kind === 'human_message' || e.kind === 'run') return undefined
    if (e.blocked !== undefined) return e
  }
  return undefined
}

export function buildItems(
  timeline: readonly MatterEvent[],
  ctx: {
    live?: MatterLiveRun | undefined
    roleId?: string | undefined
    closed: boolean
    /** WP287：岗位里问的一句（会话）——「按 X 做的」那一行不出 */
    ask?: boolean | undefined
  },
): MatterItem[] {
  /** WP287：没跑成的那几次——「没跑成：…」那一行就够了，摘要那行「这次没跑成」不再说一遍 */
  const failedRuns = new Set(
    timeline.filter((e) => e.failed !== undefined && e.run_id !== undefined).map((e) => e.run_id),
  )
  const digested = new Set(
    timeline
      .filter((e) => e.run_digest !== undefined && e.run_id !== undefined)
      .map((e) => e.run_id),
  )
  // 预览挂到紧跟着的那条 AI 消息上（中间隔着人话就不挂）
  const previewOf = new Map<string, MatterEvent>()
  const attached = new Set<string>()
  timeline.forEach((e, i) => {
    if (e.preview === undefined) return
    for (const next of timeline.slice(i + 1)) {
      if (next.kind === 'human_message') break
      if (next.kind === 'agent_message') {
        if (!previewOf.has(next.id)) {
          previewOf.set(next.id, e)
          attached.add(e.id)
        }
        break
      }
    }
  })
  const out: MatterItem[] = []
  let lastDay = ''
  const push = (item: MatterItem, at: string): void => {
    const day = dayKey(at)
    if (day !== lastDay) {
      out.push({ kind: 'day', key: `day-${day}`, at })
      lastDay = day
    }
    out.push(item)
  }
  for (const [i, e] of timeline.entries()) {
    const key = e.id
    let item: MatterItem | undefined
    if (e.kind === 'human_message') item = { kind: 'me', key, event: e }
    else if (e.kind === 'agent_message') {
      const preview = previewOf.get(e.id)
      item = { kind: 'ai', key, event: e, ...(preview === undefined ? {} : { preview }) }
    } else if (e.kind === 'card' && e.approval_item_id !== undefined)
      item = { kind: 'card', key, event: e }
    else if (e.kind === 'run') {
      const hidden =
        e.run_id !== undefined && (digested.has(e.run_id) || ctx.live?.run_id === e.run_id)
      item = hidden ? undefined : { kind: 'sys', key, event: e, variant: 'run' }
    } else if (e.failed !== undefined) item = { kind: 'sys', key, event: e, variant: 'failed' }
    else if (e.run_digest !== undefined)
      item =
        e.run_digest.outcome === 'failed' && failedRuns.has(e.run_id)
          ? undefined
          : { kind: 'sys', key, event: e, variant: 'digest' }
    else if (e.preview !== undefined)
      item = attached.has(e.id) ? undefined : { kind: 'ai', key, preview: e }
    else if (e.blocked !== undefined)
      item =
        !ctx.closed && !movedOnAfter(timeline, i)
          ? { kind: 'blocked', key, event: e }
          : { kind: 'sys', key, event: e, variant: 'blocked' }
    else if (e.route !== undefined)
      item =
        e.route.picked === undefined && ctx.roleId === undefined && !ctx.closed
          ? { kind: 'choice', key, event: e }
          : ctx.ask === true
            ? undefined
            : { kind: 'sys', key, event: e, variant: 'route' }
    // WP287：会话里路由那一行（没有可换的、只是「路由到 X」）也不出
    else if (ctx.ask === true && e.actor.id === 'position_router' && e.kind === 'status')
      item = undefined
    else if (e.stopped !== undefined) item = { kind: 'sys', key, event: e, variant: 'stopped' }
    else item = { kind: 'sys', key, event: e, variant: 'plain' }
    if (item !== undefined) push(item, e.at)
  }
  return out
}

/**
 * WP287：最近那条「没跑成」、后面还没人接着做（再说一句 / 又跑了一次）——只有它下面出「重试」。
 */
export function retryableFailure(timeline: readonly MatterEvent[]): string | undefined {
  for (let i = timeline.length - 1; i >= 0; i -= 1) {
    const e = timeline[i] as MatterEvent
    if (e.kind === 'human_message' || e.kind === 'run') return undefined
    if (e.failed !== undefined) return e.id
  }
  return undefined
}

/**
 * WP287：刚发出去、AI 还没开口（运行还没登记上，或者刚登记）——页面接着拉，别停在一句人话上。
 * 只看最近两分钟，免得没接 AI 的进程一直拉。
 */
export function awaitingReply(timeline: readonly MatterEvent[], nowMs: number): boolean {
  const last = [...timeline]
    .reverse()
    .find(
      (e) =>
        e.kind === 'human_message' ||
        e.kind === 'agent_message' ||
        e.run_digest !== undefined ||
        e.failed !== undefined,
    )
  if (last === undefined || last.kind !== 'human_message') return false
  return nowMs - Date.parse(last.at) < 120_000
}

/** 页头那一个状态词（小点颜色与左栏同一套）。 */
export function matterState(input: {
  closed: boolean
  running: boolean
  awaiting: boolean
  timeline: readonly MatterEvent[]
}): MatterState {
  if (input.closed) return 'done'
  if (input.running) return 'running'
  if (input.awaiting) return 'awaiting'
  if (openBlock(input.timeline) !== undefined) return 'blocked'
  return 'doing'
}

/**
 * 输入框的建议（决策 179）：只认三处——卡住了的固定规则、等你批的卡的主按钮、AI 最后那条结构化的下一步。
 * 在跑、刚发完（还在等）、最后说话的是人、没有明确下一步——都不给。
 */
export function suggestionFor(input: {
  items: readonly MatterItem[]
  busy: boolean
  blockedSay: string
  cardAction?: string | undefined
}): string | undefined {
  if (input.busy) return undefined
  const talk = input.items.filter((i) => i.kind !== 'day' && i.kind !== 'sys')
  const last = talk[talk.length - 1]
  if (last === undefined || last.kind === 'me') return undefined
  if (last.kind === 'blocked') return input.blockedSay
  if (input.cardAction !== undefined && input.cardAction !== '') return input.cardAction
  if (last.kind === 'ai') return last.event?.next_suggestion
  return undefined
}

/** 运行摘要那一行要的几个数（读 / 改了几个文件、有没有检查、有没有推）。 */
export function digestFacts(digest: MatterRunDigest): {
  read: number
  changed: number
  checked: boolean
  pushed: boolean
} {
  const texts = digest.steps.filter((s) => s.status === 'ok').map((s) => s.text)
  const files = (prefix: string): number =>
    new Set(texts.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))).size
  return {
    read: files('读 '),
    changed: files('改 '),
    checked: texts.some((t) => t.startsWith('主题检查')),
    pushed: texts.some((t) => t.startsWith('推成未发布主题')),
  }
}

/** 秒 → 分 / 秒两格（给 i18n 拼「4 分 12 秒」）。 */
export function splitDuration(seconds: number): { m: number; s: number } {
  const total = Math.max(0, Math.round(seconds))
  return { m: Math.floor(total / 60), s: total % 60 }
}

/** 人说的话超过 6 行（或很长一段）先收起。 */
export function bubbleIsLong(text: string): boolean {
  return text.split('\n').length > 6 || Array.from(text).length > 280
}

/** AI 的长回答先露一屏，「展开全文」。 */
export function replyIsLong(text: string): boolean {
  return text.split('\n').length > 14 || Array.from(text).length > 700
}
