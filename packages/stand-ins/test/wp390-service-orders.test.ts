/**
 * WP390：云上「工坊服务」契约替身——两类服务各走一遍、幂等键只扣一次、按件退、分段结算、后台加一行。
 */
import { describe, expect, it } from 'vitest'
import { SAMPLE_SERVICES, ServiceOrdersStandIn } from '../src/cloud/service-orders.js'

function world(balance = 2000) {
  let left = balance
  let seq = 0
  let t = Date.parse('2026-10-18T02:00:00.000Z')
  const svc = new ServiceOrdersStandIn({
    now: () => new Date(t).toISOString(),
    newId: (p) => `${p}_${String(++seq)}`,
    available: () => left,
    spend: (c) => {
      left -= c
    },
    refund: (c) => {
      left += c
    },
  })
  return {
    svc,
    left: () => left,
    tick: (h: number) => {
      t += h * 3_600_000
    },
  }
}

const post = 'https://reddit.com/r/x/comments/1'

describe('WP390 工坊服务替身', () => {
  it('标准件：价目单两项 → 凭证交付 → 通过，没做完的按件退；同键只扣一次', () => {
    const w = world()
    const body = {
      service_id: 'demo.engagement',
      lines: [
        { item_id: 'like', quantity: 50, target: { post_url: post } },
        { item_id: 'comment', quantity: 10, target: { post_url: post } },
      ],
      idempotency_key: 'k1',
    }
    const first = w.svc.submit(body)
    const again = w.svc.submit(body)
    expect(first.created).toBe(true)
    expect(again.created).toBe(false)
    expect(again.order.id).toBe(first.order.id)
    expect(first.order.total_credits).toBe(105)
    expect(w.left()).toBe(1895)
    expect(first.order.message_count).toBe(0)
    const id = first.order.id
    w.svc.take(id)
    const delivered = w.svc.deliver(id, {
      proof: {
        links: [post],
        screenshots: [],
        completed: [
          { item_id: 'like', quantity: 50 },
          { item_id: 'comment', quantity: 8 },
        ],
      },
    })
    expect(delivered.status).toBe('delivered')
    expect(delivered.auto_accept_at).toBeDefined()
    expect(delivered.actions).toEqual(['accept', 'revise', 'dispute'])
    const done = w.svc.autoAccept(id)
    expect(done.status).toBe('completed')
    expect(done.settled_credits).toBe(89)
    expect(done.refunded_credits).toBe(16)
    expect(w.left()).toBe(1911)
    expect(w.svc.ledger().map((r) => r.capability)).toEqual([
      'workshop.service.escrow',
      'workshop.service.complete',
      'workshop.service.refund',
    ])
    expect(() => w.svc.postMessage(id, { text: 'hi' })).toThrow(/标准件没有消息串/)
  })

  it('定制件：需求单 → 报价（不扣钱）→ 同意报价扣进托管 → 等你补材料 → 联系方式 → 三段验收', () => {
    const w = world()
    const { order } = w.svc.submit({
      service_id: 'workshop.site_build',
      requirements: [
        { question_id: 'sell', answer: '电动自行车' },
        { question_id: 'market', answer: '美国' },
      ],
      idempotency_key: 'k2',
    })
    expect(order.status).toBe('quote_requested')
    expect(w.left()).toBe(2000)
    w.svc.quote(order.id, { credits: 1200, deliver_hours: 240 })
    const paid = w.svc.acceptQuote(order.id)
    const twice = w.svc.acceptQuote(order.id)
    expect(paid.status).toBe('paid')
    expect(twice.escrow_credits).toBe(1200)
    expect(w.left()).toBe(800)
    expect(paid.milestones?.map((m) => m.credits)).toEqual([240, 480, 480])
    w.svc.take(order.id)
    w.svc.askUser(order.id, '上传 Logo 原图')
    expect(w.svc.get(order.id).waiting_for).toBe('上传 Logo 原图')
    w.svc.postMessage(order.id, { text: '发你邮箱了' })
    expect(w.svc.get(order.id).status).toBe('in_progress')
    const ex = w.svc.requestContact(order.id, '约个时间过设计稿', {
      kind: 'wechat',
      value: 'ws-team',
    })
    const swapped = w.svc.contact(order.id, {
      request_id: ex.id,
      accept: true,
      contact: { kind: 'email', value: 'me@example.com' },
    })
    expect(swapped.contact?.provider_contact?.value).toBe('ws-team')
    for (const _ of [0, 1, 2]) {
      w.svc.deliver(order.id, { deliverables: [{ type: 'link', label: '预览' }] })
      w.svc.accept(order.id)
    }
    const done = w.svc.get(order.id)
    expect(done.status).toBe('completed')
    expect(done.settled_credits).toBe(1200)
    expect(done.contact?.provider_contact).toBeUndefined()
    expect(done.deliverables_expire_at).toBeDefined()
  })

  it('返工次数用完 409；申请退款判部分退，没开始的段全退', () => {
    const w = world()
    const { order } = w.svc.submit({
      service_id: 'workshop.site_build',
      requirements: [
        { question_id: 'sell', answer: 'a' },
        { question_id: 'market', answer: 'b' },
      ],
      idempotency_key: 'k3',
    })
    w.svc.quote(order.id, { credits: 1000, deliver_hours: 100 })
    w.svc.acceptQuote(order.id)
    w.svc.take(order.id)
    w.svc.deliver(order.id, {})
    w.svc.revise(order.id, { reason: '颜色不对' })
    w.svc.deliver(order.id, {})
    w.svc.revise(order.id, { reason: '还是不对' })
    w.svc.deliver(order.id, {})
    expect(() => w.svc.revise(order.id, {})).toThrow(/返工次数用完/)
    w.svc.dispute(order.id, { reason: '做得不好' })
    const r = w.svc.resolve(order.id, 'partial_refund', '第一段做了一半', 100)
    expect(r.status).toBe('refunded')
    expect(r.refunded_credits).toBe(900)
    expect(r.settled_credits).toBe(100)
    expect(r.dispute?.note).toBe('第一段做了一半')
  })

  it('积分不够 402 一分不扣；取消原路全退；后台加一行目录就有', () => {
    const w = world(10)
    const res = w.svc.handle('POST', '/v1/services/orders', new URLSearchParams(), {
      service_id: 'demo.google_account',
      lines: [{ item_id: 'account', quantity: 1 }],
      idempotency_key: 'k4',
    })
    expect(res?.status).toBe(402)
    expect(w.left()).toBe(10)
    const before = w.svc.catalog().services.length
    w.svc.addService({ ...(SAMPLE_SERVICES[1] as never), id: 'fake.new', label_zh: '假标准件' })
    expect(w.svc.catalog().services).toHaveLength(before + 1)
    const w2 = world()
    const { order } = w2.svc.submit({
      service_id: 'demo.google_account',
      lines: [{ item_id: 'account', quantity: 1 }],
      idempotency_key: 'k5',
    })
    expect(w2.left()).toBe(1970)
    expect(w2.svc.cancel(order.id).refunded_credits).toBe(30)
    expect(w2.left()).toBe(2000)
  })
})
