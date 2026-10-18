/**
 * WP353（Luoye 10-16，决策 912）：**应用内搜索浏览器**——服务进程那一侧的联网搜索经它打开 Google / Bing
 * 结果页、或者读一页正文（Reddit / LinkedIn 这类匿名抓取常被拒的站）。
 *
 * 思路参考了 Proma 的做法（Electron 主进程里一个不挂界面的视图、按工作区的持久 partition、
 * UA 去掉 Electron 字样），**只参考思路，未复制代码（Proma 为 AGPL-3.0）**。
 *
 * 这个文件**不 import electron**（同 `work-browser.ts`），所以能在 vitest 里跑满：
 * - {@link searchPartitionOf} / {@link cleanUserAgent}：两条纯规则；
 * - {@link validateOpen} / {@link validateReveal}：本机通道收到的请求一律当不可信、只认这几种形状；
 * - {@link startSearchBrowserChannel}：服务进程 → 桌面壳的**本机通道**（只听 127.0.0.1、随机端口、
 *   随机口令；口令经环境变量交给 sidecar，与 `AGENTSWS_SESSION_KEY` 同一条路）。
 *
 * 真正开页面的 Electron 那一半在 `search-browser-electron.ts`。
 *
 * 纪律（派工单 + Luoye 10-16）：
 * 1. **不开 remote-debugging 端口、不用 CDP**：读结果只用 `executeJavaScript` 跑只读的 DOM 提取；
 * 2. 只做「打开一页、读回来」：不点击、不填表；人机验证只在**人**点了之后才算过，AI 不碰；
 * 3. 默认静默：视图不挂到界面上、不弹窗、不抢焦点；只有要人介入（验证 / 登录）时才把那一页亮到第三栏。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ReadableExtract, SerpExtract } from './search-extract.js'

/** 交给 sidecar 的两个环境变量（服务进程按它们找到这条通道）。 */
export const SEARCH_BROWSER_URL_ENV = 'AGENTSWS_SEARCH_BROWSER_URL'
export const SEARCH_BROWSER_TOKEN_ENV = 'AGENTSWS_SEARCH_BROWSER_TOKEN'

/** 每个品牌一份持久 partition（数据只在本机；名字是哈希，看不出是哪个品牌）。 */
export function searchPartitionOf(workspace_id: string): string {
  const digest = createHash('sha256').update(`search:${workspace_id}`).digest('hex').slice(0, 24)
  return `persist:agentsws-search-${digest}`
}

/**
 * UA 去掉 `Electron/x` 与应用自己的名字（Electron 缺省会带上），其余照 Chromium 原样——
 * 不冒充别的浏览器，只是不把「这是个 Electron 应用」写在每一次请求上。
 */
export function cleanUserAgent(ua: string): string {
  const keep = /^(Mozilla|AppleWebKit|Chrome|Safari|Version|Mobile|Gecko|Edg)\//
  const out: string[] = []
  // 括号段（平台、KHTML 那段）整段保留；其余按「名字/版本」逐个看
  for (const part of ua.match(/\([^)]*\)|\S+/g) ?? []) {
    if (part.startsWith('(') || keep.test(part)) out.push(part)
  }
  return out.join(' ')
}

/**
 * WP398（docs/106 §2.1 Amazon Agent Policy）：访问 **Amazon** 的每个请求，User-Agent 末尾带上 `Agent/AgentsWorkshop`
 * ——照实告诉 Amazon 这是代人干活的软件（Chromium 原有那几段不去掉）。别的站照旧 {@link cleanUserAgent}。
 * 带了标识 Amazon 随时能拦；拦了就停，不绕（服务进程那一侧管）。
 */
export const AMAZON_AGENT_TOKEN = 'Agent/AgentsWorkshop'

/** Amazon 各站前台（与 `amz/store.yml` 的 `browser_scope` 同一批）+ 联想词 / 图片这些资源域。 */
export const AMAZON_DOMAINS: readonly string[] = [
  'amazon.com',
  'amazon.ca',
  'amazon.com.mx',
  'amazon.com.br',
  'amazon.co.uk',
  'amazon.de',
  'amazon.fr',
  'amazon.it',
  'amazon.es',
  'amazon.nl',
  'amazon.se',
  'amazon.pl',
  'amazon.com.be',
  'amazon.com.tr',
  'amazon.ae',
  'amazon.sa',
  'amazon.eg',
  'amazon.in',
  'amazon.co.jp',
  'amazon.com.au',
  'amazon.sg',
  'media-amazon.com',
  'ssl-images-amazon.com',
  'images-amazon.com',
]

