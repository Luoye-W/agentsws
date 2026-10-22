/**
 * WP441（docs/108 §5.1）：消息规则——写死条件、AI 条件塞进同一次模型调用、多条命中的合法、
 * 去向过把握线、岗位没开不挪信、规则里没有外发动作、一句话转规则的确定性兜底、试跑、库。
 */
import type { MessageRecord, MessageRule, MessageRuleAction } from '@agentsws/contracts'
import { MESSAGE_RULE_ACTION_TYPES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  cleanAction,
  describeRule,
  evaluateRule,
  MemoryMessageStore,
  messageRuleStubScript,
  parseRuleSentence,
  RULE_TRIAGE_PROMPT_MARKER,
  resolveRuleActions,
  SqliteMessageStore,
  sanitizeRuleDraft,
  type TriageContext,
  type TriageInput,
  type TriageModel,
  triageMessage,
  trialRule,
} from '../src/index.js'

const T0 = '2026-10-22T02:00:00.000Z'

const rule = (over: Partial<MessageRule> & Pick<MessageRule, 'id'>): MessageRule => ({
  name: over.id,
  scope: { kind: 'brand' },
  when: { match: 'all', conditions: [] },
  actions: [],
  enabled: true,
  order: 0,
  revision: 1,
  by: 'per_me',
  updated_by: 'per_me',
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
  origin_text: '',
  ...over,
})

const input = (over: Partial<TriageInput> = {}): TriageInput => ({
  from_email: 'notify@shopify.com',
  subject: 'Your payout of $120 is on its way',
  text: 'Hi, your payout has been sent.',
  thread_id: '<p1@shopify>',
  references: [],
  headers: {},
  has_attachments: false,
  date: T0,
  ...over,
})

const ctx = (over: Partial<TriageContext> = {}): TriageContext => ({
  support_enabled: true,
  kol_enabled: false,
  b2b_enabled: false,
  isSupportThread: () => false,
  isKolThread: () => false,
  isB2bThread: () => false,
  isB2bSender: () => false,
  senderRules: [],
  model_halted: false,
  at: T0,
  ...over,
})

/** 替身模型：记几次调用、递来哪几条规则；按给定的把握回 `rule_hits`。 */
function countingModel(
  hits: Record<string, number> = {},
  verdict: Partial<Awaited<ReturnType<TriageModel['classify']>>> = {},
) {
  const calls: Parameters<TriageModel['classify']>[0][] = []
  const model: TriageModel = {
    async classify(req) {
      calls.push(req)
      return {
        route: 'inbox',
        labels: [],
        needs_reply: true,
        priority: 'normal',
        summary: '一封信',
        confidence: 0.9,
        kind: 'personal_other',
        rule_hits: (req.rules ?? [])
          .filter((r) => hits[r.id] !== undefined)
          .map((r) => ({ id: r.id, confidence: hits[r.id] })),
        ...verdict,
      }
    },
  }
  return { model, calls }
}

const settlement = rule({
  id: 'r_settle',
  name: '结算通知',
  when: {
    match: 'all',
    conditions: [
      { type: 'from', value: '@shopify.com' },
      { type: 'subject_has', value: 'payout' },
    ],
  },
  actions: [{ type: 'label', label: 'billing' }, { type: 'record' }, { type: 'notice' }],
})

const pitch = rule({
  id: 'r_pitch',
  name: '推销',
  order: 1,
  when: { match: 'all', conditions: [{ type: 'ai', value: '陌生人的推销 / 开发信' }] },
  actions: [{ type: 'notify' }],
})

describe('写死条件', () => {
  it('发件人域 + 主题含 → 命中，子域也算；排除名单不认', () => {
    const mail = {
      from_email: 'mail@mailer.shopify.com',
      subject: 'Payout sent',
      text: '',
      has_attachments: false,
    }
    expect(evaluateRule(settlement, mail).hit).toBe(true)
    expect(evaluateRule(settlement, { ...mail, subject: 'Order #1' }).hit).toBe(false)
    expect(
      evaluateRule(
        { ...settlement, when: { ...settlement.when, except: ['mail@mailer.shopify.com'] } },
        mail,
      ).hit,
    ).toBe(false)
  })
  it('一个条件都没有的规则不命中任何信', () => {
    expect(
      evaluateRule(rule({ id: 'x' }), {
        from_email: 'a@b.com',
        subject: '',
        text: '',
        has_attachments: false,
      }).hit,
    ).toBe(false)
  })
  it('带去向的写死规则命中 → 不问模型；只是通知、打标签', async () => {
    const { model, calls } = countingModel()
    const v = await triageMessage(input(), ctx({ messageRules: [settlement, pitch] }), model)
    expect(calls).toHaveLength(0)
    expect(v.needs_reply).toBe(false)
    expect(v.labels).toContain('billing')
    expect(v.rule_hits?.map((h) => h.rule_id)).toEqual(['r_settle'])
    expect(v.rule_route).toBe('r_settle')
  })
  it('规则建好之前的信不管（生效只管以后进来的）', async () => {
    const late = { ...settlement, created_at: '2026-10-23T00:00:00.000Z' }
    const { model } = countingModel()
    const v = await triageMessage(input(), ctx({ messageRules: [late] }), model)
    expect(v.rule_hits).toBeUndefined()
  })
})

