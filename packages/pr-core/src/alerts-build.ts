/**
 * WP387（docs/103 v2 §3.3、R3、T1）：**你的浏览器替你建 / 导入 Google 提醒**——纯逻辑那一半。
 *
 * 服务端（`apps/server/src/pr-alerts/`）与模拟世界都调这里；这里没有时钟、没有 IO、没有浏览器：
 *
 * | 函数 | 干什么 |
 * |---|---|
 * | {@link alertLinesFromPlan} | 配置卡上确认过的清单 → 卡上的 N 行（已经挂上监控源的、重复的不列） |
 * | {@link alertChangeOf} | N 行 → 一张「改东西」卡的标题 / 正文 / `after`（一批一张，不是一条一张） |
 * | {@link approvedLines} | 卡同意之后真要做的那几行：只认**勾选**这一处改动，查询语句改不了、行加不进来 |
 * | {@link ingestAlertsReport} | 浏览器交回来的结果 → 新的监控源（`added_via: 'browser'`）、没建成的、要改成 RSS 的 |
 * | {@link splitExisting} | 读一遍已有的提醒 → 能导入的（RSS）/ 还在用邮箱的 / 已经在监控源里的 |
 *
 * 纪律：
 * - **只碰卡上那几条**：读回结果里卡外的行一律不认（不删、不改用户别的提醒是技能说明里的规矩，这里再兜一道）；
 * - **读回的必须是 RSS 链接**（`google.com/alerts/feeds/…`），不是就算没建成，绝不存一个邮箱投递的提醒；
 * - **没建成的明确列出来**，退回手动贴链接；不自动重试第二轮。
 */
import type {
  ExistingGoogleAlert,
  GoogleAlertChangeAfter,
  GoogleAlertLine,
  GoogleAlertOp,
  GoogleAlertReportLine,
  GoogleAlertsExistingView,
  GoogleAlertsJob,
  GoogleAlertsJobStatus,
  GoogleAlertsReport,
  GoogleAlertsStop,
  MonitorPlanItem,
  MonitorSource,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  GOOGLE_ALERT_CHANGE_MAX_LINES,
  GOOGLE_ALERT_SETTINGS_SENTENCE,
  GOOGLE_ALERTS_FEED_PREFIX,
  MONITOR_DEFAULT_EVERY_HOURS,
} from '@agentsws/contracts'

/* ── 查询语句怎么算「同一条」 ─────────────────────────────────────── */

/**
 * 把查询语句归一（判「账号里已经有同样的提醒」用）：大小写、弯引号、多余空格、`OR` 两边的空格都不算差别。
 * 词序与排除词算差别（`"Aventon" -job` 与 `"Aventon"` 是两条提醒）。
 */
export function normalizeAlertQuery(q: string): string {
  return q
    .replace(/[“”„«»]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase()
}

/** 是不是一条 Google 提醒的 RSS 链接（带不带 www 都认）。 */
export function isGoogleAlertsFeedUrl(url: string): boolean {
  const u = url.trim()
  if (u.startsWith(GOOGLE_ALERTS_FEED_PREFIX)) return u.length > GOOGLE_ALERTS_FEED_PREFIX.length
  const bare = GOOGLE_ALERTS_FEED_PREFIX.replace('://www.', '://')
  return u.startsWith(bare) && u.length > bare.length
}

/** 链接归一（带 www 的那种），比对「已经在监控源里」用。 */
function feedKey(url: string): string {
  return url.trim().replace('https://google.com/', 'https://www.google.com/')
}

/* ── 清单 → 卡 ─────────────────────────────────────────────────────── */

/**
 * 配置卡上确认过的清单 → 卡上的 N 行。
 *
 * 只列：勾着的、还没挂上监控源的；同一条查询语句只列一次；已经有监控源盯着同一条查询语句的不列。
 * 最多 {@link GOOGLE_ALERT_CHANGE_MAX_LINES} 行（再多分两批）。
 */
export function alertLinesFromPlan(
  items: readonly MonitorPlanItem[],
  sources: readonly MonitorSource[],
): GoogleAlertLine[] {
  const watched = new Set(
    sources.filter((s) => s.query !== undefined).map((s) => normalizeAlertQuery(s.query as string)),
  )
  const seen = new Set<string>()
  const out: GoogleAlertLine[] = []
  for (const it of items) {
    if (!it.selected || it.status !== 'planned' || it.source_id !== undefined) continue
    const key = normalizeAlertQuery(it.query)
    if (key === '' || watched.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `ga_${out.length + 1}`,
      op: 'create',
      query: it.query.trim(),
      language: it.language,
      region: it.region,
      label: it.label,
      group: it.group,
      ...(it.competitor === undefined ? {} : { competitor: it.competitor }),
      plan_item_id: it.id,
      selected: true,
    })
    if (out.length >= GOOGLE_ALERT_CHANGE_MAX_LINES) break
  }
  return out
}

