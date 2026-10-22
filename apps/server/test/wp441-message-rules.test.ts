/**
 * WP441（docs/108 §5.1 / §5.6）：消息规则——服务进程这一层。
 *
 * - 一句话 → 草案 + 试跑（数字对）+ 「要建这条规则吗」卡；卡被点「建」才生效；下一封命中：打标签、只是通知、记到某处，
 *   **不问模型**（写死条件）；
 * - 「推销的都告诉我」→ AI 条件：一封信只调一次模型（替身计数），命中了铃铛一条，一小时内同一条规则合成一条；
 * - 去向冲突按清单顺序、拖动排序换过来跟着换；交给的岗位没开不挪信；
 * - 版本号防撞（拿旧版本改的回「刚被 X 改过」）；「这封不该归它」加排除当场生效；
 * - 今天的简报：没到点不发、到点发一条、一天一次、0 封不发、「全部知道了」；
 * - 起草回复：按来信语言起草、出卡（不发信）；
 * - 对话里的工具：只有人发起的对话才建规则。
 */
import type { MailboxWriter, MailSource, RawEmailMessage } from '@agentsws/channels'
import { RULE_TRIAGE_PROMPT_MARKER } from '@agentsws/channels'
import type {
  ApprovalItem,
  Clock,
  MessageRecord,
  MessageRuleDraft,
  ModelGateway,
} from '@agentsws/contracts'
import { MemoryHalt } from '@agentsws/kernel'
import { describe, expect, it } from 'vitest'
import type { MailAccount } from '../src/index.js'
import { createMessageRuleToolExecutor } from '../src/message-rule-tools.js'
import { DIGEST_SYSTEM_RULE_ID } from '../src/message-rules.js'
import { createMessages, type MessagesOptions } from '../src/messages.js'

const WS = 'ws_1'
const ME = 'hello@shop.example'
const ACTOR = { workspace_id: WS, person_id: 'p_owner', assignment_id: 'asg_1' }
const OTHER = { workspace_id: WS, person_id: 'p_lin', assignment_id: 'asg_2' }

const account: MailAccount = {
  connection_id: 'conn_mail',
  address: ME,
  imap: { host: 'localhost', port: 143, secure: false, user: ME, connection_id: 'conn_mail' },
  smtp: { host: 'localhost', port: 25, secure: false, user: ME, connection_id: 'conn_mail' },
}

