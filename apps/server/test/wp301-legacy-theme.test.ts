/**
 * WP301（决策 399 = A）：已经用旧的自带主题（agentsws-theme v0.9.x / v0.10）起过底的工作目录（Windows 上 Rollout 那一份）。
 *
 * 钉住：不删、不自动迁；运行里照实说「这份是旧的自带主题，工坊已改用 Horizon」；旧目录上不再改、不再推；
 * 下一次起底在 Horizon 上新起一份，旧目录整份挪去 `theme-work/<品牌>/legacy/` 原样留着、时间线记一句；
 * WP296 的升级卡不再出，以前出过的那张被点了只记一句「作废了」。
 *
 * `shopify theme …` 是进程内替身（线上那一份是手写的 Horizon 形状假主题），不联网、不碰任何真店。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalItem,
  type Assignment,
  platformKitOf,
  type RunRequest,
} from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { ProbeExec } from '../src/platform-cli.js'
import { cliSessionHome } from '../src/platform-cli-session.js'
import { createSiteTheme, type SiteThemeAssembly } from '../src/site-theme.js'
import { isThemeUpgradeCard, LEGACY_UPGRADE_CARD_VOID } from '../src/site-theme-legacy.js'
import {
  FAKE_LEGACY_THEME_FILES,
  themeCliStandIn,
  writeThemeFiles,
} from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'

const T0 = '2026-10-13T09:00:00.000Z'
const SHOP = '6suegp-md.myshopify.com'
const WS = 'ws_rollout'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let notes: { matter: string; text: string }[]
let events: { type: string; payload: Record<string, unknown> }[]

const request = (matter = 'mat_1'): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id: 'site.shopify-theme' },
    work_item: { id: matter, conversation_id: matter, role_id: 'site.shopify-theme' },
  }) as unknown as RunRequest

const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)
const settingsFile = (): string => join(dir, 'data', 'brand', 'site-theme.json')

/** 照 v0.10 那时候留下来的样子：工作目录 + 设置文件里记着从 agentsws-theme 起的底。 */
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
            commit: '236ef33de9f8d4409a4343a181088f7dc3e782b2',
            license: 'MIT',
            at: '2026-10-12T00:00:00.000Z',
          },
          pushes: [],
          upgrade_offer: {
            to: '0.10.0',
            approval_item_id: 'apv_old',
            at: '2026-10-12T00:00:00.000Z',
          },
        },
      },
    }),
  })
}

