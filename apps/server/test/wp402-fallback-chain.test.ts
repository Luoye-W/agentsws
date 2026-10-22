/**
 * WP402（决策 1140 / 1146）：服务端那一半的取数链——
 *
 * - 独立站：直接读、内置浏览器都被挡 → 工坊云端代读（`shop.page`，按次扣积分、只认公开数据地址）→ 你自己的浏览器；
 *   每次结果记下走了哪条路（连接卡那一行）；
 * - 你自己的浏览器（BrowserSkill 的四个读动作）：开窗口 → 打开 → 读回原文（数据页取 `<pre>`）→ 闲了关掉；
 * - Amazon 走你自己的浏览器：第一次出一张同意卡（只出一次）、同意后每家每天至多一次、设置里撤回就不用；
 * - 品牌级「被 Amazon 拦了」：竞品读页被拦，联想词那边同时不再用内置浏览器、换下一条路；反过来也一样。
 *
 * 全用录好的样本与替身，不连真网站、不调付费接口、不起真浏览器。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type {
  BrandWatch,
  CompetitorWatchSource,
  DataCallResult,
  WorkspaceId,
} from '@agentsws/contracts'
import { AMAZON_EXTENSION_CONSENT_TARGET } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  type AmazonOwnBrowserState,
  createAmazonBlock,
  createAmazonFrontReader,
  createAmazonOwnBrowser,
} from '../src/amazon-front/index.js'
import { createAmazonKeywordBank } from '../src/amazon-keywords/index.js'
import {
  createAmazonAsinAdapter,
  createCompetitorWatch,
  createCompetitorWatchDb,
  createShopCatalogAdapter,
  shopPageCloudRead,
} from '../src/competitor-watch/index.js'
import {
  type BskJson,
  createOwnBrowserReader,
  dataTextOfHtml,
  type OwnBrowserReader,
  type SearchBrowserChannel,
} from '../src/web-browser/index.js'

const WS = 'ws_wp402' as WorkspaceId
const NOW = '2026-10-19T01:30:00.000Z'
const SHOP_FIX = join(
  import.meta.dirname,
  '../../../packages/brand-intake/test/fixtures/shop-catalog',
)
const AMZ_FIX = join(
  import.meta.dirname,
  '../../../packages/brand-intake/test/fixtures/amazon-watch',
)
const shopFx = (n: string) => readFileSync(join(SHOP_FIX, n), 'utf8')
const amzFx = (n: string) => readFileSync(join(AMZ_FIX, n), 'utf8')
const RIVAL = 'https://rival-bikes.example'

const SHOP_SOURCE: CompetitorWatchSource = {
  id: 'cw_shop_c_rival',
  workspace_id: WS,
  kind: 'shop_catalog',
  url: RIVAL,
  platform: 'shopify',
  group: 'competitor',
  label: 'Rival Bikes',
  competitor_id: 'c_rival',
  every_hours: 24,
  status: 'ok',
} as unknown as CompetitorWatchSource

/** 云端代读替身：记下要读的地址，回录好的商品数据；每次 0.02 积分。 */
function shopCloud(answer: 'ok' | 'challenge' = 'ok') {
  const urls: string[] = []
  const port = {
    async call(capability: string, input: { input: Record<string, unknown> }) {
      expect(capability).toBe('shop.page')
      const url = String(input.input.url)
      urls.push(url)
      const text =
        answer === 'challenge'
          ? shopFx('cloudflare-challenge.html')
          : url.includes('all.atom')
            ? shopFx('shopify-all.atom')
            : shopFx('shopify-products-p1.json')
      return {
        capability,
        items: [{ status: answer === 'challenge' ? 403 : 200, final_url: url, text }],
        quantity: 1,
        credits: 0.02,
        cached: false,
        fetched_at: NOW,
        source: 'official',
      } satisfies DataCallResult
    },
  }
  return { urls, port }
}

const blockedFetch = async (url: string) => ({
  ok: false,
  status: 403,
  url,
  text: async () => '',
})
const challengeBrowser = async (url: string) => ({
  ok: true as const,
  status: 403,
  final_url: url,
  text: shopFx('cloudflare-challenge.html'),
  challenge: true,
})

