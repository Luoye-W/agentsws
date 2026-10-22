/**
 * WP402（决策 1140 / 1146）：取数链的第 3 条路——**通过插件在用户自己的浏览器里读一页**（只读）。
 *
 * 走的是已经装好的 BrowserSkill（WP92：本机 `bsk` CLI ↔ daemon ↔ 用户浏览器里的扩展）。我们只用它的四个读的动作：
 * `session start --no-focus`（开一个独立的 Agent 窗口，不动用户的标签）→ `navigate`（打开那个公开地址）→
 * `get-html`（读回原文）→ `session stop`（关掉自己开的那个窗口）。**不点、不填、不跑脚本、不碰登录 / 验证码**；
 * 读回来的是页面原文，判被拦 / 解析都在调用方（和内置浏览器那一路同一份判法）。
 *
 * 这条路只在「用你正在用的浏览器」那一种装好了（`browserSettings.forRun()` 是 `browserskill`）、服务就在用户电脑上时才有；
 * 没有就是 `undefined`（取数链跳过这一条）。两个更新开关和 WP92 一样永远带着（不自己换版本、不去查新版本）。
 *
 * 一个品牌一份；同一轮里连着读几页时复用同一个窗口，闲 30 秒就关。
 *
 * WP455（docs/110 §3，决策 1434）：同一个窗口也给「用你的 Chrome 搜 Google」用（{@link OwnBrowserReader.serp}）：
 * 还是那四个读动作；`navigate` 等到 `domcontentloaded`（Google 结果页是服务端直接给的，不必等整页停止加载），
 * 读回来如果还是过渡页，隔 1 秒再 `get-html` 一次，最多等 8 秒，再交给调用方解析。
 */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { BrowserTextRead } from '@agentsws/brand-intake'

/** 跑一次 `bsk <args> --json`，交回解析好的那份 JSON（失败抛错，错里带它自己的那句话）。 */
export type BskJson = (args: string[], timeoutMs: number) => Promise<Record<string, unknown>>

/** 一页最多等多久（打开 + 读回）。 */
export const OWN_BROWSER_PAGE_TIMEOUT_MS = 30_000
/** 读回原文最多多少字节。 */
export const OWN_BROWSER_MAX_BYTES = 8_000_000
/** 窗口闲多久就关。 */
export const OWN_BROWSER_IDLE_MS = 30_000
/** WP455：搜索结果页读回来还是过渡页时，最多再等多久（毫秒）。 */
export const OWN_BROWSER_SERP_SETTLE_MS = 8_000
/** WP455：等过渡页跳走时，隔多久再读一次。 */
export const OWN_BROWSER_SERP_POLL_MS = 1_000

const NO_UPDATE_MANIFEST = 'http://127.0.0.1:1/agentsws-no-update-check.json'

