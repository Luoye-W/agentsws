/**
 * Extracted from KefuAgent src/lib/support/chat-teaching.ts
 * (guideChatSession 的 prompt 组装、containsInstructionVerbatimLeak、沉淀那一段),
 * rewritten for agentsws contracts.
 *
 * 「教 AI」：商家用中文说"这种问题该这么答"，AI 用访客的语言把它说出去，
 * 同时把这条指导沉淀成知识候选——下一次不用再教一遍。
 *
 * 两条红线，本文件负责其中一条半：
 * 1. **商家的中文指导绝不出现在对客消息里**。prompt 里写了这条不算保证——
 *    会复读输入的模型会把商家的私下措辞放到访客屏幕上，而且撤不回来。
 *    所以投递前再问一次 `containsInstructionLeak`，答"是"就拒发，不是改改再发。
 * 2. **只有 AI 一个声音对客**：商家不直接说话。这条由上层（会话状态机 + 沙盒页）落地。
 *
 * 另一条纪律：**指导先存、再叫模型**。生成失败该让商家重试一次，
 * 不该把他刚打的那条学习信号一起弄丢。所以本文件把"存什么"与"问模型什么"
 * 拆成两步返回，顺序由调用方保证。
 */
import type { Iso8601, KnowledgeLayer } from '@agentsws/contracts'
import { displayLine, sanitizeExternal } from '../text.js'
import type { ChatIntent, ChatTurnMessage } from './types.js'

/** 这条指导管多大范围。名字沿用 KefuAgent（商家只看见中文标签）。 */
export const CHAT_TEACHING_SCOPES = ['single_reply', 'similar_cases', 'global_rule'] as const
export type ChatTeachingScope = (typeof CHAT_TEACHING_SCOPES)[number]

export const CHAT_TEACHING_SCOPE_LABELS: Readonly<Record<ChatTeachingScope, string>> = {
  single_reply: '只管这一条回复',
  similar_cases: '以后遇到同类问题都这么答',
  global_rule: '当成一条通用规则',
}

/** 商家指导的长度上限（与 KefuAgent 对齐）。 */
export const MAX_CHAT_INSTRUCTION_CHARS = 2000

/** 进 prompt 的对话条数。聊天轮次短，20 条很宽裕。 */
export const CHAT_TEACHING_TRANSCRIPT_LIMIT = 20

/**
 * 多长的一段商家原话算"泄漏"。
 *
 * 够长，讲中文的访客与写中文的商家可以共用寻常短语（"免费换新"）；
 * 够短，商家指导里的一整句话钻不到访客屏幕上。
 */
export const INSTRUCTION_LEAK_RUN_CHARS = 12

const squeeze = (text: string): string => sanitizeExternal(text).replace(/\s+/g, '')

/**
 * 红线①的守卫：对客草稿里有没有逐字抄商家指导。
 *
 * 两边都先去空白再比——把同一句话换行重排的模型仍然是在复读它。
 */
export function containsInstructionLeak(
  instruction: string,
  reply: string,
  run_chars = INSTRUCTION_LEAK_RUN_CHARS,
): boolean {
  const src = squeeze(instruction)
  const out = squeeze(reply)
  if (src.length < run_chars || out.length < run_chars) return false
  for (let i = 0; i + run_chars <= src.length; i += 1) {
    if (out.includes(src.slice(i, i + run_chars))) return true
  }
  return false
}

export interface ChatTeachingInput {
  /** 商家打的那句中文。 */
  instruction: string
  scope: ChatTeachingScope
  /** 这条会话的对话记录（时间序）。 */
  transcript: readonly ChatTurnMessage[]
  /** 这一轮判出来的意图；不给就不进 prompt。 */
  intent?: ChatIntent
  now: Iso8601
  /** 谁教的（进候选的 `answered_by`）。 */
  taught_by: string
}

export interface ChatTeachingRequest {
  /** 系统提示（硬性边界五条）。 */
  system: string
  /** 用户侧载荷（已是 JSON 字符串，模型网关直接传）。 */
  payload: string
  /** 这一轮之前 AI 已经说过话了 → 这条是补充或更正，不是第一次开口。 */
  is_correction: boolean
}

const SYSTEM = `你是这家店的在线客服 AI。商家刚用中文告诉你这种问题该怎么答，
把它变成一句对访客说的话。

硬性边界：
1. 用访客的语言写（看访客消息判断；判不出用英文），1-3 句，像聊天不像邮件。
2. 商家的中文指导是内部信息：不能出现在回复里，也不能提"商家说""我问了同事"这类内部过程；
   直接以你自己的身份把答案说出来。
3. 只说商家指导与已知事实支持的内容：不编订单、金额、退款、补发、物流事实，
   不承诺指导里没有的时限或结果。
4. 涉及钱、退款、改单的，只说流程与下一步，不在聊天里替商家定下来。
5. is_correction 为 true 时你刚才已经答过：这条是补充或更正，自然衔接，不要否认自己说过话。

只输出 JSON：{"reply": "对客回复"}`

