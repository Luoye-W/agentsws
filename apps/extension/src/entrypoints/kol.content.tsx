/**
 * 三个平台页面上的那一块（WP119 定论 2）。
 *
 * 四件事，一件都不多：
 *
 * 1. **不点不出现**。挂载发生在用户按工具栏图标之后。页面加载时这个脚本只是
 *    在那儿待着，一个字段都不解析、一个请求都不发。
 * 2. **解析在按下的那一刻**。面板打开时读一次当前页；用户在 SPA 里换了人，
 *    面板会跟着换 key 重建，但**不会**自己重新上报。
 * 3. **活在 shadow root 里**。页面的 CSS 进不来，我们的也出不去——
 *    YouTube 换一次皮肤这张卡不会跟着花，我们也不会把 YouTube 弄花。
 * 4. **全屏时整块藏起来**（不是卸载）：用户看完视频退出全屏，面板与刚填的
 *    阈值都还在。
 */

import { createRoot, type Root } from 'react-dom/client'
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root'
import { defineContentScript } from 'wxt/utils/define-content-script'
import { routeOf } from '@/lib/parse/route'
import { parseInstagramProfile, parseTikTokProfile } from '@/lib/parse/social'
import { parseYouTubeChannel, parseYouTubeWatch } from '@/lib/parse/youtube'
import type { ContentSnapshot, CreatorSnapshot } from '@/lib/snapshot'
import { Panel } from '@/ui/panel'
import '@/ui/tokens.css'

/** 当前这一页解析成什么。解析不出来就三个都没有，面板会老实说看不懂。 */
function readPage(href: string): {
  creator?: CreatorSnapshot | undefined
  content?: ContentSnapshot | undefined
  search?: { query: string; pageUrl: string } | undefined
} {
  const route = routeOf(href)
  if (route === undefined) return {}
  const now = new Date().toISOString()
  if (route.kind === 'search') return { search: { query: route.subject, pageUrl: href } }
  if (route.kind === 'content') {
    return route.platform === 'youtube' ? { content: parseYouTubeWatch(document, href, now) } : {}
  }
  if (route.platform === 'youtube') return { creator: parseYouTubeChannel(document, href, now) }
  if (route.platform === 'instagram') return { creator: parseInstagramProfile(document, href, now) }
  return { creator: parseTikTokProfile(document, href, now) }
}

export default defineContentScript({
  matches: ['https://*.youtube.com/*', 'https://*.instagram.com/*', 'https://*.tiktok.com/*'],
  runAt: 'document_idle',
  cssInjectionMode: 'ui',

  async main(ctx) {
    let root: Root | undefined
    let open = false

    const ui = await createShadowRootUi(ctx, {
      name: 'agentsws-kol-assistant',
      position: 'inline',
      anchor: 'body',
      onMount: (container) => {
        root = createRoot(container)
        return root
      },
      onRemove: () => {
        root?.unmount()
        root = undefined
      },
    })

    const render = (): void => {
      if (!open || root === undefined) return
      const href = location.href
      const page = readPage(href)
      root.render(
        <Panel
          key={href}
          {...page}
          onClose={() => {
            open = false
            ui.remove()
          }}
        />,
      )
    }

    // 工具栏图标：按一下开 / 关。**这是面板出现的唯一入口。**
    chrome.runtime.onMessage.addListener((message: { type?: string }) => {
      if (message.type !== 'toggle-panel') return
      if (open) {
        open = false
        ui.remove()
        return
      }
      open = true
      ui.mount()
      render()
    })

    // SPA 换页：面板开着就跟着换一页的内容（换 key 重建），**不自动上报**。
    ctx.addEventListener(window, 'wxt:locationchange', () => {
      if (open) render()
    })
  },
})
