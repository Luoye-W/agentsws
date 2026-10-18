/**
 * WP304（决策 445）：建站先选主题——选主题卡（「选一个」）与买高级主题卡（「花钱」）两条路。
 *
 * 店里的主题是进程内替身（`themeCliStandIn`）：线上是手写的 Horizon 形状假主题，另加一份手写的 Dawn 那一代形状 2.0 主题
 * （编的 Lumen）与一份只有 `.liquid` 模板的老主题——都不是任何真主题的拷贝。高级主题的云是替身（`premiumThemeStandIn`，
 * 包是手写的占位主题），经真的 `createPremiumThemeClient` 调；不联网、不花钱、不碰任何真店。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalBus,
  type ApprovalItem,
  platformKitOf,
  type RunRequest,
  type ThemeChoicePayload,
} from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createPremiumThemeClient, type PremiumFetch } from '../src/premium-theme.js'
import { premiumThemeStandIn } from '../src/premium-theme-stand-in.js'
import type { SecretStore } from '../src/secret-store.js'
import { createSiteTheme, type SiteThemeAssembly } from '../src/site-theme.js'
import {
  FAKE_HORIZON_FILES,
  FAKE_OS2_THEME_FILES,
  FAKE_VINTAGE_THEME_FILES,
  themeCliStandIn,
} from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'

const T0 = '2026-10-13T09:00:00.000Z'
const SHOP = 'rovella-gear.myshopify.com'
const WS = 'ws_rovella'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let fake: ReturnType<typeof themeCliStandIn>
let items: ApprovalItem[]
let notes: { matter: string; text: string }[]
let previews: { matter: string; label: string }[]
let resumed: { matter_id: string; person_id: string; assignment_id: string }[]
let credits: number
let cloud: ReturnType<typeof premiumThemeStandIn>
/** 云的样子：`ok` = 三条路都在；`missing` = 还没上线（404）；`tamper` = 下载回来的 sha256 不对。 */
let cloudMode: 'ok' | 'missing' | 'tamper'
let linked: boolean

const request = (matter = 'mat_1'): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id: 'site.shopify-theme' },
    work_item: { id: matter, conversation_id: matter, role_id: 'site.shopify-theme' },
  }) as unknown as RunRequest

const bus = {
  create: async (input: Record<string, unknown>) => {
    const item = {
      ...input,
      id: `apv_${items.length + 1}`,
      state: 'pending',
      revision: 1,
      deliveries: [],
      links: { children: [] },
      created_at: T0,
      updated_at: T0,
    } as unknown as ApprovalItem
    items.push(item)
    return item
  },
  get: async (id: string) => items.find((i) => i.id === id),
} as unknown as ApprovalBus

/** 人在卡上点了（选项 / 买下 / 先不买）。 */
const decided = (item: ApprovalItem, option?: string, state = 'approved'): ApprovalItem => {
  const out = {
    ...item,
    state,
    decision: {
      action: state === 'rejected' ? 'reject' : 'approve',
      by: 'per_owner',
      at: T0,
      via: 'workstation',
      ...(option === undefined ? {} : { selected_option_id: option }),
    },
  } as ApprovalItem
  items[items.findIndex((i) => i.id === item.id)] = out
  return out
}

const premiumFetch: PremiumFetch = async (input, init) => {
  const url = new URL(input)
  const body = init?.body === undefined ? {} : (JSON.parse(init.body) as Record<string, unknown>)
  const hit =
    cloudMode === 'missing'
      ? undefined
      : cloud.handle(init?.method ?? 'GET', url.pathname, url.searchParams, body)
  const out = hit ?? { status: 404, body: { code: 'not_found', message: 'no route' } }
  // WP305：下载是 zip 流，sha256 在响应头
  const headers = { ...(out.headers ?? {}) }
  if (cloudMode === 'tamper' && out.bytes !== undefined)
    headers['X-Agentsws-Theme-Sha256'] = '0'.repeat(64)
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]))
  const bytes = out.bytes
  const text = JSON.stringify(out.body ?? {})
  return {
    ok: out.status < 300,
    status: out.status,
    text: async () => text,
    headers: { get: (n: string) => lower.get(n.toLowerCase()) ?? null },
    ...(bytes === undefined
      ? {}
      : { arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer }),
  }
}

