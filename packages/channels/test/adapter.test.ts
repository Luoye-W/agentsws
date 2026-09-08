import type { MessagePart } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { EmailChannelAdapter, emailDedupeKey } from '../src/email/adapter.js'
import { MemoryThreadStore } from '../src/email/threads.js'
import { ChannelError } from '../src/errors.js'
import { MemoryRawStore } from '../src/raw-store.js'
import {
  FakeClock,
  FakeConnect,
  MemoryMailSource,
  mimeMessage,
  RecordingMailer,
  rawEmail,
  waitFor,
} from './helpers.js'

const ADDRESS = 'support@shop.example'

function makeAdapter(over: Partial<ConstructorParameters<typeof EmailChannelAdapter>[0]> = {}) {
  const clock = new FakeClock()
  const rawStore = new MemoryRawStore()
  const mailer = new RecordingMailer()
  const source = new MemoryMailSource()
  const threads = new MemoryThreadStore()
  const adapter = new EmailChannelAdapter({
    clock,
    rawStore,
    address: ADDRESS,
    display_name: '3C Support',
    mailer,
    source,
    threads,
    interval_ms: 30_000,
    ...over,
  })
  return { adapter, clock, rawStore, mailer, source, threads }
}

const textOf = (parts: readonly MessagePart[]) =>
  parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')

describe('EmailChannelAdapter.toInbound', () => {
  it('把一封普通邮件映射成 InboundEvent 的前半段', async () => {
    const { adapter, rawStore } = makeAdapter()
    const head = await adapter.toInbound(
      rawEmail(11, {
        from: 'Ann Lee <Ann@Customer.com>',
        subject: 'Where is my order #1001?',
        text: 'Hi, my order is late.',
      }),
      'ws_1',
    )
    expect(head.channel).toBe('email')
    expect(head.kind).toBe('message')
    expect(head.workspace_id).toBe('ws_1')
    expect(head.actor).toEqual({ external_id: 'ann@customer.com', display: 'Ann Lee' })
    expect(head.thread?.external_id).toBe('<m-1@mail.example>')
    expect(head.dedupe_key).toBe('email:<m-1@mail.example>')
    expect(textOf(head.parts)).toBe('Hi, my order is late.')
    expect(head.occurred_at).toBe('2026-09-09T07:55:00.000Z')
    expect(head.received_at).toBe('2026-09-09T08:00:00.000Z')
    const raw = rawStore.get(head.raw_ref)
    expect(raw?.mime).toBe('message/rfc822')
    expect(String(raw?.payload)).toContain('Message-ID: <m-1@mail.example>')
  })

  it('回复邮件的线程 id 取 References 首个', async () => {
    const { adapter } = makeAdapter()
    const head = await adapter.toInbound(
      rawEmail(12, {
        from: 'ann@customer.com',
        message_id: '<m-3@mail.example>',
        in_reply_to: '<m-2@mail.example>',
        references: '<m-1@mail.example> <m-2@mail.example>',
      }),
      'ws_1',
    )
    expect(head.thread?.external_id).toBe('<m-1@mail.example>')
  })

  it('HTML 邮件转文本并去掉引用尾巴，附件不进 text', async () => {
    const { adapter, rawStore } = makeAdapter()
    const head = await adapter.toInbound(
      rawEmail(13, {
        from: 'ann@customer.com',
        html: '<p>Still waiting.</p><div class="gmail_quote"><blockquote>On Mon, support wrote:<br>we shipped it</blockquote></div>',
        attachments: [
          { filename: 'receipt.txt', content_type: 'text/plain', content: 'ATTACHED-BODY' },
          { filename: 'photo.png', content_type: 'image/png', content: 'PNGDATA' },
        ],
      }),
      'ws_1',
    )
    const text = textOf(head.parts)
    expect(text).toBe('Still waiting.')
    expect(text).not.toContain('we shipped it')
    expect(text).not.toContain('ATTACHED-BODY')

    const files = head.parts.filter((p) => p.type === 'file' || p.type === 'image')
    expect(files).toHaveLength(2)
    expect(files.map((f) => (f.type === 'file' || f.type === 'image' ? f.name : ''))).toEqual([
      'receipt.txt',
      'photo.png',
    ])
    expect(files[1]?.type).toBe('image')
    const attachmentRef = files[0]?.type === 'file' ? files[0].ref : ''
    const stored = rawStore.get(attachmentRef)
    expect(stored?.kind).toBe('attachment')
    expect(Buffer.from(stored?.payload as Uint8Array).toString('utf8')).toBe('ATTACHED-BODY')
  })

  it('没有 Message-ID 时 dedupe_key 退化成内容哈希，线程 id 按发件人 + 主题', async () => {
    const { adapter } = makeAdapter()
    const source = mimeMessage({ from: 'ann@customer.com', text: 'no id' }).replace(
      /Message-ID: .*\r\n/,
      '',
    )
    const head = await adapter.toInbound({ uid: 14, mailbox: 'INBOX', source }, 'ws_1')
    expect(head.dedupe_key.startsWith('email:')).toBe(true)
    expect(head.dedupe_key).not.toContain('<')
    expect(head.thread?.external_id.startsWith('email-thread:')).toBe(true)
  })

  it('缺 From / 缺原始 MIME 一律拒收', async () => {
    const { adapter } = makeAdapter()
    const noFrom = mimeMessage({ from: 'x@y.z' }).replace(/From: .*\r\n/, '')
    await expect(adapter.toInbound({ uid: 1, source: noFrom }, 'ws_1')).rejects.toBeInstanceOf(
      ChannelError,
    )
    await expect(adapter.toInbound({ uid: 1 }, 'ws_1')).rejects.toThrow(/原始 MIME/)
    await expect(adapter.toInbound('not-an-object', 'ws_1')).rejects.toThrow(/必须是对象/)
  })

  it('默认策略下秘密在落受控原始材料区之前就被抹掉；keep 策略保留原文', async () => {
    const body = 'my card is 4111 1111 1111 1111 please refund'
    const { adapter, rawStore } = makeAdapter()
    const head = await adapter.toInbound(
      rawEmail(15, { from: 'ann@customer.com', text: body }),
      'ws_1',
    )
    const raw = rawStore.get(head.raw_ref)
    expect(String(raw?.payload)).not.toContain('4111 1111 1111 1111')
    expect(String(raw?.payload)).toContain('[redacted:card_number]')
    expect(raw?.secrets_scrubbed).toBe(true)
    // 适配器出口的 parts 仍是原文——脱敏标记由管线判定（18 §2.2 的第二跳）
    expect(textOf(head.parts)).toContain('4111 1111 1111 1111')

    const keep = makeAdapter({ raw_secret_policy: 'keep' })
    const head2 = await keep.adapter.toInbound(
      rawEmail(15, { from: 'ann@customer.com', text: body }),
      'ws_1',
    )
    expect(String(keep.rawStore.get(head2.raw_ref)?.payload)).toContain('4111 1111 1111 1111')
  })

  it('线程台账登记参与者，排除自己的地址', async () => {
    const { adapter, threads } = makeAdapter()
    await adapter.toInbound(
      rawEmail(16, {
        from: 'ann@customer.com',
        to: `${ADDRESS}, ops@shop.example`,
        cc: 'boss@customer.com',
      }),
      'ws_1',
    )
    const rec = threads.get('<m-1@mail.example>')
    expect(rec?.participants).toEqual(['ann@customer.com', 'ops@shop.example', 'boss@customer.com'])
    expect(rec?.last_message_id).toBe('<m-1@mail.example>')
  })
})

