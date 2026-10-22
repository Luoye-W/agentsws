/**
 * WP439（docs/108 §5.1.5 / §5.7）：规则清单与回复建议的口吻、语言——服务进程这一层。
 *
 * - 教过 3 个发件人 → 清单 3 行，命中数对（按发件人规则直达的那几封各记一笔）；
 * - 删一条当场生效：那个发件人的下一封重新走模型；能撤回（命中账一起回来）；
 * - 同事 / 公司模式：清单写谁教的名字，删了通知（宿主发给同岗位），撤回也通知；
 * - 回复建议：`voice` 带着这封信该归的岗位去取口吻，送进模型的 `lang` 按来信语言，判不出退回品牌默认语言再退中文。
 */
import type { MailboxWriter, MailSource, RawEmailMessage } from '@agentsws/channels'
import type { Clock, MessageRecord, ModelGateway, SenderRule } from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { describe, expect, it } from 'vitest'
import type { MailAccount } from '../src/index.js'
import { createMessages, type MessagesOptions } from '../src/messages.js'
import { replyLanguage, replyLanguageOf } from '../src/reply-language.js'

const WS = 'ws_1'
const ME = 'hello@shop.example'
const T0 = '2026-09-18T02:00:00.000Z'
const clock: Clock = { now: () => T0, sleep: async () => undefined }
const ACTOR = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }
const OTHER = { workspace_id: WS, person_id: 'p_lin', assignment_id: 'asg_2' }

const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

function mime(uid: number, from: string, subject: string, text = 'plain body'): RawEmailMessage {
  const source = [
    `From: ${from}`,
    `To: ${ME}`,
    `Subject: ${subject}`,
    `Message-ID: <m-${uid}@mail.example>`,
    'Date: Fri, 18 Sep 2026 01:00:00 +0000',
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
    '',
  ].join('\r\n')
  return { uid, mailbox: 'INBOX', source }
}

