/**
 * WP113（63 §7）：邮件 HTML 正文的**服务端净化**。
 *
 * 两层防护，缺一不可：
 * ① 这里（服务端）：白名单标签 / 白名单属性 / 扔掉 `script`·`style`·`iframe`·
 *    `object`·`embed`·`form` 与一切 `on*` 事件、`javascript:` 链接；
 * ② 前端（`apps/workstation`）：再套一层 `<iframe sandbox>`（无脚本、无同源）。
 *
 * 为什么不装 `sanitize-html`：它自带 `htmlparser2` + `postcss` 一串传递依赖，
 * 而我们要的只是"白名单 + 去远程图片"这两件事，而且**净化的结果还要再被
 * sandbox iframe 兜一次**——多一个供应链入口换不到那一层额外保证。这个文件
 * 有自己的用例表（`test/messages.test.ts` 的第 ① 组），改一条规则就能看见后果。
 *
 * **远程图片默认不加载**（防追踪像素）。做法不是删掉 `<img>`（那样版式就塌了），
 * 是把 `src` 搬到 `data-ws-remote-src`：界面上按"显示图片"时前端把它搬回去，
 * 在此之前浏览器一个请求都不会发出去——追踪像素要的就是那一个请求。
 */

/** 留下来的标签。没列在这里的一律**只留它的文字**（不是连内容一起删）。 */
const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'col',
  'colgroup',
  'dd',
  'div',
  'dl',
  'dt',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  's',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
])

/** 连内容一起扔掉的（留下文字反而更糟：CSS 源码、脚本源码会变成正文）。 */
const DROP_WITH_CONTENT =
  /<(script|style|head|title|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi

/** 这几个自己没有结束标签，也一律不留。 */
const DROP_VOID = /<(?:base|link|meta|input|button|source|track|param)\b[^>]*>/gi

/** 表单与内嵌：整段扔（含内容）。 */
const DROP_FRAMES =
  /<(iframe|object|embed|form|frameset|frame|applet|audio|video)\b[\s\S]*?(?:<\/\1\s*>|$)/gi

/** 每个标签保留哪些属性。`*` 是所有标签通用的那几个。 */
const ALLOWED_ATTRS: Readonly<Record<string, readonly string[]>> = {
  '*': ['title', 'dir', 'lang', 'align', 'colspan', 'rowspan'],
  a: ['href'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan'],
}

/** 链接协议白名单。`javascript:` / `data:` / `vbscript:` 一律丢掉整个属性。 */
const SAFE_HREF = /^(?:https?:|mailto:|tel:|#)/i

/** 远程图片：`http(s)://…`。`cid:` 与 `data:image/…` 不是远程，不拦。 */
const REMOTE_SRC = /^https?:\/\//i

export interface SanitizedHtml {
  html: string
  /** 拆掉过远程图片吗（界面据此出"显示图片"那一行）。 */
  has_remote_images: boolean
}

/**
 * 净化一段邮件 HTML。
 *
 * 空串进空串出。**永不抛**——一封信的版式再畸形也不该让整封信读不到
 * （读不到的那一封仍然有纯文本 `text` 兜底）。
 */
export function sanitizeMessageHtml(html: string): SanitizedHtml {
  if (html.trim().length === 0) return { html: '', has_remote_images: false }
  let hasRemote = false
  const stripped = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(DROP_WITH_CONTENT, '')
    .replace(DROP_FRAMES, '')
    .replace(DROP_VOID, '')

  const out = stripped.replace(
    /<\/?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g,
    (whole, rawName: string, rawAttrs: string) => {
      const name = rawName.toLowerCase()
      if (!ALLOWED_TAGS.has(name)) return ''
      if (whole.startsWith('</')) return `</${name}>`
      const selfClosing = /\/\s*$/.test(rawAttrs)
      const kept: string[] = []
      for (const attr of parseAttributes(rawAttrs)) {
        const key = attr.name.toLowerCase()
        // `on*` 一个都不留——它是 HTML 里唯一可以直接执行脚本的地方
        if (key.startsWith('on')) continue
        const allowed = ALLOWED_ATTRS['*'] ?? []
        const perTag = ALLOWED_ATTRS[name] ?? []
        if (!allowed.includes(key) && !perTag.includes(key)) continue
        const value = attr.value
        if (key === 'href') {
          if (!SAFE_HREF.test(value.trim())) continue
          kept.push(`href="${escapeAttr(value)}"`)
          continue
        }
        if (key === 'src') {
          if (REMOTE_SRC.test(value.trim())) {
            hasRemote = true
            // 搬到 data-* 上：在人按下"显示图片"之前，浏览器不会去请求它
            kept.push(`data-ws-remote-src="${escapeAttr(value)}"`)
            continue
          }
          if (!/^cid:|^data:image\//i.test(value.trim())) continue
          kept.push(`src="${escapeAttr(value)}"`)
          continue
        }
        kept.push(`${key}="${escapeAttr(value)}"`)
      }
      // 外链一律新窗口打开，且断掉 `window.opener`
      if (name === 'a' && kept.some((k) => k.startsWith('href='))) {
        kept.push('target="_blank"', 'rel="noopener noreferrer"')
      }
      const body = kept.length === 0 ? name : `${name} ${kept.join(' ')}`
      return selfClosing || name === 'br' || name === 'img' || name === 'hr'
        ? `<${body} />`
        : `<${body}>`
    },
  )

  return { html: out.trim(), has_remote_images: hasRemote }
}

interface ParsedAttr {
  name: string
  value: string
}

function parseAttributes(raw: string): ParsedAttr[] {
  const out: ParsedAttr[] = []
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
  for (const m of raw.matchAll(re)) {
    const name = m[1]
    if (name === undefined) continue
    out.push({ name, value: m[3] ?? m[4] ?? m[5] ?? '' })
  }
  return out
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 「总是信任这个发件人」之后，把远程图片搬回 `src`。
 *
 * 搬回去这一步在**服务端**做（而不是让前端 `innerHTML` 里改）：净化后的那一份
 * 是唯一一份真源，前端只负责把它塞进 sandbox iframe。
 */
export function restoreRemoteImages(html: string): string {
  return html.replace(/data-ws-remote-src=/g, 'src=')
}