describe('EmailChannelAdapter 收信循环', () => {
  it('poll 按 UID 增量，不重复交付', async () => {
    const { adapter, source } = makeAdapter()
    source.messages.push(rawEmail(1, { from: 'a@x.com' }), rawEmail(2, { from: 'b@x.com' }))
    const seen: number[] = []
    const handler = async (raw: unknown) => {
      seen.push((raw as { uid: number }).uid)
    }
    expect(await adapter.poll(handler)).toBe(2)
    expect(await adapter.poll(handler)).toBe(0)
    source.messages.push(rawEmail(3, { from: 'c@x.com' }))
    expect(await adapter.poll(handler)).toBe(1)
    expect(seen).toEqual([1, 2, 3])
  })

  it('start 起轮询循环，周期由 Clock 决定；stop 收干净', async () => {
    const { adapter, clock, source } = makeAdapter()
    source.messages.push(rawEmail(1, { from: 'a@x.com' }))
    const seen: number[] = []
    await adapter.start(async (raw) => {
      seen.push((raw as { uid: number }).uid)
    })
    expect(adapter.started).toBe(true)
    await waitFor(() => clock.sleeping > 0, '第一轮轮询')
    expect(seen).toEqual([1])

    source.messages.push(rawEmail(2, { from: 'b@x.com' }))
    clock.advance(30_000)
    await waitFor(() => seen.length === 2, '第二轮轮询')
    await adapter.stop()
    expect(adapter.started).toBe(false)
  })

  it('轮询里的异常走 on_error，不打断循环', async () => {
    const errors: unknown[] = []
    const { adapter, clock, source } = makeAdapter({ on_error: (e) => errors.push(e) })
    source.fail = new Error('imap down')
    await adapter.start(async () => undefined)
    await waitFor(() => errors.length > 0, 'poll 失败')
    clock.advance(30_000)
    await adapter.stop()
    expect(String(errors[0])).toContain('imap down')
  })

  it('没有 MailSource 就不能收信', async () => {
    const clock = new FakeClock()
    const adapter = new EmailChannelAdapter({
      clock,
      rawStore: new MemoryRawStore(),
      address: ADDRESS,
      mailer: new RecordingMailer(),
    })
    await expect(adapter.start(async () => undefined)).rejects.toThrow(/无法收信/)
    await expect(adapter.poll(async () => undefined)).rejects.toThrow(/无法收信/)
  })
})

