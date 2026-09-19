import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BrandDesignProfile } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { chroma, isNeutral, parseColor, saturation } from '../src/color.js'
import { cssVariables, parseCss, resolveVar, stripComments, stylesheetHrefs } from '../src/css.js'
import { type DesignPageInput, extractSiteDesign } from '../src/site-design.js'
import { worthFetching } from '../src/site-fetch.js'
import {
  regionAt,
  selectorKey,
  selectorReach,
  structureWeight,
  varNameFactor,
} from '../src/weight.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const fixture = (name: string): string => readFileSync(join(HERE, 'fixtures', name), 'utf8')

/** 夹具一：Shopify 风格的站（CSS 变量 + 外链主题样式表 + theme-color）。 */
function shopifyPages(): DesignPageInput[] {
  return [
    {
      url: 'https://heritage.test/',
      kind: 'home',
      html: fixture('shopify-home.html'),
      sheets: [
        {
          url: 'https://cdn.shopify.com/s/files/1/0001/theme.css',
          css: fixture('shopify-theme.css'),
        },
      ],
    },
  ]
}

/** 夹具二：自建站（全部内联，没有一个 CSS 变量）。 */
function customPages(): DesignPageInput[] {
  return [{ url: 'https://yunlan.test/', kind: 'home', html: fixture('custom-home.html') }]
}

const hexOf = (p: BrandDesignProfile, token: string): string | undefined => p.colors?.[token]?.value

describe('CSS 拆解', () => {
  it('先去注释再配对花括号 —— 注释里写 `{}` 是常事', () => {
    expect(stripComments('a{/* } */color:red}')).toBe('a{ color:red}')
    const decls = parseCss({ url: 'x', css: 'a{/* } */color:red}' })
    expect(decls).toEqual([{ selector: 'a', prop: 'color', value: 'red', order: 0, from: 'x' }])
  })

  it('逗号选择器拆成好几条；@media 里的规则照样收，并记下它套在哪', () => {
    const decls = parseCss({ url: 'x', css: '@media (min-width:768px){h1,h2{font-size:32px}}' })
    expect(decls.map((d) => d.selector)).toEqual(['h1', 'h2'])
    expect(decls[0]?.at).toBe('@media (min-width:768px)')
  })

  it('var() 解引用，认 fallback，绕圈不死循环', () => {
    const vars = cssVariables(parseCss({ url: 'x', css: ':root{--a:var(--b);--b:#123456}' }))
    expect(resolveVar('var(--a)', vars)).toBe('#123456')
    expect(resolveVar('var(--missing, 8px)', vars)).toBe('8px')
    const loop = cssVariables(parseCss({ url: 'x', css: ':root{--x:var(--y);--y:var(--x)}' }))
    expect(() => resolveVar('var(--x)', loop)).not.toThrow()
  })

  it('外链样式表：相对地址补绝对，非 http 的丢掉', () => {
    const html =
      '<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="data:text/css,x">'
    expect(stylesheetHrefs(html, 'https://x.test/p')).toEqual(['https://x.test/a.css'])
  })

  it('只抓同源与站自己的 CDN，不为第三方跑一趟', () => {
    expect(worthFetching('https://x.test/a.css', 'https://x.test/')).toBe(true)
    expect(worthFetching('https://cdn.shopify.com/t/1/a.css', 'https://x.test/')).toBe(true)
    expect(worthFetching('https://tracker.example/a.css', 'https://x.test/')).toBe(false)
  })
})

