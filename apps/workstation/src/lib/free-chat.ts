/**
 * WP188「随便聊」的客户端：会话增删改走统一信封（`api()`），说一句 / 重新生成走 SSE
 * （`fetch` + `ReadableStream`，凭据在头里、不进 URL——与聊天沙盒同一种写法）。
 *
 * 前端仍然不引任何模型 SDK：模型只在服务端的模型网关里。
 *
 * WP343：随便聊改名「我的助理」（路由 `/assistant`，老地址跳过来；接口路径不动）——多了派活那一行、
 * 回报那一条、快捷问题、`@` 岗位与助理记忆。
 */
import type { ArchivedWorkCandidate } from '@agentsws/contracts'
import { ApiClientError, type ApiErrorBody, api, assignmentId, storedToken } from '@/lib/api'

export interface FreeChatSession {
  id: string
  title: string
  created_at: string
  updated_at: string
}

export interface FreeChatSource {
  url: string
  title?: string
}

export interface FreeChatCitation {
  n: number
  fact_card_id: string
  text: string
  source?: string
}

export interface FreeChatImage {
  mime: string
  data: string
}

export interface FreeChatMessage {
  id: string
  session_id: string
  role: 'user' | 'assistant'
  text: string
  at: string
  images?: FreeChatImage[]
  model?: { id: string; label: string; official: boolean }
  usage?: { input_tokens: number; output_tokens: number; credits?: number }
  sources?: FreeChatSource[]
  citations?: FreeChatCitation[]
  web_search?: boolean
  knowledge?: boolean
  stopped?: boolean
  error?: string
  /** WP425：这一轮从自己的 AI 切到了工坊积分（那一句）。 */
  source_switch?: string
  /** WP430：切过来源的那一轮原来选的是哪一个——AI 钮按它回到原选（下一轮先试原选）。 */
  chosen_model?: string
  /** WP425：自己的 AI 用不了、开关关着，这一轮停下了（出「用工坊积分接着做」那张卡）。 */
  source_fallback_off?: boolean
  /** WP207：模型找回归档时给出的候选（卡片；人点了才恢复）。 */
  archived_candidates?: ArchivedWorkCandidate[]
  /** WP343：用户这句是 `@` 给谁的（只显示）。 */
  to?: string
  /** WP343：这一轮交给岗位去做的事。 */
  dispatches?: FreeChatDispatch[]
  /** WP343：交出去的事回来报的一句。 */
  report?: FreeChatReport
  /** WP350：附上的文本类资料（只有名字与字数）。 */
  attachments?: FreeChatAttachment[]
  /** WP350：「我打算这样分」方案卡。 */
  fanout?: FreeChatFanout
  /** WP350：方案卡点过之后的汇总。 */
  fanout_summary?: FreeChatFanoutSummary
  /** WP352：属于长对话里的哪一段话题。 */
  segment_id?: string
  /** WP352：这一轮翻了以前聊过的，查回来的出处。 */
  recalled?: AssistantHistoryHit[]
}

/** WP352：长对话里的一段话题。 */
export interface AssistantSegment {
  id: string
  started_at: string
  ended_at?: string
  reason: 'first' | 'gap' | 'day' | 'topic' | 'manual' | 'migrated'
  title?: string
  summary?: string
  current: boolean
}

/** WP352：助理那一条长对话。 */
export interface AssistantThread {
  session: FreeChatSession
  segments: AssistantSegment[]
}

/** WP352：以前聊过的里面搜到的一处（小结或原话）。 */
export interface AssistantHistoryHit {
  segment_id: string
  message_id?: string
  kind: 'message' | 'summary'
  at: string
  role?: 'user' | 'assistant'
  title?: string
  snippet: string
  /** WP511：这条长对话里第几段（1 起）。 */
  segment_n?: number
  /** WP511：那一段里第几句（1 起）。 */
  message_n?: number
  /** WP511：命中的是附上的资料（名字）。 */
  attachment?: string
}