class FolderSource implements MailSource {
  constructor(private readonly rows: RawEmailMessage[]) {}
  async fetchSince(since: number): Promise<RawEmailMessage[]> {
    return this.rows.filter((r) => r.uid > since)
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async uidValidity(): Promise<number> {
    return 1
  }
}

const writer: MailboxWriter = {
  setFlags: () => true,
  move: () => true,
  keywordsSupported: () => false,
}

/** 模型桩：分拣回一份固定结论；建议那一次把送进去的请求记下来。 */
function models(): {
  gateway: ModelGateway
  calls: string[]
  suggests: Record<string, unknown>[]
  raw: { system: string; user: string }[]
} {
  const calls: string[] = []
  const suggests: Record<string, unknown>[] = []
  const raw: { system: string; user: string }[] = []
  const gateway = {
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? ''
      const triage = system.includes('邮件分拣')
      calls.push(triage ? 'triage' : 'suggest')
      if (!triage) {
        suggests.push(JSON.parse(req.messages[1]?.content ?? '{}'))
        raw.push({ system, user: req.messages[1]?.content ?? '' })
      }
      const text = triage
        ? JSON.stringify({
            route: 'inbox',
            labels: [],
            needs_reply: true,
            priority: 'normal',
            summary: '问一件事',
            confidence: 0.9,
            kind: 'customer_question',
          })
        : JSON.stringify([
            { kind: 'short', text: 'ok' },
            { kind: 'detailed', text: 'ok ok' },
            { kind: 'decline', text: 'no' },
          ])
      return {
        text,
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
  } as unknown as ModelGateway
  return { gateway, calls, suggests, raw }
}

function harness(rows: RawEmailMessage[], extra: Partial<MessagesOptions> = {}) {
  const m = models()
  const messages = createMessages({
    clock,
    workspace_id: WS,
    appendEvent: () => undefined,
    halt: new MemoryHalt({}),
    accounts: () => [account],
    credentials: { password: () => 'pw' },
    position: () => ({ person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'dtc.support' }),
    activeRoles: () => [],
    models: m.gateway,
    makeSource: () => new FolderSource(rows),
    makeWriter: () => writer,
    ...extra,
  })
  return { messages, ...m }
}

const byFrom = async (
  h: ReturnType<typeof harness>,
  from: string,
  subject?: string,
): Promise<MessageRecord> => {
  const all = await h.messages.store.list({ limit: 1000 })
  const hit = all.find(
    (r) => r.from.email === from && (subject === undefined || r.subject === subject),
  )
  if (hit === undefined) throw new Error(`没有 ${from} 的信`)
  return hit
}

describe('WP439 规则清单：命中数、删除、撤回', () => {
  it('教过 3 个发件人 → 清单 3 行，命中数对；删一条 → 那个发件人的下一封重新走模型；能撤回', async () => {
    const rows = [
      mime(1, 'ann@buyer.example', 'a1'),
      mime(2, 'bob@vendor.example', 'b1'),
      mime(3, 'cat@media.example', 'c1'),
    ]
    const h = harness(rows)
    await h.messages.poll()
    expect(h.calls).toEqual(['triage', 'triage', 'triage'])
    for (const [from, kind] of [
      ['ann@buyer.example', 'after_sales'],
      ['bob@vendor.example', 'billing_system'],
      ['cat@media.example', 'media'],
    ] as const) {
      const row = await byFrom(h, from)
      await h.messages.port.setKind?.(ACTOR, row.id, { kind, remember_sender: true })
    }

    // 下一批：ann 两封、bob 一封——规则直达，一次模型都不花
    rows.push(mime(4, 'ann@buyer.example', 'a2'), mime(5, 'ann@buyer.example', 'a3'))
    rows.push(mime(6, 'bob@vendor.example', 'b2'))
    h.calls.length = 0
    await h.messages.poll()
    expect(h.calls).toEqual([])

    const list = await h.messages.port.senderRules(ACTOR)
    expect(list.rules).toHaveLength(3)
    const hits = Object.fromEntries(list.rules.map((r) => [r.sender, r.hits_30d]))
    expect(hits).toEqual({
      'ann@buyer.example': 2,
      'bob@vendor.example': 1,
      'cat@media.example': 0,
    })
    // 命中多的在前；人教的；个人模式不写名字；账本本身不往外给
    expect(list.rules[0]?.sender).toBe('ann@buyer.example')
    expect(list.rules.every((r) => r.source === 'user' && r.by_me === true)).toBe(true)
    expect(list.rules.every((r) => r.by_name === undefined && r.hit_days === undefined)).toBe(true)
    expect(list.rules[0]?.last_hit_at).toBe('2026-09-18T01:00:00.000Z')
    expect(list.shared).toBe(false)

    // 删 ann：当场生效
    const ann = list.rules.find((r) => r.sender === 'ann@buyer.example') as SenderRule
    const out = await h.messages.port.deleteSenderRule(ACTOR, ann.id)
    expect(out).toMatchObject({ deleted: true, rule: { sender: 'ann@buyer.example' } })
    rows.push(mime(7, 'ann@buyer.example', 'a4'))
    await h.messages.poll()
    expect(h.calls).toEqual(['triage'])
    expect((await byFrom(h, 'ann@buyer.example', 'a4')).triage?.kind_by).toBe('model')

    const after = await h.messages.port.senderRules(ACTOR)
    expect(after.rules.map((r) => r.sender).sort()).toEqual([
      'bob@vendor.example',
      'cat@media.example',
    ])
    expect(after.recently_deleted).toEqual([
      expect.objectContaining({ deleted_by: 'p_owner', deleted_by_me: true }),
    ])

    // 撤回：同一条放回去，命中账一起回来；下一封又直达
    const back = await h.messages.port.restoreSenderRule?.(ACTOR, ann.id)
    expect(back).toMatchObject({ restored: true, rule: { sender: 'ann@buyer.example' } })
    expect(back?.rule?.hits_30d).toBe(2)
    rows.push(mime(8, 'ann@buyer.example', 'a5'))
    h.calls.length = 0
    await h.messages.poll()
    expect(h.calls).toEqual([])
    const again = await h.messages.port.senderRules(ACTOR)
    expect(again.rules.find((r) => r.id === ann.id)?.hits_30d).toBe(3)
    expect(again.recently_deleted).toEqual([])
    // 撤回过的不能再撤一次
    expect(await h.messages.port.restoreSenderRule?.(ACTOR, ann.id)).toEqual({ restored: false })
  })

  it('同事 / 公司模式：写谁教的名字；删了、撤回了都通知（宿主发给同岗位）', async () => {
    const rows = [mime(1, 'ann@buyer.example', 'a1')]
    const notes: { by: string; action: string; sender: string }[] = []
    const h = harness(rows, {
      sharedRules: () => true,
      personName: (id) => (id === 'p_owner' ? '王一' : id === 'p_lin' ? '林二' : undefined),
      notifyRuleChange: ({ by, action, rule }) => {
        notes.push({ by, action, sender: rule.sender })
      },
    })
    await h.messages.poll()
    const row = await byFrom(h, 'ann@buyer.example')
    await h.messages.port.setKind?.(ACTOR, row.id, { kind: 'after_sales', remember_sender: true })

    // 同事看：名字是王一、不是「你」
    const seen = await h.messages.port.senderRules(OTHER)
    expect(seen.shared).toBe(true)
    expect(seen.rules[0]).toMatchObject({ by_name: '王一' })
    expect(seen.rules[0]?.by_me).toBeUndefined()

    // 同事删（谁都能删），留名、通知
    const id = seen.rules[0]?.id as string
    await h.messages.port.deleteSenderRule(OTHER, id)
    expect(notes).toEqual([{ by: 'p_lin', action: 'deleted', sender: 'ann@buyer.example' }])
    const mine = await h.messages.port.senderRules(ACTOR)
    expect(mine.recently_deleted?.[0]).toMatchObject({ deleted_by_name: '林二' })

    // 原来教的人撤回
    await h.messages.port.restoreSenderRule?.(ACTOR, id)
    expect(notes.at(-1)).toEqual({ by: 'p_owner', action: 'restored', sender: 'ann@buyer.example' })
  })
})

describe('WP439 回复建议：品牌口吻、按来信语言', () => {
  it('英文来信 → lang = en；中文来信 → zh；口吻按这封信该归的岗位取、原样送进模型', async () => {
    const rows = [
      mime(
        1,
        'ann@buyer.example',
        'Order #1024',
        'Hi, my order has not arrived yet. Can you check?',
      ),
      mime(2, 'li@buyer.example', '订单问题', '你好，我的订单还没到，能帮我查一下吗？'),
    ]
    const asked: (string | undefined)[] = []
    const h = harness(rows, {
      // 客服岗位开着：客户问题「交给 客服」是主按钮 → 按客服那条职责取口吻
      positions: () => [
        { id: 'customer-care', name_zh: '客服', name_en: 'Customer care', open: true },
      ],
      voice: ({ position_id }) => {
        asked.push(position_id)
        return '品牌口吻：热情、简短，结尾署名 Nordvolt Team'
      },
    })
    await h.messages.poll()
    const en = await byFrom(h, 'ann@buyer.example')
    const zh = await byFrom(h, 'li@buyer.example')
    await h.messages.port.assistant(ACTOR, en.id)
    await h.messages.port.assistant(ACTOR, zh.id)
    expect(h.suggests.map((s) => s.lang)).toEqual(['en', 'zh'])
    expect(h.suggests.every((s) => String(s.voice).includes('Nordvolt Team'))).toBe(true)
    // WP471（决策 1549）：两封信系统提示逐字相同；品牌话术排在 JSON 最前面（固定在前、这封信在后）
    const [a, b] = h.raw
    expect(b?.system).toBe(a?.system)
    const voicePrefix = JSON.stringify({ voice: h.suggests[0]?.voice }).slice(0, -1)
    expect(a?.user.startsWith(voicePrefix)).toBe(true)
    expect(b?.user.startsWith(voicePrefix)).toBe(true)
    // 这封信「交给 X」的主按钮是哪个岗位，就按那个岗位取口吻
    expect(asked).toEqual(['customer-care', 'customer-care'])
  })

  it('没人接（没有开着的岗位）→ 品牌口吻（不带岗位去取）', async () => {
    const asked: (string | undefined)[] = []
    const h = harness([mime(1, 'ann@buyer.example', 'Hi', 'Hi, where is my order?')], {
      voice: ({ position_id }) => {
        asked.push(position_id)
        return undefined
      },
    })
    await h.messages.poll()
    await h.messages.port.assistant(ACTOR, (await byFrom(h, 'ann@buyer.example')).id)
    expect(asked).toEqual([undefined])
  })

  it('判不出语言（只有一个链接）→ 品牌默认语言；没设 → 中文', async () => {
    const rows = [mime(1, 'x@buyer.example', '', 'https://example.com/a')]
    const de = harness(rows, { brandLanguage: () => 'de' })
    await de.messages.poll()
    await de.messages.port.assistant(ACTOR, (await byFrom(de, 'x@buyer.example')).id)
    expect(de.suggests[0]?.lang).toBe('de')

    const plain = harness([mime(1, 'x@buyer.example', '', 'https://example.com/a')])
    await plain.messages.poll()
    await plain.messages.port.assistant(ACTOR, (await byFrom(plain, 'x@buyer.example')).id)
    expect(plain.suggests[0]?.lang).toBe('zh')
    // 没接口吻：提示词里就没有那一段
    expect(plain.suggests[0]?.voice).toBe('')
  })
})

describe('WP439 来信语言', () => {
  it('常见几种', () => {
    expect(replyLanguageOf('Hi, where is my order?')).toBe('en')
    expect(replyLanguageOf('你好，我的订单到哪了？')).toBe('zh')
    expect(replyLanguageOf('Hola, ¿dónde está mi pedido? Gracias')).toBe('es')
    expect(replyLanguageOf('Hallo, wo ist meine Bestellung? Danke')).toBe('de')
    expect(replyLanguageOf('こんにちは、注文はどこですか')).toBe('ja')
  })

  it('中英夹杂按多的那种；英文信署个中文名不算中文信；引用的上一封不算', () => {
    expect(replyLanguageOf('订单 #1234 的 tracking number 还没更新，帮忙看下')).toBe('zh')
    expect(replyLanguageOf('Hi team, the parcel arrived damaged. Please advise.\n王')).toBe('en')
    expect(
      replyLanguageOf(
        'Thanks, that works for me.\n\nOn Mon, Sep 1, 2026 Shop wrote:\n> 你好，已经发货了',
      ),
    ).toBe('en')
    expect(replyLanguageOf('好的，谢谢\n> Hi, your order has shipped and will arrive soon')).toBe(
      'zh',
    )
  })

  it('判不出：回 undefined；退回品牌默认语言，再不行中文', () => {
    expect(replyLanguageOf('https://example.com/x ok')).toBeUndefined()
    expect(replyLanguageOf('')).toBeUndefined()
    expect(replyLanguage('https://example.com', 'FR')).toBe('fr')
    expect(replyLanguage('https://example.com')).toBe('zh')
    expect(replyLanguage('Where is my order?', 'de')).toBe('en')
  })
})
