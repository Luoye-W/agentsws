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

import { isSourceFallbackOffText } from '@agentsws/model-gateway'

/** 内部错误的那句通用人话（派工单原文）。 */
export const INTERNAL_FAILURE_TEXT = '工坊这边出错了，已记下，点重试或稍后再试'

const BUSY_CODES = new Set(['provider_unavailable', 'rate_limited', 'timeout'])

/** 余额 / 额度不足的上游原文（WP151 的「去充值」那类），原样给人看。 */
const QUOTA_HINT = /(余额|充值|额度|quota|insufficient)/iu

/** 中文里有没有字（上游原文全是英文时不原样给非技术用户看）。 */
const HAS_CJK = /[\u4e00-\u9fff]/u

/**
 * WP421（自查 general 2.5）：余额 / 额度 / 登录过期的上游原文是英文时（"Insufficient Balance"、"quota exceeded"），
 * 换成中文固定句；中文原文（自家写的人话）照旧原样用。英文原文只进日志。
 */
const QUOTA_ZH = '模型那边的余额或额度不够了，去充值或换一个模型后点重试'
const AUTH_ZH = '模型账号的登录过期了（或 key 不对），重新登录 / 换一把 key 后点重试'

export function runFailureText(error: { code: string; message: string }): string {
  const msg = error.message.trim()
  // WP425：自己的 AI 用不了、开关关着停下的那一句本来就是给人看的（说清原因与开关）
  if (isSourceFallbackOffText(error.message)) return msg
  if (error.code === 'unauthenticated' && msg !== '') return HAS_CJK.test(msg) ? msg : AUTH_ZH
  if (QUOTA_HINT.test(msg) && msg.length <= 120) return HAS_CJK.test(msg) ? msg : QUOTA_ZH
  if (error.code === 'budget_exhausted') return '这次的额度用完了，调高额度后点重试'
  if (error.code === 'provider_error') return 'AI 这次回得不对劲，点重试再来一次'
  if (BUSY_CODES.has(error.code)) return '模型那边这会儿没回上，点重试或稍后再试'
  return INTERNAL_FAILURE_TEXT
}

/** 时间线上那一整句（`没跑成：…`）。 */
export function runFailureLine(error: { code: string; message: string }): string {
  return `没跑成：${runFailureText(error)}`
}
