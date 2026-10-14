/**
 * WP330：Run 里 **Reddit 周报分节与措辞**的两个工具真接上（定义在 `@agentsws/stand-ins` 的 `runtime/reddit-weekly.ts`）。
 *
 * 只做三件事：按这次运行所在的品牌找周报服务；把模型给的那几项交给服务端校验（认不出的照实回）；
 * 出参白名单（格式本身 + 小节标题预览，不带任何原文或记录正文）。每周几几点出走同一条定时（只改这个品牌那一条）。
 */
import type { WorkspaceId } from '@agentsws/contracts'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { GET_REDDIT_WEEKLY_FORMAT_TOOL, SET_REDDIT_WEEKLY_FORMAT_TOOL } from '@agentsws/stand-ins'
import type { RedditWeeklyService } from './reddit-weekly.js'

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.indexOf('.') + 1) : name

const WEEKDAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

type ScheduleView = { weekday: number; time: string; paused: boolean; missing?: boolean }

export function createRedditWeeklyToolExecutor(options: {
  service(workspace_id: WorkspaceId): Promise<RedditWeeklyService>
  schedule(workspace_id: WorkspaceId): ScheduleView
  setSchedule(
    workspace_id: WorkspaceId,
    input: { weekday: number; time: string },
  ): Promise<ScheduleView>
}): ToolExecutor {
  const when = (s: ScheduleView): string =>
    s.missing === true ? '还没排上（先有人担 Reddit 运营）' : `每${WEEKDAY_ZH[s.weekday]} ${s.time}`
  return async (call): Promise<ToolExecution> => {
    const ws = call.request.workspace_id
    const input = (call.input ?? {}) as Record<string, unknown>
    const service = await options.service(ws)
    const view = () => {
      const f = service.format()
      return {
        title: f.title,
        sections: f.sections,
        numbering: f.numbering,
        assessment_labels: f.assessment_labels,
        quote_max_chars: f.quote_max_chars,
        max_quotes_per_topic: f.max_quotes_per_topic,
        date_format: f.date_format,
        window_start_weekday: f.window_start_weekday,
        schedule: when(options.schedule(ws)),
        preview: f.sections.filter((s) => s.enabled).map((s) => s.title),
      }
    }
    switch (bare(call.name)) {
      case GET_REDDIT_WEEKLY_FORMAT_TOOL: {
        const last = service.report()
        return {
          status: 'ok',
          data: { ...view(), ...(last === undefined ? {} : { last_report: last.title }) },
        }
      }
      case SET_REDDIT_WEEKLY_FORMAT_TOOL: {
        const { weekday, time, reset, ...patch } = input
        const problems: string[] = []
        const r = service.setFormat(patch, reset === true ? { reset: true } : {})
        problems.push(...r.problems.filter((p) => p !== '没给要改什么'))
        if (weekday !== undefined || time !== undefined) {
          const now = options.schedule(ws)
          const day = weekday ?? now.weekday
          const at = time ?? now.time
          if (
            typeof day !== 'number' ||
            !Number.isInteger(day) ||
            day < 0 ||
            day > 6 ||
            typeof at !== 'string' ||
            !/^([01]\d|2[0-3]):[0-5]\d$/.test(at)
          )
            problems.push('出报告的时间要写成 周几（0–6）+ HH:MM')
          else
            await options.setSchedule(ws, { weekday: day, time: at }).catch((e: unknown) => {
              problems.push(e instanceof Error ? e.message : String(e))
            })
        }
        return { status: 'ok', data: { ok: problems.length === 0, ...view(), problems } }
      }
      default:
        return { status: 'error', reason: `不认识的工具 ${call.name}` }
    }
  }
}
