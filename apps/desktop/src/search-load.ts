/**
 * WP454（docs/110 §2.2，决策 1433）：内置浏览器「打开一页」那一段，单独拎出来（**不 import electron**），
 * 好用假 `webContents` 在 vitest 里钉住。
 *
 * 以前：等**第一次** `dom-ready` 就算打开了。Google 对没有 cookie 的新浏览器先给 200 的「过渡页」，
 * 页面脚本跑完再带 `&sei=…` 请求一次才是真结果页——第一次 `dom-ready` 是过渡页的，读到 0 条。
 *
 * 现在（只对搜索结果页，传 `ready` 时）：第一次 `dom-ready` 之后接着轮询页面状态，最多再等 `max_wait_ms`；
 * 出现结果 / 明说没结果 / 被拦 / 同意页任一条就读。等的时候页面又导航了（`did-navigate`），
 * 就等那一页的 `dom-ready` 再接着看，不把上一页的 `dom-ready` 当成完成。等满了照样交回去（让服务进程认是不是过渡页）。
 *
 * WP484（WP464 §8）：
 * - **超时但页面已经开始显示**（主文档到了、`dom-ready` 迟迟不来——10-23 真机：某独立站 1 秒就有 3 千多字，
 *   `dom-ready` 要等 20 秒后的脚本）：传 `partial_on_timeout` 时停下加载、照样交回去读（`partial: true`），不算打不开；
 * - {@link settleText}：读正文前等字数稳住（YouTube 这类页面 `dom-ready` 之后才把列表画出来）；
 * - {@link withDeadline}：一次读页的总上限——过了就算超时、交回去，不让一页卡住后面排队的几页。
 */
import type { SerpProbe, SerpState } from './search-extract.js'

/** `webContents` 里这里用到的那几样（真的就是 `Electron.WebContents`）。 */
export interface LoadableContents {
  on(event: string, listener: (...args: never[]) => void): unknown
  once(event: string, listener: (...args: never[]) => void): unknown
  removeListener(event: string, listener: (...args: never[]) => void): unknown
  loadURL(url: string, options?: { userAgent?: string }): Promise<void>
  stop(): void
}

export type LoadResult =
  | {
      ok: true
      /** 主文档的 HTTP 状态码（最后一次主文档导航的；拿不到回 0）。 */
      status: number
      /** 传了 `ready` 才有：最后一次看到的页面状态。 */
      state?: SerpState
      /** 传了 `ready` 才有：`dom-ready` 之后又等了多久（毫秒）。 */
      waited_ms?: number
      /** 传了 `ready` 才有：第一次 `dom-ready` 之后主文档又导航了几次（过渡页 → `sei=` 那一下算一次）。 */
      renavigations?: number
      /** 最后一次探针原样（核实可见性 / 视口用）。 */
      probe?: SerpProbe
      /** WP484：到时间还没 `dom-ready`，但主文档已经到了——停下加载、读到多少算多少。 */
      partial?: true
    }
  | {
      ok: false
      reason: 'timeout' | 'failed'
      message: string
      /** 主框架加载失败时 Chromium 的错误码（`-100` 这种）。 */
      code?: number
    }

/**
 * WP484：连接层抖一下的那几种（代理 / 网络）——-100 连接被关、-101 连接被重置、-21 网络换了。
 * 10-23 真机重跑：同一个站前后几秒一次 -100、一次正常；这几种换一页重开一次。
 */
export const TRANSIENT_NET_CODES: readonly number[] = [-100, -101, -21]

export function isTransientLoadFailure(r: { ok: boolean; code?: number }): boolean {
  return !r.ok && r.code !== undefined && TRANSIENT_NET_CODES.includes(r.code)
}

/** 这几种状态就读，不再等。 */
export const SERP_FINAL_STATES: readonly SerpState[] = [
  'results',
  'no_results',
  'blocked',
  'consent',
]

export interface ReadyWait {
  /** 第一次 `dom-ready` 之后最多再等多久。 */
  max_wait_ms: number
  /** 多久看一次。 */
  interval_ms: number
  /** 在页面里跑一次只读探针（抛错 = 页面正在换，当作还没出来）。 */
  probe(): Promise<SerpProbe>
  now?(): number
  sleep?(ms: number): Promise<void>
}