function mime(
  uid: number,
  from: string,
  subject: string,
  date: string,
  text = 'plain body',
): RawEmailMessage {
  const source = [
    `From: ${from}`,
    `To: ${ME}`,
    `Subject: ${subject}`,
    `Message-ID: <m-${uid}@mail.example>`,
    `Date: ${new Date(date).toUTCString()}`,
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

/** 模型替身：分拣回固定结论（带规则时按词面回 rule_hits）；数调用次数。其余调用回不能用的字（走兜底）。 */
function models() {
  const calls: { kind: string; rules?: unknown }[] = []
  const gateway = {
    async complete(req: { messages: { role: string; content: string }[] }) {
      const system = req.messages[0]?.content ?? ''
      const user = JSON.parse(req.messages[1]?.content ?? '{}') as Record<string, unknown>
      let text = 'not json'
      if (system.includes('邮件分拣')) {
        calls.push({ kind: 'triage', rules: user.rules })
        const rules = (user.rules ?? []) as { id: string; text: string }[]
        const pitchy = /seo|grow your|agency/i.test(`${user.subject} ${user.body}`)
        text = JSON.stringify({
          route: 'inbox',
          labels: [],
          needs_reply: true,
          priority: 'normal',
          summary: '一封来信',
          confidence: 0.9,
          kind: 'personal_other',
          rule_hits: pitchy ? rules.map((r) => ({ id: r.id, confidence: 0.85 })) : [],
        })
      } else if (system.includes(RULE_TRIAGE_PROMPT_MARKER)) {
        calls.push({ kind: 'trial' })
        const mails = (user.mails ?? []) as { id: string; subject: string; body: string }[]
        text = JSON.stringify({
          results: mails.map((m) => ({
            id: m.id,
            rule_hits: /seo|grow your|agency/i.test(`${m.subject} ${m.body}`)
              ? [{ id: 'trial', confidence: 0.9 }]
              : [],
          })),
        })
      } else if (system.includes('回复草稿') || system.includes('回一封邮件')) {
        calls.push({ kind: 'suggest' })
        const lang = (user.lang as string) ?? 'zh'
        text = JSON.stringify(
          ((user.kinds as string[]) ?? ['short']).map((kind) => ({
            kind,
            text: lang === 'en' ? 'Thanks, we will look into it.' : '收到，我们看一下。',
          })),
        )
      } else {
        calls.push({ kind: 'other' })
      }
      return {
        text,
        usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub' },
        static_prefix_hash: '',
      }
    },
  } as unknown as ModelGateway
  return { gateway, calls }
}

function harness(extra: Partial<MessagesOptions> = {}, start = '2026-10-22T02:00:00.000Z') {
  const time = { now: start }
  const clock: Clock = { now: () => time.now, sleep: async () => undefined }
  const rows: RawEmailMessage[] = []
  const m = models()
  const cards: { kind: 'rule' | 'draft'; input: Record<string, unknown> }[] = []
  const records: Record<string, unknown>[] = []
  const notes: { person_id: string; text: string; key: string; href: string }[] = []
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
    ruleSinks: () => [{ id: 'snk_fin', name: '财务表' }],
    recordRuleMessage: (input) => {
      records.push({
        message: input.record.subject,
        sink_id: input.sink_id,
        rules: input.rules.map((r) => r.name),
      })
    },
    notifyMessages: (n) => {
      notes.push(n)
    },
    stageRuleCard: async (input) => {
      cards.push({ kind: 'rule', input: input as never })
      return `card_${cards.length}`
    },
    stageRuleDraft: async (input) => {
      cards.push({ kind: 'draft', input: input as never })
      return `card_${cards.length}`
    },
    ...extra,
  })
  return { messages, rows, time, cards, records, notes, ...m }
}

/** 「要建这条规则吗」卡被点了「建」（卡上的草案原样，或勾了「也处理过去 30 天的」）。 */
function decided(
  input: Record<string, unknown>,
  over: { apply_past?: boolean; by?: string; state?: string; pick?: string } = {},
): ApprovalItem {
  return {
    id: 'card_x',
    workspace_id: WS,
    kind: 'policy_change',
    state: over.state ?? 'approved',
    proposer: { kind: 'person', id: 'p_owner' },
    routing: { recipients: [{ person: 'p_owner', via: 'owner' }] },
    decision: {
      action: 'approve',
      by: over.by ?? 'p_owner',
      at: '2026-10-22T02:00:00.000Z',
      via: 'workstation',
      selected_option_id: over.pick ?? (over.apply_past === true ? 'after_past' : 'after'),
    },
    payload: {
      form: 'message_rule',
      draft: input.draft,
      ...(input.rule_id === undefined ? {} : { rule_id: input.rule_id, revision: input.revision }),
    },
  } as unknown as ApprovalItem
}

const byFrom = async (h: ReturnType<typeof harness>, from: string, subject?: string) => {
  const all = await h.messages.store.list({ limit: 1000 })
  const hit = all.find(
    (r) => r.from.email === from && (subject === undefined || r.subject === subject),
  )
  if (hit === undefined) throw new Error(`没有 ${from} 的信`)
  return hit as MessageRecord
}

