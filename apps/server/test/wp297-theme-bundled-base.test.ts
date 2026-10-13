/**
 * WP297（决策 140 / 376）：起底时 GitHub 下不动 → 用安装包里随带的那一份（同一个 sha256），并在事项时间线照实记一句。
 *
 * 钉住的事：
 * - 先试网络（照旧）：网络好就用网络那一份，随包那一份碰都不碰、时间线不记；
 * - 网络失败 / 卡住超时 / 下来的校验不对 → 用随包那一份（核 sha256），回 `source: 'bundled'`，
 *   这件事的时间线上记一句「没从 GitHub 拿到（为什么），用的是安装包里随带的那一份」；
 * - 随包那一份 sha256 也不对 → 拒，一个文件都不放，时间线不记；
 * - 升级卡批了、新版那一份也是用随包的：升级那一句后面接上同一句。
 *
 * 起底包都是现造的假包（`fakeThemeBase`），不联网。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type ApprovalItem, platformKitOf, type RunRequest } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledBaseNote,
  createSiteTheme,
  type SiteThemeAssembly,
  type ThemeFetch,
} from '../src/site-theme.js'
import { FAKE_THEME_FILES, fakeThemeBase } from '../src/site-theme-stand-in.js'
import { createThemeToolExecutor } from '../src/theme-tools.js'

const SHOP = 'bundled-test.myshopify.com'
const WS = 'ws_bundled'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

const BASE = fakeThemeBase(FAKE_THEME_FILES, { version: '0.10.0', commit: `${'c'.repeat(39)}1` })

let dir: string
let notes: { matter: string; text: string }[]
let events: { type: string; payload: Record<string, unknown> }[]
let cards: ApprovalItem[]

const request = (): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_owner', assignment_id: 'asg_theme', role_id: 'site.shopify-theme' },
    work_item: { id: 'mat_7', conversation_id: 'mat_7', role_id: 'site.shopify-theme' },
  }) as unknown as RunRequest

const bundledDir = (): string => join(dir, 'resources', 'theme-base')
const bundledFile = (pin = BASE.pin): string =>
  join(bundledDir(), `agentsws-theme-${pin.commit}.tgz`)
const themeDir = (): string => join(dir, 'data', 'themes', WS, SHOP)

const offline: ThemeFetch = async () => {
  throw new Error('getaddrinfo ENOTFOUND codeload.github.com')
}

function make(
  fetch: ThemeFetch,
  extra: Partial<Parameters<typeof createSiteTheme>[0]> = {},
): SiteThemeAssembly {
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => '2026-10-13T09:00:00.000Z' },
    dataDir: join(dir, 'data'),
    settingsFile: join(dir, 'data', 'brand', 'site-theme.json'),
    cliSpec: () => spec,
    probe: async () => ({
      installed: true,
      node_ok: true,
      min_node_major: 20,
      checked_at: '2026-10-13T09:00:00.000Z',
    }),
    loggedIn: () => true,
    invocation: () => ({ command: 'shopify', prefix: [] }),
    connectedShops: () => [],
    fetch,
    base: BASE.pin,
    localBaseDir: bundledDir(),
    ledger: { stage: async () => ({ ok: false, message: 'no' }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    approvals: () => ({
      create: async (input: never) => {
        const item = {
          ...(input as object),
          id: `apv_${cards.length + 1}`,
          state: 'pending',
        } as unknown as ApprovalItem
        cards.push(item)
        return item as never
      },
    }),
    noteMatter: (matter, text) => notes.push({ matter, text }),
    appendEvent: (type, payload) => events.push({ type, payload }),
    ...extra,
  })
}

/** 经主题工具起底（运行里就是这么起的：带着这次运行与它的事项）。 */
async function initViaTool(t: SiteThemeAssembly) {
  await t.setStore(SHOP)
  const exec = createThemeToolExecutor({ module: async () => t })
  return exec({ name: 'theme_init_from_base', input: {}, request: request() })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp297-theme-'))
  notes = []
  events = []
  cards = []
  mkdirSync(bundledDir(), { recursive: true })
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('起底：先试网络，不行再用安装包里随带的那一份', () => {
  it('网络好：用网络那一份；随包那一份不碰、时间线不记', async () => {
    writeFileSync(bundledFile(), 'never read')
    const res = await initViaTool(make(BASE.fetch))
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({ ok: true, source: 'github' })
    expect(notes).toEqual([])
    expect(events.find((e) => e.type === 'site_theme.base_local')).toBeUndefined()
  })

  it('网络失败 → 用随包那一份（核过 sha256）；回 source=bundled；事项时间线照实记一句', async () => {
    writeFileSync(bundledFile(), BASE.tgz)
    const res = await initViaTool(make(offline))
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({ ok: true, source: 'bundled', base: { version: '0.10.0' } })
    expect(existsSync(join(themeDir(), 'LICENSE'))).toBe(true)
    expect(notes).toEqual([{ matter: 'mat_7', text: bundledBaseNote('0.10.0', 'GitHub 下不动') }])
    expect(notes[0]?.text).toBe(
      '开源主题这次没从 GitHub 拿到（GitHub 下不动），用的是安装包里随带的那一份 v0.10.0，和钉死的那一版核对过、一致。',
    )
    expect(events.find((e) => e.type === 'site_theme.base_local')?.payload).toMatchObject({
      reason: 'network',
    })
    expect(events.find((e) => e.type === 'site_theme.initialized')?.payload).toMatchObject({
      source: 'bundled',
    })
  })

  it('网络卡住不动 → 超时后用随包那一份，时间线写「N 秒没下完」', async () => {
    writeFileSync(bundledFile(), BASE.tgz)
    const hang: ThemeFetch = () => new Promise(() => undefined)
    const t = make(hang, { baseFetchTimeoutMs: 1000 })
    const started = Date.now()
    const res = await initViaTool(t)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(res.data).toMatchObject({ source: 'bundled' })
    expect(notes[0]?.text).toContain('GitHub 1 秒没下完')
  })

  it('网络那一份校验不对 → 用随包那一份，时间线写「对不上」', async () => {
    writeFileSync(bundledFile(), BASE.tgz)
    const tampered: ThemeFetch = async () => ({
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode('swapped').buffer as ArrayBuffer,
    })
    const res = await initViaTool(make(tampered))
    expect(res.data).toMatchObject({ source: 'bundled' })
    expect(notes[0]?.text).toContain('从 GitHub 下来的和钉死的那一版对不上')
    expect(events.find((e) => e.type === 'site_theme.base_local')?.payload).toMatchObject({
      reason: 'integrity',
    })
  })

  it('随包那一份 sha256 不对 → 拒：一个文件都不放、时间线不记', async () => {
    writeFileSync(bundledFile(), Buffer.concat([BASE.tgz, Buffer.from('x')]))
    const res = await initViaTool(make(offline))
    expect(res.status).toBe('error')
    expect(res.reason).toMatch(/下不来开源主题/)
    expect(readdirSync(themeDir())).toEqual([])
    expect(notes).toEqual([])
    expect(events.map((e) => e.type)).toContain('site_theme.base_local_rejected')
  })

  it('没有随包那一份（开发期）：照旧只从 GitHub 下，下不动就照实报错', async () => {
    const res = await initViaTool(make(offline))
    expect(res.status).toBe('error')
    expect(res.reason).toMatch(/下不来开源主题 agentsws-theme（getaddrinfo ENOTFOUND/)
  })

  it('升级卡批了、新版那一份用的是随包的：升级那一句后面接上同一句', async () => {
    const OLD = fakeThemeBase(FAKE_THEME_FILES, { version: '0.9.2', commit: `${'9'.repeat(39)}2` })
    const old = make(OLD.fetch, { base: OLD.pin })
    await old.setStore(SHOP)
    await old.initFromBase({})
    writeFileSync(bundledFile(), BASE.tgz)
    const t = make(offline)
    await t.baseUpgrade(request())
    expect(cards).toHaveLength(1)
    await t.onUpgradeDecided({
      ...(cards[0] as ApprovalItem),
      state: 'approved',
      workspace_id: WS,
    } as ApprovalItem)
    expect((await t.readiness()).workspace.base?.version).toBe('0.10.0')
    expect(notes).toHaveLength(1)
    expect(notes[0]?.text).toMatch(/^主题升到 v0\.10\.0 了/)
    expect(notes[0]?.text).toContain(bundledBaseNote('0.10.0', 'GitHub 下不动'))
  })
})