/** 已有的、还在用邮箱投递的那几条 → 「改成 RSS」卡上的行。 */
export function toRssLines(
  email: readonly ExistingGoogleAlert[],
  plan: readonly MonitorPlanItem[] = [],
): GoogleAlertLine[] {
  const byQuery = new Map(plan.map((p) => [normalizeAlertQuery(p.query), p]))
  return email.slice(0, GOOGLE_ALERT_CHANGE_MAX_LINES).map((e, i) => {
    const p = byQuery.get(normalizeAlertQuery(e.query))
    return {
      id: `ga_${i + 1}`,
      op: 'to_rss' as const,
      query: e.query.trim(),
      language: e.language ?? p?.language ?? 'any',
      region: e.region ?? p?.region ?? 'any',
      label: p?.label ?? labelOfQuery(e.query),
      group: p?.group ?? 'own',
      ...(p?.competitor === undefined ? {} : { competitor: p.competitor }),
      ...(p === undefined ? {} : { plan_item_id: p.id }),
      selected: true,
    }
  })
}

/** 查询语句里拆一个人话名（`"Aventon" -job` → `Aventon`）。 */
export function labelOfQuery(q: string): string {
  const quoted = /"([^"]+)"/u.exec(q.replace(/[“”]/gu, '"'))
  const raw = quoted?.[1] ?? q.replace(/\s-\S+/gu, '').split(/\s+OR\s+/u)[0] ?? q
  return raw.trim().slice(0, 60) || q.trim().slice(0, 60)
}

