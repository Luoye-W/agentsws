/**
 * WP311（决策 480，高级主题 v0.11.0 已上架）：工作目录是**旧的自带主题**（WP301 之前从 agentsws-theme 起底的，Rollout 那种）时，
 * 第一次起底 / 说「换主题」不再直接复制 Horizon，照 WP304 出**选主题卡**（高级主题一行 + 店里已装主题）。
 *
 * 钉住：出卡就停、店里与工作目录一个字节不动；选了店里的主题 → 新起一份未发布的、旧目录挪去 legacy/ 原样留着、线上不动；
 * 已买高级主题的店那一行「已买」，选了直接下载（不出花钱卡、不扣）；没接审批总线时照 WP301 老路（Horizon）。
 *
 * 店里的主题是进程内替身，高级主题的云是替身（包是手写的占位主题）；不联网、不花钱、不碰任何真店。
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
  FAKE_LEGACY_THEME_FILES,
  FAKE_OS2_THEME_FILES,
  themeCliStandIn,
  writeThemeFiles,
} from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'

const T0 = '2026-10-14T09:00:00.000Z'
const SHOP = '6suegp-md.myshopify.com'
const WS = 'ws_rollout'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let fake: ReturnType<typeof themeCliStandIn>
let items: ApprovalItem[]
let notes: { matter: string; text: string }[]
let resumed: { matter_id: string }[]
let credits: number
let cloud: ReturnType<typeof premiumThemeStandIn>

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

const decided = (item: ApprovalItem, option?: string): ApprovalItem => {
  const out = {
    ...item,
    state: 'approved',
    decision: {
      action: 'approve',
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
  const out = cloud.handle(init?.method ?? 'GET', url.pathname, url.searchParams, body) ?? {
    status: 404,
    body: { code: 'not_found', message: 'no route' },
  }
  const lower = new Map(Object.entries(out.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
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

function make(opts: { bus?: boolean } = {}): SiteThemeAssembly {
  const secrets = {
    available: true,
    get: () => ({ token: 'wst_test' }),
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
    noteMatter: (matter, text) => notes.push({ matter, text }),
    ...(opts.bus === false ? {} : { approvals: () => bus }),
    premium: createPremiumThemeClient({
      secrets,
      baseUrl: 'https://cloud.test',
      tokenSecretId: 'cloud.workspace_token',
      fetch: premiumFetch,
    }),
    resume: async (input) => {
      resumed.push({ matter_id: input.matter_id })
    },
  })
}

const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)
const legacyRoot = (): string => join(dir, 'data', 'theme-work', WS, 'legacy')
const payloadOf = (item: ApprovalItem | undefined): ThemeChoicePayload =>
  item?.payload as ThemeChoicePayload

/** v0.10 那时候留下来的样子：工作目录 + 设置文件里记着从 agentsws-theme 起的底。 */
function seedLegacy(): void {
  writeThemeFiles(themeDir(), FAKE_LEGACY_THEME_FILES)
  writeThemeFiles(join(dir, 'data', 'brand'), {
    'site-theme.json': JSON.stringify({
      version: 1,
      store: SHOP,
      store_by: 'manual',
      stores: {
        [SHOP]: {
          base: {
            repo: 'Luoye-W/agentsws-theme',
            version: '0.10.0',
            commit: '0000000',
            license: 'MIT',
            at: '2026-10-12T00:00:00.000Z',
          },
          pushes: [],
        },
      },
    }),
  })
}

