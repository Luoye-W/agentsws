/**
 * WP341（决策 847）：genui 完全融合——按钮 / 表单 / 图片 / 链接都进对话，动作接到**工坊自己的处理器**。
 *
 * 这一份只放宿主这边的小规矩（服务进程、模拟、工作台共用；不依赖 `genui.ts`）：
 * - **动作写法**：模型在按钮 / 表单上写 `action`，宿主认这几种（其余一律当「把这句话发进对话」）：
 *   `say[:一句话]`（接着问 / 选这个）、`open:/页面` 或 `open:agentsws://…`（工坊内页面 / 第三栏）、
 *   `tool:工具名` + `args`（走现有工具执行器：只读直接跑，会改外部的进账本出审批）、
 *   `connect:服务[,服务]`（连接卡）、`setup:设置目标`（配置卡）、`submit`（表单交上来）。
 *   插件只把动作名交给宿主，自己不发任何请求。
 * - **口令格子**（决策 814）：`inputType: password`、或名字 / 标签像口令 / 密钥 / 令牌的格子，一律换成宿主自己画的
 *   「口令格」，值直接交本机加密库（连接卡那张本机原生表单），AI 只收到「已填好」。
 * - **图片 / 媒体来源**：店铺 CDN、本机（同源 `/…`）、常见平台图床直接加载；其他外部网址先显示「点开看」并标域名。
 */
import { isSecretLikeSetupKey } from './setup-card.js'

/** 宿主处理器认的一个动作。 */
export type GenuiHostAction =
  /** 作为用户的一句话发进当前对话（`text` 空 = 用按钮上的字 / 选中的值）。 */
  | { kind: 'say'; text?: string }
  /** 工坊内页面（`/…`）或第三栏地址（`agentsws://…`）。 */
  | { kind: 'open'; to: string }
  /** 调一个工具（只读的直接跑、结果就地画；会改外部的进账本出审批，审批就地画在对话里）。 */
  | { kind: 'tool'; tool: string }
  /** 开连接卡（就地连）。 */
  | { kind: 'connect'; services: string[] }
  /** 开配置卡（就地设）。 */
  | { kind: 'setup'; target: string }
  /** 表单交上来：变成用户在对话里的一条结构化回话。 */
  | { kind: 'submit' }

const SERVICE_RE = /^[a-z][a-z0-9_.:-]{0,63}$/u
const TOOL_RE = /^[a-z][a-z0-9_.-]{0,79}$/iu
const TARGET_RE = /^[a-z][a-z0-9_.-]{0,79}$/iu
const PLAIN_RE = /^[\p{L}\p{N}_.-]{1,40}$/u

