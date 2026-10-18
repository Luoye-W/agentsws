/**
 * WP424（Luoye 10-19）：邮件营销用的哪一家——只认官网自己挂着的脚本（订阅弹窗 / 埋点），
 * 认不出就不填（首次设置第 ④ 步就不会替人把哪一家列成要连的）。
 */
import { describe, expect, it } from 'vitest'
import type { PageFetch } from '../src/fetch.js'
import { analyzeSite, detectEmailService } from '../src/index.js'

const pagesFetch =
  (pages: Record<string, string>): PageFetch =>
  async (url) => {
    const html = pages[url]
    if (html === undefined) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => html }
  }

describe('WP424 · 官网上的邮件营销脚本', () => {
  it('认得出 Klaviyo / Omnisend / Mailchimp；只是正文里提到一个词不算', () => {
    expect(
      detectEmailService(
        '<script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=X"></script>',
      )?.label,
    ).toBe('Klaviyo')
    expect(
      detectEmailService('<script src="https://omnisnippet1.com/inshop/launcher.js">')?.label,
    ).toBe('Omnisend')
    expect(
      detectEmailService('<script src="https://chimpstatic.com/mcjs-connected/js/x.js">')?.label,
    ).toBe('Mailchimp')
    expect(detectEmailService('<p>We send newsletters every week.</p>')).toBeUndefined()
  })

  it('analyzeSite 把它记进档案（带出处）；没有就不出这一格', async () => {
    const home = `<html><head><meta property="og:site_name" content="Lumen Lamps"><script src="https://cdn.shopify.com/s/x.js"></script><script async src="https://static.klaviyo.com/onsite/js/klaviyo.js?company_id=AbC"></script></head><body><main><h1>Lumen Lamps</h1></main></body></html>`
    const out = await analyzeSite(
      pagesFetch({ 'https://lumen.example/': home }),
      'https://lumen.example/',
      { maxPages: 1 },
    )
    expect(out.profile.email_service).toMatchObject({
      value: 'Klaviyo',
      evidence: [expect.objectContaining({ locator: 'page:static.klaviyo.com' })],
    })

    const plain = await analyzeSite(
      pagesFetch({
        'https://plain.example/':
          '<html><head><title>Plain</title></head><body><h1>Plain</h1></body></html>',
      }),
      'https://plain.example/',
      { maxPages: 1 },
    )
    expect(plain.profile.email_service).toBeUndefined()
  })
})
