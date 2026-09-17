/**
 * `expected` 的结构化断言（26 §1）。断言不变量与结构，**不断言措辞**——
 * `reply_omits` / `reply_includes_any` 是"必须没有 / 至少有一个"的白名单，不是逐字比对。
 */
import type { ChangeKind } from '@agentsws/contracts'
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
