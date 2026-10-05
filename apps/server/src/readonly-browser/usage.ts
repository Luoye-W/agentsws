/**
 * WP228：只读浏览器的**限速账本**（每个品牌一份，落盘）——记开过页面的时刻与「被拦了、停到几点」。
 *
 * 为什么落盘：WP220 的限速器只在内存里，服务一重启「一天 200 页」就清零了；连接页要显示
 * 「今天额度用完」也得有个地方问。形状与 WP220 的 `createReadRateLimiter` 一样（`check` / `take`），
 * Reddit 路由直接拿它当限速器用，两边数的是同一本账。
 *
 * 规则（数字从设置来，默认两页隔 20 秒、一小时 30 页、一天 200 页；「一天」= 最近 24 小时）：
 * 到了就说到了，不睡觉、不排队。被拦了（429 / 验证码 / 拦截页 / 登录墙）就记一笔，停到点之前
 * 这一路直接说「被拦了」，**不重试**。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WallKind } from './guard.js'

export interface ReadLimits {
  min_interval_seconds: number
  max_pages_per_hour: number
  max_pages_per_day: number
}

export interface BlockState {
  kind: WallKind
  message: string
  /** 记下的时刻 / 停到的时刻（毫秒）。 */
  at: number
  until: number
}

/** 被拦之后这一路停多久（毫秒）。429 带了 Retry-After 且更长就按它。 */
export const BLOCK_PAUSE_MS: Readonly<Record<WallKind, number>> = {
  rate_limited: 3_600_000,
  captcha: 6 * 3_600_000,
  blocked: 6 * 3_600_000,
  login: 3_600_000,
  // 跳去白名单外的站：那一页的事，不停这一路
  off_site: 0,
}

const HOUR = 3_600_000
const DAY = 86_400_000

interface File {
  version: 1
  opened: number[]
  block?: BlockState
}

export type LimitCheck =
  | { ok: true }
  | { ok: false; reason: 'interval' | 'hour' | 'day' | 'blocked'; message: string }

export interface UsageSnapshot {
  pages_last_hour: number
  pages_last_day: number
  /** 最近 24 小时的额度用完了。 */
  day_full: boolean
  blocked?: BlockState
}

export interface ReadUsage {
  check(nowMs: number): LimitCheck
  take(nowMs: number): void
  block(kind: WallKind, message: string, nowMs: number, retryAfterMs?: number): void
  snapshot(nowMs: number): UsageSnapshot
}

const clock = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 建一本账。`file` 不给 = 只在内存里（测试用）。 */
export function createReadUsage(options: { file?: string; limits(): ReadLimits }): ReadUsage {
  let state: File = { version: 1, opened: [] }
  if (options.file !== undefined && existsSync(options.file)) {
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<File>
      state = {
        version: 1,
        opened: Array.isArray(raw.opened) ? raw.opened.filter((t) => typeof t === 'number') : [],
        ...(raw.block === undefined ? {} : { block: raw.block }),
      }
    } catch {
      // 坏了就当没记过（只影响限速，不影响安全：白名单与只读在驱动层另有闸）
    }
  }
  const flush = (): void => {
    if (options.file === undefined) return
    mkdirSync(dirname(options.file), { recursive: true })
    const tmp = `${options.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, options.file)
  }
  const prune = (now: number): void => {
    state.opened = state.opened.filter((t) => t > now - DAY && t <= now + 60_000)
    if (state.block !== undefined && state.block.until <= now) delete state.block
  }
  return {
    check(now) {
      prune(now)
      const l = options.limits()
      const b = state.block
      if (b !== undefined)
        return { ok: false, reason: 'blocked', message: `${b.message}（停到 ${clock(b.until)}）` }
      const last = state.opened[state.opened.length - 1]
      if (last !== undefined && now - last < l.min_interval_seconds * 1000) {
        const wait = Math.ceil((l.min_interval_seconds * 1000 - (now - last)) / 1000)
        return {
          ok: false,
          reason: 'interval',
          message: `浏览器只读取数要隔 ${l.min_interval_seconds} 秒开一页，还要等 ${wait} 秒。`,
        }
      }
      if (state.opened.filter((t) => t > now - HOUR).length >= l.max_pages_per_hour)
        return {
          ok: false,
          reason: 'hour',
          message: `这一小时已经开了 ${l.max_pages_per_hour} 页（设置里的上限），过一会儿再取。`,
        }
      if (state.opened.length >= l.max_pages_per_day)
        return {
          ok: false,
          reason: 'day',
          message: `最近 24 小时已经开了 ${l.max_pages_per_day} 页（设置里的上限），明天再取。`,
        }
      return { ok: true }
    },
    take(now) {
      prune(now)
      state.opened.push(now)
      flush()
    },
    block(kind, message, now, retryAfterMs) {
      const pause = Math.max(BLOCK_PAUSE_MS[kind], retryAfterMs ?? 0)
      if (pause <= 0) return
      state.block = { kind, message, at: now, until: now + pause }
      flush()
    },
    snapshot(now) {
      prune(now)
      const l = options.limits()
      return {
        pages_last_hour: state.opened.filter((t) => t > now - HOUR).length,
        pages_last_day: state.opened.length,
        day_full: state.opened.length >= l.max_pages_per_day,
        ...(state.block === undefined ? {} : { blocked: { ...state.block } }),
      }
    },
  }
}