/** WP511（决策 1546）：以前某一段的原话（一页；第三栏「打开那一段」）。 */
export interface AssistantSegmentPage {
  segment: AssistantSegment
  /** 第几段（1 起）。 */
  n: number
  from: number
  total: number
  messages: FreeChatMessage[]
}

/** WP350：附上的一份资料（界面只看名字、字数、读不出的那句、抹掉了几处口令）。 */
export interface FreeChatAttachment {
  name: string
  chars: number
  unreadable?: string
  redacted?: number
}

/** WP350：方案卡上的一条。 */
export interface FreeChatFanoutItem {
  id: string
  kind: 'task' | 'note' | 'memory'
  text: string
  why?: string
  due?: string
  quote?: string
  position_id?: string
  position_name?: string
  role_id?: string
  duty_name?: string
  brand?: boolean
  unsure?: { reason: string }
  secret?: boolean
}

/** WP350：「我打算这样分」。 */
export interface FreeChatFanout {
  batch_id: string
  title: string
  source: { name: string; kind: 'meeting' | 'document' | 'human' }
  items: FreeChatFanoutItem[]
  positions: { position_id: string; name: string; duties: { role_id: string; name: string }[] }[]
  status: 'proposed' | 'sent' | 'dismissed'
  at: string
}

/** WP350：派好之后的汇总。 */
export interface FreeChatFanoutSummary {
  batch_id: string
  title: string
  groups: {
    position_id: string
    name: string
    tasks: { matter_id: string; title: string }[]
    notes: number
  }[]
  brand_notes: number
  memories: number
  skipped: { dropped: number; unsure: number; secret: number }
  knowledge_card_id?: string
  /** WP357（决策 902）：写进知识库就生效的那几条（撤销撤的就是它们）。 */
  note_card_ids?: string[]
  notes_undone_at?: string
  notes_undone?: number
  failed?: string[]
  at: string
}

/** WP350：人在方案卡上对一条的改动。 */
export interface FreeChatFanoutEdit {
  id: string
  drop?: boolean
  position_id?: string
  role_id?: string
  brand?: boolean
  text?: string
}

/** WP350：要附的一份资料（`data` 是 base64）。 */
export interface FreeChatFile {
  name: string
  data: string
  size: number
}

/** WP343：交给岗位的一件事。 */
export interface FreeChatDispatch {
  matter_id: string
  title: string
  position_id: string
  position_name: string
  role_id?: string
  duty_name?: string
  at: string
  /** WP350：同一张方案卡派出去的带同一个来源批次。 */
  batch_id?: string
}

/** WP343：交出去的事回来报一句。 */
export interface FreeChatReport {
  matter_id: string
  kind: 'done' | 'decide' | 'failed'
  position_name: string
  duty_name?: string
  approval_item_id?: string
  /** WP350：哪一批派出去的（按批次聚在一起）。 */
  batch_id?: string
  batch_title?: string
}

/** WP343：快捷问题与 `@` 能选的岗位。 */
export interface AssistantState {
  suggestions: {
    text: string
    kind: 'cards' | 'position' | 'dispatch' | 'create_position'
    href?: string
  }[]
  targets: { position_id: string; name: string; duties: { role_id: string; name: string }[] }[]
}

/** WP343：输入框里 `@` 选的那个。 */
export interface AssistantTarget {
  position_id: string
  role_id?: string
  /** 「Reddit 运营 · 官方版块」 */
  label: string
}

/** WP343：助理这一层的一条记忆。 */
export interface AssistantMemory {
  id: string
  text: string
  at: string
  written_by: 'ai' | 'person'
}

