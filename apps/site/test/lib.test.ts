/**
 * 价目（构建时取云上、取不到用样例）、下载清单、SEO、文案中英同形。
 */

import { readFileSync } from 'node:fs'
import type { PricingCatalog } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { accountUrl, SISTER_SITES } from '../src/config.js'
import manifest from '../src/data/downloads.json'
import { COMMON, localePath } from '../src/i18n/common.js'
import { DOWNLOAD } from '../src/i18n/download.js'
import { HOME } from '../src/i18n/home.js'
import { PAGES } from '../src/i18n/pages.js'
import { PRICING } from '../src/i18n/pricing.js'
import { ROLES, ROLES_PAGE } from '../src/i18n/roles.js'
import { type DownloadManifest, formatSize, manifestProblems } from '../src/lib/downloads.js'
import { linkNames } from '../src/lib/locales.js'
import {
  blockOf,
  entryLabel,
  formatCredits,
  loadPricing,
  looksLikeCatalog,
  tiersOf,
  unitLabel,
} from '../src/lib/pricing.js'
import { absolute, alternates, robotsTxt, sitemapXml } from '../src/lib/seo.js'

const sample: PricingCatalog = {
  version: 1,
  pricing: {
    version: 1,
    as_of: '2026-09-19',
    credit_cny: 1,
    ai_multiplier: 3,
    fx: {},
    entries: [
      {
        capability: 'ai.chat',
        unit: '1k_tokens',
        credits_per_unit: 0.3,
        label_zh: 'AI 对话（按 token）',
        label_en: 'AI chat (per token)',
      },
      {
        capability: 'kol.service.monthly',
        unit: 'month',
        credits_per_unit: 30,
        label_zh: '红人营销增值服务（每月）',
        label_en: 'Influencer add-on (monthly)',
      },
      {
        capability: 'crawl.page',
        unit: 'page',
        credits_per_unit: 0.2,
        label_zh: '网页抓取（按页）',
        label_en: 'Web fetch (per page)',
      },
    ],
  },
  topup_tiers: {
    version: 1,
    as_of: '2026-09-19',
    credits_per_usd: 7,
    tiers: [{ id: 'usd20', usd: 20, credits: 140, label_zh: '入门', label_en: 'Starter' }],
  },
}
const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch

describe('价目：构建时取云上，取不到用样例', () => {
  it('取到了就用云上那份', async () => {
    const cloud = { ...sample, pricing: { ...sample.pricing, as_of: '2026-09-29' } }
    const p = await loadPricing({
      url: 'https://x/v1/pricing',
      sample,
      fetchImpl: ok({ data: cloud }),
    })
    expect(p.source).toBe('cloud')
    expect(p.catalog.pricing.as_of).toBe('2026-09-29')
  })

  it('断网、非 200、回包不像价目、强制离线：一律用样例，不编数', async () => {
    const down = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    const bad = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    for (const fetchImpl of [down, bad, ok({ data: { hello: 1 } }), ok({})]) {
      const p = await loadPricing({ url: 'https://x', sample, fetchImpl })
      expect(p.source).toBe('sample')
      expect(p.catalog).toBe(sample)
    }
    expect(
      (
        await loadPricing({
          url: 'https://x',
          sample,
          fetchImpl: ok({ data: sample }),
          offline: true,
        })
      ).source,
    ).toBe('sample')
    expect(looksLikeCatalog(null)).toBe(false)
  })

  it('分块、单位、标签、积分数、档位', () => {
    expect(sample.pricing.entries.map(blockOf)).toEqual(['ai', 'service', 'data'])
    expect(unitLabel('1k_tokens', 'zh')).toBe('每千 token')
    expect(unitLabel('weird', 'en')).toBe('weird')
    expect(
      entryLabel({ label_zh: '网页抓取（按页）', label_en: 'Web fetch (per page)' }, 'zh'),
    ).toBe('网页抓取')
    expect(
      entryLabel({ label_zh: '网页抓取（按页）', label_en: 'Web fetch (per page)' }, 'en'),
    ).toBe('Web fetch')
    expect(formatCredits(0.30000000004)).toBe('0.3')
    expect(formatCredits(30)).toBe('30')
    expect(tiersOf({ source: 'sample', as_of: '', catalog: sample })).toHaveLength(1)
  })
})

describe('下载清单', () => {
  it('仓库里那份没毛病（链接没定的是 null）', () => {
    expect(manifestProblems(manifest as unknown as DownloadManifest)).toEqual([])
  })

  it('给了链接就必须有 https、sha256 与大小', () => {
    const m = structuredClone(manifest) as unknown as DownloadManifest
    const d = m.desktop[0]
    if (d === undefined) throw new Error('清单是空的')
    d.url = 'http://example.com/a.dmg'
    const problems = manifestProblems(m)
    expect(problems.some((p) => p.includes('https'))).toBe(true)
    expect(problems.some((p) => p.includes('sha256'))).toBe(true)
    expect(problems.some((p) => p.includes('大小'))).toBe(true)
    expect(formatSize(null)).toBe('—')
    expect(formatSize(150 * 1024 * 1024)).toBe('150 MB')
  })
})

