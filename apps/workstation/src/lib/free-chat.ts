/**
 * WP188「随便聊」的客户端：会话增删改走统一信封（`api()`），说一句 / 重新生成走 SSE
 * （`fetch` + `ReadableStream`，凭据在头里、不进 URL——与聊天沙盒同一种写法）。
 *
 * 前端仍然不引任何模型 SDK：模型只在服务端的模型网关里。
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
  /** WP207：模型找回归档时给出的候选（卡片；人点了才恢复）。 */
  archived_candidates?: ArchivedWorkCandidate[]
}

export interface FreeChatModelChoice {
  id: string
  label: string
  official: boolean
  vision: 'ok' | 'no' | 'unchecked'
}

export interface FreeChatModels {
  choices: FreeChatModelChoice[]
  default?: string
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
  | { type: 'done'; message: FreeChatMessage; session: FreeChatSession }
  | { type: 'error'; message: string }

export interface FreeChatTurnOptions {
  model?: string
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

/**
 * 说一句（或重新生成）：一帧一帧交给 `onFrame`，流结束时 resolve。
 * `signal` abort = 停（连接一断，服务端就把已经答出来的部分存成"停了"的一条）。
 */
export async function streamFreeChat(
  session_id: string,
  input:
    | ({ text: string; images?: FreeChatImage[] } & FreeChatTurnOptions)
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
