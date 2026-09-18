/**
 * WP113（63 §3）：**消息库**的端口与内存实现。
 *
 * 端口化的理由与 `MailSource` 一样：测试里不能真去连一只邮箱，也不该为了跑一条
 * 分拣用例先起一个 SQLite。真装配用 `SqliteMessageStore`（同一份用例跑两遍，
 * 见 `test/messages-store.test.ts`）。
 *
 * **信件全部落本机库**（63 §10）：没有任何一条路把正文送出这台机器，
 * 除了分拣与回复建议那两处显式的模型调用——而那两处走的是用户自己配置的网关。
 */

import type {
  MaybePromise,
  MessageDraft,
  MessageFolder,
  MessageFolderKind,
  MessageLabel,
  MessageListQuery,
  MessageRecord,
  MessageThreadSummary,
  SenderRule,
} from '@agentsws/contracts'
import { BUILTIN_LABELS } from './labels.js'
import { aggregateThreads, byNewest, matchesQuery } from './query.js'

/** 一次局部改（旗标 / 标签 / 文件夹 / 路由 / 分拣结论）。 */
export type MessagePatch = Partial<
  Pick<
    MessageRecord,
    'flags' | 'labels' | 'folder' | 'folder_kind' | 'route' | 'triage' | 'uid' | 'linked' | 'html'
  >
>

export interface MessageStore {
  /** 落一封信（同 id 覆盖；同 `account + message_id` 视为同一封，见 {@link MessageStore.find}）。 */
  put(record: MessageRecord): MaybePromise<void>
  get(id: string): MaybePromise<MessageRecord | undefined>
  /** 去重：这只邮箱里有没有这个 `Message-ID`。 */
  find(account: string, message_id: string): MaybePromise<MessageRecord | undefined>
  list(query: MessageListQuery): MaybePromise<MessageRecord[]>
  /** 会话聚合后的列表（中栏那一列）。 */
  threads(query: MessageListQuery): MaybePromise<MessageThreadSummary[]>
  /** 一条会话里的全部信（时间正序）。 */
  thread(thread_id: string): MaybePromise<MessageRecord[]>
  update(id: string, patch: MessagePatch): MaybePromise<MessageRecord | undefined>
  /** 文件夹清单 + 未读数。 */
  folders(account?: string): MaybePromise<MessageFolder[]>
  /** 这台机器上连着哪几只邮箱（库里见过的那几个地址）。 */
  accounts(): MaybePromise<string[]>

  labels(): MaybePromise<MessageLabel[]>
  putLabel(label: MessageLabel): MaybePromise<void>
  /** 内置标签删不掉（只能改名改色）；删自建标签会把它从所有信上摘掉。 */
  deleteLabel(id: string): MaybePromise<boolean>

  senderRules(): MaybePromise<SenderRule[]>
  putSenderRule(rule: SenderRule): MaybePromise<void>
  deleteSenderRule(id: string): MaybePromise<boolean>

  drafts(): MaybePromise<MessageDraft[]>
  getDraft(id: string): MaybePromise<MessageDraft | undefined>
  putDraft(draft: MessageDraft): MaybePromise<void>
  deleteDraft(id: string): MaybePromise<boolean>

  /** 「总是信任这个发件人」的名单（远程图片默认不加载，63 §7）。 */
  trustedSenders(): MaybePromise<string[]>
  trustSender(email: string): MaybePromise<void>

  close?(): MaybePromise<void>
}

/** 文件夹真名 → 语义。各家名字不一样，认不出的一律 `custom`。 */
export function folderKindOf(path: string): MessageFolderKind {
  const p = path.trim().toLowerCase()
  if (p === 'inbox') return 'inbox'
  if (p === 'kefuagents') return 'support'
  if (p === 'kolagents') return 'kol'
  if (/(^|\/)(sent|sent items|sent messages|sent mail|已发送|已发信件)$/.test(p)) return 'sent'
  if (/(^|\/)(drafts|draft|草稿|草稿箱)$/.test(p)) return 'drafts'
  if (/(^|\/)(trash|deleted items|bin|已删除|垃圾桶)$/.test(p)) return 'trash'
  if (/(^|\/)(spam|junk|bulk mail|垃圾邮件)$/.test(p)) return 'spam'
  if (/(^|\/)(archive|all mail|归档|所有邮件)$/.test(p)) return 'archive'
  return 'custom'
}

/** 语义 → 这只邮箱上的真名（挪信时用）。认不出就用语义名本身。 */
export function folderPathFor(kind: MessageFolderKind, known: readonly string[]): string {
  const hit = known.find((p) => folderKindOf(p) === kind)
  if (hit !== undefined) return hit
  switch (kind) {
    case 'inbox':
      return 'INBOX'
    case 'support':
      return 'kefuagents'
    case 'kol':
      return 'kolagents'
    case 'trash':
      return 'Trash'
    case 'spam':
      return 'Junk'
    case 'sent':
      return 'Sent'
    case 'drafts':
      return 'Drafts'
    case 'archive':
      return 'Archive'
    default:
      return 'INBOX'
  }
}

