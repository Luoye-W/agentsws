/**
 * WP113（63 §3）：原始 MIME → {@link MessageRecord}。
 *
 * 分工与 18 §2.1 一致，一个字没改：
 * - **原文进受控原始材料区**（加密、按发件人为 `subject_ref`、随主体删除）；
 * - **库里只存解析后的**头、纯文本、净化过的 HTML、附件元数据；
 * - 附件字节走 `RawStore`（装了对象存储时它自己会转到 blob）。
 *
 * 与 `EmailChannelAdapter.toInbound` 的关系：那一条产出的是 `InboundEvent`
 * （喂给入站管线、变成岗位事项），这一条产出的是**消息库里的一行**（给人看的那只
 * 邮箱）。两条路读同一封信，但要的东西不一样——那边只要正文，这边要版式、
 * 附件名、抄送人和收件时间。共用的解析零件（`mime.ts`）是同一份。
 */

import type {
  MessageAddress,
  MessageAttachmentMeta,
  MessageRecord,
  WorkspaceId,
} from '@agentsws/contracts'
import { sha256 } from '@agentsws/core'
import { type AddressObject, type ParsedMail, simpleParser } from 'mailparser'
import type { RawEmailMessage } from '../email/imap.js'
import {
  htmlToText,
  normalizeAddress,
  normalizeMessageId,
  normalizeText,
  parseReferences,
  stripQuotedTail,
  threadExternalId,
} from '../email/mime.js'
import { ChannelError } from '../errors.js'
import type { RawStore } from '../raw-store.js'
import { sanitizeMessageHtml } from './sanitize.js'
import { folderKindOf } from './store.js'

/** 列表那一行最多显示多少字。 */
export const SNIPPET_LIMIT = 160

export interface ParseMessageInput {
  raw: RawEmailMessage
  account: string
  folder: string
  workspace_id: WorkspaceId
  received_at: string
  rawStore?: RawStore
}

export async function parseMessage(input: ParseMessageInput): Promise<MessageRecord> {
  const parsed = await simpleParser(input.raw.source)
  const from = firstAddress(parsed.from)
  if (from === undefined)
    throw new ChannelError('invalid_input', '入站邮件缺 From', { uid: input.raw.uid })

  const message_id = normalizeMessageId(parsed.messageId)
  const references = parseReferences(parsed.references)
  const in_reply_to = normalizeMessageId(parsed.inReplyTo)
  const thread_id =
    threadExternalId({
      ...(message_id === undefined ? {} : { message_id }),
      ...(in_reply_to === undefined ? {} : { in_reply_to }),
      references,
    }) ?? `email-thread:${sha256(from.email + (parsed.subject ?? '')).slice(0, 16)}`

  // 原文进受控原始材料区。`subject_ref` = 发件人：受控区按它加密、按它随主体删除
  const raw_ref =
    input.rawStore === undefined
      ? undefined
      : await input.rawStore.put({
          channel: 'email',
          kind: 'message',
          stored_at: input.received_at,
          payload: input.raw.source,
          mime: 'message/rfc822',
          subject_ref: from.email,
          name: `${input.folder}/${input.raw.uid}`,
        })

  const plain = typeof parsed.text === 'string' ? parsed.text : ''
  const rawHtml = typeof parsed.html === 'string' ? parsed.html : ''
  const text =
    plain.trim().length > 0
      ? stripQuotedTail(plain)
      : rawHtml.length > 0
        ? stripQuotedTail(htmlToText(rawHtml))
        : normalizeText(plain)
  const sanitized = sanitizeMessageHtml(rawHtml)

  const attachments: MessageAttachmentMeta[] = []
  for (const [i, att] of (parsed.attachments ?? []).entries()) {
    const ref =
      input.rawStore === undefined
        ? undefined
        : await input.rawStore.put({
            channel: 'email',
            kind: 'attachment',
            stored_at: input.received_at,
            payload: new Uint8Array(att.content),
            subject_ref: from.email,
            ...(att.contentType === undefined ? {} : { mime: att.contentType }),
            ...(att.filename === undefined ? {} : { name: att.filename }),
          })
    attachments.push({
      id: `${input.raw.uid}_${i}`,
      name: att.filename ?? `附件 ${i + 1}`,
      mime: att.contentType ?? 'application/octet-stream',
      size: att.size ?? att.content.length,
      ...(ref === undefined ? {} : { ref }),
      ...(att.contentDisposition === 'inline' ? { inline: true } : {}),
      ...(att.cid === undefined ? {} : { content_id: att.cid }),
    })
  }

  const headers = triageHeaders(parsed)
  const flags = flagsOf(input.raw)
  const folder_kind = folderKindOf(input.folder)
  const date =
    parsed.date instanceof Date && !Number.isNaN(parsed.date.getTime())
      ? parsed.date.toISOString()
      : (input.raw.internal_date ?? input.received_at)

  return {
    id: messageRowId(input.account, input.folder, input.raw.uid, message_id),
    workspace_id: input.workspace_id,
    source: 'email',
    account: input.account,
    folder: input.folder,
    folder_kind,
    uid: input.raw.uid,
    thread_id,
    ...(message_id === undefined ? {} : { message_id }),
    ...(in_reply_to === undefined ? {} : { in_reply_to }),
    references,
    headers,
    from,
    to: addressesOf(parsed.to),
    cc: addressesOf(parsed.cc),
    bcc: addressesOf(parsed.bcc),
    subject: parsed.subject ?? '',
    snippet: snippetOf(text),
    text,
    ...(sanitized.html === '' ? {} : { html: sanitized.html }),
    has_remote_images: sanitized.has_remote_images,
    attachments,
    date,
    received_at: input.received_at,
    flags: { ...flags, draft: folder_kind === 'drafts' || flags.draft },
    labels: [],
    route: 'inbox',
    ...(raw_ref === undefined ? {} : { raw_ref }),
  }
}

