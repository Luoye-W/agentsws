/** 移植自 agentsws-extension `src/lib/kol/format.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）。决策 1739 A：只搬采集器与指标算法；开源仓这一份只改 import 路径（与注释里点名私有插件 / 模板的几个词），本体逐字不动。 */
/** 移植自 KOLAgents 浏览器插件（Browser Extension - Influencer Assistant） `src/lib/format.ts` @ d25b877（原移植基准 25bbeae；与 d25b877 相比只差 import 路径与下面写明的本仓改动）。 */
/** Display formatting shared by the capture cards. */
import { activeLang, pick } from "./language.js"

/** Compact numbers read as 12.3万 to a Chinese reader and 123K to an English one. */
const localeTag = () => (activeLang() === "zh" ? "zh-CN" : "en-US")

export function formatNumber(value?: number) {
  if (!Number.isFinite(value)) return "-"
  return new Intl.NumberFormat(localeTag(), {
    notation: "compact",
    maximumFractionDigits: 1
  }).format(value as number)
}

export function formatDate(iso?: string) {
  if (!iso) return undefined
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return iso
  return parsed.toLocaleDateString(localeTag())
}

/**
 * Seconds as a clock — 95 → "1:35", 3725 → "1:02:05". Not localized on
 * purpose: m:ss is how both platforms and both languages already write a
 * runtime, and it is what the export row prints, so the panel and the sheet
 * say the same thing.
 */
export function formatDurationClock(
  seconds?: number | null
): string | undefined {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) {
    return undefined
  }
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const ss = String(total % 60).padStart(2, "0")
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}`
    : `${minutes}:${ss}`
}

/** "3 分钟前" / "2 天前" — how fresh a cached/library value is. */
export function formatRelativeTime(iso?: string): string | undefined {
  if (!iso) return undefined
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return undefined
  const minutes = Math.round((Date.now() - then) / 60_000)
  if (minutes < 1) return pick("刚刚", "just now")
  if (minutes < 60) return pick(`${minutes} 分钟前`, `${minutes} min ago`)
  const hours = Math.round(minutes / 60)
  if (hours < 24) return pick(`${hours} 小时前`, `${hours}h ago`)
  const days = Math.round(hours / 24)
  if (days < 30) return pick(`${days} 天前`, `${days}d ago`)
  const months = Math.round(days / 30)
  if (months < 12) return pick(`${months} 个月前`, `${months}mo ago`)
  const years = Math.round(months / 12)
  return pick(`${years} 年前`, `${years}y ago`)
}