describe('EmailChannelAdapter.send', () => {
  const parts: MessagePart[] = [{ type: 'text', text: 'We reshipped it today.' }]

  it('回复带正确的 In-Reply-To / References / Re: 主题，收件人来自线程台账', async () => {
    const { adapter, mailer } = makeAdapter()
    await adapter.toInbound(
      rawEmail(21, {
        from: 'ann@customer.com',
        subject: 'Order #1001 late',
        message_id: '<m-1@mail.example>',
      }),
      'ws_1',
    )
    await adapter.toInbound(
      rawEmail(22, {
        from: 'ann@customer.com',
        subject: 'Re: Order #1001 late',
        message_id: '<m-2@mail.example>',
        in_reply_to: '<m-1@mail.example>',
        references: '<m-1@mail.example>',
      }),
      'ws_1',
    )
    const out = await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'change_1',
    })
    expect(mailer.sent).toHaveLength(1)
    const sent = mailer.sent[0]
    expect(sent?.to).toEqual(['ann@customer.com'])
    expect(sent?.from).toBe('3C Support <support@shop.example>')
    expect(sent?.subject).toBe('Re: Order #1001 late')
    expect(sent?.in_reply_to).toBe('<m-2@mail.example>')
    expect(sent?.references).toBe('<m-1@mail.example> <m-2@mail.example>')
    expect(out.external_id).toBe(sent?.message_id)
    expect(adapter.routeOf('change_1')).toBe('smtp')
  })

  it('同一 idempotency_key 不重发', async () => {
    const { adapter, mailer } = makeAdapter()
    await adapter.toInbound(rawEmail(23, { from: 'ann@customer.com' }), 'ws_1')
    const a = await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'change_9',
    })
    const b = await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'change_9',
    })
    expect(mailer.sent).toHaveLength(1)
    expect(b.external_id).toBe(a.external_id)

    await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'change_10',
    })
    expect(mailer.sent).toHaveLength(2)
    expect(mailer.sent[1]?.message_id).not.toBe(mailer.sent[0]?.message_id)
  })

  it('收件人门禁：未知线程与没有参与者的线程都拒发（31 §3.3）', async () => {
    const { adapter, mailer, threads } = makeAdapter()
    await expect(
      adapter.send({ external_id: '<unknown@x>' }, parts, {
        connect_token: '',
        idempotency_key: 'k1',
      }),
    ).rejects.toMatchObject({ code: 'authorization_check_failed' })

    threads.upsert({
      external_id: '<solo@x>',
      participants: [ADDRESS],
      references: [],
      updated_at: '2026-09-09T08:00:00.000Z',
    })
    await expect(
      adapter.send({ external_id: '<solo@x>' }, parts, {
        connect_token: '',
        idempotency_key: 'k2',
      }),
    ).rejects.toMatchObject({ code: 'authorization_check_failed' })
    expect(mailer.sent).toHaveLength(0)
  })

  it('没有文本 / 没有幂等键都拒发', async () => {
    const { adapter } = makeAdapter()
    await adapter.toInbound(rawEmail(24, { from: 'ann@customer.com' }), 'ws_1')
    await expect(
      adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
        connect_token: '',
        idempotency_key: '',
      }),
    ).rejects.toThrow(/idempotency_key/)
    await expect(
      adapter.send({ external_id: '<m-1@mail.example>' }, [{ type: 'card', payload: {} }], {
        connect_token: '',
        idempotency_key: 'k3',
      }),
    ).rejects.toThrow(/没有文本/)
  })

  it('有 gmail provider 且带 token 就走 Connect，凭据留在 OpenConnector', async () => {
    const connect = new FakeConnect()
    const { adapter, mailer } = makeAdapter({ connect })
    await adapter.toInbound(rawEmail(25, { from: 'ann@customer.com' }), 'ws_1')
    const out = await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: 'tok_apply',
      connection: 'conn_gmail',
      idempotency_key: 'change_11',
    })
    expect(mailer.sent).toHaveLength(0)
    expect(connect.calls).toHaveLength(1)
    const call = connect.calls[0]
    expect(call?.action_id).toBe('gmail.send_message')
    expect(call?.opts).toEqual({
      token: 'tok_apply',
      idempotencyKey: 'change_11',
      connection: 'conn_gmail',
    })
    expect((call?.input as { to: string[] } | undefined)?.to).toEqual(['ann@customer.com'])
    expect(out.external_id).toBe('gmail-msg-1')
    expect(adapter.routeOf('change_11')).toBe('connect')
  })

  it('没有 gmail provider / 没有 token / providers 失败都回落 SMTP', async () => {
    const noGmail = new FakeConnect()
    noGmail.providerList = [{ service: 'shopify', auth: 'api_key', executable: true }]
    const a = makeAdapter({ connect: noGmail })
    await a.adapter.toInbound(rawEmail(26, { from: 'ann@customer.com' }), 'ws_1')
    await a.adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: 'tok',
      idempotency_key: 'k1',
    })
    expect(a.mailer.sent).toHaveLength(1)

    const broken = new FakeConnect()
    broken.providersFail = new Error('runtime down')
    const b = makeAdapter({ connect: broken })
    await b.adapter.toInbound(rawEmail(27, { from: 'ann@customer.com' }), 'ws_1')
    await b.adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: 'tok',
      idempotency_key: 'k2',
    })
    expect(b.mailer.sent).toHaveLength(1)

    const gmail = new FakeConnect()
    const c = makeAdapter({ connect: gmail })
    await c.adapter.toInbound(rawEmail(28, { from: 'ann@customer.com' }), 'ws_1')
    await c.adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'k3',
    })
    expect(c.mailer.sent).toHaveLength(1)
    expect(gmail.providerCalls).toBe(0)
  })

  it('两条路都没有就报 provider_unavailable', async () => {
    const clock = new FakeClock()
    const threads = new MemoryThreadStore()
    threads.upsert({
      external_id: '<t@x>',
      participants: ['ann@customer.com'],
      references: [],
      updated_at: clock.now(),
    })
    const adapter = new EmailChannelAdapter({
      clock,
      rawStore: new MemoryRawStore(),
      address: ADDRESS,
      threads,
    })
    await expect(
      adapter.send({ external_id: '<t@x>' }, parts, { connect_token: '', idempotency_key: 'k' }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' })
  })

  it('注入 render_html 时同时发纯文本与 HTML', async () => {
    const { adapter, mailer } = makeAdapter({
      render_html: (text) => `<p>${text}</p>`,
    })
    await adapter.toInbound(rawEmail(29, { from: 'ann@customer.com' }), 'ws_1')
    await adapter.send({ external_id: '<m-1@mail.example>' }, parts, {
      connect_token: '',
      idempotency_key: 'k-html',
    })
    expect(mailer.sent[0]?.html).toBe('<p>We reshipped it today.</p>')
    expect(mailer.sent[0]?.text).toBe('We reshipped it today.')
  })
})

