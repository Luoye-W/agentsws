/**
 * WP331：stub 运行时的**报告剧本**（模拟 / 演示 / 场景测试用；真模型不走这里）。
 *
 * 两段：
 * 1. **到点出报告**：官方定时到点那次运行（外框 `[SCHEDULE REMINDER…`），提示词里在要一份报告、工具面里有
 *    `publish_report`：按提示词里编了号的几项（①② / 1. 2.）逐项认要什么数据 → 先巡查一次 → 调查数据工具 →
 *    按**提示词里的顺序**拼一份 Markdown → 发布。
 * 2. **改格式**：「把第三节放最前面」→ 列出这件事里的定时 → 把那条提示词里编号的几项挪位、重新编号 →
 *    `schedule_update` 改提示词。下一次到点就按新顺序出。
 *
 * 只认这几种说法；认不出就不走（stub 其余路径一个字节不变）。
 */
import { QUERY_SENT_RECORDS_TOOL, QUERY_WATCH_ITEMS_TOOL, RUN_WATCH_NOW_TOOL } from './report.js'

export type ReportNeed = 'own_counts' | 'voc_ugc' | 'external' | 'sent' | 'other'

export interface ReportSection {
  text: string
  need: ReportNeed
}

export interface ReportPlan {
  prompt: string
  /** 报告叫什么（「r/xxx 周报」）；也是系列名。 */
  name: string
  sections: ReportSection[]
  /** 要调的取数工具（按顺序；`need` 标这一步的数给哪一节用）。 */
  calls: { tool: string; input: Record<string, unknown>; need?: ReportNeed }[]
}

/* ── 编号的几项 ─────────────────────────────────────────────────────────── */

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩'
const ZH_NUM: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
}

/** 提示词 → 开头那段 + 编号的几项（① 或 1. / 1、）。不到两项回 `undefined`。 */
export function splitNumbered(
  prompt: string,
): { head: string; style: 'circled' | 'arabic'; items: string[] } | undefined {
  const circled = [...prompt.matchAll(/[①-⑩]/g)]
  const arabic = [...prompt.matchAll(/(?:^|[\s：:，,；;])(\d{1,2})[.、)）]\s*/g)]
  const style = circled.length >= 2 ? 'circled' : arabic.length >= 2 ? 'arabic' : undefined
  if (style === undefined) return undefined
  const marks =
    style === 'circled'
      ? circled.map((m) => ({ at: m.index ?? 0, len: 1 }))
      : arabic.map((m) => {
          const lead = m[0].length - m[0].trimStart().length
          const sep = /^[：:，,；;]/.test(m[0]) ? 1 : 0
          const at = (m.index ?? 0) + Math.max(lead, sep)
          return { at, len: (m.index ?? 0) + m[0].length - at }
        })
  const head = prompt.slice(0, marks[0]?.at ?? 0)
  const items = marks.map((m, i) =>
    prompt
      .slice(m.at + m.len, marks[i + 1]?.at ?? prompt.length)
      .trim()
      .replace(/[，,；;。]+$/u, '')
      .trim(),
  )
  return { head, style, items }
}

/** 把第 `from` 项（从 0 数）挪到 `to`，重新编号。认不出编号回 `undefined`。 */
export function reorderNumbered(prompt: string, from: number, to: number): string | undefined {
  const s = splitNumbered(prompt)
  if (s === undefined || from < 0 || from >= s.items.length) return undefined
  const items = [...s.items]
  const [moved] = items.splice(from, 1)
  items.splice(Math.min(Math.max(to, 0), items.length), 0, moved as string)
  const mark = (i: number) => (s.style === 'circled' ? (CIRCLED[i] ?? `${i + 1}.`) : `${i + 1}. `)
  return `${s.head}${items.map((t, i) => `${mark(i)}${t}`).join(' ')}`
}