export class MemoryMessageStore implements MessageStore {
  private readonly rows = new Map<string, MessageRecord>()
  private readonly labelRows = new Map<string, MessageLabel>(
    BUILTIN_LABELS.map((l) => [l.id, { ...l }]),
  )
  private readonly rules = new Map<string, SenderRule>()
  private readonly draftRows = new Map<string, MessageDraft>()
  private readonly trusted = new Set<string>()

  put(record: MessageRecord): void {
    this.rows.set(record.id, clone(record))
  }

  get(id: string): MessageRecord | undefined {
    const row = this.rows.get(id)
    return row === undefined ? undefined : clone(row)
  }

  find(account: string, message_id: string): MessageRecord | undefined {
    for (const row of this.rows.values())
      if (row.account === account && row.message_id === message_id) return clone(row)
    return undefined
  }

  list(query: MessageListQuery): MessageRecord[] {
    const all = [...this.rows.values()].filter((m) => matchesQuery(m, query)).sort(byNewest)
    const limit = query.limit ?? 200
    return all.slice(0, limit).map(clone)
  }

  threads(query: MessageListQuery): MessageThreadSummary[] {
    // 聚合**先于**截断：先挑出这一屏的会话，再去取它们的信
    const matched = [...this.rows.values()].filter((m) => matchesQuery(m, query))
    const threadIds = new Set(matched.map((m) => m.thread_id))
    const full = [...this.rows.values()].filter((m) => threadIds.has(m.thread_id))
    return aggregateThreads(full).slice(0, query.limit ?? 100)
  }

  thread(thread_id: string): MessageRecord[] {
    return [...this.rows.values()]
      .filter((m) => m.thread_id === thread_id)
      .sort((a, b) => Date.parse(a.date) - Date.parse(b.date))
      .map(clone)
  }

  update(id: string, patch: MessagePatch): MessageRecord | undefined {
    const row = this.rows.get(id)
    if (row === undefined) return undefined
    const next: MessageRecord = { ...row, ...stripUndefined(patch) }
    this.rows.set(id, next)
    return clone(next)
  }

  folders(account?: string): MessageFolder[] {
    const byKey = new Map<string, MessageFolder>()
    for (const row of this.rows.values()) {
      if (account !== undefined && row.account !== account) continue
      const key = `${row.account}|${row.folder}`
      const cur = byKey.get(key) ?? {
        path: row.folder,
        kind: row.folder_kind,
        account: row.account,
        unread: 0,
        total: 0,
      }
      cur.total += 1
      if (!row.flags.read) cur.unread += 1
      byKey.set(key, cur)
    }
    return [...byKey.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  accounts(): string[] {
    return [...new Set([...this.rows.values()].map((m) => m.account))].sort()
  }

  labels(): MessageLabel[] {
    return [...this.labelRows.values()].map((l) => ({ ...l }))
  }

  putLabel(label: MessageLabel): void {
    this.labelRows.set(label.id, { ...label })
  }

  deleteLabel(id: string): boolean {
    const row = this.labelRows.get(id)
    if (row === undefined || row.builtin) return false
    this.labelRows.delete(id)
    for (const [key, m] of this.rows)
      if (m.labels.includes(id))
        this.rows.set(key, { ...m, labels: m.labels.filter((l) => l !== id) })
    return true
  }

  senderRules(): SenderRule[] {
    return [...this.rules.values()].map((r) => ({ ...r, labels: [...r.labels] }))
  }

  putSenderRule(rule: SenderRule): void {
    this.rules.set(rule.id, { ...rule, labels: [...rule.labels] })
  }

  deleteSenderRule(id: string): boolean {
    return this.rules.delete(id)
  }

  drafts(): MessageDraft[] {
    return [...this.draftRows.values()]
      .map((d) => ({ ...d }))
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))
  }

  getDraft(id: string): MessageDraft | undefined {
    const row = this.draftRows.get(id)
    return row === undefined ? undefined : { ...row }
  }

  putDraft(draft: MessageDraft): void {
    this.draftRows.set(draft.id, { ...draft })
  }

  deleteDraft(id: string): boolean {
    return this.draftRows.delete(id)
  }

  trustedSenders(): string[] {
    return [...this.trusted].sort()
  }

  trustSender(email: string): void {
    this.trusted.add(email.trim().toLowerCase())
  }
}

function clone(m: MessageRecord): MessageRecord {
  return {
    ...m,
    references: [...m.references],
    to: m.to.map((a) => ({ ...a })),
    cc: m.cc.map((a) => ({ ...a })),
    bcc: m.bcc.map((a) => ({ ...a })),
    labels: [...m.labels],
    attachments: m.attachments.map((a) => ({ ...a })),
    flags: { ...m.flags },
    ...(m.triage === undefined ? {} : { triage: { ...m.triage, labels: [...m.triage.labels] } }),
  }
}

/** `exactOptionalPropertyTypes` 下 `{ x: undefined }` 与"没有 x"不是一回事。 */
function stripUndefined<T extends object>(patch: T): Partial<T> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(patch)) if (v !== undefined) out[k] = v
  return out as Partial<T>
}
