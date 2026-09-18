/**
 * WP95（36 §11，`docs/upstream/sidebar-compare.md` #12 / #15）：
 * **一次运行的浏览器侧汇总**——第三栏「运行中的浏览器」面板读的那一份。
 *
 * 官方的浏览器面板是"一个 tab 一个独立浏览会话，载体是 iframe"。那个**体**我们不借
 * （spike ④：它的 iframe 直连目标 URL，与壳 `default-src 'self'` 撞死），
 * 借的是那个**形**：右栏里要看得见"它现在在哪家站上、刚才去了哪、被拦在哪、是不是在等我"。
 *
 * 这个文件只做一件事：**把事件日志折成那几格**。
 *
 * | 格 | 从哪条事件来 |
 * |---|---|
 * | 哪种执行器 | `tool.call` 的工具名（带 `mcp__playwright-mcp__` 前缀 = 官方 provider；六个 `browser_*` 裸名 = WP92 BrowserSkill） |
 * | 当前域 / 最近一次导航 | `tool.call` 里带 URL 的那几种（两种浏览器各有各的入参位置，判定复用 `@agentsws/dsh-adapter` 那两个纯函数） |
 * | 最近一次拒绝 | `tool.result{status:'blocked'}`，按 `call_id` 认回是哪个工具 |
 * | 等人接管 | `progress{step:'browser_handoff'}`（WP92 的 `browser_assist{request-help}` 放行时记的那一条） |
 * | 还在不在跑 | 有没有 `run.completed` / `run.failed` / `run.cancelled` |
 *
 * **不存第二份状态**：这是纯投影，所以运行结束之后照样算得出来——
 * 官方那一侧"会话一销毁摘要就没了"的毛病（`sidebar-compare` §4 第 1 条）我们不学。
 *
 * **只给域名不给整条 URL**：路径里常带订单号、邮箱、一次性 token（21 敏感级）。
 * 人要知道的是"它在 myshopify 后台"，不是那串参数。
 */
import type { EventEnvelope, Iso8601, RunBrowserView } from '@agentsws/contracts'
import {
  browserSkillNavigationUrl,
  browserSkillToolName,
  browserToolName,
} from '@agentsws/dsh-adapter'

/** 运行结束的三条（有任何一条 = 不在跑了）。 */
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled'])

/**
 * 官方 provider 那一种里会打开新地址的两个工具。
 *
 * 与 `dsh-adapter/src/browser.ts` 的 `navigationUrlOf` 同一张表——那一份没有导出
 * （它是门禁的内部件），这里照着写一遍而不是去改那个包：这是**只读投影**，
 * 不该为了省四行而在门禁那一侧开一个导出面。两边要是哪天不一致，
 * 结果只是右栏少显示一次导航，不会影响任何一条拦截。
 */
function playwrightNavigationUrl(short: string, args: Record<string, unknown>): string | undefined {
  if (short === 'browser_navigate') return typeof args.url === 'string' ? args.url : ''
  if (short === 'browser_tabs' && args.action === 'new')
    return typeof args.url === 'string' ? args.url : undefined
  return undefined
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/** `https://x.myshopify.com/admin/orders/1` → `x.myshopify.com`（解析不了就不给）。 */
function hostOf(url: string): string | undefined {
  if (url === '') return undefined
  try {
    return new URL(url).host
  } catch {
    return undefined
  }
}

/**
 * 把一次运行的事件折成第三栏那一份。
 *
 * `events` 按时间**从旧到新**（事件日志的 ulid 自带这个序）；乱序也不会炸，
 * 只是"最近一次"可能指到前面那一条。
 */
export function summarizeRunBrowser(
  run_id: string,
  events: Iterable<EventEnvelope>,
): RunBrowserView {
  const view: RunBrowserView = {
    run_id,
    executor: 'none',
    running: true,
    navigations: 0,
    blocked: 0,
  }
  /** `call_id` → 工具名（`tool.result` 只带 call_id，要认回是哪个工具）。 */
  const calls = new Map<string, string>()
  let handoff: { at: Iso8601; note?: string } | undefined

  for (const e of events) {
    if (TERMINAL.has(e.type)) {
      view.running = false
      continue
    }
    if (e.type === 'progress') {
      const p = asRecord(e.payload)
      if (p.step === 'browser_handoff') {
        const note = typeof p.note === 'string' ? p.note : undefined
        handoff = { at: e.at, ...(note === undefined ? {} : { note }) }
      }
      continue
    }
    if (e.type === 'tool.call') {
      const p = asRecord(e.payload)
      const tool = typeof p.tool === 'string' ? p.tool : ''
      const playwright = browserToolName(tool)
      const skill = browserSkillToolName(tool)
      if (playwright === undefined && skill === undefined) continue
      if (typeof p.call_id === 'string') calls.set(p.call_id, tool)
      view.executor = playwright === undefined ? 'browserskill' : 'playwright-mcp'
      // 又动手了 = 不再是"等我接管"那个状态（人接完管，运行会接着往下跑）
      handoff = undefined
      const args = asRecord(p.input)
      const url =
        playwright === undefined
          ? browserSkillNavigationUrl(skill as string, args)
          : playwrightNavigationUrl(playwright, args)
      if (url === undefined) continue
      view.navigations += 1
      const host = hostOf(url)
      if (host === undefined) continue
      view.current_host = host
      view.last_navigation = { at: e.at, host, tool }
      continue
    }
    if (e.type === 'tool.result') {
      const p = asRecord(e.payload)
      if (p.status !== 'blocked') continue
      const tool = typeof p.call_id === 'string' ? calls.get(p.call_id) : undefined
      // 不是浏览器工具的拒绝（改价越额、发布主题…）不进这个面板
      if (tool === undefined) continue
      view.blocked += 1
      view.last_blocked = {
        at: e.at,
        tool,
        reason: typeof p.reason === 'string' ? p.reason : 'blocked',
      }
    }
  }

  // 跑完了就不会再有人来接管——那时候还挂着"等你接管"只会让人白点一次
  if (handoff !== undefined && view.running) view.awaiting_handoff = handoff
  return view
}

/** 读事件的最小面（与 `GatewayDeps.eventLog` 同形，这里只要 `read`）。 */
export interface RunEventReader {
  read(filter: {
    workspace_id: string
    run_id?: string
    limit?: number
  }): AsyncIterable<EventEnvelope>
}

/**
 * 一次运行最多折多少条事件。
 *
 * 一次建站运行的事件几千条是常态（每个 `text.delta` 都是一条）。第三栏只要
 * 那五格，读到上限就停——这条上限的作用是"面板永远在一瞬间打开"，
 * 不是"数得准"（数不准的只有计数那两格，而且只会少不会多）。
 */
export const RUN_BROWSER_EVENT_LIMIT = 2000

export async function readRunBrowser(
  reader: RunEventReader,
  workspace_id: string,
  run_id: string,
): Promise<RunBrowserView> {
  const events: EventEnvelope[] = []
  for await (const e of reader.read({ workspace_id, run_id, limit: RUN_BROWSER_EVENT_LIMIT }))
    events.push(e)
  return summarizeRunBrowser(run_id, events)
}
