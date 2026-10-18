/**
 * WP402（决策 1140 / 1146）：取数链——每条路成功 / 被拦换路 / 429 先退避 / 全失败照实说 / Amazon 走你自己的浏览器
 * （要同意、每家每天至多一次、币种不对作废）。全用录好的样本与替身，不联网、不花钱。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CompetitorWatchSource } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { PageFetch } from '../src/fetch.js'
import {
  type AmazonOwnBrowserRoute,
  type AmazonPageOutcome,
  type BrowserTextRead,
  type ChainRoute,
  createReadChain,
  parseAmazonProduct,
  readAmazonAsins,
  readBatchChain,
  readShopCatalog,
} from '../src/index.js'

const NOW = '2026-10-19T01:00:00.000Z'
const noSleep = async (): Promise<void> => {}
const shopFixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'shop-catalog', name), 'utf8')
const amazonPage = (name: string): string =>
  readFileSync(join(import.meta.dirname, 'fixtures', 'amazon-watch', name), 'utf8')

type Step = Awaited<ReturnType<ChainRoute<string, string>['read']>>
const scripted = (route: ChainRoute<string, string>['route'], steps: Step[], log: string[]) => {
  let i = 0
  return {
    route,
    read: async (input: string): Promise<Step> => {
      log.push(`${route}:${input}`)
      const s = steps[Math.min(i, steps.length - 1)] as Step
      i += 1
      return s
    },
  }
}

describe('WP402 · 取数链（一页一页读）', () => {
  it('第一条路读到就用它；被拦换下一条，之后这一次都从那条读（不在被拦的那条上硬试）', async () => {
    const log: string[] = []
    const chain = createReadChain(
      [
        scripted('browser', [{ ok: false, kind: 'blocked', reason: '验证页' }], log),
        scripted('cloud', [{ ok: true, value: 'a' }], log),
      ],
      { sleep: noSleep },
    )
    expect(await chain.read('p1')).toEqual({ ok: true, value: 'a', via: 'cloud' })
    expect(await chain.read('p2')).toMatchObject({ ok: true, via: 'cloud' })
    expect(log).toEqual(['browser:p1', 'cloud:p1', 'cloud:p2'])
    expect(chain.via()).toBe('cloud')
    expect(chain.attempts()).toEqual([
      { route: 'browser', outcome: 'blocked', reason: '验证页' },
      { route: 'cloud', outcome: 'ok' },
    ])
  })

  it('429：先按退避等两次再试同一条；还是 429 才换路', async () => {
    const waits: number[] = []
    const sleep = async (ms: number) => {
      waits.push(ms)
    }
    const log: string[] = []
    const ok = createReadChain(
      [
        scripted(
          'direct',
          [
            { ok: false, kind: 'rate_limited', reason: '429', retry_after_ms: 5_000 },
            { ok: true, value: 'x' },
          ],
          log,
        ),
      ],
      { sleep },
    )
    expect(await ok.read('u')).toMatchObject({ ok: true, via: 'direct' })
    expect(waits).toEqual([5_000])

    waits.length = 0
    const moved = createReadChain(
      [
        scripted('direct', [{ ok: false, kind: 'rate_limited', reason: '429' }], log),
        scripted('browser', [{ ok: true, value: 'y' }], log),
      ],
      { sleep, backoffMs: [100, 200] },
    )
    expect(await moved.read('u')).toMatchObject({ ok: true, via: 'browser' })
    expect(waits).toEqual([100, 200])
    expect(moved.attempts()[0]).toMatchObject({ route: 'direct', outcome: 'rate_limited' })
  })

  it('对方说没有（404）/ 打不开 / 本机额度满了：不换路（不为赶时间去花钱）', async () => {
    for (const kind of ['not_found', 'unreachable', 'quota'] as const) {
      const log: string[] = []
      const chain = createReadChain(
        [
          scripted('direct', [{ ok: false, kind, reason: kind }], log),
          scripted('cloud', [{ ok: true, value: 'never' }], log),
        ],
        { sleep: noSleep },
      )
      expect(await chain.read('u')).toEqual({ ok: false, kind, reason: kind })
      expect(log).toEqual(['direct:u'])
    }
  })

  it('全都不行：照实说每条路为什么没读到（这台没有的路不算理由）', async () => {
    const log: string[] = []
    const chain = createReadChain(
      [
        scripted('browser', [{ ok: false, kind: 'unavailable', reason: '没有桌面壳' }], log),
        scripted('cloud', [{ ok: false, kind: 'blocked', reason: '云端也被挡' }], log),
        scripted('extension', [{ ok: false, kind: 'failed', reason: '插件没连上' }], log),
      ],
      { sleep: noSleep },
    )
    const r = await chain.read('u')
    expect(r).toEqual({ ok: false, kind: 'blocked', reason: '云端也被挡；插件没连上' })
    expect(chain.attempts().map((a) => `${a.route}:${a.outcome}`)).toEqual([
      'browser:unavailable',
      'cloud:blocked',
      'extension:failed',
    ])
  })

  it('一批一起读：读到的收下、被拦的往下一条传、作废的停在原地', async () => {
    const out = await readBatchChain(
      ['a', 'b', 'c'],
      [
        {
          route: 'browser',
          read: async (keys) => ({
            got: [{ key: 'a', value: 1 }],
            next: keys.slice(1),
            outcome: 'blocked',
          }),
        },
        {
          route: 'cloud',
          read: async () => ({
            got: [{ key: 'b', value: 2 }],
            next: [],
            stop: [{ key: 'c', kind: 'failed' }],
          }),
        },
        { route: 'extension', read: async () => ({ got: [{ key: 'z', value: 9 }], next: [] }) },
      ],
    )
    expect(out.got.map((g) => `${g.key}@${g.via}`)).toEqual(['a@browser', 'b@cloud'])
    expect(out.stopped).toEqual([{ key: 'c', kind: 'failed' }])
    expect(out.left).toEqual([])
    expect(out.attempts.map((a) => a.outcome)).toEqual(['blocked', 'ok'])
  })
})

/* ── 独立站：直接读 → 内置浏览器 → 工坊云端 → 你自己的浏览器 ──────────────── */

