/**
 * WP446（docs/109 §4.4 S5）：建站补「改跳转」（`shop_save_redirects` → `url_redirect`）。
 *
 * 钉住：
 * - 出卡不碰店，卡上记着每条旧路径**原来**跳到哪；
 * - 批了才改（建 / 改 / 删），改完读回核对；卡出来之后有人在后台动过 → 一条都不改；
 * - 撤回：账本反向（before / after 对调）再执行一次就回到原样；
 * - guardrail：跳到自己、跳转链 block，超过额度转人审；
 * - 只有建站有这个工具；替身剧本（没接模型时）说一句「跳转」就出一张卡。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type EffectiveConfig,
  platformKitOf,
  type RunRequest,
  type StagedChange,
  type WorkspaceId,
} from '@agentsws/contracts'
import { evaluateGuardrail } from '@agentsws/core'
import { redirectBranch, SHOP_SAVE_REDIRECTS_TOOL, shopToolsFor } from '@agentsws/stand-ins'
import type { StageInput } from '@agentsws/txn'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executorOf } from '../src/execution/registry.js'
import {
  demoRedirects,
  demoShop,
  type FakeShop,
  shopAdminRunStandIn,
  shopAuthSpawnStandIn,
} from '../src/shop-admin-stand-in.js'
import {
  createShopAdmin,
  createStoreAuthRunner,
  type ShopAdminAssembly,
  type StoreAuthRunner,
} from '../src/shop-auth.js'
import type { ShopOps } from '../src/shop-ops.js'
import { createShopOps } from '../src/shop-service.js'

const WS = 'ws_wp446' as WorkspaceId
const SHOP = 'rovella-test.myshopify.com'
const spec = platformKitOf('shopify')?.cli
if (spec === undefined) throw new Error('shopify 那一行没有 CLI')

let dir: string
let shop: FakeShop
let runner: StoreAuthRunner
let auth: ShopAdminAssembly
let ops: ShopOps
let staged: StageInput[]

const config = (): EffectiveConfig =>
  ({
    actions: [
      {
        id: 'stage_url_redirect',
        mandate: { caps: { max_redirects_per_change: 20 } },
        route_to: 'scope_manager',
      },
    ],
    automation: { stage_url_redirect: { level: 'L1' } },
  }) as unknown as EffectiveConfig
const req = (role_id = 'site.shopify-build', id = 'run_1'): RunRequest =>
  ({
    id,
    actor: { person_id: 'per_owner', assignment_id: `asg_${role_id}`, role_id },
  }) as unknown as RunRequest
const changeOf = (i: number): StagedChange =>
  ({
    id: `chg_${i}`,
    workspace_id: WS,
    kind: staged[i]?.kind,
    target: staged[i]?.target,
    before: staged[i]?.before,
    after: staged[i]?.after,
  }) as unknown as StagedChange
/** 账本反向那一下（`ChangeLedgerImpl.reverse`）：before / after 对调、新 id。 */
const reversalOf = (c: StagedChange, id: string): StagedChange =>
  ({ ...c, id, before: c.after, after: c.before, reversal_of: c.id }) as unknown as StagedChange
const targetOf = (path: string): string | undefined =>
  shop.redirects?.find((r) => r.path === path)?.target

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp446-'))
  mkdirSync(join(dir, 'brand'), { recursive: true })
  shop = demoShop()
  shop.redirects = demoRedirects()
  staged = []
  runner = createStoreAuthRunner({
    now: () => new Date().toISOString(),
    spawn: shopAuthSpawnStandIn(shop, { delayMs: 5 }),
  })
  auth = createShopAdmin({
    workspace_id: WS,
    clock: { now: () => new Date().toISOString() },
    cliSpec: () => spec,
    probe: async () => ({ installed: true, node_ok: true, min_node_major: 22, checked_at: '' }),
    invocation: () => ({ command: 'node', prefix: ['shopify.js'] }),
    store: async () => SHOP,
    setStore: async () => undefined,
    install: () => undefined,
    installJob: () => undefined,
    auth: runner,
    run: shopAdminRunStandIn(shop),
    brandRoles: () => ['site.shopify-build'],
  })
  ops = createShopOps({
    workspace_id: WS,
    clock: { now: () => new Date().toISOString() },
    auth,
    ledger: {
      stage: async (input) => {
        staged.push(input)
        return {
          ok: true,
          change: { id: `chg_${staged.length - 1}` },
          approval: { id: `apr_${staged.length - 1}` },
        } as never
      },
    },
    effectiveConfig: config,
    fileRoots: () => [join(dir, 'brand')],
    stateFile: join(dir, 'brand', 'shop-ops.json'),
  })
  await auth.run('authorize', ['site.shopify-build'])
  for (let i = 0; i < 100 && (await auth.view(['site.shopify-build'])).state !== 'authorized'; i++)
    await new Promise((r) => setTimeout(r, 10))
})
afterEach(() => {
  runner.dispose()
  rmSync(dir, { recursive: true, force: true })
})