describe('主次判定：按面积与位置，不只按频次（71 §5.2）', () => {
  it('页脚里出现八次的分隔线灰，排不过首屏铺满的品牌色', () => {
    const profile = extractSiteDesign(shopifyPages())
    // `.site-footer__divider` 在夹具里被放了 8 个，`--color-slate` 只在页脚用
    expect(hexOf(profile, 'primary')).toBe('#b8422e')
    expect(Object.values(profile.colors ?? {}).map((v) => v.value)).not.toEqual(
      expect.arrayContaining(['#6c7278', '#b8422e'].slice(0, 1).map(() => '#6c7278_as_primary')),
    )
    expect(hexOf(profile, 'primary')).not.toBe('#6c7278')
  })

  it('中性色与彩色分两堆挑 —— 否则前四名是白、黑、灰、灰', () => {
    const profile = extractSiteDesign(shopifyPages())
    expect(hexOf(profile, 'neutral')).toBe('#f7f5f2')
    expect(hexOf(profile, 'surface')).toBe('#ffffff')
    expect(hexOf(profile, 'on-surface')).toBe('#1a1c1e')
    // 主色那一格不许被中性色占掉
    const primary = parseColor(hexOf(profile, 'primary') ?? '')
    expect(primary).toBeDefined()
    expect(primary === undefined ? true : isNeutral(primary)).toBe(false)
  })

  it('中性色用彩度判，不用 HSL 饱和度 —— `#f7f5f2` 的饱和度比很多品牌色还高', () => {
    const paper = parseColor('#f7f5f2')
    expect(paper).toBeDefined()
    if (paper === undefined) return
    expect(saturation(paper)).toBeGreaterThan(0.2) // 饱和度会骗人
    expect(chroma(paper)).toBeLessThan(0.05) // 彩度不会
    expect(isNeutral(paper)).toBe(true)
  })

  it('语义色由选择器 / 变量名点名，不靠面积竞争', () => {
    const profile = extractSiteDesign(shopifyPages())
    expect(hexOf(profile, 'success')).toBe('#2f7d4f')
  })

  it('色板在界面上按规范推荐的次序排（主色第一，语义色不抢头名）', () => {
    const profile = extractSiteDesign(shopifyPages())
    expect(Object.keys(profile.colors ?? {})[0]).toBe('primary')
  })

  it('打分的三个乘数各自成立', () => {
    expect(structureWeight('.hero')).toBeGreaterThan(structureWeight('.site-footer'))
    expect(structureWeight('.btn')).toBeGreaterThan(structureWeight('.badge'))
    expect(varNameFactor('--color-brand')).toBeGreaterThan(varNameFactor('--color-border'))
    const html =
      '<body><header>a</header><div class="mid">b</div><footer><span class="f">c</span></footer></body>'
    expect(regionAt(html, html.indexOf('class="f"'))).toBe('footer')
  })

  it('页面上找不到的选择器整条不算数（挡掉框架自带那几千条没用上的工具类）', () => {
    expect(selectorReach('.never-used-anywhere', '<body><p>hi</p></body>')).toBeUndefined()
    expect(selectorKey('.a .b:hover')).toEqual({ kind: 'class', name: 'b' })
    expect(selectorKey('h1')).toEqual({ kind: 'tag', name: 'h1' })
  })
})

describe('字体阶梯', () => {
  it('Shopify 站：字号阶梯从 h1 排到小字，字体族跟着走', () => {
    const t = extractSiteDesign(shopifyPages()).typography ?? {}
    expect(t.h1?.value).toMatchObject({
      fontFamily: 'Public Sans',
      fontSize: '48px',
      fontWeight: 600,
    })
    expect(t.h1?.value.lineHeight).toBe(1.1)
    expect(t.h1?.value.letterSpacing).toBe('-0.02em')
    expect(t.h2?.value.fontSize).toBe('32px')
    expect(t.h3?.value.fontSize).toBe('24px')
    expect(t['body-md']?.value).toMatchObject({ fontFamily: 'Public Sans', fontSize: '16px' })
    expect(t['body-sm']?.value.fontSize).toBe('12px')
  })

  it('无单位 lineHeight 存成数字（规范允许，且这是 CSS 里推荐的写法）', () => {
    const t = extractSiteDesign(shopifyPages()).typography ?? {}
    expect(t['body-md']?.value.lineHeight).toBe(1.6)
  })

  it('`sans-serif` / `inherit` 不是品牌字体，是兜底 —— 不许进字体表', () => {
    const t = extractSiteDesign(customPages()).typography ?? {}
    expect(t['body-md']?.value.fontFamily).toBe('Noto Serif SC')
    for (const v of Object.values(t)) expect(v.value.fontFamily).not.toBe('serif')
  })
})