function make(cli: ReturnType<typeof themeCliStandIn>): SiteThemeAssembly {
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => T0 },
    dataDir: join(dir, 'data'),
    settingsFile: settingsFile(),
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 20, checked_at: T0 }),
    loggedIn: () => true,
    invocation: () => ({ command: 'shopify', prefix: [] }),
    connectedShops: () => [],
    run: cli.run,
    ledger: { stage: async () => ({ ok: false }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    noteMatter: (matter, text) => notes.push({ matter, text }),
    appendEvent: (type, payload) => events.push({ type, payload }),
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp301-legacy-'))
  notes = []
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('旧的自带主题那一份工作目录', () => {
  it('照实说一句、不迁不删；旧目录上不改不推；起底在 Horizon 上新起一份，旧的挪去 legacy/ 原样留着', async () => {
    seedLegacy()
    const cli = themeCliStandIn({ shop: SHOP })
    const t = make(cli)
    const exec = createThemeToolExecutor({ module: async () => t })

    // 岗位页 / 工具回话同一个判断：这份是旧的
    const view = await t.readiness()
    expect(view.workspace.legacy).toEqual({ theme: 'agentsws-theme', version: '0.10.0' })
    expect(view.workspace.base).toBeUndefined()

    // 每次回话都带一句（ok 的挂进 data；出错的接在原因后面）
    const files = await exec({ name: 'theme_files', input: {}, request: request() })
    expect(files.status).toBe('ok')
    const notice = (files.data as { base_legacy?: { message: string; version?: string } })
      .base_legacy
    expect(notice?.version).toBe('0.10.0')
    expect(notice?.message).toContain('工坊已改用 Shopify 官方的 Horizon')
    expect(notice?.message).toContain('不删、不迁')
    const write = await exec({
      name: 'theme_write_file',
      input: { path: 'templates/index.json', content: '{}' },
      request: request(),
    })
    expect(write.status).toBe('error')
    expect(write.reason).toContain('这一步没做')
    const push = await exec({
      name: 'theme_push_unpublished',
      input: { name: 'v2' },
      request: request(),
    })
    expect(push.status).toBe('error')
    expect(cli.calls.filter((c) => c[1] === 'push')).toEqual([])
    // 一个字节没动、一张升级卡都没出
    expect(readFileSync(join(themeDir(), 'templates', 'index.json'), 'utf8')).toBe(
      FAKE_LEGACY_THEME_FILES['templates/index.json'],
    )
    expect(events.some((e) => e.type.includes('upgrade_offered'))).toBe(false)

    // 起底：不用 replace，旧的整份挪去 legacy/（不删），在 Horizon 上新起一份
    const init = await exec({ name: 'theme_init_from_base', input: {}, request: request() })
    expect(init.status).toBe('ok')
    expect(init.data).toMatchObject({
      ok: true,
      legacy_moved: true,
      moved_aside: true,
      theme: { name: 'Horizon' },
      source: { theme_id: '100001', live: true },
    })
    expect((init.data as { base_legacy?: unknown }).base_legacy).toBeUndefined()
    const legacyRoot = join(dir, 'data', 'theme-work', WS, 'legacy')
    const [moved] = readdirSync(legacyRoot)
    expect(moved).toMatch(
      new RegExp(`^${SHOP.replace(/\./g, '\\.')}-agentsws-theme-v0\\.10\\.0-\\d+$`),
    )
    for (const [rel, body] of Object.entries(FAKE_LEGACY_THEME_FILES))
      expect(readFileSync(join(legacyRoot, moved ?? '', rel), 'utf8')).toBe(body)
    expect(existsSync(join(themeDir(), 'sections', 'custom-banner.liquid'))).toBe(false)
    expect(existsSync(join(themeDir(), 'CATALOG.index.json'))).toBe(true)
    expect(notes).toEqual([
      {
        matter: 'mat_1',
        text: expect.stringContaining('旧的自带主题（agentsws-theme v0.10.0）那份工作目录原样留着'),
      },
    ])
    // 设置文件里记下挪去了哪；没定的旧升级卡那一格不再用
    const saved = JSON.parse(readFileSync(settingsFile(), 'utf8')) as {
      stores: Record<string, { base: { repo: string }; legacy: { moved_to: string }[] }>
    }
    expect(saved.stores[SHOP]?.base.repo).toBe('Shopify/horizon')
    expect(saved.stores[SHOP]?.legacy[0]?.moved_to).toBe(join(legacyRoot, moved ?? ''))

    // 之后照常：不再带那一句，能改能推
    expect((await t.readiness()).workspace.legacy).toBeUndefined()
    const after = await exec({ name: 'theme_files', input: {}, request: request() })
    expect((after.data as { base_legacy?: unknown }).base_legacy).toBeUndefined()
    expect(
      (
        await exec({
          name: 'theme_push_unpublished',
          input: { name: 'Rollout 首页 v2' },
          request: request(),
        })
      ).status,
    ).toBe('ok')
  })

  it('只认得出工作目录（设置文件里没记）也算旧的；拉线上那一份前先把它挪开', async () => {
    writeThemeFiles(themeDir(), FAKE_LEGACY_THEME_FILES)
    const cli = themeCliStandIn({ shop: SHOP })
    const t = make(cli)
    await t.setStore(SHOP)
    expect((await t.legacyNotice())?.version).toBe('0.10.0')
    await t.pull({})
    expect(await t.legacyNotice()).toBeUndefined()
    expect(readdirSync(join(dir, 'data', 'theme-work', WS, 'legacy'))).toHaveLength(1)
    expect((await t.readiness()).workspace.base).toMatchObject({ repo: 'Shopify/horizon' })
  })

  it('WP296 出过的升级卡被点了：什么都不升，只记一句作废了', async () => {
    seedLegacy()
    const cli = themeCliStandIn({ shop: SHOP })
    const t = make(cli)
    const card = {
      id: 'apv_old',
      workspace_id: WS,
      kind: 'upstream_upgrade',
      state: 'approved',
      subject: { object: { type: 'theme_workspace', id: SHOP }, matter_id: 'mat_9' },
      payload: { upstream_id: 'agentsws-theme', from: '0.9.2', to: '0.10.0', store: SHOP },
    } as unknown as ApprovalItem
    expect(isThemeUpgradeCard(card)).toBe(true)
    expect(
      isThemeUpgradeCard({ kind: 'upstream_upgrade', payload: { upstream_id: 'dsh' } } as never),
    ).toBe(false)
    await t.onUpgradeDecided(card)
    expect(notes).toEqual([{ matter: 'mat_9', text: LEGACY_UPGRADE_CARD_VOID }])
    expect(cli.calls).toEqual([])
    expect(readFileSync(join(themeDir(), 'templates', 'index.json'), 'utf8')).toBe(
      FAKE_LEGACY_THEME_FILES['templates/index.json'],
    )
    // 别的品牌的卡不归它
    await t.onUpgradeDecided({ ...card, workspace_id: 'ws_other' } as ApprovalItem)
    expect(notes).toHaveLength(1)
  })
})

describe('真装配线（stub）：Rollout 那份旧目录上说「首页再改一版」', () => {
  let server: Server | undefined
  afterEach(async () => {
    await server?.close()
    server = undefined
  })

  it('照实说一句 → 当场在 Horizon 上新起一份 → 检查 → 推未发布预览；旧的那份原样留着', async () => {
    const fake = themeCliStandIn()
    const exec: ProbeExec = async (bin) =>
      bin === 'node'
        ? { ok: true, stdout: 'v22.12.0' }
        : { ok: true, stdout: 'Current Shopify CLI version: 4.8.5' }
    const dbDir = join(dir, 'db')
    const s = await createServer({
      quiet: true,
      clock: { now: () => T0 },
      random: () => 0.42,
      scheduleIntervalMs: 0,
      tokenRefreshIntervalMs: 0,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      env: { AGENTSWS_OWNER_EMAIL: 'owner@example.test' },
      dbDir,
      platformCliExec: exec,
      siteTheme: { run: fake.run },
    })
    server = s
    const ws = s.bootstrap.workspace.id
    const theme: Assignment = s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: ws,
      role_id: 'site.shopify-theme',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: ws }],
    })
    const call = async (as: string, method: string, path: string, body?: unknown) => {
      const headers = new Headers({ Authorization: `Bearer ${s.bootstrap.internalToken}` })
      headers.set('X-Assignment', as)
      if (body !== undefined) headers.set('content-type', 'application/json')
      const res = await s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
      const parsed = (await res.json()) as { data?: unknown }
      if (parsed.data === undefined)
        throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(parsed)}`)
      return parsed.data
    }
    await call(s.bootstrap.ownerAssignment.id, 'PUT', '/v1/workspace/profile', {
      legal_name: 'Rollout',
      storefront_platform: 'shopify',
    })
    await call(theme.id, 'GET', '/v1/site/theme?fresh=1')
    await call(theme.id, 'PUT', '/v1/platform-kit/cli/login', { confirmed: true })
    // 一键登录在本品牌那一份 CLI 会话目录里登（替身不跑真登录，这里把那个目录建出来）
    mkdirSync(cliSessionHome(join(dbDir, 'tools'), spec.id, ws), { recursive: true })
    await call(theme.id, 'PUT', '/v1/site/theme/store', { store: SHOP })
    // v0.10 那时候起过底的工作目录（设置文件里没记也认得出）
    const root = join(dbDir, 'themes', ws, SHOP)
    writeThemeFiles(root, FAKE_LEGACY_THEME_FILES)
    const view = (await call(theme.id, 'GET', '/v1/site/theme')) as {
      workspace: { legacy?: { version?: string } }
    }
    expect(view.workspace.legacy?.version).toBe('0.10.0')

    const out = (await call(theme.id, 'POST', `/v1/positions/${theme.id}/matters`, {
      title: '首页再改一版出预览',
      role_id: 'site.shopify-theme',
    })) as { matter: { id: string }; run_id?: string }
    const matter = (await call(theme.id, 'GET', `/v1/matters/${out.matter.id}`)) as {
      timeline: { kind: string; text: string; preview?: { url: string } }[]
    }
    const reply = matter.timeline.find((e) => e.kind === 'agent_message')?.text ?? ''
    expect(reply).toContain('旧的自带主题（agentsws-theme v0.10.0）')
    expect(reply).toContain('这次在 Horizon 上新起了一份')
    expect(reply).toContain('预览好了')
    expect(matter.timeline.some((e) => e.text.includes('原样留着（挪到一边了，没删、没迁）'))).toBe(
      true,
    )
    expect(matter.timeline.find((e) => e.preview !== undefined)?.preview?.url).toContain(
      'preview_theme_id=',
    )
    // 旧的那份原样在 legacy/ 下；店里多了一份复制出来的 Horizon（推预览推到它上面），线上没动
    const legacyRoot = join(dbDir, 'theme-work', ws, 'legacy')
    expect(readdirSync(legacyRoot)).toHaveLength(1)
    expect(fake.themes.filter((t) => t.role === 'unpublished')).toHaveLength(1)
    expect(fake.themes.find((t) => t.role === 'main')?.id).toBe('100001')
    expect(fake.calls.filter((c) => c[1] === 'publish')).toEqual([])
    // 一张升级卡都没出
    const pending = await s.txn.approvals.queue({
      workspace_id: ws,
      person_id: s.bootstrap.person.id,
      lane: 'mine',
    })
    expect(pending.filter((a) => a.kind === 'upstream_upgrade')).toEqual([])
  }, 60_000)
})