describe('AI 条件：一封信只调一次模型', () => {
  it('塞进第 ④ 层那一次调用，多回「命中了哪几条」', async () => {
    const { model, calls } = countingModel({ r_pitch: 0.85 })
    const v = await triageMessage(
      input({
        from_email: 'sam@growth-agency.example',
        subject: 'Grow your store',
        text: 'SEO help',
      }),
      ctx({ messageRules: [settlement, pitch] }),
      model,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.rules?.map((r) => r.id)).toEqual(['r_pitch'])
    expect(v.rule_hits).toEqual([{ rule_id: 'r_pitch', by: 'ai', confidence: 0.85, name: '推销' }])
  })
  it('没有要判的 AI 规则时提示词与老的一样（不带 rules）', async () => {
    const { model, calls } = countingModel()
    await triageMessage(
      input({ from_email: 'a@b.example', subject: 'hi' }),
      ctx({ messageRules: [settlement] }),
      model,
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]?.rules).toBeUndefined()
  })
  it('自动信（③）有 AI 规则要判 → 问一次模型，只取它判的规则，结论仍听信头', async () => {
    const { model, calls } = countingModel(
      { r_pitch: 0.9 },
      { route: 'support', needs_reply: true },
    )
    const v = await triageMessage(
      input({
        from_email: 'news@agency.example',
        subject: 'We can help you grow',
        headers: { 'list-unsubscribe': '<mailto:x@y>' },
      }),
      ctx({ messageRules: [pitch] }),
      model,
    )
    expect(calls).toHaveLength(1)
    expect(v.route).toBe('inbox')
    expect(v.needs_reply).toBe(false)
    expect(v.rule_hits?.[0]?.rule_id).toBe('r_pitch')
  })
  it('发件人规则命中的信不再判 AI 条件（不调模型）', async () => {
    const { model, calls } = countingModel({ r_pitch: 0.9 })
    const v = await triageMessage(
      input({ from_email: 'sam@growth-agency.example', subject: 'hello' }),
      ctx({
        messageRules: [pitch],
        senderRules: [
          {
            id: 's1',
            sender: 'sam@growth-agency.example',
            labels: [],
            by: 'p',
            created_at: T0,
            kind: 'partnership',
          },
        ],
      }),
      model,
    )
    expect(calls).toHaveLength(0)
    expect(v.kind_by).toBe('sender_rule')
    expect(v.rule_hits).toBeUndefined()
  })
  it('去向类动作要过 0.6：0.55 只打标签不改去向', async () => {
    const r = rule({
      id: 'r_soft',
      when: { match: 'all', conditions: [{ type: 'ai', value: '供应商来信' }] },
      actions: [{ type: 'label', label: 'suppliers' }, { type: 'notice' }],
    })
    const { model } = countingModel({ r_soft: 0.55 })
    const v = await triageMessage(
      input({ from_email: 'a@factory.example', subject: 'hi' }),
      ctx({ messageRules: [r] }),
      model,
    )
    expect(v.labels).toContain('suppliers')
    expect(v.needs_reply).toBe(true)
    expect(v.rule_route).toBeUndefined()
  })
  it('模型急停：AI 规则不判、写死规则照跑', async () => {
    const { model, calls } = countingModel({ r_pitch: 0.9 })
    const v = await triageMessage(
      input({ from_email: 'x@y.example', subject: 'x' }),
      ctx({ messageRules: [pitch], model_halted: true }),
      model,
    )
    expect(calls).toHaveLength(0)
    expect(v.by).toBe('halted')
    expect(v.rule_hits).toBeUndefined()
  })
})

