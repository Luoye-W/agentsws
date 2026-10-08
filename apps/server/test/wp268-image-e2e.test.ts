/**
 * WP268（决策 213）端到端（真装配线：路由 → 运行时 → 生图工具 → 素材库 → 挑图卡 → 决定钩子 → 店铺文件 → 主题 → 推预览）。
 *
 * 模型那一跳是 stub；生图是「假云端」——OpenAI 形态的 `images/generations` / `images/edits`（`openaiImageProvider`
 * 接一个记账的假 fetch）；`shopify theme …` 与 `store execute` 都是进程内替身（假店）。不联网、不花钱、不碰真店。
 *
 * 钉住：网页模板说「出首页横幅图」→ 出图进素材库 + 事项里一张挑图卡（不改店）；人选一张 → 先传店铺「文件」
 * 再写进 `templates/index.json` 的 hero 那一格（`shopify://shop_images/…`）→ 推到上一次那份未发布副本、时间线上
 * 「预览好了」；线上一次都没发布。素材库路由列得出、取得到原图；拖进来的图能上传。
 */
import type { Assignment, RunEvent } from '@agentsws/contracts'
import { encodePng, openaiImageProvider } from '@agentsws/model-gateway'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import {
  demoShop,
  type FakeShop,
  shopAdminRunStandIn,
  shopAuthSpawnStandIn,
} from '../src/shop-admin-stand-in.js'
import { fakeThemeBase, themeCliStandIn } from '../src/site-theme-stand-in.js'

const T0 = '2026-10-08T09:00:00.000Z'
const SHOP = 'rollout-test.myshopify.com'

let server: Server
let theme: Assignment
let fake: ReturnType<typeof themeCliStandIn>
let shop: FakeShop
let cloudCalls: { path: string; images: number; model?: string }[]
let uploads: string[]

const PNG = encodePng(4, 4, new Uint8Array(4 * 13), 'rgb')

const call = async (
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<Response> => {
  const headers = new Headers({ Authorization: `Bearer ${server.bootstrap.internalToken}` })
  headers.set('X-Assignment', assignment ?? theme.id)
  if (body !== undefined && !(body instanceof FormData))
    headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
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
  fake = themeCliStandIn()
  shop = demoShop()
  cloudCalls = []
  uploads = []
  const exec: ProbeExec = async (bin) =>
    bin === 'node'
      ? { ok: true, stdout: 'v22.12.0' }
      : { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
  const base = fakeThemeBase()
  // 假云端：OpenAI 形态的生图 / 改图口（按张回 base64 PNG）
  const provider = openaiImageProvider({
    baseUrl: 'https://cloud.agentsws.test/v1/ai',
    apiKey: () => 'wst_test_only',
    model: 'gpt-image-1',
    provider: 'agentsws_cloud',
    fetch: async (url, init) => {
      const form = init.body instanceof FormData ? init.body : undefined
      const json =
        typeof init.body === 'string'
          ? (JSON.parse(init.body) as { n?: number; model?: string })
          : undefined
      const n = Number(form?.get('n') ?? json?.n ?? 1)
      cloudCalls.push({
        path: new URL(url).pathname,
        images: form?.getAll('image[]').length ?? 0,
        ...(json?.model === undefined ? {} : { model: json.model }),
      })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: Array.from({ length: n }, () => ({
            b64_json: Buffer.from(PNG).toString('base64'),
          })),
        }),
        text: async () => '',
      }
    },
  })
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    random: () => 0.42,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
    platformCliExec: exec,
    siteTheme: { run: fake.run, fetch: base.fetch, base: base.pin },
    shopAdmin: {
      run: shopAdminRunStandIn(shop),
      spawn: shopAuthSpawnStandIn(shop, { delayMs: 10 }),
      fetch: (async (url: string) => {
        uploads.push(url)
        return new Response(null, { status: 204 })
      }) as unknown as typeof fetch,
    },
    images: { provider, sleep: async () => undefined, extraImageHosts: /^cdn\.shopify\.test$/ },
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
    await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/workspace/profile', {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': owner,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ legal_name: 'Rollout', storefront_platform: 'shopify' }),
      }),
    ),
  )
  // 网页模板就绪：CLI 登好、知道店铺
  await dataOf(await call('PUT', '/v1/platform-kit/cli/login', { confirmed: true }))
  await dataOf(await call('PUT', '/v1/site/theme/store', { store: SHOP }))
})

afterEach(async () => {
  await server.close()
})

type Timeline = {
  kind: string
  text: string
  approval_item_id?: string
  preview?: { url: string }
}[]

