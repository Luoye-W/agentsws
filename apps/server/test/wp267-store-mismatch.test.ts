/**
 * WP267（决策 164）：建站岗位自动定店——账号下**只有一家**，但与品牌档案里官网读到的（`shopify_domain`）不是同一家
 * → 多半登错了账号，**不自动定**；岗位页问「官网那家店不在这个账号下，要换个账号登录吗」（换个账号 / 就用这家）。
 * 假 `shopify` 是真脚本、真子进程（同 WP258）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { platformKitOf } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cliSessionEnv } from '../src/platform-cli-session.js'
import { createSiteTheme, type SiteThemeAssembly, STORE_LOOKUP_TEXT } from '../src/site-theme.js'
import { fakeThemeBase } from '../src/site-theme-stand-in.js'
import {
  type FakeOrg,
  type FakeShopifyTheme,
  writeFakeShopifyTheme,
} from './fixtures/fake-shopify-theme.js'

const T0 = '2026-10-07T09:00:00.000Z'
const WS = 'ws_rollout'
const ROLLOUT = '6suegp-md.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let cli: FakeShopifyTheme
let clock: { at: string }
let machine: { loggedIn: boolean; shops: string[]; site?: string }
let events: { type: string; payload: Record<string, unknown> }[]

const settingsFile = (): string => join(dir, 'data', 'brand', 'site-theme.json')

function make(): SiteThemeAssembly {
  const base = fakeThemeBase()
  return createSiteTheme({
    workspace_id: WS,
    clock: { now: () => clock.at },
    dataDir: join(dir, 'data'),
    settingsFile: settingsFile(),
    cliSpec: () => spec,
    probe: async () => ({
      installed: true,
      node_ok: true,
      min_node_major: 22,
      checked_at: clock.at,
      source: 'app' as const,
      version: '4.8.5',
    }),
    loggedIn: () => machine.loggedIn,
    invocation: () => ({ command: process.execPath, prefix: [cli.entry] }),
    sessionEnv: () => cliSessionEnv(join(dir, 'sessions', WS)),
    connectedShops: () => machine.shops,
    siteStore: () => machine.site,
    env: {
      ...process.env,
      AGENTSWS_SECRETS_KEY: 'never-leaks',
      SHOPIFY_CLI_THEME_TOKEN: 'shpat_x',
    },
    fetch: base.fetch,
    base: base.pin,
    ledger: { stage: async () => ({ ok: false, reason: 'unused' }) as never },
    effectiveConfig: () => {
      throw new Error('没有分配')
    },
    appendEvent: (type, payload) => events.push({ type, payload }),
  })
}

const ONE: FakeOrg[] = [
  { id: '111', name: 'My Store', stores: [{ store: ROLLOUT, name: 'My Store', plan: 'basic' }] },
]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wp267-store-'))
  mkdirSync(join(dir, 'bin'))
  cli = writeFakeShopifyTheme(join(dir, 'bin'))
  clock = { at: T0 }
  machine = { loggedIn: true, shops: [] }
  events = []
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('WP267 只有一家店但与官网不符', () => {
  it('不自动定：next = store，清单里就那一家，官网那家照实带出；AI 工具说「换个账号或就用这家」', async () => {
    cli.setOrgs(ONE)
    machine.site = 'inmo-official.myshopify.com'
    const t = make()
    const r = await t.readiness()
    expect(r.store).toBeUndefined()
    expect(r.next).toBe('store')
    expect(r.site_store).toBe('inmo-official.myshopify.com')
    expect(r.store_lookup).toMatchObject({ status: 'ok', stores: [{ store: ROLLOUT }] })
    expect(events.some((e) => e.type === 'site_theme.store_auto')).toBe(false)
    await expect(t.list()).rejects.toThrow(STORE_LOOKUP_TEXT.mismatch)
  })

  it('「就用这家」= 从清单里选（source: list），之后照常；再找一次也不被清掉', async () => {
    cli.setOrgs(ONE)
    machine.site = 'inmo-official.myshopify.com'
    const t = make()
    await t.readiness()
    const r = await t.setStore(ROLLOUT, { source: 'list' })
    expect(r).toMatchObject({ store: ROLLOUT, store_source: 'cli' })
    expect(r.next).toBeUndefined()
    await t.refreshStores({ relogin: true })
    expect((await t.readiness()).store).toBe(ROLLOUT)
  })

  it('「换个账号」登进官网那家所在的账号：自动定成官网那家', async () => {
    cli.setOrgs(ONE)
    machine.site = 'inmo-official.myshopify.com'
    const t = make()
    expect((await t.readiness()).store).toBeUndefined()
    cli.setOrgs([
      {
        id: '444',
        name: 'INMO',
        stores: [{ store: 'inmo-official.myshopify.com', name: 'INMO', plan: 'Shopify' }],
      },
    ])
    await t.refreshStores({ relogin: true })
    expect((await t.readiness()).store).toBe('inmo-official.myshopify.com')
  })

  it('官网没读到店（档案里没有 shopify_domain）/ 官网就是这一家：照旧只有一家就定它', async () => {
    cli.setOrgs(ONE)
    expect((await make().readiness()).store).toBe(ROLLOUT)
    rmSync(join(dir, 'data'), { recursive: true, force: true })
    machine.site = ROLLOUT
    expect((await make().readiness()).store).toBe(ROLLOUT)
  })
})
