/**
 * WP304（决策 445）端到端（真装配线：路由 → 端口 → 运行时（stub）→ 主题工坊 → 审批总线 → 决定钩子 → 接着跑）。
 *
 * 「从头给我搭个首页」没点名用哪套 → 起底先出一张选主题卡（高级主题排第一；这台没登录工坊账号 →「登录后可买」）、这次就停；
 * 人在卡上选店里那份 Lumen（手写的 Dawn 那一代形状 2.0 主题）→ 服务端复制它起底、时间线记一句 → 按原话接着跑：
 * 起底回 `reused`、检查、推未发布预览。店里的主题是进程内替身，不联网、不碰任何真店。
 */
import type { ApprovalItem, Assignment, RunEvent } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { FAKE_OS2_THEME_FILES, themeCliStandIn } from '../src/site-theme-stand-in.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SHOP = '6demox-md.myshopify.com'

let server: Server
let theme: Assignment
let fake: ReturnType<typeof themeCliStandIn>
let installed: boolean
let now = T0

const call = async (
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<Response> => {
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
const toolsCalled = (run_id: string): string[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.correlation?.run_id === run_id && e.type === 'tool.call')
    .map((e) => (e.payload as Extract<RunEvent, { type: 'tool.call' }>).tool)

beforeEach(async () => {
  installed = false
  now = T0
  fake = themeCliStandIn({
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
    clock: { now: () => now },
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
  const owner = server.bootstrap.ownerAssignment.id
  await dataOf(
    await call(
      'PUT',
      '/v1/workspace/profile',
      { legal_name: 'Rovella', storefront_platform: 'shopify' },
      owner,
    ),
  )
})

afterEach(async () => {
  await server.close()
})

type Timeline = { kind: string; text: string; preview?: { url: string; label: string } }[]

describe('WP304 选主题卡端到端（stub）', () => {
  it('没点名用哪套 → 出选主题卡就停；选了店里的免费主题 → 起底、记一句、接着做到出预览', async () => {
    installed = true
    await dataOf(await call('PUT', '/v1/platform-kit/cli/login', { confirmed: true }))
    await dataOf(await call('PUT', '/v1/site/theme/store', { store: SHOP }))
    const out = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/positions/${theme.id}/matters`, {
        title: '从头给我搭个首页',
        role_id: 'site.shopify-theme',
      }),
    )
    expect(toolsCalled(out.run_id ?? '')).toEqual(['theme_init_from_base'])
    const ws = server.bootstrap.workspace.id
    const queue = await server.txn.approvals.queue({
      workspace_id: ws,
      person_id: server.bootstrap.person.id,
      lane: 'mine',
    })
    const card = queue.find((a) => a.kind === 'theme_choice') as ApprovalItem
    expect(card.state).toBe('pending')
    const p = card.payload as {
      premium: { status: string }
      options: { id: string; label: string }[]
    }
    expect(p.premium.status).toBe('needs_account')
    expect(p.options.map((o) => o.id)).toEqual(['store:100001', 'store:100002'])
    expect(fake.calls.some((c) => c[1] === 'duplicate')).toBe(false)
    const timeline = async (): Promise<Timeline> =>
      (await dataOf<{ timeline: Timeline }>(await call('GET', `/v1/matters/${out.matter.id}`)))
        .timeline
    expect((await timeline()).find((e) => e.kind === 'agent_message')?.text).toMatch(/选主题卡/)

    // 人在卡上选店里那份 Lumen（工作台那一路：HTTP 决定 → 决定钩子）
    const decided = await call('POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
      selected_option_id: 'store:100002',
      via: 'workstation',
    })
    expect(decided.status).toBe(200)
    let tl: Timeline = []
    for (let i = 0; i < 100; i++) {
      tl = await timeline()
      if (tl.some((e) => e.preview !== undefined)) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(tl.map((e) => e.text).join('\n')).toMatch(/用「Lumen」起好底了/)
    expect(tl.find((e) => e.preview !== undefined)?.text).toContain('预览好了')
    expect(tl.filter((e) => e.kind === 'agent_message').at(-1)?.text).toMatch(
      /用你选的「Lumen」起好的底接着做/,
    )
    // 线上那一份没动；店里多了 Lumen 的那份副本（预览推在它上面），没有第二份
    expect(fake.themes.find((t) => t.role === 'main')?.name).toBe('Horizon')
    expect(fake.calls.filter((c) => c[1] === 'duplicate')).toHaveLength(1)
    const view = await dataOf<{ workspace: { base?: { theme_name?: string; source?: string } } }>(
      await call('GET', '/v1/site/theme'),
    )
    expect(view.workspace.base).toMatchObject({ theme_name: 'Lumen', source: 'store' })
  })
})
