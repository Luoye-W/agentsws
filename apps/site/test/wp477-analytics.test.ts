/**
 * WP477（决策 1609 / 1611 选 A）：官网统计。全程不联网（只测纯逻辑与源码、构建配置）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | Consent Mode v2 默认四格 denied；点「允许」只开 `analytics_storage`，广告类永远不开 | 决策 1611 |
 * | 只在正式域名上加载 gtag；本机预览、测试一个统计请求都不发 | 开发期间不往 Google 发 |
 * | 下载直链 / 下载页入口 / 注册入口 → 固定事件名，参数只有几个固定的词 | 漏斗「官网 → 下载」 |
 * | CSP 只放 GA4 要的那几个域；横幅在每一页、中英都有；隐私政策写到了 | 能跑、讲清楚 |
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { accountUrl, GA4_HOSTS, GA4_MEASUREMENT_ID } from '../src/config.js'
import { CONSENT } from '../src/i18n/consent.js'
import {
  CONSENT_DEFAULT,
  consentUpdate,
  eventOf,
  gaCookieNames,
  placementOf,
  readChoice,
  shouldLoadGa,
} from '../src/lib/analytics.js'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')

describe('WP477 Consent Mode v2', () => {
  it('默认四格全 denied；「允许」只改 analytics_storage', () => {
    expect(CONSENT_DEFAULT).toEqual({
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
      analytics_storage: 'denied',
    })
    expect(consentUpdate('granted')).toEqual({ analytics_storage: 'granted' })
    expect(consentUpdate('denied')).toEqual({ analytics_storage: 'denied' })
    expect(readChoice('granted')).toBe('granted')
    expect(readChoice('denied')).toBe('denied')
    for (const x of [null, undefined, '', 'yes', 'GRANTED']) expect(readChoice(x)).toBeUndefined()
  })

  it('只在正式域名上加载 gtag', () => {
    expect(GA4_MEASUREMENT_ID).toBe('G-P4LBL51H3P')
    expect(shouldLoadGa('agentsws.com', GA4_HOSTS)).toBe(true)
    expect(shouldLoadGa('www.agentsws.com', GA4_HOSTS)).toBe(true)
    for (const host of [
      'localhost',
      '127.0.0.1',
      'agentsws-site.example.workers.dev',
      'evil-agentsws.com',
    ])
      expect(shouldLoadGa(host, GA4_HOSTS), host).toBe(false)
  })

  it('脚本里先设默认 denied、再 config、最后才拉 gtag.js', () => {
    const src = read('../src/scripts/analytics.ts')
    const order = [
      "gtag('consent', 'default'",
      "gtag('config', id)",
      'googletagmanager.com/gtag/js',
    ].map((x) => src.indexOf(x))
    expect(order.every((i) => i > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // 广告类永远不改成 granted
    expect(src).not.toMatch(/ad_storage['"]?\s*:\s*['"]granted/u)
  })

  it('「不允许」时只清 GA 自己的 Cookie', () => {
    expect(gaCookieNames('_ga=GA1.1.1; _ga_P4LBL51H3P=GS1; theme=dark; _gat=1; x_ga=2')).toEqual([
      '_ga',
      '_ga_P4LBL51H3P',
    ])
  })
})

describe('WP477 下载 / 注册事件', () => {
  it('安装包直链、下载页入口、注册入口各自一个固定事件名；参数只有固定的几个词', () => {
    expect(
      eventOf({ href: 'https://dl.agentsws.com/v0.2.1/Agents-Workshop-0.2.1-arm64.dmg' }, '/'),
    ).toEqual({ name: 'download_click', params: { os: 'mac', link: 'file', placement: 'home' } })
    expect(
      eventOf(
        { href: 'https://dl.agentsws.com/Agents-Workshop-Setup-0.2.1-x64.exe' },
        '/en/download/',
      ),
    ).toEqual({
      name: 'download_click',
      params: { os: 'win', link: 'file', placement: 'download' },
    })
    expect(
      eventOf(
        { href: 'https://dl.agentsws.com/agents-workshop-extension-0.2.1.zip' },
        '/download/',
      ),
    ).toEqual({
      name: 'download_click',
      params: { os: 'extension', link: 'file', placement: 'download' },
    })
    expect(eventOf({ href: '/download/', dl: true }, '/')).toEqual({
      name: 'download_click',
      params: { os: 'unknown', link: 'page', placement: 'home' },
    })
    expect(eventOf({ href: accountUrl('signup', 'zh') }, '/pricing/')).toEqual({
      name: 'signup_click',
      params: { placement: 'pricing' },
    })
    expect(eventOf({ href: accountUrl('signup', 'en') }, '/en/')).toEqual({
      name: 'signup_click',
      params: { placement: 'home' },
    })
    for (const href of [
      accountUrl('login', 'zh'),
      '/pricing/',
      'https://github.com/Luoye-W/agentsws',
    ])
      expect(eventOf({ href }, '/'), href).toBeUndefined()
    expect(placementOf('/docs/x/')).toBe('docs')
    expect(placementOf('/roles/')).toBe('other')
  })
})

describe('WP477 横幅、页脚、CSP、隐私政策', () => {
  it('横幅挂在每一页的外壳上；页脚有「统计设置」；中英文案都在、都很短', () => {
    expect(read('../src/layouts/Base.astro')).toContain('<Analytics lang={lang} />')
    expect(read('../src/components/Footer.astro')).toContain("'#consent'")
    for (const lang of ['zh', 'en'] as const) {
      const t = CONSENT[lang]
      expect(t.text.length).toBeLessThan(90)
      expect(t.allow.length).toBeLessThan(16)
      expect(t.deny.length).toBeLessThan(16)
    }
  })

  it('CSP 只多放了 GA4 要的那几个域', () => {
    const headers = read('../public/_headers')
    const csp = headers.split('\n').find((l) => l.includes('Content-Security-Policy')) ?? ''
    const hosts = [...csp.matchAll(/https:\/\/[^\s;]+/gu)].map((m) => m[0])
    expect(new Set(hosts)).toEqual(
      new Set([
        'https://*.googletagmanager.com',
        'https://*.google-analytics.com',
        'https://*.analytics.google.com',
      ]),
    )
  })

  it('隐私政策中英两份都写到了：官网 GA（同意前不存 Cookie）、PostHog、四件关键事、反馈 180 天', () => {
    const zh = read('../src/content/legal/privacy.md')
    const en = read('../src/content/legal/privacy.en.md')
    for (const s of [
      'Google Analytics',
      'PostHog',
      '「允许 / 不允许」',
      '180 天',
      '#consent',
      '帮助改进工坊',
    ])
      expect(zh, s).toContain(s)
    for (const s of [
      'Google Analytics',
      'PostHog',
      'Allow',
      '180 days',
      '#consent',
      'Help improve',
    ])
      expect(en, s).toContain(s)
    expect(zh).not.toContain('目前也没有接入访问统计')
    expect(en).not.toContain('currently has no visitor analytics')
  })
})