const SHOP = 'https://rival-bikes.example'
const PAGE1 = `${SHOP}/products.json?limit=250&page=1`

const blockedFetch: PageFetch = async (url) => ({
  ok: false,
  status: 403,
  url,
  text: async () => '',
})
const reader = (
  who: string,
  log: string[],
  answer: (url: string) => Awaited<ReturnType<BrowserTextRead>>,
): BrowserTextRead => {
  return async (url) => {
    log.push(`${who}:${url.replace(SHOP, '')}`)
    return answer(url)
  }
}
const okPage = (url: string): Awaited<ReturnType<BrowserTextRead>> =>
  url.includes('products.json')
    ? { ok: true, status: 200, final_url: url, text: shopFixture('shopify-products-p1.json') }
    : { ok: true, status: 200, final_url: url, text: shopFixture('shopify-all.atom') }
const challenge = (url: string): Awaited<ReturnType<BrowserTextRead>> => ({
  ok: true,
  status: 403,
  final_url: url,
  text: shopFixture('cloudflare-challenge.html'),
  challenge: true,
})

describe('WP402 · 竞品独立站的取数链', () => {
  it('直接读和内置浏览器都被挡：工坊云端代读同一个地址，记下走了云端', async () => {
    const log: string[] = []
    const out = await readShopCatalog(
      {
        fetch: blockedFetch,
        browser: reader('browser', log, challenge),
        cloud: reader('cloud', log, okPage),
        sleep: noSleep,
      },
      { url: SHOP, platform: 'shopify', now: NOW },
    )
    expect(out.via).toBe('cloud')
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.error).toBeUndefined()
    expect(out.notes[0]).toContain('工坊云端')
    // 被挡之后剩下的页（all.atom）直接从云端读，不再回头试前两条
    expect(log).toEqual([
      'browser:/products.json?limit=250&page=1',
      'cloud:/products.json?limit=250&page=1',
      'cloud:/collections/all.atom',
    ])
    expect(out.attempts?.map((a) => `${a.route}:${a.outcome}`)).toEqual([
      'direct:blocked',
      'browser:blocked',
      'cloud:ok',
    ])
  })

  it('云端也被挡：通过插件在你自己的浏览器里读（独立站不用额外同意）', async () => {
    const log: string[] = []
    const out = await readShopCatalog(
      {
        fetch: blockedFetch,
        browser: reader('browser', log, challenge),
        cloud: reader('cloud', log, challenge),
        extension: reader('extension', log, okPage),
        sleep: noSleep,
      },
      { url: SHOP, platform: 'shopify', now: NOW },
    )
    expect(out.via).toBe('extension')
    expect(out.rows.length).toBeGreaterThan(0)
    expect(out.notes[0]).toContain('你自己的浏览器')
  })

  it('四条路都不行：一行都没有、照实说每条为什么，下一轮再试（不重试、不绕）', async () => {
    const log: string[] = []
    const out = await readShopCatalog(
      {
        fetch: blockedFetch,
        browser: reader('browser', log, challenge),
        cloud: reader('cloud', log, () => ({ ok: false, message: '积分不够' })),
        extension: reader('extension', log, challenge),
        sleep: noSleep,
      },
      { url: SHOP, platform: 'shopify', now: NOW },
    )
    expect(out.rows).toEqual([])
    expect(out.complete).toBe(false)
    expect(out.error).toMatch(
      /对方拒绝了（403）.*内置浏览器里也被挡了.*积分不够.*你自己的浏览器里也被挡了/,
    )
    // 每条路只试一次
    expect(log).toHaveLength(3)
  })

  it('第一条路就读到：后面几条一页都不碰（不花云端积分）', async () => {
    const log: string[] = []
    const fetch: PageFetch = async (url) => {
      const r = okPage(url)
      return {
        ok: true,
        status: 200,
        url,
        text: async () => (r.ok ? r.text : ''),
      }
    }
    const out = await readShopCatalog(
      { fetch, cloud: reader('cloud', log, okPage), extension: reader('ext', log, okPage) },
      { url: PAGE1.replace('/products.json?limit=250&page=1', ''), platform: 'shopify', now: NOW },
    )
    expect(out.via).toBe('direct')
    expect(log).toEqual([])
  })
})

