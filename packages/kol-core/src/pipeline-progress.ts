/**
 * 合作的分段进度（WP302，决策 406 第一期）。
 *
 * 改编自 KOLAgents（Luoye 的产品，非模板代码）：`src/influencer/pipeline-progress.ts` @ 88d74b2c 的
 * `PIPELINE_STALL_DAYS` / `STALL_WATCHED_STAGES` / `dwellDays` / `isStageStalled` / `stageSegments`。
 * 规则一条没改：只盯着**要人推着走的那几段**，在一段里停满 7 天就标黄；结案 / 谢绝是终点，
 * 谢绝的那条不把后面几段画成「到过」。改的只有阶段表——决策 404：合作阶段机以工坊这十段为准
 * （KOLAgents 前半段的「已发现 / 已通过」在候选池里，不在这里）。
 *
 * 纯函数：只认阶段名与时刻，界面、看板、卡片「依据」三处同一份，画出来的条永远一致。
 */
import type { CollaborationStage } from '@agentsws/contracts'

const DAY_MS = 24 * 60 * 60 * 1000

/** 在一段里停多少天就标黄（KOLAgents 的同一个数）。 */
export const PIPELINE_STALL_DAYS = 7

/**
 * 停久了值得催的那几段：发了信等回、回了没往下谈、谈着没定、谈成了没动。
 * 「已找到」是还没开始（那是待办，不是卡住），寄样之后到交付由交付物的排期管，终点不标。
 */
export const STALL_WATCHED_STAGES: ReadonlySet<CollaborationStage> = new Set([
  'contacted',
  'replied',
  'negotiating',
  'agreed',
])

/** 进度条的主线（`declined` 是另一个终点，单独画）。 */
export const PIPELINE_STAGES: readonly CollaborationStage[] = [
  'sourced',
  'contacted',
  'replied',
  'negotiating',
  'agreed',
  'sample_sent',
  'delivering',
  'delivered',
  'closed',
]

function toMs(value: string | undefined): number | null {
  if (value === undefined) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? t : null
}

/**
 * 在这一段里停了几整天；算不出来回 `null`。
 *
 * 向下取整（不满一天不说「已 1 天」）；时钟偏一点、时刻落在将来的按 0 天。
 * `stage_changed_at` 是 WP302 才开始记的，老数据退回 `fallback`（最近一次动静）。
 */
export function dwellDays(
  stageChangedAt: string | undefined,
  now: string,
  fallback?: string,
): number | null {
  const since = toMs(stageChangedAt) ?? toMs(fallback)
  const at = toMs(now)
  if (since === null || at === null) return null
  return Math.max(0, Math.floor((at - since) / DAY_MS))
}

/** 是不是停久了：只在盯着的那几段、停满 {@link PIPELINE_STALL_DAYS} 天才算。 */
export function isStageStalled(
  stage: CollaborationStage,
  stageChangedAt: string | undefined,
  now: string,
  fallback?: string,
): boolean {
  if (!STALL_WATCHED_STAGES.has(stage)) return false
  const days = dwellDays(stageChangedAt, now, fallback)
  return days !== null && days >= PIPELINE_STALL_DAYS
}

/** 一段在条上怎么画。 */
export type StageSegmentState = 'done' | 'current' | 'pending' | 'terminal'

export interface StageSegment {
  stage: CollaborationStage
  state: StageSegmentState
  /** 只有当前那一段、而且停久了才是 true。 */
  stalled: boolean
}

/**
 * 一条合作的那几段。
 *
 * - 「已寄样」只在这条合作寄过样（或正停在那一段）时出——不寄样的合作从「谈成」直接开拍，
 *   画一段永远空着的格子会让人以为漏了一步；
 * - 谢绝的那条：谢绝之前到过的几段是 done，自己是 terminal，后面的不画（这条线断了，
 *   不该看起来像走完了）。
 */
export function stageSegments(
  stage: CollaborationStage,
  options: {
    now: string
    stageChangedAt?: string | undefined
    lastActivityAt?: string | undefined
    /** 这条合作寄过样（有 `sample`）。 */
    withSample?: boolean | undefined
    /** 谢绝之前走到了哪一段（不给就只画到「已找到」）。 */
    declinedFrom?: CollaborationStage | undefined
  },
): StageSegment[] {
  const stalled = isStageStalled(stage, options.stageChangedAt, options.now, options.lastActivityAt)
  const line = PIPELINE_STAGES.filter(
    (s) => s !== 'sample_sent' || options.withSample === true || stage === 'sample_sent',
  )
  if (stage === 'declined') {
    const reached = line.indexOf(options.declinedFrom ?? 'sourced')
    return [
      ...line
        .slice(0, Math.max(0, reached) + 1)
        .map((s) => ({ stage: s, state: 'done' as const, stalled: false })),
      { stage: 'declined', state: 'terminal', stalled: false },
    ]
  }
  const at = line.indexOf(stage)
  return line.map((s, i) => ({
    stage: s,
    state: i < at ? 'done' : i === at ? (stage === 'closed' ? 'terminal' : 'current') : 'pending',
    stalled: i === at && stalled,
  }))
}
