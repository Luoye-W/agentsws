/**
 * WP246：网页转文字（本机那一级）。只喂本地夹具，不联网。
 */
import { describe, expect, it } from 'vitest'
import { htmlToReadable, parseHtmlTree } from '../src/index.js'

const ARTICLE = `<!doctype html><html lang="en"><head><title>Ignored title</title>
<meta property="og:title" content="How we built the Air3 display">
<style>.x{color:red}</style><script>var a = "<p>not text</p>";</script></head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<header><nav><a href="/">Home</a><a href="/shop">Shop</a><a href="/cart">Cart 0</a></nav></header>
<div class="cookie-banner">We use cookies. <button>Accept</button></div>
<div class="layout">
  <aside class="sidebar"><h3>Related</h3><a href="/a">Other post</a></aside>
  <article>
    <h1>How we built the Air3 display</h1>
    <p>The <strong>Air3</strong> uses a micro-OLED panel, which is why text looks sharp &amp; bright.</p>
    <p>Read the <a href="/specs">full specs</a> for details, including brightness, refresh rate and weight.</p>
    <ul><li>1080p per eye</li><li>120 Hz</li></ul>
    <pre>code &lt;here&gt;</pre>
    <div class="share-buttons"><a href="https://x.com/share">Share</a></div>
  </article>
</div>
<footer>© 2026 Example · <a href="/privacy">Privacy</a></footer>
</body></html>`

const DIV_SOUP = `<html><body>
<div id="top-menu"><a href="/">Home</a> <a href="/b">Blog</a> <a href="/c">Contact</a></div>
<div class="wrap"><div class="content">
<p>Battery life on the glasses is about four hours with mixed use, longer with subtitles only.</p>
<p>Charging from empty to full takes about fifty minutes with the bundled cable, faster with a PD charger.</p>
<p>Unclosed paragraph one with enough words to count as content in the scoring step.
<p>Unclosed paragraph two, also long enough, so the tolerant parser has to close the first one.
</div></div>
<div class="footer-links"><a href="/1">One</a><a href="/2">Two</a><a href="/3">Three</a></div>
</body></html>`

const SPA = `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`

describe('网页转文字（本机抽取）', () => {
  it('有 <article>：只留正文，去掉导航 / 页眉页脚 / 侧栏 / cookie 条 / 分享按钮', () => {
    const r = htmlToReadable(ARTICLE, 'https://example.com/blog/air3')
    expect(r.title).toBe('How we built the Air3 display')
    expect(r.lang).toBe('en')
    expect(r.markdown).toContain('# How we built the Air3 display')
    expect(r.markdown).toContain('**Air3**')
    expect(r.markdown).toContain('sharp & bright')
    expect(r.markdown).toContain('[full specs](https://example.com/specs)')
    expect(r.markdown).toContain('- 1080p per eye')
    expect(r.markdown).toContain('code <here>')
    for (const junk of [
      'Cart 0',
      'cookies',
      'Other post',
      'Privacy',
      'Share',
      'Skip to content',
      'not text',
    ])
      expect(r.markdown).not.toContain(junk)
    expect(r.chars).toBeGreaterThan(100)
    expect(r.truncated).toBe(false)
  })

  it('没有 <article>：按段落打分挑正文块，没闭合的 <p> 也收得住', () => {
    const r = htmlToReadable(DIV_SOUP, 'https://example.com/')
    expect(r.markdown).toContain('Battery life on the glasses')
    expect(r.markdown).toContain('Unclosed paragraph two')
    expect(r.markdown).not.toContain('Contact')
    expect(r.markdown).not.toContain('Three')
  })

  it('靠脚本现画的页面：抽不出正文（字数几乎为 0），交给调用方照实说', () => {
    const r = htmlToReadable(SPA, 'https://example.com/')
    expect(r.chars).toBeLessThan(10)
  })

  it('太长就截断并标出来', () => {
    const long = `<article>${'<p>word word word word word.</p>'.repeat(400)}</article>`
    const r = htmlToReadable(long, 'https://example.com/', 500)
    expect(r.truncated).toBe(true)
    expect(r.markdown.length).toBeLessThan(600)
  })

  it('建树器宽容：乱序闭合、脚本里的尖括号不崩', () => {
    const t = parseHtmlTree('<div><p>a<b>b</p></div></span><script>if(a<b){}</script><p>c')
    expect(t.children.length).toBeGreaterThan(0)
  })
})
