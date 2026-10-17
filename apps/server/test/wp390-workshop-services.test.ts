/**
 * WP390（docs/105 §4 / §5 / §9 一期 A）：工坊服务本机那一半——云端全用替身（`ServiceOrdersStandIn`），卡用内存总线。
 *
 * 1. 推荐分寸（§9 ⑤）：同一对话只推一次、说「不用」后 30 天不推（记进记忆）、定时任务里不推；没接住的意向只上报说法 + 岗位；
 * 2. 标准件：价目单 → 下单（托管）→ 凭证交付 → 验收卡 → 通过，没做完的按件退；本机账本各记一条；
 * 3. 定制件：需求单 → 报价 → 下单卡（同意并支付）→ 等你补材料 → 交换联系方式卡 → 三段验收 → 落主题；
 * 4. 同一张卡点两次只下一单；失败一分不扣、按同一个幂等键重出一张；老令牌缺 `services` → 引导重新登录；
 * 5. 后台加一项假标准件 / 假定制件，本机不改代码就进推荐、岗位页、服务列表；卡点（「交给工坊办」）对得上。
 */
import type {
  ApprovalBus,
  ApprovalItem,
  ServiceAcceptanceCardPayload,
  ServiceMenuCardPayload,
  ServicePayCardPayload,
  ServiceRequirementsCardPayload,
  ServiceView,
} from '@agentsws/contracts'
import { SAMPLE_SERVICES, ServiceOrdersStandIn } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import {
  createWorkshopServices,
  SERVICE_REFUSAL,
  type WorkshopLandings,
} from '../src/workshop-services.js'

const T0 = Date.parse('2026-10-18T02:00:00.000Z')

function harness(opts: { balance?: number; landings?: WorkshopLandings } = {}) {
  let t = T0
  let seq = 0
  let left = opts.balance ?? 2000
  let linked = true
  let scopeMissing = false
  const now = () => new Date(t).toISOString()
  const cloudSvc = new ServiceOrdersStandIn({
    now,
    newId: (p) => `${p}_${String(++seq)}`,
    available: () => left,
    spend: (c) => {
      left -= c
    },
    refund: (c) => {
      left += c
    },
  })
  const hits: string[] = []
  const cloud = {
    linked: () => linked,
    async call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      hits.push(`${init.method ?? 'GET'} ${path}`)
      if (scopeMissing)
        return {
          ok: false,
          status: 403,
          code: 'forbidden',
          message: '令牌没有这条路由要的动作',
          details: { required_scope: 'services' },
        }
      const u = new URL(`http://cloud${path}`)
      const out = cloudSvc.handle(
        init.method ?? 'GET',
        u.pathname,
        u.searchParams,
        (init.body ?? {}) as Record<string, unknown>,
      )
      if (out === undefined) return { ok: false, status: 404 }
      const b = out.body as {
        data?: T
        code?: string
        message?: string
        details?: Record<string, unknown>
      }
      return out.status < 300
        ? { ok: true, status: out.status, data: b.data as T }
        : {
            ok: false,
            status: out.status,
            ...(b.code === undefined ? {} : { code: b.code }),
            ...(b.message === undefined ? {} : { message: b.message }),
            ...(b.details === undefined ? {} : { details: b.details }),
          }
    },
  }
  const cards: ApprovalItem[] = []
  const bus = {
    async create(input: Record<string, unknown>) {
      const item = {
        ...input,
        id: `card_${String(cards.length + 1)}`,
        state: 'pending',
        revision: 1,
        links: { children: [] },
        deliveries: [],
        created_at: now(),
        updated_at: now(),
      } as unknown as ApprovalItem
      cards.push(item)
      return item
    },
    async get(id: string) {
      return cards.find((c) => c.id === id)
    },
    async expireNow(id: string) {
      const c = cards.find((x) => x.id === id)
      if (c !== undefined) c.state = 'expired'
      return c
    },
  } as unknown as ApprovalBus
  const notes: string[] = []
  const memory: string[] = []
  const svc = createWorkshopServices({
    workspace_id: 'ws_1' as never,
    clock: { now },
    cloud: async () => cloud as never,
    approvals: () => bus,
    note: (_m, text) => notes.push(text),
    remember: async (text) => {
      memory.push(text)
    },
    syncMs: 0,
    newKey: () => `key_${String(++seq)}`,
    ...(opts.landings === undefined ? {} : { landings: opts.landings }),
  })
  const actor = {
    person_id: 'p_1',
    role_id: 'site.shopify-theme',
    assignment_id: 'a_1',
    position_id: 'site',
  }
  /** 人在卡上点了（批 / 不要），服务端照决定去做。 */
  const decide = async (
    card: ApprovalItem,
    action: 'approve' | 'reject',
    extra: { edited?: unknown; option?: string; reason?: string; by?: string } = {},
  ) => {
    card.state = action === 'approve' ? 'approved' : 'rejected'
    card.decision = {
      action,
      by: (extra.by ?? 'p_1') as never,
      at: now(),
      via: 'workstation',
      ...(extra.edited === undefined ? {} : { edited_payload: extra.edited }),
      ...(extra.option === undefined ? {} : { selected_option_id: extra.option }),
      ...(extra.reason === undefined ? {} : { reason: extra.reason }),
    }
    await svc.onDecided(card)
  }
  const lastCard = (form: string) =>
    [...cards].reverse().find((c) => (c.payload as { form?: string }).form === form) as ApprovalItem
  return {
    svc,
    cloudSvc,
    cards,
    notes,
    memory,
    hits,
    actor,
    decide,
    lastCard,
    left: () => left,
    tick: (hours: number) => {
      t += hours * 3_600_000
    },
    unlink: () => {
      linked = false
    },
    denyScope: (on: boolean) => {
      scopeMissing = on
    },
  }
}