/** Electron `webRequest` 的地址过滤写法（`*.amazon.com` 也认 `amazon.com` 本身）。 */
export const AMAZON_URL_PATTERNS: readonly string[] = AMAZON_DOMAINS.map((d) => `*://*.${d}/*`)

/** 这个主机是不是 Amazon（各站前台、联想词、图片资源）。 */
export function isAmazonHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  return AMAZON_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))
}

/** 这个请求该带的 User-Agent：Amazon 的在末尾加 {@link AMAZON_AGENT_TOKEN}（已经有了不重复加）。 */
export function userAgentFor(url: string, ua: string): string {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return ua
  }
  if (!isAmazonHost(host) || ua.includes(AMAZON_AGENT_TOKEN)) return ua
  return `${ua} ${AMAZON_AGENT_TOKEN}`.trim()
}

/**
 * WP394：这个网址是不是 Amazon 的（读 HTML 原文、设配送邮编只认它；按 {@link isAmazonHost} 判）。
 * 认不出的网址一律不算。
 */
export function isAmazonUrl(url: string): boolean {
  try {
    return isAmazonHost(new URL(url).hostname)
  } catch {
    return false
  }
}

/** WP394：`html` = 读 Amazon 前台页的 HTML 原文（**只认 Amazon 的网址**）。 */
export type OpenKind = 'google' | 'bing' | 'page' | 'html'

export interface OpenRequest {
  workspace_id: string
  url: string
  kind: OpenKind
  /** 等到页面结构出来（`dom-ready`）最多多久；超了算「打不开」。 */
  timeout_ms: number
  /** 结构出来之后再等多久读（让结果画完）。 */
  settle_ms: number
  /** 正文最多留多少字（`page` 那种）。 */
  max_chars: number
}

export type OpenResult =
  | {
      ok: true
      /** 主文档的 HTTP 状态码（拿不到回 0）。 */
      status: number
      final_url: string
      serp?: SerpExtract
      page?: ReadableExtract
    }
  | { ok: false; reason: 'timeout' | 'failed' | 'revealed'; message: string }

export interface RevealRequest {
  workspace_id: string
  /** 要人打开的那一页（被拦的那个搜索地址）。 */
  url: string
  reason: 'captcha' | 'login'
  /** 第三栏上那一句（服务进程定，人话）。 */
  message: string
}

export interface SearchBrowserStatus {
  /** 那一页正亮在第三栏等人。 */
  revealed: boolean
  /** 人上一次点过验证、离开验证页的时刻（毫秒）。 */
  verified_at?: number
}

/**
 * WP394（docs/104 §2.3）：把这个品牌内置浏览器里 Amazon 某站的「配送到」设成一个邮编（不登录，只是 Amazon
 * 记在这个 partition 里的地址 cookie）。出口在境外时 Amazon 会认成别的国家，价格变币种、写「不能配送」。
 */
export interface AmazonDeliveryRequest {
  workspace_id: string
  /** 站点前台首页（`https://www.amazon.com/`）。 */
  url: string
  zip: string
  timeout_ms: number
}

export type AmazonDeliveryResult =
  | { ok: true; deliver_to?: string }
  | { ok: false; reason: 'timeout' | 'failed' | 'blocked'; message: string }

/** Electron 那一半要实现的口子。 */
export interface SearchBrowserDriver {
  open(req: OpenRequest): Promise<OpenResult>
  reveal(req: RevealRequest): Promise<{ shown: boolean }>
  status(workspace_id: string): SearchBrowserStatus
  /** WP394：设 Amazon「配送到」（没实现 = 这一版桌面壳不会设，服务进程照实说）。 */
  amazonDelivery?(req: AmazonDeliveryRequest): Promise<AmazonDeliveryResult>
}

/** 通道收到的「设配送邮编」请求：只认 Amazon 站点首页、邮编只许字母数字空格横线。 */
export function validateAmazonDelivery(body: unknown): AmazonDeliveryRequest | string {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isWorkspace(b.workspace_id)) return 'workspace_id 不对'
  if (!isWebUrl(b.url) || !isAmazonUrl(b.url) || !b.url.startsWith('https://www.amazon.'))
    return '只认 Amazon 站点首页'
  if (typeof b.zip !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9 -]{1,10}$/.test(b.zip))
    return '邮编格式不对'
  return {
    workspace_id: b.workspace_id,
    url: new URL(b.url).origin,
    zip: b.zip,
    timeout_ms: clampInt(b.timeout_ms, 1_000, 60_000, 20_000),
  }
}

