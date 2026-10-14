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

/** 记忆条目标题的前缀：靠它从岗位记忆里认出哪几条是广告实验。 */
export const AD_EXPERIMENT_HEADING = '广告实验'

/**
 * 一笔 → 投放岗记忆里那一条（标题 + 正文）。**这一条就是真源**（WP320 起岗位记忆
 * 落盘、按品牌分），人在记忆面板里改它，流水线下一轮读到的就是改后的。
 */
export function experimentMemoryText(
  entry: Pick<AdExperimentEntry, 'round' | 'hypothesis' | 'change' | 'result' | 'platform'>,
): { heading: string; text: string } {
  const short = [...entry.hypothesis.trim()].slice(0, 16).join('')
  return {
    heading: `${AD_EXPERIMENT_HEADING} · 第 ${entry.round} 轮：${short}`,
    text: [
      `假设：${entry.hypothesis.trim()}`,
      `改了什么：${entry.change.trim()}`,
      `结果：${entry.result?.trim() || NO_RESULT}`,
      ...(entry.platform === undefined
        ? []
        : [`平台：${entry.platform === 'google' ? 'Google' : 'Meta'}`]),
    ].join('\n'),
  }
}

const NO_RESULT = '还没有结果'

/**
 * 岗位记忆里的一条 → 一笔实验（{@link experimentMemoryText} 的反方向）。
 *
 * 认不出（标题不是「广告实验」开头、或假设 / 改了什么缺了）回 `undefined`——
 * 人在面板里把它改成了别的东西，就不再当实验读。
 */
export function experimentFromMemory(memory: {
  id: string
  heading?: string
  body: string
}): Omit<AdExperimentEntry, 'at'> | undefined {
  const heading = memory.heading ?? ''
  if (!heading.startsWith(AD_EXPERIMENT_HEADING)) return undefined
  const line = (label: string): string | undefined => {
    const hit = memory.body.split('\n').find((l) => l.startsWith(`${label}：`))
    const v = hit?.slice(label.length + 1).trim()
    return v === undefined || v === '' ? undefined : v
  }
  const hypothesis = line('假设')
  const change = line('改了什么')
  if (hypothesis === undefined || change === undefined) return undefined
  const result = line('结果')
  const platform = line('平台')
  const round = Number(/第\s*(\d+)\s*轮/.exec(heading)?.[1] ?? '0')
  return {
    id: memory.id,
    memory_id: memory.id,
    round,
    hypothesis,
    change,
    ...(result === undefined || result === NO_RESULT ? {} : { result }),
    ...(platform === 'Google' ? { platform: 'google' as const } : {}),
    ...(platform === 'Meta' ? { platform: 'meta' as const } : {}),
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