describe('WP402 · 独立站：云端代读与你自己的浏览器', () => {
  it('直接读、内置浏览器都被挡：走工坊云端代读，扣的积分记上，走了哪条路记下', async () => {
    const cloud = shopCloud()
    const adapter = createShopCatalogAdapter({
      fetch: blockedFetch,
      browser: () => challengeBrowser,
      cloud: (onCredits) => shopPageCloudRead(cloud.port, onCredits),
    })
    const out = await adapter.read(SHOP_SOURCE, { workspace_id: WS, now: NOW })
    expect(out.via).toBe('cloud')
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.credits).toBeCloseTo(0.04)
    expect(cloud.urls).toEqual([
      `${RIVAL}/products.json?limit=250&page=1`,
      `${RIVAL}/collections/all.atom`,
    ])
    expect(out.attempts?.map((a) => `${a.route}:${a.outcome}`)).toEqual([
      'direct:blocked',
      'browser:blocked',
      'cloud:ok',
    ])
    expect(out.notes?.join('；')).toContain('工坊云端代读扣了 0.04 积分')
  })

  it('云端代读只认公开商品数据那几个地址：别的地址一个都不发', async () => {
    const cloud = shopCloud()
    const read = shopPageCloudRead(cloud.port)
    for (const bad of [
      'https://rival-bikes.example/account',
      'http://rival-bikes.example/products.json',
      'https://127.0.0.1/products.json',
      'https://intranet.local/products.json',
    ]) {
      const r = await read(bad)
      expect(r.ok).toBe(false)
    }
    expect(cloud.urls).toEqual([])
    expect((await read(`${RIVAL}/products.json?limit=1`)).ok).toBe(true)
  })

  it('云端也被挡：通过插件在你自己的浏览器里读；一轮下来连接卡那一格记下走了哪条路', async () => {
    const cloud = shopCloud('challenge')
    const own: string[] = []
    const extension = async (url: string) => {
      own.push(url)
      return {
        ok: true as const,
        status: 0,
        final_url: url,
        text: url.includes('atom')
          ? shopFx('shopify-all.atom')
          : shopFx('shopify-products-p1.json'),
      }
    }
    const adapter = createShopCatalogAdapter({
      fetch: blockedFetch,
      browser: () => challengeBrowser,
      cloud: (onCredits) => shopPageCloudRead(cloud.port, onCredits),
      extension: () => extension,
    })
    const db = createCompetitorWatchDb()
    const store = db.forWorkspace(WS)
    const watch: Pick<BrandWatch, 'brand' | 'competitors'> = {
      brand: { name: 'Ranger Bikes', aliases: [], domains: ['ranger.example'] },
      competitors: [
        {
          id: 'c_rival',
          name: 'Rival Bikes',
          aliases: [],
          domains: ['rival-bikes.example'],
          store: { url: RIVAL, platform: 'shopify' },
        },
      ] as never,
    }
    let seq = 0
    const cw = createCompetitorWatch({
      workspace_id: WS,
      store,
      now: () => NOW,
      newId: (p) => `${p}_${++seq}`,
      tzOffsetMinutes: () => 480,
      brandWatch: async () => watch,
      adapters: () => ({ shop_catalog: adapter }),
    })
    const run = await cw.runNow({ trigger: 'manual' })
    const part = run.parts[0]
    expect(part?.status).toBe('ok')
    expect(part?.via).toBe('extension')
    expect(part?.attempts?.map((a) => a.route)).toEqual(['direct', 'browser', 'cloud', 'extension'])
    const src = cw.sources().find((s) => s.kind === 'shop_catalog')
    expect(src?.last_via).toBe('extension')
    expect(src?.last_attempts?.at(-1)).toEqual({ route: 'extension', outcome: 'ok' })
    expect(own[0]).toContain('/products.json')
  })
})

/* ── 你自己的浏览器（BrowserSkill 的四个读动作）──────────────────────────── */

function fakeBsk(pages: Record<string, string>, fail?: string) {
  const calls: string[][] = []
  const prepared = new Set<string>()
  const bsk: BskJson = async (args) => {
    calls.push(args)
    const [cmd, sub] = args
    // bsk 0.3.3：开窗口前必须先 `session request <id> --prepare`，否则报 not prepared
    if (cmd === 'session' && sub === 'request' && args[3] === '--prepare') {
      prepared.add(args[2] as string)
      return { state: 'prepared', request_id: args[2] }
    }
    if (cmd === 'session' && sub === 'start') {
      if (!prepared.has(args[3] as string)) throw new Error('request is not prepared')
      return { session_id: 'sess_1' }
    }
    if (cmd === 'session' && sub === 'stop') return { ok: true }
    if (cmd === 'navigate') {
      const url = args.at(-1) as string
      if (fail !== undefined && url.includes(fail)) throw new Error('extension not connected')
      return { tab_id: 7, url, final_url: url }
    }
    if (cmd === 'get-html') {
      const last = [...calls]
        .reverse()
        .find((c) => c[0] === 'navigate')
        ?.at(-1) as string
      return { tab_id: 7, html: pages[last] ?? '<html><body></body></html>', truncated: false }
    }
    throw new Error(`没想到的命令 ${args.join(' ')}`)
  }
  return { calls, bsk }
}

