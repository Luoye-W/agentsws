/**
 * WP348（决策 887）：配置卡「AI 先查、先定方案，人只确认」（单元：替身审批总线、替身搜索 / 模型，不联网）。
 *
 * - 出卡前跑了「怎么查」：替身档案 / 已连账号 / 搜索结果进了方案值、理由与来源；查的过程记在时间线上、也带在卡上；
 * - 查不到的格子留空并标「需要你填」；不让猜的格子不认模型 / AI 的建议；
 * - 「就这样」= 方案原样存、接着做；「改一下」= 人改的值为准；
 * - 搜索 / 模型限次、同一句话 7 天内走缓存；
 * - 已设好再改：现值 → 新值，确认后生效、不确认不动；一格都没变不出卡；
 * - `request_setup`：已设好 + 带新值 = 提议改；理由带过去；像秘密的理由整条拒收。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  SetupField,
  SetupRequestPayload,
} from '@agentsws/contracts'
import { setupRequestBranch } from '@agentsws/stand-ins'
import { describe, expect, it, vi } from 'vitest'
import { RunBlockLog, setupNeedOf } from '../src/run-blocked.js'
import { createSetupCards, type SetupTarget } from '../src/setup-cards.js'
import { createSetupRequestTool } from '../src/setup-request-tool.js'
import {
  brandFactsOf,
  changeFields,
  createResearchKit,
  mergePlan,
  type SetupResearchHost,
} from '../src/setup-research.js'
import { builtinSetupTargets } from '../src/setup-targets.js'

const actor = { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'social.reddit' } as never

function fakeBus(): ApprovalBus & { items: Map<string, ApprovalItem> } {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  return {
    items,
    async create(raw: Partial<ApprovalItem>) {
      n += 1
      const item = { ...raw, id: `apr_${n}`, state: 'pending', revision: 1 } as ApprovalItem
      items.set(item.id, item)
      return item
    },
    async get(id: string) {
      return items.get(id)
    },
    async withdraw(id: string) {
      const it = items.get(id) as ApprovalItem
      it.state = 'withdrawn'
      return it
    },
  } as never
}

const decide = (bus: ReturnType<typeof fakeBus>, id: string, action: string, edited?: unknown) => {
  const it = bus.items.get(id) as ApprovalItem
  it.state = action === 'reject' ? 'rejected' : 'approved'
  it.decision = { action, ...(edited === undefined ? {} : { edited_payload: edited }) } as never
  return it
}

/** 一个通用的设置目标：一格档案里有、一格要搜、一格要模型、一格是账号（不让猜）、一格必填查不到。 */
function demoTarget(saved: Record<string, string> = {}) {
  const applied: Record<string, string>[] = []
  const target: SetupTarget = {
    id: 'demo.watch',
    name: '演示巡查',
    why: '我先查了一遍。',
    noGuess: ['account'],
    async fields(): Promise<SetupField[]> {
      const f = (key: string, label: string, required = false): SetupField => ({
        key,
        label,
        kind: 'text',
        required,
        ...(saved[key] === undefined ? {} : { suggested: saved[key] }),
      })
      return [
        f('keywords', '关键词'),
        f('forums', '版块'),
        f('alerts', '告警词'),
        f('account', '账号'),
        f('address', '地址', true),
      ]
    },
    async satisfied() {
      return Object.keys(saved).length > 0
    },
    async apply(values) {
      applied.push(values)
      Object.assign(saved, values)
    },
    async research(kit) {
      const facts = await kit.profile()
      kit.note(`看了档案：${facts.name}`)
      const hits = (await kit.search(`site:reddit.com ${facts.name}`)) ?? []
      kit.note(`搜到 ${hits.length} 条`)
      const ai = await kit.ask('整理一下')
      return {
        keywords: {
          value: [facts.name, ...(facts.keywords?.category ?? [])].join(', '),
          why: '品牌词和品类词',
          sources: [{ kind: 'profile', label: '品牌档案 · 关键词' }],
        },
        forums: {
          value: hits.map((h) => h.title).join(', '),
          why: '搜到的版块',
          sources: hits.map((h) => ({ kind: 'web' as const, label: h.title ?? '', url: h.url })),
        },
        ...(ai === undefined
          ? {}
          : {
              alerts: { value: ai, why: 'AI 整理', sources: [{ kind: 'model', label: 'AI 整理' }] },
            }),
        // 模型想猜账号：不认（来源不是已连的）
        account: { value: 'guessed_by_model', sources: [{ kind: 'model', label: 'AI 整理' }] },
      }
    },
  }
  return { target, applied, saved }
}

