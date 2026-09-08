import type {
  ActionMeta,
  Clock,
  Connect,
  Connection,
  ConnectToken,
  EventEnvelope,
  ExecuteOptions,
  ExecuteResult,
  Iso8601,
  KnownEventType,
  ProviderMeta,
} from '@agentsws/contracts'
import type { MailSource, RawEmailMessage } from '../src/email/imap.js'
import type { Mailer, OutboundMail } from '../src/email/smtp.js'
import type { ChannelEventSink } from '../src/pipeline.js'

/** 假时钟：`sleep` 挂起直到测试显式 `advance`，循环因此可控。 */
export class FakeClock implements Clock {
  private ms: number
  private waiters: { resolve: () => void }[] = []

  constructor(start: Iso8601 = '2026-09-09T08:00:00.000Z') {
    this.ms = Date.parse(start)
  }

  now(): Iso8601 {
    return new Date(this.ms).toISOString()
  }

  sleep(_ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push({ resolve })
    })
  }

  advance(ms: number): void {
    this.ms += ms
    const waiting = this.waiters
    this.waiters = []
    for (const w of waiting) w.resolve()
  }

  get sleeping(): number {
    return this.waiters.length
  }
}

export async function waitFor(predicate: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2)
    })
  }
  throw new Error(`waitFor 超时：${label}`)
}

export class MemoryMailSource implements MailSource {
  readonly messages: RawEmailMessage[] = []
  fail: Error | undefined
  healthy = true

  constructor(messages: RawEmailMessage[] = []) {
    this.messages.push(...messages)
  }

  async fetchSince(since_uid: number): Promise<RawEmailMessage[]> {
    if (this.fail !== undefined) throw this.fail
    return this.messages.filter((m) => m.uid > since_uid).sort((a, b) => a.uid - b.uid)
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.healthy ? { ok: true } : { ok: false, detail: 'imap: down' }
  }
}

export class RecordingMailer implements Mailer {
  readonly sent: OutboundMail[] = []
  fail: Error | undefined
  healthy = true
  closed = false

  async send(mail: OutboundMail): Promise<{ message_id: string }> {
    if (this.fail !== undefined) throw this.fail
    this.sent.push(mail)
    return { message_id: mail.message_id ?? `<generated-${this.sent.length}@example.com>` }
  }

  async health(): Promise<{ ok: boolean; detail?: string }> {
    return this.healthy ? { ok: true } : { ok: false, detail: 'smtp: down' }
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

export class MemoryEventSink implements ChannelEventSink {
  readonly events: EventEnvelope<KnownEventType, unknown>[] = []
  private seq = 0

  async append(
    e: Omit<EventEnvelope<KnownEventType, unknown>, 'id' | 'at'>,
  ): Promise<EventEnvelope<KnownEventType, unknown>> {
    this.seq += 1
    const full: EventEnvelope<KnownEventType, unknown> = {
      ...e,
      id: `ev_${this.seq}`,
      at: new Date(Date.UTC(2026, 8, 9)).toISOString(),
    }
    this.events.push(full)
    return full
  }

  typesOf(): string[] {
    return this.events.map((e) => e.type)
  }

  ofType(type: KnownEventType): EventEnvelope<KnownEventType, unknown>[] {
    return this.events.filter((e) => e.type === type)
  }
}

export interface MimeInput {
  from: string
  to?: string
  cc?: string
  subject?: string
  message_id?: string
  in_reply_to?: string
  references?: string
  date?: string
  text?: string
  html?: string
  attachments?: { filename: string; content_type: string; content: string }[]
}

/** 手搓一封 MIME（测试不引入构造库，纯字符串更能暴露解析问题）。 */
export function mimeMessage(input: MimeInput): string {
  const headers: string[] = [
    `From: ${input.from}`,
    `To: ${input.to ?? 'support@shop.example'}`,
    ...(input.cc === undefined ? [] : [`Cc: ${input.cc}`]),
    `Subject: ${input.subject ?? 'Where is my order?'}`,
    `Date: ${input.date ?? 'Wed, 09 Sep 2026 07:55:00 +0000'}`,
    `Message-ID: ${input.message_id ?? '<m-1@mail.example>'}`,
    ...(input.in_reply_to === undefined ? [] : [`In-Reply-To: ${input.in_reply_to}`]),
    ...(input.references === undefined ? [] : [`References: ${input.references}`]),
    'MIME-Version: 1.0',
  ]

  const attachments = input.attachments ?? []
  if (attachments.length === 0 && input.html === undefined) {
    headers.push('Content-Type: text/plain; charset=utf-8')
    return `${headers.join('\r\n')}\r\n\r\n${(input.text ?? 'hello').replace(/\n/g, '\r\n')}\r\n`
  }

  const boundary = 'bnd-test-1'
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`)
  const parts: string[] = []
  if (input.text !== undefined || input.html === undefined) {
    parts.push(
      [
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        '',
        (input.text ?? 'hello').replace(/\n/g, '\r\n'),
      ].join('\r\n'),
    )
  }
  if (input.html !== undefined) {
    parts.push(
      [
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        '',
        input.html.replace(/\n/g, '\r\n'),
      ].join('\r\n'),
    )
  }
  for (const att of attachments) {
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${att.content_type}`,
        'Content-Transfer-Encoding: base64',
        `Content-Disposition: attachment; filename="${att.filename}"`,
        '',
        Buffer.from(att.content, 'utf8').toString('base64'),
      ].join('\r\n'),
    )
  }
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}\r\n--${boundary}--\r\n`
}

export function rawEmail(uid: number, input: MimeInput): RawEmailMessage {
  return { uid, mailbox: 'INBOX', source: mimeMessage(input) }
}

/** 只实现 `providers` 与 `execute` 的 Connect 替身（其余方法在本包用不到，调用即报错）。 */
export class FakeConnect implements Connect {
  readonly calls: { action_id: string; input: unknown; opts: ExecuteOptions }[] = []
  providerList: ProviderMeta[] = [{ service: 'gmail', auth: 'oauth2', executable: true }]
  providersFail: Error | undefined
  executeFail: Error | undefined
  returnId: string | undefined = 'gmail-msg-1'
  providerCalls = 0

  async providers(): Promise<ProviderMeta[]> {
    this.providerCalls += 1
    if (this.providersFail !== undefined) throw this.providersFail
    return this.providerList
  }

  async execute<T = unknown>(
    action_id: string,
    input: unknown,
    opts: ExecuteOptions,
  ): Promise<ExecuteResult<T>> {
    this.calls.push({ action_id, input, opts })
    if (this.executeFail !== undefined) throw this.executeFail
    return {
      data: { id: this.returnId } as T,
      execution_id: `exec_${this.calls.length}`,
    }
  }

  async actions(): Promise<ActionMeta[]> {
    throw new Error('未实现')
  }
  async connections(): Promise<Connection[]> {
    throw new Error('未实现')
  }
  async beginConnect(): Promise<{ request_id: string }> {
    throw new Error('未实现')
  }
  async pollConnect(): Promise<'initiated'> {
    throw new Error('未实现')
  }
  async transferConnection(): Promise<Connection> {
    throw new Error('未实现')
  }
  async issueToken(): Promise<ConnectToken> {
    throw new Error('未实现')
  }
  async revokeTokens(): Promise<void> {
    throw new Error('未实现')
  }
}
