/**
 * WP455（docs/110 §3.1 第 5–8 条，决策 1434）：搜索回退链里「用你的 Chrome 搜 Google」那一环的**全进程**那几样。
 *
 * 用户的 Chrome 一台电脑只有一个，几个品牌共用——所以频率和「今天停用」按整台机算，不按品牌：
 * - 每小时最多 {@link OWN_CHROME_MAX_PER_HOUR} 次（同时照样计入内置浏览器那每小时 60 页的总上限，在搜索那边套）；
 * - 在你的 Chrome 里遇到 Google 的人机验证 / `/sorry`（或 cookie 同意页）：**不亮给人、不点**，
 *   这一路停到北京时间第二天零点——不让工坊连累你自己用 Google。停用记在数据目录下一个小文件里，重启不丢。
 *
 * 读页本身走 WP402 的 BrowserSkill 读页（`own-browser.ts`，每个品牌一个后台窗口，闲 30 秒自动关）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { OwnBrowserReader } from './own-browser.js'
import { createSearchThrottle, OWN_CHROME_MAX_PER_HOUR, type SearchThrottle } from './search.js'

const BEIJING_OFFSET_MS = 8 * 3_600_000
const DAY_MS = 86_400_000

/** 北京时间（UTC+8，没有夏令时）下一个零点。 */
export function nextBeijingMidnight(ms: number): number {
  return (Math.floor((ms + BEIJING_OFFSET_MS) / DAY_MS) + 1) * DAY_MS - BEIJING_OFFSET_MS
}

/** 整台机一份：这一路的频率与停用。 */
export interface OwnChromeGate {
  /** 每小时 20 次那一道（同一时刻只搜一次）。 */
  readonly throttle: SearchThrottle
  /** 停着没有；停着回停到什么时候。 */
  pausedUntil(): number | undefined
  /** 被 Google 拦了：停到北京时间第二天零点。 */
  pauseForToday(): number
}

export function createOwnChromeGate(o: {
  now(): number
  /** 停用记在哪（数据目录下）；不给 = 只在内存里。 */
  file?: string | undefined
  maxPerHour?: number
}): OwnChromeGate {
  let until: number | undefined
  if (o.file !== undefined && existsSync(o.file)) {
    try {
      const raw = JSON.parse(readFileSync(o.file, 'utf8')) as { paused_until?: unknown }
      if (typeof raw.paused_until === 'number') until = raw.paused_until
    } catch {
      // 读不了就当没停
    }
  }
  const save = (): void => {
    if (o.file === undefined) return
    try {
      mkdirSync(dirname(o.file), { recursive: true })
      writeFileSync(`${o.file}.tmp`, JSON.stringify({ version: 1, paused_until: until ?? null }))
      renameSync(`${o.file}.tmp`, o.file)
    } catch {
      // 落不了盘只影响重启后记不记得，不影响这一次
    }
  }
  const throttle = createSearchThrottle({
    now: o.now,
    random: () => 0,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    maxPerHour: o.maxPerHour ?? OWN_CHROME_MAX_PER_HOUR,
    // 间隔由外面那道总节流管（随机 2–4 秒），这里只数次数
    minGapMs: 0,
    maxGapMs: 0,
  })
  return {
    throttle,
    pausedUntil() {
      if (until === undefined) return undefined
      if (until <= o.now()) {
        until = undefined
        save()
        return undefined
      }
      return until
    },
    pauseForToday() {
      until = nextBeijingMidnight(o.now())
      save()
      return until
    },
  }
}

/** 搜索后端要的那一份：这个品牌的读页（没有 = 这一路跳过）+ 整台机的频率与停用。 */
export interface OwnChromeSearch {
  /** 「用你正在用的浏览器」装好了、服务在用户电脑上才有；没有 = `undefined`。 */
  reader(): OwnBrowserReader | undefined
  gate: OwnChromeGate
}