function setup(host?: Partial<SetupResearchHost>) {
  const bus = fakeBus()
  const notes: string[] = []
  const resumed: string[] = []
  const search = vi.fn(async (q: string) => [
    { url: 'https://www.reddit.com/r/SmartGlasses/', title: 'r/SmartGlasses', snippet: q },
  ])
  const ask = vi.fn(async () => 'recall, refund')
  const cards = createSetupCards({
    workspace_id: 'ws_1',
    clock: { now: () => '2026-10-15T09:00:00.000Z' },
    approvals: () => bus,
    isConnected: async () => true,
    resume: async (t) => {
      resumed.push(t.matter_id)
    },
    note: (_m, text) => notes.push(text),
    research: () => ({
      profile: () =>
        brandFactsOf(
          {
            // WP346 之后的形状（有就用）
            keywords: { brand: ['INMO'], category: ['AR glasses'], scenario: [] },
            competitors: [{ name: 'Xreal', reason: '同品类' }],
          },
          { name: 'INMO' },
        ),
      search,
      ask,
      ...host,
    }),
  })
  return { bus, cards, notes, resumed, search, ask }
}

describe('出卡前先查，卡面是方案', () => {
  it('档案 / 搜索 / 模型进了方案值、理由与来源；查的过程进时间线和卡；查不到的标需要你填；账号不让猜', async () => {
    const s = setup()
    const { target } = demoTarget()
    s.cards.registerTarget(target)
    const out = await s.cards.askSetup({ target: 'demo.watch', actor, matter_id: 'mat_1' })
    const p = out?.item.payload as SetupRequestPayload
    expect(out?.item.title).toBe('演示巡查：我打算这样设')
    expect(p.mode).toBe('plan')
    const by = (k: string) => p.fields.find((f) => f.key === k)
    expect(by('keywords')).toMatchObject({
      suggested: 'INMO, AR glasses',
      suggested_why: '品牌词和品类词',
      sources: [{ kind: 'profile' }],
    })
    expect(by('forums')?.sources?.[0]).toMatchObject({
      kind: 'web',
      url: 'https://www.reddit.com/r/SmartGlasses/',
    })
    expect(by('alerts')?.suggested).toBe('recall, refund')
    expect(by('account')).toMatchObject({ needs_you: true })
    expect(by('account')?.suggested).toBeUndefined()
    expect(by('address')).toMatchObject({ needs_you: true, required: true })
    expect(p.steps?.map((x) => x.text)).toEqual(['看了档案：INMO', '搜到 1 条'])
    expect(s.notes).toEqual(['看了档案：INMO', '搜到 1 条'])
  })

  it('「就这样」= 方案原样存、接着做；「改一下」= 人改的值为准', async () => {
    const s = setup()
    const one = demoTarget()
    s.cards.registerTarget(one.target)
    const out = await s.cards.askSetup({ target: 'demo.watch', actor, matter_id: 'mat_1' })
    const p = out?.item.payload as SetupRequestPayload
    // 必填的地址空着：「就这样」存不了 → 再出一张，等着的带过去
    await s.cards.onDecided(decide(s.bus, out?.item.id as string, 'approve'))
    expect(one.applied).toEqual([])
    expect(s.notes.at(-1)).toMatch(/没存成：「地址」还没填/)
    const again = [...s.bus.items.values()].at(-1) as ApprovalItem
    expect(again.id).not.toBe(out?.item.id)
    // 重出的那张不再查一遍
    expect(s.search).toHaveBeenCalledTimes(1)
    // 改一下：人填了地址、改了关键词
    await s.cards.onDecided(
      decide(s.bus, again.id, 'approve_edited', {
        ...(again.payload as SetupRequestPayload),
        values: { address: '1 Main St, Springfield', keywords: 'INMO only' },
      }),
    )
    expect(one.applied.at(-1)).toMatchObject({
      keywords: 'INMO only',
      forums: 'r/SmartGlasses',
      alerts: 'recall, refund',
      address: '1 Main St, Springfield',
    })
    expect(one.applied.at(-1)?.account).toBeUndefined()
    expect(s.resumed).toEqual(['mat_1'])
    void p
  })

  it('AI 在这件事里给的建议压过查到的，但碰不到不让猜的格子；理由带过去', async () => {
    const s = setup()
    s.cards.registerTarget(demoTarget().target)
    const log = new RunBlockLog()
    const need = setupNeedOf('request_setup', {
      status: 'ok',
      data: {
        ok: false,
        needs_setup: 'demo.watch',
        suggestions: { keywords: 'INMO, Air3', account: 'u_guess' },
        suggestion_why: { keywords: '加上型号' },
        message: '',
      },
    })
    if (need !== undefined) log.noteSetup('request_setup', need)
    const out = await s.cards.onRunBlocked({
      run_id: 'run_1',
      matter_id: 'mat_1',
      actor,
      block: log.block() as never,
      needs: [],
      targets: log.setupTargets(),
      ...log.asked(),
    })
    const p = out?.item.payload as SetupRequestPayload
    expect(p.fields.find((f) => f.key === 'keywords')).toMatchObject({
      suggested: 'INMO, Air3',
      suggested_why: '加上型号',
    })
    expect(p.fields.find((f) => f.key === 'account')?.needs_you).toBe(true)
  })

  it('搜索、模型限次；同一句话 7 天内走缓存；没宿主工具也照样出方案卡', async () => {
    const search = vi.fn(async () => [{ url: 'https://example.com/a', title: 'a' }])
    const ask = vi.fn(async () => 'x')
    const { kit, used } = createResearchKit(
      { profile: () => ({}), search, ask },
      { cache: undefined },
    )
    for (const q of ['a', 'b', 'c', 'd', 'e']) await kit.search(q)
    await kit.ask('p1')
    await kit.ask('p2')
    expect(search).toHaveBeenCalledTimes(3)
    expect(ask).toHaveBeenCalledTimes(1)
    expect(used()).toEqual({ searches: 3, asks: 1 })

    const s = setup()
    s.cards.registerTarget(demoTarget().target)
    const one = await s.cards.askSetup({ target: 'demo.watch', actor })
    await s.cards.onDecided(decide(s.bus, one?.item.id as string, 'reject'))
    await s.cards.askSetup({ target: 'demo.watch', actor })
    expect(s.search).toHaveBeenCalledTimes(1)
    expect(s.ask).toHaveBeenCalledTimes(1)

    const bare = createSetupCards({
      workspace_id: 'ws_2',
      clock: { now: () => '2026-10-15T09:00:00.000Z' },
      approvals: () => fakeBus(),
      isConnected: async () => true,
      resume: async () => undefined,
    })
    bare.registerTarget(demoTarget().target)
    const p = (await bare.askSetup({ target: 'demo.watch', actor }))?.item
      .payload as SetupRequestPayload
    expect(p.mode).toBe('plan')
    expect(p.fields.find((f) => f.key === 'address')?.needs_you).toBe(true)
  })
})

