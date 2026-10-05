/**
 * WP113（63 §7）：一封信的正文。
 *
 * **两层防护的第二层**：服务端已经按白名单净化过（`packages/channels` 的
 * `sanitize.ts`），这里再把它塞进一个 `<iframe sandbox>` ——`sandbox` 不带
 * `allow-scripts` 也不带 `allow-same-origin`，于是就算净化那一层将来漏了一条规则，
 * 漏进来的东西也跑不了脚本、读不到我们的 cookie。
 *
 * **远程图片默认不加载**：服务端把 `src` 搬去了 `data-ws-remote-src`，
 * 所以在人按下「显示图片」之前，浏览器一个请求都不会发出去——追踪像素要的就是
 * 那一个请求。按了之后由服务端把那一份搬回来（唯一一份真源在服务端）。
 *
 * 没有 HTML 的信（纯文本）照原样用 `<pre>` 显示，不走 iframe——那一条路上没有
 * 任何可执行的东西，多套一层只会让选中复制变难。

 * **正文里的链接（WP227，Luoye 10-05 #9）**：点了用系统浏览器 / 新窗口打开。沙箱只为这一步
 * 开最小的口子 `allow-popups allow-popups-to-escape-sandbox`（仍然无脚本、无同源、无表单、
 * 不许动顶层窗口）：开出去的是一个独立的新窗口，不是这个沙箱。放行前在这里再筛一遍链接：
 * 只有 http / https / mailto 留着 `href` 且一律 `target=_blank rel="noopener noreferrer"`，
 * 其它协议（`tel:` `file:` `javascript:` 相对地址……）一律拿掉 `href`，点了什么都不发生。
 * 桌面壳那一侧 `setWindowOpenHandler` 再按同一份白名单交给 `shell.openExternal`
 * （`apps/desktop/src/navigation.ts`），永远不在壳里开新窗口。
 */
import type { MessageRecord } from '@agentsws/contracts'
import { type ReactNode, useEffect, useRef } from 'react'
import { useApp } from '@/lib/app-context'

/** 正文链接只放行这三种协议（和桌面壳 `navigation.ts` 的外链白名单一致）。 */
export const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/** 沙箱：只为「点链接新开窗口」开口子；脚本、同源、表单、顶层导航一个都不给。 */
export const BODY_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox'

/**
 * WP227：把正文里的链接筛一遍。白名单协议 → 新窗口 + 断 opener / referrer；
 * 页内锚点（`#xx`）留着、只在框里跳；其余拿掉 `href`（字照留）。
 */
export function guardLinks(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const a of Array.from(doc.querySelectorAll('a[href], area[href]'))) {
    const href = (a.getAttribute('href') ?? '').trim()
    if (href.startsWith('#')) {
      a.removeAttribute('target')
      continue
    }
    let ok = false
    try {
      ok = LINK_PROTOCOLS.has(new URL(href).protocol)
    } catch {
      ok = false
    }
    if (ok) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
    } else {
      a.removeAttribute('href')
      a.removeAttribute('target')
    }
  }
  return doc.body.innerHTML
}

/** iframe 里那份文档的壳：只给最基本的排版，不引任何外部资源。 */
function documentOf(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<style>',
    'body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a;word-break:break-word}',
    'img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}a:not([href]){color:inherit;text-decoration:none}',
    'blockquote{margin:8px 0;padding-left:10px;border-left:2px solid #e5e5e5;color:#666}',
    '</style></head><body>',
    html,
    '</body></html>',
  ].join('')
}

/**
 * WP204：正文大概多高（像素）。块级标签与字数算行数，图片按标的高度算，没标的按 200；
 * 夹在 120–900 之间。只是估计——估少了框里能滚，估多了留点白。
 */
export function estimateHeight(html: string): number {
  const blocks = (html.match(/<(p|br|div|tr|li|h[1-6]|blockquote)\b/gi) ?? []).length
  const text = html.replace(/<[^>]*>/g, '').length
  let images = 0
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const h = /height="(\d+)"/.exec(m[0])?.[1]
    images += h === undefined ? 200 : Math.min(Number(h), 600)
  }
  return Math.max(120, Math.min(900, 24 + blocks * 26 + Math.ceil(text / 70) * 22 + images))
}

export function MessageBody({ message }: { message: MessageRecord }): ReactNode {
  const { t } = useApp()
  const frame = useRef<HTMLIFrameElement>(null)

  // 高度跟着内容走：邮件的版式千奇百怪，写死一个高度不是滚两层就是留一大片白
  useEffect(() => {
    const el = frame.current
    if (el === null) return
    const fit = (): void => {
      const doc = el.contentDocument
      if (doc === null) return
      el.style.height = `${Math.max(120, doc.body.scrollHeight + 16)}px`
    }
    el.addEventListener('load', fit)
    fit()
    return () => {
      el.removeEventListener('load', fit)
    }
  }, [])

  if (message.html === undefined || message.html === '') {
    return (
      <pre
        data-testid="message-text"
        className="whitespace-pre-wrap font-sans text-[13.5px] leading-relaxed text-ws-body"
      >
        {message.text}
      </pre>
    )
  }

  return (
    <iframe
      ref={frame}
      data-testid="message-html"
      title={t('messages.body')}
      // 无脚本、无同源：净化那一层将来漏了一条规则，这一层仍然兜得住。
      // WP227：只多开「点链接新开窗口」这一个口子（见文件头）
      sandbox={BODY_SANDBOX}
      srcDoc={documentOf(guardLinks(message.html))}
      // WP204：无同源的 iframe 里量不到内容高度（上面那个 fit 读 contentDocument 永远是 null），
      // 以前就停在浏览器缺省的 150px——「显示图片」之后题图一撑，正文就被挤到框外看不见了。
      // 现在按正文粗估一个高度（估少了在框里滚）。要真贴合得放开同源（仍无脚本），留给 Luoye 定。
      style={{ height: `${estimateHeight(message.html)}px` }}
      className="max-h-[70vh] w-full border-0 bg-white"
    />
  )
}