/** 一张卡的标题 / 正文 / `after`。 */
export function alertChangeOf(
  op: GoogleAlertOp,
  lines: readonly GoogleAlertLine[],
): { title: string; summary: string; after: GoogleAlertChangeAfter } {
  const n = lines.length
  return op === 'create'
    ? {
        title: `要在你的 Google 账号里建 ${n} 条提醒`,
        summary: `确认后，你的浏览器会一条一条建好（${GOOGLE_ALERT_SETTINGS_SENTENCE}），建完把 RSS 链接读回来。不想建的先勾掉；只动这几条，不碰你别的提醒。`,
        after: { op, lines: lines.map((l) => ({ ...l })) },
      }
    : {
        title: `把 ${n} 条提醒的投递改成 RSS`,
        summary:
          '这几条提醒还在发邮件。确认后，你的浏览器把它们的投递改成 RSS、把链接读回来；查询语句不动，也不碰你别的提醒。',
        after: { op, lines: lines.map((l) => ({ ...l })) },
      }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * 卡同意之后真要做的那几行。
 *
 * 卡上**只有勾选**这一处能改：人改过的那一版（`edited`，卡面带回的 `approve_edited` 载荷）里，
 * 只看每一行（按 id 对回原来的行）的 `selected`；查询语句、语言、地区一律以原来那张卡为准，
 * 编出来的新行不认。勾掉的不做。
 */
export function approvedLines(after: unknown, edited?: unknown): GoogleAlertLine[] {
  const base =
    isRecord(after) && Array.isArray(after.lines) ? (after.lines as GoogleAlertLine[]) : []
  const editedAfter = isRecord(edited) && isRecord(edited.after) ? edited.after : undefined
  const picks = new Map<string, boolean>()
  if (editedAfter !== undefined && Array.isArray(editedAfter.lines))
    for (const l of editedAfter.lines)
      if (isRecord(l) && typeof l.id === 'string') picks.set(l.id, l.selected !== false)
  return base
    .filter((l) => (picks.has(l.id) ? picks.get(l.id) === true : l.selected !== false))
    .map((l) => ({ ...l, selected: true }))
}

/* ── 浏览器交回来的结果 ─────────────────────────────────────────────── */

/** 停下的那一句人话。 */
export function alertsStopSentence(stop: GoogleAlertsStop): string {
  switch (stop) {
    case 'not_signed_in':
      return '你的浏览器里 Google 还没登录'
    case 'captcha':
      return 'Google 要你做一次人机验证'
    case 'page_changed':
      return 'Google 提醒的页面和我认识的不一样了'
    case 'other':
      return '浏览器那边没走完'
    default:
      return ''
  }
}

export interface IngestInput {
  workspace_id: WorkspaceId
  job: GoogleAlertsJob
  report: GoogleAlertsReport
  /** 现有的监控源（同一条链接已经在了就挂上去，不重复存）。 */
  sources: readonly MonitorSource[]
  now: string
  newId(): string
  every_hours?: number
}

export interface IngestResult {
  /** 新存的监控源（`status: 'unchecked'`：调用方先拉一次再标 ok / failed）。 */
  sources: MonitorSource[]
  /** 配置卡上那一行挂上了哪条源。 */
  links: { plan_item_id: string; source_id: string }[]
  /** 读回了链接的行（新建 / 已有 / 改成 RSS）。 */
  done: { line: GoogleAlertLine; source_id: string; outcome: GoogleAlertReportLine['outcome'] }[]
  /** 没成的行与一句原因（退回手动贴链接）。 */
  failed: { line: GoogleAlertLine; reason: string }[]
  /** 账号里已经有、但投递还是邮箱的行（另出一张「改成 RSS」的卡）。 */
  email: GoogleAlertLine[]
  status: GoogleAlertsJobStatus
  /** 每一行的结局（存进这一趟的记录）。 */
  results: GoogleAlertReportLine[]
  summary: string
}

/**
 * 浏览器交回来的结果 → 监控源 + 没建成的清单。
 *
 * - 只认这一趟卡上的行（按 id）；卡外的行、卡上没交代的行都不当成建好了；
 * - `created` / `existing` / `switched` 必须带一条 Google 提醒的 RSS 链接，否则算没成（「读回来的不是 RSS 链接」）；
 * - 同一条链接已经在监控源里：挂上那一条，不重复存；
 * - 停下了（没登录 / 验证码 / 页面认不出）：交代过结果的照常保存，其余列成没建成。
 */
export function ingestAlertsReport(input: IngestInput): IngestResult {
  const { job, report } = input
  const byId = new Map(report.lines.map((l) => [l.id, l]))
  const known = new Map(input.sources.map((s) => [feedKey(s.url), s]))
  const stopWhy = alertsStopSentence(report.stop)
  const out: IngestResult = {
    sources: [],
    links: [],
    done: [],
    failed: [],
    email: [],
    status: 'done',
    results: [],
    summary: '',
  }
  for (const line of job.lines) {
    const r = byId.get(line.id)
    const outcome = r?.outcome ?? 'not_attempted'
    if (outcome === 'existing_email') {
      out.email.push(line)
      out.results.push({ id: line.id, outcome })
      continue
    }
    if (outcome === 'created' || outcome === 'existing' || outcome === 'switched') {
      const url = r?.feed_url?.trim() ?? ''
      if (!isGoogleAlertsFeedUrl(url)) {
        const reason = url === '' ? '没读回 RSS 链接' : '读回来的不是 RSS 链接'
        out.failed.push({ line, reason })
        out.results.push({ id: line.id, outcome: 'failed', reason })
        continue
      }
      const had = known.get(feedKey(url))
      const source_id = had?.id ?? `ms_${input.newId()}`
      if (had === undefined) {
        const row: MonitorSource = {
          id: source_id,
          workspace_id: input.workspace_id,
          kind: 'google_alerts',
          url: feedKey(url),
          group: line.group,
          label: line.label,
          query: line.query,
          ...(line.language === 'any' ? {} : { language: line.language }),
          ...(line.region === 'any' ? {} : { region: line.region }),
          ...(line.competitor === undefined ? {} : { competitor: line.competitor }),
          every_hours: input.every_hours ?? MONITOR_DEFAULT_EVERY_HOURS,
          status: 'unchecked',
          added_via: 'browser',
          ...(line.plan_item_id === undefined ? {} : { plan_item_id: line.plan_item_id }),
          created_at: input.now,
        }
        out.sources.push(row)
        known.set(feedKey(url), row)
      }
      if (line.plan_item_id !== undefined)
        out.links.push({ plan_item_id: line.plan_item_id, source_id })
      out.done.push({ line, source_id, outcome })
      out.results.push({ id: line.id, outcome, feed_url: feedKey(url) })
      continue
    }
    const reason =
      outcome === 'failed'
        ? (r?.reason?.trim() || '没建成').slice(0, 120)
        : stopWhy === ''
          ? '没轮到'
          : `没轮到（${stopWhy}）`
    out.failed.push({ line, reason })
    out.results.push({
      id: line.id,
      outcome: outcome === 'failed' ? 'failed' : 'not_attempted',
      reason,
    })
  }
  const n = job.lines.length
  out.status =
    out.failed.length === 0
      ? 'done'
      : out.done.length === 0 && out.email.length === 0
        ? 'failed'
        : 'partial'
  out.summary = alertsSummary(job.op, out, n, report.stop)
  return out
}

/** 一趟的收尾那一句（建好几条、几条另出卡、哪几条没成退回手动）。 */
export function alertsSummary(
  op: GoogleAlertOp,
  r: Pick<IngestResult, 'done' | 'email' | 'failed'>,
  n: number,
  stop: GoogleAlertsStop,
): string {
  const parts: string[] = []
  const verb = op === 'create' ? '建好' : '改成 RSS'
  if (r.done.length > 0) parts.push(`${verb} ${r.done.length} 条，RSS 链接已读回，正在先拉一次`)
  if (r.email.length > 0)
    parts.push(`${r.email.length} 条你账号里本来就有、但还在发邮件：另出一张「改成 RSS」的卡`)
  if (r.failed.length > 0) {
    const names = r.failed.map((f) => f.line.label).slice(0, 6)
    const more = r.failed.length > names.length ? ` 等 ${r.failed.length} 条` : ''
    const why = alertsStopSentence(stop)
    parts.push(
      `${names.join('、')}${more}没${op === 'create' ? '建' : '改'}成${why === '' ? '' : `（${why}）`}：到配置卡上手动贴 RSS 链接（卡上有教程）`,
    )
  }
  return parts.length === 0 ? `这 ${n} 条一条都没交代结果` : `${parts.join('；')}。`
}

/* ── 读一遍已有的 ───────────────────────────────────────────────────── */

/** 读一遍已有的提醒 → 能导入的 / 还在用邮箱的 / 已经在监控源里的。 */
export function splitExisting(
  existing: readonly ExistingGoogleAlert[],
  sources: readonly MonitorSource[],
  read_at?: string,
): GoogleAlertsExistingView {
  const have = new Set(sources.map((s) => feedKey(s.url)))
  const haveQuery = new Set(
    sources.filter((s) => s.query !== undefined).map((s) => normalizeAlertQuery(s.query as string)),
  )
  const view: GoogleAlertsExistingView = {
    ...(read_at === undefined ? {} : { read_at }),
    importable: [],
    email: [],
    already: 0,
  }
  const seen = new Set<string>()
  for (const e of existing) {
    const key = normalizeAlertQuery(e.query)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    if (e.delivery === 'rss' && e.feed_url !== undefined && isGoogleAlertsFeedUrl(e.feed_url)) {
      if (have.has(feedKey(e.feed_url))) view.already += 1
      else view.importable.push({ ...e, feed_url: feedKey(e.feed_url) })
    } else if (e.delivery === 'email') {
      if (haveQuery.has(key)) view.already += 1
      else view.email.push(e)
    }
  }
  return view
}

/* ── 交给浏览器那一趟的话 ───────────────────────────────────────────── */

/** 建 / 改那一趟的任务说明（事项里那段话；技能说明里有每一步怎么认页面）。 */
export function buildAlertsBrief(job: Pick<GoogleAlertsJob, 'change_id' | 'op' | 'lines'>): string {
  const head =
    job.op === 'create'
      ? `用户刚在卡上同意了：在他的 Google 账号里建下面 ${job.lines.length} 条提醒。`
      : `用户刚在卡上同意了：把下面 ${job.lines.length} 条提醒的投递从邮箱改成 RSS。`
  const rows = job.lines.map(
    (l) => `- ${l.id}：查询「${l.query}」 · 语言 ${l.language} · 地区 ${l.region}`,
  )
  return [
    head,
    '先读技能「google-alerts」，照里面的步骤在用户自己的浏览器里做；一条一条来，中间停一两秒，不要并发。',
    ...rows,
    `只碰这几条：别的提醒不删、不改。做完（或者停下）调一次 report_google_alerts，change_id 填 ${job.change_id}，每一行按 id 交代结局。`,
    '遇到登录、验证码、人机验证就用 bsk_assist 的 request-help 请用户处理，处理完接着做；页面认不出就停下照实交代，不要硬闯，也不要自动再来一轮。',
  ].join('\n')
}

/** 只读一遍已有提醒那一趟的任务说明。 */
export function readExistingBrief(): string {
  return [
    '读一遍用户 Google 账号里已有的提醒（只看，不点任何创建、修改、删除）。',
    '先读技能「google-alerts」里「读已有的提醒」那一段，照着认每一条的查询语句和投递方式；投递是 RSS 的把链接读出来。',
    '读完调一次 report_google_alerts（不填 change_id），把读到的放进 existing；遇到登录、验证码就请用户处理。',
  ].join('\n')
}