describe('WP441 一句话建规则：Shopify 结算通知', () => {
  it('试跑数字对 → 出卡 → 点「建」才生效 → 下一封命中：打标签、只是通知、记到财务表，不问模型', async () => {
    const h = harness()
    const d = '2026-10-21T01:00:00.000Z'
    h.rows.push(
      mime(1, 'notify@shopify.com', 'Your payout of $120 is on its way', d),
      mime(2, 'notify@shopify.com', 'Your payout of $80 is on its way', d),
      mime(3, 'notify@shopify.com', 'New order #1001', d),
      mime(4, 'ann@buyer.example', 'payout question', d),
    )
    await h.messages.poll()
    const out = await h.messages.port.proposeMessageRule?.(ACTOR, {
      text: 'Shopify 结算通知打标签记到表里别烦我',
    })
    expect(out?.ok).toBe(true)
    expect(out?.draft?.when.conditions).toEqual([
      { type: 'from', value: '@shopify.com' },
      { type: 'subject_has', value: 'payout' },
    ])
    expect(out?.trial).toMatchObject({ scanned: 4, matched: 2 })
    expect(out?.plain).toContain('只是通知')
    expect(out?.card_id).toBe('card_1')
    // 出卡不等于生效
    expect((await h.messages.port.messageRules?.(ACTOR))?.rules.filter((r) => !r.system)).toEqual(
      [],
    )

    await h.messages.rules.onCardDecided(decided(h.cards[0]?.input ?? {}))
    const list = await h.messages.port.messageRules?.(ACTOR)
    const rule = list?.rules.find((r) => r.system === undefined)
    expect(rule).toMatchObject({ name: 'Shopify 结算通知', revision: 1, by: 'p_owner' })
    expect(rule?.origin_text).toBe('Shopify 结算通知打标签记到表里别烦我')
    // 系统规则「今天的简报」也在清单里
    expect(list?.rules.some((r) => r.id === DIGEST_SYSTEM_RULE_ID && r.time === '09:00')).toBe(true)

    h.time.now = '2026-10-22T03:00:00.000Z'
    h.calls.length = 0
    h.rows.push(mime(5, 'notify@shopify.com', 'Your payout of $300 is on its way', h.time.now))
    await h.messages.poll()
    expect(h.calls.filter((c) => c.kind === 'triage')).toEqual([])
    const hit = await byFrom(h, 'notify@shopify.com', 'Your payout of $300 is on its way')
    expect(hit.labels).toContain('billing')
    expect(hit.triage?.needs_reply).toBe(false)
    expect(hit.triage?.rule_hits).toEqual([
      { rule_id: rule?.id, by: 'static', name: 'Shopify 结算通知' },
    ])
    const threads = await h.messages.port.threads(ACTOR, { claim: 'notice' })
    expect(threads.threads.some((t) => t.subject === 'Your payout of $300 is on its way')).toBe(
      true,
    )
    expect(h.records).toEqual([
      {
        message: 'Your payout of $300 is on its way',
        sink_id: 'snk_fin',
        rules: ['Shopify 结算通知'],
      },
    ])
    expect((await h.messages.port.messageRules?.(ACTOR))?.rules[0]).toMatchObject({
      hits_30d: 1,
      recent_hits: [expect.objectContaining({ subject: 'Your payout of $300 is on its way' })],
    })
    // 建之前的老信不动（生效只管以后进来的）
    expect(
      (await byFrom(h, 'notify@shopify.com', 'Your payout of $120 is on its way')).triage
        ?.rule_hits,
    ).toBeUndefined()
  })

  it('「也处理过去 30 天的」：打标签、只是通知、记录；点「不要」什么都不建', async () => {
    const h = harness()
    h.rows.push(
      mime(
        1,
        'notify@shopify.com',
        'Your payout of $120 is on its way',
        '2026-10-20T01:00:00.000Z',
      ),
    )
    await h.messages.poll()
    await h.messages.port.proposeMessageRule?.(ACTOR, { text: 'Shopify 结算通知打标签别烦我' })
    await h.messages.rules.onCardDecided(decided(h.cards[0]?.input ?? {}, { pick: 'before' }))
    expect((await h.messages.port.messageRules?.(ACTOR))?.rules.filter((r) => !r.system)).toEqual(
      [],
    )
    await h.messages.rules.onCardDecided(decided(h.cards[0]?.input ?? {}, { apply_past: true }))
    const old = await byFrom(h, 'notify@shopify.com')
    expect(old.labels).toContain('billing')
    expect(old.triage?.needs_reply).toBe(false)
    // 过去的信不发铃铛
    expect(h.notes).toEqual([])
  })
})