/** 旧目录一个字节没动。 */
const legacyUntouched = (): void => {
  for (const [rel, body] of Object.entries(FAKE_LEGACY_THEME_FILES))
    expect(readFileSync(join(themeDir(), rel), 'utf8')).toBe(body)
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp311-legacy-'))
  fake = themeCliStandIn({
    shop: SHOP,
    themes: [
      { id: '100002', name: 'Lumen', role: 'unpublished', files: { ...FAKE_OS2_THEME_FILES } },
    ],
  })
  items = []
  notes = []
  resumed = []
  credits = 1000
  cloud = premiumThemeStandIn({
    available: () => credits,
    spend: (n) => {
      credits -= n
    },
  })
  seedLegacy()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('WP311 / 480：旧的自带主题那一份也出选主题卡', () => {
  it('起底不说用哪套（不用说换主题）：出卡就停——高级主题排第一 + 店里已装的；店里、旧目录一个字节不动', async () => {
    const t = make()
    const exec = createThemeToolExecutor({ module: async () => t })
    const out = await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect(out.status).toBe('ok')
    const data = out.data as { ok: boolean; choice?: { premium: string }; base_legacy?: unknown }
    expect(data.ok).toBe(false)
    expect(data.choice?.premium).toBe('buy')
    // 还是旧目录：回话里照实带那一句（说的是先出选主题卡，不是直接复制 Horizon）
    expect(JSON.stringify(data.base_legacy)).toContain('选主题卡')
    expect(items).toHaveLength(1)
    expect(items[0]?.kind).toBe('theme_choice')
    expect(payloadOf(items[0]).options.map((o) => o.id)).toEqual([
      'premium',
      'store:100001',
      'store:100002',
    ])
    expect(fake.calls.some((c) => c[1] === 'duplicate')).toBe(false)
    expect(existsSync(legacyRoot())).toBe(false)
    legacyUntouched()
    // 再叫一次：同一张卡
    await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect(items).toHaveLength(1)
  })

  it('选店里的免费主题：新起一份未发布的、旧目录挪去 legacy/ 原样留着、线上不动、按原话接着做', async () => {
    const t = make()
    await t.askThemeChoice?.({ request: request() })
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'store:100002'))
    const view = await t.readiness()
    expect(view.workspace.legacy).toBeUndefined()
    expect(view.workspace.base).toMatchObject({ theme_name: 'Lumen', source_theme_id: '100002' })
    const [moved] = readdirSync(legacyRoot())
    for (const [rel, body] of Object.entries(FAKE_LEGACY_THEME_FILES))
      expect(readFileSync(join(legacyRoot(), moved ?? '', rel), 'utf8')).toBe(body)
    expect(fake.themes.find((x) => x.role === 'main')?.files).toEqual(FAKE_HORIZON_FILES)
    expect(fake.calls.filter((c) => c[1] === 'publish')).toEqual([])
    const said = notes.map((n) => n.text).join('\n')
    expect(said).toContain('旧的自带主题（agentsws-theme v0.10.0）那份工作目录原样留着')
    expect(said).toContain('复制了一份「Lumen」')
    expect(said).toMatch(/用「Lumen」起好底了/)
    expect(resumed).toEqual([{ matter_id: 'mat_1' }])
    expect(await t.legacyNotice()).toBeUndefined()
  })

  it('已买高级主题的店：那一行「已买」，选了直接下载推未发布预览，不出花钱卡、不扣；旧目录挪开留着', async () => {
    cloud.handle('POST', '/v1/themes/premium/purchase', new URLSearchParams(), { shop: SHOP })
    credits = 1000
    const t = make()
    const asked = await t.askThemeChoice?.({ request: request() })
    expect(asked?.premium).toBe('owned')
    expect(payloadOf(items[0]).options[0]?.label).toContain('已买')
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'premium'))
    expect(items).toHaveLength(1)
    expect(credits).toBe(1000)
    expect(cloud.downloads()).toHaveLength(1)
    const view = await t.readiness()
    expect(view.workspace.base?.source).toBe('premium')
    expect(view.workspace.legacy).toBeUndefined()
    expect(readdirSync(legacyRoot())).toHaveLength(1)
    expect(fake.themes.find((x) => x.name.startsWith('高级主题'))?.role).toBe('unpublished')
    expect(fake.themes.find((x) => x.role === 'main')?.files).toEqual(FAKE_HORIZON_FILES)
    expect(notes.map((n) => n.text).join('\n')).toContain('这次装的是我们的高级主题')
    expect(resumed).toHaveLength(1)
  })

  it('没买：选高级主题 → 出花钱卡，点了才扣；没点之前旧目录不动', async () => {
    const t = make()
    await t.askThemeChoice?.({ request: request() })
    await t.onThemeCardDecided?.(decided(items[0] as ApprovalItem, 'premium'))
    expect(items[1]?.kind).toBe('theme_purchase')
    expect(credits).toBe(1000)
    legacyUntouched()
    await t.onThemeCardDecided?.(decided(items[1] as ApprovalItem))
    expect(credits).toBe(440)
    expect((await t.readiness()).workspace.base?.source).toBe('premium')
    expect(readdirSync(legacyRoot())).toHaveLength(1)
  })

  it('没接审批总线（出不了卡）：照 WP301 老路在 Horizon 上新起一份', async () => {
    const t = make({ bus: false })
    const out = await t.initFromBase({ request: request() })
    expect(out).toMatchObject({ legacy_moved: true, theme: { name: 'Horizon' } })
    expect(items).toEqual([])
    expect(notes.map((n) => n.text).join('\n')).toContain('Shopify 官方 Horizon')
  })
})