describe('SEO', () => {
  it('中英互指 + x-default 指中文；结尾斜杠', () => {
    expect(alternates('/pricing/')).toEqual([
      { hreflang: 'zh-CN', href: 'https://agentsws.com/pricing/' },
      { hreflang: 'en', href: 'https://agentsws.com/en/pricing/' },
      { hreflang: 'x-default', href: 'https://agentsws.com/pricing/' },
    ])
    expect(localePath('/en/docs/x/', 'zh')).toBe('/docs/x/')
    expect(localePath('/', 'en')).toBe('/en/')
    expect(absolute('/terms')).toBe('https://agentsws.com/terms/')
  })

  it('sitemap 每页两条、带 xhtml:link；robots 指向 sitemap', () => {
    const xml = sitemapXml([{ path: '/' }, { path: '/pricing/' }])
    expect(xml.match(/<url>/g)).toHaveLength(4)
    expect(xml).toContain('<loc>https://agentsws.com/en/pricing/</loc>')
    expect(xml).toContain('hreflang="x-default"')
    expect(robotsTxt()).toContain('Sitemap: https://agentsws.com/sitemap.xml')
  })
})

/** 两份文案的「形状」：键一样、数组一样长。 */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(shape)
  if (v !== null && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)]))
  return typeof v
}

describe('文案：中英同形（少翻一句会红）', () => {
  it.each([
    ['common', COMMON],
    ['home', HOME],
    ['roles', ROLES],
    ['rolesPage', ROLES_PAGE],
    ['pricing', PRICING],
    ['download', DOWNLOAD],
    ['pages', PAGES],
  ] as const)('%s', (_, copy) => {
    expect(shape(copy.en)).toEqual(shape(copy.zh))
  })
})

describe('账号页链接（WP198 的路径；英文站带 ?lang=en）', () => {
  it('登录 / 账号 / 充值', () => {
    expect(accountUrl('login', 'zh')).toBe('https://cloud.agentsws.com/account/login')
    expect(accountUrl('account', 'zh')).toBe('https://cloud.agentsws.com/account')
    expect(accountUrl('topup', 'zh')).toBe('https://cloud.agentsws.com/account/topup')
    expect(accountUrl('login', 'en')).toBe('https://cloud.agentsws.com/account/login?lang=en')
    expect(accountUrl('topup', 'en')).toBe('https://cloud.agentsws.com/account/topup?lang=en')
  })
})

describe('WP227：首页台阶链到 KOLAgents / KefuAgents；Windows 下载旁的小字', () => {
  it('两个名字都变成新窗口链接（rel=noopener），其余照样转义', () => {
    for (const lang of ['zh', 'en'] as const) {
      const html = linkNames(HOME[lang].why.steps[2]?.p ?? '', SISTER_SITES)
      for (const name of ['KOLAgents', 'KefuAgents']) {
        const url = SISTER_SITES[name] ?? ''
        expect(url).toMatch(/^https:\/\/[a-z]+agents\.com$/u)
        expect(html).toContain(`<a href="${url}" target="_blank" rel="noopener">${name}</a>`)
      }
    }
    expect(linkNames('<b>X</b> & X', { X: 'https://x.example' })).toBe(
      '&#60;b&#62;<a href="https://x.example" target="_blank" rel="noopener">X</a>&#60;/b&#62; &#38; <a href="https://x.example" target="_blank" rel="noopener">X</a>',
    )
    // 不是 http(s) 的链接不认
    expect(linkNames('X', { X: 'javascript:alert(1)' })).toBe('X')
  })

  it('「第一次打开若被拦」只有一行（与 WP225 合并），中英都有、默认藏着等 Windows 访客', () => {
    // 和 WP225 合成一份：只剩一行（WP225 的显示条件：有直链、Windows 访客），文案用 WP227 那句
    expect(HOME.zh.hero.winFirstOpen).toBe('第一次打开若被拦，点「更多信息 → 仍要运行」')
    expect(HOME.en.hero.winFirstOpen).toContain('More info → Run anyway')
    expect('winHint' in HOME.zh.hero).toBe(false)
    const home = readFileSync(new URL('../src/views/Home.astro', import.meta.url), 'utf8')
    expect(home.match(/data-dl-win-note hidden/gu)?.length).toBe(2)
    expect(home).not.toContain('data-win-hint')
    const script = readFileSync(new URL('../src/scripts/site.ts', import.meta.url), 'utf8')
    expect(script).toContain("querySelectorAll<HTMLElement>('[data-dl-win-note]')")
  })
})
