/**
 * WP403（决策 1134）端到端：真装配线（本机路由 → 工坊服务 → `cloud.ts` 的字节那一跳 → demo 云替身）——
 * 订单面板传一份补材料（multipart）= 补上了、取回来一字不差；服务方发起追加 → 跟单出追加卡 → HTTP 批卡 →
 * 云上替身扣进托管。一行网都不出、不花一分真钱。
 */
import type { ApprovalItem, ServicePayCardPayload } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_STAND_IN_PASSWORD, CLOUD_STAND_IN_REGISTERED_EMAIL } from '../src/cloud-stand-in.js'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server
let cloud: CloudStandIn
let site: { id: string }

const call = async (method: string, path: string, body?: unknown, assignment?: string) => {
  const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
  headers.set('X-Assignment', assignment ?? site.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined)
    throw new Error(`没有 data：${res.status} ${parsed.code} ${parsed.message}`)
  return parsed.data as T
}
const waitFor = async (fn: () => Promise<boolean>, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到：${what}`)
}

beforeEach(async () => {
  cloud = cloudStandIn({ autoLinkAfterMs: -1, services: { extra_credits: 5000 } })
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date().toISOString() },
    random: () => 0.42,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    liveDataIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      [SECRETS_KEY_ENV]: 'a'.repeat(64),
      AGENTSWS_CLOUD_BASE_URL: CLOUD_STAND_IN_BASE_URL,
      AGENTSWS_WORKSHOP_SERVICES_SYNC_MS: '0',
    },
    cloudFetch: (input, init) => cloud.fetch(input, init),
  })
  const ws = server.bootstrap.workspace.id
  site = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    role_id: 'site.shopify-theme',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: ws }],
  })
  await dataOf(
    await call(
      'POST',
      '/v1/cloud/account/password-login',
      { email: CLOUD_STAND_IN_REGISTERED_EMAIL, password: CLOUD_STAND_IN_PASSWORD },
      server.bootstrap.ownerAssignment.id,
    ),
  )
})

afterEach(async () => {
  await server.close()
})

describe('WP403 工坊服务追加费用与订单附件端到端', () => {
  it('补材料传上去 = 补上了、取回来一字不差；追加卡 HTTP 批了才扣进托管', async () => {
    const created = cloud.services.submit({
      service_id: 'workshop.site_build',
      requirements: [
        { question_id: 'sell', answer: '电动自行车' },
        { question_id: 'market', answer: '美国' },
      ],
      idempotency_key: 'wp403-e2e',
    })
    const id = created.order.id
    cloud.services.quote(id, { credits: 1000, deliver_hours: 240 })
    cloud.services.acceptQuote(id)
    cloud.services.take(id)
    cloud.services.askUser(id, '上传 Logo 原图')
    const detail = await dataOf<{ order: { status: string } }>(
      await call('GET', `/v1/workshop-services/orders/${id}`),
    )
    expect(detail.order.status).toBe('waiting_user')

    // 订单面板传一份（multipart → 本机 → 云上替身，正文是文件字节）
    const form = new FormData()
    form.append('file', new File(['<svg/>'], 'logo 原图.svg', { type: 'image/svg+xml' }))
    const up = await server.gateway.fetch(
      new Request(`http://127.0.0.1/v1/workshop-services/orders/${id}/attachments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': site.id,
        },
        body: form,
      }),
    )
    expect(up.status).toBe(201)
    const att = await dataOf<{ id: string; name: string; from: string }>(up)
    expect(att).toMatchObject({ name: 'logo 原图.svg', from: 'user' })
    expect(cloud.services.get(id).status).toBe('in_progress')
    const got = await call('GET', `/v1/workshop-services/orders/${id}/attachments/${att.id}`)
    expect(got.status).toBe(200)
    expect(await got.text()).toBe('<svg/>')
    expect(got.headers.get('content-type')).toBe('image/svg+xml')
    expect(got.headers.get('content-disposition')).toContain('attachment;')
    expect(got.headers.get('x-content-type-options')).toBe('nosniff')

    // 服务方发起追加 → 跟单出追加卡（这一单不是本机下的：卡发给品牌的主人）→ HTTP 批了才扣
    const spentBefore = cloud.services.ledger().filter((r) => r.capability.endsWith('.escrow'))
    cloud.services.requestExtra(id, { credits: 200, reason: '会上定了加两页' })
    // 跟单（列我的订单时顺手看一遍云上）：这一单在等你的那张就是追加卡
    const open = await dataOf<{ orders: { order: { id: string }; card_id?: string }[] }>(
      await call('GET', '/v1/workshop-services/orders'),
    )
    const cardId = open.orders.find((o) => o.order.id === id)?.card_id as string
    const card = (await server.txn.approvals.get(
      cardId as never,
    )) as ApprovalItem<ServicePayCardPayload>
    expect(card.kind).toBe('service_order')
    expect(card.payload.stage).toBe('extra')
    expect(card.payload).toMatchObject({ credits: 200, extra_reason: '会上定了加两页' })
    expect(cloud.services.get(id).escrow_credits).toBe(1000)
    const decided = await call('POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
      via: 'workstation',
    })
    expect(decided.status).toBe(200)
    await waitFor(async () => cloud.services.get(id).escrow_credits === 1200, '追加进了托管')
    expect(cloud.services.get(id).extras?.[0]?.status).toBe('accepted')
    expect(cloud.services.ledger().filter((r) => r.capability.endsWith('.escrow')).length).toBe(
      spentBefore.length + 1,
    )
  })
})
