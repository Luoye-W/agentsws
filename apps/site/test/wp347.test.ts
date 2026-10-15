/**
 * WP347（Luoye 10-15，决策 883）：首页补三种用法 / 出海卖家定位 / 能动手 / 一键连平台 / 按量付费；
 * 首屏下载按系统直下；顶栏与页脚入口齐；Mac 一律说「M 系列芯片」。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountUrl } from '../src/config.js'
import { COMMON } from '../src/i18n/common.js'
import { DOWNLOAD } from '../src/i18n/download.js'
import { HOME } from '../src/i18n/home.js'
import { PRICING } from '../src/i18n/pricing.js'
import { CHANGELOG_DIR } from '../src/lib/changelog.js'
import { type DownloadManifest, directDesktop, pickDesktop } from '../src/lib/downloads.js'
import { HELP_DIR } from '../src/lib/help.js'
import { repoRoot } from '../src/lib/paths.js'

const root = repoRoot()
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0'
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0'

describe('首屏下载按系统直下', () => {
  it('Windows → exe；M 系列 Mac（认不出芯片也算）→ dmg', () => {
    expect(pickDesktop({ userAgent: WIN })).toBe('win')
    expect(
      pickDesktop({ userAgent: MAC, gpu: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2)' }),
    ).toBe('mac')
    expect(pickDesktop({ userAgent: MAC, gpu: 'Apple GPU' })).toBe('mac')
    expect(pickDesktop({ userAgent: MAC, gpu: null })).toBe('mac')
  })

  it('手机、平板（含报成 Mac 的 iPad）、Intel Mac、Linux → 去下载页', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148'
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/131.0 Mobile Safari/537.36'
    expect(pickDesktop({ userAgent: iphone })).toBeNull()
    expect(pickDesktop({ userAgent: android })).toBeNull()
    expect(pickDesktop({ userAgent: MAC, maxTouchPoints: 5, gpu: 'Apple GPU' })).toBeNull()
    expect(pickDesktop({ userAgent: MAC, gpu: 'Intel(R) Iris(TM) Plus Graphics 655' })).toBeNull()
    expect(pickDesktop({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/131.0' })).toBeNull()
  })

  it('直链取自清单；清单里没链接的就不换', () => {
    const m = {
      version: '0.2.0-beta.7',
      channel: 'beta',
      released: '2026-10-15',
      desktop: [
        { id: 'mac-arm64', os: 'mac', arch: 'arm64', file: 'a.dmg', url: 'https://x/a.dmg' },
        { id: 'win-x64', os: 'win', arch: 'x64', file: 'b.exe', url: null },
      ],
      extension: { id: 'extension' },
    } as unknown as DownloadManifest
    expect(directDesktop(m)).toEqual({ mac: 'https://x/a.dmg', win: null })
  })
})

describe('首页文案', () => {
  it('定位进 meta 与首屏；首屏三个勾是 Mac / Windows、一键连平台、按量付费', () => {
    expect(HOME.zh.meta.title).toContain('专为跨境电商 / 出海卖家打造的 AI Agents')
    expect(HOME.zh.meta.description).toContain('专为跨境电商 / 出海卖家打造的 AI Agents')
    expect(HOME.zh.hero.position).toContain('专为跨境电商 / 出海卖家打造的 AI Agents')
    expect(HOME.zh.hero.title.join('')).toContain('面板会吃灰')
    expect(HOME.zh.hero.checks).toEqual([
      'Mac / Windows',
      '一键连上各平台',
      '按量付费 · 自带 key 免费',
    ])
    expect(HOME.en.meta.title).toMatch(/cross-border e-commerce sellers/u)
  })

  it('三种用法：个人 / 团队 / 整个公司；「有人管人」只写在公司那张', () => {
    for (const lang of ['zh', 'en'] as const)
      expect(HOME[lang].modes.items.map((m) => m.key)).toEqual(['solo', 'team', 'company'])
    const [solo, team, company] = HOME.zh.modes.items
    for (const m of [solo, team]) expect(m?.p).not.toMatch(/审批|上级|老板|额度|上限/u)
    expect(company?.p).toMatch(/审批/u)
    expect(company?.h).toMatch(/老板开启/u)
  })

  it('能动手、一键连平台、按量付费都点到了', () => {
    expect(HOME.zh.base.title.join('')).toContain('还能动手')
    expect(HOME.zh.how.items[0]?.h).toBe('一键连上各平台')
    expect(HOME.zh.how.items[0]?.p).toContain('不用申请开发者应用')
    expect(HOME.zh.credits.title).toContain('按量付费')
    expect(HOME.en.credits.title).toMatch(/Pay as you go/u)
  })
})

describe('入口', () => {
  it('注册链到云端真注册页（/account/signup），英文带 lang', () => {
    expect(accountUrl('signup', 'zh')).toBe('https://cloud.agentsws.com/account/signup')
    expect(accountUrl('signup', 'en')).toBe('https://cloud.agentsws.com/account/signup?lang=en')
    expect(COMMON.zh.nav.signup).toBe('注册')
    expect(COMMON.en.footer.signup).toBe('Sign up')
  })
})

describe('Mac 一律说「M 系列芯片」', () => {
  const sources = (): [string, string][] => {
    const out: [string, string][] = [
      ['home', JSON.stringify(HOME)],
      ['download', JSON.stringify(DOWNLOAD)],
      ['pricing', JSON.stringify(PRICING)],
      ['common', JSON.stringify(COMMON)],
    ]
    for (const dir of [CHANGELOG_DIR, HELP_DIR])
      for (const f of readdirSync(join(root, dir)).filter((x) => x.endsWith('.md')))
        out.push([`${dir}/${f}`, readFileSync(join(root, dir, f), 'utf8')])
    return out
  }

  it('中文不写「Apple 芯片」；英文的 Apple silicon 后面都跟着 M-series', () => {
    for (const [name, text] of sources()) {
      expect(text, name).not.toMatch(/Apple ?芯片|苹果芯片/u)
      for (const m of text.matchAll(/Apple silicon[^.\n]{0,24}/gu))
        expect(m[0], name).toMatch(/M-series/u)
    }
    expect(DOWNLOAD.zh.primary['mac-arm64']).toContain('M 系列芯片')
    expect(DOWNLOAD.en.primary['mac-arm64']).toContain('Apple silicon (M-series)')
  })
})