describe('WP390 推荐的分寸（§9 ⑤）', () => {
  it('同一对话只推一次；另一段对话照推；自营排第一', async () => {
    const h = harness()
    const first = await h.svc.offerFor({
      conversation: 'm1',
      text: '我想找人建站',
      background: false,
    })
    expect(first).toMatchObject({
      service_id: 'workshop.site_build',
      provider_label: 'workshop_team',
    })
    expect(first?.from_credits).toBe(800)
    expect(
      await h.svc.offerFor({ conversation: 'm1', text: '还是想找人建站', background: false }),
    ).toBeUndefined()
    expect(
      (await h.svc.offerFor({ conversation: 'm2', text: '网站想改版', background: false }))
        ?.service_id,
    ).toBe('workshop.site_build')
  })

  it('定时任务 / 后台巡查里不推', async () => {
    const h = harness()
    expect(
      await h.svc.offerFor({ conversation: 'm1', text: '我想找人建站', background: true }),
    ).toBeUndefined()
  })

  it('说「不用」：这一项 30 天不推（记进记忆），过了 30 天又推', async () => {
    const h = harness()
    expect(SERVICE_REFUSAL.test('不用了，谢谢')).toBe(true)
    expect(SERVICE_REFUSAL.test('不用急，先帮我看看首页怎么改比较好')).toBe(false)
    const out = await h.svc.decline('workshop.site_build', h.actor)
    expect(h.memory[0]).toMatch(/工坊建站.*先不用/)
    expect(Date.parse(out.until) - T0).toBeGreaterThanOrEqual(30 * 86_400_000)
    expect(
      await h.svc.offerFor({ conversation: 'm3', text: '我想找人建站', background: false }),
    ).toBeUndefined()
    h.tick(31 * 24)
    expect(
      (await h.svc.offerFor({ conversation: 'm3', text: '我想找人建站', background: false }))
        ?.service_id,
    ).toBe('workshop.site_build')
  })

  it('没接住的意向只上报说法 + 岗位（不收正文）', async () => {
    const h = harness()
    expect(await h.svc.find('想找人拍产品视频')).toEqual([])
    await h.svc.reportIntent('想找人拍产品视频', 'design')
    expect(h.cloudSvc.intents()).toEqual([{ phrase: '想找人拍产品视频', position_id: 'design' }])
  })
})

