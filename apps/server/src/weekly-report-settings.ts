/**
 * WP388（docs/103 S3 / T2）：系统自带的三份周报——岗位周复盘、经营一页纸、SEO 周报——**几点出**，
 * 用户跟 AI 说一声就能改（「周复盘改到周五下午 5 点」）：走 `request_setup` 的「改设置」卡（WP334 / 决策 841），
 * 设置目标 `schedule.weekly_reports`。卡上每份一格（这个品牌里有的那几份），写法「周五 17:00」。
 *
 * 默认每周一 16:30（工作区时区）出上一周的；改过的照用户的（`ensureDefaultTask` 不覆盖）。
 * 周复盘每人一条：卡上确认的是谁，就只改谁的（经营一页纸、SEO 周报一个品牌一条）。
 * 这里只认这三份系统自带的；AI 用「自动化任务」建的周报由 AI 自己改那条定时，不走这里。
 */
import type { SetupField } from '@agentsws/contracts'
import {
  type Scheduler,
  type ScheduleTask,
  WEEKLY_REPORT_CRON,
  WEEKLY_REPORT_WHY,
} from '@agentsws/schedule'
import { HANDLERS } from './schedule.js'
import { SetupCardError, type SetupTarget } from './setup-cards.js'

export const WEEKLY_REPORTS_TARGET = 'schedule.weekly_reports'

/** 三份系统周报（键 → 人话名、哪个处理器）。 */
export const WEEKLY_REPORT_KINDS: readonly {
  key: 'review_week' | 'weekly_review' | 'seo_weekly'
  label: string
  handler: string
  kind?: string
}[] = [
  { key: 'review_week', label: '周复盘', handler: HANDLERS.review, kind: 'week' },
  { key: 'weekly_review', label: '经营一页纸', handler: HANDLERS.weeklyReview },
  { key: 'seo_weekly', label: 'SEO 周报', handler: HANDLERS.seoWeekly },
]

const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const CN_DAY: Readonly<Record<string, number>> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
}
const EN_DAY = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

/** 一条周定时 → 「周一 16:30」（不是「某天某时」那种 cron 的回 `undefined`）。 */
export function formatWeekly(task: ScheduleTask): string | undefined {
  if (task.trigger.kind !== 'cron') return undefined
  const [mm, hh, dom, mon, dow] = task.trigger.expr.trim().split(/\s+/)
  if (dom !== '*' || mon !== '*' || !/^\d+$/.test(mm ?? '') || !/^\d+$/.test(hh ?? ''))
    return undefined
  if (!/^\d$/.test(dow ?? '')) return undefined
  const day = DAYS[Number(dow) % 7]
  return `${day} ${String(Number(hh)).padStart(2, '0')}:${String(Number(mm)).padStart(2, '0')}`
}

/**
 * 「周五 17:00」「星期五 下午 5 点」「Fri 17:30」「周五 5:30pm」→ 星期几（0 = 周日）+ 时分。认不出回 `undefined`。
 */
