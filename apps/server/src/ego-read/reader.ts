/**
 * WP493（决策 1718）：**ego 读页口**——和插件那一口（`web-browser/own-browser.ts` 的 `OwnBrowserReader`）同一个样子，
 * 外加两样 ego 才有的：读整页（正文 + 表格 + 可选无障碍快照）、借这一页的登录态 GET 几个同源地址。
 *
 * 能不能用由注入的 `egoPath()` 说了算（本机档 + 浏览器选了 ego（或没选过、默认 ego）+ 探得到；
 * `AGENTSWS_EGO_READ=off` 整条关掉）。每一次都是一趟完整的「开空间 → 读 → 收空间」，不留标签页。
 */
import type { BrowserTextRead } from '@agentsws/brand-intake'
import type { EgoSpawn } from '../ego-write/runner.js'
import { dataTextOfHtml } from '../web-browser/own-browser.js'
import {
  type EgoFetchResponse,
  type EgoPageSnapshot,
  type EgoReadCall,
  type EgoReadResult,
  runEgoRead,
} from './runner.js'

export interface EgoPageReadOptions {
  /** 要页面原文。 */
  html?: boolean
  /** 要无障碍快照。 */
  snapshot?: boolean
  settle_ms?: number
}

export type EgoPageRead =
  | { ok: true; page: EgoPageSnapshot }
  | { ok: false; state: EgoReadResult['state'] | 'off'; message: string }

export type EgoFetchRead =
  | { ok: true; responses: EgoFetchResponse[]; final_url?: string }
  | { ok: false; state: EgoReadResult['state'] | 'off'; message: string }

export interface EgoPageReader {
  /** 这会儿 ego 能不能用。 */
  available(): boolean
  /** 与插件那一口同形：`data` = 数据地址（取 `<pre>` 里的原文）；`html` = 网页原文。 */
  read(url: string, kind: 'data' | 'html'): ReturnType<BrowserTextRead>
  /** 读一整页（正文 + 表格 + 可选原文 / 无障碍快照）。 */
  page(url: string, options?: EgoPageReadOptions): Promise<EgoPageRead>
  /** 先打开 `start`，再借这一页的登录态 GET 几个同源地址（跨源的不发）。 */
  fetch(
    start: string,
    urls: readonly string[],
    options?: { gap_ms?: number; stop_on_wall?: boolean; settle_ms?: number },
  ): Promise<EgoFetchRead>
  /** 跑一趟自定义的只读步骤（在线表格那一路用）。 */
  run(call: EgoReadCall): Promise<EgoReadResult | { state: 'off'; why: string; steps: [] }>
}

export interface EgoPageReaderOptions {
  /** 能用就回 `ego-browser` 的路径；用不了回 `undefined`。 */
  egoPath(): string | undefined
  spawn?: EgoSpawn
  timeoutMs?: number
  /** 临时目录（缺省系统临时目录）。 */
  root?: string
  log?(message: string, fields?: Record<string, unknown>): void
}

const OFF = 'ego 没装好或没选用'

/** 一趟没成时给人的那一句。 */
export function egoReadWhy(res: { state: string; why?: string }): string {
  if (res.state === 'needs_human') return 'ego 里弹了要你处理的框，这一页没读成'
  return res.why === undefined ? 'ego 这一页没读成' : `ego 这一页没读成（${res.why}）`
}

export function createEgoPageReader(options: EgoPageReaderOptions): EgoPageReader {
  /** ego 一次只跑一趟（同一个用户的浏览器，不并发开空间）。 */
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const next = queue.then(task, task)
    queue = next.catch(() => undefined)
    return next
  }
  const run: EgoPageReader['run'] = (call) =>
    enqueue(async () => {
      const egoPath = options.egoPath()
      if (egoPath === undefined) return { state: 'off' as const, why: OFF, steps: [] as [] }
      const res = await runEgoRead({
        egoPath,
        call,
        ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.root === undefined ? {} : { root: options.root }),
      })
      if (res.state !== 'ok' || res.closed === false)
        options.log?.('ego 读页这一趟', {
          state: res.state,
          ...(res.why === undefined ? {} : { why: res.why }),
          closed: res.closed,
        })
      return res
    })

  const page: EgoPageReader['page'] = async (url, opts = {}) => {
    const res = await run({
      url,
      ...(opts.settle_ms === undefined ? {} : { settle_ms: opts.settle_ms }),
      steps: [
        {
          op: 'read',
          id: 'read',
          ...(opts.html === true ? { html: true } : {}),
          ...(opts.snapshot === true ? { snapshot: true } : {}),
        },
      ],
    })
    const got = res.steps.find((s) => s.id === 'read')?.page
    if (res.state === 'ok' && got !== undefined) return { ok: true, page: got }
    return { ok: false, state: res.state, message: egoReadWhy(res) }
  }

  return {
    available: () => options.egoPath() !== undefined,
    run,
    page,
    async read(url, kind) {
      const got = await page(url, { html: true })
      if (!got.ok) return { ok: false, message: got.message }
      const html = got.page.html ?? ''
      return {
        ok: true,
        status: 0,
        final_url: got.page.final_url,
        text: kind === 'data' ? dataTextOfHtml(html) : html,
      }
    },
    async fetch(start, urls, opts = {}) {
      const res = await run({
        url: start,
        ...(opts.settle_ms === undefined ? { settle_ms: 1000 } : { settle_ms: opts.settle_ms }),
        steps: [
          {
            op: 'fetch',
            id: 'fetch',
            urls: [...urls],
            ...(opts.gap_ms === undefined ? {} : { gap_ms: opts.gap_ms }),
            ...(opts.stop_on_wall === true ? { stop_on_wall: true } : {}),
          },
        ],
      })
      const step = res.steps.find((s) => s.id === 'fetch')
      if (res.state === 'ok' && step?.responses !== undefined)
        return { ok: true, responses: step.responses }
      return { ok: false, state: res.state, message: egoReadWhy(res) }
    },
  }
}