export interface FreeChatModelChoice {
  id: string
  label: string
  official: boolean
  vision: 'ok' | 'no' | 'unchecked'
  /** WP362：哪一组（工坊积分 / ChatGPT 订阅 / 自己接的）；老服务端没有 = 按 `official` 兜。 */
  group?: 'workshop' | 'subscription' | 'own'
  /** WP362：厂商（图标用）。 */
  vendor?: string
  /** WP362：每行右边那一格。 */
  price?: FreeChatModelPrice
  /** WP370：目录里给人看的名字（GPT-5.5、DeepSeek-V4.1-Flash）；没有就用 id 里的模型名。 */
  name?: string
  /** WP370：上下文窗口（token）。 */
  context_window?: number
  /** WP370：这个来源自带联网搜索（ChatGPT 订阅）。 */
  native_search?: boolean
  /** WP370：能调的思考程度（三档白话；没有 = 不出那一行）。 */
  thinking?: FreeChatModelThinking
}

/** WP370：思考程度的 id（官方 dsh / pi-ai 同名）。 */
export type ReasoningEffort = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
/** WP370：界面上的三档白话。 */
export type ThinkingLevel = 'fast' | 'standard' | 'deep'
export interface FreeChatModelThinking {
  options: { level: ThinkingLevel; effort: ReasoningEffort }[]
  default: ReasoningEffort
  /** WP373：只支持开 / 关（开 = `options[0].effort`，关 = `off`）；不给 = 三档。 */
  toggle?: true
}

/** WP362：消耗速率（DeepSeek v4 Pro 官方原价 = 1x）/ 限免 / 订阅额度 / 用你自己的 key。 */
export type FreeChatModelPrice =
  | {
      kind: 'rate'
      rate: number
      source: 'stats' | 'list_price'
      /** WP363（决策 954）：折扣（`0 < d < 1`，0.1 = 一折）；没有就不给。倍率仍是原价口径。 */
      discount?: number
    }
  | { kind: 'free' }
  | { kind: 'subscription' }
  | { kind: 'own_key' }

export interface FreeChatModels {
  choices: FreeChatModelChoice[]
  default?: string
  /** WP362：消耗速率的 1x 是哪个模型（`fallback` = 价目里没有 DeepSeek v4 Pro，退回默认模型）。 */
  rate_base?: { model: string; fallback: boolean }
  rate_note?: string
  web_search: { available: boolean; reason?: string; max_searches: number }
  knowledge: { available: boolean }
}

export type FreeChatFrame =
  | { type: 'start'; user?: FreeChatMessage; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'searching'; query: string }
  | { type: 'sources'; sources: FreeChatSource[] }
  | { type: 'notice'; text: string }
  | { type: 'archived_candidates'; candidates: ArchivedWorkCandidate[] }
  | { type: 'dispatched'; dispatch: FreeChatDispatch }
  | { type: 'fanout'; fanout: FreeChatFanout }
  | { type: 'done'; message: FreeChatMessage; session: FreeChatSession }
  | { type: 'error'; message: string }

export interface FreeChatTurnOptions {
  model?: string
  /** WP370：连同 `model` 一起选的思考程度。 */
  effort?: ReasoningEffort
  web_search?: boolean
  knowledge?: boolean
}

const base = '/v1/free-chat'
const one = (id: string): string => `${base}/sessions/${encodeURIComponent(id)}`

export const getFreeChatModels = (): Promise<FreeChatModels> => api(`${base}/models`)
export const listFreeChatSessions = (): Promise<FreeChatSession[]> => api(`${base}/sessions`)
export const createFreeChatSession = (title?: string): Promise<FreeChatSession> =>
  api(`${base}/sessions`, { method: 'POST', body: title === undefined ? {} : { title } })
export const renameFreeChatSession = (id: string, title: string): Promise<FreeChatSession> =>
  api(one(id), { method: 'PATCH', body: { title } })
export const deleteFreeChatSession = (id: string): Promise<{ deleted: boolean }> =>
  api(one(id), { method: 'DELETE' })
export const listFreeChatMessages = (id: string): Promise<FreeChatMessage[]> =>
  api(`${one(id)}/messages`)
export const stopFreeChat = (id: string): Promise<{ stopped: boolean }> =>
  api(`${one(id)}/stop`, { method: 'POST' })