/** 工坊内去处：站内路径（不是 `//`）或第三栏地址。 */
export function isGenuiOpenTarget(to: string): boolean {
  if (to.length > 300 || /[\s"'<>\\]/u.test(to)) return false
  if (to.startsWith('/') && !to.startsWith('//')) return true
  return /^agentsws:\/\/[a-z][a-z0-9-]*\/\S+$/u.test(to)
}

/**
 * 模型写的 `action` 认成宿主动作。认不出的（空、超长、带奇怪字符）回 `undefined`——那个按钮画成禁用的。
 * 单纯一个词（`pick`、`refresh`、`选这个`）按插件的老意思：把这次点击当一句话发回对话。
 */
export function parseGenuiAction(raw: unknown): GenuiHostAction | undefined {
  if (typeof raw !== 'string') return undefined
  const a = raw.trim()
  if (a === '' || a.length > 300) return undefined
  const at = a.indexOf(':')
  const head = (at < 0 ? a : a.slice(0, at)).toLowerCase()
  const rest = at < 0 ? '' : a.slice(at + 1).trim()
  if (head === 'say') return rest === '' ? { kind: 'say' } : { kind: 'say', text: rest.slice(0, 200) }
  if (head === 'submit') return { kind: 'submit' }
  if (head === 'open') return isGenuiOpenTarget(rest) ? { kind: 'open', to: rest } : undefined
  if (head === 'tool') {
    const tool = rest.replace(/#\d+$/u, '')
    return TOOL_RE.test(tool) ? { kind: 'tool', tool } : undefined
  }
  if (head === 'connect') {
    const services = rest
      .split(/[,+\s]+/u)
      .filter((s) => s !== '')
      .slice(0, 4)
    return services.length > 0 && services.every((s) => SERVICE_RE.test(s))
      ? { kind: 'connect', services }
      : undefined
  }
  if (head === 'setup') return TARGET_RE.test(rest) ? { kind: 'setup', target: rest } : undefined
  return PLAIN_RE.test(head) ? { kind: 'say' } : undefined
}

/** 规范成宿主认的那一种写法（`say:…` 原样；单个词 → `say`）。认不出回 `undefined`。 */
export function normalizeGenuiAction(raw: unknown): string | undefined {
  const parsed = parseGenuiAction(raw)
  if (parsed === undefined) return undefined
  switch (parsed.kind) {
    case 'say':
      return parsed.text === undefined ? 'say' : `say:${parsed.text}`
    case 'open':
      return `open:${parsed.to}`
    case 'tool':
      return `tool:${parsed.tool}`
    case 'connect':
      return `connect:${parsed.services.join(',')}`
    case 'setup':
      return `setup:${parsed.target}`
    case 'submit':
      return 'submit'
  }
}

/** 一个格子像不像口令 / 密钥 / 令牌（名字、标签、提示字、输入类型任一）。 */
export function isSecretLikeGenuiField(node: Record<string, unknown>): boolean {
  if (node.inputType === 'password') return true
  const words = ['id', 'label', 'placeholder', 'name']
    .map((k) => (typeof node[k] === 'string' ? (node[k] as string) : ''))
    .join(' ')
  return isSecretLikeSetupKey(words)
}

/**
 * 直接加载的图片 / 媒体来源（店铺 CDN、常见平台图床）。其余外部网址先显示「点开看」并标域名，
 * 免得不点就把「谁在看这条」带出去。同源 `/…`（本机文件、工坊截图）一律直接加载。
 */
export const GENUI_TRUSTED_MEDIA_HOSTS = [
  'cdn.shopify.com',
  '*.myshopify.com',
  '*.shopifycdn.com',
  'images.unsplash.com',
  'i.imgur.com',
  '*.alicdn.com',
  '*.xhscdn.com',
  '*.sinaimg.cn',
  '*.douyinpic.com',
  '*.hdslb.com',
  'mmbiz.qpic.cn',
  'pbs.twimg.com',
  '*.cdninstagram.com',
  '*.fbcdn.net',
  'i.ytimg.com',
  '*.googleusercontent.com',
  '*.pinimg.com',
] as const

/** 来源的域名（不是 http(s) 的回 `undefined`）。 */
export function genuiUrlHost(src: string): string | undefined {
  const m = /^https?:\/\/([^/?#\s:@]+)(?::\d+)?(?:[/?#]|$)/iu.exec(src)
  return m?.[1]?.toLowerCase()
}

const hostMatches = (host: string, pattern: string): boolean =>
  pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern

/**
 * 一个图片 / 媒体地址怎么画：`direct` 直接加载；`gate` 先「点开看」（标域名）；`undefined` 不画
 * （`data:`、`file:`、`javascript:`、`//` 开头…）。`extraHosts`：宿主另认的（如已连店铺的自定义域名）。
 */
export function genuiMediaTrust(
  src: unknown,
  extraHosts: readonly string[] = [],
): 'direct' | 'gate' | undefined {
  if (typeof src !== 'string' || src.length > 2000 || /[\s"'<>\\]/u.test(src)) return undefined
  if (src.startsWith('/') && !src.startsWith('//')) return 'direct'
  const host = genuiUrlHost(src)
  if (host === undefined) return undefined
  const trusted = [...GENUI_TRUSTED_MEDIA_HOSTS, ...extraHosts]
  return trusted.some((p) => hostMatches(host, p)) ? 'direct' : 'gate'
}

/** 链接能不能点：`http(s)` / `mailto` / 站内 `/…`。别的（`javascript:`、`data:`、`//`）只留字。 */
export function isGenuiLinkHref(href: unknown): href is string {
  if (typeof href !== 'string' || href.length > 2000 || /[\s"'<>\\]/u.test(href)) return false
  if (href.startsWith('/') && !href.startsWith('//')) return true
  return genuiUrlHost(href) !== undefined || /^mailto:[^\s@]+@[^\s@]+$/iu.test(href)
}
