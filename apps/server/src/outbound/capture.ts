/**
 * WP323：**写入点**——从「发出去了」的那一跳认出要记的那一行。
 *
 * 两个总口子（都在 `server.ts` 的执行器装配上，一处接住所有渠道）：
 * - {@link recordFromApproval}：批准了的对外草稿真发出去（`deliverOutbound` 回 ok）——客服回信、聊天、社媒回帖…
 * - {@link recordsFromChange}：变更账本里「发出去」类的变更施行成功（`backendApply` 回 ok）——开发信、询盘回复、
 *   红人外联…（一批信一封一行）。
 * 社媒发帖 / 群发不经这两跳（到点由社媒服务自己发），在 `social-service.ts` 发成功那一刻另记。
 *
 * 只认结构化字段，不现编；认不出的字段就空着（宁缺不猜）。
 */
import type {
  ApprovalItem,
  ChangeKind,
  OutboundRecordInput,
  StagedChange,
} from '@agentsws/contracts'
import { finalPayload } from '@agentsws/txn'

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 一个收件人格子 → 人看得懂的字（邮箱 / 名字；对象引用认不出就空着）。 */
function who(v: unknown): string | undefined {
  if (typeof v === 'string') return str(v)
  if (Array.isArray(v)) {
    const list = v.map(who).filter((x): x is string => x !== undefined)
    return list.length === 0 ? undefined : list.join(', ')
  }
  if (isRecord(v)) return str(v.email) ?? str(v.name) ?? str(v.handle) ?? str(v.label)
  return undefined
}

/** 正文：`body` 是字符串，或 `{ text, subject }`。 */
function bodyOf(p: Record<string, unknown>): { text?: string; subject?: string } {
  const b = p.body
  if (typeof b === 'string') return { text: b }
  if (isRecord(b))
    return {
      ...(str(b.text) === undefined ? {} : { text: str(b.text) as string }),
      ...(str(b.subject) === undefined ? {} : { subject: str(b.subject) as string }),
    }
  const text = str(p.text) ?? str(p.message) ?? str(p.content)
  return text === undefined ? {} : { text }
}

/** 渠道 → 动作（没别的说法时）。 */
const ACTION_OF_CHANNEL: Readonly<Record<string, string>> = { email: 'email', chat: 'message' }

/** 批准了、真发出去的那张草稿卡 → 一行。 */
export function recordFromApproval(
  item: ApprovalItem,
  approverName?: (person_id: string) => string | undefined,
): OutboundRecordInput | undefined {
  if (item.kind !== 'outbound_draft') return undefined
  const fp = finalPayload(item)
  const p = isRecord(fp) ? fp : isRecord(item.payload) ? item.payload : {}
  const body = bodyOf(p)
  const channel = str(p.channel) ?? 'email'
  const social = p.form === 'social_reply'
  const by = item.decision?.by
  const approved_by =
    by === undefined ? undefined : by === 'mandate' ? '自动' : (approverName?.(by) ?? by)
  return {
    source_key: `approval:${item.id}`,
    channel,
    action: social ? 'reply' : (ACTION_OF_CHANNEL[channel] ?? 'message'),
    kind: social ? 'social_reply' : item.kind,
    ...(social
      ? {
          ...(str(p.channel_label) === undefined ? {} : { destination: str(p.channel_label) }),
          ...(str(p.author) === undefined ? {} : { counterpart: str(p.author) }),
          ...(str(p.in_reply_to) === undefined ? {} : { counterpart_text: str(p.in_reply_to) }),
        }
      : who(p.to) === undefined
        ? {}
        : { destination: who(p.to), counterpart: who(p.to) }),
    ...(body.subject === undefined ? {} : { subject: body.subject }),
    content: body.text ?? '',
    approval_item_id: item.id,
    ...(item.subject.matter_id === undefined ? {} : { matter_id: item.subject.matter_id }),
    role_id: item.role_id,
    ...(approved_by === undefined ? {} : { approved_by }),
    ...(item.decision?.at === undefined ? {} : { approved_at: item.decision.at }),
  } as OutboundRecordInput
}

/**
 * 「发出去」类的变更（施行成功 = 发出去了）。社媒发帖 / 群发 / 社群发帖不在这里：
 * 它们批了只是排期，到点由社媒服务发，发成功那一刻另记。
 */
export const OUTBOUND_CHANGE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'kol_outreach',
  'b2b_reply',
  'b2b_outreach',
  'review_reply',
  'press_release',
  'export_docs_send',
])

const CHANNEL_OF_KIND: Partial<Record<ChangeKind, string>> = {
  kol_outreach: 'email',
  b2b_reply: 'email',
  b2b_outreach: 'email',
  export_docs_send: 'email',
  review_reply: 'review',
  press_release: 'press',
}

/** 施行成功的那条变更 → 一行或几行（一批开发信一封一行）。 */
export function recordsFromChange(
  change: StagedChange,
  approverName?: (person_id: string) => string | undefined,
): OutboundRecordInput[] {
  if (!OUTBOUND_CHANGE_KINDS.has(change.kind)) return []
  const after = isRecord(change.after) ? change.after : {}
  const by = change.approval?.by
  const approved_by =
    by === undefined ? undefined : by === 'mandate' ? '自动' : (approverName?.(by) ?? by)
  const base = {
    channel: str(after.channel) ?? CHANNEL_OF_KIND[change.kind] ?? 'email',
    kind: change.kind,
    change_id: change.id,
    role_id: change.role_id,
    ...(change.approval === undefined ? {} : { approval_item_id: change.approval.item_id }),
    ...(approved_by === undefined ? {} : { approved_by }),
    ...(change.approval?.at === undefined ? {} : { approved_at: change.approval.at }),
  }
  const one = (p: Record<string, unknown>, key: string): OutboundRecordInput => {
    const body = bodyOf(p)
    const to = who(p.to) ?? who(p.recipient) ?? who(p.email) ?? who(p.contact)
    const action =
      base.channel === 'email' ? 'email' : change.kind === 'review_reply' ? 'reply' : 'post'
    return {
      ...base,
      source_key: key,
      action,
      ...(to === undefined ? {} : { destination: to, counterpart: to }),
      ...((body.subject ?? str(p.subject)) === undefined
        ? {}
        : { subject: (body.subject ?? str(p.subject)) as string }),
      ...(str(p.url) === undefined ? {} : { link: str(p.url) as string }),
      content: body.text ?? '',
    } as OutboundRecordInput
  }
  const emails = Array.isArray(after.emails) ? after.emails.filter(isRecord) : []
  if (emails.length > 0) return emails.map((e, i) => one(e, `change:${change.id}:${i}`))
  return [one(after, `change:${change.id}`)]
}