/** WP343：快捷问题与 `@` 能选的岗位。 */
export const getAssistantState = (): Promise<AssistantState> => api(`${base}/assistant`)
/** WP343：助理这一层的记忆。 */
export const listAssistantMemory = (): Promise<AssistantMemory[]> => api(`${base}/memory`)
export const forgetAssistantMemory = (id: string): Promise<{ deleted: boolean }> =>
  api(`${base}/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })
/** WP350：方案卡「就这样」（带改动）/「不用了」。 */
export const confirmFanout = (
  session_id: string,
  batch_id: string,
  body: { items?: FreeChatFanoutEdit[]; dismiss?: boolean },
): Promise<{ plan: FreeChatMessage; summary?: FreeChatMessage }> =>
  api(`${one(session_id)}/fanout/${encodeURIComponent(batch_id)}`, { method: 'POST', body })

/** WP357（决策 902）：汇总卡上「撤销」——这一批写进知识库的口径全部退役。 */
export const undoFanoutNotes = (
  session_id: string,
  batch_id: string,
): Promise<{ summary: FreeChatMessage }> =>
  api(`${one(session_id)}/fanout/${encodeURIComponent(batch_id)}/undo-notes`, { method: 'POST' })
/** WP357：改一条助理记进知识库的口径（就地改、旧句留痕）。 */
export const editAssistantNote = (card_id: string, statement: string): Promise<unknown> =>
  api(`${base}/notes/${encodeURIComponent(card_id)}`, { method: 'PATCH', body: { statement } })
/** WP357：删一条助理记进知识库的口径（退役留痕）。 */
export const removeAssistantNote = (card_id: string): Promise<{ retired: boolean }> =>
  api(`${base}/notes/${encodeURIComponent(card_id)}`, { method: 'DELETE' })

/** WP352：助理那一条长对话（老会话第一次拼进来）。 */
export const getAssistantThread = (): Promise<AssistantThread> => api(`${base}/thread`)
/** WP352：换个话题。 */
export const newAssistantTopic = (): Promise<AssistantThread> =>
  api(`${base}/thread/topic`, { method: 'POST' })
/** WP352：搜以前聊过的。 */
export const searchAssistantHistory = (q: string): Promise<AssistantHistoryHit[]> =>
  api(`${base}/thread/search?q=${encodeURIComponent(q)}`)

/** WP511：以前某一段的原话（一页，从第 `from` 句起）。 */
export const getAssistantSegment = (
  id: string,
  from = 1,
  limit = 50,
): Promise<AssistantSegmentPage> =>
  api(`${base}/thread/segments/${encodeURIComponent(id)}?from=${from}&limit=${limit}`)

/** WP352：回答开头「换话题了」的记号（服务端分段用，不给人看；流式时可能只到一半）。 */
const TOPIC_TAG = '<new-topic/>'

/**
 * WP343：回答末尾的 `<remember>` 标记不给人看（流式时还没被服务端拿掉）。
 * WP352：开头的 `<new-topic/>`（含流到一半的前缀）同样藏掉。
 */
export const hideRememberTags = (text: string): string => {
  let out = text.split(TOPIC_TAG).join('')
  const lead = out.trimStart()
  if (lead !== '' && TOPIC_TAG.startsWith(lead)) out = ''
  return out.replace(/<remember\b[^>]*>[\s\S]*?(<\/remember>|$)/giu, '').trimEnd()
}

/**
 * 说一句（或重新生成）：一帧一帧交给 `onFrame`，流结束时 resolve。
 * `signal` abort = 停（连接一断，服务端就把已经答出来的部分存成"停了"的一条）。
 */
export async function streamFreeChat(
  session_id: string,
  input:
    | ({
        text: string
        images?: FreeChatImage[]
        /** WP343：`@` 选的岗位 / 职责（直接交给它）。 */
        target?: AssistantTarget
        /** WP350：附上的文本类资料。 */
        files?: { name: string; data: string }[]
      } & FreeChatTurnOptions)
    | ({ regenerate: true } & FreeChatTurnOptions),
  onFrame: (frame: FreeChatFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const headers = new Headers({ 'content-type': 'application/json' })
  const token = storedToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = assignmentId()
  if (asg !== null) headers.set('X-Assignment', asg)
  const regenerate = 'regenerate' in input
  const body: Record<string, unknown> = { ...input }
  delete body.regenerate
  const res = await fetch(`${one(session_id)}/${regenerate ? 'regenerate' : 'messages'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new ApiClientError(res.status, (text === '' ? {} : JSON.parse(text)) as ApiErrorBody)
  }
  await readFrames(res, onFrame, signal)
}