function make(): SiteThemeAssembly {
  const secrets = {
    get available() {
      return linked
    },
    get: () => (linked ? { token: 'wst_test' } : undefined),
  } as unknown as SecretStore
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => T0 },
    dataDir: join(dir, 'data'),
    settingsFile: join(dir, 'data', 'brand', 'site-theme.json'),
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 20, checked_at: T0 }),
    loggedIn: () => true,
    invocation: () => ({ command: 'shopify', prefix: [] }),
    connectedShops: () => [SHOP],
    run: fake.run,
    ledger: { stage: async () => ({ ok: false, message: 'no' }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    notePreview: (matter, input) => previews.push({ matter, label: input.label }),
    noteMatter: (matter, text) => notes.push({ matter, text }),
    approvals: () => bus,
    premium: createPremiumThemeClient({
      secrets,
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: premiumFetch,
    }),
    resume: async (input) => {
      resumed.push(input)
    },
  })
}

const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)
const payloadOf = (item: ApprovalItem | undefined): ThemeChoicePayload =>
  item?.payload as ThemeChoicePayload

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp304-theme-'))
  fake = themeCliStandIn({
    shop: SHOP,
    themes: [
      { id: '100002', name: 'Lumen', role: 'unpublished', files: { ...FAKE_OS2_THEME_FILES } },
      {
        id: '100003',
        name: 'Old shop',
        role: 'unpublished',
        files: { ...FAKE_VINTAGE_THEME_FILES },
      },
    ],
  })
  items = []
  notes = []
  previews = []
  resumed = []
  credits = 1000
  cloudMode = 'ok'
  linked = true
  cloud = premiumThemeStandIn({
    available: () => credits,
    spend: (n) => {
      credits -= n
    },
  })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('选主题卡（WP304）', () => {
  it('第一次起底先出选主题卡：高级主题排第一；店里能改的免费主题能选，老主题只列不选；不重复出', async () => {
    const t = make()
    const exec = createThemeToolExecutor({ module: async () => t })
    const out = await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect(out.status).toBe('ok')
    const data = out.data as { ok: boolean; choice: { approval_item_id: string; premium: string } }
    expect(data.ok).toBe(false)
    expect(data.choice.premium).toBe('buy')
    const card = items[0]
    expect(card?.kind).toBe('theme_choice')
    expect(card?.subject.matter_id).toBe('mat_1')
    const p = payloadOf(card)
    expect(p.options.map((o) => o.id)).toEqual(['premium', 'store:100001', 'store:100002'])
    expect(p.options[0]?.label).toContain('560 积分')
    expect(p.options[1]?.label).toBe('Horizon（线上）')
    expect(p.store_themes.find((x) => x.id === '100003')).toMatchObject({
      name: 'Old shop',
      usable: false,
    })
    // 店里一个字节没动：没复制、工作目录是空的
    expect(fake.calls.some((c) => c[1] === 'duplicate')).toBe(false)
    expect(existsSync(themeDir()) ? readdirSync(themeDir()) : []).toEqual([])
    // 再叫一次起底：同一张卡，不再出
    const again = await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect((again.data as { choice: { approval_item_id: string } }).choice.approval_item_id).toBe(
      card?.id,
    )
    expect(items).toHaveLength(1)
  })

  it('选店里的免费主题（不是 Horizon）：复制那一份起底、目录按它的写法；接着做的那次起底不再起；推过之后照老规矩', async () => {
    const t = make()
    await t.askThemeChoice?.({ request: request() })
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'store:100002'))
    const view = await t.readiness()
    expect(view.workspace.base).toMatchObject({
      repo: 'shopify-theme-store',
      theme_name: 'Lumen',
      source: 'store',
      source_theme_id: '100002',
    })
    expect(view.workspace.base).not.toHaveProperty('chosen')
    const index = JSON.parse(readFileSync(join(themeDir(), 'CATALOG.index.json'), 'utf8'))
    expect(index.theme).toBe('Lumen 1.0.0-fixture')
    expect(index.how_to.join('\n')).toMatch(/local_blocks/)
    expect(notes.map((n) => n.text).join('\n')).toMatch(/用「Lumen」起好底了/)
    expect(resumed).toEqual([
      { matter_id: 'mat_1', person_id: 'per_owner', assignment_id: 'asg_theme' },
    ])
    // 线上那一份一个字节没动；店里多了一份 Lumen 的未发布副本
    expect(fake.themes.find((x) => x.role === 'main')?.files).toEqual(FAKE_HORIZON_FILES)
    expect(fake.themes.filter((x) => x.role === 'unpublished')).toHaveLength(3)
    // 接着做的那次运行再叫起底：就用这一份（不出卡、不再复制）
    const exec = createThemeToolExecutor({ module: async () => t })
    const re = await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect(re.data).toMatchObject({ ok: true, reused: true, theme: { name: 'Lumen' } })
    expect(items).toHaveLength(1)
    // 只改商店层文件；模板对着它自己的目录查
    const ok = await t.writeFile(
      'templates/index.json',
      '{"sections":{"b":{"type":"image-banner","blocks":{"h":{"type":"heading","settings":{"heading":"Hi"}}},"block_order":["h"]}},"order":["b"]}',
    )
    expect(ok.problems).toBeUndefined()
    await expect(t.writeFile('sections/x.liquid', '<div></div>')).rejects.toThrow(/核心代码/)
    // 第一次推预览推到复制出来的那一份上；推过之后再起底照老规矩（起过底了）
    const pushed = await t.push({ name: 'Lumen 首页 v1', request: request() })
    expect(pushed.theme_name).toBe('Lumen 首页 v1')
    await expect(t.initFromBase({})).rejects.toThrow(/已经有东西/)
  })

  it('选了老主题：照实说太老、改不了（建议 Horizon），工作目录不动', async () => {
    const t = make()
    await expect(t.initFromBase({ source: 'store', theme_id: '100003' })).rejects.toMatchObject({
      code: 'too_old',
      message: expect.stringMatching(/「Old shop」是老一代.*Horizon/),
    })
    await t.askThemeChoice?.({ request: request() })
    // 老卡（或者别处）点了那份老主题：时间线上照实说，不起底、不接着跑
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'store:100003'))
    expect(notes.at(-1)?.text).toMatch(/老一代/)
    expect(resumed).toEqual([])
    expect(existsSync(themeDir()) ? readdirSync(themeDir()) : []).toEqual([])
  })

  it('说「换主题」：起过底的也出卡（replace）；选好之后旧的挪到一边不删', async () => {
    const t = make()
    await t.initFromBase({ source: 'store' })
    await t.push({ name: '首页 v1', request: request() })
    const asked = await t.askThemeChoice?.({ replace: true, request: request() })
    expect(asked?.approval_item_id).toBe(items[0]?.id)
    expect(payloadOf(items[0]).replace).toBe(true)
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'store:100002'))
    expect((await t.readiness()).workspace.base?.theme_name).toBe('Lumen')
    expect(readdirSync(join(dir, 'data', 'theme-work', WS, 'aside'))).toHaveLength(1)
  })
})