/**
 * 组一次「教 AI」的模型请求。
 *
 * 不调模型（本包的纪律：22 模型只在网关后面）——调用方拿这两段去网关。
 */
export function buildChatTeachingRequest(input: ChatTeachingInput): ChatTeachingRequest {
  const recent = input.transcript.slice(-CHAT_TEACHING_TRANSCRIPT_LIMIT)
  const is_correction = recent.some((m) => m.role === 'agent')
  const payload = {
    merchant_instruction_zh: sanitizeExternal(input.instruction).slice(
      0,
      MAX_CHAT_INSTRUCTION_CHARS,
    ),
    instruction_scope: input.scope,
    is_correction,
    intent: input.intent ?? null,
    recent_messages: recent.map((m) => ({
      role: m.role,
      // 访客的话是外部文本：进 prompt 前照常清洗（进模型的那一份仍在围栏里由网关包）
      text: sanitizeExternal(m.text).slice(0, 500),
    })),
  }
  return { system: SYSTEM, payload: JSON.stringify(payload), is_correction }
}

/** 这条指导沉淀成什么。`none` = 只管这一条回复，不进知识库。 */
export type ChatTeachingSediment = 'none' | 'knowledge_candidate'

export interface ChatKnowledgeCandidate {
  /** 候选正文（可直接做 19 §1.1 FactCard 的 statement）。 */
  statement: string
  layer: KnowledgeLayer
  /** 从哪条会话学来的。 */
  source: { kind: 'chat'; session_id: string; intent?: ChatIntent }
  answered_by: string
  answered_at: Iso8601
  /** 承诺类永不自动发布（48 §1.1 知识库那条）：这一格恒为 false 时上层才敢自动发。 */
  auto_publishable: boolean
}

export type ChatTeachingOutcome =
  /** AI 写了对客回复，可以投递。 */
  | 'sent'
  /** 模型没给出可用结果；指导已存，商家重试一次。 */
  | 'ai_unavailable'
  /** 草稿复读了商家原话：拒发，不是改改再发。 */
  | 'blocked_verbatim_leak'
  /** 会话已关：指导留下，什么都不说。 */
  | 'archived_only'

export interface ChatTeachingResult {
  outcome: ChatTeachingOutcome
  /** 能发的那句话（`sent` 时有）。 */
  reply?: string
  sediment: ChatTeachingSediment
  candidate?: ChatKnowledgeCandidate
}

export interface AcceptTeachingInput extends ChatTeachingInput {
  session_id: string
  /** 模型吐出来的对客回复；没有就是 `ai_unavailable`。 */
  reply?: string
  /** 会话已关：只存不发。 */
  closed?: boolean
}

/** 沉淀：`single_reply` 不进知识库；另外两档进候选。承诺类一律不许自动发布。 */
export function chatTeachingSediment(scope: ChatTeachingScope): ChatTeachingSediment {
  return scope === 'single_reply' ? 'none' : 'knowledge_candidate'
}

/**
 * 判一次「教 AI」的结果：能不能发、沉淀成什么。
 *
 * 注意返回值里 **`candidate` 与 `outcome` 相互独立**：草稿被泄漏守卫拒了，
 * 商家教的那条规则照样沉淀——被拒的是模型写的那句话，不是商家的判断。
 */
export function acceptChatTeaching(input: AcceptTeachingInput): ChatTeachingResult {
  const sediment = chatTeachingSediment(input.scope)
  const instruction = sanitizeExternal(input.instruction).slice(0, MAX_CHAT_INSTRUCTION_CHARS)
  const candidate: ChatKnowledgeCandidate | undefined =
    sediment === 'none'
      ? undefined
      : {
          statement: displayLine(instruction, MAX_CHAT_INSTRUCTION_CHARS),
          layer: input.scope === 'global_rule' ? 'policy' : 'phrasing',
          source: {
            kind: 'chat',
            session_id: input.session_id,
            ...(input.intent === undefined ? {} : { intent: input.intent }),
          },
          answered_by: input.taught_by,
          answered_at: input.now,
          // 19：承诺类永不自动发布。商家教的这条要不要进知识库，还得他自己再点一次头。
          auto_publishable: false,
        }
  const tail = { sediment, ...(candidate === undefined ? {} : { candidate }) }

  if (input.closed === true) return { outcome: 'archived_only', ...tail }
  const reply = input.reply?.trim() ?? ''
  if (reply.length === 0) return { outcome: 'ai_unavailable', ...tail }
  if (containsInstructionLeak(instruction, reply)) {
    return { outcome: 'blocked_verbatim_leak', ...tail }
  }
  return { outcome: 'sent', reply, ...tail }
}