describe('已设好再改：我打算改成这样', () => {
  it('现值 → 新值；确认后生效、不确认不动；一格都没变不出卡；账号不改', async () => {
    const s = setup()
    const t = demoTarget({
      keywords: 'INMO',
      forums: 'SmartGlasses',
      account: 'brand_one',
      address: '1 Main St',
    })
    s.cards.registerTarget(t.target)
    // 一格都没变 → 不出
    expect(
      await s.cards.askSetup({
        target: 'demo.watch',
        actor,
        change: true,
        suggestions: { keywords: 'INMO' },
      }),
    ).toBeUndefined()
    const out = await s.cards.askSetup({
      target: 'demo.watch',
      actor,
      change: true,
      suggestions: { forums: 'SmartGlasses, Xreal', account: 'someone_else' },
      reasons: { forums: '竞品版也看看' },
    })
    const p = out?.item.payload as SetupRequestPayload
    expect(out?.item.title).toBe('演示巡查：我打算改成这样')
    expect(p.mode).toBe('change')
    const forums = p.fields.find((f) => f.key === 'forums')
    expect(forums).toMatchObject({
      current: 'SmartGlasses',
      suggested: 'SmartGlasses, Xreal',
      suggested_why: '竞品版也看看',
    })
    expect(p.fields.find((f) => f.key === 'account')).toMatchObject({
      current: 'brand_one',
      suggested: 'brand_one',
    })
    // 不确认：不动
    await s.cards.onDecided(decide(s.bus, out?.item.id as string, 'reject'))
    expect(t.applied).toEqual([])
    expect(t.saved.forums).toBe('SmartGlasses')
    // 再提一次、确认：生效（其余格子照现值存回去）
    const two = await s.cards.askSetup({
      target: 'demo.watch',
      actor,
      change: true,
      suggestions: { forums: 'SmartGlasses, Xreal' },
    })
    await s.cards.onDecided(decide(s.bus, two?.item.id as string, 'approve'))
    expect(t.saved).toMatchObject({
      keywords: 'INMO',
      forums: 'SmartGlasses, Xreal',
      account: 'brand_one',
    })
  })

  it('changeFields：下拉里没有的值不改', () => {
    const fields: SetupField[] = [
      {
        key: 'every',
        label: '频率',
        kind: 'select',
        options: [{ value: '24', label: '每天' }],
        suggested: '24',
        required: true,
      },
    ]
    expect(changeFields(fields, { every: '3' })).toBeUndefined()
  })
})

