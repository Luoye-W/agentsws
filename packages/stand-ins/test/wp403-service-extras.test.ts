/**
 * WP403（决策 1134）：云上工坊服务契约替身的追加费用与订单附件——与私有仓真服务同一套口径：
 * 点头才扣（钱不够 402、这一条原样等着）、同一条只扣一次、不同意不扣、结束时没回的收起来；
 * 附件正文是字节、取回来一字不差、下载一律 octet-stream（原本的类型在 x-content-type）。
 */
import { SERVICE_LEDGER_CAPABILITIES } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { ServiceOrdersStandIn } from '../src/index.js'

function world(balance = 2000) {
  let seq = 0
  let left = balance
  const svc = new ServiceOrdersStandIn({
    now: () => '2026-10-18T02:00:00.000Z',
    newId: (p) => `${p}_${String(++seq)}`,
    available: () => left,
    spend: (c) => {
      left -= c
    },
    refund: (c) => {
      left += c
    },
  })
  const order = () => {
    const { order } = svc.submit({
      service_id: 'workshop.site_build',
      requirements: [
        { question_id: 'sell', answer: '电动自行车' },
        { question_id: 'market', answer: '美国' },
      ],
      idempotency_key: `k${String(++seq)}`,
    })
    svc.quote(order.id, { credits: 1000, deliver_hours: 240 })
    svc.acceptQuote(order.id)
    svc.take(order.id)
    return order.id
  }
  const http = (
    method: string,
    path: string,
    body: Record<string, unknown> = {},
    raw?: Uint8Array,
  ) => {
    const u = new URL(`http://cloud${path}`)
    return svc.handle(
      method,
      u.pathname,
      u.searchParams,
      body,
      raw === undefined ? undefined : { bytes: raw, contentType: 'text/plain' },
    )
  }
  return { svc, order, http, left: () => left, topup: (n: number) => (left += n) }
}

describe('WP403 替身：追加费用', () => {
  it('点头才扣；钱不够 402 原样等着；同一条只扣一次；不同意不扣；结束时没回的收起来', async () => {
    const w = world(1100)
    const id = w.order()
    const extra = w.svc.requestExtra(id, { credits: 300, reason: '加两页', deliver_hours: 48 })
    expect(() => w.svc.requestExtra(id, { credits: 1, reason: 'x' })).toThrow()
    const answer = { extra_id: extra.id, accept: true, idempotency_key: 'x' }
    const poor = w.http('POST', `/v1/services/orders/${id}/extra`, answer)
    expect(poor?.status).toBe(402)
    expect(w.svc.get(id).extras?.[0]?.status).toBe('pending')
    expect(w.left()).toBe(100)
    w.topup(500)
    expect(w.http('POST', `/v1/services/orders/${id}/extra`, answer)?.status).toBe(200)
    expect(w.http('POST', `/v1/services/orders/${id}/extra`, answer)?.status).toBe(200)
    expect(w.left()).toBe(300)
    const v = w.svc.get(id)
    expect(v).toMatchObject({ total_credits: 1300, escrow_credits: 1300 })
    expect(v.milestones?.[0]?.credits).toBe(500)
    const escrows = w.svc
      .ledger()
      .filter((r) => r.capability === SERVICE_LEDGER_CAPABILITIES.escrow)
      .map((r) => r.credits)
    expect(escrows).toEqual([1000, 300])

    const second = w.svc.requestExtra(id, { credits: 50, reason: '加动画' })
    w.http('POST', `/v1/services/orders/${id}/extra`, {
      extra_id: second.id,
      accept: false,
      idempotency_key: 'y',
    })
    expect(w.svc.get(id).extras?.[1]?.status).toBe('declined')
    expect(w.left()).toBe(300)

    w.svc.requestExtra(id, { credits: 10, reason: '再加' })
    w.svc.expire(id)
    expect(w.svc.get(id).extras?.map((e) => e.status)).toEqual([
      'accepted',
      'declined',
      'withdrawn',
    ])
  })
})

describe('WP403 替身：订单附件', () => {
  it('补材料：正文是字节；「等你补材料」时传 = 补上了；下载 octet-stream、原本的类型在头里', async () => {
    const w = world()
    const id = w.order()
    w.svc.askUser(id, '上传 Logo 原图')
    const up = w.http(
      'POST',
      `/v1/services/orders/${id}/attachments?name=${encodeURIComponent('品牌说明.txt')}`,
      {},
      new TextEncoder().encode('品牌说明'),
    )
    expect(up?.status).toBe(201)
    const att = (up?.body as { data: { id: string; name: string; sha256: string } } | undefined)
      ?.data as { id: string; name: string; sha256: string }
    expect(att.name).toBe('品牌说明.txt')
    expect(w.svc.get(id).status).toBe('in_progress')
    const got = w.http('GET', `/v1/services/orders/${id}/attachments/${att.id}`)
    expect(new TextDecoder().decode(got?.bytes ?? new Uint8Array())).toBe('品牌说明')
    expect(got?.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'x-content-type': 'text/plain',
      'x-content-sha256': att.sha256,
    })
    expect(w.http('GET', `/v1/services/orders/${id}/attachments/att_nope`)?.status).toBe(404)
  })

  it('服务方的交付文件：交付时按附件号挂进交付物；结束后标上到期日', async () => {
    const w = world()
    const id = w.order()
    const f = w.svc.attach(id, {
      name: '需求确认书.pdf',
      bytes: new TextEncoder().encode('%PDF'),
      from: 'provider',
    })
    expect(f).toMatchObject({ purpose: 'delivery', milestone_id: 'brief' })
    expect(() => w.svc.deliver(id, { attachment_ids: ['att_nope'] })).toThrow()
    const v = w.svc.deliver(id, { attachment_ids: [f.id] })
    expect(v.deliverables.at(-1)).toMatchObject({ type: 'file', attachment_id: f.id })
    w.svc.accept(id)
    w.svc.expire(id)
    expect(w.svc.get(id).attachments?.[0]?.expires_at).toBeDefined()
    w.svc.purgeFiles(id)
    expect(w.svc.get(id).attachments?.[0]?.expired).toBe(true)
    expect(w.http('GET', `/v1/services/orders/${id}/attachments/${f.id}`)?.status).toBe(404)
  })
})
