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
 */
import type { MessageRecord } from '@agentsws/contracts'
import { type ReactNode, useEffect, useRef } from 'react'
import { useApp } from '@/lib/app-context'

/** iframe 里那份文档的壳：只给最基本的排版，不引任何外部资源。 */
function documentOf(html: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<meta name="referrer" content="no-referrer">',
    '<style>',
    'body{margin:0;font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a;word-break:break-word}',
    'img{max-width:100%;height:auto}table{max-width:100%}a{color:#2563eb}',
    'blockquote{margin:8px 0;padding-left:10px;border-left:2px solid #e5e5e5;color:#666}',
    '</style></head><body>',
    html,
    '</body></html>',
  ].join('')
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
      // 无脚本、无同源：净化那一层将来漏了一条规则，这一层仍然兜得住
      sandbox=""
      srcDoc={documentOf(message.html)}
      className="w-full border-0 bg-white"
    />
  )
}
