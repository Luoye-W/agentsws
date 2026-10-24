/**
 * WP505（决策 1771 B）：红人图片缓存的**清理**——用户不用操心磁盘。
 *
 * 一轮做两件事，只删 `kol-media/` 里缓存的图，红人数据（资料、快照、标签、审核）一个字不动：
 *
 * 1. **没人再引用的删掉**：每个品牌现在还用得上的图 = 每个账号**最近一次存入红人池**那份资料里的头像、横幅、
 *    前几张作品封面（`KolServiceAssembly.mediaReferences`）。换了头像 / 横幅 / 封面，旧的那张就没人引用了。
 *    刚存下不到 {@link KOL_MEDIA_GRACE_MS} 的不删（存入那一刻资料与取图是前后脚，别撞上）。
 * 2. **总量上限**（所有已装起来的品牌合计，默认 {@link KOL_MEDIA_MAX_TOTAL_BYTES}）：超了按「最久没用」
 *    （存下或被看）的先删，删到上限以下。被删掉的人界面上回到一个字的头像 / 色块封面，下次存入时再取。
 *
 * 什么时候跑：服务起来 {@link KOL_MEDIA_FIRST_SWEEP_MS} 后一次，之后每 {@link KOL_MEDIA_SWEEP_EVERY_MS} 一次；
 * 另外每存下一张图叫一声 `nudge()`——合计超了上限就在几秒后补一轮（连着存一批只跑一轮）。
 */
import type { KolMediaCache } from './kol-media.js'

/** 默认总量上限：500 MB（一张几十 KB，够上千个人的头像 + 横幅 + 6 张封面）。 */
export const KOL_MEDIA_MAX_TOTAL_BYTES = 500 * 1024 * 1024
/** 刚存下多久之内不按「没人引用」删。 */
export const KOL_MEDIA_GRACE_MS = 10 * 60 * 1000
/** 起来之后多久跑第一轮（不拖慢启动）。 */
export const KOL_MEDIA_FIRST_SWEEP_MS = 2 * 60 * 1000
/** 之后隔多久跑一轮。 */
export const KOL_MEDIA_SWEEP_EVERY_MS = 6 * 60 * 60 * 1000
/** 存图之后超了上限，隔多久补一轮（连着存一批只跑一轮）。 */
const NUDGE_DELAY_MS = 5_000

/** 一个品牌的缓存 + 它现在还用得上哪些图（外站地址）。 */
export interface KolMediaBrandCache {
  cache: Pick<KolMediaCache, 'entries' | 'remove'>
  /** 这个品牌现在还用得上的图（外站地址；`kolMediaIdOf` 换成 id 比）。 */
  references(): Iterable<string>
}

export interface KolMediaSweep {
  /** 删了几张没人引用的。 */
  unreferenced: number
  /** 为了总量上限删了几张。 */
  evicted: number
  /** 一共腾出多少字节。 */
  freed_bytes: number
  /** 删完之后合计多大。 */
  total_bytes: number
}

export interface KolMediaJanitorOptions {
  /** 现在装起来的品牌（懒取：品牌是陆续装起来的）。 */
  brands(): readonly KolMediaBrandCache[]
  /** 外站地址 → 缓存 id（`kolMediaIdOf`）。 */
  idOf(url: string): string
  maxTotalBytes?: number
  graceMs?: number
  now?: () => number
  log?: (line: string) => void
}

export interface KolMediaJanitor {
  /** 现在跑一轮。 */
  sweep(): KolMediaSweep
  /** 存下了一张：合计超了上限就过一会儿补一轮。 */
  nudge(): void
  /** 起定时（第一轮 + 之后每隔一阵）。 */
  start(timing?: { firstMs?: number; everyMs?: number }): void
  stop(): void
}

export function createKolMediaJanitor(options: KolMediaJanitorOptions): KolMediaJanitor {
  const cap = options.maxTotalBytes ?? KOL_MEDIA_MAX_TOTAL_BYTES
  const grace = options.graceMs ?? KOL_MEDIA_GRACE_MS
  const now = options.now ?? Date.now
  const timers: ReturnType<typeof setTimeout>[] = []
  let nudgeTimer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const totalOf = (): number => {
    let sum = 0
    for (const b of options.brands()) for (const e of b.cache.entries()) sum += e.bytes
    return sum
  }

  const sweep = (): KolMediaSweep => {
    let unreferenced = 0
    let evicted = 0
    let freed = 0
    const t = now()
    const live: { cache: KolMediaBrandCache['cache']; id: string; bytes: number; at: number }[] = []
    for (const brand of options.brands()) {
      let keep: Set<string>
      try {
        keep = new Set([...brand.references()].map((u) => options.idOf(u)))
      } catch {
        // 读不出这个品牌在用哪些图：这一轮不按「没人引用」删它的（宁可留着）
        keep = new Set(brand.cache.entries().map((e) => e.id))
      }
      for (const e of brand.cache.entries()) {
        if (!keep.has(e.id) && t - e.last_used_ms >= grace) {
          brand.cache.remove(e.id)
          unreferenced++
          freed += e.bytes
        } else live.push({ cache: brand.cache, id: e.id, bytes: e.bytes, at: e.last_used_ms })
      }
    }
    let total = live.reduce((s, e) => s + e.bytes, 0)
    if (total > cap) {
      live.sort((a, b) => a.at - b.at)
      for (const e of live) {
        if (total <= cap) break
        e.cache.remove(e.id)
        total -= e.bytes
        freed += e.bytes
        evicted++
      }
    }
    if (unreferenced + evicted > 0)
      options.log?.(
        `红人图片缓存：清掉没人引用的 ${String(unreferenced)} 张、超上限删最久没用的 ${String(evicted)} 张，腾出 ${String(Math.round(freed / 1024))} KB`,
      )
    return { unreferenced, evicted, freed_bytes: freed, total_bytes: total }
  }

  const safeSweep = (): void => {
    if (stopped) return
    try {
      sweep()
    } catch (e) {
      options.log?.(`红人图片缓存：这一轮没清成（${e instanceof Error ? e.message : String(e)}）`)
    }
  }

  return {
    sweep,
    nudge() {
      if (stopped || nudgeTimer !== undefined) return
      if (totalOf() <= cap) return
      nudgeTimer = setTimeout(() => {
        nudgeTimer = undefined
        safeSweep()
      }, NUDGE_DELAY_MS)
      nudgeTimer.unref?.()
    },
    start(timing = {}) {
      const first = setTimeout(safeSweep, timing.firstMs ?? KOL_MEDIA_FIRST_SWEEP_MS)
      const every = setInterval(safeSweep, timing.everyMs ?? KOL_MEDIA_SWEEP_EVERY_MS)
      first.unref?.()
      every.unref?.()
      timers.push(first, every)
    },
    stop() {
      stopped = true
      for (const t of timers.splice(0)) clearTimeout(t)
      if (nudgeTimer !== undefined) clearTimeout(nudgeTimer)
      nudgeTimer = undefined
    },
  }
}