describe('WP402 · 你自己的浏览器（只读）', () => {
  it('开一个独立窗口（不抢焦点）→ 打开 → 读回原文；数据页取 <pre> 里的原文；同一个窗口接着读', async () => {
    const json = '{"products":[{"title":"A & B <x>"}]}'
    const b = fakeBsk({
      [`${RIVAL}/products.json`]: `<html><head></head><body><pre style="word-wrap: break-word;">${json.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></body></html>`,
      [`${RIVAL}/robots.txt`]: '<html><body><pre>User-agent: *</pre></body></html>',
    })
    const reader = createOwnBrowserReader({ bsk: b.bsk, newId: () => 'req_1', idleMs: 10 })
    const r = await reader.dataRead(`${RIVAL}/products.json`)
    expect(r).toMatchObject({
      ok: true,
      status: 0,
      final_url: `${RIVAL}/products.json`,
      text: json,
    })
    await reader.dataRead(`${RIVAL}/robots.txt`)
    const cmds = b.calls.map((c) => c.slice(0, 2).join(' '))
    expect(cmds.filter((c) => c === 'session start')).toHaveLength(1)
    expect(b.calls[0]).toEqual(['session', 'request', 'req_1', '--prepare'])
    expect(b.calls[1]).toEqual(['session', 'start', '--request-id', 'req_1', '--no-focus'])
    // 只用读的动作：开窗口 / 打开 / 读原文 / 关窗口
    for (const c of b.calls) expect(['session', 'navigate', 'get-html']).toContain(c[0] as string)
    await reader.close()
    expect(b.calls.at(-1)).toEqual(['session', 'stop', 'sess_1'])
  })

  it('插件没读成：照实说一句、关掉这个窗口（下次重开），不重试', async () => {
    const b = fakeBsk({}, 'products.json')
    const reader = createOwnBrowserReader({ bsk: b.bsk, newId: () => 'req_1' })
    const r = await reader.dataRead(`${RIVAL}/products.json`)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.message).toContain('extension not connected')
    expect(b.calls.filter((c) => c[0] === 'navigate')).toHaveLength(1)
    expect(b.calls.at(-1)).toEqual(['session', 'stop', 'sess_1'])
  })

  it('网页原样交回（Amazon 商品页那种）；浏览器画 JSON 的那一层剥掉', () => {
    expect(dataTextOfHtml('<html><body><div>hi</div></body></html>')).toBe(
      '<html><body><div>hi</div></body></html>',
    )
    expect(dataTextOfHtml('<html><body><pre>{"a":1}</pre></body></html>')).toBe('{"a":1}')
  })
})

/* ── Amazon 走你自己的浏览器：同意、每家每天一次、撤回 ─────────────────────────── */

function ownBrowserSetup(pages: Record<string, string> = {}) {
  let state: AmazonOwnBrowserState | undefined
  let now = NOW
  const asked: string[] = []
  const reader: OwnBrowserReader = {
    read: async (url) => ({ ok: true, status: 0, final_url: url, text: pages[url] ?? '' }),
    dataRead: async (url) => ({ ok: true, status: 0, final_url: url, text: pages[url] ?? '' }),
    close: async () => {},
  }
  const own = createAmazonOwnBrowser({
    reader: () => reader,
    state: () => state,
    saveState: (s) => {
      state = s
    },
    now: () => now,
    tzOffsetMinutes: () => 480,
    askConsent: async () => {
      asked.push(AMAZON_EXTENSION_CONSENT_TARGET)
    },
  })
  return {
    own,
    asked,
    at: (iso: string) => {
      now = iso
    },
  }
}