/** 「把第三节放最前面」→ 第几项挪到哪（从 0 数）。 */
export function reorderAsk(text: string): { from: number; to: 'first' | 'last' } | undefined {
  if (text.includes('[SCHEDULE REMINDER')) return undefined
  const m = /第\s*([一二三四五六七八九十]|\d{1,2})\s*(?:节|部分|点|项|条|段)/.exec(text)
  if (m?.[1] === undefined) return undefined
  const n = ZH_NUM[m[1]] ?? Number.parseInt(m[1], 10)
  const tail = text.slice((m.index ?? 0) + m[0].length)
  const to = /最前|开头|第一个?|首位|最上|前面/.test(tail)
    ? 'first'
    : /最后|末尾|最下/.test(tail)
      ? 'last'
      : undefined
  if (to === undefined || !Number.isInteger(n) || n < 1) return undefined
  return { from: n - 1, to }
}

/* ── 到点出报告 ─────────────────────────────────────────────────────────── */

/** 官方外框里的提示词（不是到点那次运行回 `undefined`）。 */
export function reminderPromptOf(text: string): string | undefined {
  if (!text.includes('[SCHEDULE REMINDER')) return undefined
  const batch = /reminders_json:\s*(\[.*\])/.exec(text)?.[1]
  if (batch !== undefined) {
    try {
      const list = JSON.parse(batch) as { reminder_prompt?: unknown }[]
      const p = list[0]?.reminder_prompt
      if (typeof p === 'string') return p
    } catch {
      // 落到下面一种写法
    }
  }
  const one = /reminder_prompt_json:\s*(".*")/.exec(text)?.[1]
  if (one === undefined) return undefined
  try {
    const p = JSON.parse(one) as unknown
    return typeof p === 'string' ? p : undefined
  } catch {
    return undefined
  }
}

const WANTS_REPORT = /报告|周报|日报|月报|汇总|report/i
const WEEKDAY: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 }

function needOf(text: string): ReportNeed {
  if (/外部|舆情|话题/.test(text)) return 'external'
  if (/回复|回帖|我们.{0,6}(发|回)/.test(text)) return 'sent'
  if (/VOC|UGC/i.test(text)) return 'voc_ugc'
  if (/帖子|评论|发帖量/.test(text)) return 'own_counts'
  return 'other'
}