describe('出处：每个值都说得出它从哪来', () => {
  it('从 CSS 变量来的记变量名，把握度 high —— 那是站方自己声明的语义', () => {
    const profile = extractSiteDesign(shopifyPages())
    const primary = profile.colors?.primary
    expect(primary?.confidence).toBe('high')
    expect(
      primary?.source.some((s) => s.locator?.startsWith('css-var:--color-brand') === true),
    ).toBe(true)
  })

  it('没有变量名、只从规则里量出来的，把握度只能是 medium', () => {
    const profile = extractSiteDesign(customPages())
    expect(profile.colors?.primary?.confidence).toBe('medium')
    expect(profile.colors?.primary?.source[0]?.locator).toMatch(/^css:/)
  })

  it('出处带页面地址与原文片段，人能自己去核', () => {
    const profile = extractSiteDesign(shopifyPages())
    const source = profile.typography?.h1?.source[0]
    expect(source?.origin).toBe('site')
    expect(source?.url).toBe('https://heritage.test/')
    expect(source?.locator).toMatch(/h1\{font-/)
  })

  it('出处最多留 4 条 —— 再多是噪声，不是证据', () => {
    const profile = extractSiteDesign(shopifyPages())
    for (const v of Object.values(profile.colors ?? {}))
      expect(v.source.length).toBeLessThanOrEqual(4)
  })
})

describe('其余令牌组', () => {
  it('圆角：`9999px` / `50%` 单独进 `full`，别的按大小排 sm/md/lg', () => {
    const rounded = extractSiteDesign(shopifyPages()).rounded ?? {}
    expect(rounded.full?.value).toBe('9999px')
    expect(rounded.sm?.value).toBe('8px')
  })

  it('间距阶梯是数出来的，不是按 2 的幂套出来的', () => {
    const spacing = extractSiteDesign(shopifyPages()).spacing ?? {}
    const values = Object.values(spacing).map((v) => String(v.value))
    // 夹具里真出现过的值
    expect(values).toContain('8px')
    expect(values).toContain('16px')
    // 夹具里一次都没出现过的 128px 不许出现在阶梯里
    expect(values).not.toContain('128px')
  })

  it('组件：按钮 / 输入框 / 卡片 / 导航各自的样式', () => {
    const c = extractSiteDesign(shopifyPages()).components ?? {}
    expect(c['button-primary']?.rounded?.value).toBe('8px')
    expect(c.card?.backgroundColor?.value).toBe('#ffffff')
    expect(c.input?.padding?.value).toBe('12px')
  })

  it('logo：深浅版分得开，且只存 logo（别人站上的别的图一张都不碰）', () => {
    const logos = extractSiteDesign(customPages()).logos?.value ?? []
    expect(logos.map((l) => l.variant)).toEqual(['light', 'dark'])
    expect(logos[1]?.url).toBe('https://yunlan.test/img/logo-white.svg')
  })

  it('动效倾向：读得到过渡就说一句，读不到就没有这一格', () => {
    expect(extractSiteDesign(shopifyPages()).motion?.value).toMatch(/过渡节奏/)
    expect(
      extractSiteDesign([
        { url: 'https://x.test/', kind: 'home', html: '<html><body></body></html>' },
      ]).motion,
    ).toBeUndefined()
  })

  it('什么都抽不到的页面回一个空档案，不回一堆空字符串', () => {
    const profile = extractSiteDesign([
      { url: 'https://x.test/', kind: 'home', html: '<html><body>hi</body></html>' },
    ])
    expect(profile.colors).toBeUndefined()
    expect(profile.typography).toBeUndefined()
    expect(profile.logos).toBeUndefined()
  })
})
