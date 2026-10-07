/**
 * WP253 端到端（真装配线：路由 → 端口 → 运行时 → 主题工坊 → 变更账本 → 执行器）。
 *
 * 模型那一跳是 stub（没接模型），`shopify theme …` 是进程内替身，起底包是内存里的假 agentsws-theme——
 * 不联网、不碰任何真店。钉住的事：
 *
 * 1. 建站岗位页的引导：没装 / 没登录 / 不知道店铺 → `/v1/site/theme` 的 `next` 依次给出，补上就消失；
 * 2. 「用 agentsws-theme 给我搭个首页」→ 起底 → 检查 → 推**未发布**主题，事项时间线上一条「预览好了」+ 链接；
 * 3. 「发布」→ 只出一张 `publish_theme` 的卡（L1，卡上写清换哪一份、改了哪些文件），**一次 publish 都没跑**；
 * 4. 人批了 → 执行器跑 `theme publish`；别的职责的工具面里没有主题工具。
 */
import type { Assignment, RunEvent } from '@agentsws/contracts'
import { THEME_TOOL_NAMES } from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { fakeThemeBase, themeCliStandIn } from '../src/site-theme-stand-in.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SHOP = '6suegp-md.myshopify.com'

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

type ThemeView = {
  cli: string
  next?: string
  store?: string
  last_push?: { preview_url?: string }
}

beforeEach(async () => {
  installed = false
  now = T0
  fake = themeCliStandIn()
  const exec: ProbeExec = async (bin, args) => {
    if (bin === 'node') return { ok: true, stdout: 'v22.12.0' }
    return installed
      ? { ok: true, stdout: `Current Shopify CLI version: 4.8.5 ${args.length}` }
      : { ok: false, stdout: '', missing: true }
  }
  const base = fakeThemeBase()
  server = await createServer({
    quiet: true,
    clock: { now: () => now },
    random: () => 0.42,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    platformCliExec: exec,
    siteTheme: { run: fake.run, fetch: base.fetch, base: base.pin },
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
      { legal_name: 'Rollout', storefront_platform: 'shopify' },
      owner,
    ),
  )
})

afterEach(async () => {
  await server.close()
})

describe('WP253 建站岗位端到端（stub）', () => {
  it('岗位页引导 → 搭首页出预览 → 发布只出卡 → 批了才换线上主题', async () => {
    // ① 引导：没装 → 没登录 → 不知道店铺；补上一样少一样
    expect((await dataOf<ThemeView>(await call('GET', '/v1/site/theme'))).next).toBe('install_cli')
    installed = true
    expect((await dataOf<ThemeView>(await call('GET', '/v1/site/theme?fresh=1'))).next).toBe(
      'login',
    )
    await dataOf(await call('PUT', '/v1/platform-kit/cli/login', { confirmed: true }))
    expect((await dataOf<ThemeView>(await call('GET', '/v1/site/theme'))).next).toBe('store')
    const bad = await call('PUT', '/v1/site/theme/store', { store: 'not a shop!!' })
    expect(bad.status).toBe(400)
    const ready = await dataOf<ThemeView>(
      await call('PUT', '/v1/site/theme/store', { store: SHOP }),
    )
    expect(ready).toMatchObject({ cli: 'ready', store: SHOP })
    expect(ready.next).toBeUndefined()

    // ② 搭首页：起底 → 检查 → 推未发布；时间线上「预览好了」+ 链接
    const out = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/positions/${theme.id}/matters`, {
        title: '用 agentsws-theme 给我搭个首页',
        role_id: 'site.shopify-theme',
      }),
    )
    expect(toolsCalled(out.run_id ?? '')).toEqual([
      'theme_init_from_base',
      'theme_check',
      'theme_push_unpublished',
    ])
    const view = await dataOf<{
      timeline: { kind: string; text: string; preview?: { url: string; label: string } }[]
    }>(await call('GET', `/v1/matters/${out.matter.id}`))
    const preview = view.timeline.find((e) => e.preview !== undefined)
    expect(preview?.text).toContain('预览好了')
    expect(preview?.preview?.url).toMatch(
      new RegExp(`^https://${SHOP.replace(/\./g, '\\.')}\\?preview_theme_id=\\d+$`),
    )
    const reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toContain('预览好了')
    expect(reply).not.toMatch(/theme_push_unpublished|theme_init_from_base/)
    expect(fake.themes.filter((t) => t.role === 'unpublished')).toHaveLength(1)
    expect(
      (await dataOf<ThemeView>(await call('GET', '/v1/site/theme'))).last_push?.preview_url,
    ).toBe(preview?.preview?.url)

    // ③ 发布：只出卡（L1），一次 publish 都没跑
    const pub = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/positions/${theme.id}/matters`, {
        title: '预览看过了，发布上线',
        role_id: 'site.shopify-theme',
      }),
    )
    expect(toolsCalled(pub.run_id ?? '')).toEqual(['theme_list', 'theme_publish'])
    expect(fake.calls.filter((c) => c[1] === 'publish')).toEqual([])
    const pending = (
      await server.txn.approvals.queue({
        workspace_id: server.bootstrap.workspace.id,
        person_id: server.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((a) => (a.payload as { kind?: string } | undefined)?.kind === 'publish_theme')
    expect(pending).toHaveLength(1)
    const card = pending[0]
    expect(card?.state).toBe('pending')
    expect(card?.title).toContain('设为线上主题')
    expect(card?.summary).toContain('从「Horizon」换成')
    // stub 不写 Liquid：起底之后原样推，卡上照实说没改文件（改了哪些文件的那一行由单测钉）
    expect(card?.summary).toContain('没改文件')
    expect(card?.automation.level_at_creation).toBe('L1')

    // ④ 人批了：执行器跑 `theme publish`，线上换成那一份
    const id = card?.id ?? ''
    const token = card?.deliveries[0]?.decision_token ?? ''
    await server.txn.approvals.decide(id, card?.deliveries[0]?.to as never, {
      action: 'approve',
      decision_token: token,
      via: 'workstation',
    })
    // 批准后有一段可撤回的窗口；过了窗口执行器才动手
    now = new Date(Date.parse(T0) + 60 * 60 * 1000).toISOString()
    await server.txn.executor.applyApproval(id)
    expect(fake.calls.filter((c) => c[1] === 'publish')).toHaveLength(1)
    expect(fake.themes.find((t) => t.role === 'main')?.name).toContain('agentsws-theme')
  })

  it('别的职责的工具面里没有主题工具（哪怕说的是主题）', async () => {
    installed = true
    const build = server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      role_id: 'site.shopify-build',
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: server.bootstrap.workspace.id }],
    })
    const out = await dataOf<{ run_id?: string }>(
      await call(
        'POST',
        `/v1/positions/${build.id}/matters`,
        { title: '用 agentsws-theme 给我搭个首页，然后发布', role_id: 'site.shopify-build' },
        build.id,
      ),
    )
    for (const t of toolsCalled(out.run_id ?? '')) expect(THEME_TOOL_NAMES).not.toContain(t)
    expect(fake.calls).toEqual([])
  })
})