describe('多条命中', () => {
  const a = rule({
    id: 'a',
    name: 'A',
    order: 0,
    when: { match: 'all', conditions: [{ type: 'from', value: '@x.example' }] },
    actions: [
      { type: 'notice' },
      { type: 'label', label: 'billing' },
      { type: 'record', sink_id: 's1' },
    ],
  })
  const b = rule({
    id: 'b',
    name: 'B',
    order: 1,
    when: { match: 'all', conditions: [{ type: 'from', value: '@x.example' }] },
    actions: [
      { type: 'hand_to', position_id: 'customer-care' },
      { type: 'label', label: 'orders' },
      { type: 'record', sink_id: 's1' },
      { type: 'notify' },
    ],
  })
  it('去向只认排最前的一条；其余动作全做；同一处只记一次', () => {
    const r = resolveRuleActions([
      { rule: b, by: 'static' },
      { rule: a, by: 'static' },
    ])
    expect(r.destination?.rule_id).toBe('a')
    expect(r.labels).toEqual(['billing', 'orders'])
    expect(r.records).toHaveLength(1)
    expect(r.notifies).toEqual([{ rule_id: 'b', name: 'B', person_id: 'per_me' }])
    expect(r.hits.map((h) => h.rule_id)).toEqual(['a', 'b'])
  })
  it('排序换过来，去向跟着换', async () => {
    const { model } = countingModel()
    const v = await triageMessage(
      input({ from_email: 'q@x.example', subject: 'where is my order' }),
      ctx({ messageRules: [{ ...a, order: 5 }, b] }),
      model,
    )
    expect(v.route).toBe('support')
    expect(v.rule_route).toBe('b')
  })
  it('交给的岗位没开 → 不挪信，留在没人接的', async () => {
    const { model } = countingModel()
    const v = await triageMessage(
      input({ from_email: 'q@x.example', subject: 'hi' }),
      ctx({ messageRules: [b], support_enabled: false }),
      model,
    )
    expect(v.route).toBe('inbox')
    expect(v.needs_reply).toBe(true)
    expect(v.suggested_position).toBe('customer-care')
  })
})

describe('守卫：规则里不存在外发动作', () => {
  it('动作全集只有七种，没有发送 / 转发 / 删除', () => {
    expect([...MESSAGE_RULE_ACTION_TYPES].sort()).toEqual(
      ['digest', 'draft', 'hand_to', 'label', 'notice', 'notify', 'record'].sort(),
    )
    for (const bad of ['send', 'reply', 'forward', 'delete', 'trash', 'spam', 'archive', 'webhook'])
      expect(cleanAction({ type: bad, to: 'x@y.com' })).toBeUndefined()
  })
  it('草案里混进来的外发动作被丢掉；只剩外发动作就不成规则', () => {
    const d = sanitizeRuleDraft(
      {
        when: { match: 'all', conditions: [{ type: 'from', value: 'a@b.com' }] },
        actions: [
          { type: 'forward', to: 'evil@x.com' },
          { type: 'label', label: 'billing' },
        ],
      },
      '原话',
    )
    expect(d?.actions).toEqual([{ type: 'label', label: 'billing' }])
    expect(
      sanitizeRuleDraft(
        {
          when: { match: 'all', conditions: [{ type: 'from', value: 'a@b.com' }] },
          actions: [{ type: 'send' }],
        },
        '原话',
      ),
    ).toBeUndefined()
  })
})