describe('WP268 生图接入建站端到端', () => {
  it('出横幅图 → 挑图卡 → 选一张 → 传店铺文件、写进 hero、推未发布预览；线上没动', async () => {
    // 先搭一版首页（起底 → 检查 → 推未发布）
    const first = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/positions/${theme.id}/matters`, {
        title: '用 agentsws-theme 给我搭个首页',
        role_id: 'site.shopify-theme',
      }),
    )
    expect(toolsCalled(first.run_id ?? '')).toContain('theme_push_unpublished')
    const copies = fake.themes.filter((t) => t.role === 'unpublished').length

    // 店铺授权（网页模板那条职责要「读商品 + 上传文件」）
    await dataOf(
      await call('POST', '/v1/shop-admin/run', {
        action: 'authorize',
        roles: ['site.shopify-theme'],
      }),
    )
    for (let i = 0; i < 200; i++) {
      const v = await dataOf<{ state?: string }>(
        await call('GET', '/v1/shop-admin?roles=site.shopify-theme'),
      )
      if (v.state === 'authorized') break
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(shop.sessions.get(SHOP)?.scopes).toContain('write_files')

    // 出图：只出图、出卡，不改店
    const out = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/positions/${theme.id}/matters`, {
        title: '给首页出几张横幅图',
        role_id: 'site.shopify-theme',
      }),
    )
    expect(toolsCalled(out.run_id ?? '')).toEqual(['generate_image'])
    expect(cloudCalls).toEqual([
      { path: '/v1/ai/images/generations', images: 0, model: 'gpt-image-1' },
    ])
    expect(shop.files ?? []).toEqual([])
    const view = await dataOf<{ timeline: Timeline }>(
      await call('GET', `/v1/matters/${out.matter.id}`),
    )
    const cardEvent = view.timeline.find((e) => e.kind === "card")
    expect(cardEvent?.approval_item_id).toBeDefined()
    const reply = view.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toContain('挑图卡')
    expect(reply).not.toContain('generate_image')

    // 卡：三张 + 再来一版；卡面写明选中会传店铺、挂首页
    const card = await dataOf<{
      id: string
      kind: string
      summary: string
      options: { id: string; label: string }[]
      payload: { variants: { url: string; asset_id: string }[] }
    }>(await call('GET', `/v1/approvals/${cardEvent?.approval_item_id}`))
    expect(card.kind).toBe('image_pick')
    expect(card.options.map((o) => o.label)).toEqual(['第 1 张', '第 2 张', '第 3 张', '再来一版'])
    expect(card.summary).toContain('传到店铺「文件」')

    // 卡上的图取得到（素材库原图）
    const img = await call('GET', card.payload.variants[0]?.url ?? '')
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')

    // 选第 2 张
    const pick = card.options[1]?.id ?? ''
    // 人在工作台上点（老板那一条分配批卡，同工作台）
    const decided = await call(
      'POST',
      `/v1/approvals/${card.id}/decide`,
      { action: 'approve', selected_option_id: pick, via: 'workstation' },
      server.bootstrap.ownerAssignment.id,
    )
    expect(decided.status).toBe(200)

    // 传了店铺文件、写进 hero、推到上一次那份未发布副本（没多建一份），没发布
    expect(uploads).toHaveLength(1)
    const asset_id = pick.replace('asset:', '')
    const file = shop.files?.[0]
    expect(file?.filename).toBe(`agentsws-${asset_id}.png`)
    // 推上去的那份未发布副本里，模板的 hero 那一格引用店铺文件里的图
    const index =
      fake.themes.find((t) => t.role === 'unpublished')?.files['templates/index.json'] ?? ''
    expect(JSON.parse(index).sections.hero.settings.image).toBe(
      `shopify://shop_images/${file?.filename}`,
    )
    expect(fake.themes.filter((t) => t.role === 'unpublished')).toHaveLength(copies)
    expect(fake.calls.filter((c) => c[1] === 'publish')).toEqual([])
    const after = await dataOf<{ timeline: Timeline }>(
      await call('GET', `/v1/matters/${out.matter.id}`),
    )
    expect(after.timeline.some((e) => e.text.includes('挂好了'))).toBe(true)
    expect(after.timeline.some((e) => e.preview !== undefined && e.text.includes('预览好了'))).toBe(
      true,
    )

    // 素材库：选中的那张记了店铺文件与挂在哪
    const lib = await dataOf<{
      rows: {
        id: string
        status: string
        source_label: string
        shop_file?: { theme_ref: string }
      }[]
    }>(await call('GET', `/v1/brand-assets?matter_id=${out.matter.id}`))
    expect(lib.rows).toHaveLength(3)
    const chosen = lib.rows.find((r) => r.id === asset_id)
    expect(chosen).toMatchObject({ status: 'picked', source_label: 'AI 生成' })
    expect(chosen?.shop_file?.theme_ref).toContain('shopify://shop_images/')
  })

  it('拖进来的图上传进素材库；不是图片拒收', async () => {
    const form = new FormData()
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'box.png')
    form.append('matter_id', 'mat_x')
    form.append('tags', 'product')
    const up = await dataOf<{
      asset: { id: string; source_label: string; status: string; tags: string[] }
    }>(await call('POST', '/v1/brand-assets/upload', form))
    expect(up.asset).toMatchObject({
      source_label: '事项里拖进来的',
      status: 'picked',
      tags: ['product'],
    })
    const bad = new FormData()
    bad.append('file', new Blob(['hello'], { type: 'image/png' }), 'x.png')
    expect((await call('POST', '/v1/brand-assets/upload', bad)).status).toBe(400)
    expect((await call('GET', '/v1/brand-assets/dasset_nope/file')).status).toBe(404)
  })
})