describe('WP441 推销的都告诉我（AI 条件）', () => {
  it('一封信只调一次模型；命中铃铛一条；一小时内同一条规则合成一条', async () => {
    const h = harness()
    const out = await h.messages.port.proposeMessageRule?.(ACTOR, { text: '推销的都告诉我' })
    expect(out?.draft?.when.conditions[0]?.type).toBe('ai')
    await h.messages.rules.onCardDecided(decided(h.cards[0]?.input ?? {}))
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.calls.length = 0
    h.rows.push(
      mime(1, 'sam@growth.example', 'Grow your store with SEO', h.time.now),
      mime(2, 'kim@growth.example', 'Agency offer', h.time.now),
      mime(3, 'ann@buyer.example', 'where is my order', h.time.now),
    )
    await h.messages.poll()
    const triage = h.calls.filter((c) => c.kind === 'triage')
    // 三封信三次（每封一次），没有为规则多调
    expect(triage).toHaveLength(3)
    expect(triage.every((c) => Array.isArray(c.rules) && (c.rules as unknown[]).length === 1)).toBe(
      true,
    )
    expect(h.notes).toHaveLength(2)
    expect(h.notes[0]?.key).toBe(h.notes[1]?.key)
    expect(h.notes[0]?.text).toContain('来信')
    expect(h.notes[0]?.person_id).toBe('p_owner')
  })
})

