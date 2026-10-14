/**
 * WP319 ③（Luoye 10-14 Windows 真机）：**开机自检——挂在「进行中」的没跑成**。
 *
 * 现场：独立站岗位「店铺管理」下「查询店铺当前在售产品」一直挂在「进行中」，旁边是原始错误
 * 「dsh 组合装配失败：…unsupported …」。那一轮是 10-09 热修（dsh 工具参数表）之前跑的：运行一启动就失败，
 * 当时的版本时间线上只记了「跑完了」、事项摘要落的是原始错误——WP287 之后新跑的都会说「没跑成」，
 * 但**老事项不会自己改过来**。还有一种同样挂着的：运行跑到一半应用被关掉 / 被更新重启了，
 * 时间线上只有「开始跑了」，永远等不到收尾。
 *
 * 开机时（这个品牌还没有任何运行在跑）扫一遍开着的事项，最近一轮**没有收尾**的按本机事件日志补一句：
 *
 * | 事件日志里这一轮 | 补什么 |
 * |---|---|
 * | 有 `run.failed` | 「没跑成：<人话>」+ 失败标记（界面出「重试」）；原始错误仍只在事件日志里 |
 * | 有开跑、没有任何收尾（`run.completed` / `run.failed` / `run.cancelled`） | 「没跑成：上次没跑完（应用关了或更新了）…」+ 失败标记 |
 * | 有 `run.completed` / `run.cancelled`，或一条运行事件都查不到 | 不动（说不清的不编） |
 *
 * 事项摘要里还挂着原始错误（「dsh 组合装配失败…」这类）的，换成同一句人话。**幂等**：补过的那一轮已经有
 * 「没跑成」那一条，再扫就是收了尾的，不会补第二次。
 */
import type { Matter, MatterEvent, MatterId, RunId } from '@agentsws/contracts'
import { matterRunStateOf } from './position-work.js'
import { runFailureLine, runFailureText } from './run-failure.js'

/** 跑到一半应用关了 / 更新重启了的那一句。 */
export const INTERRUPTED_FAILURE_TEXT = '上次没跑完（应用关了或更新了），点重试再跑一次'

/** 运行事件里认作「这一轮收尾了」的几种。 */
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled'])

/** 摘要里挂着原始错误的样子（运行时的原文：装配失败、参数表、堆栈）。 */
const RAW_FAILURE =
  /组合装配失败|input_schema|unsupported keyword|must be explicitly|^\w*Error:|\n\s+at /u

export interface RunRepairPort {
  /** 开着的事项（开着 / 等着，未归档）。 */
  openMatters(): readonly Matter[]
  /** 一件事项的时间线（最近的若干条，按时间先后）。 */
  timeline(matter_id: MatterId): readonly MatterEvent[]
  /** 本机事件日志里这一轮运行的事件（只要 `type` 与 `payload`）。 */
  runEvents(run_id: RunId): readonly { type: string; payload: unknown }[]
  /** 时间线上补一条。 */
  append(
    matter_id: MatterId,
    event: Pick<MatterEvent, 'kind' | 'text' | 'actor' | 'run_id' | 'failed'>,
  ): void
  /** 把事项摘要换成人话（不动别的格、不算一次新活动）。 */
  setSummary(matter: Matter, summary: string): void
}

export interface RunRepairResult {
  matter_id: MatterId
  run_id: RunId
  why: 'failed' | 'interrupted'
}

function errorOf(payload: unknown): { code: string; message: string } {
  const e =
    typeof payload === 'object' && payload !== null
      ? (payload as { error?: { code?: unknown; message?: unknown } }).error
      : undefined
  return {
    code: typeof e?.code === 'string' ? e.code : 'internal',
    message: typeof e?.message === 'string' ? e.message : '',
  }
}

/** 扫一遍、补齐，回补了哪几件（事件与日志由调用方记）。 */
export function repairStuckRuns(port: RunRepairPort): RunRepairResult[] {
  const out: RunRepairResult[] = []
  for (const matter of port.openMatters()) {
    const events = port.timeline(matter.id)
    const state = matterRunStateOf(events, false)
    // 收了尾的（答了 / 停了 / 没跑成 / 卡在缺连接）不动
    if (state.last !== undefined || state.blocked !== undefined) continue
    const run_id = [...events].reverse().find((e) => e.run_id !== undefined)?.run_id
    if (run_id === undefined) continue
    const runEvents = port.runEvents(run_id)
    if (runEvents.length === 0) continue
    const failed = runEvents.find((e) => e.type === 'run.failed')
    const ended = runEvents.some((e) => TERMINAL.has(e.type))
    let text: string
    let code: string
    if (failed !== undefined) {
      const error = errorOf(failed.payload)
      text = runFailureLine(error)
      code = error.code
    } else if (!ended) {
      text = `没跑成：${INTERRUPTED_FAILURE_TEXT}`
      code = 'interrupted'
    } else continue
    port.append(matter.id, {
      kind: 'status',
      text,
      actor: { kind: 'system', id: 'runtime' },
      run_id,
      failed: { code, retryable: true },
    })
    if (RAW_FAILURE.test(matter.context.summary))
      port.setSummary(
        matter,
        failed === undefined ? INTERRUPTED_FAILURE_TEXT : runFailureText(errorOf(failed.payload)),
      )
    out.push({ matter_id: matter.id, run_id, why: failed === undefined ? 'interrupted' : 'failed' })
  }
  return out
}
