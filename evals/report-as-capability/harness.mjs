/**
 * WP331（决策 691）：「一句话配出周报、再一句话改格式」的评测台——**一份用例，两个跑法**：
 *
 * - stub 运行时（不花钱、确定性）：`apps/server/test/wp331-report-scenario.test.ts`（vitest）；
 * - 真模型（DeepSeek 等，经 dsh 运行时）：`scripts/eval-report-capability.mjs --live`。
 *
 * 用例格式沿用 `evals/README.md`：`state`（替身数据：巡查条目、发出记录、当前时刻、职责）+ `turns`（说一句 /
 * 到点）+ 每一轮的 `expect`。这里只做三件事：起一个临时数据目录的服务进程、按轮次驱动（说话走 HTTP、到点走调度器
 * `runNow`）、按 `expect` 打分。打分只看**结果**（建了什么定时、发了什么报告、报告里各节的顺序与链接）和用到的工具，
 * 不看模型怎么措辞。
 *
 * 纯 JS（`.mjs`）：vitest 与 node 脚本都能直接导入；`createServer` 由调用方给（测试用源码，脚本用构建产物）。
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const AUTOMATION_HANDLER = 'automation.reminder'
const TERMINAL = new Set(['run.completed', 'run.failed', 'run.cancelled'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 用例里的巡查替身 → 服务端的 `WatchSource`。 */
export function watchSourceOf(watch) {
  return {
    platform: watch.platform,
    configured: () => true,
    ownPlaces: () => watch.own_places,
    items: () => watch.items,
    sweeps: () => watch.sweeps ?? [],
  }
}

/**
 * 起服务进程。`serverOptions` 给真模型那一档用（dsh 运行时等）；`configureModel(call)` 在起好之后配模型。
 * 回 `{ server, call, close, tmp, person, assignment }`。
 */