describe('WP441 去向冲突、版本号、排除、岗位没开', () => {
  const base = (name: string, actions: MessageRuleDraft['actions']): MessageRuleDraft => ({
    name,
    when: { match: 'all', conditions: [{ type: 'from', value: '@x.example' }] },
    actions,
    origin_text: name,
  })

  it('去向按清单顺序；拖动换过来跟着换', async () => {
    const h = harness({
      activeRoles: () => ['dtc.support'],
      positions: () => [
        { id: 'customer-care', name_zh: '客服', name_en: 'CS', open: true, route: 'support' },
      ],
    })
    const a = await h.messages.port.createMessageRule?.(ACTOR, base('A', [{ type: 'notice' }]))
    const b = await h.messages.port.createMessageRule?.(
      ACTOR,
      base('B', [
        { type: 'hand_to', position_id: 'customer-care' },
        { type: 'label', label: 'orders' },
      ]),
    )
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.rows.push(mime(1, 'q@x.example', 'one', h.time.now))
    await h.messages.poll()
    const one = await byFrom(h, 'q@x.example', 'one')
    expect(one.triage?.rule_route).toBe(a?.rule.id)
    expect(one.triage?.needs_reply).toBe(false)
    expect(one.labels).toContain('orders')

    await h.messages.port.reorderMessageRules?.(ACTOR, [b?.rule.id ?? '', a?.rule.id ?? ''])
    h.rows.push(mime(2, 'q@x.example', 'two', h.time.now))
    await h.messages.poll()
    const two = await byFrom(h, 'q@x.example', 'two')
    expect(two.triage?.rule_route).toBe(b?.rule.id)
    expect(two.triage?.suggested_position).toBe('customer-care')
  })

  it('交给的岗位没开 → 不挪信，留在没人接的', async () => {
    const h = harness({
      positions: () => [{ id: 'pr', name_zh: '公关', name_en: 'PR', open: false }],
    })
    await h.messages.port.createMessageRule?.(
      ACTOR,
      base('媒体', [{ type: 'hand_to', position_id: 'pr' }]),
    )
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.rows.push(mime(1, 'q@x.example', 'interview?', h.time.now))
    await h.messages.poll()
    const t = await h.messages.port.threads(ACTOR, { claim: 'unclaimed' })
    expect(t.threads.map((x) => x.subject)).toContain('interview?')
  })

  it('拿旧版本改 → 「刚被 X 改过」；同事模式留名、通知', async () => {
    const changes: string[] = []
    const h = harness({
      sharedRules: () => true,
      personName: (id) => (id === 'p_lin' ? '林二' : '王一'),
      notifyMessageRuleChange: ({ by, action }) => {
        changes.push(`${by}:${action}`)
      },
    })
    const made = await h.messages.port.createMessageRule?.(ACTOR, base('A', [{ type: 'notice' }]))
    const id = made?.rule.id ?? ''
    await h.messages.port.updateMessageRule?.(OTHER, id, { revision: 1, enabled: false })
    await expect(
      h.messages.port.updateMessageRule?.(ACTOR, id, { revision: 1, name: 'A2' }),
    ).rejects.toThrow('刚被 林二 改过')
    const seen = await h.messages.port.messageRules?.(ACTOR)
    expect(seen?.rules.find((r) => r.id === id)).toMatchObject({
      revision: 2,
      enabled: false,
      by_name: '王一',
      updated_by_name: '林二',
    })
    expect(changes).toEqual(['p_owner:created', 'p_lin:updated'])
  })

  it('「这封不该归它」：加这个发件人的排除，下一封不再命中', async () => {
    const h = harness()
    const made = await h.messages.port.createMessageRule?.(
      ACTOR,
      base('A', [{ type: 'label', label: 'billing' }]),
    )
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.rows.push(mime(1, 'q@x.example', 'one', h.time.now))
    await h.messages.poll()
    const one = await byFrom(h, 'q@x.example', 'one')
    expect(one.labels).toContain('billing')
    const ex = await h.messages.port.excludeFromMessageRule?.(ACTOR, one.id, made?.rule.id ?? '')
    expect(ex?.rule.when.except).toEqual(['q@x.example'])
    h.rows.push(mime(2, 'q@x.example', 'two', h.time.now))
    await h.messages.poll()
    expect((await byFrom(h, 'q@x.example', 'two')).triage?.rule_hits).toBeUndefined()
  })
})

describe('WP441 今天的简报', () => {
  it('没到点不发；到点发一条、一天一次；全部知道了', async () => {
    // 东八区：UTC 00:30 = 本地 08:30
    const h = harness({ tzOffsetMinutes: () => 480 }, '2026-10-22T00:00:00.000Z')
    await h.messages.port.createMessageRule?.(ACTOR, {
      name: '供应商',
      when: { match: 'all', conditions: [{ type: 'from', value: '@vendor.example' }] },
      actions: [{ type: 'digest' }],
      origin_text: '供应商的信进简报',
    })
    h.time.now = '2026-10-22T00:30:00.000Z'
    h.rows.push(
      mime(1, 'a@vendor.example', 'quote', h.time.now),
      mime(2, 'b@vendor.example', 'invoice', h.time.now),
    )
    await h.messages.poll()
    expect(h.notes).toEqual([])
    const dg = await h.messages.port.digest?.(ACTOR)
    expect(dg).toMatchObject({ time: '09:00', total: 2, groups: [{ rule_name: '供应商' }] })

    h.time.now = '2026-10-22T01:05:00.000Z' // 本地 09:05
    await h.messages.poll()
    expect(h.notes).toEqual([
      expect.objectContaining({ text: '消息简报：今天 2 封', href: '/messages?panel=digest' }),
    ])
    await h.messages.poll()
    expect(h.notes).toHaveLength(1)
    expect(await h.messages.port.ackDigest?.(ACTOR)).toEqual({ acked: 2 })
    expect((await h.messages.port.digest?.(ACTOR))?.total).toBe(0)

    // 改时间、第二天 0 封不发
    const sys = (await h.messages.port.messageRules?.(ACTOR))?.rules.find(
      (r) => r.id === DIGEST_SYSTEM_RULE_ID,
    )
    await h.messages.port.updateMessageRule?.(ACTOR, DIGEST_SYSTEM_RULE_ID, {
      revision: sys?.revision ?? 1,
      time: '08:00',
    })
    h.time.now = '2026-10-23T00:05:00.000Z'
    await h.messages.poll()
    expect(h.notes).toHaveLength(1)
    await expect(h.messages.port.deleteMessageRule?.(ACTOR, DIGEST_SYSTEM_RULE_ID)).rejects.toThrow(
      '系统规则删不掉',
    )
  })
})

