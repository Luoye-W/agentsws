/**
 * 五个渠道的链接解析（48 §5.2「URL 解析（认五个渠道的链接）」）。
 *
 * 用在三处：Excel 导入（一列全是链接，得认出是谁）、开发信里对方贴过来的链接、
 * 同一人合并（两条记录贴的是不是同一个账号）。
 *
 * 两条纪律：
 *
 * 1. **认不出来就说认不出来**。返回 `undefined` 比猜一个渠道好得多——猜错了，
 *    这条记录会以另一个渠道的名义进库，而"渠道之间零共享数据"这句话正是靠
 *    `channel` 这一格成立的。
 * 2. **handle 归一到不带 `@` 的小写**。平台自己两种写法都用（`@gadgetjonas`
 *    与 `gadgetjonas`），不归一的话同一个账号会在库里躺两条。归一只做这两件
 *    保守的事，不做别的（不去尾部斜杠以外的路径、不解析大小写敏感的平台 id）。
 */
import type { KolChannel } from '@agentsws/contracts'

export interface ParsedCreatorUrl {
  channel: KolChannel
  /** 归一后的 handle（不带 `@`、全小写）。 */
  handle: string
  /** 归一后的规范链接（去掉 query 与 fragment）。 */
  url: string
  /**
   * 这条链接指向的是**频道 / 主页**还是一条**内容**。
   *
   * 分开是因为用处不同：找人要的是主页，内容审核要的是那一条视频。
   * 认成主页而其实是一条视频，打分就会拿一条视频的数字当一个人的数字。
   */
  target: 'profile' | 'content'
  /** 内容链接时的那条内容 id（视频 id / 帖子 shortcode）。 */
  content_id?: string
}

/** handle 归一：去掉前导 `@`、两端空白与尾部斜杠，转小写。 */
export function normalizeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, '').replace(/\/+$/, '').toLowerCase()
}

interface HostRule {
  channel: KolChannel
  /** 认这几个域名（去掉 `www.` 之后比对）。 */
  hosts: readonly string[]
  parse(
    path: string,
    params: URLSearchParams,
  ): Omit<ParsedCreatorUrl, 'channel' | 'url'> | undefined
}

/** 路径切成非空段。 */
const segments = (path: string): string[] => path.split('/').filter((s) => s !== '')

/** 这几段不是人名，是平台自己的页面——认成 handle 就会在库里建出一条叫 "about" 的红人。 */
const RESERVED = new Set([
  'about',
  'watch',
  'shorts',
  'playlist',
  'feed',
  'results',
  'explore',
  'reel',
  'reels',
  'p',
  'tv',
  'stories',
  'groups',
  'pages',
  'profile.php',
  'home',
  'search',
  'i',
  'hashtag',
  'video',
  'status',
  'discover',
  'tag',
  'music',
])

