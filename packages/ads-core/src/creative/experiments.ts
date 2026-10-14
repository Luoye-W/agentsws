/**
 * WP317（docs/101 §5.1④「实验记忆」；docs/100 §1.2 Austin 的「简易记忆」）。
 *
 * 每一轮记三样：**假设 / 改了什么 / 结果**。下一次出文案时，最近几笔带进
 * 两个子 Agent 的上下文——「上次带价格的标题点击率高」这种结论不该每轮重新试一遍。
 *
 * 纯函数：校验、写成记忆条目的那段话、挑哪几笔进上下文。存在哪由服务端定
 * （按品牌一张库，同步一份进投放岗记忆，docs/54）。
 */

import type { AdExperimentEntry } from '@agentsws/contracts'

/** 新记一笔的入参（`result` 可以晚点回填）。 */
export interface AdExperimentInput {
  hypothesis: string
  change: string
  result?: string | undefined
}

/** 三格的长度上限（进上下文的是它们，太长等于往提示词里塞一份报告）。 */
export const AD_EXPERIMENT_LIMITS = { hypothesis: 200, change: 300, result: 300 } as const

/** 校验一笔；回空数组 = 可以记。 */
export function checkExperiment(input: AdExperimentInput): string[] {
  const problems: string[] = []
  if (input.hypothesis.trim() === '') problems.push('「假设」不能空：这一轮想验证什么？')
  if (input.change.trim() === '') problems.push('「改了什么」不能空：这一轮具体动了哪一样？')
  for (const k of ['hypothesis', 'change', 'result'] as const) {
    const v = input[k]
    if (v !== undefined && [...v].length > AD_EXPERIMENT_LIMITS[k])
      problems.push(`「${LABEL[k]}」最多 ${AD_EXPERIMENT_LIMITS[k]} 字，写短一点。`)
  }
  return problems
}

const LABEL = { hypothesis: '假设', change: '改了什么', result: '结果' } as const

/**
 * 一笔 → 投放岗记忆里那一条（标题 + 正文）。
 *
 * 标题带品牌名：岗位记忆不分品牌（docs/54 §3），同一个人管两个品牌时，
 * 记忆面板上要一眼分得开是哪家的实验。
 */
export function experimentMemoryText(
  entry: Pick<AdExperimentEntry, 'round' | 'hypothesis' | 'change' | 'result' | 'platform'>,
  brand: string,
): { heading: string; text: string } {
  const short = [...entry.hypothesis.trim()].slice(0, 16).join('')
  return {
    heading: `广告实验 · ${brand} · 第 ${entry.round} 轮：${short}`,
    text: [
      `假设：${entry.hypothesis.trim()}`,
      `改了什么：${entry.change.trim()}`,
      `结果：${entry.result?.trim() || '还没有结果'}`,
      ...(entry.platform === undefined
        ? []
        : [`平台：${entry.platform === 'google' ? 'Google' : 'Meta'}`]),
    ].join('\n'),
  }
}

/**
 * 挑哪几笔进上下文、写成一段。
 *
 * 有结果的优先（没结果的只是一个还没验证的猜想），同等条件下新的优先；
 * 最多 `limit` 笔。一笔都没有回 `undefined`（提示词里就不出这一块）。
 */
export function experimentContext(
  entries: readonly AdExperimentEntry[],
  options: { limit?: number; platform?: AdExperimentEntry['platform'] } = {},
): { text: string; used: number } | undefined {
  const limit = options.limit ?? 8
  const pool = entries.filter(
    (e) =>
      options.platform === undefined || e.platform === undefined || e.platform === options.platform,
  )
  const picked = [...pool]
    .sort((a, b) => {
      const ra = a.result?.trim() ? 1 : 0
      const rb = b.result?.trim() ? 1 : 0
      if (ra !== rb) return rb - ra
      return b.round - a.round
    })
    .slice(0, limit)
  if (picked.length === 0) return undefined
  const text = picked
    .sort((a, b) => a.round - b.round)
    .map(
      (e) =>
        `第 ${e.round} 轮｜假设：${e.hypothesis.trim()}｜改了：${e.change.trim()}｜结果：${e.result?.trim() || '还没有'}`,
    )
    .join('\n')
  return { text, used: picked.length }
}

/** 下一笔是第几轮（同一品牌内递增）。 */
export function nextExperimentRound(entries: readonly AdExperimentEntry[]): number {
  return entries.reduce((m, e) => Math.max(m, e.round), 0) + 1
}
