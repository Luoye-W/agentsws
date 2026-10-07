/**
 * WP250（决策 95）：空 Shopify 店识别认中文（简 / 繁）和日、韩、德、法、西。
 *
 * 夹具 = 三家刚开的 Shopify 店（简体「我的商店」、繁体「我的商店」、日文「My Store」），
 * 首页是默认主题的本地化占位文字，各带一份 Shopify 自动生成的隐私政策；
 * 再加一家只留了公告栏欢迎语、其余都是真内容的正式店（不能误判）。
 *
 * 决策 103：数据文件只存哈希、不存原文。本文件里也不写官方原句——要用的时候从夹具里取
 * （夹具是我们仿造的页面，用到官方句子的地方在夹具文件头注明了出处）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  analyzeSite,
  isFreshShopifyStore,
  isPlaceholderStoreName,
  normalizeForMatch,
  pageSentenceHashes,
  placeholderTextHits,
  SHOPIFY_DEFAULT_HOME_TEXTS,
  sentencesOf,
  textHashes,
} from '../src/index.js'
import { fixture, replayFetch } from './fixtures.js'

const here = dirname(fileURLToPath(import.meta.url))
const DATA_SOURCE = readFileSync(join(here, '../src/shopify-default-texts.ts'), 'utf8')

/** 从夹具里取第一个匹配的文本节点（官方原句不写进测试代码）。 */
const pickText = (name: string, re: RegExp): string => {
  const m = re.exec(fixture(name))?.[1]
  if (m === undefined) throw new Error(`${name} 里没有 ${re}`)
  return m
}
const SHOPIFY = '<script src="https://cdn.shopify.com/x.js"></script>'

const FRESH: Record<string, { origin: string; home: string; privacy: string }> = {
  'zh-CN': {
    origin: 'https://xinpu.example',
    home: 'fresh-zh-cn-home.html',
    privacy: 'fresh-zh-cn-privacy.html',
  },
  'zh-TW': {
    origin: 'https://xinpu-tw.example',
    home: 'fresh-zh-tw-home.html',
    privacy: 'fresh-zh-tw-privacy.html',
  },
  ja: {
    origin: 'https://atarashii.example',
    home: 'fresh-ja-home.html',
    privacy: 'fresh-ja-privacy.html',
  },
}

/** 把店名换成一个真名字：只靠首页占位文字还认不认得出来。 */
const renamed = (html: string): string =>
  html
    .replace(/我的商店|My Store/g, 'Brightpath')
    .replace(/<title>[^<]*<\/title>/, '<title>Brightpath</title>')

