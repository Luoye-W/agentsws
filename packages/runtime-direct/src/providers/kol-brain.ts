/**
 * WP117（66 断点 #1）：**红人的规则脑**。
 *
 * `direct` 与 `dsh` 两档里，「决定调哪个工具」是模型那一跳做的，而模拟回路里的
 * 「模型」是一个确定性的替身（`brain.ts` 的售后规则脑）。那一份只会查订单、查政策、
 * 提退款、起草回信——红人的运行落到它手里，出来的自然是客服的话。
 *
 * 这个文件是红人那一份：判定与工具计划**复用 `kol-core` 的剧本**（与 stub 同一份），
 * 只把「决定」翻成工具协议。所以同一条场景在三个运行时下走的是同一条链，
 * parity 比的才是运行时本身，而不是三份各写一遍的判定。
 */
import type { ChatMessage, Clock, KolChannel, ModelProvider, ModelRef } from '@agentsws/contracts'
import {
  classifyKolTask,
  KOL_TOOL_NAMES,
  type KolTaskContext,
  kolChannelOfRole,
  planKolTools,
} from '@agentsws/kol-core'
import type { ScriptedTurn, ScriptFn } from './scripted.js'
import { scriptedProvider } from './scripted.js'

const BLOCK = /^\[([a-z_]+):([^\]]*)\]\n?([\s\S]*)$/

interface Block {
  kind: string
  id: string
  body: string
}

function blocksOf(messages: readonly ChatMessage[]): Block[] {
  const out: Block[] = []
  for (const m of messages) {
    if (m.role === 'tool' || m.role === 'assistant') continue
    const match = BLOCK.exec(m.content)
    if (match?.[1] !== undefined && match[2] !== undefined && match[3] !== undefined) {
      out.push({ kind: match[1], id: match[2], body: match[3] })
    }
  }
  return out
}

/** 已经调过的工具名（工具结果消息上带 `name`）。 */
function calledTools(messages: readonly ChatMessage[]): Set<string> {
  const out = new Set<string>()
  for (const m of messages) {
    if (m.role !== 'tool') continue
    const name = (m as { name?: string }).name
    if (typeof name === 'string') out.add(name)
  }
  return out
}

/**
 * 从 prompt 里认出这是红人的运行，以及是哪条渠道。
 *
 * 判据有两层，都不依赖 `RunRequest`（规则脑只看得到消息与工具面）：
 *
 * 1. **工具面里有红人工具**——这是硬判据（工具面是按职责给的，见服务端 `buildRequest`）；
 * 2. 渠道从 persona 段里的职责名读（`## role kol.youtube`），读不到就按 youtube。
 */
export function kolRunOf(
  messages: readonly ChatMessage[],
  tools: readonly { name: string }[] | undefined,
): { channel: KolChannel } | undefined {
  const names = new Set((tools ?? []).map((t) => t.name))
  if (!KOL_TOOL_NAMES.some((n) => names.has(n))) return undefined
  for (const m of messages) {
    const hit = /kol\.(youtube|instagram|tiktok|facebook|x)\b/.exec(m.content)
    const channel = hit?.[0] === undefined ? undefined : kolChannelOfRole(hit[0])
    if (channel !== undefined) return { channel }
  }
  return { channel: 'youtube' }
}

export interface KolBrainOptions {
  clock: Clock
}

/**
 * 红人规则脑：一步一个工具，按 `kol-core` 的剧本往下走，走完说一句人话。
 *
 * 「一步一个」而不是一轮把全部工具都丢出去：`direct` 的 turn loop 与 dsh 的
 * agent-loop 都是一轮一调，前一步的结果要能影响后一步（比如搜完才知道有没有人）。
 */
export function kolBrain(options: KolBrainOptions): ScriptFn {
  return ({ messages, tools }): ScriptedTurn => {
    const run = kolRunOf(messages, tools)
    if (run === undefined) return { text: '' }
    const available = new Set((tools ?? []).map((t) => t.name))
    const blocks = blocksOf(messages)
    const text = [
      blocks.find((b) => b.kind === 'thread')?.body ?? '',
      blocks.find((b) => b.kind === 'matter_summary')?.body ?? '',
    ].join('\n')
    const hit = classifyKolTask(text)
    const ctx: KolTaskContext = { channel: run.channel, text, ...idsOf(blocks) }
    const done = calledTools(messages)
    for (const call of planKolTools(hit.intent, ctx)) {
      if (done.has(call.tool) || !available.has(call.tool)) continue
      return { tool_calls: [{ name: call.tool, input: call.input }] }
    }
    return { text: `红人（${run.channel}）：${hit.intent}，该调的工具都调过了。` }
  }
}

/** 现场钉着的那几个 id（上下文块的 id 形如 `pin_creator_cr_1`）。 */
function idsOf(blocks: readonly Block[]): Partial<KolTaskContext> {
  const find = (type: string): string | undefined => {
    for (const b of blocks) {
      const m = new RegExp(`^pin_${type}_(.+)$`).exec(b.id)
      if (m?.[1] !== undefined) return m[1]
    }
    return undefined
  }
  const creator_id = find('creator')
  const collaboration_id = find('collaboration')
  const deliverable_id = find('deliverable')
  return {
    ...(creator_id === undefined ? {} : { creator_id }),
    ...(collaboration_id === undefined ? {} : { collaboration_id }),
    ...(deliverable_id === undefined ? {} : { deliverable_id }),
  }
}

export interface KolBrainProviderOptions extends KolBrainOptions {
  ref?: ModelRef
  seed?: number
}

/** 红人规则脑 → 一个可以直接挂进模型网关的 provider（测试与单独装配用）。 */
export function kolBrainProvider(options: KolBrainProviderOptions): ModelProvider {
  return scriptedProvider({
    script: kolBrain(options),
    ...(options.ref === undefined ? {} : { ref: options.ref }),
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  })
}