describe('高级主题（WP304）', () => {
  it('没买：选它 → 出花钱卡（560 积分），点了才扣；买了下载、核 sha256、推未发布预览；不当旧的自带主题', async () => {
    const t = make()
    await t.askThemeChoice?.({ request: request() })
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'premium'))
    const buy = items[1]
    expect(buy?.kind).toBe('theme_purchase')
    expect(buy?.title).toBe('买下高级主题？')
    expect(buy?.summary).toContain('$80')
    expect(buy?.payload).toMatchObject({ form: 'theme_purchase', shop: SHOP, price_credits: 560 })
    expect(credits).toBe(1000)
    expect(resumed).toEqual([])
    // 人点了「买下」
    await t.onThemeCardDecided?.(decided(buy as ApprovalItem))
    expect(credits).toBe(440)
    expect(cloud.downloads()).toEqual([{ shop: SHOP, version: '1.2.0' }])
    // 工作目录：只有主题那几个目录 + 我们生成的目录（包根上的 AGENTS.md / README 不要——AGENTS.md 会被推进店里）
    const top = readdirSync(themeDir()).sort()
    expect(top).toEqual([
      'CATALOG.index.json',
      'CATALOG.json',
      'blocks',
      'config',
      'layout',
      'sections',
      'templates',
    ])
    const view = await t.readiness()
    expect(view.workspace.base).toMatchObject({ source: 'premium', version: '1.2.0' })
    expect(view.workspace.legacy).toBeUndefined()
    expect(await t.legacyNotice()).toBeUndefined()
    // 推了一份未发布预览（线上没动）
    expect(fake.themes.find((x) => x.name === '高级主题 1.2.0')?.role).toBe('unpublished')
    expect(fake.themes.find((x) => x.role === 'main')?.files).toEqual(FAKE_HORIZON_FILES)
    expect(previews).toEqual([{ matter: 'mat_1', label: '高级主题 1.2.0' }])
    expect(notes.map((n) => n.text).join('\n')).toMatch(/扣了 560 积分/)
    expect(resumed).toHaveLength(1)
    // 接着做那一次：就用这一份；第一次推预览推到那一份上、改成人起的名字
    const re = await t.initFromBase({})
    expect(re).toMatchObject({ reused: true, premium: true })
    const pushed = await t.push({ name: 'Rovella 首页 v1', request: request() })
    expect(pushed.theme_id).toBe(fake.themes.find((x) => x.name === 'Rovella 首页 v1')?.id)
    expect(fake.themes.filter((x) => x.role === 'unpublished')).toHaveLength(3)
  })

  it('已买的店：选它直接下载推预览，不再出花钱卡、不再扣', async () => {
    cloud.handle('POST', '/v1/themes/premium/purchase', new URLSearchParams(), { shop: SHOP })
    credits = 1000
    const t = make()
    const asked = await t.askThemeChoice?.({ request: request() })
    expect(asked?.premium).toBe('owned')
    expect(payloadOf(items[0]).options[0]?.label).toContain('已买')
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'premium'))
    expect(items).toHaveLength(1)
    expect(credits).toBe(1000)
    expect((await t.readiness()).workspace.base?.source).toBe('premium')
  })

  it('先不买 / 积分不够 / 包校验不对：一个积分不多扣，工作目录不动，时间线上照实说', async () => {
    const t = make()
    await t.askThemeChoice?.({ request: request() })
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'premium'))
    await t.onThemeCardDecided?.(decided(items[1] as ApprovalItem, undefined, 'rejected'))
    expect(notes.at(-1)?.text).toMatch(/没买高级主题/)
    expect(credits).toBe(1000)
    // 积分不够
    credits = 100
    await t.onThemeCardDecided?.(decided(items[1] as ApprovalItem))
    expect(notes.at(-1)?.text).toMatch(/积分不够/)
    expect(credits).toBe(100)
    // 买成了，但下载回来的包对不上 sha256
    credits = 1000
    cloudMode = 'tamper'
    await t.onThemeCardDecided?.(decided(items[1] as ApprovalItem))
    expect(notes.at(-1)?.text).toMatch(/校验没对上/)
    expect(existsSync(themeDir()) ? readdirSync(themeDir()) : []).toEqual([])
    expect(resumed).toEqual([])
  })

  it('云上桶没绑 / 还没上架（200、available: false）：即将开放，不能选', async () => {
    cloud = premiumThemeStandIn({ available: () => credits, spend: () => undefined, listed: false })
    const t = make()
    expect((await t.askThemeChoice?.({ request: request() }))?.premium).toBe('soon')
    expect(payloadOf(items[0]).options.map((o) => o.id)).not.toContain('premium')
  })

  it('云上还没开 / 没登录工坊账号：高级主题那一行「即将开放」/「登录后可买」，不能选', async () => {
    cloudMode = 'missing'
    const t = make()
    expect((await t.askThemeChoice?.({ request: request() }))?.premium).toBe('soon')
    expect(payloadOf(items[0]).options.map((o) => o.id)).toEqual(['store:100001', 'store:100002'])
    expect(items[0]?.summary).toMatch(/即将开放/)
    linked = false
    cloudMode = 'ok'
    const t2 = make()
    expect((await t2.askThemeChoice?.({ request: request('mat_2') }))?.premium).toBe('soon')
    rmSync(join(dir, 'data', 'brand'), { recursive: true, force: true })
    items = []
    const t3 = make()
    expect((await t3.askThemeChoice?.({ request: request('mat_3') }))?.premium).toBe(
      'needs_account',
    )
  })
})
