/**
 * WP287（Luoye 10-09 真机）：一次运行**没跑成**时给人看的那一句。
 *
 * 真机现场：工具参数表 dsh 不认，运行一启动就失败，界面上却写「跑完了 · 1 秒」。现在任何原因的失败
 * 都在时间线 / 当场回答处说「没跑成：<人话>」并给「重试」。原始错误（可能带 schema、堆栈、上游原文）
 * 只进本机事件日志，界面只说人话：
 *
 * - 登录过期 / 余额不足这类，上游那句本来就是给人看的（WP150 / WP151）——原样用；
 * - 模型那边忙 / 连不上 / 超时 → 让人稍后再试；
 * - 其余（内部错、参数表、装配失败…）→ 一句通用的「工坊这边出错了，已记下」。
 */

/** 内部错误的那句通用人话（派工单原文）。 */
export const INTERNAL_FAILURE_TEXT = '工坊这边出错了，已记下，点重试或稍后再试'

const BUSY_CODES = new Set(['provider_unavailable', 'rate_limited', 'timeout'])

/** 余额 / 额度不足的上游原文（WP151 的「去充值」那类），原样给人看。 */
const QUOTA_HINT = /(余额|充值|额度|quota|insufficient)/iu

export function runFailureText(error: { code: string; message: string }): string {
  if (error.code === 'unauthenticated' && error.message.trim() !== '') return error.message.trim()
  if (QUOTA_HINT.test(error.message) && error.message.length <= 120) return error.message.trim()
  if (error.code === 'budget_exhausted') return '这次的额度用完了，调高额度后点重试'
  if (error.code === 'provider_error') return 'AI 这次回得不对劲，点重试再来一次'
  if (BUSY_CODES.has(error.code)) return '模型那边这会儿没回上，点重试或稍后再试'
  return INTERNAL_FAILURE_TEXT
}

/** 时间线上那一整句（`没跑成：…`）。 */
export function runFailureLine(error: { code: string; message: string }): string {
  return `没跑成：${runFailureText(error)}`
}