const KINDS: readonly OpenKind[] = ['google', 'bing', 'page', 'html']
/** WP394：Amazon 一页商品页的 HTML 原文最多多少字（整页 1–2 MB）。 */
export const HTML_MAX_CHARS = 4_000_000

const isWorkspace = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,120}$/.test(v)

const isWebUrl = (v: unknown): v is string => {
  if (typeof v !== 'string' || v.length > 4000) return false
  try {
    const u = new URL(v)
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === ''
    )
  } catch {
    return false
  }
}

const clampInt = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, Math.floor(v)))
    : fallback

/** 通道收到的 `open` 请求：认不出回一句为什么。 */
export function validateOpen(body: unknown): OpenRequest | string {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isWorkspace(b.workspace_id)) return 'workspace_id 不对'
  if (!isWebUrl(b.url)) return '只开 http / https 网址'
  if (!KINDS.includes(b.kind as OpenKind)) return 'kind 只认 google / bing / page / html'
  if (b.kind === 'html' && !isAmazonUrl(b.url)) return 'html 只开 Amazon 的网址'
  return {
    workspace_id: b.workspace_id,
    url: b.url,
    kind: b.kind as OpenKind,
    timeout_ms: clampInt(b.timeout_ms, 1_000, 60_000, 15_000),
    settle_ms: clampInt(b.settle_ms, 0, 10_000, 1_200),
    max_chars:
      b.kind === 'html'
        ? clampInt(b.max_chars, 1_000, HTML_MAX_CHARS, HTML_MAX_CHARS)
        : clampInt(b.max_chars, 1_000, 200_000, 60_000),
  }
}

export function validateReveal(body: unknown): RevealRequest | string {
  const b = (body ?? {}) as Record<string, unknown>
  if (!isWorkspace(b.workspace_id)) return 'workspace_id 不对'
  if (!isWebUrl(b.url)) return '只开 http / https 网址'
  if (b.reason !== 'captcha' && b.reason !== 'login') return 'reason 只认 captcha / login'
  const message = typeof b.message === 'string' ? b.message.slice(0, 300) : ''
  return { workspace_id: b.workspace_id, url: b.url, reason: b.reason, message }
}

/** 一次随机口令（通道用）。 */
export function newChannelToken(): string {
  return randomBytes(24).toString('hex')
}

const BODY_LIMIT = 64 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > BODY_LIMIT) {
        reject(new Error('too_large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('bad_json'))
      }
    })
    req.on('error', reject)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function tokenOk(header: string | undefined, token: string): boolean {
  const got = Buffer.from((header ?? '').replace(/^Bearer\s+/i, ''))
  const want = Buffer.from(token)
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * 起本机通道：`POST /open`、`POST /reveal`、`POST /amazon-delivery`（WP394）、`GET /status?workspace_id=`。只听 127.0.0.1、随机端口；
 * 每个请求要带 `Authorization: Bearer <口令>`，不对一律 401；浏览器来的跨站请求（带 Origin）一律拒。
 */
export async function startSearchBrowserChannel(input: {
  driver: SearchBrowserDriver
  token: string
}): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((req, res) => {
    void (async () => {
      if (req.headers.origin !== undefined) return send(res, 403, { error: 'no_browser_origin' })
      if (!tokenOk(req.headers.authorization, input.token))
        return send(res, 401, { error: 'unauthorized' })
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      try {
        if (req.method === 'GET' && url.pathname === '/status') {
          const ws = url.searchParams.get('workspace_id')
          if (!isWorkspace(ws)) return send(res, 400, { error: 'workspace_id 不对' })
          return send(res, 200, input.driver.status(ws))
        }
        if (req.method === 'POST' && url.pathname === '/open') {
          const got = validateOpen(await readBody(req))
          if (typeof got === 'string') return send(res, 400, { error: got })
          return send(res, 200, await input.driver.open(got))
        }
        if (req.method === 'POST' && url.pathname === '/amazon-delivery') {
          const got = validateAmazonDelivery(await readBody(req))
          if (typeof got === 'string') return send(res, 400, { error: got })
          if (input.driver.amazonDelivery === undefined)
            return send(res, 200, {
              ok: false,
              reason: 'failed',
              message: '这一版桌面壳不会设配送地址',
            })
          return send(res, 200, await input.driver.amazonDelivery(got))
        }
        if (req.method === 'POST' && url.pathname === '/reveal') {
          const got = validateReveal(await readBody(req))
          if (typeof got === 'string') return send(res, 400, { error: got })
          return send(res, 200, await input.driver.reveal(got))
        }
        return send(res, 404, { error: 'not_found' })
      } catch (err) {
        return send(res, 500, { error: err instanceof Error ? err.message : String(err) })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  }
}