/** 按行读 SSE（`data: {...}`）；没有 body（测试替身）就一次读完。 */
export async function readFrames(
  res: { body: ReadableStream<Uint8Array> | null; text(): Promise<string> },
  onFrame: (frame: FreeChatFrame) => void,
  signal?: AbortSignal,
): Promise<void> {
  const line = (raw: string): void => {
    if (!raw.startsWith('data: ')) return
    try {
      onFrame(JSON.parse(raw.slice(6)) as FreeChatFrame)
    } catch {
      // 半截的行不会出现（按 \n 切），坏行跳过
    }
  }
  if (res.body === null) {
    for (const raw of (await res.text()).split('\n')) line(raw)
    return
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted === true) break
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let at = buffer.indexOf('\n')
      while (at >= 0) {
        line(buffer.slice(0, at))
        buffer = buffer.slice(at + 1)
        at = buffer.indexOf('\n')
      }
    }
  } catch (e) {
    // 用户点了停：fetch 抛 AbortError，这是正常收尾
    if ((e as { name?: string }).name !== 'AbortError') throw e
  }
}

/** 按日期分组：今天 / 昨天 / 7 天内 / 更早（DeepSeek 网页版的样子）。 */
export type SessionGroup = 'today' | 'yesterday' | 'week' | 'older'

export function groupOf(updated_at: string, now: Date = new Date()): SessionGroup {
  const day = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diff = Math.round((day(now) - day(new Date(updated_at))) / 86_400_000)
  if (diff <= 0) return 'today'
  if (diff === 1) return 'yesterday'
  if (diff < 7) return 'week'
  return 'older'
}

/** 贴 / 拖进来的一张图 → base64（不带 `data:` 前缀）。 */
export function readImage(file: File): Promise<FreeChatImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      const comma = url.indexOf(',')
      resolve({ mime: file.type, data: url.slice(comma + 1) })
    }
    reader.onerror = () => reject(reader.error ?? new Error('读不出这张图'))
    reader.readAsDataURL(file)
  })
}

/** WP350：能附的文本类资料（扩展名）；WP357（决策 904）加表格 .xlsx / .csv。 */
export const DOC_EXTENSIONS = ['txt', 'md', 'docx', 'pdf', 'xlsx', 'csv'] as const
/** WP357：一份资料最多多大、一次最多几份（助理、岗位页、事项输入框同一道；服务端还会再闸一次）。 */
export const DOC_MAX_BYTES = 5 * 1024 * 1024
export const DOC_MAX_COUNT = 3
export const isDocFile = (name: string): boolean =>
  (DOC_EXTENSIONS as readonly string[]).includes(name.split('.').pop()?.toLowerCase() ?? '')
/** WP350：粘贴超过这么多字就收成一份附件（不塞进输入框）。 */
export const PASTE_AS_FILE_CHARS = 1500

/** WP350：一段字 → base64（UTF-8；分块转，长文不爆栈）。 */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

/** WP350：附一份资料 → base64（不带 `data:` 前缀）。 */
export function readDoc(file: File): Promise<FreeChatFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = String(reader.result)
      resolve({ name: file.name, data: url.slice(url.indexOf(',') + 1), size: file.size })
    }
    reader.onerror = () => reject(reader.error ?? new Error('读不出这份文件'))
    reader.readAsDataURL(file)
  })
}