describe('WP250 · 官方文案数据（决策 103：只存哈希）', () => {
  it('每处默认文字都有 en / zh-CN / zh-TW / ja / ko / de / fr / es（模板写死的英文、老主题两句除外）', () => {
    for (const c of SHOPIFY_DEFAULT_HOME_TEXTS) {
      for (const t of c.texts) for (const h of t.sentences) expect(h).toMatch(/^[0-9a-f]{16}$/)
      expect(Object.keys(c.texts[0] ?? {}).sort()).toEqual(['from', 'lang', 'sentences'])
      if (c.id === 'home_banner_browse' || c.id.startsWith('legacy_')) continue
      const langs = new Set(c.texts.map((t) => t.lang))
      for (const l of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'de', 'fr', 'es'])
        expect(langs.has(l), `${c.id} 缺 ${l}`).toBe(true)
      for (const t of c.texts)
        expect(t.from).toMatch(/^Shopify\/(dawn|horizon)@[0-9a-f]{8}:locales\//)
    }
  })

  it('数据文件里没有原文：夹具上的每个文本节点都不在数据文件源码里', () => {
    for (const name of [
      'fresh-home.html',
      'fresh-zh-cn-home.html',
      'fresh-zh-tw-home.html',
      'fresh-ja-home.html',
    ])
      for (const node of fixture(name).split(/<[^>]*>/)) {
        const t = node.trim()
        if (t.length < 4) continue
        expect(DATA_SOURCE.includes(t), `${name}：${t}`).toBe(false)
      }
  })

  it('归一：去标签、全角半角、空白标点都不影响比对', () => {
    expect(normalizeForMatch('<p>今年春茶已到。满 299 元包邮</p>')).toBe(
      normalizeForMatch('今年春茶已到. \n 满299元包邮'),
    )
    expect(normalizeForMatch('一棵樹、一批茶，或')).toBe(normalizeForMatch('一棵樹,一批茶, 或'))
    expect(normalizeForMatch('Hand&nbsp;Made Tea')).toBe('handmadetea')
  })

  it('切句：句末标点切，换行和小数点不切', () => {
    expect(sentencesOf('春茶到了。满 299\n元包邮！Free shipping. Only $19.99 today?')).toEqual([
      '春茶到了',
      '满299元包邮',
      'freeshipping',
      'only1999today',
    ])
    expect(textHashes('<p>一句。两句。</p>')).toHaveLength(2)
  })

  it('一段官方文案整段照搬、拆进几个节点、嵌在更长的一段里，都认得出', () => {
    const body = pickText('fresh-zh-cn-home.html', /rich-text__text rte"><p>([^<]+)<\/p>/)
    const hashes = textHashes(body)
    const has = (html: string) => {
      const page = pageSentenceHashes(html)
      return hashes.every((h) => page.has(h))
    }
    expect(has(`<p>${body}</p>`)).toBe(true)
    expect(has(`<p>我们从 2015 年开始做茶。${body}欢迎来店里坐坐。</p>`)).toBe(true)
    const [first, ...rest] = body.split('。')
    expect(has(`<h3>${first}。</h3><div><span>${rest.join('。')}</span></div>`)).toBe(true)
    // 改了一个字就对不上
    expect(has(`<p>${body.replace('品牌', '茶园')}</p>`)).toBe(false)
  })
})

describe('WP250 · 占位店名', () => {
  it('中文候选也算，忽略大小写与首尾空白', () => {
    for (const n of ['我的商店', ' 我的店铺 ', '我的商店名称', 'my store', ' MY SHOP '])
      expect(isPlaceholderStoreName(n), n).toBe(true)
    for (const n of ['叶语茶舍', '我的商店小铺', 'My Storefront'])
      expect(isPlaceholderStoreName(n), n).toBe(false)
  })
})

describe('WP250 · 简体 / 繁体 / 日文空店', () => {
  for (const [lang, f] of Object.entries(FRESH)) {
    it(`${lang}：认出空店，品牌名 / 一句话不填，自动生成的政策不进`, async () => {
      const { fetch } = replayFetch({
        [`${f.origin}/`]: f.home,
        [`${f.origin}/policies/privacy-policy`]: f.privacy,
      })
      const out = await analyzeSite(fetch, `${f.origin}/`, { maxPages: 30 })
      expect(out.fresh_store).toBe(true)
      expect(out.profile.brand_name).toBeUndefined()
      expect(out.profile.one_liner).toBeUndefined()
      expect(out.profile.policies).toBeUndefined()
      expect(out.profile.storefront_platform?.value).toBe('shopify')
      expect(out.pages.some((p) => p.kind === 'policy' && p.ok)).toBe(true)
    })

    it(`${lang}：店名改过了，光靠首页占位文字也认得出`, () => {
      const html = renamed(fixture(f.home))
      expect(isFreshShopifyStore(html, 'Brightpath')).toBe(true)
      expect(placeholderTextHits(html).length).toBeGreaterThanOrEqual(3)
    })
  }

  it('中英混排：各语言命中合并计数，同一处的两种语言只算一处', () => {
    const zhWelcome = pickText(
      'fresh-zh-cn-home.html',
      /announcement-bar__message h5"><span>([^<]+)</,
    )
    const twWelcome = pickText(
      'fresh-zh-tw-home.html',
      /announcement-bar__message h5"><span>([^<]+)</,
    )
    // 公告栏简繁各一遍 = 一处 → 不算
    const twice = `${SHOPIFY}<p>${zhWelcome}</p><p>${twWelcome}</p><main><p>手工茶。</p></main>`
    expect(placeholderTextHits(twice)).toEqual(['announcement_welcome'])
    expect(isFreshShopifyStore(twice, 'Leafwise')).toBe(false)
    // 英文富文本标题 + 中文示例商品名 = 两处 → 算
    const enHeading = pickText(
      'fresh-home.html',
      /rich_text" class="shopify-section">\s*<h2>([^<]+)</,
    )
    const zhProduct = pickText('fresh-zh-cn-home.html', /<li><a href="#">([^<]+)</)
    const mixed = `${SHOPIFY}<main><h2>${enHeading}</h2><li>${zhProduct}</li></main>`
    expect(placeholderTextHits(mixed).sort()).toEqual([
      'example_product_title',
      'rich_text_heading',
    ])
    expect(isFreshShopifyStore(mixed, 'Leafwise')).toBe(true)
  })
})

describe('WP250 · 正式店不误判', () => {
  const ORIGIN = 'https://yeyu.example'
  const pages = (home: string) => {
    const html = fixture('zh-shop-home.html')
    const body =
      home === 'only-welcome'
        ? html.replace(/(<h2 class="banner__heading">)[^<]*(<\/h2>)/, '$1春茶上新$2')
        : html
    return async (url: string) => {
      if (url === `${ORIGIN}/`) return { ok: true, status: 200, text: async () => body }
      if (url === `${ORIGIN}/policies/refund-policy`)
        return { ok: true, status: 200, text: async () => fixture('zh-shop-refund.html') }
      return { ok: false, status: 404, text: async () => '' }
    }
  }

  it('只留了公告栏的默认欢迎语：不是空店，品牌名 / 一句话 / 政策照旧', async () => {
    const out = await analyzeSite(pages('only-welcome'), `${ORIGIN}/`, { maxPages: 30 })
    expect(out.fresh_store).toBeUndefined()
    expect(out.profile.brand_name?.value).toBe('叶语茶舍')
    expect(out.profile.one_liner?.value).toBe('只做云南古树茶，一棵树一批茶。')
    expect(out.profile.policies?.value.map((p) => p.kind)).toEqual(['refund'])
  })

  it('公告栏 + 横幅那两句常被留着的默认文字都在：仍不算空店', async () => {
    const html = fixture('zh-shop-home.html')
    expect(placeholderTextHits(html).sort()).toEqual(['announcement_welcome', 'home_banner_browse'])
    expect(isFreshShopifyStore(html, '叶语茶舍')).toBe(false)
    const out = await analyzeSite(pages('as-is'), `${ORIGIN}/`, { maxPages: 30 })
    expect(out.fresh_store).toBeUndefined()
    expect(out.profile.brand_name?.value).toBe('叶语茶舍')
  })
})