describe('WP390 标准件：价目单 → 托管 → 凭证 → 验收', () => {
  it('价目单勾两项下单；点两次只一单一笔；凭证交付 → 验收卡 → 通过，没做完的按件退；账本各一条', async () => {
    const h = harness()
    const started = await h.svc.start({ service_id: 'demo.engagement', matter_id: 'm1' }, h.actor)
    expect(started.next).toBe('card')
    const menu = h.lastCard('service_menu')
    expect(menu.kind).toBe('service_order')
    expect(menu.automation.level_at_creation).toBe('L1')
    const p = menu.payload as ServiceMenuCardPayload
    const lines = [
      { item_id: 'like', quantity: 50, target: { post_url: 'https://reddit.com/r/x/1' } },
      { item_id: 'comment', quantity: 10, target: { post_url: 'https://reddit.com/r/x/1' } },
    ]
    await h.decide(menu, 'approve', { edited: { ...p, lines } })
    // 同一张卡又被处理一次（双击 / 重投）：同一个幂等键，云上只一单、只扣一次
    await h.svc.onDecided(menu)
    expect(h.left()).toBe(1895)
    expect(h.cloudSvc.list('all').orders).toHaveLength(1)
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    expect(h.notes.some((n) => n.includes('托管 105 积分'))).toBe(true)

    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, {
      proof: {
        links: ['https://reddit.com/r/x/1'],
        screenshots: [],
        completed: [
          { item_id: 'like', quantity: 50 },
          { item_id: 'comment', quantity: 8 },
        ],
      },
    })
    await h.svc.sync()
    const acc = h.lastCard('service_acceptance')
    const ap = acc.payload as ServiceAcceptanceCardPayload
    expect(ap.proof?.completed).toHaveLength(2)
    expect(ap.auto_accept_at).toBeDefined()
    expect(acc.options?.map((o) => o.id)).toEqual(['accept', 'revise', 'dispute'])
    await h.decide(acc, 'approve', { option: 'accept' })
    const done = h.cloudSvc.get(id)
    expect(done.status).toBe('completed')
    expect(done.refunded_credits).toBe(16)
    expect(h.left()).toBe(1911)
    const kinds = h.svc.ledger(id).map((l) => l.kind)
    for (const k of ['order', 'escrow', 'delivery', 'acceptance', 'settle', 'refund'])
      expect(kinds).toContain(k)
    expect(h.svc.ledger(id).filter((l) => l.kind === 'escrow')).toHaveLength(1)
  })

  it('到期自动通过：在等的验收卡收起来，不再让人点', async () => {
    const h = harness()
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    const menu = h.lastCard('service_menu')
    await h.decide(menu, 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, { proof: { links: [], screenshots: [], completed: [] } })
    await h.svc.sync()
    const acc = h.lastCard('service_acceptance')
    expect(acc.state).toBe('pending')
    h.cloudSvc.autoAccept(id)
    await h.svc.sync()
    expect(acc.state).toBe('expired')
    expect(h.notes.at(-1)).toMatch(/完成了/)
  })

  it('积分不够：一分不扣，事项里照实说、按同一个键重出一张价目单', async () => {
    const h = harness({ balance: 10 })
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    const menu = h.lastCard('service_menu')
    await h.decide(menu, 'approve')
    expect(h.left()).toBe(10)
    expect(h.cloudSvc.list('all').orders).toHaveLength(0)
    expect(h.notes.at(-1)).toMatch(/一分没扣.*积分不够/)
    const again = h.lastCard('service_menu')
    expect(again.id).not.toBe(menu.id)
    expect((again.payload as ServiceMenuCardPayload).idempotency_key).toBe(
      (menu.payload as ServiceMenuCardPayload).idempotency_key,
    )
  })

  it('不是人点的（额度内自动批）一律不下单', async () => {
    const h = harness()
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    await h.decide(h.lastCard('service_menu'), 'approve', { by: 'mandate' })
    expect(h.cloudSvc.list('all').orders).toHaveLength(0)
  })
})