/* ── Amazon：内置浏览器 → 工坊云端 → 你自己的浏览器（要同意、每家每天至多一次）──────────── */

const SRC = {
  id: 'cw_amz_c_rival_US',
  competitor_id: 'c_rival',
  label: 'Rival Gear',
  marketplace: 'US',
  asins: ['B0TESTRG01', 'B0TESTRG02'],
} satisfies Pick<CompetitorWatchSource, 'id' | 'competitor_id' | 'label' | 'marketplace' | 'asins'>

const facts = (name: string, asin: string): AmazonPageOutcome => {
  const f = parseAmazonProduct(amazonPage(name), { asin })
  return f === undefined ? { status: 'blocked' } : { status: 'ok', facts: f }
}
const blockedBrowser = async (): Promise<AmazonPageOutcome> => ({ status: 'blocked' })
const brokenCloud = async () => ({ error: '工坊云端这次没回来' })

function ownBrowser(
  gate: AmazonOwnBrowserRoute['gate'],
  page = 'us-normal.html',
): AmazonOwnBrowserRoute & { opened: string[]; uses: number } {
  const out = {
    gate,
    opened: [] as string[],
    uses: 0,
    read: async (i: { marketplace: string; asin: string }) => {
      out.opened.push(i.asin)
      return facts(page, i.asin)
    },
    used: () => {
      out.uses += 1
    },
  }
  return out
}

describe('WP402 · Amazon 的第 3 条路（你自己的浏览器）', () => {
  it('内置浏览器被拦、云端也没读到：还没同意 → 一页都不开，标「要问一句」', async () => {
    const ext = ownBrowser('needs_consent')
    const got = await readAmazonAsins(SRC, {
      browser: blockedBrowser,
      cloud: brokenCloud,
      extension: ext,
      now: NOW,
    })
    expect(ext.opened).toEqual([])
    expect(got.needs_consent).toBe(true)
    expect(got.rows).toEqual([])
    expect(got.error).toContain('先问你一句')
    expect(got.attempts?.map((a) => `${a.route}:${a.outcome}`)).toEqual([
      'browser:blocked',
      'cloud:failed',
      'extension:needs_consent',
    ])
  })

  it('同意过了：剩下的在你自己的浏览器里读，记一次「今天这家用过了」', async () => {
    const ext = ownBrowser('ok')
    const got = await readAmazonAsins(SRC, {
      browser: blockedBrowser,
      cloud: brokenCloud,
      extension: ext,
      now: NOW,
    })
    expect(ext.opened).toEqual(['B0TESTRG01', 'B0TESTRG02'])
    expect(ext.uses).toBe(1)
    expect(got.via).toBe('extension')
    expect(got.extension_asins).toEqual(['B0TESTRG01', 'B0TESTRG02'])
    expect(got.complete).toBe(true)
    expect(got.notes?.join('；')).toContain('你自己的浏览器')
  })

  it('今天这家已经用过一次：不再开，照实说明天再试', async () => {
    const ext = ownBrowser('limited')
    const got = await readAmazonAsins(SRC, {
      browser: blockedBrowser,
      cloud: brokenCloud,
      extension: ext,
      now: NOW,
    })
    expect(ext.opened).toEqual([])
    expect(got.error).toContain('今天已经用你自己的浏览器读过一次')
  })

  it('前两条有一条读到就不碰你的浏览器（只在前两条都失败时用）', async () => {
    const ext = ownBrowser('ok')
    const viaBrowser = await readAmazonAsins(SRC, {
      browser: async (i) => facts('us-normal.html', i.asin),
      extension: ext,
      now: NOW,
    })
    expect(viaBrowser.via).toBe('browser')
    const viaCloud = await readAmazonAsins(SRC, {
      browser: blockedBrowser,
      cloud: async (i) => ({
        credits: 0.36,
        items: i.asins.map((asin) => ({ asin, title: asin, price: 999, currency: 'USD' })),
      }),
      extension: ext,
      now: NOW,
    })
    expect(viaCloud.via).toBe('cloud')
    expect(ext.opened).toEqual([])
    expect(ext.uses).toBe(0)
  })

  it('你浏览器里的配送地址不是这个站的：作废、照实说，不替你改地址', async () => {
    const ext = ownBrowser('ok', 'ca-undeliverable.html')
    const got = await readAmazonAsins(SRC, {
      browser: blockedBrowser,
      cloud: brokenCloud,
      extension: ext,
      now: NOW,
    })
    expect(got.rows).toEqual([])
    expect(got.unread).toEqual(['B0TESTRG01', 'B0TESTRG02'])
    expect(got.notes?.join('；')).toContain('不替你改地址')
  })
})
