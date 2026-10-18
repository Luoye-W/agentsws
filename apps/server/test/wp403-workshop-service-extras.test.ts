/**
 * WP403（决策 1134）：工坊服务本机那一半的追加费用与订单附件——云端是契约替身（`ServiceOrdersStandIn`），
 * 卡用内存总线。
 *
 * 1. 追加：服务方发起 → 跟单时出一张下单卡（`stage: 'extra'`，同一条只出一张）→ 点「同意并支付」才扣进托管，
 *    本机账本记一条托管；钱不够 → 一分不扣、按同一个幂等键重出一张，充了再点只扣一次；点「先不要」= 不同意；
 *    服务方撤回 → 那张卡收起来；
 * 2. 附件：「等你补材料」时传一份 = 补上了（回到做中）；取回来一字不差；服务方的交付文件挂进交付物、取得到；
 *    太大的本机先拦；标准件不收补材料。
 */
import type { ApprovalBus, ApprovalItem, ServicePayCardPayload } from '@agentsws/contracts'
import { ServiceOrdersStandIn } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { createWorkshopServices } from '../src/workshop-services.js'

const T0 = Date.parse('2026-10-18T02:00:00.000Z')

type Out = ReturnType<ServiceOrdersStandIn['handle']>

function harness(balance = 2000) {
  let t = T0
  let seq = 0
  let left = balance
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
  const asCall = <T>(out: Out) => {
    if (out === undefined) return { ok: false, status: 404 }
    if (out.bytes !== undefined)
      return { ok: true, status: out.status, bytes: out.bytes, headers: out.headers ?? {} }
    const b = out.body as { data?: T; code?: string; message?: string; details?: unknown }
    return out.status < 300
      ? { ok: true, status: out.status, data: b.data as T }
      : {
          ok: false,
          status: out.status,
          ...(b.code === undefined ? {} : { code: b.code }),
          ...(b.message === undefined ? {} : { message: b.message }),
        }
  }
  const cloud = {
    linked: () => true,
    async call<T>(path: string, init: { method?: string; body?: unknown } = {}) {
      const u = new URL(`http://cloud${path}`)
      return asCall<T>(
        cloudSvc.handle(
          init.method ?? 'GET',
          u.pathname,
          u.searchParams,
          (init.body ?? {}) as Record<string, unknown>,
        ),
      )
    },
    async callBytes<T>(
      path: string,
      init: { method?: string; bytes?: Uint8Array; content_type?: string } = {},
    ) {
      const u = new URL(`http://cloud${path}`)
      return asCall<T>(
        cloudSvc.handle(
          init.method ?? 'GET',
          u.pathname,
          u.searchParams,
          {},
          init.bytes === undefined
            ? undefined
            : {
                bytes: init.bytes,
                ...(init.content_type === undefined ? {} : { contentType: init.content_type }),
              },
        ),
      )
    },
  }
  const cards: ApprovalItem[] = []
  const bus = {
    async create(input: Record<string, unknown>) {
      // 同一个去重键还在等的那张：原样回（与真总线同一个口径）
      const same = cards.find(
        (c) => c.dedupe_key === input.dedupe_key && (c.state === 'pending' || c.state === 'in_review'),
      )
      if (same !== undefined) return same
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
  const svc = createWorkshopServices({
    workspace_id: 'ws_1' as never,
    clock: { now },
    cloud: async () => cloud as never,
    approvals: () => bus,
    note: (_m, text) => notes.push(text),
    syncMs: 0,
    newKey: () => `key_${String(++seq)}`,
  })
  const actor = { person_id: 'p_1', role_id: 'site.shopify-theme', assignment_id: 'a_1' }
  const decide = async (card: ApprovalItem, action: 'approve' | 'reject') => {
    card.state = action === 'approve' ? 'approved' : 'rejected'
    card.decision = { action, by: 'p_1' as never, at: now(), via: 'workstation' } as never
    await svc.onDecided(card)
  }
  const extraCards = () =>
    cards.filter(
      (c) =>
        (c.payload as { form?: string; stage?: string }).form === 'service_pay' &&
        (c.payload as ServicePayCardPayload).stage === 'extra',
    )
  /** 定制件：需求单 → 报价 1000 → 同意并支付 → 接单。 */
  const customOrder = async () => {
    const drafted = await svc.draftCard(
      {
        service_id: 'workshop.site_build',
        answers: [
          { question_id: 'sell', answer: '电动自行车' },
          { question_id: 'market', answer: '美国' },
        ],
        matter_id: 'm1',
      },
      actor,
    )
    await decide(drafted.card, 'approve')
    const id = cloudSvc.list('all').orders[0]?.id as string
    cloudSvc.quote(id, { credits: 1000, deliver_hours: 240 })
    await svc.sync()
    const pay = [...cards].reverse().find((c) => (c.payload as { form?: string }).form === 'service_pay')
    await decide(pay as ApprovalItem, 'approve')
    cloudSvc.take(id)
    await svc.sync()
    return id
  }
  return {
    svc,
    cloudSvc,
    cards,
    notes,
    decide,
    extraCards,
    customOrder,
    left: () => left,
    topup: (n: number) => {
      left += n
    },
  }
}

describe('WP403 追加费用（本机）', () => {
  it('服务方发起 → 出一张追加卡（同一条只出一张）→ 点头才扣、账本记托管；再跟单不重出', async () => {
    const h = harness()
    const id = await h.customOrder()
    expect(h.left()).toBe(1000)
    h.cloudSvc.requestExtra(id, { credits: 300, reason: '会上定了加两页', deliver_hours: 48 })
    await h.svc.sync()
    await h.svc.sync()
    expect(h.extraCards()).toHaveLength(1)
    const card = h.extraCards()[0] as ApprovalItem
    const p = card.payload as ServicePayCardPayload
    expect(p).toMatchObject({ stage: 'extra', credits: 300, extra_reason: '会上定了加两页' })
    expect(p.extra_id).toBeDefined()
    expect(card.title).toContain('追加费用')
    expect(card.summary).toMatch(/追加 300 积分.*交付顺延约 2 天/u)
    expect(h.notes.some((n) => n.includes('想追加 300 积分'))).toBe(true)
    // 没点头之前一分没动
    expect(h.left()).toBe(1000)
    await h.decide(card, 'approve')
    expect(h.left()).toBe(700)
    const v = h.cloudSvc.get(id)
    expect(v.extras?.[0]?.status).toBe('accepted')
    expect(v.escrow_credits).toBe(1300)
    expect(h.notes.some((n) => n.includes('追加好了'))).toBe(true)
    // 同一张卡的决定又被投一次：不再扣
    await h.svc.onDecided(card)
    expect(h.left()).toBe(700)
    const detail = await h.svc.order(id)
    expect(detail.ledger.filter((l) => l.kind === 'escrow').map((l) => l.credits)).toEqual([
      1000, 300,
    ])
    await h.svc.sync()
    expect(h.extraCards()).toHaveLength(1)
  })

  it('钱不够：一分不扣、同一个幂等键重出一张；充了再点只扣一次', async () => {
    const h = harness(1100)
    const id = await h.customOrder()
    h.cloudSvc.requestExtra(id, { credits: 300, reason: '加两页' })
    await h.svc.sync()
    const first = h.extraCards()[0] as ApprovalItem
    await h.decide(first, 'approve')
    expect(h.left()).toBe(100)
    expect(h.cloudSvc.get(id).extras?.[0]?.status).toBe('pending')
    expect(h.notes.some((n) => n.includes('没办成（一分没扣）'))).toBe(true)
    const again = h.extraCards().at(-1) as ApprovalItem
    expect(again.id).not.toBe(first.id)
    expect((again.payload as ServicePayCardPayload).idempotency_key).toBe(
      (first.payload as ServicePayCardPayload).idempotency_key,
    )
    // 再跟单不另出第三张（重出的那张记在这一单上）
    await h.svc.sync()
    expect(h.extraCards()).toHaveLength(2)
    h.topup(500)
    await h.decide(again, 'approve')
    expect(h.left()).toBe(300)
    expect(h.cloudSvc.get(id).escrow_credits).toBe(1300)
  })

  it('点「先不要」= 不同意，一分不扣；服务方撤回 / 订单结束：那张卡收起来', async () => {
    const h = harness()
    const id = await h.customOrder()
    h.cloudSvc.requestExtra(id, { credits: 100, reason: '加动画' })
    await h.svc.sync()
    await h.decide(h.extraCards()[0] as ApprovalItem, 'reject')
    expect(h.cloudSvc.get(id).extras?.[0]?.status).toBe('declined')
    expect(h.left()).toBe(1000)
    expect(h.notes.some((n) => n.includes('没同意追加'))).toBe(true)

    h.cloudSvc.requestExtra(id, { credits: 50, reason: '加一页' })
    await h.svc.sync()
    const pending = h.extraCards().at(-1) as ApprovalItem
    expect(pending.state).toBe('pending')
    h.cloudSvc.expire(id)
    await h.svc.sync()
    expect(h.cloudSvc.get(id).extras?.[1]?.status).toBe('withdrawn')
    expect(pending.state).toBe('expired')
  })
})

describe('WP403 订单附件（本机）', () => {
  it('「等你补材料」时传一份 = 补上了；取回来一字不差；服务方的交付文件挂进交付物', async () => {
    const h = harness()
    const id = await h.customOrder()
    h.cloudSvc.askUser(id, '上传 Logo 原图')
    await h.svc.sync()
    const att = await h.svc.uploadAttachment(id, {
      name: 'logo.svg',
      content_type: 'image/svg+xml',
      bytes: new TextEncoder().encode('<svg/>'),
    })
    expect(att).toMatchObject({ name: 'logo.svg', from: 'user', purpose: 'material', size: 6 })
    expect(h.cloudSvc.get(id).status).toBe('in_progress')
    const got = await h.svc.attachment(id, att.id)
    expect(new TextDecoder().decode(got.bytes)).toBe('<svg/>')
    expect(got).toMatchObject({ name: 'logo.svg', content_type: 'image/svg+xml' })
    const detail = await h.svc.order(id)
    expect(detail.order.attachments?.map((a) => a.id)).toEqual([att.id])
    expect(detail.ledger.some((l) => l.text.includes('你传了文件「logo.svg」'))).toBe(true)

    const file = h.cloudSvc.attach(id, {
      name: '需求确认书.pdf',
      content_type: 'application/pdf',
      bytes: new TextEncoder().encode('%PDF'),
      from: 'provider',
    })
    h.cloudSvc.deliver(id, { attachment_ids: [file.id] })
    await h.svc.sync()
    const view = h.cloudSvc.get(id)
    expect(view.deliverables.at(-1)).toMatchObject({ type: 'file', attachment_id: file.id })
    const pdf = await h.svc.attachment(id, file.id)
    expect(new TextDecoder().decode(pdf.bytes)).toBe('%PDF')
    await expect(h.svc.attachment(id, 'att_nope')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('太大的本机先拦（不打云）；空文件不收；标准件不收补材料', async () => {
    const h = harness()
    const id = await h.customOrder()
    await expect(
      h.svc.uploadAttachment(id, { name: 'big.bin', bytes: new Uint8Array(25 * 1024 * 1024 + 1) }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(
      h.svc.uploadAttachment(id, { name: 'empty.txt', bytes: new Uint8Array() }),
    ).rejects.toMatchObject({ code: 'invalid_input' })
    const menu = await h.svc.draftCard(
      {
        service_id: 'demo.google_account',
        lines: [{ item_id: 'account', quantity: 1 }],
        matter_id: 'm2',
      },
      { person_id: 'p_1', role_id: 'web-ops' },
    )
    await h.decide(menu.card, 'approve')
    const std = h.cloudSvc.list('all').orders.find((o) => o.kind === 'standard')?.id as string
    await expect(
      h.svc.uploadAttachment(std, { name: 'a.txt', bytes: new TextEncoder().encode('a') }),
    ).rejects.toMatchObject({ code: 'conflict' })
  })
})
