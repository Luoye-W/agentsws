/**
 * 官方托管的服务额度（WP124）。与 `pricing.json` / `topup-tiers.json` 同一条纪律：
 * **额度是数据不是代码**。改 200 这个数是改 json 出一个版本，不是发版。
 *
 * 这里只有三件事：
 * 1. 把那份 json 端出来（带类型）；
 * 2. 按 id 找一条额度——**找不到就回 `undefined`，语义是「没有这条限制」**
 *    （自建转发就是靠这个无上限：不查这张表）；
 * 3. 一道自检（{@link limitsConsistent}）：提醒比例必须在 (0,1) 开区间里，
 *    数值上限必须是正整数——写错一位数最难在界面上看出来。
 */
import RAW from './limits.json' with { type: 'json' }

export interface ServiceLimit {
  /** 稳定 id（`chat.conversations.monthly`）。 */
  id: string
  /** 数值：对话数是正整数；比例是 (0,1) 的小数。 */
  value: number
  /** 计数口径的归属（现在只有 workspace）。 */
  scope: 'workspace'
  label_zh: string
  label_en: string
}

export interface LimitsFile {
  version: number
  as_of: string
  note: string
  limits: ServiceLimit[]
}

export const LIMITS_FILE: LimitsFile = RAW as LimitsFile

/** 按 id 找一条额度。**认不出就 `undefined`** = 没有这条限制，不是 0。 */
export function serviceLimitById(
  id: string,
  file: LimitsFile = LIMITS_FILE,
): ServiceLimit | undefined {
  return file.limits.find((l) => l.id === id)
}

/** 免费档官方转发每月对话上限（Luoye 09-19 定 200）。 */
export const CHAT_CONVERSATIONS_MONTHLY = serviceLimitById('chat.conversations.monthly')

/** 额度自检：回对不上的那几条（空数组 = 全对）。 */
export function limitsConsistent(file: LimitsFile = LIMITS_FILE): string[] {
  const bad: string[] = []
  for (const limit of file.limits) {
    if (limit.id.includes('ratio')) {
      if (!(limit.value > 0 && limit.value < 1)) bad.push(limit.id)
    } else if (!Number.isInteger(limit.value) || limit.value <= 0) {
      bad.push(limit.id)
    }
  }
  return bad
}