describe('改跳转：出卡 → 批 → 执行 → 撤回（docs/109 §4.4）', () => {
  it('出卡不碰店、卡上记着原来跳到哪；批了才建；撤回再执行一次就没了', async () => {
    const out = await ops.propose(
      SHOP_SAVE_REDIRECTS_TOOL,
      { redirects: [{ path: '/pages/old-faq', target: '/pages/faq' }] },
      req(),
    )
    expect(out.status).toBe('staged')
    const card = staged[0] as StageInput
    expect(card.kind).toBe('url_redirect')
    expect(card.level).toBe('L1')
    expect(card.approval.title).toBe('改跳转：/pages/old-faq → /pages/faq')
    expect(card.approval.summary).toContain('原来：没有跳转')
    // 卡面只看人话那一行；给执行器的那一份改名成 `_` 开头
    expect(card.after).toMatchObject({ redirect: '/pages/old-faq → /pages/faq', count: 1 })
    expect(card.before).toMatchObject({ _redirects: [{ path: '/pages/old-faq', target: '' }] })
    expect(targetOf('/pages/old-faq')).toBeUndefined()
    // 执行器认得出这一张（建站经店铺工具出的卡）
    expect(executorOf(changeOf(0))?.id).toBe('shop.ops')

    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(targetOf('/pages/old-faq')).toBe('/pages/faq')

    // 撤回：账本反向那一条（before / after 对调）→ 执行器删掉这条跳转、读回核对
    expect(await ops.apply(reversalOf(changeOf(0), 'chg_rev'))).toMatchObject({ status: 'ok' })
    expect(targetOf('/pages/old-faq')).toBeUndefined()
  })

  it('改一条已有的跳转：before 记旧目标，撤回就改回旧目标', async () => {
    expect(targetOf('/blogs/news/old-guide')).toBe('/blogs/news/guide')
    await ops.propose(
      SHOP_SAVE_REDIRECTS_TOOL,
      { redirects: [{ path: '/blogs/news/old-guide', target: '/blogs/news/guide-2026' }] },
      req(),
    )
    expect(staged[0]?.approval.summary).toContain('原来：/blogs/news/guide')
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(targetOf('/blogs/news/old-guide')).toBe('/blogs/news/guide-2026')
    expect(await ops.apply(reversalOf(changeOf(0), 'chg_rev'))).toMatchObject({ status: 'ok' })
    expect(targetOf('/blogs/news/old-guide')).toBe('/blogs/news/guide')
  })

  it('目标留空 = 撤掉这条跳转（也出卡）；已经是这样了就不出卡', async () => {
    await ops.propose(
      SHOP_SAVE_REDIRECTS_TOOL,
      { redirects: [{ path: '/blogs/news/old-guide', target: '' }] },
      req(),
    )
    expect(staged[0]?.approval.title).toBe('撤掉跳转：/blogs/news/old-guide')
    expect(await ops.apply(changeOf(0))).toMatchObject({ status: 'ok' })
    expect(targetOf('/blogs/news/old-guide')).toBeUndefined()
    await expect(
      ops.propose(
        SHOP_SAVE_REDIRECTS_TOOL,
        { redirects: [{ path: '/blogs/news/old-guide', target: '' }] },
        req(),
      ),
    ).rejects.toThrow('不用出卡')
  })

  it('卡出来之后有人在后台改过这条跳转 → 一条都不改', async () => {
    await ops.propose(
      SHOP_SAVE_REDIRECTS_TOOL,
      {
        redirects: [
          { path: '/pages/a', target: '/pages/b' },
          { path: '/blogs/news/old-guide', target: '/blogs/news/x' },
        ],
      },
      req(),
    )
    const row = shop.redirects?.find((r) => r.path === '/blogs/news/old-guide')
    if (row !== undefined) row.target = '/somewhere-else'
    const applied = await ops.apply(changeOf(0))
    expect(applied?.status).toBe('failed')
    expect(applied?.error?.message).toContain('变过')
    expect(targetOf('/pages/a')).toBeUndefined()
  })

  it('路径写法不对就不出卡（站内路径 / 开头；目标站内或 https）', async () => {
    await expect(
      ops.propose(
        SHOP_SAVE_REDIRECTS_TOOL,
        { redirects: [{ path: 'pages/a', target: '/b' }] },
        req(),
      ),
    ).rejects.toThrow('/ 开头')
    await expect(
      ops.propose(
        SHOP_SAVE_REDIRECTS_TOOL,
        { redirects: [{ path: '/a', target: 'http://x.example' }] },
        req(),
      ),
    ).rejects.toThrow('https://')
    expect(staged).toHaveLength(0)
  })

  it('只有建站能改跳转（SEO 与 GEO、店铺管理都没有这个工具）', async () => {
    const all = ['write_online_store_navigation', 'write_content', 'write_products']
    expect(shopToolsFor('site.shopify-build', all)).toContain(SHOP_SAVE_REDIRECTS_TOOL)
    expect(shopToolsFor('dtc.store', all)).not.toContain(SHOP_SAVE_REDIRECTS_TOOL)
    expect(shopToolsFor('dtc.seo', all)).not.toContain(SHOP_SAVE_REDIRECTS_TOOL)
    // 没有导航写权限就不摆出来
    expect(shopToolsFor('site.shopify-build', ['write_content'])).not.toContain(
      SHOP_SAVE_REDIRECTS_TOOL,
    )
    const out = await ops.propose(
      SHOP_SAVE_REDIRECTS_TOOL,
      { redirects: [{ path: '/a', target: '/b' }] },
      req('dtc.store'),
    )
    expect(out.status).toBe('blocked')
  })
})

