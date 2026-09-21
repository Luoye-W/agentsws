/**
 * 聊天会话与消息的内存档（测试、fast 模拟、没有数据目录的本地档）。
 * SQLite 档在 `sqlite-store.ts`，两档跑同一份一致性套件。
 */
import type { WorkspaceId } from '@agentsws/contracts'
import { ChannelError } from '../errors.js'
import {
  type ChatMessage,
  type ChatSession,
  type ChatSessionInput,
  type ChatSessionPatch,
  type ChatSource,
  type ChatStore,
  chatThreadExternalId,
} from './types.js'

const uniqueKey = (ws: WorkspaceId, source: ChatSource, external: string): string =>
  `${ws}|${source}|${external}`

export class MemoryChatStore implements ChatStore {
  private readonly sessions = new Map<string, ChatSession>()
  private readonly byUnique = new Map<string, string>()
  private readonly byThread = new Map<string, string>()
  private readonly messages = new Map<string, ChatMessage[]>()
  private seq = 0
  private msgSeq = 0

  ensureSession(input: ChatSessionInput): ChatSession {
    const key = uniqueKey(input.workspace_id, input.source, input.external_session_id)
    const known = this.byUnique.get(key)
    if (known !== undefined) return this.sessions.get(known) as ChatSession
    this.seq += 1
    const id = `cs_${String(this.seq).padStart(4, '0')}`
    const session: ChatSession = {
      id,
      workspace_id: input.workspace_id,
      source: input.source,
      external_session_id: input.external_session_id,
      visitor_id: input.visitor_id,
      status: 'open',
      thread_external_id: chatThreadExternalId(id),
      created_at: input.at,
      updated_at: input.at,
      takeover: false,
      ...(input.visitor_display === undefined ? {} : { visitor_display: input.visitor_display }),
    }
    this.sessions.set(id, session)
    this.byUnique.set(key, id)
    this.byThread.set(session.thread_external_id, id)
    this.messages.set(id, [])
    return session
  }

  getSession(id: string): ChatSession | undefined {
    return this.sessions.get(id)
  }

  findSession(
    workspace_id: WorkspaceId,
    source: ChatSource,
    external_session_id: string,
  ): ChatSession | undefined {
    const id = this.byUnique.get(uniqueKey(workspace_id, source, external_session_id))
    return id === undefined ? undefined : this.sessions.get(id)
  }

  findByThread(thread_external_id: string): ChatSession | undefined {
    const id = this.byThread.get(thread_external_id)
    return id === undefined ? undefined : this.sessions.get(id)
  }

  listSessions(
    workspace_id: WorkspaceId,
    filter: { status?: string[]; limit?: number } = {},
  ): ChatSession[] {
    const all = [...this.sessions.values()]
      .filter((s) => s.workspace_id === workspace_id)
      .filter((s) => filter.status === undefined || filter.status.includes(s.status))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
    return filter.limit === undefined ? all : all.slice(0, filter.limit)
  }

  patchSession(id: string, patch: ChatSessionPatch): ChatSession {
    const prior = this.sessions.get(id)
    if (prior === undefined) throw new ChannelError('not_found', `没有这条会话：${id}`, { id })
    const next: ChatSession = { ...prior, updated_at: patch.at }
    if (patch.status !== undefined) next.status = patch.status
    if (patch.takeover !== undefined) next.takeover = patch.takeover
    if (patch.visitor_email !== undefined) next.visitor_email = patch.visitor_email
    if (patch.last_seen_at !== undefined) next.last_seen_at = patch.last_seen_at
    // `null` = 清空（求助被接了 / 会话关了）；`undefined` = 这一格不动
    if (patch.assist_requested_at === null) delete next.assist_requested_at
    else if (patch.assist_requested_at !== undefined)
      next.assist_requested_at = patch.assist_requested_at
    if (patch.assist_deadline_at === null) delete next.assist_deadline_at
    else if (patch.assist_deadline_at !== undefined)
      next.assist_deadline_at = patch.assist_deadline_at
    if (patch.assist_reminded_at === null) delete next.assist_reminded_at
    else if (patch.assist_reminded_at !== undefined)
      next.assist_reminded_at = patch.assist_reminded_at
    this.sessions.set(id, next)
    return next
  }

  appendMessage(input: Omit<ChatMessage, 'id'>): ChatMessage {
    const list = this.messages.get(input.session_id)
    if (list === undefined) {
      throw new ChannelError('not_found', `没有这条会话：${input.session_id}`, {
        session_id: input.session_id,
      })
    }
    const already = list.find((m) => m.external_id === input.external_id)
    if (already !== undefined) return already
    this.msgSeq += 1
    const message: ChatMessage = { ...input, id: `cm_${String(this.msgSeq).padStart(6, '0')}` }
    list.push(message)
    return message
  }

  listMessages(session_id: string, filter: { limit?: number } = {}): ChatMessage[] {
    const all = [...(this.messages.get(session_id) ?? [])].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at),
    )
    return filter.limit === undefined ? all : all.slice(-filter.limit)
  }

  eraseVisitor(visitor_id: string): number {
    let rows = 0
    for (const session of [...this.sessions.values()]) {
      if (session.visitor_id !== visitor_id) continue
      rows += (this.messages.get(session.id) ?? []).length + 1
      this.messages.delete(session.id)
      this.sessions.delete(session.id)
      this.byThread.delete(session.thread_external_id)
      this.byUnique.delete(
        uniqueKey(session.workspace_id, session.source, session.external_session_id),
      )
    }
    return rows
  }
}

/** 沙盒页给访客造一个稳定 id（同一个人刷新页面回到同一条会话）。 */
export function sandboxVisitorId(person_id: string): string {
  return `sandbox:${person_id}`
}
