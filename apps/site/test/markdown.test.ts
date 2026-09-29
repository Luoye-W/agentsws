/**
 * 文档区 / 更新日志 / 条款共用的安全渲染：与工作台 SafeMarkdown 同一套四条纪律。
 */
import { describe, expect, it } from 'vitest'
import {
  docHref,
  escapeHtml,
  headingId,
  linkKind,
  parseMarkdown,
  renderDoc,
  renderInline,
  splitFrontmatter,
  stripSourceComments,
} from '../src/lib/markdown.js'

const zh = { lang: 'zh' as const, helpSlugs: ['conn-email', 'agentsws-credits'] }
const en = { lang: 'en' as const, helpSlugs: ['conn-email'] }

describe('不解析 HTML、不加载图片', () => {
  it('标签一律转义成字', () => {
    const html = renderInline('<script>alert(1)</script> & <b>x</b>', zh)
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('&amp;')
  })

  it('整篇里的 HTML 也当字', () => {
    const { html } = renderDoc('# 标题\n\n<img src=x onerror=alert(1)>\n\n<div>hi</div>', zh)
    expect(html).not.toMatch(/<img|<div/u)
  })

  it('图片只留说明文字', () => {
    expect(renderInline('看 ![截图说明](https://evil.example/x.png) 这里', zh)).toBe(
      '看 截图说明 这里',
    )
  })
})

describe('链接只认三种', () => {
  it('外链：新窗口 + noopener', () => {
    expect(renderInline('[Shopify](https://shopify.dev/x)', zh)).toBe(
      '<a href="https://shopify.dev/x" target="_blank" rel="noopener noreferrer">Shopify</a>',
    )
  })

  it('help:<slug> → 官网 /docs/<slug>/（英文加 /en）；不存在的教程原样当字', () => {
    expect(renderInline('[连邮箱](help:conn-email)', zh)).toBe(
      '<a href="/docs/conn-email/">连邮箱</a>',
    )
    expect(renderInline('[mail](help:conn-email)', en)).toBe(
      '<a href="/en/docs/conn-email/">mail</a>',
    )
    expect(renderInline('[没有](help:no-such)', zh)).toBe('[没有](help:no-such)')
  })

  it('工作台站内路径：官网上没有这页，只留文字 +「在工作台里」', () => {
    expect(renderInline('在 [设置 → 账号与积分](/settings/credits) 里', zh)).toBe(
      '在 <span class="in-app">设置 → 账号与积分</span>（在工作台里） 里',
    )
    expect(renderInline('[Settings](/settings/credits)', en)).toContain(' (in the app)')
  })

  it('条款页的站内路径：是官网自己的页，英文加 /en', () => {
    expect(renderInline('[隐私政策](/privacy/)', { ...zh, internal: 'site' })).toBe(
      '<a href="/privacy/">隐私政策</a>',
    )
    expect(renderInline('[Privacy](/privacy/)', { ...en, internal: 'site' })).toBe(
      '<a href="/en/privacy/">Privacy</a>',
    )
  })

  it('javascript: / data: / // 开头：原样当字', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.example']) {
      expect(linkKind(bad, [])).toBeUndefined()
      expect(renderInline(`[点我](${bad})`, zh)).not.toContain('<a')
    }
  })
})

describe('块与整篇', () => {
  it('块的认法与工作台一致：标题、列表、编号接着数、表格、提示框、代码块', () => {
    const blocks = parseMarkdown(
      '# T\n\n- a\n- b\n\n3. c\n4. d\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n> tip\n\n```sh\n<raw>\n```',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'ul', 'ol', 'table', 'quote', 'code'])
    expect(blocks[2]).toMatchObject({ kind: 'ol', start: 3 })
  })

  it('第一个 # 标题当页面标题，二级标题进目录，第一段当摘要', () => {
    const doc = renderDoc(
      '# 连 Shopify\n\n这篇讲 **怎么** 连。\n\n## 第一步\n\n文字\n\n## 常见问题',
      zh,
    )
    expect(doc.title).toBe('连 Shopify')
    expect(doc.summary).toBe('这篇讲 怎么 连。')
    expect(doc.toc.map((t) => t.text)).toEqual(['第一步', '常见问题'])
    expect(doc.html).not.toContain('<h1')
    expect(doc.html).toContain('<h2 id="第一步">')
  })

  it('代码块里的内容原样转义', () => {
    expect(renderDoc('```\n<b>&</b>\n```', zh).html).toBe(
      '<pre><code>&lt;b&gt;&amp;&lt;/b&gt;</code></pre>',
    )
  })

  it('标题锚点、转义、docHref', () => {
    expect(headingId('**FAQ** & Links')).toBe('faq-links')
    expect(escapeHtml(`"'<>&`)).toBe('&quot;&#39;&lt;&gt;&amp;')
    expect(docHref('browser', 'zh')).toBe('/docs/browser/')
    expect(docHref('browser', 'en')).toBe('/en/docs/browser/')
  })
})

describe('frontmatter 与源文件注释', () => {
  it('frontmatter', () => {
    const { data, body } = splitFrontmatter('---\ndate: 2026-09-29\ntitle: "B2B"\n---\n\n正文')
    expect(data).toEqual({ date: '2026-09-29', title: 'B2B' })
    expect(body.trim()).toBe('正文')
  })

  it('开头的 HTML 注释拿掉，不上页面', () => {
    expect(stripSourceComments('<!--\n  上线前建议律师审阅\n-->\n# 用户条款')).toBe('# 用户条款')
  })
})