describe('WP441 起草回复：出卡、不发信', () => {
  it('按来信语言起草，交给宿主出卡', async () => {
    const h = harness()
    await h.messages.port.createMessageRule?.(ACTOR, {
      name: '合作',
      when: { match: 'all', conditions: [{ type: 'from', value: '@brand.example' }] },
      actions: [{ type: 'draft', instruction: '客气地婉拒' }],
      origin_text: '合作邀约都客气地婉拒',
    })
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.rows.push(
      mime(
        1,
        'ceo@brand.example',
        'Partnership?',
        h.time.now,
        'Would you like to partner with us?',
      ),
    )
    await h.messages.poll()
    await new Promise((r) => setTimeout(r, 10))
    const draft = h.cards.find((c) => c.kind === 'draft')
    expect(draft?.input).toMatchObject({
      rule: { name: '合作' },
      text: 'Thanks, we will look into it.',
    })
  })
})

describe('WP441 对话里的工具', () => {
  it('人发起的对话才建；信件触发的运行不建', async () => {
    const h = harness()
    const exec = createMessageRuleToolExecutor({ messages: () => h.messages })
    const req = (source: string) =>
      ({
        workspace_id: WS,
        actor: { person_id: 'p_owner', assignment_id: 'asg_1', role_id: 'common.owner' },
        trigger: { event_id: 'e', source },
        tools: { allow: [] },
      }) as never
    const no = await exec({
      name: 'propose_message_rule',
      input: { instruction: '推销的都告诉我' },
      request: req('inbound'),
    })
    expect(no).toMatchObject({ status: 'ok', data: { ok: false } })
    expect(h.cards).toHaveLength(0)
    const yes = await exec({
      name: 'propose_message_rule',
      input: { instruction: '推销的都告诉我' },
      request: req('manual'),
    })
    expect(yes).toMatchObject({ status: 'ok', data: { ok: true, name: '推销', card: true } })
    const list = await exec({ name: 'list_message_rules', input: {}, request: req('manual') })
    expect((list as { data: { rules: unknown[] } }).data.rules).toHaveLength(1)
  })
})

