/**
 * WP258 端到端（真装配线）：品牌分析从官网取下 `Shopify.shop` 存进档案 → 建站岗位页一键安装 / 一键登录 →
 * 登好了服务端自己去找这个账号下的店 → 与官网对上的那家默认选中，岗位页那一格不再出现。
 *
 * CLI 检测 / 安装 / 登录是 demo 替身（`platform-cli-stand-in.ts`），`shopify store list` 是进程内替身
 * （`themeCliStandIn({ orgs })`），官网是夹具——不联网、不碰任何真店。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import type { Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { platformCliStandIn } from '../src/platform-cli-stand-in.js'
import { fakeThemeBase, themeCliStandIn } from '../src/site-theme-stand-in.js'

const SITE = 'https://rollout.example'
const ROLLOUT = '6suegp-md.myshopify.com'
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../packages/brand-intake/test/fixtures',
)
/** 刚开的 Shopify 空店首页，带上 Shopify 每一页都有的那一行 `Shopify.shop = "…"`。 */
const home = readFileSync(join(FIXTURES, 'fresh-home.html'), 'utf8').replace(
  '</head>',
  `<script>Shopify.shop = "${ROLLOUT}";</script></head>`,
)
const site: PageFetch = async (url) =>
  url === `${SITE}/`
    ? { ok: true, status: 200, text: async () => home }
    : { ok: false, status: 404, text: async () => '' }

let server: Server
let theme: Assignment
let fake: ReturnType<typeof themeCliStandIn>

type ThemeView = {
  cli: string
  next?: string
  store?: string
  store_source?: string
  site_store?: string
  store_lookup?: { status: string; stores: { store: string; name?: string; plan?: string }[] }
}
type KitView = { kit?: { cli?: { state: string; job?: { phase: string } } } }

const call = async <T>(
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<{ status: number; data?: T }> => {
  const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
  headers.set('X-Assignment', assignment ?? theme.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const parsed = (await res.json()) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
}
const until = async <T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> => {
  for (let i = 0; i < 400; i += 1) {
    const v = await read()
    if (ok(v)) return v
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('等不到')
}

beforeEach(async () => {
  fake = themeCliStandIn({
    orgs: [
      {
        id: '111',
        name: 'Rollout Org',
        stores: [
          { store: ROLLOUT, name: 'My Store', plan: 'basic' },
          { store: 'inmo-dev.myshopify.com', name: 'INMO Dev', plan: 'Development' },
        ],
      },
    ],
  })
  const cli = platformCliStandIn({ stepMs: 2, loginMs: 5 })
  const base = fakeThemeBase()
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date().toISOString() },
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    liveDataIntervalMs: 0,
    mdns: () => ({ reason: '测试里不开局域网' }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    brandIntakeFetch: site,
    platformCliExec: cli.exec,
    platformCliRunner: cli.runner,
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
  await call(
    'PUT',
    '/v1/workspace/profile',
    { legal_name: 'Rollout', storefront_platform: 'shopify' },
    owner,
  )
})

afterEach(async () => {
  await server.close()
})

describe('WP258 登录 Shopify 后自动取店铺（真装配线）', () => {
  it('官网 → 档案 → 一键装 / 登 → 自动找店 → 与官网对上的那家默认选中', async () => {
    const owner = server.bootstrap.ownerAssignment.id
    // ① 品牌分析：官网首页里那一行 Shopify.shop 存进档案
    const run = await call<{ id: string }>(
      'POST',
      '/v1/brand-intake/runs',
      { urls: [`${SITE}/`] },
      owner,
    )
    const id = run.data?.id ?? ''
    await until(
      () => call<{ status: string }>('GET', `/v1/brand-intake/runs/${id}`, undefined, owner),
      (r) => r.data?.status === 'awaiting_confirm',
    )
    expect((await call('POST', `/v1/brand-intake/runs/${id}/confirm`, {}, owner)).status).toBe(200)

    // ② 没装 → 一键装；没登录 → 一键登录（替身：很快就「登好了」）
    expect((await call<ThemeView>('GET', '/v1/site/theme')).data?.next).toBe('install_cli')
    await call('POST', '/v1/platform-kit/cli/run', { action: 'install' })
    await until(
      () => call<KitView>('GET', '/v1/platform-kit'),
      (r) => r.data?.kit?.cli?.state === 'needs_login',
    )
    expect(fake.calls.some((c) => c[0] === 'store')).toBe(false)
    await call('POST', '/v1/platform-kit/cli/run', { action: 'login' })
    await until(
      () => call<KitView>('GET', '/v1/platform-kit'),
      (r) => r.data?.kit?.cli?.state === 'ready',
    )

    // ③ 登好了：服务端自己跑了 store list；官网那家（6suegp-md）默认选中，岗位页那一格不出现
    const view = await until(
      () => call<ThemeView>('GET', '/v1/site/theme'),
      (r) => r.data?.store !== undefined,
    )
    expect(view.data).toMatchObject({
      cli: 'ready',
      store: ROLLOUT,
      store_source: 'cli',
      site_store: ROLLOUT,
      store_lookup: { status: 'ok' },
    })
    expect(view.data?.next).toBeUndefined()
    expect(view.data?.store_lookup?.stores.map((s) => s.store)).toEqual([
      ROLLOUT,
      'inmo-dev.myshopify.com',
    ])
    expect(fake.calls.filter((c) => c[0] === 'store')).toEqual([['store', 'list', '--json']])

    // ④ 下拉框里换一家：选了即存；不在清单里的 400；「都不是？手动填」照旧
    const picked = await call<ThemeView>('PUT', '/v1/site/theme/store', {
      store: 'inmo-dev.myshopify.com',
      source: 'list',
    })
    expect(picked.data).toMatchObject({ store: 'inmo-dev.myshopify.com', store_source: 'cli' })
    const bad = await call('PUT', '/v1/site/theme/store', {
      store: 'evil.myshopify.com',
      source: 'list',
    })
    expect(bad.status).toBe(400)
    const manual = await call<ThemeView>('PUT', '/v1/site/theme/store', {
      store: 'typed.myshopify.com',
    })
    expect(manual.data).toMatchObject({ store: 'typed.myshopify.com', store_source: 'manual' })
    expect(manual.data?.store_lookup).toBeUndefined()

    // 事件里只有个数与命令名，没有店名
    const events = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type.startsWith('site_theme.store'))
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['site_theme.store_lookup', 'site_theme.store_auto']),
    )
    expect(JSON.stringify(events.map((e) => e.payload))).not.toContain('My Store')
  })
})
