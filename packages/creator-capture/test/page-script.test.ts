// @vitest-environment node
/**
 * WP496：生成的页面脚本（`src/page-script.generated.ts`）与源码对得上——采集器改了忘了重出，这里红。
 * 重出：`node scripts/build-page-script.mjs`。
 */
import { describe, expect, it } from 'vitest'
// @ts-expect-error 打包脚本是 .mjs（只在测试 / 构建时用）
import { bundlePageScript } from '../scripts/page-bundle.mjs'
import { CREATOR_CAPTURE_PAGE_BUNDLE } from '../src/page-script.generated.js'
import { creatorCapturePageExpression, PAGE_ARGS_PLACEHOLDER } from '../src/page-script.js'

describe('页面脚本', () => {
  it('生成的那份 = 现在的源码打出来的', async () => {
    expect(CREATOR_CAPTURE_PAGE_BUNDLE).toBe(await bundlePageScript())
  })

  it('只读：不点、不滚、不打字、不发请求、不碰存储与剪贴板', () => {
    const src = CREATOR_CAPTURE_PAGE_BUNDLE
    for (const banned of [
      /\.click\(/,
      /scrollTo|scrollBy|scrollIntoView/,
      /\bfetch\(/,
      /XMLHttpRequest/,
      /sendBeacon/,
      /localStorage|sessionStorage|indexedDB/,
      /document\.cookie/,
      /chrome\.\w/,
      /navigator\.clipboard/,
      /\.dispatchEvent\(/,
      /\.submit\(/,
      /new WebSocket/,
      /window\.open\(/,
      /location\.(assign|replace|href\s*=)/,
    ])
      expect(src, String(banned)).not.toMatch(banned)
  })

  it('参数只换那一处记号；as_url 只换 window.location', () => {
    const expr = creatorCapturePageExpression({ lang: 'zh', as_url: 'https://www.youtube.com/@x' })
    expect(expr).not.toContain(PAGE_ARGS_PLACEHOLDER)
    expect(expr.endsWith('})({"lang":"zh","as_url":"https://www.youtube.com/@x"})')).toBe(true)
    expect(creatorCapturePageExpression().endsWith('})({})')).toBe(true)
  })
})
