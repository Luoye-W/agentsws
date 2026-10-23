/**
 * 采集器要的那一句：「近期作品缺少发布时间，无法判断更新规律」（`assessUploadRegularity` 的兜底说明）。
 *
 * 出处：agentsws-extension `src/contents/utils/captureStrings.ts` @ 57fca9c（源自 KOLAgents 旧插件 d25b877）的
 * `PlatformStrings` / `PLATFORM_ZH` / `PLATFORM_EN` / `platformStrings()`。决策 1739 A 只搬采集器与算法，**面板文案不搬**——
 * 三个主页采集器只读 `.regularityUnknown` 这一格，所以这里只留这一格，句子逐字照抄；其余面板文案仍只在私有插件里。
 */
import type { CapturePlatform } from "../kol/utils/creatorSnapshot.js"
import { activeLang } from "../kol/language.js"

export type PlatformStrings = {
  /** Shown when there are too few dated posts to judge upload cadence. */
  regularityUnknown: string
}

const PLATFORM_ZH: Record<CapturePlatform, PlatformStrings> = {
  youtube: {
    regularityUnknown: "近期视频样本不足，打开频道“视频”页可判断更新规律"
  },
  instagram: {
    regularityUnknown: "近期帖子缺少发布时间，无法判断更新规律"
  },
  tiktok: {
    regularityUnknown: "近期视频缺少发布时间，无法判断更新规律"
  }
}

const PLATFORM_EN: Record<CapturePlatform, PlatformStrings> = {
  youtube: {
    regularityUnknown:
      "Too few recent videos to judge cadence — open the channel's Videos tab"
  },
  instagram: {
    regularityUnknown: "Recent posts carry no dates, so cadence is unknown"
  },
  tiktok: {
    regularityUnknown: "Recent videos carry no dates, so cadence is unknown"
  }
}

export function platformStrings(): Record<CapturePlatform, PlatformStrings> {
  return activeLang() === "zh" ? PLATFORM_ZH : PLATFORM_EN
}