describe('WP402 · Amazon 走你自己的浏览器的规矩', () => {
  it('第一次要用：出一张同意卡，只出一次；没同意之前一页都不开', async () => {
    const t = ownBrowserSetup()
    expect(t.own.route('src_a')?.gate).toBe('needs_consent')
    await t.own.needConsent()
    await t.own.needConsent()
    expect(t.asked).toEqual([AMAZON_EXTENSION_CONSENT_TARGET])
    expect(t.own.consent().state).toBe('asked')
    const target = t.own.setupTarget()
    expect(await target.satisfied()).toBe(false)
    const fields = await target.fields()
    expect(fields[0]?.options?.map((o) => o.value)).toEqual(['granted', 'declined'])
    await target.apply({ consent: 'granted' })
    expect(await target.satisfied()).toBe(true)
    expect(t.own.route('src_a')?.gate).toBe('ok')
  })

  it('每家竞品每天至多一次（按品牌本地日子算）；第二天又能用；联想词那一批算一家', () => {
    const t = ownBrowserSetup()
    t.own.setConsent('granted')
    t.own.route('src_a')?.used?.()
    expect(t.own.route('src_a')?.gate).toBe('limited')
    expect(t.own.route('src_b')?.gate).toBe('ok')
    t.own.keywords()?.used()
    expect(t.own.keywords()?.gate).toBe('limited')
    // 本地（+8）第二天早上
    t.at('2026-10-19T23:30:00.000Z')
    expect(t.own.route('src_a')?.gate).toBe('ok')
    expect(t.own.keywords()?.gate).toBe('ok')
  })

  it('设置里撤回：不用、也不再问；点「先不用」同样不再问', async () => {
    const t = ownBrowserSetup()
    t.own.setConsent('granted')
    t.own.setConsent('revoked')
    expect(t.own.route('src_a')?.gate).toBe('needs_consent')
    await t.own.needConsent()
    expect(t.asked).toEqual([])
    const u = ownBrowserSetup()
    await u.own.setupTarget().apply({ consent: 'declined' })
    await u.own.needConsent()
    expect(u.asked).toEqual([])
    expect(await u.own.setupTarget().satisfied()).toBe(true)
  })

  it('读商品页：你浏览器里出验证页 → blocked（AI 不碰）；找不到 → missing；正常页解析好', async () => {
    const t = ownBrowserSetup({
      'https://www.amazon.com/dp/B0TESTRG01': amzFx('us-normal.html'),
      'https://www.amazon.com/dp/B0TESTRG02': amzFx('captcha.html'),
    })
    t.own.setConsent('granted')
    const route = t.own.route('src_a')
    expect((await route?.read({ marketplace: 'US', asin: 'B0TESTRG01' }))?.status).toBe('ok')
    expect((await route?.read({ marketplace: 'US', asin: 'B0TESTRG02' }))?.status).toBe('blocked')
  })
})

/* ── 品牌级「被 Amazon 拦了」：竞品读页与联想词共用一份 ───────────────────────── */