describe('WP390 定制件：需求单 → 报价 → 同意并支付 → 补材料 → 联系方式 → 分段验收 → 落主题', () => {
  it('一路走通', async () => {
    const landed: string[] = []
    const h = harness({
      landings: {
        theme: async ({ theme_id }) => {
          landed.push(theme_id)
          return '出了一张卡：将把主题设为线上主题。'
        },
      },
    })
    const drafted = await h.svc.draftCard(
      {
        service_id: 'workshop.site_build',
        answers: [
          { question_id: 'sell', answer: '电动自行车' },
          { question_id: 'market', answer: '美国' },
          { question_id: 'nope', answer: '多给的丢掉' },
        ],
        matter_id: 'm1',
      },
      h.actor,
    )
    expect(drafted.form).toBe('service_requirements')
    const req = drafted.card
    expect((req.payload as ServiceRequirementsCardPayload).answers).toHaveLength(2)
    await h.decide(req, 'approve')
    expect(h.left()).toBe(2000)
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    expect(h.cloudSvc.get(id).status).toBe('quote_requested')

    h.cloudSvc.quote(id, { credits: 1200, deliver_hours: 240, note: '三页 + 博客' })
    await h.svc.sync()
    const pay = h.lastCard('service_pay')
    expect((pay.payload as ServicePayCardPayload).stage).toBe('accept_quote')
    expect(pay.summary).toMatch(/1,200 积分.*可改 2 次.*7 天不点自动通过/)
    await h.decide(pay, 'approve')
    expect(h.left()).toBe(800)

    h.cloudSvc.take(id)
    h.cloudSvc.askUser(id, '上传 Logo 原图')
    await h.svc.sync()
    expect(h.notes.some((n) => n.includes('在等你：上传 Logo 原图'))).toBe(true)
    await h.svc.postMessage(id, '发你邮箱了')
    expect(h.cloudSvc.get(id).status).toBe('in_progress')

    h.cloudSvc.say(id, '首页要不要放视频？')
    h.cloudSvc.requestContact(id, '约个时间过一下设计稿', { kind: 'wechat', value: 'ws-team' })
    await h.svc.sync()
    expect(h.notes.some((n) => n.includes('首页要不要放视频'))).toBe(true)
    const contact = h.lastCard('service_contact')
    await h.decide(contact, 'approve', {
      edited: {
        ...(contact.payload as object),
        contact: { kind: 'email', value: 'me@example.com' },
      },
    })
    expect(h.cloudSvc.get(id).contact?.status).toBe('accepted')

    for (const ms of ['brief', 'design', 'launch']) {
      h.cloudSvc.deliver(id, {
        deliverables:
          ms === 'launch'
            ? [
                {
                  type: 'platform_object',
                  label: '新主题（未发布）',
                  ref: '123456',
                  url: 'https://x.myshopify.com/?preview_theme_id=123456',
                },
              ]
            : [{ type: 'link', label: `${ms} 稿` }],
      })
      await h.svc.sync()
      const acc = h.lastCard('service_acceptance')
      expect((acc.payload as ServiceAcceptanceCardPayload).milestone_id).toBe(ms)
      await h.decide(acc, 'approve', { option: 'accept' })
    }
    const done = h.cloudSvc.get(id)
    expect(done.status).toBe('completed')
    expect(done.settled_credits).toBe(1200)
    expect(landed).toEqual(['123456'])
    expect(h.notes.some((n) => n.includes('将把主题设为线上主题'))).toBe(true)
    // 每条沟通各记一条
    expect(h.svc.ledger(id).filter((l) => l.kind === 'message').length).toBeGreaterThanOrEqual(3)
  })

  it('要改 / 申请退款：理由带上去；申请退款没写理由不交', async () => {
    const h = harness()
    const { card } = await h.svc.draftCard(
      {
        service_id: 'workshop.site_build',
        answers: [
          { question_id: 'sell', answer: 'a' },
          { question_id: 'market', answer: 'b' },
        ],
        matter_id: 'm1',
      },
      h.actor,
    )
    await h.decide(card, 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.quote(id, { credits: 1000, deliver_hours: 100 })
    await h.svc.sync()
    await h.decide(h.lastCard('service_pay'), 'approve')
    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, {})
    await h.svc.sync()
    await h.decide(h.lastCard('service_acceptance'), 'approve', {
      option: 'revise',
      edited: { reason: '颜色不对' },
    })
    expect(h.cloudSvc.get(id).revisions_left).toBe(1)
    h.cloudSvc.deliver(id, {})
    await h.svc.sync()
    await h.decide(h.lastCard('service_acceptance'), 'approve', { option: 'dispute' })
    expect(h.cloudSvc.get(id).status).toBe('delivered')
    expect(h.notes.at(-1)).toMatch(/申请退款要写一句为什么/)
  })

  it('报价不同意：取消，一分不扣', async () => {
    const h = harness()
    const { card } = await h.svc.draftCard(
      {
        service_id: 'workshop.site_build',
        answers: [
          { question_id: 'sell', answer: 'a' },
          { question_id: 'market', answer: 'b' },
        ],
      },
      h.actor,
    )
    await h.decide(card, 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.quote(id, { credits: 1000, deliver_hours: 100 })
    await h.svc.sync()
    await h.decide(h.lastCard('service_pay'), 'reject')
    expect(h.cloudSvc.get(id).status).toBe('cancelled')
    expect(h.left()).toBe(2000)
  })
})

describe('WP390 目录、卡点、重新登录', () => {
  it('后台加一项假标准件 / 假定制件：不改代码就进推荐、岗位页、服务列表；标准件出价目单、定制件出需求问答', async () => {
    const h = harness()
    const fakeStd: ServiceView = {
      ...(SAMPLE_SERVICES[1] as ServiceView),
      id: 'fake.reviews',
      label_zh: '假标准件：评论代写',
      intents: ['想要更多评论', '评论太少'],
      positions: ['pr'],
    }
    const fakeCustom: ServiceView = {
      ...(SAMPLE_SERVICES[0] as ServiceView),
      id: 'fake.pr_plan',
      label_zh: '假定制件：公关方案',
      provider_label: 'partner_team',
      intents: ['想找人做公关方案'],
      positions: ['pr'],
      blockers: ['connect:media'],
    }
    h.cloudSvc.addService(fakeStd)
    h.cloudSvc.addService(fakeCustom)
    const list = await h.svc.catalog(true)
    expect(list.services.map((s) => s.id)).toEqual(
      expect.arrayContaining(['fake.reviews', 'fake.pr_plan']),
    )
    expect(
      (await h.svc.offerFor({ conversation: 'x', text: '评论太少了怎么办', background: false }))
        ?.service_id,
    ).toBe('fake.reviews')
    expect((await h.svc.find('想找人做公关方案', 'pr'))[0]?.service.id).toBe('fake.pr_plan')
    expect((await h.svc.blockerOffer({ key: 'connect:media' }))?.service_id).toBe('fake.pr_plan')
    const std = await h.svc.start({ service_id: 'fake.reviews' }, h.actor)
    expect(h.cards.find((c) => c.id === std.card_id)?.payload).toMatchObject({
      form: 'service_menu',
    })
    const custom = await h.svc.start({ service_id: 'fake.pr_plan' }, h.actor)
    // 没接 AI 问答（没有事项）：出一张空的需求单，问题都在卡上
    expect(h.cards.find((c) => c.id === custom.card_id)?.payload).toMatchObject({
      form: 'service_requirements',
    })
  })

  it('交给工坊办：带回卡点那一步；回执做成了 → 回到那一步接着做', async () => {
    const resumed: string[] = []
    const h = harness({
      landings: {
        resume: async ({ resume, blocker }) => {
          resumed.push(`${resume.matter_id}|${blocker}`)
        },
      },
    })
    const bus = { card: undefined as ApprovalItem | undefined }
    // 一张「缺 Google 连接」的连接卡（卡点）
    bus.card = {
      id: 'setup_1',
      payload: {
        form: 'connect_request',
        why: 'x',
        needs: [{ kind: 'google', service: 'google', name: 'Google', required: true }],
        resume: { matter_id: 'm9', person_id: 'p_1', assignment_id: 'a_1' },
      },
    } as never
    h.cards.push(bus.card as ApprovalItem)
    expect((await h.svc.blockerOffer({ key: 'connect:google' }))?.service_id).toBe(
      'demo.google_account',
    )
    await h.svc.start({ service_id: 'demo.google_account', from_card: 'setup_1' }, h.actor)
    const menu = h.lastCard('service_menu')
    expect(menu.payload).toMatchObject({ blocker: 'connect:google', matter_id: 'm9' })
    await h.decide(menu, 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, { deliverables: [{ type: 'receipt', label: '开好了' }] })
    await h.svc.sync()
    await h.decide(h.lastCard('service_acceptance'), 'approve', { option: 'accept' })
    expect(resumed).toEqual(['m9|connect:google'])
  })

  it('老令牌缺 services（自动补签也没成）：目录照实说要重新登录；下单失败一分不扣', async () => {
    const h = harness()
    h.denyScope(true)
    const view = await h.svc.catalog(true)
    expect(view.reauth).toBe(true)
    expect(view.notice).toMatch(/重新登录/)
    h.denyScope(false)
    await h.svc.catalog(true)
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    h.denyScope(true)
    await h.decide(h.lastCard('service_menu'), 'approve')
    expect(h.notes.at(-1)).toMatch(/一分没扣.*重新登录/)
    expect(h.left()).toBe(2000)
  })

  it('交付物快到期（P10）：提醒一次', async () => {
    const h = harness()
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    await h.decide(h.lastCard('service_menu'), 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, { deliverables: [{ type: 'receipt', label: '开好了' }] })
    h.cloudSvc.autoAccept(id)
    await h.svc.sync()
    h.tick(85 * 24)
    await h.svc.sync()
    await h.svc.sync()
    expect(h.notes.filter((n) => n.includes('到期删除'))).toHaveLength(1)
    const rows = await h.svc.orders('all')
    expect(rows.orders[0]?.expiring).toBe(true)
  })

  it('没关联账号：目录空 + 一句人话，不打云', async () => {
    const h = harness()
    h.unlink()
    const view = await h.svc.catalog(true)
    expect(view.linked).toBe(false)
    expect(view.notice).toMatch(/关联/)
    expect(h.hits).toEqual([])
  })

  it('岗位页「在做」：服务订单和事项排在一起（带等你的卡）', async () => {
    const h = harness()
    await h.svc.start({ service_id: 'demo.google_account', matter_id: 'm1' }, h.actor)
    await h.decide(h.lastCard('service_menu'), 'approve')
    const id = h.cloudSvc.list('all').orders[0]?.id as string
    h.cloudSvc.take(id)
    h.cloudSvc.deliver(id, {})
    await h.svc.sync()
    const items = h.svc.workItems('site')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'service_order', ref_id: id, group: 'doing', cards: 1 })
    expect(h.svc.workItems('pr')).toEqual([])
  })
})
