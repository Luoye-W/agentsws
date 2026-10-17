/**
 * WP358：桌面壳手里那张会话（13 §5 会话密钥换来的 HttpOnly cookie）怎么保鲜。
 *
 * 以前主进程换一次就一直缓存着，直到服务进程重启才扔。可服务端的会话只活 12 小时
 * （`DEFAULT_SESSION_TTL`）——桌面版常驻托盘，开一整天很正常：过了 12 小时，窗口里
 * 后台重取 `/v1/me` 撞 401，工作台就落到「进工作台 / 你的邮箱」那一页；壳自己再问
 * 也还是那张过期的（Windows 真机 10-16：开了 27 小时，更新前问「岗位 AI 在不在干活」回 401）。
 *
 * 现在三条：
 * 1. **到点就换**：拿到手超过 {@link SESSION_REFRESH_MS}（服务端寿命的一半）再要时重换一张；
 * 2. **丢了就换**：页面或壳自己撞上 401 → `renew()` 立刻重换（服务进程重启、数据目录换了、
 *    会话被清，都走这一条）；
 * 3. **同时只换一次**：好几处同时要，共用同一趟。
 *
 * 只在个人档用：`remote` 档没有会话密钥，登录走公司服务器自己的那一套（20 §5）。
 */

/** 服务端会话寿命 12 小时；过半就换，留足余量给睡眠唤醒、时钟漂移。 */
export const SESSION_REFRESH_MS = 6 * 60 * 60 * 1000

export interface SessionKeeperOptions<S> {
  /** 用会话密钥换一张新的（`POST /v1/auth/session`）；换不到回 `undefined`。 */
  exchange: () => Promise<S | undefined>
  /** 换到之后装进窗口用的 cookie 罐（Electron `session.cookies.set`）。 */
  install: (session: S) => Promise<void>
  nowMs: () => number
  refreshAfterMs?: number
}

export interface SessionKeeper<S> {
  /** 手上那张还新鲜就给它，否则重换。 */
  get(): Promise<S | undefined>
  /** 不管新不新鲜，重换一张（撞上 401 之后用）。 */
  renew(): Promise<S | undefined>
  /** 服务进程重启：手上的作废，下次要时再换。 */
  forget(): void
  /** 手上那张是什么时候换到的（测试与诊断用）。 */
  issuedAtMs(): number | undefined
}

export function createSessionKeeper<S>(options: SessionKeeperOptions<S>): SessionKeeper<S> {
  const refreshAfter = options.refreshAfterMs ?? SESSION_REFRESH_MS
  let current: { session: S; at: number } | undefined
  let inflight: Promise<S | undefined> | undefined
  // 每次 forget / renew 加一：换到一半被作废的那一趟，结果不再落进缓存
  let generation = 0

  const exchange = (): Promise<S | undefined> => {
    if (inflight !== undefined) return inflight
    const mine = generation
    const run = (async () => {
      const next = await options.exchange()
      if (next === undefined) return undefined
      await options.install(next)
      if (mine === generation) current = { session: next, at: options.nowMs() }
      return next
    })()
    inflight = run
    void run.finally(() => {
      if (inflight === run) inflight = undefined
    })
    return run
  }

  return {
    get() {
      if (current !== undefined && options.nowMs() - current.at < refreshAfter)
        return Promise.resolve(current.session)
      return exchange()
    },
    renew() {
      current = undefined
      return exchange()
    },
    forget() {
      generation += 1
      current = undefined
      inflight = undefined
    },
    issuedAtMs: () => current?.at,
  }
}
