/**
 * `expected` 的结构化断言（26 §1）。断言不变量与结构，**不断言措辞**——
 * `reply_omits` / `reply_includes_any` 是"必须没有 / 至少有一个"的白名单，不是逐字比对。
 */
import type { ChangeKind } from '@agentsws/contracts'
import { type DeckKind, isQueueCard } from '@agentsws/deck'
import { assemblePrompt } from '@agentsws/stand-ins'
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'
import type { JudgeReport } from './judge.js'
import type { MetricTable } from './metrics.js'
import type { NumericAssertion, ScenarioExpected } from './scenario/types.js'

export interface ExpectationResult {
  key: string
  ok: boolean
  detail: string
}

const CMP = /^(>=|<=|==|>|<)\s*(-?\d+(?:\.\d+)?)$/

/** `>=0.6` / `<=20000` / 裸数字（相等）。 */
export function matchNumeric(actual: number, expected: NumericAssertion): boolean {
  if (typeof expected === 'number') return Math.abs(actual - expected) < 1e-9
  const m = CMP.exec(expected.trim())
  if (m === null || m[1] === undefined || m[2] === undefined) return false
  const v = Number.parseFloat(m[2])
  switch (m[1]) {
    case '>=':
      return actual >= v
    case '<=':
      return actual <= v
    case '>':
      return actual > v
    case '<':
      return actual < v
    default:
      return Math.abs(actual - v) < 1e-9
  }
}

/** 本次模拟里模型实际调过的工具（按事件顺序）。 */
export function toolsCalled(evidence: Evidence): string[] {
  return evidence.events.filter((e) => e.type === 'tool.call').map((e) => String(payloadOf(e).tool))
}

/** 发出去的回信正文（`delivery.sent` 对应的审批项 payload）。 */
export function repliesSent(evidence: Evidence): string[] {
  const sentItems = new Set(
    evidence.events.filter((e) => e.type === 'delivery.sent').map((e) => e.subject?.id),
  )
  return evidence.approvals
    .filter((i) => sentItems.has(i.id))
    .map((i) => {
      const payload = (i.decision?.edited_payload ?? i.payload) as { body?: { text?: unknown } }
      return String(payload.body?.text ?? '')
    })
}

/** 已提出的草稿正文（含还没发出去的），用于"没发出去也不该出现某措辞"。 */
export function draftsProposed(evidence: Evidence): string[] {
  return evidence.approvals
    .filter((i) => i.kind === 'outbound_draft')
    .map((i) => {
      const payload = (i.decision?.edited_payload ?? i.payload) as { body?: { text?: unknown } }
      return String(payload.body?.text ?? '')
    })
}