describe('request_setup：已设好 + 带新值 = 提议改', () => {
  const tool = (satisfied: boolean) =>
    createSetupRequestTool({
      directory: async () => [],
      isConnected: async () => undefined,
      target: async (id) =>
        id === 'reddit.watch'
          ? { id, name: 'Reddit 巡查', satisfied: async () => satisfied }
          : undefined,
      targetIds: async () => ['reddit.watch'],
    })
  const call = (input: Record<string, unknown>) =>
    ({ id: 'c1', name: 'request_setup', input }) as never

  it('设好了不带值 → 不用卡；带新值 → change + 理由；没设好 → 方案卡；像秘密的理由拒收', async () => {
    const t = tool(true)
    const plain = await t(call({ setting: 'reddit.watch', why: '看看' }), {} as never)
    expect((plain.data as { already?: boolean }).already).toBe(true)
    const change = await t(
      call({
        setting: 'reddit.watch',
        why: '把 Xreal 改成每周两次',
        suggestions: [{ key: 'watch_subreddits', value: 'Xreal（每周2次）', why: '量不大' }],
      }),
      {} as never,
    )
    expect(change.data).toMatchObject({
      ok: false,
      needs_setup: 'reddit.watch',
      change: true,
      suggestions: { watch_subreddits: 'Xreal（每周2次）' },
      suggestion_why: { watch_subreddits: '量不大' },
    })
    const need = setupNeedOf('request_setup', change)
    expect(need).toMatchObject({
      kind: 'setup',
      change: true,
      reasons: { watch_subreddits: '量不大' },
    })
    const fresh = await tool(false)(call({ setting: 'reddit.watch', why: '先设好' }), {} as never)
    expect((fresh.data as { change?: boolean }).change).toBeUndefined()
    const secret = await t(
      call({
        setting: 'reddit.watch',
        why: '改一下',
        suggestions: [{ key: 'keywords', value: 'x', why: 'password: hunter2' }],
      }),
      {} as never,
    )
    expect(secret.status).toBe('error')
    expect(secret.reason).not.toContain('hunter2')
  })
})

