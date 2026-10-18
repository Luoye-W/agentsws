/**
 * WP390（docs/105 §9 一期 A）端到端：真装配线（本机路由 → 运行时（stub）→ `find_service` → 推荐卡挂在回答末尾 →
 * 「看看」→ 价目单卡 → HTTP 决定 → 决定钩子 → 云上替身下单扣进托管 → 服务方交付 → 跟单出验收卡 → 通过 → 订单面板）。
 * 云端是 demo 那个替身（`cloud-stand-in.ts` 的 `/v1/services*`），一行网都不出、不花一分真钱。
 */
import type { ApprovalItem, MatterEvent, ServiceMenuCardPayload } from '@agentsws/contracts'
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
const timeline = async (matter: string): Promise<MatterEvent[]> =>
  (await dataOf<{ timeline: MatterEvent[] }>(await call('GET', `/v1/matters/${matter}`))).timeline
const queue = async (): Promise<ApprovalItem[]> =>
  server.txn.approvals.queue({
    workspace_id: server.bootstrap.workspace.id,
    person_id: server.bootstrap.person.id,
    lane: 'mine',
  })
const offers = async (matter: string) =>
  (await timeline(matter)).filter((e) => e.service_offer !== undefined)
const agentSaid = async (matter: string, n: number) =>
  (await timeline(matter)).filter((e) => e.kind === 'agent_message').length >= n