export function parseWeekly(
  text: string,
): { weekday: number; hour: number; minute: number } | undefined {
  const t = text.trim().toLowerCase()
  const cn = /(?:周|星期|礼拜)([日天一二三四五六])/.exec(t)?.[1]
  const en = EN_DAY.findIndex((d) => new RegExp(`\\b${d}`).test(t))
  const weekday = cn !== undefined ? CN_DAY[cn] : en >= 0 ? en : undefined
  if (weekday === undefined) return undefined
  let hour: number | undefined
  let minute = 0
  const hm = /(\d{1,2})\s*[:：]\s*(\d{2})/.exec(t)
  const dian = /(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/.exec(t)
  if (hm !== null) {
    hour = Number(hm[1])
    minute = Number(hm[2])
  } else if (dian !== null) {
    hour = Number(dian[1])
    minute = dian[2] === '半' ? 30 : dian[3] !== undefined ? Number(dian[3]) : 0
  } else {
    const ampm = /(\d{1,2})\s*(am|pm)\b/.exec(t)
    if (ampm !== null) hour = Number(ampm[1])
  }
  if (hour === undefined) return undefined
  const pm = /下午|晚上|傍晚|pm\b/.test(t)
  if (pm && hour < 12) hour += 12
  if (/am\b|凌晨|早上|上午/.test(t) && hour === 12) hour = 0
  if (hour > 23 || minute > 59) return undefined
  return { weekday, hour, minute }
}

/** 这个品牌里某一份系统周报的定时（周复盘每个岗位一条；结束了的不算）。 */
export function weeklyReportTasks(
  scheduler: Scheduler,
  workspace_id: string,
  key: (typeof WEEKLY_REPORT_KINDS)[number]['key'],
): ScheduleTask[] {
  const spec = WEEKLY_REPORT_KINDS.find((k) => k.key === key)
  if (spec === undefined) return []
  return scheduler
    .list({
      workspace_id: workspace_id as never,
      handler: spec.handler,
      state: ['active', 'paused'],
    })
    .filter((t) => spec.kind === undefined || t.params?.kind === spec.kind)
}

/** 设置目标：三份系统周报几点出（见文件头）。 */
export function weeklyReportsSetupTarget(input: {
  /** 现取（服务装配时调度器可能还没建好）。 */
  scheduler(): Scheduler
  workspace_id: string
}): SetupTarget {
  const present = () =>
    WEEKLY_REPORT_KINDS.flatMap((spec) => {
      const tasks = weeklyReportTasks(input.scheduler(), input.workspace_id, spec.key)
      const first = tasks[0]
      return first === undefined ? [] : [{ spec, tasks, value: formatWeekly(first) }]
    })
  const defaultText = formatWeekly({
    trigger: { kind: 'cron', expr: WEEKLY_REPORT_CRON, tz: 'UTC' },
  } as ScheduleTask)
  return {
    id: WEEKLY_REPORTS_TARGET,
    name: '周报几点出',
    why: '每周一 16:30 出上周。',
    async fields(): Promise<SetupField[]> {
      return present().map(
        ({ spec, value }): SetupField => ({
          key: spec.key,
          label: spec.label,
          kind: 'text',
          placeholder: '周一 16:30',
          ...(value === undefined ? {} : { suggested: value }),
          ...(value === defaultText ? { suggested_why: WEEKLY_REPORT_WHY } : {}),
          required: false,
        }),
      )
    },
    // 一直有默认值 = 不缺什么；人说要改时 AI 带新值来，出「我打算改成这样」的卡
    satisfied: async () => true,
    async apply(values, context): Promise<void> {
      const rows = present()
      if (rows.length === 0)
        throw new SetupCardError('unknown_target', '这个品牌还没有系统自带的周报定时。')
      const plan: { tasks: ScheduleTask[]; expr: string }[] = []
      for (const row of rows) {
        const { spec } = row
        // 周复盘每人一条：知道是谁确认的，就只改他自己的（公司模式下不动同事的）
        const tasks =
          spec.key === 'review_week' && context?.by !== undefined
            ? row.tasks.filter((t) => t.owner === context.by)
            : row.tasks
        const first = tasks[0]
        if (first === undefined) continue
        const value = formatWeekly(first)
        const raw = values[spec.key]?.trim()
        if (raw === undefined || raw === '' || raw === value) continue
        const p = parseWeekly(raw)
        if (p === undefined)
          throw new SetupCardError(
            'invalid_input',
            `「${spec.label}」没看懂，写成「周五 17:00」这样。`,
          )
        plan.push({ tasks, expr: `${p.minute} ${p.hour} * * ${p.weekday}` })
      }
      for (const { tasks, expr } of plan)
        for (const t of tasks) {
          const tz = t.trigger.kind === 'cron' ? t.trigger.tz : 'UTC'
          await input.scheduler().update(t.id, { trigger: { kind: 'cron', expr, tz } })
        }
    },
  }
}