describe('内置几个目标的「怎么查」', () => {
  const targets = (facts: Record<string, string> = {}) =>
    builtinSetupTargets({
      theme: async () => undefined,
      postalAddress: () => undefined,
      setPostalAddress: () => true,
      brandFacts: () => facts,
      setBrandFacts: () => true,
    })
  const byId = (id: string) => targets().find((t) => t.id === id) as SetupTarget

  it('公司档案：币种按目标市场、一句话介绍从定位摘、客服邮箱只认搜到的官网域名下的', async () => {
    const t = byId('company.profile')
    const { kit, steps } = createResearchKit({
      profile: () =>
        brandFactsOf(
          { markets: ['GB'], positioning: '给通勤族的翻译眼镜。第二句不要。' },
          { domain: 'inmo.example' },
        ),
      search: async () => [
        {
          url: 'https://inmo.example/contact',
          title: 'Contact',
          snippet: 'mail support@inmo.example or sales@other.example',
        },
      ],
      ask: async () => '{"one_liner":"不该问到这里"}',
    })
    const plan = await t.research?.(kit)
    const fields = mergePlan(await t.fields(), plan ?? {})
    const by = (k: string) => fields.find((f) => f.key === k)
    expect(by('currency')).toMatchObject({ suggested: 'GBP', suggested_why: '目标市场是 GB' })
    expect(by('one_liner')).toMatchObject({
      suggested: '给通勤族的翻译眼镜。',
      sources: [{ kind: 'profile' }],
    })
    expect(by('support_email')).toMatchObject({
      suggested: 'support@inmo.example',
      sources: [{ kind: 'web', url: 'https://inmo.example/contact' }],
    })
    expect(steps().length).toBeGreaterThan(0)
  })

  it('公司地址：模型摘的地址要在网页原文里，核对不上就要你填', async () => {
    const t = byId('company.address')
    const hits = [
      {
        url: 'https://inmo.example/contact',
        snippet: 'Visit us at 88 Harbor Road, Shenzhen 518000.',
      },
    ]
    const run = async (answer: string) => {
      const { kit } = createResearchKit({
        profile: () => brandFactsOf({}, { domain: 'inmo.example' }),
        search: async () => hits,
        ask: async () => answer,
      })
      return mergePlan(await t.fields(), (await t.research?.(kit)) ?? {})[0]
    }
    expect(await run('{"address":"88 Harbor Road, Shenzhen 518000"}')).toMatchObject({
      suggested: '88 Harbor Road, Shenzhen 518000',
      sources: [{ kind: 'web' }, { kind: 'model' }],
    })
    const made = await run('{"address":"1 Invented Ave"}')
    expect(made?.suggested).toBeUndefined()
    expect(made?.needs_you).toBe(true)
  })
})

describe('stub 剧本（演示用）', () => {
  it('「先设好 Reddit 巡查」要方案卡；「把 Reddit 巡查的重点版块改成 …」带新值要卡', () => {
    const on = { tools: { allow: ['request_setup'] } } as never
    expect(setupRequestBranch(on, '先设好 Reddit 巡查，再每天看看')?.input).toMatchObject({
      setting: 'reddit.watch',
    })
    expect(
      setupRequestBranch(on, '把 Reddit 巡查的重点版块改成 UsbCHardware, anker（每周2次）')?.input,
    ).toMatchObject({
      setting: 'reddit.watch',
      suggestions: [{ key: 'watch_subreddits', value: 'UsbCHardware, anker（每周2次）' }],
    })
  })
})
