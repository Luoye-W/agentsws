/**
 * WP489（决策 1684）：用户贴一条在线表格的链接（飞书 / Google 表格 / 其它），工坊用**自己已登录的
 * 浏览器**打开读。不申请任何开发者应用、不要 API key。
 *
 * 这里是纯的那一半：
 *
 * - 认链接：是哪一家、先读哪个地址（Google 有一个浏览器里直接显示成表格的导出页，先读它；
 *   读不了再读表格页本身）；
 * - 读到的页面 → 格子（`<table>` 或一行一行用制表符隔开的文字）；
 * - 看页面是不是登录页 / 没权限页——是就照实说「登录一下」，不假装读到了；
 * - 读不出表 → 告诉用户「下载成 Excel 拖进来」。
 *
 * 打开页面那一跳由宿主注入（内置浏览器 / 插件里的浏览器，按用户的浏览器设置）。
 */

export type OnlineSheetKind = 'google' | 'feishu' | 'other'

export interface OnlineSheetPlan {
  kind: OnlineSheetKind
  /** 按顺序试的地址。`page` = 读页面上的字；`html` = 读页面原文（找 `<table>`）。 */
  reads: { url: string; as: 'page' | 'html' }[]
}

/** 一条链接 → 怎么读。不是 http(s) 的回 `undefined`。 */
export function onlineSheetPlan(raw: string): OnlineSheetPlan | undefined {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  const host = u.hostname.toLowerCase()
  if (host === 'docs.google.com') {
    const id = /\/spreadsheets\/d\/([\w-]+)/.exec(u.pathname)?.[1]
    if (id !== undefined) {
      const gid = /gid=(\d+)/.exec(`${u.search}${u.hash}`)?.[1]
      const exportUrl = `https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:html${
        gid === undefined ? '' : `&gid=${gid}`
      }`
      return {
        kind: 'google',
        reads: [
          { url: exportUrl, as: 'html' },
          { url: u.toString(), as: 'page' },
        ],
      }
    }
  }
  if (/(^|\.)(feishu\.cn|larksuite\.com|larkoffice\.com|feishu\.net)$/.test(host))
    return { kind: 'feishu', reads: [{ url: u.toString(), as: 'page' }] }
  return {
    kind: 'other',
    reads: [
      { url: u.toString(), as: 'html' },
      { url: u.toString(), as: 'page' },
    ],
  }
}

/** 浏览器那一跳读回来的东西（宿主拼）。 */
export interface OnlinePageRead {
  ok: boolean
  final_url?: string
  /** 页面原文（插件那条路给）。 */
  html?: string
  /** 页面上的字（内置浏览器那条路给；表格的一行是一行、格子之间是制表符）。 */
  text?: string
  /** 页面上有密码框（内置浏览器报的）。 */
  password_inputs?: number
  /** 读不了时那一句（浏览器没开 / 超时）。 */
  message?: string
}

export type OnlineSheetBlock = 'login' | 'no_access'

const LOGIN_HOSTS =
  /(^|\.)(accounts\.google\.com|passport\.feishu\.cn|accounts\.feishu\.cn|passport\.larksuite\.com|accounts\.larksuite\.com|login\.microsoftonline\.com)$/i

/** 读回来的是登录页 / 没权限页吗。 */
export function onlineSheetBlock(read: OnlinePageRead): OnlineSheetBlock | undefined {
  let host = ''
  let path = ''
  try {
    const u = new URL(read.final_url ?? '')
    host = u.hostname
    path = u.pathname
  } catch {
    // 没有最终地址：只看页面内容
  }
  if (LOGIN_HOSTS.test(host) || /\/(login|signin|sign-in|accounts\/login)\b/i.test(path))
    return 'login'
  if ((read.password_inputs ?? 0) > 0) return 'login'
  const body = `${read.text ?? ''} ${(read.html ?? '').slice(0, 200_000)}`
  if (/type=["']?password/i.test(read.html ?? '') && /sign in|log in|登录/i.test(body))
    return 'login'
  if (
    /you need (access|permission)|request access|ask for access|没有权限|无权限|需要权限|申请权限|无访问权限/i.test(
      body,
    )
  )
    return 'no_access'
  return undefined
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code =
        e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1))
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return ENTITIES[e.toLowerCase()] ?? m
  })
}

const cellText = (html: string): string =>
  decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' '),
  ).trim()

/** 页面原文里最大的那张 `<table>` → 格子。没有表回 `undefined`。 */
export function gridFromHtml(html: string): string[][] | undefined {
  const tables = html.match(/<table[\s\S]*?<\/table>/gi) ?? []
  let best: string[][] | undefined
  for (const t of tables) {
    const rows: string[][] = []
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells: string[] = []
      for (const cell of tr.match(/<t[dh]\b[^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []) {
        const span = Number(/colspan=["']?(\d+)/i.exec(cell)?.[1] ?? '1')
        const text = cellText(cell.replace(/^<t[dh]\b[^>]*>/i, '').replace(/<\/t[dh]>$/i, ''))
        cells.push(text)
        for (let i = 1; i < Math.min(span, 50); i += 1) cells.push(text)
      }
      if (cells.some((c) => c !== '')) rows.push(cells)
    }
    if (
      rows.length >= 2 &&
      (best === undefined ||
        rows.length * (rows[0]?.length ?? 0) > best.length * (best[0]?.length ?? 0))
    )
      best = rows
  }
  return best
}

/**
 * 页面上的字 → 格子：表格在页面文字里是一行一行、格子之间是制表符。至少两行、每行至少两格的那一段
 * 才算一张表（导航栏、按钮上的字不是）。
 */
export function gridFromText(text: string): string[][] | undefined {
  const rows = text
    .split(/\r?\n/)
    .map((l) => l.split('\t').map((c) => c.trim()))
    .filter((r) => r.length >= 2 && r.filter((c) => c !== '').length >= 2)
  return rows.length >= 2 ? rows : undefined
}

export function gridFromRead(read: OnlinePageRead): string[][] | undefined {
  if (read.html !== undefined) {
    const g = gridFromHtml(read.html)
    if (g !== undefined) return g
  }
  if (read.text !== undefined) return gridFromText(read.text)
  return undefined
}

/** 读不了时给人的那一句（短；卡面上就这一句）。 */
export function onlineSheetMessage(
  why: OnlineSheetBlock | 'unreadable' | 'no_browser',
  kind: OnlineSheetKind,
): string {
  const where = kind === 'google' ? 'Google' : kind === 'feishu' ? '飞书' : '这个网站'
  switch (why) {
    case 'login':
      return `工坊的浏览器还没登录${where}——在浏览器里登录一下，再贴一次链接。`
    case 'no_access':
      return `登录的这个${where}账号打不开这张表——换有权限的账号登录，或者在表格里「下载为 Excel」拖进来。`
    case 'no_browser':
      return '工坊现在没有能用的浏览器。在表格里「下载为 Excel」，拖进来就行。'
    default:
      return '这张表从页面上读不出来。在表格里「下载为 Excel」，拖进来就行。'
  }
}