describe('能力与健康', () => {
  it('capabilities 报的是 send 能发什么', () => {
    const { adapter } = makeAdapter()
    expect(adapter.capabilities()).toEqual({
      text: true,
      image: false,
      file: false,
      card: false,
      thread: true,
      streaming: false,
    })
  })

  it('health 汇总 IMAP 与 SMTP', async () => {
    const { adapter, source, mailer } = makeAdapter()
    expect(await adapter.health()).toEqual({ ok: true })

    source.healthy = false
    const down = await adapter.health()
    expect(down.ok).toBe(false)
    expect(down.detail).toContain('imap: down')

    source.healthy = true
    mailer.healthy = false
    const smtpDown = await adapter.health()
    expect(smtpDown.ok).toBe(false)
    expect(smtpDown.detail).toContain('smtp: down')
  })

  it('没配 SMTP 但有 Connect 时仍算健康；两边都没有则不健康', async () => {
    const clock = new FakeClock()
    const withConnect = new EmailChannelAdapter({
      clock,
      rawStore: new MemoryRawStore(),
      address: ADDRESS,
      connect: new FakeConnect(),
    })
    const h = await withConnect.health()
    expect(h.ok).toBe(true)
    expect(h.detail).toContain('走 Connect')

    const bare = new EmailChannelAdapter({
      clock,
      rawStore: new MemoryRawStore(),
      address: ADDRESS,
    })
    expect((await bare.health()).ok).toBe(false)
  })
})

describe('emailDedupeKey', () => {
  it('有 Message-ID 用它，没有才哈希内容', () => {
    expect(emailDedupeKey('<a@x>', { from: 'a', body: 'b' })).toBe('email:<a@x>')
    const k1 = emailDedupeKey(undefined, { from: 'a', body: 'b', subject: 's' })
    const k2 = emailDedupeKey(undefined, { from: 'a', body: 'b', subject: 's' })
    const k3 = emailDedupeKey(undefined, { from: 'a', body: 'other', subject: 's' })
    expect(k1).toBe(k2)
    expect(k1).not.toBe(k3)
  })
})