describe('WP402 · 品牌级暂停（一边被拦，另一边同时换路）', () => {
  it('竞品读页碰到验证页：联想词那边也不再用内置浏览器，直接换下一条路（要同意 → 出卡）', async () => {
    const db = createCompetitorWatchDb()
    const store = db.forWorkspace(WS)
    let now = NOW
    const block = createAmazonBlock({
      get: () => store.kv('amazon_block') ?? undefined,
      set: (n) => store.setKv('amazon_block', n),
      nowMs: () => Date.parse(now),
    })
    const opened: string[] = []
    const channel: SearchBrowserChannel = {
      async open(input) {
        opened.push(input.url)
        return {
          ok: true,
          status: 200,
          final_url: input.url,
          page: {
            signals: { title: '', text: '', captcha: false, passwordInputs: 0 },
            text: amzFx('captcha.html'),
            truncated: false,
          },
        }
      },
      reveal: async () => false,
      status: async () => ({ revealed: false }),
    }
    const reader = createAmazonFrontReader({
      workspace_id: WS,
      channel: () => channel,
      page: (task) => task(),
      nowMs: () => Date.parse(now),
      state: () => ({}),
      saveState: () => {},
      zipOf: () => undefined,
      block,
    })
    const consentAsks: string[] = []
    const adapter = createAmazonAsinAdapter({
      reader: () => reader,
      cloud: () => undefined,
      store: () => store,
      ownBrowser: () => ({
        gate: 'needs_consent',
        read: async () => ({ status: 'failed', message: 'never' }),
      }),
      onNeedsConsent: (id) => consentAsks.push(id),
    })
    const src = {
      ...SHOP_SOURCE,
      id: 'cw_amz_c_rival_US',
      kind: 'amazon_asin',
      url: 'https://www.amazon.com',
      marketplace: 'US',
      asins: ['B0TESTRG01'],
    } as CompetitorWatchSource
    const got = await adapter.read(src, { workspace_id: WS, now })
    expect(got.rows).toEqual([])
    expect(got.needs_consent).toBe(true)
    expect(consentAsks).toEqual(['cw_amz_c_rival_US'])
    expect(block.state()).toMatchObject({ by: 'competitor' })
    expect(block.pausedUntil()).toBe(Date.parse(now) + 24 * 3_600_000)

    // 联想词那边：内置浏览器一页都不开，换到你自己的浏览器（还没同意 → 要问一句）
    const suggestCalls: string[] = []
    let keywordConsent = 0
    const bank = createAmazonKeywordBank({
      workspace_id: WS,
      now: () => now,
      newId: (p) => `${p}_1`,
      block,
      reader: () => ({
        suggest: async (i) => {
          suggestCalls.push(i.prefix)
          return { status: 'ok', suggestions: [] }
        },
      }),
      ownBrowser: () => ({
        gate: 'needs_consent',
        suggest: async () => ({ status: 'ok', suggestions: [] }),
        used: () => {},
      }),
      onNeedsConsent: () => {
        keywordConsent += 1
      },
      brand: async () => ({ name: 'Nordvik', markets: ['US'], competitors: [] }),
    })
    const r = await bank.refresh({ trigger: 'tool', seeds: ['electric bike'] })
    expect(suggestCalls).toEqual([])
    expect(r.refresh.autocomplete.status).toBe('blocked')
    expect(r.refresh.autocomplete.attempts?.map((a) => `${a.route}:${a.outcome}`)).toEqual([
      'browser:blocked',
      'cloud:unavailable',
      'extension:needs_consent',
    ])
    expect(keywordConsent).toBe(1)

    // 24 小时之后内置浏览器又能读
    now = '2026-10-20T02:00:00.000Z'
    expect(block.pausedUntil()).toBeUndefined()
    expect(reader.ready()).toBe(true)
  })

  it('联想词被拦：竞品读页那边同时停用内置浏览器（这一轮走云端）；同意过就在你自己的浏览器里读（一批至多 9 页）', async () => {
    const db = createCompetitorWatchDb()
    const store = db.forWorkspace(WS)
    const now = NOW
    const block = createAmazonBlock({
      get: () => store.kv('amazon_block') ?? undefined,
      set: (n) => store.setKv('amazon_block', n),
      nowMs: () => Date.parse(now),
    })
    const builtIn: string[] = []
    const own: string[] = []
    let used = 0
    const bank = createAmazonKeywordBank({
      workspace_id: WS,
      now: () => now,
      newId: (p) => `${p}_1`,
      block,
      reader: () => ({
        suggest: async (i) => {
          builtIn.push(i.prefix)
          return builtIn.length >= 2
            ? { status: 'blocked', message: 'Amazon 出了验证页' }
            : { status: 'ok', suggestions: [`${i.prefix} one`] }
        },
      }),
      ownBrowser: () => ({
        gate: 'ok',
        suggest: async (i) => {
          own.push(i.prefix)
          return { status: 'ok', suggestions: [`${i.prefix} two`] }
        },
        used: () => {
          used += 1
        },
      }),
      brand: async () => ({ name: 'Nordvik', markets: ['US'], competitors: [] }),
    })
    const r = await bank.refresh({ trigger: 'tool', seeds: ['electric bike'] })
    expect(builtIn).toHaveLength(2)
    // WP408（决策 1155）：你自己的浏览器一批只读 9 页，其余留给下一轮
    expect(own.length).toBe(9)
    expect(used).toBe(1)
    expect(r.refresh.autocomplete.read).toBe(10)
    expect(r.refresh.autocomplete.via).toBe('extension')
    expect(block.state().by).toBe('keywords')

    const channel: SearchBrowserChannel = {
      async open() {
        throw new Error('暂停期里不该开 Amazon 的页')
      },
      reveal: async () => false,
      status: async () => ({ revealed: false }),
    }
    const reader = createAmazonFrontReader({
      workspace_id: WS,
      channel: () => channel,
      page: (task) => task(),
      nowMs: () => Date.parse(now),
      state: () => ({}),
      saveState: () => {},
      block,
    })
    expect(reader.ready()).toBe(false)
    expect((await reader.readFacts({ marketplace: 'US', asin: 'B0TESTRG01' })).status).toBe(
      'blocked',
    )
  })
})
