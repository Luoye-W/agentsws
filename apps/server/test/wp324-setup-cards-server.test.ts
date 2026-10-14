/**
 * WP324（决策 690）端到端（真装配线：路由 → 端口 → 运行时（stub）→ 建站工具 → 卡住标记 → 连接卡 / 配置卡 →
 * HTTP 决定 → 决定钩子 → 按原话接着跑）。店里的主题与 CLI 是进程内替身，不联网、不碰任何真店。
 *
 * 1. 建站工具没装 → 出**连接卡**（建站工具）就停；第二件事撞上同一缺项 → 不再出新卡、挂到同一张上；
 *    装好、登好、店定了 → 卡上「接着做」→ 两件事都按原话接着跑。
 * 2. 还不知道是哪家店 → 出**配置卡**（选店，带建议值）；卡上填好保存 → 存进去、接着跑（这次到了选主题卡）。
 */
import type { ApprovalItem, Assignment, ConnectRequestPayload } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { FAKE_OS2_THEME_FILES, themeCliStandIn } from '../src/site-theme-stand-in.js'

const T0 = '2026-10-14T09:00:00.000Z'
const SHOP = '6suegp-md.myshopify.com'

let server: Server
let theme: Assignment
let installed: boolean

const call = async (method: string, path: string, body?: unknown, assignment?: string) => {
  const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
  headers.set('X-Assignment', assignment ?? theme.id)
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
type Timeline = { kind: string; text: string; approval_item_id?: string; blocked?: unknown }[]
const timeline = async (matter: string): Promise<Timeline> =>
  (await dataOf<{ timeline: Timeline }>(await call('GET', `/v1/matters/${matter}`))).timeline
const queue = async (): Promise<ApprovalItem[]> =>
  server.txn.approvals.queue({
    workspace_id: server.bootstrap.workspace.id,
    person_id: server.bootstrap.person.id,
    lane: 'mine',
  })
const waitFor = async (fn: () => Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
}
const newMatter = async (title: string) =>
  dataOf<{ matter: { id: string }; run_id?: string }>(
    await call('POST', `/v1/positions/${theme.id}/matters`, {
      title,
      role_id: 'site.shopify-theme',
    }),
  )

beforeEach(async () => {
  installed = false
  const fake = themeCliStandIn({
    themes: [
      { id: '100002', name: 'Lumen', role: 'unpublished', files: { ...FAKE_OS2_THEME_FILES } },
    ],
  })
  const exec: ProbeExec = async (bin, args) => {
    if (bin === 'node') return { ok: true, stdout: 'v22.12.0' }
    return installed
      ? { ok: true, stdout: `Current Shopify CLI version: 4.8.5 ${args.length}` }
      : { ok: false, stdout: '', missing: true }
  }
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: () => 0.42,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    platformCliExec: exec,
    siteTheme: { run: fake.run },
  })
  const ws = server.bootstrap.workspace.id
  theme = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    role_id: 'site.shopify-theme',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: ws }],
  })
  await dataOf(
    await call(
      'PUT',
      '/v1/workspace/profile',
      { legal_name: 'Rollout', storefront_platform: 'shopify' },
      server.bootstrap.ownerAssignment.id,
    ),
  )
})

afterEach(async () => {
  await server.close()
})

describe('WP324 连接卡 / 配置卡端到端（stub）', () => {
  it('缺建站工具 → 出连接卡就停；同一缺项第二件事不再出卡；连好点「接着做」→ 两件事都接着跑', async () => {
    const a = await newMatter('从头给我搭个首页')
    const b = await newMatter('给我搭个关于我们页')
    const cards = (await queue()).filter((c) => c.kind === 'connect_request')
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem<ConnectRequestPayload>
    expect(card.payload.needs.map((n) => n.service)).toEqual(['site_theme'])
    expect(card.subject.matter_id).toBe(a.matter.id)
    // 两件事的时间线上都有卡住那一句（指向这张卡）+ 这张卡
    for (const m of [a.matter.id, b.matter.id]) {
      const tl = await timeline(m)
      const blocked = tl.find((e) => e.blocked !== undefined)
      expect(blocked?.blocked).toMatchObject({ reason: 'needs_setup', card_id: card.id })
      expect(blocked?.text).toMatch(/下面这张卡/)
      expect(tl.filter((e) => e.kind === 'card' && e.approval_item_id === card.id)).toHaveLength(1)
    }

    // 还没装就点「接着做」：不接着跑，换一张新卡（等着的两件事带过去）
    expect(
      (
        await call('POST', `/v1/approvals/${card.id}/decide`, {
          action: 'approve',
          via: 'workstation',
        })
      ).status,
    ).toBe(200)
    await waitFor(async () =>
      (await queue()).some((c) => c.kind === 'connect_request' && c.id !== card.id),
    )
    const again = (await queue()).find((c) => c.kind === 'connect_request') as ApprovalItem
    expect(again.id).not.toBe(card.id)
    expect((await timeline(a.matter.id)).map((e) => e.text).join('\n')).toMatch(/还没连上/)

    // 装好、登好、店定了 → 点「接着做」→ 两件事都按原话接着跑
    installed = true
    await dataOf(await call('PUT', '/v1/platform-kit/cli/login', { confirmed: true }))
    await dataOf(await call('PUT', '/v1/site/theme/store', { store: SHOP }))
    expect(
      (
        await call('POST', `/v1/approvals/${again.id}/decide`, {
          action: 'approve',
          via: 'workstation',
        })
      ).status,
    ).toBe(200)
    const resumed = async (m: string) =>
      (await timeline(m)).some((e) => e.kind === 'run' && e.text === '连好了，接着做')
    await waitFor(async () => (await resumed(a.matter.id)) && (await resumed(b.matter.id)))
    expect(await resumed(a.matter.id)).toBe(true)
    expect(await resumed(b.matter.id)).toBe(true)
    // 接着跑的那一次到了选主题卡（建站工具这一关过了），不再出连接卡
    await waitFor(async () => (await queue()).some((c) => c.kind === 'theme_choice'))
    expect((await queue()).filter((c) => c.kind === 'connect_request')).toHaveLength(0)
  })

  it('不知道是哪家店 → 出配置卡（带建议格）；填好保存 → 存进去、按原话接着做', async () => {
    installed = true
    await dataOf(await call('PUT', '/v1/platform-kit/cli/login', { confirmed: true }))
    const a = await newMatter('从头给我搭个首页')
    const card = (await queue()).find((c) => c.kind === 'setup_request') as ApprovalItem<{
      target: string
      fields: { key: string }[]
    }>
    expect(card).toBeDefined()
    expect(card.payload.target).toBe('site.store')
    expect(card.payload.fields.map((f) => f.key)).toEqual(['store'])
    const res = await call('POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
      edited_payload: { ...card.payload, values: { store: SHOP } },
      via: 'workstation',
    })
    expect(res.status).toBe(200)
    await waitFor(async () =>
      (await timeline(a.matter.id)).some((e) => e.kind === 'run' && e.text === '设好了，接着做'),
    )
    const view = await dataOf<{ store?: string }>(await call('GET', '/v1/site/theme'))
    expect(view.store).toBe(SHOP)
    await waitFor(async () => (await queue()).some((c) => c.kind === 'theme_choice'))
    expect((await queue()).some((c) => c.kind === 'theme_choice')).toBe(true)
  })
})