export async function bootCase(
  kase,
  { createServer, serverOptions = {}, env = {}, configureModel },
) {
  const tmp = mkdtempSync(join(tmpdir(), 'agentsws-eval-report-'))
  const dataDir = join(tmp, 'data')
  mkdirSync(dataDir)
  let t = Date.parse(kase.state.now)
  const clock = { now: () => new Date(t).toISOString() }
  const server = await createServer({
    dbDir: dataDir,
    quiet: true,
    clock,
    env: {
      // 这一次临时数据目录的本机加密库钥匙：现生成、只在这个进程里、跑完随目录删掉
      AGENTSWS_SECRETS_KEY: randomBytes(32).toString('hex'),
      AGENTSWS_OWNER_EMAIL: 'eval@example.test',
      // 云与连接器都指到一个没人听的本机端口：评测一个字节都不出网（模型除外）
      AGENTSWS_CLOUD_BASE_URL: 'http://127.0.0.1:9',
      AGENTSWS_CONNECT_URL: 'http://127.0.0.1:9',
      AGENTSWS_CONTENT_UPDATES: 'off',
      AGENTSWS_APP_DATA_DIR: tmp,
      ...env,
    },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    watchSource: () => watchSourceOf(kase.state.watch),
    ...serverOptions,
  })
  const ws = server.bootstrap.workspace.id
  const assignment = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: ws,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
    role_id: kase.state.role_id,
  })
  const call = async (method, path, body, asg = assignment.id) => {
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': asg,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const json = await res.json().catch(() => ({}))
    return { status: res.status, ...json }
  }
  if (configureModel !== undefined) await configureModel(call, server)
  for (const r of kase.state.sent ?? []) server.outbound.record(ws, r)
  return {
    server,
    call,
    assignment,
    tmp,
    ws,
    setNow: (iso) => {
      t = Date.parse(iso)
    },
    close: async () => {
      await server.close().catch(() => undefined)
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}

const events = (ctx) => ctx.server.kernel.eventLog.readSync({ workspace_id: ctx.ws })

/** 等这一轮起的运行都跑完（没起运行的等 `graceMs` 就算完）。 */
async function settle(ctx, mark, { timeoutMs, graceMs = 3000 }) {
  const start = Date.now()
  for (;;) {
    const fresh = events(ctx).slice(mark)
    const started = new Set(
      fresh.filter((e) => e.type === 'run.started').map((e) => e.correlation?.run_id),
    )
    const ended = new Set(
      fresh.filter((e) => TERMINAL.has(e.type)).map((e) => e.correlation?.run_id),
    )
    const active = new Set((ctx.server.runtime?.activeRuns() ?? []).map((r) => r.run_id))
    const open = [...started].filter((id) => !ended.has(id) && active.has(id))
    if (
      started.size > 0 &&
      open.length === 0 &&
      [...started].every((id) => ended.has(id) || !active.has(id))
    )
      return
    if (started.size === 0 && Date.now() - start > graceMs) return
    if (Date.now() - start > timeoutMs) throw new Error(`等运行跑完超时（${timeoutMs / 1000} 秒）`)
    await sleep(150)
  }
}

const automationTasks = (ctx) =>
  ctx.server.schedule.scheduler
    .list({ workspace_id: ctx.ws })
    .filter((t) => t.handler === AUTOMATION_HANDLER && t.state !== 'cancelled')

async function reports(ctx) {
  const items = await ctx.server.approvals.queue({
    workspace_id: ctx.ws,
    person_id: ctx.server.bootstrap.person.id,
    lane: 'mine',
    kind: 'weekly_review',
    state: ['pending', 'in_review', 'auto_approved', 'approved', 'superseded', 'expired'],
  })
  return items
    .filter((i) => i.payload?.kind === 'report')
    .sort((a, b) => String(a.updated_at).localeCompare(String(b.updated_at)))
}

/** 会往外发的周期任务先出卡（现有规则）：评测里替用户点「批」，并记一笔。 */
async function approvePendingSchedules(ctx, note) {
  for (const task of automationTasks(ctx)) {
    if (task.params?.awaiting_approval !== true || typeof task.approval !== 'string') continue
    const res = await ctx.call('POST', `/v1/approvals/${task.approval}/decide`, {
      action: 'approve',
    })
    note.push(`定时「${task.title}」先出了确认卡，评测替用户点了批（HTTP ${res.status}）`)
  }
}

/* ── 打分 ──────────────────────────────────────────────────────────────── */

/** 报告正文 → 各节（按节标题认是哪一节；认法见用例的 `sections`，按 外部 → VOC → 回复 → 数据 的先后认）。 */
export function sectionsOf(markdown, markers) {
  const lines = markdown.split('\n')
  const heads = []
  lines.forEach((line, i) => {
    const m = /^(#{1,6})\s+(.*)$/.exec(line)
    if (m !== null) heads.push({ i, level: m[1].length, text: m[2] })
  })
  const below = heads.filter((h) => h.level > 1)
  const level = below.length === 0 ? 1 : Math.min(...below.map((h) => h.level))
  const tops = heads.filter((h) => h.level === level)
  const order = []
  const bodies = {}
  tops.forEach((h, k) => {
    const id = Object.keys(markers).find((key) => new RegExp(markers[key], 'i').test(h.text))
    const end = tops[k + 1]?.i ?? lines.length
    if (id === undefined || bodies[id] !== undefined) return
    order.push(id)
    bodies[id] = lines.slice(h.i, end).join('\n')
  })
  return { order, bodies }
}

function scoreTurn(kase, n, turn, obs, prev) {
  const out = []
  const check = (name, pass, detail = '') => out.push({ turn: n + 1, name, pass, detail })
  const e = turn.expect ?? {}
  for (const tool of e.tools_called ?? [])
    check(
      `调了 ${tool}`,
      obs.tools.includes(tool),
      `这一轮调了：${obs.tools.join(', ') || '（没有）'}`,
    )
  for (const tool of e.tools_not_called ?? []) check(`没调 ${tool}`, !obs.tools.includes(tool))
  if (e.schedule !== undefined) {
    const s = e.schedule
    if (s.count !== undefined)
      check(`定时有 ${s.count} 条`, obs.tasks.length === s.count, `现在 ${obs.tasks.length} 条`)
    const task = obs.tasks[0]
    const rule = task?.trigger?.rule ?? {}
    if (s.weekly !== undefined) {
      const days = Array.isArray(rule.weekdays) ? rule.weekdays : []
      check(
        `每周 ${s.weekly.weekdays.join(',')} ${s.weekly.time}`,
        rule.kind === 'weekly' &&
          JSON.stringify(days) === JSON.stringify(s.weekly.weekdays) &&
          String(rule.time ?? '').startsWith(s.weekly.time),
        JSON.stringify({
          kind: rule.kind,
          weekdays: rule.weekdays,
          time: rule.time,
          tz: rule.timeZone,
        }),
      )
    }
    if (s.same_task === true)
      check('改的是原来那条定时', task !== undefined && task.id === prev.tasks[0]?.id)
    if (s.prompt_changed === true)
      check(
        '定时的说明改了',
        task !== undefined &&
          task.params?.official?.prompt !== prev.tasks[0]?.params?.official?.prompt,
      )
  }
  if (e.report !== undefined) {
    const r = obs.report
    check('发了一份报告', r !== undefined)
    if (r !== undefined) {
      const p = r.payload
      if (e.report.version !== undefined)
        check(`第 ${e.report.version} 版`, p.version === e.report.version, `实际第 ${p.version} 版`)
      const { order, bodies } = sectionsOf(p.markdown, kase.sections)
      if (e.report.sections_in_order !== undefined)
        check(
          `各节顺序 ${e.report.sections_in_order.join(' → ')}`,
          JSON.stringify(order) === JSON.stringify(e.report.sections_in_order),
          `实际：${order.join(' → ')}`,
        )
      for (const [id, needles] of Object.entries(e.report.contains ?? {}))
        for (const needle of needles)
          check(`「${id}」一节里有 ${needle}`, (bodies[id] ?? '').includes(needle))
      for (const needle of e.report.omits ?? [])
        check(`报告里没有 ${needle}`, !p.markdown.includes(needle))
    }
  }
  return out
}

/**
 * 跑一个用例。回 `{ pass, checks, transcript, usage }`；`transcript` 里每轮有用到的工具、AI 的回话、
 * 报告的标题与各节顺序（不含任何 key）。
 */
export async function runReportCase(kase, options) {
  const { turnTimeoutMs = 8 * 60_000, log = () => {} } = options
  const ctx = await bootCase(kase, options)
  const checks = []
  const transcript = []
  let matterId
  let prev = { tasks: [] }
  try {
    for (const [n, turn] of kase.turns.entries()) {
      const mark = events(ctx).length
      const notes = []
      if (turn.say !== undefined) {
        log(`第 ${n + 1} 轮：说「${turn.say}」`)
        if (matterId === undefined) {
          const m = await ctx.call('POST', '/v1/matters', { kind: 'conversation', title: turn.say })
          matterId = m.data?.matter?.id
          if (matterId === undefined)
            throw new Error(`开事项失败：HTTP ${m.status} ${m.code ?? ''}`)
        }
        const r = await ctx.call('POST', `/v1/matters/${matterId}/messages`, { text: turn.say })
        if (r.status >= 300)
          throw new Error(`发消息失败：HTTP ${r.status} ${r.code ?? ''} ${r.message ?? ''}`)
        await settle(ctx, mark, { timeoutMs: turnTimeoutMs })
        await approvePendingSchedules(ctx, notes)
      } else if (turn.fire_at !== undefined) {
        log(`第 ${n + 1} 轮：到点 ${turn.fire_at}`)
        ctx.setNow(turn.fire_at)
        await approvePendingSchedules(ctx, notes)
        const [task] = automationTasks(ctx)
        if (task === undefined) notes.push('没有可到点的定时')
        else {
          const fired = await ctx.server.schedule.scheduler.runNow(task.id)
          if (fired?.ok !== true) notes.push(`到点没跑成：${JSON.stringify(fired).slice(0, 300)}`)
          await settle(ctx, mark, { timeoutMs: turnTimeoutMs })
        }
      }
      const fresh = events(ctx).slice(mark)
      const tools = fresh
        .filter((e) => e.type === 'tool.call')
        .map((e) => String(e.payload?.tool ?? '').replace(/^.*\./, ''))
      const failed = fresh
        .filter((e) => e.type === 'run.failed')
        .map((e) => JSON.stringify(e.payload).slice(0, 300))
      const answers = fresh
        .filter((e) => e.type === 'run.completed')
        .flatMap((e) =>
          (e.payload?.outputs ?? []).filter((o) => o.kind === 'answer').map((o) => o.text),
        )
      const all = await reports(ctx)
      const before = new Set((prev.reports ?? []).map((r) => `${r.id}:${r.revision}`))
      const report = all.filter((r) => !before.has(`${r.id}:${r.revision}`)).at(-1)
      const obs = { tools, tasks: automationTasks(ctx), report, reports: all }
      checks.push(...scoreTurn(kase, n, turn, obs, prev))
      if (failed.length > 0)
        checks.push({ turn: n + 1, name: '运行没报错', pass: false, detail: failed.join(' | ') })
      transcript.push({
        turn: n + 1,
        ...(turn.say === undefined ? { fire_at: turn.fire_at } : { say: turn.say }),
        tools,
        answers,
        notes,
        ...(report === undefined
          ? {}
          : {
              report: {
                title: report.payload.title,
                period: report.payload.period,
                version: report.payload.version,
                sections: sectionsOf(report.payload.markdown, kase.sections).order,
                markdown: report.payload.markdown,
              },
            }),
        schedule: obs.tasks.map((t) => ({
          id: t.id,
          state: t.state,
          rule: t.trigger?.rule,
          prompt: t.params?.official?.prompt,
        })),
      })
      prev = obs
      // 真模型那一档：每轮报一次用量，超了预算由调用方抛错停下（finally 里照样关服务、删临时目录）
      await options.onTurn?.({ turn: n + 1, usage: usageOf(ctx) })
    }
    return { pass: checks.every((c) => c.pass), checks, transcript, usage: usageOf(ctx) }
  } finally {
    await ctx.close()
  }
}

const ZERO = { runs: 0, input_tokens: 0, output_tokens: 0, cached_tokens: 0, tool_calls: 0 }

/** 到目前为止所有运行的用量（真模型那一档拿它算花了多少钱）。 */
export function usageOf(ctx) {
  return events(ctx)
    .filter((e) => e.type === 'run.completed')
    .reduce((acc, e) => {
      const u = e.payload?.usage ?? {}
      return {
        runs: acc.runs + 1,
        input_tokens: acc.input_tokens + (u.input_tokens ?? 0),
        output_tokens: acc.output_tokens + (u.output_tokens ?? 0),
        cached_tokens: acc.cached_tokens + (u.cached_tokens ?? 0),
        tool_calls: acc.tool_calls + (u.tool_calls ?? 0),
      }
    }, ZERO)
}