/** 到点那次运行：要出报告、工具面里有发布，就排出要调的取数工具。 */
export function reportPlan(allow: readonly string[], text: string): ReportPlan | undefined {
  const prompt = reminderPromptOf(text)
  if (prompt === undefined || !WANTS_REPORT.test(prompt)) return undefined
  const split = splitNumbered(prompt)
  const sections: ReportSection[] = (split?.items ?? [prompt]).map((t) => ({
    text: t,
    need: needOf(t),
  }))
  const range = /周([日天一二三四五六])\s*(?:到|至|—|-|~)\s*周/.exec(prompt)?.[1]
  const period = /上周/.test(prompt)
    ? 'last_week'
    : /月报|本月|每月/.test(prompt)
      ? 'this_month'
      : /日报|今天|每天/.test(prompt)
        ? 'today'
        : /周报|本周|每周/.test(prompt)
          ? 'this_week'
          : 'last_7_days'
  const when = {
    period,
    ...(range === undefined ? {} : { week_start: WEEKDAY[range] }),
  }
  const reddit = /reddit|(^|[\s（(])r\//i.test(prompt)
  const platform = reddit ? { platform: 'reddit' } : {}
  const named = /(?:出|做|写|发)一?份\s*(.+?(?:周报|日报|月报|报告|汇总))/.exec(prompt)?.[1]
  const name = (named ?? '报告').trim()
  const needs = new Set(sections.map((s) => s.need))
  const watch = needs.has('own_counts') || needs.has('voc_ugc') || needs.has('external')
  const calls: ReportPlan['calls'] = []
  if (watch && allow.includes(RUN_WATCH_NOW_TOOL))
    calls.push({ tool: RUN_WATCH_NOW_TOOL, input: { ...platform } })
  if (allow.includes(QUERY_WATCH_ITEMS_TOOL)) {
    if (needs.has('own_counts'))
      calls.push({
        tool: QUERY_WATCH_ITEMS_TOOL,
        input: { ...when, ...platform, scope: 'own', limit: 1 },
        need: 'own_counts',
      })
    if (needs.has('voc_ugc'))
      calls.push({
        tool: QUERY_WATCH_ITEMS_TOOL,
        input: { ...when, ...platform, scope: 'own', signal: 'any', limit: 30 },
        need: 'voc_ugc',
      })
    if (needs.has('external'))
      calls.push({
        tool: QUERY_WATCH_ITEMS_TOOL,
        input: { ...when, ...platform, scope: 'external', group_by: 'topic', limit: 5 },
        need: 'external',
      })
  }
  if (needs.has('sent') && allow.includes(QUERY_SENT_RECORDS_TOOL))
    calls.push({
      tool: QUERY_SENT_RECORDS_TOOL,
      input: { ...when, ...(reddit ? { channel: 'reddit' } : {}), actions: ['reply', 'comment'] },
      need: 'sent',
    })
  return { prompt, name, sections, calls }
}

/* ── 拼一份（stub 只排版：数与原话都来自工具回的那几份） ───────────────────── */

type Rec = Record<string, unknown>
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' ? (v as Rec) : {})
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
const list = (v: unknown): Rec[] => (Array.isArray(v) ? v.map(rec) : [])

const ASSESS_ZH: Record<string, string> = {
  follow_up: '需跟进',
  no_action: '日常讨论，无需处理',
  low_relevance: '相关度不高，不建议回复',
}

function quoteLines(q: Rec): string[] {
  const text = str(q.text)
  const meta = [
    str(q.author) === undefined ? undefined : `u/${str(q.author)}`,
    str(q.place),
    str(q.at)?.slice(0, 10),
    str(q.url),
  ].filter((x): x is string => x !== undefined)
  return [`> ${text ?? '（原文已删除）'}`, '', meta.join(' · '), '']
}

function sectionBody(need: ReportNeed, data: unknown): string[] {
  const d = rec(data)
  if (need === 'own_counts') {
    const own = rec(rec(d.totals).own)
    return [`- 帖子 **${num(own.posts)}** · 评论 **${num(own.comments)}**`, '']
  }
  if (need === 'voc_ugc') {
    const items = list(d.items)
    const out: string[] = []
    for (const [label, key] of [
      ['VOC', 'voc'],
      ['UGC', 'ugc'],
    ] as const) {
      const hits = items.filter((q) => q[key] === true)
      out.push(`### ${label}（${hits.length}）`, '')
      if (hits.length === 0) out.push('这段时间没有。', '')
      for (const q of hits) out.push(...quoteLines(q))
    }
    return out
  }
  if (need === 'external') {
    const groups = list(d.groups)
    if (groups.length === 0) return ['这段时间没有。', '']
    return groups.flatMap((g, i) => [
      `### ${i + 1}. ${str(g.topic) ?? '其他'}（post × ${num(g.posts)} / comment × ${num(g.comments)}）`,
      '',
      `评估：${ASSESS_ZH[str(g.assessment) ?? ''] ?? str(g.assessment) ?? ''}`,
      '',
      ...list(g.items).flatMap(quoteLines),
      ...(num(g.more) > 0 ? [`另有 ${num(g.more)} 条未列出。`, ''] : []),
    ])
  }
  if (need === 'sent') {
    const t = rec(d.totals)
    const rows = list(d.records)
    return [
      `- 回复帖子 **${num(t.replies_to_posts)}** · 回复评论 **${num(t.replies_to_comments)}**`,
      '',
      ...rows.map((r, i) =>
        [
          `${i + 1}. ${str(r.at)?.slice(0, 10) ?? ''}`,
          str(r.thread_title),
          str(r.link) ?? str(r.thread_url),
        ]
          .filter((x): x is string => x !== undefined && x !== '')
          .join(' · '),
      ),
      ...(rows.length > 0 ? [''] : ['这段时间没有。', '']),
    ]
  }
  return ['（没有对应的数据工具，这一节先空着。）', '']
}

/** 工具回的数据 → 一份报告（标题、周期、正文按提示词里的顺序）。 */
export function composeStubReport(
  plan: ReportPlan,
  results: ReadonlyMap<ReportNeed, unknown>,
): { title: string; series: string; period: string; period_start?: string; markdown: string } {
  const first = [...results.values()].map((v) => rec(rec(v).window)).find((w) => str(w.label))
  const period = str(first?.label) ?? ''
  const start = str(first?.start_date)
  const title = period === '' ? plan.name : `${plan.name}（${period}）`
  const out: string[] = [`# ${title}`, '']
  plan.sections.forEach((s, i) => {
    out.push(`## ${i + 1}. ${s.text}`, '')
    out.push(...sectionBody(s.need, results.get(s.need)))
  })
  return {
    title,
    series: plan.name,
    period,
    ...(start === undefined ? {} : { period_start: start }),
    markdown: `${out
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trimEnd()}\n`,
  }
}

/* ── WP411（#13）：按时间窗回补 ───────────────────────────────────────── */

const pad = (n: number): string => String(n).padStart(2, '0')

/**
 * 「把 10-11 到 10-16 的外部补一下 / 补搜 10/11–10/16」→ 回补哪一段（本地日期，年份按现在）。
 * 工具面里没有 `run_watch_now`、话里没在要补、认不出两个日期 → `undefined`（stub 其余路径一个字节不变）。
 */
export function backfillAsk(
  allow: readonly string[],
  text: string,
  nowIso: string,
): { since: string; until: string } | undefined {
  if (!allow.includes(RUN_WATCH_NOW_TOOL) || !/补/u.test(text)) return undefined
  const dates = [...text.matchAll(/(?:(\d{4})[-/.年])?(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?/gu)]
  if (dates.length < 2) return undefined
  const year = new Date(nowIso).getUTCFullYear()
  const iso = (m: RegExpMatchArray): string | undefined => {
    const mo = Number(m[2])
    const d = Number(m[3])
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return undefined
    return `${m[1] ?? year}-${pad(mo)}-${pad(d)}`
  }
  const since = dates[0] === undefined ? undefined : iso(dates[0])
  const until = dates[1] === undefined ? undefined : iso(dates[1])
  return since === undefined || until === undefined ? undefined : { since, until }
}

/** 回补那两步（先看计划、再照做）的结果 → 一段人话（数都来自工具回的）。 */
export function backfillAnswer(preview: unknown, done: unknown): string {
  const why = (preview as { message?: string } | undefined)?.message ?? '这一步没走通'
  const p = (preview ?? {}) as { ok?: boolean; message?: string; can?: string; say?: string }
  if (p.ok !== true)
    return `${why.startsWith('补不了') ? why : `补不了：${why}`}${p.can === undefined ? '' : `\n能做的：${p.can}`}`
  const d = (done ?? {}) as {
    ok?: boolean
    message?: string
    can?: string
    parts?: {
      part?: string
      status?: string
      fresh?: number
      filtered?: number
      message?: string
    }[]
  }
  const head = p.say ?? ''
  if (d.ok !== true)
    return `${head}\n没补成：${d.message ?? '这一步没走通'}${d.can === undefined ? '' : `\n能做的：${d.can}`}`
  const ZH: Record<string, string> = {
    own_sub: '自家版块',
    watch_sub: '重点版块',
    external: '外部社区',
    inbox: '收件箱',
  }
  const lines = (d.parts ?? []).map(
    (x) =>
      `- ${ZH[x.part ?? ''] ?? x.part}：${x.status === 'ok' ? `新补进 ${x.fresh ?? 0} 条` : `没补成（${x.message ?? x.status}）`}${(x.filtered ?? 0) > 0 ? `，丢掉不相关的 ${x.filtered} 条` : ''}`,
  )
  return [head, '补完了：', ...lines].join('\n')
}