const HOST_RULES: readonly HostRule[] = [
  {
    channel: 'youtube',
    hosts: ['youtube.com', 'm.youtube.com', 'youtu.be'],
    parse(path, params) {
      // 短链 `youtu.be/<id>` 的那一段是视频 id 不是 handle，在 `parseCreatorUrl`
      // 里按 host 单独走，不进这条规则。
      const segs = segments(path)
      const head = segs[0]
      if (head === 'watch') {
        const v = params.get('v')
        return v === null ? undefined : { handle: '', target: 'content', content_id: v }
      }
      if (head === 'shorts' && segs[1] !== undefined)
        return { handle: '', target: 'content', content_id: segs[1] }
      if (head?.startsWith('@') === true)
        return { handle: normalizeHandle(head), target: 'profile' }
      if ((head === 'channel' || head === 'c' || head === 'user') && segs[1] !== undefined)
        return { handle: normalizeHandle(segs[1]), target: 'profile' }
      return undefined
    },
  },
  {
    channel: 'facebook',
    hosts: ['facebook.com', 'm.facebook.com', 'fb.com', 'fb.me'],
    parse(path, params) {
      const segs = segments(path)
      const head = segs[0]
      if (head === undefined) return undefined
      if (head === 'profile.php') {
        const id = params.get('id')
        return id === null ? undefined : { handle: id.toLowerCase(), target: 'profile' }
      }
      if (head === 'groups' && segs[1] !== undefined)
        return { handle: normalizeHandle(segs[1]), target: 'profile' }
      if (RESERVED.has(head)) return undefined
      // `/<page>/posts/<id>` 是一条内容，`/<page>` 是主页
      if (segs[1] === 'posts' && segs[2] !== undefined)
        return { handle: normalizeHandle(head), target: 'content', content_id: segs[2] }
      return { handle: normalizeHandle(head), target: 'profile' }
    },
  },
  {
    channel: 'instagram',
    hosts: ['instagram.com', 'instagr.am'],
    parse(path) {
      const segs = segments(path)
      const head = segs[0]
      if (head === undefined) return undefined
      if ((head === 'p' || head === 'reel' || head === 'tv') && segs[1] !== undefined)
        return { handle: '', target: 'content', content_id: segs[1] }
      if (RESERVED.has(head)) return undefined
      return { handle: normalizeHandle(head), target: 'profile' }
    },
  },
  {
    channel: 'tiktok',
    hosts: ['tiktok.com', 'm.tiktok.com', 'vm.tiktok.com'],
    parse(path) {
      const segs = segments(path)
      const head = segs[0]
      if (head === undefined) return undefined
      if (!head.startsWith('@')) return undefined
      const handle = normalizeHandle(head)
      if (segs[1] === 'video' && segs[2] !== undefined)
        return { handle, target: 'content', content_id: segs[2] }
      return { handle, target: 'profile' }
    },
  },
  {
    channel: 'x',
    hosts: ['x.com', 'twitter.com', 'mobile.twitter.com'],
    parse(path) {
      const segs = segments(path)
      const head = segs[0]
      if (head === undefined || RESERVED.has(head)) return undefined
      const handle = normalizeHandle(head)
      if (segs[1] === 'status' && segs[2] !== undefined)
        return { handle, target: 'content', content_id: segs[2] }
      return { handle, target: 'profile' }
    },
  },
]

/** 去掉 `www.` 前缀之后的主机名（小写）。 */
function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, '')
}

/**
 * 一条链接 → 渠道 + handle。认不出来回 `undefined`（见文件头第 1 条）。
 *
 * 不带协议的也认（`youtube.com/@x`）——用户从地址栏抄过来的常常没有 `https://`。
 */
export function parseCreatorUrl(raw: string): ParsedCreatorUrl | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  let u: URL
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return undefined
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined
  const host = hostOf(u)
  // youtu.be/<id> 是视频短链，路径第一段就是视频 id，不走 youtube.com 那套路径判断
  if (host === 'youtu.be') {
    const id = segments(u.pathname)[0]
    return id === undefined
      ? undefined
      : {
          channel: 'youtube',
          handle: '',
          url: `https://youtu.be/${id}`,
          target: 'content',
          content_id: id,
        }
  }
  const rule = HOST_RULES.find((r) => r.hosts.includes(host))
  if (rule === undefined) return undefined
  const parsed = rule.parse(u.pathname, u.searchParams)
  if (parsed === undefined) return undefined
  // 规范链接：去掉 query 与 fragment（UTM 参数不该跟着一条红人记录进库）
  const path = u.pathname.replace(/\/+$/, '')
  return {
    channel: rule.channel,
    url: `https://${host}${path}`,
    ...parsed,
  }
}

/** 这条链接是不是某一条渠道的（认不出来一律 false，不猜）。 */
export function isChannelUrl(raw: string, channel: KolChannel): boolean {
  return parseCreatorUrl(raw)?.channel === channel
}
