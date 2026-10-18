/**
 * WP402（决策 1140 / 1146）：**取数链**——读外部公开页面时的备用路，独立站、Amazon 前台、联想词共用这一份规矩
 * （顺序与名字在 `@agentsws/contracts` 的 `read-chain.ts`）：
 *
 * ① 工坊内置浏览器（独立站在它前面还有「本机直接请求」）→ ② 工坊云端 → ③ 插件操作用户自己的浏览器 → ④ 照实说。
 *
 * 两种用法：
 * - {@link createReadChain}：**一个地址一个地址读**（独立站翻页）：被拦就换下一条路，之后这一次都从那条路读（粘住）；
 *   429 先按退避等一会儿再试同一条，还是 429 才换；`not_found` / `unreachable`（对方回话了 / 根本打不开）不换路；
 *   `quota`（本机这一小时额度满了）也不换——不为了赶时间去花钱。
 * - {@link readBatchChain}：**一批一起读**（Amazon 几个 ASIN、一批联想词前缀）：每条路拿到「还没读到、可以换路」的那几个，
 *   读到的收下，被拦 / 这条路没有的往下一条传；作废、找不到、额度满的停在原地照实说。
 *
 * 每试一条路都记一笔 {@link ReadRouteAttempt}（连接卡「走了哪条路」、报告用）。这里不碰网络，读的那一口全注入。
 */
import {
  READ_RATE_LIMIT_BACKOFF_MS,
  READ_RATE_LIMIT_MAX_WAIT_MS,
  type ReadRoute,
  type ReadRouteAttempt,
  type ReadRouteOutcome,
} from '@agentsws/contracts'

/** 一条路读一次失败的种类（`ok` 之外）。 */
export type ChainFailKind =
  | Exclude<ReadRouteOutcome, 'ok'>
  /** 对方回话了：没有这个（404 之类）——不换路。 */
  | 'not_found'
  /** 打不开这个网站（域名不对 / 连不上）——不换路。 */
  | 'unreachable'

export type ChainStep<T> =
  | { ok: true; value: T }
  | { ok: false; kind: ChainFailKind; reason: string; retry_after_ms?: number }

/** 取数链上的一条路（一个地址读一次）。 */
export interface ChainRoute<I, T> {
  route: ReadRoute
  read(input: I): Promise<ChainStep<T>>
}

export type ChainResult<T> =
  | { ok: true; value: T; via: ReadRoute }
  | { ok: false; kind: ChainFailKind; reason: string }

export interface ReadChainOptions {
  /** 退避用的等待（测试塞假的）。不给 = 真的等。 */
  sleep?(ms: number): Promise<void>
  backoffMs?: readonly number[]
  maxWaitMs?: number
}

export interface ReadChain<I, T> {
  read(input: I): Promise<ChainResult<T>>
  /** 现在粘在哪条路上（还没读成过 = 第一条）。 */
  route(): ReadRoute | undefined
  /** 读成过的那条路（一页都没读成 = `undefined`）。 */
  via(): ReadRoute | undefined
  /** 试过的每条路（同一条路同一种结局只记一次）。 */
  attempts(): ReadRouteAttempt[]
}

/** 这几种不换路（对方回话了 / 根本打不开 / 本机额度满了不花钱）。 */
const TERMINAL = new Set<ChainFailKind>(['not_found', 'unreachable', 'quota'])

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 记一笔（同一条路同一种结局只留第一次；最多 16 笔）。 */
export function noteAttempt(
  list: ReadRouteAttempt[],
  route: ReadRoute,
  outcome: ReadRouteOutcome,
  reason?: string,
): void {
  if (list.some((a) => a.route === route && a.outcome === outcome)) return
  if (list.length >= 16) return
  list.push(reason === undefined || reason === '' ? { route, outcome } : { route, outcome, reason })
}

/** 都没读到时报哪一种：被拦 > 限速 > 读失败 > 要同意 / 今天用过了 > 这条路没有。 */
const RANK: readonly ChainFailKind[] = [
  'blocked',
  'rate_limited',
  'failed',
  'needs_consent',
  'limited',
  'unavailable',
]
const worse = (a: ChainFailKind | undefined, b: ChainFailKind): ChainFailKind =>
  a === undefined || RANK.indexOf(b) < RANK.indexOf(a) ? b : a

const outcomeOf = (kind: ChainFailKind): ReadRouteOutcome =>
  kind === 'not_found' || kind === 'unreachable' ? 'failed' : kind

/** 读一次；429 就按退避等了再试同一条（对方给了 Retry-After 按它，不超过上限）。 */
async function withBackoff<I, T>(
  r: ChainRoute<I, T>,
  input: I,
  opts: ReadChainOptions,
): Promise<ChainStep<T>> {
  const waits = opts.backoffMs ?? READ_RATE_LIMIT_BACKOFF_MS
  const cap = opts.maxWaitMs ?? READ_RATE_LIMIT_MAX_WAIT_MS
  const sleep = opts.sleep ?? realSleep
  let got = await r.read(input)
  for (const w of waits) {
    if (got.ok || got.kind !== 'rate_limited') return got
    await sleep(Math.min(cap, Math.max(0, got.retry_after_ms ?? w)))
    got = await r.read(input)
  }
  return got
}