/**
 * 消息库里的 id。
 *
 * 用 `Message-ID` 的哈希而不是 `账号|文件夹|uid`：一封信被挪到另一个文件夹之后
 * UID 会换号，用位置当身份的话同一封信会变成两条。没有 `Message-ID` 的
 * （少数畸形信）才退回位置。
 */
export function messageRowId(
  account: string,
  folder: string,
  uid: number,
  message_id: string | undefined,
): string {
  const key = message_id ?? `${folder}|${uid}`
  return `msg_${sha256(`${account}|${key}`).slice(0, 24)}`
}

/**
 * 分拣要看的那几个头（63 §4 ③）。
 *
 * **白名单**，不是"把头都抄下来"：`Received` 链与 DKIM 签名属于原文，
 * 留在受控原始材料区就够了，库里不该有第二份明文副本（21 §4）。
 */
export const TRIAGE_HEADERS: readonly string[] = [
  'list-unsubscribe',
  'list-id',
  'auto-submitted',
  'precedence',
  'authentication-results',
  'return-path',
]

/**
 * 从 `headerLines`（**原始行**）里取，不从 `parsed.headers`。
 *
 * 这不是风格问题：mailparser 会把 `List-Unsubscribe` 结构化进一个叫 `list` 的
 * 键，于是 `headers.get('list-unsubscribe')` 永远是 `undefined`——分拣第 ③ 层
 * 因此一次都不会命中，每一封群发都会白白花一次模型。原始行没有这个问题。
 */
export function triageHeaders(parsed: ParsedMail): Record<string, string> {
  const out: Record<string, string> = {}
  const wanted = new Set(TRIAGE_HEADERS)
  for (const line of parsed.headerLines ?? []) {
    const key = line.key.toLowerCase()
    if (!wanted.has(key) || out[key] !== undefined) continue
    const colon = line.line.indexOf(':')
    const value = (colon < 0 ? line.line : line.line.slice(colon + 1)).trim()
    if (value !== '') out[key] = value.slice(0, 500)
  }
  return out
}

function snippetOf(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > SNIPPET_LIMIT ? `${one.slice(0, SNIPPET_LIMIT - 1)}…` : one
}

/** IMAP flags → 我们那四格。拉不到 flags 的替身一律按"未读、没星标"算。 */
function flagsOf(raw: RawEmailMessage): MessageRecord['flags'] {
  const set = new Set((raw.flags ?? []).map((f) => f.toLowerCase()))
  return {
    read: set.has('\\seen'),
    starred: set.has('\\flagged'),
    answered: set.has('\\answered'),
    draft: set.has('\\draft'),
  }
}

function firstAddress(a: AddressObject | AddressObject[] | undefined): MessageAddress | undefined {
  return addressesOf(a)[0]
}

function addressesOf(a: AddressObject | AddressObject[] | undefined): MessageAddress[] {
  if (a === undefined) return []
  const objs = Array.isArray(a) ? a : [a]
  const out: MessageAddress[] = []
  for (const obj of objs)
    for (const v of obj.value ?? []) {
      if (typeof v.address !== 'string' || v.address.length === 0) continue
      const email = normalizeAddress(v.address)
      const name = typeof v.name === 'string' && v.name.trim() !== '' ? v.name.trim() : undefined
      if (out.some((x) => x.email === email)) continue
      out.push(name === undefined ? { email } : { email, name })
    }
  return out
}

/** 只给测试与宿主用：认出 `ParsedMail` 里有没有远程图片（不解析两遍）。 */
export function hasRemoteImages(parsed: ParsedMail): boolean {
  const html = typeof parsed.html === 'string' ? parsed.html : ''
  return sanitizeMessageHtml(html).has_remote_images
}