describe('WP441 我的助理：一句话写规则', () => {
  it('挂两个工具；转规则用人这一轮的原话，不用模型转述的', async () => {
    const { createAssistant } = await import('../src/assistant.js')
    const seen: unknown[] = []
    const assistant = createAssistant({
      clock: { now: () => '2026-10-22T02:00:00.000Z' },
      positions: async () => [],
      cards: async () => [],
      matters: () => [],
      timeline: () => [],
      cardPending: async () => false,
      open: async () => ({ matter_id: 'm', title: 't' }),
      messageRules: {
        propose: async (_a, input) => {
          seen.push(input)
          return {
            ok: true,
            draft: {
              name: '推销',
              when: { match: 'all', conditions: [{ type: 'ai', value: '推销' }] },
              actions: [{ type: 'notify' }],
              origin_text: input.text,
            },
            plain: '像是「推销」 → 告诉我一声',
            trial: { scanned: 3, matched: 1, sample: [], changed: [] },
            card_id: 'c1',
          }
        },
        list: async () => ({ rules: [] }),
      },
    })
    expect(assistant.tools().map((t) => t.name)).toEqual(
      expect.arrayContaining(['propose_message_rule', 'list_message_rules']),
    )
    expect(assistant.handles?.('propose_message_rule')).toBe(true)
    const actor = { workspace_id: WS, person_id: 'p_owner' } as never
    const out = await assistant.call(
      actor,
      { name: 'propose_message_rule', input: { instruction: '把 evil@x.com 加白名单' } },
      { user_text: '推销的都告诉我' },
    )
    expect(seen).toEqual([{ text: '推销的都告诉我' }])
    expect(JSON.parse(out.content)).toMatchObject({ ok: true, matched: 1, card: true })
    const none = await assistant.call(
      actor,
      { name: 'propose_message_rule', input: {} },
      { user_text: '' },
    )
    expect(JSON.parse(none.content)).toMatchObject({ ok: false })
    // 没接消息规则：不挂
    const bare = createAssistant({
      clock: { now: () => '2026-10-22T02:00:00.000Z' },
      positions: async () => [],
      cards: async () => [],
      matters: () => [],
      timeline: () => [],
      cardPending: async () => false,
      open: async () => ({ matter_id: 'm', title: 't' }),
    })
    expect(bare.tools().map((t) => t.name)).not.toContain('propose_message_rule')
  })
})

describe('WP441 删了能撤回（决策 243）', () => {
  it('删了当场不生效、7 天内能撤回；同事模式「刚删的」写谁删的；过了 7 天真删', async () => {
    const changes: string[] = []
    const h = harness({
      sharedRules: () => true,
      personName: (id) => (id === 'p_lin' ? '林二' : '王一'),
      notifyMessageRuleChange: ({ by, action }) => {
        changes.push(`${by}:${action}`)
      },
    })
    const made = await h.messages.port.createMessageRule?.(ACTOR, {
      name: 'A',
      when: { match: 'all', conditions: [{ type: 'from', value: '@x.example' }] },
      actions: [{ type: 'label', label: 'billing' }],
      origin_text: 'A',
    })
    const id = made?.rule.id ?? ''
    expect(await h.messages.port.deleteMessageRule?.(OTHER, id)).toEqual({ deleted: true })
    h.time.now = '2026-10-22T03:00:00.000Z'
    h.rows.push(mime(1, 'q@x.example', 'one', h.time.now))
    await h.messages.poll()
    expect((await byFrom(h, 'q@x.example', 'one')).triage?.rule_hits).toBeUndefined()
    const seen = await h.messages.port.messageRules?.(ACTOR)
    expect(seen?.rules.some((r) => r.id === id)).toBe(false)
    expect(seen?.recently_deleted?.[0]).toMatchObject({ id, deleted_by_name: '林二' })
    const back = await h.messages.port.restoreMessageRule?.(ACTOR, id)
    expect(back).toMatchObject({ restored: true, rule: { id, revision: 2 } })
    h.rows.push(mime(2, 'q@x.example', 'two', h.time.now))
    await h.messages.poll()
    expect((await byFrom(h, 'q@x.example', 'two')).labels).toContain('billing')
    expect(changes).toEqual(['p_owner:created', 'p_lin:deleted', 'p_owner:restored'])
    // 过了 7 天：撤不回、库里真删
    await h.messages.port.deleteMessageRule?.(ACTOR, id)
    h.time.now = '2026-10-30T03:00:00.000Z'
    expect(await h.messages.port.restoreMessageRule?.(ACTOR, id)).toEqual({ restored: false })
    await h.messages.port.messageRules?.(ACTOR)
    expect(((await h.messages.store.messageRules?.()) ?? []).some((r) => r.id === id)).toBe(false)
  })
})
