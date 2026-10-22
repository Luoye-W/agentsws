/**
 * WP352（决策 931）：助理长对话的「段」——读写存储、切段、出小结（调一次模型）、段内压缩、迁移老会话。
 * 纯函数在 `assistant-thread.ts`；这里接存储与模型网关。小结 / 压缩没调成（没接模型、模型报错、回空）
 * 一律退回规则小结，不挡对话。
 */
import type { FreeChatActor, FreeChatMessageView, FreeChatSessionView } from '@agentsws/api'
import type { Clock, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import {
  dispatchesOf,
  estimateTokens,
  parseSummary,
  ruleSummary,
  summaryInstruction,
  transcriptOf,
} from './assistant-thread.js'
import type {
  AssistantSegmentReason,
  AssistantSegmentRow,
  FreeChatStore,
} from './free-chat-store.js'
import type { ModelChatChoice } from './models.js'

/** 每一轮拼了多少（写进事件 `assistant.context`，以后调预算看它）。 */
export interface AssistantContextStats {
  run_id: string
  segment_id: string
  split?: AssistantSegmentReason
  raw_messages: number
  raw_tokens: number
  compact_tokens: number
  compacted_now: boolean
  topics: number
  topic_tokens: number
  memory: number
  memory_tokens: number
  system_tokens: number
  /** WP470：这一段里新记、放在末尾附加里的记忆条数。 */
  new_memory?: number
  /** WP470：末尾附加那一段（时间 / 联网 / 公司资料 / 段内新记的记忆）的 token 估算。 */
  tail_tokens?: number
  /** WP470：这一轮回答的所有模型调用合计的输入 token（模型报的，含命中缓存的）。 */
  input_tokens?: number
  /** WP470：其中命中缓存的 token。 */
  cached_tokens?: number
  /** WP470：命中率（cached / input，三位小数；没有输入记 0）。 */
  cache_ratio?: number
}

export interface SegmentDeps {
  clock: Clock
  store: FreeChatStore
  newId(prefix: string): string
  gateway(): Promise<ModelGatewayApi>
  models(): Promise<{ chatChoices(): ModelChatChoice[]; defaultRef(): ModelRef }>
  roleOf(assignment_id: string): string | undefined
  /** 段收起 / 小结出来 / 段内压缩时记一笔（`assistant.topic`，不带正文）。 */
  observe?(actor: FreeChatActor, type: 'assistant.topic', payload: Record<string, unknown>): void
}

export type SegmentedRows = { seg: AssistantSegmentRow; rows: FreeChatMessageView[] }[]

export function createSegments(deps: SegmentDeps) {
  const { store, clock } = deps
  /** 后台在出的小结（测试与关进程时等它）。 */
  const pending = new Set<Promise<void>>()

  const list = (session_id: string): AssistantSegmentRow[] => store.segments(session_id)

  /** 话按段分好（老的话没有 `segment_id` 就算第一段的）。 */
  const grouped = (session_id: string, rows?: FreeChatMessageView[]): SegmentedRows => {
    const segs = list(session_id)
    const all = rows ?? store.messages(session_id)
    const first = segs[0]?.id
    return segs.map((seg) => ({
      seg,
      rows: all.filter((m) => (m.segment_id ?? first) === seg.id),
    }))
  }

  const open = (session_id: string): AssistantSegmentRow | undefined => {
    const last = list(session_id).at(-1)
    return last === undefined || last.ended_at !== undefined ? undefined : last
  }

  const start = (
    session: Pick<FreeChatSessionView, 'id'> & { person_id: string },
    reason: AssistantSegmentReason,
    at: string,
  ): AssistantSegmentRow => {
    const row: AssistantSegmentRow = {
      id: deps.newId('seg'),
      session_id: session.id,
      person_id: session.person_id,
      started_at: at,
      reason,
    }
    store.putSegment(row)
    return row
  }

  /** 调一次模型出小结（标题 + 正文）；没调成回 `undefined`。 */
  const ask = async (
    actor: FreeChatActor,
    kind: 'topic' | 'compact',
    transcript: string,
    prefer: string | undefined,
  ): Promise<{ title: string; summary: string; tokens: number } | undefined> => {
    try {
      const models = await deps.models()
      const choices = models.chatChoices()
      const ref = models.defaultRef()
      const choice =
        choices.find((c) => c.id === prefer) ??
        choices.find((c) => c.id === `${ref.provider}/${ref.model}`) ??
        choices[0]
      if (choice === undefined) return undefined
      const [provider, ...rest] = choice.id.split('/')
      const gateway = await deps.gateway()
      const out = await gateway.complete({
        model: { provider: provider ?? '', model: rest.join('/') },
        messages: [
          { role: 'system', content: summaryInstruction(kind) },
          { role: 'user', content: transcript },
        ],
        meta: {
          workspace_id: actor.workspace_id as never,
          assignment_id: actor.assignment_id as never,
          role_id: (deps.roleOf(actor.assignment_id) ?? 'common.member') as never,
          run_id: `fchat_${kind}_${deps.newId('sum')}` as never,
          purpose: 'free_chat',
        },
      })
      const parsed = parseSummary(out.text)
      return parsed === undefined
        ? undefined
        : { ...parsed, tokens: out.usage.input_tokens + out.usage.output_tokens }
    } catch {
      return undefined
    }
  }

  const lastModel = (rows: readonly FreeChatMessageView[]): string | undefined =>
    [...rows].reverse().find((m) => m.model !== undefined)?.model?.id

  /** 一段出话题小结（模型没出来就用规则小结），存回去。 */
  const summarize = async (
    actor: FreeChatActor,
    session_id: string,
    seg_id: string,
  ): Promise<void> => {
    const seg = list(session_id).find((s) => s.id === seg_id)
    if (seg === undefined) return
    const rows = grouped(seg.session_id).find((g) => g.seg.id === seg_id)?.rows ?? []
    if (rows.length === 0) return
    const got = await ask(actor, 'topic', transcriptOf(rows, seg.compact?.text), lastModel(rows))
    const now = list(seg.session_id).find((s) => s.id === seg_id) ?? seg
    const rule = got === undefined ? ruleSummary(rows) : undefined
    store.putSegment({
      ...now,
      title: got?.title ?? rule?.title ?? '',
      summary: got?.summary ?? rule?.summary ?? '',
      summarized_by: got === undefined ? 'rule' : 'ai',
      dispatches: dispatchesOf(rows),
    })
    deps.observe?.(actor, 'assistant.topic', {
      segment_id: seg_id,
      reason: seg.reason,
      messages: rows.length,
      summarized_by: got === undefined ? 'rule' : 'ai',
      summary_tokens: estimateTokens(got?.summary ?? rule?.summary ?? ''),
      ...(got === undefined ? {} : { model_tokens: got.tokens }),
    })
  }

  /** 收起一段（`ended_at` = 它最后一句话的时间），后台出小结。 */
  const close = (actor: FreeChatActor, seg: AssistantSegmentRow, ended_at: string): void => {
    store.putSegment({ ...seg, ended_at })
    const job = summarize(actor, seg.session_id, seg.id)
      .catch(() => undefined)
      .finally(() => {
        pending.delete(job)
      })
    pending.add(job)
  }

  /**
   * 段内压缩：`fold` 那几条（连同之前压过的）压成段内小结，记到段上。没压成就退回规则小结
   * （宁可粗一点，也不让这一轮超窗口）。
   */
  const compact = async (
    actor: FreeChatActor,
    seg: AssistantSegmentRow,
    fold: readonly FreeChatMessageView[],
  ): Promise<AssistantSegmentRow> => {
    const last = fold.at(-1)
    if (last === undefined) return seg
    const got = await ask(actor, 'compact', transcriptOf(fold, seg.compact?.text), lastModel(fold))
    const text =
      got === undefined
        ? [seg.compact?.text, ruleSummary(fold).summary].filter((x) => x !== undefined).join('\n')
        : `${got.title}\n${got.summary}`
    const next: AssistantSegmentRow = {
      ...seg,
      compact: { upto: last.id, text, at: clock.now() },
    }
    store.putSegment(next)
    deps.observe?.(actor, 'assistant.topic', {
      segment_id: seg.id,
      compacted: fold.length,
      summarized_by: got === undefined ? 'rule' : 'ai',
      summary_tokens: estimateTokens(text),
    })
    return next
  }

  return {
    list,
    grouped,
    open,
    start,
    close,
    compact,
    /** 等后台的小结都出完（测试用；关进程前也可以等一下）。 */
    async idle(): Promise<void> {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }
}

export type Segments = ReturnType<typeof createSegments>