beforeEach(async () => {
  cloud = cloudStandIn({ autoLinkAfterMs: -1 })
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

const newMatter = async (title: string) =>
  (
    await dataOf<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${site.id}/matters`, {
        title,
        role_id: 'site.shopify-theme',
      }),
    )
  ).matter.id

describe('WP390 工坊服务端到端（stub）', () => {
  it('说出意向 → 回答末尾挂推荐卡（同一对话只推一次）；回「不用」→ 这一项不再推', async () => {
    const m1 = await newMatter('我想找个专业点的外包帮我重做网站')
    await waitFor(async () => (await offers(m1)).length > 0, '推荐卡')
    const offer = (await offers(m1))[0]?.service_offer
    expect(offer).toMatchObject({
      service_id: 'workshop.site_build',
      provider_label: 'workshop_team',
      from_credits: 800,
    })
    // 推荐卡不进卡片队列
    expect((await queue()).filter((c) => c.kind === 'service_order')).toEqual([])

    await dataOf(await call('POST', `/v1/matters/${m1}/messages`, { text: '不用' }))
    await waitFor(async () => agentSaid(m1, 2), '第二段话')
    await dataOf(
      await call('POST', `/v1/matters/${m1}/messages`, { text: '还是想找个专业团队重做网站' }),
    )
    await waitFor(async () => agentSaid(m1, 3), '第三段话')
    expect(await offers(m1)).toHaveLength(1)

    // 另一段对话：说过「不用」，30 天内也不推
    const m2 = await newMatter('想找个外包帮我重做网站')
    await waitFor(async () => agentSaid(m2, 1), '另一件事的回答')
    expect(await offers(m2)).toEqual([])
  })

  it('看看 → 价目单 → 点两次只下一单 → 交付 → 验收卡 → 通过；订单面板与账本', async () => {
    const m = await newMatter('帮我看看社媒互动')
    const started = await dataOf<{ next: string; card_id: string }>(
      await call('POST', '/v1/workshop-services/start', {
        service_id: 'demo.engagement',
        matter_id: m,
      }),
    )
    expect(started.next).toBe('card')
    const card = (await queue()).find(
      (c) => c.id === started.card_id,
    ) as ApprovalItem<ServiceMenuCardPayload>
    expect(card.kind).toBe('service_order')
    const edited = {
      ...card.payload,
      lines: [
        { item_id: 'like', quantity: 50, target: { post_url: 'https://reddit.com/r/x/1' } },
        { item_id: 'comment', quantity: 10, target: { post_url: 'https://reddit.com/r/x/1' } },
      ],
    }
    const decide = () =>
      call('POST', `/v1/approvals/${card.id}/decide`, {
        action: 'approve',
        edited_payload: edited,
        via: 'workstation',
      })
    // 同一张卡点两次（双击 / 两个窗口）：总线放没放进第二下都行，云上只一单、只扣一次（同一个幂等键）
    const [a, b] = await Promise.all([decide(), decide()])
    expect(a.status).toBe(200)
    expect([200, 409]).toContain(b.status)
    await waitFor(async () => cloud.services.list('all').orders.length === 1, '云上建单')
    await new Promise((r) => setTimeout(r, 200))
    expect(cloud.services.list('all').orders).toHaveLength(1)
    const id = cloud.services.list('all').orders[0]?.id as string
    expect(cloud.services.ledger().filter((r) => r.capability.endsWith('.escrow'))).toHaveLength(1)

    cloud.services.take(id)
    cloud.services.deliver(id, {
      proof: {
        links: ['https://reddit.com/r/x/1'],
        screenshots: [],
        completed: [
          { item_id: 'like', quantity: 50 },
          { item_id: 'comment', quantity: 8 },
        ],
      },
    })
    const open = await dataOf<{
      orders: { order: { id: string; status: string }; card_id?: string }[]
    }>(await call('GET', '/v1/workshop-services/orders'))
    const row = open.orders.find((o) => o.order.id === id)
    expect(row?.order.status).toBe('delivered')
    expect(row?.card_id).toBeDefined()
    const accept = await call('POST', `/v1/approvals/${row?.card_id}/decide`, {
      action: 'approve',
      selected_option_id: 'accept',
      via: 'workstation',
    })
    expect(accept.status).toBe(200)
    await waitFor(async () => cloud.services.get(id).status === 'completed', '验收通过')
    const detail = await dataOf<{
      order: { refunded_credits: number; settled_credits: number }
      ledger: { kind: string }[]
    }>(await call('GET', `/v1/workshop-services/orders/${id}`))
    expect(detail.order.refunded_credits).toBe(16)
    expect(detail.order.settled_credits).toBe(89)
    expect(detail.ledger.map((l) => l.kind)).toEqual(
      expect.arrayContaining(['order', 'escrow', 'delivery', 'acceptance', 'settle', 'refund']),
    )
    // 岗位页「在做」里有它
    const pos = await dataOf<{ items: { kind: string; ref_id: string }[] }>(
      await call('GET', `/v1/positions/${site.id}/work`),
    )
    expect(pos.items.some((i) => i.kind === 'service_order' && i.ref_id === id)).toBe(true)
    // 积分「工坊服务」那一块：托管 / 完成 / 退回三行
    const usage = await dataOf<{ rows: { key: string }[] }>(
      await call(
        'GET',
        '/v1/cloud/usage?group=capability',
        undefined,
        server.bootstrap.ownerAssignment.id,
      ),
    )
    expect(usage.rows.map((r) => r.key)).toEqual(
      expect.arrayContaining([
        'workshop.service.escrow',
        'workshop.service.complete',
        'workshop.service.refund',
      ]),
    )
  })

  it('后台加一项假服务：本机刷新一次就有；老令牌缺 services → 照实说要重新登录', async () => {
    cloud.services.addService({
      ...(cloud.services.catalog().services[1] as never),
      id: 'fake.new',
      label_zh: '假标准件',
    })
    const list = await dataOf<{ services: { id: string }[] }>(
      await call('GET', '/v1/workshop-services?refresh=1'),
    )
    expect(list.services.map((s) => s.id)).toContain('fake.new')
    cloud.services.scopeMissing(true)
    const denied = await dataOf<{ reauth?: boolean; notice?: string }>(
      await call('GET', '/v1/workshop-services?refresh=1'),
    )
    expect(denied.reauth).toBe(true)
    expect(denied.notice).toMatch(/重新登录/)
  })
})