/** 真的 `bsk`（钉版本那一份，WP92）；两个更新开关永远关着。 */
export function bskJsonOf(bskPath: string): BskJson {
  return (args, timeoutMs) =>
    new Promise((resolve, reject) => {
      execFile(
        bskPath,
        [...args, '--json'],
        {
          timeout: timeoutMs,
          maxBuffer: OWN_BROWSER_MAX_BYTES + 1_000_000,
          windowsHide: true,
          env: {
            ...process.env,
            BSK_AUTO_UPDATE: 'off',
            BSK_UPDATE_MANIFEST_URL: NO_UPDATE_MANIFEST,
          },
        },
        (err, stdout) => {
          let body: Record<string, unknown> | undefined
          try {
            const parsed: unknown = JSON.parse(String(stdout).trim())
            body =
              parsed !== null && typeof parsed === 'object'
                ? (parsed as Record<string, unknown>)
                : undefined
          } catch {
            body = undefined
          }
          if (err !== null) {
            const said = typeof body?.message === 'string' ? body.message : err.message
            reject(new Error(said.split('\n')[0] ?? said))
            return
          }
          if (body === undefined) reject(new Error('bsk 没回 JSON'))
          else resolve(body)
        },
      )
    })
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
  '&nbsp;': ' ',
}
const unescapeHtml = (s: string): string =>
  s
    .replace(/&(?:amp|lt|gt|quot|#39|#x27|nbsp);/gu, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/gu, (_m, d: string) => String.fromCodePoint(Number(d)))

/**
 * 浏览器把 JSON / 纯文本画成一页时，原文在 `<pre>` 里（Chrome 的 JSON 查看器也是）：取出来、还原转义。
 * 不是这种页（普通网页、XML）就原样交回 HTML。
 */
export function dataTextOfHtml(html: string): string {
  const pre = /<body[^>]*>\s*(?:<[^>]+>\s*)*?<pre[^>]*>([\s\S]*?)<\/pre>/iu.exec(html)
  return pre?.[1] === undefined ? html : unescapeHtml(pre[1].replace(/<[^>]+>/gu, ''))
}

/** WP455：搜索结果页读一次的结果（HTML 原文，解析与判被拦在调用方）。 */
export type OwnBrowserSerpRead =
  | {
      ok: true
      final_url: string
      html: string
      /** 过渡页后又读了几次。 */
      rereads: number
      /** 等满 8 秒还是「还没好」。 */
      settled: boolean
    }
  | { ok: false; reason: 'timeout' | 'failed'; message: string }

export interface OwnBrowserReader {
  /**
   * 读一个地址：`data` = 数据地址（JSON / 文本，取 `<pre>` 里的原文）；`html` = 网页原文（Amazon 商品页）。
   * 交回的形状和内置浏览器那一口一样（状态码拿不到，填 0）。
   */
  read(url: string, kind: 'data' | 'html'): ReturnType<BrowserTextRead>
  /** 只读数据地址那种（给独立站的取数链）。 */
  dataRead: BrowserTextRead
  /**
   * WP455：读一个搜索结果页（只给 Google 用）。`pending(html, final_url)` 回 true = 还是过渡页，
   * 隔 1 秒再读一次，最多 8 秒。老替身没有这一口 = 这条路没有。
   */
  serp?(
    url: string,
    opts: { pending(html: string, final_url: string): boolean },
  ): Promise<OwnBrowserSerpRead>
  /** 关掉自己开着的窗口（品牌下线 / 测试收尾）。 */
  close(): Promise<void>
}

export interface OwnBrowserReaderOptions {
  bsk: BskJson
  /** 生成 request-id（bsk 要求 `<过期毫秒>:<UUID>`，最长十分钟；测试给固定的）。 */
  newId?(): string
  idleMs?: number
  /** WP455：等过渡页用的（测试给假的）。 */
  sleep?(ms: number): Promise<void>
  now?(): number
  log?(message: string, fields?: Record<string, unknown>): void
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

export function createOwnBrowserReader(options: OwnBrowserReaderOptions): OwnBrowserReader {
  const newId = options.newId ?? (() => `${Date.now() + 9 * 60_000}:${randomUUID()}`)
  const idleMs = options.idleMs ?? OWN_BROWSER_IDLE_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = options.now ?? (() => Date.now())
  let session: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let queue: Promise<unknown> = Promise.resolve()

  const stop = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const s = session
    session = undefined
    if (s !== undefined) await options.bsk(['session', 'stop', s], 10_000).catch(() => undefined)
  }
  const touch = (): void => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      void stop()
    }, idleMs)
    timer.unref?.()
  }

  /** 还没开窗口就开一个（后台、不抢焦点）；开不出来回 `undefined`。 */
  const ensureSession = async (): Promise<string | undefined> => {
    if (session === undefined) {
      // bsk 0.3.3：先登记请求（--prepare）再拿同一个 id 开窗口，否则报「request is not prepared」
      const id = newId()
      await options.bsk(['session', 'request', id, '--prepare'], OWN_BROWSER_PAGE_TIMEOUT_MS)
      const started = await options.bsk(
        ['session', 'start', '--request-id', id, '--no-focus'],
        OWN_BROWSER_PAGE_TIMEOUT_MS,
      )
      session = str(started.session_id)
    }
    return session
  }
  const getHtml = async (s: string): Promise<Record<string, unknown>> =>
    options.bsk(
      ['get-html', '--session', s, '--max-bytes', String(OWN_BROWSER_MAX_BYTES)],
      OWN_BROWSER_PAGE_TIMEOUT_MS,
    )

  const once = async (url: string, kind: 'data' | 'html'): ReturnType<BrowserTextRead> => {
    try {
      const sid = await ensureSession()
      if (sid === undefined) return { ok: false, message: '插件没开出窗口' }
      const nav = await options.bsk(
        [
          'navigate',
          '--session',
          sid,
          '--wait-until',
          'load',
          '--timeout',
          `${OWN_BROWSER_PAGE_TIMEOUT_MS}ms`,
          url,
        ],
        OWN_BROWSER_PAGE_TIMEOUT_MS + 5_000,
      )
      const got = await getHtml(sid)
      touch()
      const html = str(got.html) ?? ''
      return {
        ok: true,
        status: 0,
        final_url: str(nav.final_url) ?? str(nav.url) ?? url,
        text: kind === 'data' ? dataTextOfHtml(html) : html,
        ...(got.truncated === true ? { truncated: true } : {}),
      }
    } catch (e) {
      // 这个窗口可能坏了：关掉，下次重开
      await stop()
      const message = e instanceof Error ? e.message : String(e)
      options.log?.('你自己的浏览器这一页没读成', { message })
      return { ok: false, message: `插件没读成（${message}）` }
    }
  }

  /** WP455：搜索结果页——打开、读回；还是过渡页就隔 1 秒再读，最多 8 秒。 */
  const serpOnce = async (
    url: string,
    pending: (html: string, final_url: string) => boolean,
  ): Promise<OwnBrowserSerpRead> => {
    try {
      const sid = await ensureSession()
      if (sid === undefined) return { ok: false, reason: 'failed', message: '插件没开出窗口' }
      const nav = await options.bsk(
        [
          'navigate',
          '--session',
          sid,
          '--wait-until',
          'domcontentloaded',
          '--timeout',
          `${OWN_BROWSER_PAGE_TIMEOUT_MS}ms`,
          url,
        ],
        OWN_BROWSER_PAGE_TIMEOUT_MS + 5_000,
      )
      const finalUrl = str(nav.final_url) ?? str(nav.url) ?? url
      let html = str((await getHtml(sid)).html) ?? ''
      let rereads = 0
      const t0 = now()
      while (pending(html, finalUrl) && now() - t0 < OWN_BROWSER_SERP_SETTLE_MS) {
        await sleep(OWN_BROWSER_SERP_POLL_MS)
        html = str((await getHtml(sid)).html) ?? ''
        rereads += 1
      }
      touch()
      return { ok: true, final_url: finalUrl, html, rereads, settled: !pending(html, finalUrl) }
    } catch (e) {
      await stop()
      const message = e instanceof Error ? e.message : String(e)
      options.log?.('你自己的浏览器这一页搜索没读成', { message })
      return {
        ok: false,
        reason: /timed? ?out|timeout|超时/iu.test(message) ? 'timeout' : 'failed',
        message: `插件没读成（${message}）`,
      }
    }
  }

  /** 一次只读一页（同一个窗口）。 */
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }
  const read = (url: string, kind: 'data' | 'html'): ReturnType<BrowserTextRead> =>
    enqueue(() => once(url, kind))

  return {
    read,
    dataRead: (url) => read(url, 'data'),
    serp: (url, opts) => enqueue(() => serpOnce(url, opts.pending)),
    close: stop,
  }
}