/** 打开一页：等 `dom-ready`（超时 = 打不开）；传了 `ready` 就再等到真结果页。 */
export async function loadPage(
  wc: LoadableContents,
  url: string,
  timeoutMs: number,
  opts: { userAgent?: string; ready?: ReadyWait; partial_on_timeout?: boolean } = {},
): Promise<LoadResult> {
  let status = 0
  let committed = false
  let navigating = false
  let renavigations = 0
  let firstReady = false
  const onNavigate = (_e: unknown, _url: string, code: number): void => {
    status = code
    committed = true
    if (firstReady) {
      navigating = true
      renavigations += 1
    }
  }
  const onDomReady = (): void => {
    navigating = false
  }
  wc.on('did-navigate', onNavigate as (...args: never[]) => void)
  wc.on('dom-ready', onDomReady)
  try {
    const first = await new Promise<
      | { ok: true; partial?: true }
      | { ok: false; reason: 'timeout' | 'failed'; message: string; code?: number }
    >((resolve) => {
      const timer = setTimeout(() => {
        cleanup()
        wc.stop()
        if (committed && opts.partial_on_timeout === true) {
          resolve({ ok: true, partial: true })
          return
        }
        resolve({
          ok: false,
          reason: 'timeout',
          message: `${Math.round(timeoutMs / 1000)} 秒内没打开`,
        })
      }, timeoutMs)
      const onReady = (): void => {
        cleanup()
        resolve({ ok: true })
      }
      const onFail = (
        _e: unknown,
        code: number,
        desc: string,
        _url: string,
        isMainFrame: boolean,
      ): void => {
        // -3 = 被新的导航顶掉（跳转），不算失败
        if (!isMainFrame || code === -3) return
        cleanup()
        resolve({ ok: false, reason: 'failed', message: `${desc}（${code}）`, code })
      }
      const cleanup = (): void => {
        clearTimeout(timer)
        wc.removeListener('dom-ready', onReady)
        wc.removeListener('did-fail-load', onFail as (...args: never[]) => void)
      }
      wc.once('dom-ready', onReady)
      wc.on('did-fail-load', onFail as (...args: never[]) => void)
      wc.loadURL(
        url,
        opts.userAgent === undefined ? undefined : { userAgent: opts.userAgent },
      ).catch(() => undefined)
    })
    if (!first.ok) return first
    if (first.partial === true) return { ok: true, status, partial: true }
    firstReady = true
    const ready = opts.ready
    if (ready === undefined) return { ok: true, status }
    const now = ready.now ?? Date.now
    const sleep = ready.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    const started = now()
    let probe: SerpProbe | undefined
    let state: SerpState = 'pending'
    for (;;) {
      if (!navigating) {
        probe = await ready.probe().catch(() => undefined)
        state = probe?.state ?? 'pending'
        // 探针跑的时候页面又跳了：这次看到的是上一页，不算
        if (navigating) state = 'pending'
        if (SERP_FINAL_STATES.includes(state)) break
      }
      if (now() - started >= ready.max_wait_ms) break
      await sleep(ready.interval_ms)
    }
    return {
      ok: true,
      status,
      state,
      waited_ms: now() - started,
      renavigations,
      ...(probe === undefined ? {} : { probe }),
    }
  } finally {
    wc.removeListener('did-navigate', onNavigate as (...args: never[]) => void)
    wc.removeListener('dom-ready', onDomReady)
  }
}

export interface SettleWait {
  /** 至少等多久（原来的 `settle_ms`）。 */
  min_ms: number
  /** 最多等多久（从开始算）。 */
  max_ms: number
  /** 多久看一次字数。 */
  interval_ms: number
  /** 页面上现在有多少字（只读；抛错 = 页面正在换，当作还没稳）。 */
  probe(): Promise<number>
  now?(): number
  sleep?(ms: number): Promise<void>
}

/**
 * WP484：读正文前等字数稳住——先等 `min_ms`，之后每 `interval_ms` 看一次，**连着两次一样、而且不是 0** 就算稳了；
 * 到 `max_ms` 还在变也交回去（读到多少算多少）。
 */
export async function settleText(
  w: SettleWait,
): Promise<{ waited_ms: number; chars: number; stable: boolean }> {
  const now = w.now ?? Date.now
  const sleep = w.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const started = now()
  if (w.min_ms > 0) await sleep(w.min_ms)
  let last = -1
  for (;;) {
    const chars = await w.probe().catch(() => -1)
    if (chars > 0 && chars === last) return { waited_ms: now() - started, chars, stable: true }
    last = chars
    if (now() - started >= w.max_ms)
      return { waited_ms: now() - started, chars: Math.max(0, chars), stable: false }
    await sleep(w.interval_ms)
  }
}

/**
 * WP484：给一件事一个总上限——到点还没完就回 `late()` 的结果（那件事之后再完、再出错都不管了，
 * 由调用方在 `late` 里把它的页面关掉）。
 */
export function withDeadline<T>(work: Promise<T>, ms: number, late: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => resolve(late()), ms)
    work.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e: unknown) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