describe('一句话转规则（确定性兜底）', () => {
  it('「Shopify 结算通知打标签记到表里别烦我」→ 写死条件 + 三个动作', () => {
    const d = parseRuleSentence('Shopify 结算通知打标签记到表里别烦我', {
      sinks: [{ id: 'snk_1', name: '财务表' }],
    })
    expect(d?.when.conditions).toEqual([
      { type: 'from', value: '@shopify.com' },
      { type: 'subject_has', value: 'payout' },
    ])
    const types = d?.actions.map((a: MessageRuleAction) => a.type)
    expect(types).toEqual(['notice', 'label', 'record'])
    expect(d?.actions).toContainEqual({ type: 'record', sink_id: 'snk_1', sink_name: '财务表' })
    expect(d?.origin_text).toBe('Shopify 结算通知打标签记到表里别烦我')
    expect(describeRule(d as MessageRule)).toContain('shopify.com 发来')
  })
  it('「推销的都告诉我」→ AI 条件 + 告诉我', () => {
    const d = parseRuleSentence('推销的都告诉我')
    expect(d?.when.conditions[0]?.type).toBe('ai')
    expect(d?.actions).toEqual([{ type: 'notify' }])
    expect(d?.name).toBe('推销')
  })
  it('认不出动作就不成规则', () => {
    expect(parseRuleSentence('今天天气不错')).toBeUndefined()
  })
  it('stub 剧本：分拣带规则才回 rule_hits，不带规则不接话', () => {
    const sys = { role: 'system', content: `分拣……${RULE_TRIAGE_PROMPT_MARKER}` }
    const out = messageRuleStubScript([
      sys,
      {
        role: 'user',
        content: JSON.stringify({
          subject: 'Boost your sales',
          body: 'SEO agency',
          rules: [{ id: 'r', text: '推销' }],
        }),
      },
    ])
    expect(JSON.parse(out ?? '{}').rule_hits).toEqual([{ id: 'r', confidence: 0.85 }])
    expect(
      messageRuleStubScript([
        { role: 'system', content: '分拣' },
        { role: 'user', content: '{}' },
      ]),
    ).toBeUndefined()
  })
})

const rec = (id: string, over: Partial<MessageRecord> = {}): MessageRecord => ({
  id,
  workspace_id: 'ws_1' as never,
  source: 'email',
  account: 'shop@brand.example',
  folder: 'INBOX',
  folder_kind: 'inbox',
  thread_id: `<${id}>`,
  references: [],
  headers: {},
  from: { email: 'notify@shopify.com', name: 'Shopify' },
  to: [],
  cc: [],
  bcc: [],
  subject: 'Your payout is on its way',
  snippet: '',
  text: '',
  has_remote_images: false,
  attachments: [],
  date: '2026-10-20T00:00:00.000Z',
  received_at: '2026-10-20T00:00:00.000Z',
  flags: { read: false, starred: false, answered: false, draft: false },
  labels: [],
  route: 'inbox',
  ...over,
})

describe('试跑', () => {
  it('写死条件跑最近 30 天全部；列出会被改掉去向的那几封；不落库', async () => {
    const all = [
      rec('m1'),
      rec('m2', { route: 'support' }),
      rec('m3', { subject: 'Order #1' }),
      rec('m4', { date: '2026-08-01T00:00:00.000Z' }),
      rec('m5', { folder_kind: 'sent', folder: 'Sent' }),
    ]
    const t = await trialRule(settlement, all, { now: T0 })
    expect(t.scanned).toBe(3)
    expect(t.matched).toBe(2)
    expect(t.changed.map((c) => [c.message_id, c.before, c.after])).toEqual([
      ['m1', 'unclaimed', 'notice'],
      ['m2', 'customer-care', 'notice'],
    ])
  })
  it('AI 条件最多试 50 封；没接模型照实说只按写死条件试了', async () => {
    const all = Array.from({ length: 60 }, (_, i) =>
      rec(`a${i}`, { from: { email: `x${i}@y.example` } }),
    )
    let asked = 0
    const t = await trialRule(pitch, all, {
      now: T0,
      ai: async (mails) => {
        asked = mails.length
        return new Map(mails.slice(0, 7).map((m) => [m.id, 0.9]))
      },
    })
    expect(asked).toBe(50)
    expect(t.matched).toBe(7)
    expect(t.ai_checked).toBe(50)
    const none = await trialRule(pitch, all, { now: T0 })
    expect(none.ai_skipped).toBe(true)
    expect(none.matched).toBe(0)
  })
})

describe('库：消息规则与简报两种库一样', () => {
  for (const [name, make] of [
    ['memory', () => new MemoryMessageStore()],
    ['sqlite', () => new SqliteMessageStore()],
  ] as const) {
    it(name, () => {
      const store = make()
      store.putMessageRule?.(settlement)
      store.putMessageRule?.({ ...pitch, order: -1 })
      expect(store.messageRules?.().map((r) => r.id)).toEqual(['r_pitch', 'r_settle'])
      expect(store.deleteMessageRule?.('r_pitch')).toBe(true)
      store.putDigestEntry?.({
        message_id: 'm1',
        thread_id: 't1',
        rule_ids: ['r'],
        rule_names: ['R'],
        subject: 's',
        from: 'f',
        summary: '一句',
        at: T0,
      })
      expect(store.digestEntries?.()).toHaveLength(1)
    })
  }
})