export function checkExpectations(
  expected: ScenarioExpected,
  evidence: Evidence,
  metrics: MetricTable,
  judge?: JudgeReport,
): ExpectationResult[] {
  const out: ExpectationResult[] = []
  const add = (key: string, ok: boolean, detail: string): void => {
    out.push({ key, ok, detail })
  }
  const called = toolsCalled(evidence)
  const bare = (t: string): string => (t.includes('.') ? t.slice(t.indexOf('.') + 1) : t)
  const calledBare = called.map(bare)

  if (expected.calls_tool !== undefined) {
    const missing = expected.calls_tool.filter((t) => !calledBare.includes(bare(t)))
    add(
      'calls_tool',
      missing.length === 0,
      missing.length === 0 ? `全部命中：${called.join(', ')}` : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.first_tool !== undefined) {
    const first = calledBare[0]
    add('first_tool', first === bare(expected.first_tool), `第一次工具调用 = ${String(first)}`)
  }
  if (expected.never_calls !== undefined) {
    const hit = expected.never_calls.filter((t) => calledBare.includes(bare(t)))
    add(
      'never_calls',
      hit.length === 0,
      hit.length === 0 ? '一次没调' : `调到了：${hit.join(', ')}`,
    )
  }
  if (expected.staged_change_kinds !== undefined) {
    const actual = [...new Set(evidence.changes.map((c) => c.kind))].sort()
    const want = [...new Set(expected.staged_change_kinds as ChangeKind[])].sort()
    add(
      'staged_change_kinds',
      actual.length === want.length && actual.every((k, i) => k === want[i]),
      `实际 [${actual.join(', ')}]，期望 [${want.join(', ')}]`,
    )
  }
  if (expected.no_applied_changes_before !== undefined) {
    const marker = expected.no_applied_changes_before
    const firstApprove = evidence.events.find(
      (e) =>
        e.type === 'approval.decided' &&
        ['approve', 'approve_edited'].includes(String(payloadOf(e).action)),
    )
    const firstApplied = evidence.events.find((e) => e.type === 'change.applied')
    const ok =
      firstApplied === undefined ||
      (firstApprove !== undefined && Date.parse(firstApprove.at) <= Date.parse(firstApplied.at))
    add(
      'no_applied_changes_before',
      ok,
      ok
        ? `${marker} 之前没有 change.applied`
        : `change.applied 早于第一条批准（${firstApplied?.at ?? '-'}）`,
    )
  }
  if (expected.approval_items !== undefined) {
    const spec = expected.approval_items
    const items = evidence.approvals.filter((i) => i.kind === spec.kind)
    let ok = true
    const detail: string[] = [`${spec.kind} × ${items.length}`]
    if (spec.count !== undefined) {
      const hit = matchNumeric(items.length, spec.count)
      ok = ok && hit
      detail.push(`count ${hit ? '✓' : '✗'} (${String(spec.count)})`)
    }
    if (spec.children !== undefined) {
      const kindsOfChildren = new Set<string>()
      for (const item of items) {
        for (const childId of item.links.children) {
          const child = evidence.approvals.find((c) => c.id === childId)
          if (child !== undefined) kindsOfChildren.add(child.kind)
        }
      }
      const missing = spec.children.filter((k) => !kindsOfChildren.has(k))
      ok = ok && missing.length === 0
      detail.push(missing.length === 0 ? 'children ✓' : `children 缺 ${missing.join(', ')}`)
    }
    add('approval_items', ok, detail.join('；'))
  }
  if (expected.reply_omits !== undefined) {
    const bodies = [...repliesSent(evidence), ...draftsProposed(evidence)]
    const hit = expected.reply_omits.filter((w) => bodies.some((b) => b.includes(w)))
    add(
      'reply_omits',
      hit.length === 0,
      hit.length === 0 ? '措辞未出现' : `出现了：${hit.join(', ')}`,
    )
  }
  if (expected.reply_includes_any !== undefined) {
    const bodies = draftsProposed(evidence)
    const ok =
      bodies.length > 0 &&
      bodies.some((b) => expected.reply_includes_any?.some((w) => b.includes(w)))
    add(
      'reply_includes_any',
      ok,
      ok ? '至少一条命中' : `没有草稿命中 [${expected.reply_includes_any.join(', ')}]`,
    )
  }
  if (expected.memory_contains !== undefined) {
    const keys = evidence.runs.flatMap((r) => (r.result?.memory_candidates ?? []).map((m) => m.key))
    const missing = expected.memory_contains.filter((k) => !keys.includes(k))
    add(
      'memory_contains',
      missing.length === 0,
      missing.length === 0 ? '命中' : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.max_tool_calls !== undefined) {
    add(
      'max_tool_calls',
      called.length <= expected.max_tool_calls,
      `${called.length} 次 ≤ ${expected.max_tool_calls}`,
    )
  }
  if (expected.metrics !== undefined) {
    for (const [name, assertion] of Object.entries(expected.metrics)) {
      const metric = metrics[name]
      if (metric === undefined) {
        add(`metrics.${name}`, false, '报告里没有这个指标')
        continue
      }
      add(
        `metrics.${name}`,
        matchNumeric(metric.value, assertion),
        `${metric.value}（期望 ${String(assertion)}；来源 ${metric.event_types.join('+')} × ${metric.event_count}）`,
      )
    }
  }
  if (expected.run_failed_codes !== undefined) {
    const codes = new Set(
      evidence.events
        .filter((e) => e.type === 'run.failed')
        .map((e) => String((payloadOf(e).error as { code?: unknown })?.code ?? '')),
    )
    const missing = expected.run_failed_codes.filter((c) => !codes.has(c))
    add(
      'run_failed_codes',
      missing.length === 0,
      missing.length === 0 ? `[${[...codes].join(', ')}]` : `缺：${missing.join(', ')}`,
    )
  }
  if (expected.notifications_to !== undefined) {
    const to = new Set(evidence.notifications.map((n) => n.to))
    const missing = expected.notifications_to.filter((p) => !to.has(p))
    add(
      'notifications_to',
      missing.length === 0,
      missing.length === 0 ? `通知到 [${[...to].join(', ')}]` : `没通知到：${missing.join(', ')}`,
    )
  }
  if (expected.event_types !== undefined) {
    const seen = new Set(evidence.events.map((e) => e.type))
    const missing = expected.event_types.filter((t) => !seen.has(t))
    add(
      'event_types',
      missing.length === 0,
      missing.length === 0 ? '都出现过' : `事件日志里没有：${missing.join(', ')}`,
    )
  }
  if (expected.approval_kinds !== undefined) {
    for (const [kind, assertion] of Object.entries(expected.approval_kinds)) {
      const n = evidence.approvals.filter((i) => i.kind === kind).length
      add(
        `approval_kinds.${kind}`,
        matchNumeric(n, assertion),
        `${kind} × ${n}（期望 ${String(assertion)}）`,
      )
    }
  }
  /*
   * WP96（09-18）：**只有要人决定的才是卡**。
   *
   * 账本照旧收下每一条（14 的老规矩：Agent 主动做的每件事都进同一条账），
   * 变的是投影到界面的那一步：日报与上线检查单落进岗位面板的**报表块**，
   * 不进人的队列。所以这两个断言问的是两件不同的事——
   * `panel_reports` 问"报表块有没有数"，`queue_cards` 问"队列里干不干净"。
   * 判据是 deck 的 `isQueueCard`，六端同一份，不在这里另写一遍。
   */
  if (expected.queue_cards !== undefined || expected.panel_reports !== undefined) {
    const changeKindOf = (item: (typeof evidence.approvals)[number]): string | undefined => {
      const p = item.payload
      if (typeof p !== 'object' || p === null || Array.isArray(p)) return undefined
      const k = (p as Record<string, unknown>).kind
      return typeof k === 'string' ? k : undefined
    }
    const inQueue = evidence.approvals.filter((i) =>
      isQueueCard(i.kind as DeckKind, changeKindOf(i)),
    )
    // 账本里只有 ApprovalKind，没有 `system_alert`（那是投影时才有的系统卡），
    // 所以"不进队列的"在模拟里就等于报表块那两样。
    const inPanel = evidence.approvals.filter(
      (i) => !isQueueCard(i.kind as DeckKind, changeKindOf(i)),
    )
    if (expected.queue_cards !== undefined) {
      add(
        'queue_cards',
        matchNumeric(inQueue.length, expected.queue_cards),
        `进人队列的卡 ${inQueue.length} 张（期望 ${String(expected.queue_cards)}）`,
      )
    }
    if (expected.panel_reports !== undefined) {
      add(
        'panel_reports',
        matchNumeric(inPanel.length, expected.panel_reports),
        `面板报表块 ${inPanel.length} 条（期望 ${String(expected.panel_reports)}）`,
      )
    }
  }
  if (expected.scheduled_handlers !== undefined) {
    // 定时任务不在 evidence 里（它属于调度器），从 `schedule.created` 事件看
    const registered = new Set(
      evidence.events
        .filter((e) => e.type === 'schedule.created')
        .map((e) => String(payloadOf(e).handler)),
    )
    const missing = expected.scheduled_handlers.filter((h) => !registered.has(h))
    add(
      'scheduled_handlers',
      missing.length === 0,
      missing.length === 0
        ? `已注册 [${[...registered].join(', ')}]`
        : `没注册：${missing.join(', ')}`,
    )
  }
  if (expected.prompt_includes_any !== undefined) {
    // 17 §1 的装配函数只有一处（`assemblePrompt`），这里用同一个重组最后一次运行的 prompt
    const last = evidence.runs.at(-1)
    const text =
      last === undefined
        ? ''
        : assemblePrompt(last.request)
            .messages.map((m) => m.content)
            .join('\n')
    const hit = expected.prompt_includes_any.filter((w) => text.includes(w))
    add(
      'prompt_includes_any',
      hit.length > 0,
      hit.length > 0
        ? `最后一次运行的 prompt 含 [${hit.join(', ')}]`
        : `prompt 里一条都没有：[${expected.prompt_includes_any.join(', ')}]`,
    )
  }
  if (expected.lessons_filtered !== undefined) {
    const reasons = new Set(evidence.learning?.filtered ?? [])
    const missing = expected.lessons_filtered.filter((r) => !reasons.has(r))
    add(
      'lessons_filtered',
      missing.length === 0,
      missing.length === 0
        ? `拦下的原因 [${[...reasons].join(', ')}]`
        : `没出现的原因：${missing.join(', ')}`,
    )
  }
  if (expected.lessons_pooled !== undefined) {
    const n = evidence.learning?.pooled ?? 0
    add(
      'lessons_pooled',
      matchNumeric(n, expected.lessons_pooled),
      `池里 ${n} 条（期望 ${String(expected.lessons_pooled)}）`,
    )
  }
  // ── WP32 ────────────────────────────────────────────────────────────
  if (expected.escalated_tiers !== undefined) {
    const tiers = new Set(
      evidence.events
        .filter((e) => e.type === 'approval.escalated')
        .map((e) => String(payloadOf(e).tier)),
    )
    const missing = expected.escalated_tiers.filter((t) => !tiers.has(t))
    add(
      'escalated_tiers',
      missing.length === 0,
      missing.length === 0
        ? `升到过 [${[...tiers].join(', ')}]`
        : `没升到：${missing.join(', ')}（实际 [${[...tiers].join(', ')}]）`,
    )
  }
  if (expected.escalated_to !== undefined) {
    const people = new Set(
      evidence.events
        .filter((e) => e.type === 'approval.escalated')
        .map((e) => String(payloadOf(e).to)),
    )
    const missing = expected.escalated_to.filter((p) => !people.has(p))
    add(
      'escalated_to',
      missing.length === 0,
      missing.length === 0
        ? `交到过 [${[...people].join(', ')}]`
        : `没交到：${missing.join(', ')}（实际 [${[...people].join(', ')}]）`,
    )
  }
  if (expected.sampled !== undefined) {
    const n = evidence.sampling_reviews.length
    add(
      'sampled',
      matchNumeric(n, expected.sampled),
      `抽检 ${n} 条（期望 ${String(expected.sampled)}）`,
    )
  }
  if (expected.auto_approved !== undefined) {
    const n = evidence.approvals.filter((i) => i.automation.auto_approved).length
    add(
      'auto_approved',
      matchNumeric(n, expected.auto_approved),
      `自动批 ${n} 条（期望 ${String(expected.auto_approved)}）`,
    )
  }
  if (expected.judge_min_score !== undefined) {
    const score = judge?.rule.score ?? 1
    const failed = (judge?.rule.checks ?? []).filter((c) => !c.ok)
    add(
      'judge_min_score',
      score >= expected.judge_min_score,
      `规则 judge ${score.toFixed(3)} ≥ ${expected.judge_min_score}` +
        (failed.length === 0
          ? ''
          : `；没过的：${failed.map((c) => `${c.id}@${c.target}(${c.detail})`).join(' | ')}`),
    )
  }
  if (expected.assignments_not_unioned !== undefined) {
    // 05 §4：一个人身上有两个分配时，**没有任何一个分配**能拿到两边权限的并集
    const problems: string[] = []
    for (const person of expected.assignments_not_unioned) {
      const mine = evidence.assignments.filter((a) => a.person_id === person)
      if (mine.length < 2) {
        problems.push(`${person} 只有 ${mine.length} 个分配，这条断言没有意义`)
        continue
      }
      const union = new Set(mine.flatMap((a) => a.scopes))
      for (const a of mine) {
        if (a.scopes.length === union.size) {
          problems.push(`${person} 的分配 ${a.assignment_id}(${a.role_id}) 拿到了并集权限`)
        }
      }
    }
    add(
      'assignments_not_unioned',
      problems.length === 0,
      problems.length === 0 ? '每个分配各管各的' : problems.join('；'),
    )
  }
  // WP39：秘书把事路由给了哪些职责（41 §1.2「不是自己回，是转给对的岗位」）
  if (expected.routed_to !== undefined) {
    const roles = new Set(
      evidence.events
        .filter((e) => e.type === 'simulation.secretary_routed')
        .map((e) => String(payloadOf(e).role_id ?? '')),
    )
    const missing = expected.routed_to.filter((r) => !roles.has(r))
    add(
      'routed_to',
      missing.length === 0,
      missing.length === 0
        ? `路由到 [${[...roles].join(', ')}]`
        : `没路由到：${missing.join(', ')}（实际 [${[...roles].join(', ')}]）`,
    )
  }
  // WP69（54 §2）：**岗位内**路由落到了哪几条职责（与秘书那条不是一回事）
  if (expected.position_routed_to !== undefined) {
    const roles = new Set(
      evidence.events
        .filter((e) => e.type === 'simulation.position_routed')
        .map((e) => String(payloadOf(e).role_id ?? '')),
    )
    const missing = expected.position_routed_to.filter((r) => !roles.has(r))
    add(
      'position_routed_to',
      missing.length === 0,
      missing.length === 0
        ? `岗位内路由到 [${[...roles].join(', ')}]`
        : `没路由到：${missing.join(', ')}（实际 [${[...roles].join(', ')}]）`,
    )
  }
  // WP55 / 48 §4 L3 #2：入站被判成的渠道细分（`amazon`）
  if (expected.sub_channel !== undefined) {
    const seen = [...new Set(evidence.inbound.map((e) => e.sub_channel ?? e.channel))]
    add(
      'sub_channel',
      seen.includes(expected.sub_channel),
      `入站判成 [${seen.join(', ')}]，期望含 ${expected.sub_channel}`,
    )
  }
  // WP55 / 48 §4 L3 #3：这几道门至少各判过一次「不自主」
  if (expected.gates_failed !== undefined) {
    const failed = new Set<string>()
    for (const e of evidence.events) {
      if (e.type !== 'guardrail.gate_decided') continue
      const gates = payloadOf(e).gates
      if (!Array.isArray(gates)) continue
      for (const g of gates) {
        const rec = g !== null && typeof g === 'object' ? (g as Record<string, unknown>) : undefined
        if (rec === undefined) continue
        if (rec.status !== 'pass' && typeof rec.gate === 'string') failed.add(rec.gate)
      }
    }
    const missing = expected.gates_failed.filter((g) => !failed.has(g))
    add(
      'gates_failed',
      missing.length === 0,
      missing.length === 0
        ? `判了不自主的门：[${[...failed].sort().join(', ')}]`
        : `这几道门没说不自主：${missing.join(', ')}（实际 [${[...failed].sort().join(', ')}]）`,
    )
  }
  // WP63 / 51 §2.1：日报卡出了几张、卡面上那几个数对不对
  if (expected.daily_reports !== undefined || expected.daily_report_figures !== undefined) {
    const reports = evidence.events.filter((e) => e.type === 'digest.daily_report')
    if (expected.daily_reports !== undefined) {
      const hit = matchNumeric(reports.length, expected.daily_reports)
      add(
        'daily_reports',
        hit,
        `日报卡 ${reports.length} 张（期望 ${String(expected.daily_reports)}）`,
      )
    }
    if (expected.daily_report_figures !== undefined) {
      const last = reports[reports.length - 1]
      if (last === undefined) {
        add('daily_report_figures', false, '一张日报卡都没有，这条断言没有意义')
      } else {
        const p = payloadOf(last)
        const problems: string[] = []
        for (const [key, assertion] of Object.entries(expected.daily_report_figures)) {
          const value = p[key]
          if (typeof value !== 'number') {
            problems.push(`${key} 不在卡面上`)
            continue
          }
          if (!matchNumeric(value, assertion))
            problems.push(`${key}=${value}（期望 ${String(assertion)}）`)
        }
        add(
          'daily_report_figures',
          problems.length === 0,
          problems.length === 0 ? '日报卡上的数都对得上' : problems.join('；'),
        )
      }
    }
  }
  // WP154：「今天值得动的 5 件事」——恰好几件、先修再写、不倾倒数据
  if (expected.seo_daily !== undefined) {
    const want = expected.seo_daily
    const last = evidence.events.filter((e) => e.type === 'digest.seo_daily').pop()
    if (last === undefined) add('seo_daily', false, '一张「今天值得动的 5 件事」都没出')
    else {
      const p = payloadOf(last)
      const lanes = Array.isArray(p.lanes) ? (p.lanes as string[]) : []
      const problems: string[] = []
      if (want.picks !== undefined && !matchNumeric(lanes.length, want.picks))
        problems.push(`卡上 ${lanes.length} 件（期望 ${String(want.picks)}）`)
      if (want.fix_before_write === true) {
        const order = ['fix_page', 'site_handoff', 'pr_handoff', 'new_page']
        const idx = lanes.map((l) => order.indexOf(l))
        if (idx.some((v, i) => i > 0 && v < (idx[i - 1] ?? 0)))
          problems.push(`顺序不是先修再写：${lanes.join(' → ')}`)
      }
      if (want.no_dump === true) {
        const rowsIn = typeof p.rows_in === 'number' ? p.rows_in : 0
        const cardRows = typeof p.card_rows === 'number' ? p.card_rows : Number.POSITIVE_INFINITY
        if (cardRows > lanes.length || rowsIn <= cardRows)
          problems.push(`读进 ${rowsIn} 行、卡上 ${cardRows} 行——数据倒上卡了`)
      }
      add(
        'seo_daily',
        problems.length === 0,
        problems.length === 0
          ? `卡上 ${lanes.length} 件：${lanes.join(' → ')}`
          : problems.join('；'),
      )
    }
  }
  // WP47 / 44 G2：同一个账号的两条产品线，互相看不到对方的订单和商品
  if (expected.scope_disjoint !== undefined) {
    const seen = new Map<string, { orders: string[]; products: string[] }>()
    for (const e of evidence.events) {
      if (e.type !== 'simulation.scope_checked') continue
      const p = payloadOf(e)
      const who = String(p.who ?? '')
      seen.set(who, {
        orders: Array.isArray(p.orders) ? (p.orders as string[]) : [],
        products: Array.isArray(p.products) ? (p.products as string[]) : [],
      })
    }
    const problems: string[] = []
    for (const who of expected.scope_disjoint) {
      const mine = seen.get(who)
      if (mine === undefined) {
        problems.push(`${who} 没有 org.scope_check，这条断言没有意义`)
        continue
      }
      // 看不到任何东西的"隔离"不算隔离（那只是没给范围）
      if (mine.orders.length === 0) problems.push(`${who} 一张订单都看不到`)
      if (mine.products.length === 0) problems.push(`${who} 一件商品都看不到`)
    }
    for (const a of expected.scope_disjoint)
      for (const b of expected.scope_disjoint) {
        if (a >= b) continue
        const x = seen.get(a)
        const y = seen.get(b)
        if (x === undefined || y === undefined) continue
        const sharedOrders = x.orders.filter((id) => y.orders.includes(id))
        const sharedProducts = x.products.filter((id) => y.products.includes(id))
        if (sharedOrders.length > 0)
          problems.push(`${a} 与 ${b} 都看得到订单 ${sharedOrders.slice(0, 3).join('、')}`)
        if (sharedProducts.length > 0)
          problems.push(`${a} 与 ${b} 都看得到商品 ${sharedProducts.slice(0, 3).join('、')}`)
      }
    add(
      'scope_disjoint',
      problems.length === 0,
      problems.length === 0
        ? `${expected.scope_disjoint.join(' / ')} 各看各的（${expected.scope_disjoint
            .map((w) => `${w}:${seen.get(w)?.orders.length ?? 0} 单`)
            .join('，')}）`
        : problems.join('；'),
    )
  }
  // WP64 / 51 §2.4：超期未发是**按订单上的结构化字段判出来的**，不是模型说的
  if (expected.overdue_orders !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.fulfillment_overdue')
    if (last === undefined) {
      add('overdue_orders', false, '这一轮根本没跑过 fulfillment.sweep')
    } else {
      const p = payloadOf(last)
      const count = Number(p.count ?? 0)
      const worst = Number(p.worst_days ?? 0)
      const problems: string[] = []
      if (
        expected.overdue_orders.count !== undefined &&
        !matchNumeric(count, expected.overdue_orders.count)
      ) {
        problems.push(`找出 ${count} 张，不合期望`)
      }
      if (
        expected.overdue_orders.worst_days !== undefined &&
        !matchNumeric(worst, expected.overdue_orders.worst_days)
      ) {
        problems.push(`最久的压了 ${worst} 天，不合期望`)
      }
      add(
        'overdue_orders',
        problems.length === 0,
        problems.length === 0
          ? `超期 ${count} 张，最久 ${worst} 天（门槛 ${String(p.overdue_days ?? '?')} 天）`
          : problems.join('；'),
      )
    }
  }
  // WP64 / 51 §2.3：群发永远 L1，而且抑制名单里的人被剔掉了、卡上说了
  if (expected.campaign_send !== undefined) {
    const last = [...evidence.events].reverse().find((e) => e.type === 'simulation.campaign_staged')
    if (last === undefined) {
      add('campaign_send', false, '这一轮没有一条群发提案进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.campaign_send
      const problems: string[] = []
      if (want.requested_level !== undefined && p.level_requested !== want.requested_level) {
        problems.push(`提案报的是 ${String(p.level_requested)}，不是 ${want.requested_level}`)
      }
      // 「永远 L1」的落点：报了 L3 也不许自动放行
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(
          want.auto_approved
            ? '这张卡没有自动放行'
            : `报了 ${String(p.level_requested)} 居然自动发了出去`,
        )
      }
      const removed = Number(p.suppressed_removed ?? 0)
      if (
        want.suppressed_removed !== undefined &&
        !matchNumeric(removed, want.suppressed_removed)
      ) {
        problems.push(`名单只剔掉了 ${removed} 个人，不合期望`)
      }
      const size = Number(p.audience_size ?? 0)
      if (want.audience_size !== undefined && !matchNumeric(size, want.audience_size)) {
        problems.push(`收件人 ${size} 个，不合期望`)
      }
      // 剔了不说等于没剔：人在卡上看不见的事，等于没发生
      if (
        want.stated_on_card !== undefined &&
        (p.stated_on_card === true) !== want.stated_on_card
      ) {
        problems.push('卡面上没说名单剔了谁')
      }
      add(
        'campaign_send',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；${size} 人收，剔了 ${removed} 个，卡上说了`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP113 / 63 §4：最后一封信分拣成了什么。
   *
   * `moved` 是这一组题的心脏：**岗位没开、把握不够、急停**三种情况下它都必须是
   * `false`——"没开客服岗位的工作区里，一封客户投诉照样只是收件箱里打了标签的
   * 一封信"（Luoye 原话）。`model_calls` 是第二重要的那一格：规则层命中时是 0，
   * "教过一次之后下一封直达"在数字上就是它从 1 变成 0。
   */
  if (expected.message_triage !== undefined) {
    const last = [...evidence.events].reverse().find((e) => e.type === 'simulation.message_triaged')
    if (last === undefined) {
      add('message_triage', false, '这一轮一封信都没被分拣')
    } else {
      const p = payloadOf(last)
      const want = expected.message_triage
      const problems: string[] = []
      if (want.route !== undefined && p.route !== want.route) {
        problems.push(`判成了 ${String(p.route)}，不是 ${want.route}`)
      }
      if (want.suggested_route !== undefined && p.suggested_route !== want.suggested_route) {
        problems.push(`没挂上"像是 ${want.suggested_route} 信？"那一问`)
      }
      if (want.by !== undefined && p.by !== want.by) {
        problems.push(`这一判是 ${String(p.by)} 做的，不是 ${want.by}`)
      }
      if (want.needs_reply !== undefined && (p.needs_reply === true) !== want.needs_reply) {
        problems.push(`needs_reply 是 ${String(p.needs_reply)}`)
      }
      if (want.moved !== undefined && (p.moved === true) !== want.moved) {
        problems.push(
          want.moved ? '这封信没被挪走' : `这封信被挪进了 ${String(p.moved_to ?? '?')}——它不该挪`,
        )
      }
      if (want.moved_to !== undefined && p.moved_to !== want.moved_to) {
        problems.push(`挪到了 ${String(p.moved_to ?? '哪儿都没去')}，不是 ${want.moved_to}`)
      }
      const labels = Array.isArray(p.labels) ? (p.labels as string[]) : []
      const missing = (want.labels ?? []).filter((l) => !labels.includes(l))
      if (missing.length > 0) problems.push(`少了标签：${missing.join(', ')}`)
      const calls = Number(p.model_calls ?? 0)
      if (want.model_calls !== undefined && !matchNumeric(calls, want.model_calls)) {
        problems.push(`花了 ${calls} 次模型，不合期望`)
      }
      const confidence = Number(p.confidence ?? 0)
      if (want.confidence !== undefined && !matchNumeric(confidence, want.confidence)) {
        problems.push(`把握 ${confidence}，不合期望`)
      }
      add(
        'message_triage',
        problems.length === 0,
        problems.length === 0
          ? `判成 ${String(p.route)}（${String(p.by)}，把握 ${confidence}），${
              p.moved === true ? `挪进 ${String(p.moved_to)}` : '留在收件箱'
            }，花了 ${calls} 次模型`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP76 / 58 §1：那一张需求单。
   *
   * 三件事：路由**真判**到哪条设计职责（不是场景指定的）、brief 出没出、
   * 以及"整理不出来的那几件事"有没有被记下来（`questions_at_least`——
   * 那是"不编默认值"在断言里的样子）。
   */
  if (expected.design_request !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.design_brief_drafted')
    const routed = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.design_request_routed')
    const want = expected.design_request
    const problems: string[] = []
    if (routed === undefined) problems.push('这一轮没有一张需求单被路由过')
    else {
      const r = payloadOf(routed)
      if (want.routed_to !== undefined && String(r.role_id) !== want.routed_to) {
        problems.push(`路由到了 ${String(r.role_id ?? '（谁也没有）')}，不合期望`)
      }
    }
    if (want.brief_drafted === true && last === undefined) problems.push('没有出 brief')
    if (want.brief_drafted === false && last !== undefined) problems.push('不该出 brief')
    if (last !== undefined) {
      const p = payloadOf(last)
      if (
        want.questions_at_least !== undefined &&
        Number(p.questions ?? 0) < want.questions_at_least
      ) {
        problems.push(`brief 上只记了 ${String(p.questions ?? 0)} 句问，比期望的少`)
      }
      if (
        want.brand_system_missing !== undefined &&
        (p.brand_system_missing === true) !== want.brand_system_missing
      ) {
        problems.push(
          want.brand_system_missing
            ? '这家公司明明还没设品牌系统，卡上却没说'
            : '品牌系统取到了，不该出「先设品牌系统」卡',
        )
      }
    }
    if (want.brief_auto_approved !== undefined) {
      const auto = evidence.approvals.some(
        (a) => a.kind === 'staged_change' && a.automation.auto_approved,
      )
      if (auto !== want.brief_auto_approved) {
        problems.push(want.brief_auto_approved ? 'brief 没能 L3 自动出' : 'brief 不该自动放行')
      }
    }
    add(
      'design_request',
      problems.length === 0,
      problems.length === 0
        ? `路由到 ${routed === undefined ? '?' : String(payloadOf(routed).role_id ?? '?')}，brief 出了`
        : problems.join('；'),
    )
  }
  /*
   * WP76 / 58 §1：那一次出变体。
   *
   * `image_model: false` 时 `generated` 必须是 0，而且那句人话必须真写出来
   * （`reason_stated`）——58 §1 要的是"没有就明说"，不是一句"生成失败"。
   */
  if (expected.design_variants !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.design_variants_staged')
    if (last === undefined) {
      add('design_variants', false, '这一轮没有出过变体')
    } else {
      const p = payloadOf(last)
      const want = expected.design_variants
      const problems: string[] = []
      if (want.n !== undefined && Number(p.n ?? -1) !== want.n) {
        problems.push(`这次要出 ${String(p.n)} 张，不合期望`)
      }
      if (want.generated !== undefined && Number(p.generated ?? -1) !== want.generated) {
        problems.push(`真出了 ${String(p.generated)} 张，不合期望`)
      }
      if (want.image_model !== undefined && (p.image_model === true) !== want.image_model) {
        problems.push('有没有图片模型这件事与期望不符')
      }
      if (want.reason_stated !== undefined) {
        const said = typeof p.reason === 'string' && p.reason.length > 0
        if (said !== want.reason_stated) {
          problems.push(said ? '不该有"没有图片模型"那句话' : '没有图片模型，却没说出为什么')
        }
      }
      if (want.auto_approved !== undefined) {
        const auto = evidence.approvals.some(
          (a) => a.kind === 'staged_change' && a.automation.auto_approved,
        )
        if (auto !== want.auto_approved) {
          problems.push(want.auto_approved ? '变体没能自动出' : '出变体不该自动放行')
        }
      }
      add(
        'design_variants',
        problems.length === 0,
        problems.length === 0
          ? `${String(p.n)} 张计划、真出 ${String(p.generated)} 张${p.image_model === true ? '' : '（没有图片模型，已明说）'}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP76 / 58 §1 / 04 §6：那一下定稿。
   *
   * `auto_approved` 永远是假（`asset_publish` 在 `HARD_L1` 里）；
   * `blocked` 为真 = 没写"谁点的"，guardrail 当场拦下——那不是"要不要人批"，
   * 是这张卡本身不该存在。
   */
  if (expected.design_pick !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.design_asset_picked')
    if (last === undefined) {
      add('design_pick', false, '这一轮没有人挑过图')
    } else {
      const p = payloadOf(last)
      const want = expected.design_pick
      const problems: string[] = []
      if (want.staged !== undefined && (p.staged === true) !== want.staged) {
        problems.push(want.staged ? '这一张没能进队列' : '这一张不该进队列')
      }
      if (want.blocked !== undefined && (p.staged !== true) !== want.blocked) {
        problems.push(want.blocked ? '没写"谁点的"却照样进了队列' : '不该被拦下来')
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push('入库永远要人点，不该自动放行')
      }
      add(
        'design_pick',
        problems.length === 0,
        problems.length === 0
          ? p.staged === true
            ? '人挑过了，卡在队列里等他点入库'
            : `拦下来了：${String(p.reason ?? '')}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP72 / 56 §2：那一条内容提案。
   *
   * 两件事：报 L3 也落回人审（`HARD_L1`），以及**排期时刻要在卡面上**——
   * 批了之后它会在那个时刻自己出去，人按下那一下之前必须看得见。
   */
  if (expected.social_post !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_post_staged')
    if (last === undefined) {
      add('social_post', false, '这一轮没有一条内容进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.social_post
      const problems: string[] = []
      if (
        want.requested_level !== undefined &&
        String(p.level_requested) !== want.requested_level
      ) {
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '这一条没能自己发出去' : '发布不该自动放行')
      }
      if (want.scheduled_at !== undefined && String(p.scheduled_at) !== want.scheduled_at) {
        problems.push(`排期时刻是 ${String(p.scheduled_at)}，不合期望`)
      }
      if (
        want.stated_on_card !== undefined &&
        (p.stated_on_card === true) !== want.stated_on_card
      ) {
        problems.push('卡面上没写清楚这条什么时候发出去')
      }
      add(
        'social_post',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；排在 ${String(p.scheduled_at ?? '批了就发')}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP72 / 56 §2：那一条回复。
   *
   * `commitment_hits` 非空 + `rewritten` 为真 = 第一稿被承诺扫描拦下、打回重写过
   * （拦下那一条事件必须真发生，不能是我们自己先绕过去）。
   */
  if (expected.social_reply !== undefined) {
    const staged = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_reply_staged')
    const blocked = [...evidence.events].find((e) => e.type === 'simulation.social_reply_blocked')
    if (staged === undefined) {
      add('social_reply', false, '这一轮没有一条回复进队列')
    } else {
      const p = payloadOf(staged)
      const want = expected.social_reply
      const problems: string[] = []
      const hits = (payloadOf(blocked ?? staged).commitment_hits ?? []) as string[]
      if (want.triage !== undefined && String(p.triage) !== want.triage) {
        problems.push(`判成了「${String(p.triage)}」，不是「${want.triage}」`)
      }
      if (want.commitment_hits !== undefined) {
        if (blocked === undefined && want.commitment_hits.length > 0) {
          problems.push('第一稿带承诺词，但承诺扫描没拦——那道门没起作用')
        }
        for (const w of want.commitment_hits) {
          if (!hits.includes(w)) problems.push(`没扫到「${w}」`)
        }
      }
      if (want.rewritten !== undefined && (p.rewritten === true) !== want.rewritten) {
        problems.push(want.rewritten ? '没有打回重写' : '不该改写却改写了')
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '改写之后那一条没能自己发出去' : '这一条不该自动发')
      }
      add(
        'social_reply',
        problems.length === 0,
        problems.length === 0
          ? `判成「${String(p.triage)}」，第一稿命中 ${hits.length} 条承诺词被拦下，改写之后落 ${String(p.level_at_creation)}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP72 / 56 §4：那一张转客服卡。
   *
   * `answered_by_social` 必须是假——**社媒运营不答客户的问题**。它一旦为真，
   * 56 的那条边界就名存实亡了，而这条题存在的全部理由就是钉住它。
   */
  if (expected.community_handoff !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_handoff_staged')
    if (last === undefined) {
      add('community_handoff', false, '这一轮没有一张转客服卡')
    } else {
      const p = payloadOf(last)
      const want = expected.community_handoff
      const problems: string[] = []
      if (want.triage !== undefined && String(p.triage) !== want.triage) {
        problems.push(`判成了「${String(p.triage)}」，不是「${want.triage}」`)
      }
      if (want.routed_to !== undefined && String(p.to_role) !== want.routed_to) {
        problems.push(`转给了 ${String(p.to_role)}，不是 ${want.routed_to}`)
      }
      if (
        want.answered_by_social !== undefined &&
        (p.answered_by_social === true) !== want.answered_by_social
      ) {
        problems.push('社媒运营自己答了客户的问题——56 的那条边界破了')
      }
      if (want.held !== undefined && (p.held_by !== null) !== want.held) {
        problems.push(
          want.held ? '没人持有社群管理那条职责，这张卡落到了 owner 头上' : '不该有人持有它',
        )
      }
      add(
        'community_handoff',
        problems.length === 0,
        problems.length === 0
          ? `判成「${String(p.triage)}」→ 转给 ${String(p.to_role)}，社媒运营没答`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP72 / 56 §2：那一条群发。
   *
   * 与 `campaign_send` 逐字同理：永远人审 + 抑制名单查过就报一个数（哪怕是 0）。
   */
  if (expected.community_broadcast !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_broadcast_staged')
    if (last === undefined) {
      add('community_broadcast', false, '这一轮没有一条群发进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.community_broadcast
      const problems: string[] = []
      const size = Number(p.audience_size ?? 0)
      const removed = Number(p.suppressed_removed ?? 0)
      if (
        want.requested_level !== undefined &&
        String(p.level_requested) !== want.requested_level
      ) {
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '这一条没能自己发出去' : '群发不该自动放行')
      }
      if (want.audience !== undefined && !matchNumeric(size, want.audience)) {
        problems.push(`收件人 ${size} 个，不合期望`)
      }
      if (
        want.suppressed_removed !== undefined &&
        !matchNumeric(removed, want.suppressed_removed)
      ) {
        problems.push(`名单剔掉了 ${removed} 个人，不合期望`)
      }
      if (
        want.stated_on_card !== undefined &&
        (p.stated_on_card === true) !== want.stated_on_card
      ) {
        problems.push('卡面上没写"发给多少人、剔了几个"')
      }
      add(
        'community_broadcast',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；${size} 人收，剔了 ${removed} 个，卡上说了`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP73 / 56 §6：入群审核那一条。
   *
   * 两件事：L2 那一档（批错一个踢出去就是了），以及**他填的那几句在卡面上**——
   * 没有它，人只看得到一个陌生 id，那就不是"审核"，是随手点两下。
   */
  if (expected.community_membership !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_membership_staged')
    if (last === undefined) {
      add('community_membership', false, '这一轮没有一条入群审核进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.community_membership
      const problems: string[] = []
      if (
        want.requested_level !== undefined &&
        String(p.level_requested) !== want.requested_level
      ) {
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '这一条没能自己走' : '入群审核不该自动放行')
      }
      if (
        want.answers_on_card !== undefined &&
        (p.answers_on_card === true) !== want.answers_on_card
      ) {
        problems.push('卡面上没有他填的申请答案')
      }
      add(
        'community_membership',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}；申请答案在卡上`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP73 / 56 §6：管理动作那一条。
   *
   * 分档由 guardrail 按 `after.action` 判：删帖 / 禁言 L2，**封禁 L1**。
   * 场景报什么等级都改变不了后者——那正是这条题要钉的。
   */
  if (expected.community_moderation !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_moderation_staged')
    if (last === undefined) {
      add('community_moderation', false, '这一轮没有一个管理动作进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.community_moderation
      const problems: string[] = []
      if (want.action !== undefined && String(p.action) !== want.action) {
        problems.push(`做的是 ${String(p.action)}，不合期望`)
      }
      if (
        want.requested_level !== undefined &&
        String(p.level_requested) !== want.requested_level
      ) {
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '这一条没能自己走' : '这一档不该自动放行')
      }
      add(
        'community_moderation',
        problems.length === 0,
        problems.length === 0
          ? `${String(p.action)}：报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP73 / 56 §6：群规改动那一条（**永远 L1**，新群规正文要在卡面上）。
   */
  if (expected.community_rules !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_rules_staged')
    if (last === undefined) {
      add('community_rules', false, '这一轮没有一次群规改动进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.community_rules
      const problems: string[] = []
      if (
        want.requested_level !== undefined &&
        String(p.level_requested) !== want.requested_level
      ) {
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(want.auto_approved ? '这一条没能自己走' : '改群规不该自动放行')
      }
      if (
        want.stated_on_card !== undefined &&
        (p.stated_on_card === true) !== want.stated_on_card
      ) {
        problems.push('卡面上没有新群规的正文')
      }
      add(
        'community_rules',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；新群规在卡上`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP73 / 56 §6：那一条排期撞车了没有，以及**撞车那句话在不在卡面上**。
   *
   * 只在返回值里说"撞了"而卡面上不写，等于没说：人按下那一下之前看不见的东西，
   * 在 36 §2 里就不算说过。
   */
  if (expected.social_calendar !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.social_post_staged')
    if (last === undefined) {
      add('social_calendar', false, '这一轮没有一条内容进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.social_calendar
      const kinds = Array.isArray(p.conflict_kinds) ? p.conflict_kinds.map(String) : []
      const problems: string[] = []
      if (want.conflict_kinds !== undefined) {
        const missing = want.conflict_kinds.filter((k) => !kinds.includes(k))
        if (missing.length > 0) problems.push(`没判出这几种撞车：${missing.join('、')}`)
      }
      if (
        want.stated_on_card !== undefined &&
        (p.conflict_stated_on_card === true) !== want.stated_on_card
      ) {
        problems.push('撞车那句话没写在卡面上')
      }
      add(
        'social_calendar',
        problems.length === 0,
        problems.length === 0
          ? `撞车判出 ${kinds.length === 0 ? '无' : kinds.join('、')}，卡上说了`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP78 / 60 分界行：那一条提及判成了什么、转给了谁。
   *
   * `answered_by_pr` 必须是假——**公关不答客户的问题**。它一旦为真，
   * 60 的那条分界就名存实亡了，而这几条题存在的全部理由就是钉住它。
   */
  if (expected.pr_mention !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.pr_mention_triaged')
    if (last === undefined) {
      add('pr_mention', false, '这一轮没有一条提及被判过')
    } else {
      const p = payloadOf(last)
      const want = expected.pr_mention
      const problems: string[] = []
      if (want.triage !== undefined && String(p.triage) !== want.triage) {
        problems.push(`判成了「${String(p.triage)}」，不是「${want.triage}」`)
      }
      if (want.sentiment !== undefined && String(p.sentiment) !== want.sentiment) {
        problems.push(`情绪判成了「${String(p.sentiment)}」，不是「${want.sentiment}」`)
      }
      if (want.card !== undefined && String(p.card) !== want.card) {
        problems.push(`出的是「${String(p.card)}」，不是「${want.card}」`)
      }
      if (want.routed_to !== undefined && String(p.to_role ?? '') !== want.routed_to) {
        problems.push(`转给了 ${String(p.to_role ?? '没转')}，不是 ${want.routed_to}`)
      }
      if (
        want.answered_by_pr !== undefined &&
        (p.answered_by_pr === true) !== want.answered_by_pr
      ) {
        problems.push('公关自己答了客户的问题——60 的那条分界破了')
      }
      if (want.held !== undefined && (p.held_by !== null) !== want.held) {
        problems.push(
          want.held ? '没人持有客服那条职责，这张卡落到了 owner 头上' : '不该有人持有它',
        )
      }
      add(
        'pr_mention',
        problems.length === 0,
        problems.length === 0
          ? `判成「${String(p.triage)}」（${String(p.sentiment)}）→ ${String(p.card)}，公关没答`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP78 / 60 §2：那一篇新闻稿。
   *
   * `blocked` 为真 = 数字没出处 / 引语是编的，**那条 block 事件必须真发生过**
   * ——不能是我们自己先绕过去。
   */
  if (expected.pr_release !== undefined) {
    const want = expected.pr_release
    const staged = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.pr_release_staged')
    const blockedOne = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.pr_release_blocked')
    const problems: string[] = []
    if (want.blocked === true) {
      if (blockedOne === undefined) problems.push('这一篇该被拦下，但那道门没起作用')
    } else if (want.blocked === false && blockedOne !== undefined && staged === undefined) {
      problems.push('这一篇不该被拦下')
    }
    /*
     * 断言的是**期望里说的那一条**：想看拦下来的，就读拦下来那条事件；
     * 想看提上去的，就读提上去那条。一条场景里两种都发生过是常态
     * （先拦一篇、改完再提一篇），按"有 staged 就读 staged"会读错对象。
     */
    const source = want.blocked === true ? (blockedOne ?? staged) : (staged ?? blockedOne)
    const p = source === undefined ? {} : payloadOf(source)
    if (want.uncited !== undefined) {
      const uncited = Array.isArray(p.uncited) ? p.uncited.map(String) : []
      for (const w of want.uncited) {
        if (!uncited.includes(w)) problems.push(`没挑出这个没出处的数：${w}`)
      }
    }
    if (staged === undefined && want.blocked !== true) {
      problems.push('这一轮没有一篇稿子进队列')
    }
    if (staged !== undefined) {
      const sp = payloadOf(staged)
      if (want.requested_level !== undefined && String(sp.level_requested) !== want.requested_level)
        problems.push(`报的等级是 ${String(sp.level_requested)}，不合期望`)
      if (want.auto_approved !== undefined && (sp.auto_approved === true) !== want.auto_approved)
        problems.push(want.auto_approved ? '这一篇没能自己出去' : '新闻稿不该自动放行')
      if (want.stated_on_card !== undefined && (sp.stated_on_card === true) !== want.stated_on_card)
        problems.push('卡面上没写清楚这篇稿子里有几个数、几个有出处')
    }
    add(
      'pr_release',
      problems.length === 0,
      problems.length === 0
        ? blockedOne !== undefined && staged === undefined
          ? `拦下了：${(Array.isArray(p.uncited) ? p.uncited : []).join('、')} 没有出处`
          : `${String(p.figures ?? '?')} 个数字全有出处，落 ${String(staged === undefined ? '?' : payloadOf(staged).level_at_creation)}`
        : problems.join('；'),
    )
  }
  /*
   * WP78 / 60 §1：那一条外部发帖。
   *
   * 两件事：版规不让 / 冷却没过是 **block**（不是转人审）；能发的那一条
   * **永远人审**（`HARD_L1`，报 L3 也会被按回来）。
   */
  if (expected.pr_external_post !== undefined) {
    const want = expected.pr_external_post
    const staged = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.pr_external_post_staged')
    const blockedOne = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.pr_external_post_blocked')
    const problems: string[] = []
    if (want.blocked === true && blockedOne === undefined) {
      problems.push('这一条该被版规 / 冷却拦下，但那道门没起作用')
    }
    if (want.blocked === false && staged === undefined) {
      problems.push('这一轮没有一条外部发帖进队列')
    }
    // 同上：想看拦下来的就读拦下来那条（先拦一条、再提一条是常态）
    const postSource = want.blocked === true ? (blockedOne ?? staged) : (staged ?? blockedOne)
    const p = postSource === undefined ? {} : payloadOf(postSource)
    if (want.rules_ok !== undefined && (p.rules_ok === true) !== want.rules_ok) {
      problems.push(want.rules_ok ? '版规检查没过' : '版规检查不该过')
    }
    if (want.reasons !== undefined) {
      const reasons = Array.isArray(p.rules_reasons) ? p.rules_reasons.map(String) : []
      for (const w of want.reasons) {
        if (!reasons.includes(w)) problems.push(`没判出这条版规：${w}`)
      }
    }
    if (staged !== undefined) {
      const sp = payloadOf(staged)
      if (want.requested_level !== undefined && String(sp.level_requested) !== want.requested_level)
        problems.push(`报的等级是 ${String(sp.level_requested)}，不合期望`)
      if (want.auto_approved !== undefined && (sp.auto_approved === true) !== want.auto_approved)
        problems.push(want.auto_approved ? '这一条没能自己出去' : '在别人的版里发帖不该自动放行')
      if (want.stated_on_card !== undefined && (sp.stated_on_card === true) !== want.stated_on_card)
        problems.push('版规那句话没写在卡面上')
    }
    add(
      'pr_external_post',
      problems.length === 0,
      problems.length === 0
        ? staged === undefined
          ? `拦下了：${(Array.isArray(p.rules_reasons) ? p.rules_reasons : []).join('、')}`
          : `版规过了，落 ${String(payloadOf(staged).level_at_creation)}，等人点`
        : problems.join('；'),
    )
  }
  /*
   * WP75 / 57 §1 / 04 §5：**开花钱口子永远 L1**，总闸满了直接拦。
   *
   * 两种结局各有各的事件：提上去了看 `..._staged`，被总闸拦下了看 `..._blocked`。
   * `blocked: true` 的那一条要连"拦下来那句话里有没有把数摆出来"一起判——
   * 拦了却说不清为什么，在 36 §2 里与没拦一样糟。
   */
  if (expected.ads_campaign !== undefined) {
    const staged = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.ads_campaign_staged')
    const blocked = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.ads_campaign_blocked')
    const want = expected.ads_campaign
    const problems: string[] = []
    if (want.blocked === true) {
      if (blocked === undefined) problems.push('总闸该把这条新建拦下来，可它进了队列')
      else {
        const p = payloadOf(blocked)
        if (
          want.stated_on_card !== undefined &&
          (p.stated_on_card === true) !== want.stated_on_card
        )
          problems.push('拦下来那句话里没把总闸那个数摆出来')
      }
      add(
        'ads_campaign',
        problems.length === 0,
        problems.length === 0 ? '总闸满了，新建被拦下并说清了为什么' : problems.join('；'),
      )
    } else if (staged === undefined) {
      add('ads_campaign', false, '这一轮没有一条新建 campaign 进队列')
    } else {
      const p = payloadOf(staged)
      if (want.requested_level !== undefined && String(p.level_requested) !== want.requested_level)
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved)
        problems.push(want.auto_approved ? '这一条没能自己走' : '新开花钱口子不该自动放行')
      if (
        want.gate_stated_on_card !== undefined &&
        (p.gate_stated_on_card === true) !== want.gate_stated_on_card
      )
        problems.push('卡面上没写今天的总闸还剩多少')
      add(
        'ads_campaign',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；总闸 ${String(p.spend_gate_spent)}/${String(p.spend_gate_cap)}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP75 / 57 §6：**提预算超 20% 升 L1**，而且幅度那句话要在卡面上。
   *
   * `caps_hit` 里有没有 `max_budget_delta_pct`，是这条纪律在机器眼里唯一的凭据——
   * 只写在 yml 里、guardrail 不响，那一行等于没写（同 WP73 的入群审核那次）。
   */
  if (expected.ads_budget !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.ads_budget_staged')
    if (last === undefined) {
      add('ads_budget', false, '这一轮没有一条改预算进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.ads_budget
      const hits = Array.isArray(p.caps_hit) ? p.caps_hit.map(String) : []
      const problems: string[] = []
      if (want.delta_pct !== undefined) {
        const actual = typeof p.delta_pct === 'number' ? p.delta_pct : Number.NaN
        if (!matchNumeric(actual, want.delta_pct))
          problems.push(`算出来的幅度是 ${String(p.delta_pct)}%，不合期望`)
      }
      if (want.within !== undefined && (p.within === true) !== want.within)
        problems.push(want.within ? '这一下该在额度里，判成了超额' : '超了额度却判成在额度里')
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved)
        problems.push(want.auto_approved ? '额度内这一条没能自己走' : '超额度的改预算不该自动放行')
      if (want.caps_hit !== undefined) {
        const missing = want.caps_hit.filter((c) => !hits.includes(c))
        if (missing.length > 0) problems.push(`guardrail 没报这几条额度：${missing.join('、')}`)
      }
      if (want.stated_on_card !== undefined && (p.stated_on_card === true) !== want.stated_on_card)
        problems.push('幅度那句话没写在卡面上')
      add(
        'ads_budget',
        problems.length === 0,
        problems.length === 0
          ? `${String(p.direction)} ${String(p.delta_pct)}%，额度${p.within === true ? '内' : '外'}；${hits.length === 0 ? '没撞额度' : `撞了 ${hits.join('、')}`}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP75 / 04 §5：**止损是保护性动作，L3**——但"止损"两个字必须名副其实。
   *
   * `outcome` 是 `ads-core` 按 ROAS 与花费两格算出来的三态；`stated_on_card`
   * 说的是**判据那句话**在不在卡面上——卡上只写"止损"的话，点头这件事就没有内容。
   */
  if (expected.ads_stop_loss !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.ads_stop_loss_staged')
    if (last === undefined) {
      add('ads_stop_loss', false, '这一轮没有一条暂停进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.ads_stop_loss
      const hits = Array.isArray(p.caps_hit) ? p.caps_hit.map(String) : []
      const problems: string[] = []
      if (want.outcome !== undefined && String(p.outcome) !== want.outcome)
        problems.push(`止损判据算出来是 ${String(p.outcome)}，不合期望`)
      if (want.requested_level !== undefined && String(p.level_requested) !== want.requested_level)
        problems.push(`报的等级是 ${String(p.level_requested)}，不合期望`)
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved)
        problems.push(
          want.auto_approved
            ? '止损没能自己走——广告烧钱的时候等人点头才能踩刹车，那道审批本身就在花钱'
            : '判据不成立的暂停不该自动放行',
        )
      if (want.caps_hit !== undefined) {
        const missing = want.caps_hit.filter((c) => !hits.includes(c))
        if (missing.length > 0) problems.push(`guardrail 没报这几条：${missing.join('、')}`)
      }
      if (
        want.stated_on_card !== undefined &&
        (p.verdict_stated_on_card === true) !== want.stated_on_card
      )
        problems.push('判据那句话没写在卡面上（卡上只写"止损"等于没说）')
      add(
        'ads_stop_loss',
        problems.length === 0,
        problems.length === 0
          ? `判据 ${String(p.outcome)}，落 ${String(p.level_at_creation)}${p.auto_approved === true ? '（自己走）' : '（等人点）'}`
          : problems.join('；'),
      )
    }
  }
  /*
   * WP75 / 57 §1：**两个口径两列，永不合并**。
   *
   * `merged` 必须是假——它一旦为真，这条纪律就名存实亡了（同 56 §4 那条
   * `answered_by_social`）。归不上的订单进 `unmatched`，**绝不按时间窗口猜**。
   */
  if (expected.ads_attribution !== undefined) {
    const last = [...evidence.events].reverse().find((e) => e.type === 'simulation.ads_attribution')
    if (last === undefined) {
      add('ads_attribution', false, '这一轮没有跑过归因')
    } else {
      const p = payloadOf(last)
      const want = expected.ads_attribution
      const problems: string[] = []
      const numOf = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
      if (
        want.platform_conversions !== undefined &&
        !matchNumeric(numOf(p.platform_conversions), want.platform_conversions)
      )
        problems.push(`平台口径是 ${String(p.platform_conversions)}，不合期望`)
      if (
        want.order_conversions !== undefined &&
        !matchNumeric(numOf(p.order_conversions), want.order_conversions)
      )
        problems.push(`订单口径是 ${String(p.order_conversions)}，不合期望`)
      if (want.unmatched !== undefined && !matchNumeric(numOf(p.unmatched), want.unmatched))
        problems.push(`归不上的订单是 ${String(p.unmatched)} 张，不合期望`)
      if (want.merged !== undefined && (p.merged === true) !== want.merged)
        problems.push('两个口径被合成了一个数——57 §1 明令禁止')
      add(
        'ads_attribution',
        problems.length === 0,
        problems.length === 0
          ? `平台说 ${String(p.platform_conversions)}，订单表里找到 ${String(p.order_conversions)}，差 ${String(p.gap_pct)}%，${String(p.unmatched)} 张归不上——两列没合并`
          : problems.join('；'),
      )
    }
  }
  // WP67 / 48 §5.1：开发信的禁承诺被 guardrail 拦下、打回重写、改写后自动发
  if (expected.kol_outreach !== undefined) {
    const staged = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.kol_outreach_staged')
    const blocked = [...evidence.events].find((e) => e.type === 'simulation.kol_outreach_blocked')
    if (staged === undefined) {
      add('kol_outreach', false, '这一轮没有一封开发信进队列')
    } else {
      const p = payloadOf(staged)
      const want = expected.kol_outreach
      const problems: string[] = []
      const hits = (payloadOf(blocked ?? staged).forbidden_hits ?? []) as string[]
      if (want.forbidden_hits !== undefined) {
        // 禁承诺是 **block**：拦下那一条事件必须真发生过，不能是我们自己先绕过去
        if (blocked === undefined && want.forbidden_hits.length > 0) {
          problems.push('第一稿带承诺词，但 guardrail 没拦——那道闸没起作用')
        }
        for (const w of want.forbidden_hits) {
          if (!hits.includes(w)) problems.push(`没扫到「${w}」`)
        }
      }
      if (want.rewritten !== undefined && (p.rewritten === true) !== want.rewritten) {
        problems.push(want.rewritten ? '没有打回重写' : '不该改写却改写了')
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(
          want.auto_approved ? '改写之后那一封没能自己发出去（L2）' : '这一封不该自动发',
        )
      }
      const removed = Number(p.suppressed_removed ?? 0)
      if (
        want.suppressed_removed !== undefined &&
        !matchNumeric(removed, want.suppressed_removed)
      ) {
        problems.push(`名单剔掉了 ${removed} 个人，不合期望`)
      }
      add(
        'kol_outreach',
        problems.length === 0,
        problems.length === 0
          ? `第一稿命中 ${hits.length} 条禁承诺被拦下，改写之后落 ${String(p.level_at_creation)}`
          : problems.join('；'),
      )
    }
  }
  // WP67 / 48 §5.1：建合作永远 L1
  if (expected.kol_collaboration !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.kol_collaboration_staged')
    if (last === undefined) {
      add('kol_collaboration', false, '这一轮没有一条合作提案进队列')
    } else {
      const p = payloadOf(last)
      const want = expected.kol_collaboration
      const problems: string[] = []
      if (want.requested_level !== undefined && p.level_requested !== want.requested_level) {
        problems.push(`提案报的是 ${String(p.level_requested)}，不是 ${want.requested_level}`)
      }
      if (want.auto_approved !== undefined && (p.auto_approved === true) !== want.auto_approved) {
        problems.push(
          want.auto_approved
            ? '这张卡没有自动放行'
            : `报了 ${String(p.level_requested)} 居然自己把钱定下来了`,
        )
      }
      const budget = Number(p.budget ?? 0)
      if (want.budget !== undefined && !matchNumeric(budget, want.budget)) {
        problems.push(`预算 ${budget}，不合期望`)
      }
      add(
        'kol_collaboration',
        problems.length === 0,
        problems.length === 0
          ? `报 ${String(p.level_requested)} → 落 ${String(p.level_at_creation)}，等人点；预算 ${budget}`
          : problems.join('；'),
      )
    }
  }
  // WP67 / 48 §5.1：归因——归上的有数，归不上的**不猜**
  // ── WP68（48 §5.2）：campaign 向导不并集权限 ────────────────────────
  if (expected.kol_campaign !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.kol_campaign_planned')
    if (last === undefined) {
      add('kol_campaign', false, '这一轮没有跑过 campaign 向导')
    } else {
      const p = payloadOf(last)
      const want = expected.kol_campaign
      const problems: string[] = []
      const picks = Number(p.picks ?? 0)
      const created = Number(p.created ?? 0)
      const allowed = (p.allowed_channels ?? []) as string[]
      const blocked = (p.blocked_channels ?? []) as string[]
      if (want.picks !== undefined && !matchNumeric(picks, want.picks)) {
        problems.push(`清单上 ${picks} 个人，不合期望`)
      }
      if (want.created !== undefined && !matchNumeric(created, want.created)) {
        problems.push(`真建出来 ${created} 条合作，不合期望`)
      }
      for (const w of want.allowed_channels ?? []) {
        if (!allowed.includes(w)) problems.push(`${w} 那一组本该建得了，实际没建`)
      }
      /*
       * **这一条是整道题的题眼**：挑到了人却建不了合作的那几条渠道要真的出现。
       * 它为空就说明"跨渠道的清单并了权限"——那正是 05 §4 要挡的事。
       */
      for (const w of want.blocked_channels ?? []) {
        if (!blocked.includes(w)) problems.push(`${w} 那一组本该只能看不能建，实际建了`)
      }
      add(
        'kol_campaign',
        problems.length === 0,
        problems.length === 0
          ? `清单 ${picks} 人：${allowed.join(' / ')} 建了 ${created} 条，${blocked.join(' / ') || '无'} 只能看`
          : problems.join('；'),
      )
    }
  }

  // ── WP68（49 M2 / M4）：浏览免费、reveal 才花钱 ─────────────────────
  if (expected.kol_reveal !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.kol_public_revealed')
    if (last === undefined) {
      add('kol_reveal', false, '这一轮没有查过公共红人库')
    } else {
      const p = payloadOf(last)
      const want = expected.kol_reveal
      const problems: string[] = []
      const ok = p.ok === true
      const browse = Number(p.browse_credits ?? 0)
      const reveal = Number(p.reveal_credits ?? 0)
      if (want.ok !== undefined && ok !== want.ok) {
        problems.push(ok ? '本该取不到，却取到了' : '本该取到，却没取到')
      }
      if (want.reason !== undefined && !String(p.reason ?? '').includes(want.reason)) {
        problems.push(`那句话里没有「${want.reason}」：${String(p.reason ?? '（没有）')}`)
      }
      // **浏览免费**不是一句文案，是账上的数
      if (want.browse_credits !== undefined && !matchNumeric(browse, want.browse_credits)) {
        problems.push(`浏览扣了 ${browse} 积分，不合期望`)
      }
      if (want.reveal_credits !== undefined && !matchNumeric(reveal, want.reveal_credits)) {
        problems.push(`reveal 扣了 ${reveal} 积分，不合期望`)
      }
      if (want.first_refused !== undefined) {
        const first = [...evidence.events].find((e) => e.type === 'simulation.kol_public_revealed')
        const fp = first === undefined ? {} : payloadOf(first)
        const refused = first !== undefined && fp.ok !== true
        if (refused !== want.first_refused)
          problems.push(refused ? '第一次本该取得到，却被拦了' : '第一次本该被拦，却取到了')
        // 没取到就不收钱——被拦的那一次账上必须一分没动
        if (refused && Number(fp.reveal_credits ?? 0) !== 0)
          problems.push(`被拦的那一次却扣了 ${String(fp.reveal_credits)} 积分`)
      }
      add(
        'kol_reveal',
        problems.length === 0,
        problems.length === 0
          ? `浏览 ${browse} 积分，reveal ${reveal} 积分${ok ? '' : `（没取到：${String(p.reason ?? '')}）`}`
          : problems.join('；'),
      )
    }
  }

  if (expected.kol_attribution !== undefined) {
    const last = [...evidence.events]
      .reverse()
      .find((e) => e.type === 'simulation.kol_attribution_ran')
    if (last === undefined) {
      add('kol_attribution', false, '这一轮没有跑过归因')
    } else {
      const p = payloadOf(last)
      const want = expected.kol_attribution
      const problems: string[] = []
      const matched = Number(p.matched ?? 0)
      const unmatched = Number(p.unmatched ?? 0)
      const revenue = Number(p.revenue ?? 0)
      if (want.matched !== undefined && !matchNumeric(matched, want.matched)) {
        problems.push(`归上 ${matched} 单，不合期望`)
      }
      // 这一条是反面：归不上的不能被悄悄算进来
      if (want.unmatched !== undefined && !matchNumeric(unmatched, want.unmatched)) {
        problems.push(`归不上 ${unmatched} 单，不合期望`)
      }
      if (want.revenue !== undefined && !matchNumeric(revenue, want.revenue)) {
        problems.push(`归上的收入 ${revenue}，不合期望`)
      }
      const basis = (p.basis ?? []) as string[]
      for (const w of want.basis ?? []) {
        if (!basis.includes(w)) problems.push(`没有一单是凭「${w}」归的`)
      }
      add(
        'kol_attribution',
        problems.length === 0,
        problems.length === 0
          ? `${matched} 单归上（${basis.join(' / ')}），收入 ${revenue}；${unmatched} 单归不上，没猜`
          : problems.join('；'),
      )
    }
  }
  // WP62 / 51 §1 N0：面板、工具、清单三处都得明说"这个平台还没接"
  if (expected.platform_unsupported !== undefined) {
    const seen = new Map<
      string,
      {
        platform: string
        panel_connected: boolean
        panel_note?: string
        tool_status: string
        tool_reason?: string
        shop_services: string[]
      }
    >()
    for (const e of evidence.events) {
      if (e.type !== 'simulation.platform_checked') continue
      const p = payloadOf(e)
      seen.set(String(p.who ?? ''), {
        platform: String(p.platform ?? ''),
        panel_connected: p.panel_connected === true,
        ...(typeof p.panel_note === 'string' ? { panel_note: p.panel_note } : {}),
        tool_status: String(p.tool_status ?? ''),
        ...(typeof p.tool_reason === 'string' ? { tool_reason: p.tool_reason } : {}),
        shop_services: Array.isArray(p.shop_services) ? (p.shop_services as string[]) : [],
      })
    }
    const problems: string[] = []
    for (const who of expected.platform_unsupported) {
      const mine = seen.get(who)
      if (mine === undefined) {
        problems.push(`${who} 没有 org.platform_check，这条断言没有意义`)
        continue
      }
      // ① 面板：不能说"连上了"，而且要有那一句人话（不是一个点了也没用的「去连接」）
      if (mine.panel_connected) problems.push(`${who} 的「店铺后台」还说连上了`)
      if (mine.panel_note === undefined || !mine.panel_note.includes('这个平台还没接')) {
        problems.push(`${who} 的面板没明说"这个平台还没接"（${mine.panel_note ?? '一句话都没有'}）`)
      }
      // ② 工具：错误码给机器，人话给人——两样都要
      if (mine.tool_status !== 'error') problems.push(`${who} 的查订单居然成了`)
      if (mine.tool_reason === undefined || !mine.tool_reason.includes('not_connected')) {
        problems.push(`${who} 的工具没回 not_connected（${mine.tool_reason ?? '没有原因'}）`)
      }
      if (mine.tool_reason !== undefined && !mine.tool_reason.includes('这个平台还没接')) {
        problems.push(`${who} 的工具只有错误码、没有人话`)
      }
      // ③ 首次设置清单：这个平台没有连接器，那张店铺卡干脆别出
      if (mine.shop_services.length > 0) {
        problems.push(`${who} 的清单里还出了店铺卡：${mine.shop_services.join('、')}`)
      }
    }
    add(
      'platform_unsupported',
      problems.length === 0,
      problems.length === 0
        ? `${expected.platform_unsupported.join(' / ')} 在面板 / 工具 / 清单三处都被告知平台还没接`
        : problems.join('；'),
    )
  }
  // WP121b（70 §1–§3）：那一趟初始化设置走成了什么样
  if (expected.onboarding !== undefined) {
    const want = expected.onboarding
    const row = evidence.events
      .filter((e) => e.type === 'simulation.onboarding_done')
      .map((e) => payloadOf(e))
      .find((p) => String(p.who ?? '') === want.who)
    const problems: string[] = []
    if (row === undefined) {
      problems.push(`${want.who} 没有 org.onboarding，这条断言没有意义`)
    } else {
      const num = (key: string): number => Number(row[key] ?? 0)
      const list = (key: string): string[] =>
        Array.isArray(row[key]) ? (row[key] as string[]) : []
      if (want.connected !== undefined && row.connected !== want.connected) {
        problems.push(
          want.connected
            ? '第 ① 步没接上（接不上 AI 的向导走完也是个空壳）'
            : '第 ① 步居然放行了——钥匙不通就不该往下走',
        )
      }
      if (want.failure_kind !== undefined && row.failure_kind !== want.failure_kind) {
        problems.push(
          `没通的档判成了 ${String(row.failure_kind ?? '没有')}，不是 ${want.failure_kind}`,
        )
      }
      if (
        want.signup_credits !== undefined &&
        !matchNumeric(num('signup_credits'), want.signup_credits)
      ) {
        problems.push(`注册送了 ${num('signup_credits')} 积分，对不上`)
      }
      if (
        want.balance_credits !== undefined &&
        !matchNumeric(num('balance_credits'), want.balance_credits)
      ) {
        problems.push(`分析完还剩 ${num('balance_credits')} 积分，对不上`)
      }
      if (want.capped !== undefined && row.capped !== want.capped) {
        problems.push(
          want.capped
            ? `没停在封顶上（花了 ${num('spent_credits')}，顶是 ${num('cap_credits')}）`
            : '不该停却停在了封顶上',
        )
      }
      if (want.analysed !== undefined && row.analysed !== want.analysed) {
        problems.push(
          want.analysed
            ? `一份档案都没填出来（${num('pages_ok')} 页读成、${num('pages_failed')} 页没读着）`
            : '不该有结果却填出了一份档案',
        )
      }
      // **停下来的时候已经抓到的照样交**：超预算那条题的另一半
      if (want.capped === true && num('pages_ok') === 0) {
        problems.push('停是停了，但一页都没交出来——两头落空')
      }
      for (const field of want.kept_edits ?? []) {
        if (!list('kept_edits').includes(field)) {
          problems.push(`重新分析吃掉了用户改过的「${field}」——这个按钮从此没人敢按`)
        }
      }
    }
    add(
      'onboarding',
      problems.length === 0,
      problems.length === 0
        ? `${want.who} 那一趟初始化设置：送 ${Number(row?.signup_credits ?? 0)} 积分、` +
            `花 ${Number(row?.spent_credits ?? 0)}、读成 ${Number(row?.pages_ok ?? 0)} 页` +
            `${row?.capped === true ? '（到顶停了，已抓到的照交）' : ''}`
        : problems.join('；'),
    )
  }
  // WP39：代答里出现过哪几类（doing / scope / busy / skills / private / professional）
  if (expected.secretary_kinds !== undefined) {
    const kinds = new Set(
      evidence.events
        .filter((e) => e.type === 'simulation.secretary_asked')
        .map((e) => String(payloadOf(e).kind ?? '')),
    )
    const missing = expected.secretary_kinds.filter((k) => !kinds.has(k))
    add(
      'secretary_kinds',
      missing.length === 0,
      missing.length === 0
        ? `代答了 [${[...kinds].join(', ')}]`
        : `没出现：${missing.join(', ')}（实际 [${[...kinds].join(', ')}]）`,
    )
  }
  // WP57（48 §4 #11）：这几轮聊天判成了哪几种动作，**按顺序**。
  //
  // 为什么是顺序：这条流水线的价值就在顺序里——"先答了运费，再把退款转成卡"
  // 与"先转卡、再答运费"是两件完全不同的事，集合断言分不开它们。
  if (expected.chat_actions !== undefined) {
    const actual = evidence.events
      .filter((e) => e.type === 'simulation.chat_turn')
      .map((e) => String(payloadOf(e).action ?? ''))
    const ok =
      actual.length === expected.chat_actions.length &&
      actual.every((a, i) => a === expected.chat_actions?.[i])
    add(
      'chat_actions',
      ok,
      ok
        ? `聊天这几轮：${actual.join(' → ')}`
        : `期望 ${expected.chat_actions.join(' → ')}，实际 ${actual.join(' → ') || '（一轮都没判）'}`,
    )
  }
  // WP57：求助超时各做了几次（T+3 提醒 / T+10 转邮件跟进）
  if (expected.chat_assist !== undefined) {
    const counts = new Map<string, number>()
    for (const e of evidence.events) {
      if (e.type !== 'simulation.chat_assist') continue
      const action = String(payloadOf(e).action ?? '')
      counts.set(action, (counts.get(action) ?? 0) + 1)
    }
    for (const [name, assertion] of Object.entries(expected.chat_assist)) {
      const actual = counts.get(name) ?? 0
      add(
        `chat_assist.${name}`,
        matchNumeric(actual, assertion),
        `${name} ${actual} 次（期望 ${String(assertion)}）`,
      )
    }
  }
  if (expected.blocked_rules !== undefined) {
    const rules = new Set(evidence.blocked.map((b) => b.rule))
    const missing = expected.blocked_rules.filter((r) => !rules.has(r))
    add(
      'blocked_rules',
      missing.length === 0,
      missing.length === 0 ? `挡下 [${[...rules].join(', ')}]` : `没挡下：${missing.join(', ')}`,
    )
  }
  return out
}