describe('改跳转的 guardrail', () => {
  const check = (redirects: { path: string; target: string }[], cap = 20) =>
    evaluateGuardrail(
      {
        id: 'c',
        status: 'staged',
        kind: 'url_redirect',
        target: { type: 'url_redirect', id: redirects.map((r) => r.path).join(',') },
        before: {},
        after: { _redirects: redirects, count: redirects.length },
      } as never,
      { caps: { max_redirects_per_change: cap } },
      { changeSet: [], windowCount: 0, readFull: [] } as never,
      'stage',
    )
  const rules = (v: ReturnType<typeof check>, severity: 'block' | 'review') =>
    v.hits.filter((h) => h.severity === severity).map((h) => h.rule)

  it('跳到自己、跳转链 block；超过额度转人审；正常的放行', () => {
    expect(rules(check([{ path: '/a', target: '/b' }]), 'block')).toEqual([])
    expect(rules(check([{ path: '/a', target: '/a' }]), 'block')).toContain('url_redirect_self')
    expect(
      rules(
        check([
          { path: '/a', target: '/b' },
          { path: '/b', target: '/c' },
        ]),
        'block',
      ),
    ).toContain('url_redirect_chain')
    expect(rules(check([]), 'block')).toContain('url_redirect_empty')
    expect(
      rules(
        check(
          [
            { path: '/a', target: '/x' },
            { path: '/b', target: '/x' },
          ],
          1,
        ),
        'review',
      ),
    ).toContain('max_redirects_per_change')
  })
})

describe('替身剧本：说一句「跳转」就出一张改跳转卡', () => {
  const run = (allow: string[]) => ({ tools: { allow } }) as unknown as RunRequest
  it('话里写了两条路径 → 前一条跳到后一条；没写 → 演示店那一条；工具面里没有就不走', () => {
    expect(
      redirectBranch(run([SHOP_SAVE_REDIRECTS_TOOL]), '把 /pages/old-faq 跳转到 /pages/faq'),
    ).toEqual([
      {
        tool: SHOP_SAVE_REDIRECTS_TOOL,
        input: { redirects: [{ path: '/pages/old-faq', target: '/pages/faq' }] },
      },
    ])
    expect(
      redirectBranch(run([SHOP_SAVE_REDIRECTS_TOOL]), '旧 FAQ 页加个跳转')?.[0]?.input,
    ).toEqual({ redirects: [{ path: '/pages/old-faq', target: '/pages/faq' }] })
    expect(redirectBranch(run([]), '加个跳转')).toBeUndefined()
    expect(redirectBranch(run([SHOP_SAVE_REDIRECTS_TOOL]), '把导航理一遍')).toBeUndefined()
  })
})