/**
 * 一个地址一个地址读的取数链（见文件头）。`routes` 按顺序给；这台没有的那条路不给就行
 * （或给一条回 `unavailable` 的，连接卡上能写明「没有这条路」）。
 */
export function createReadChain<I, T>(
  routes: readonly ChainRoute<I, T>[],
  opts: ReadChainOptions = {},
): ReadChain<I, T> {
  let at = 0
  let via: ReadRoute | undefined
  const attempts: ReadRouteAttempt[] = []
  return {
    route: () => routes[at]?.route,
    via: () => via,
    attempts: () => [...attempts],
    async read(input) {
      const reasons: string[] = []
      let worst: ChainFailKind | undefined
      for (let i = at; i < routes.length; i += 1) {
        const r = routes[i] as ChainRoute<I, T>
        let got: ChainStep<T>
        try {
          got = await withBackoff(r, input, opts)
        } catch (e) {
          got = { ok: false, kind: 'failed', reason: e instanceof Error ? e.message : String(e) }
        }
        if (got.ok) {
          at = i
          via ??= r.route
          noteAttempt(attempts, r.route, 'ok')
          return { ok: true, value: got.value, via: r.route }
        }
        noteAttempt(attempts, r.route, outcomeOf(got.kind), got.reason)
        if (TERMINAL.has(got.kind)) return { ok: false, kind: got.kind, reason: got.reason }
        if (got.kind !== 'unavailable') reasons.push(got.reason)
        // 被拦 / 限速退避完了 / 这条路没有：这一次之后都从下一条读（不在同一条路上硬试）
        if (got.kind !== 'needs_consent' && got.kind !== 'limited') at = i + 1
        worst = worse(worst, got.kind)
      }
      return {
        ok: false,
        kind: worst ?? 'unavailable',
        reason: reasons.join('；') || '这台电脑上没有能读的路',
      }
    },
  }
}

/* ── 一批一起读 ───────────────────────────────────────────────────── */

/** 一条路读一批的结局：读到的、往下一条传的、停在原地的。 */
export interface BatchStep<K, T> {
  got: { key: K; value: T }[]
  /** 这几个这条路读不了（被拦 / 这条路没有 / 读失败），往下一条传。 */
  next: K[]
  /** 这几个停在原地（作废 / 找不到 / 额度满了），照实说。 */
  stop?: { key: K; kind: ChainFailKind; reason?: string }[]
  /** 这条路这一次整体怎样（记一笔用）：读到过就是 `ok`。 */
  outcome?: ReadRouteOutcome
  reason?: string
}

export interface BatchRoute<K, T> {
  route: ReadRoute
  read(keys: K[]): Promise<BatchStep<K, T>>
}

export interface BatchChainResult<K, T> {
  got: { key: K; value: T; via: ReadRoute }[]
  /** 都没读到的（每条路都试过了还在传的）。 */
  left: K[]
  stopped: { key: K; kind: ChainFailKind; reason?: string }[]
  attempts: ReadRouteAttempt[]
  /** 读到最多的那条路（没读到 = `undefined`）。 */
  via?: ReadRoute
}

/** 一批一起读的取数链（见文件头）。 */
export async function readBatchChain<K, T>(
  keys: readonly K[],
  routes: readonly BatchRoute<K, T>[],
): Promise<BatchChainResult<K, T>> {
  const got: { key: K; value: T; via: ReadRoute }[] = []
  const stopped: { key: K; kind: ChainFailKind; reason?: string }[] = []
  const attempts: ReadRouteAttempt[] = []
  const count = new Map<ReadRoute, number>()
  let todo = [...keys]
  for (const r of routes) {
    if (todo.length === 0) break
    let step: BatchStep<K, T>
    try {
      step = await r.read(todo)
    } catch (e) {
      step = {
        got: [],
        next: todo,
        outcome: 'failed',
        reason: e instanceof Error ? e.message : String(e),
      }
    }
    for (const g of step.got) {
      got.push({ ...g, via: r.route })
      count.set(r.route, (count.get(r.route) ?? 0) + 1)
    }
    stopped.push(...(step.stop ?? []))
    const outcome = step.outcome ?? (step.got.length > 0 ? 'ok' : 'failed')
    noteAttempt(attempts, r.route, outcome, step.reason)
    todo = step.next
  }
  let via: ReadRoute | undefined
  for (const [route, n] of count) if (via === undefined || n > (count.get(via) ?? 0)) via = route
  return { got, left: todo, stopped, attempts, ...(via === undefined ? {} : { via }) }
}
