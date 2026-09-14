/**
 * Extracted from KefuAgent src/lib/support/verticals/goods/boundaries.ts
 * (GOODS_POLICY_BOUNDARIES, 10 条) 与 src/lib/support/policy/policy-boundaries.ts
 * (matchTriggeredBoundaries / validatePolicyBoundaryAnswer / buildAnsweredBoundariesPromptBlock)，
 * rewritten for agentsws contracts.
 *
 * 产品原则（product-principles-v2）：**业务边界不预收集**。
 * AI 第一次遇到一条没答过的边界时，以选择题问一次（36 §2.2 的 `policy_change` 问句形态卡），
 * 答案沉淀为策略（19 的 `layer: 'policy'` 事实 / 24 的 lesson → 次日提案）。
 *
 * 舍掉的：Drizzle 表、`ON CONFLICT` 并发写、fail-open 的 console 吞异常、
 * crawlPrefill 与 factSignature（源页复核属于 KefuAgent 的爬虫回路，我们这边由 19 的
 * 事实卡有效期与冲突双值承担）。留下的是**问什么、给哪几个选项、什么时候问**。
 *
 * 前 10 条与 KefuAgent 的 key / 问句 / 选项 id / 选项值逐条对齐（已答行以 id 关联，不可改名）；
 * 后 5 条是中台侧新增（丢件赔付、地址写错、优惠券补发、差评应对、升级人工），
 * 补齐 32 §5 客服职责包要求的最小边界集。
 */
import type { Iso8601, PersonId } from '@agentsws/contracts'
import type {
  BoundaryItem,
  BoundaryOption,
  Classification,
  SupportIntent,
  SupportPolicy,
} from './types.js'
import { GOODS_BOUNDARIES } from './verticals/goods/boundaries.js'
import { getVerticalPack } from './verticals/index.js'
import type { Vertical } from './verticals/types.js'

/**
 * 实物商品的业务边界（真身已搬到 `verticals/goods/boundaries.ts`，这里只转出）。
 *
 * 保留这个名字是因为它已经是**外面在用的名字**（stand-ins、server、测试）；
 * 不带垂直参数调用时的默认 registry 也是它——与 WP54 之前逐条相同。
 */
export const SUPPORT_BOUNDARIES: readonly BoundaryItem[] = GOODS_BOUNDARIES

/** 按垂直取 registry（48 v2 L2）。拿不到垂直时回落实物。 */
export function boundariesOf(vertical?: Vertical): readonly BoundaryItem[] {
  return getVerticalPack(vertical).boundaries
}

const BY_ID = new Map(SUPPORT_BOUNDARIES.map((b) => [b.id, b]))

export function findBoundary(
  id: string,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): BoundaryItem | undefined {
  return registry === SUPPORT_BOUNDARIES ? BY_ID.get(id) : registry.find((b) => b.id === id)
}

export function findBoundaryOption(
  boundary: BoundaryItem,
  option_id: string,
): BoundaryOption | undefined {
  return boundary.options.find((o) => o.id === option_id)
}

function signalsOf(input: SupportIntent | Classification): {
  intent: SupportIntent
  risk_terms: readonly string[]
} {
  return typeof input === 'string'
    ? { intent: input, risk_terms: [] }
    : { intent: input.intent, risk_terms: input.entities.risk_terms }
}

/** 一条边界是否被这次来信触发。任一维度命中即触发（OR）；`declared` 的从不触发。 */
export function boundaryTriggered(
  boundary: BoundaryItem,
  input: SupportIntent | Classification,
  change_kinds: readonly string[] = [],
  l3_categories: readonly string[] = [],
): boolean {
  if (boundary.wiring !== 'enforced') return false
  const { intent, risk_terms } = signalsOf(input)
  const t = boundary.applies_when
  if (t.intents?.includes(intent) === true) return true
  if (t.risk_terms?.some((term) => risk_terms.includes(term)) === true) return true
  if (t.change_kinds?.some((k) => change_kinds.includes(k)) === true) return true
  // WP54：自主发送门接上之后（48 §4 第 3 项）调用方会把命中的 L3 类目递进来
  if (t.l3_categories?.some((c) => l3_categories.includes(c)) === true) return true
  return false
}

/** 查哪张 registry、按哪些信号判触发。`registry` 给了就用它，否则按垂直取。 */
export interface BoundaryLookupOptions {
  change_kinds?: readonly string[]
  /** 命中的 L3 类目（自主发送门接上之后才有值）。 */
  l3_categories?: readonly string[]
  /** 48 v2 L2：工作区卖的是什么。不给就实物。 */
  vertical?: Vertical
  /** 显式指定 registry（测试与迁移用）；给了就不看 `vertical`。 */
  registry?: readonly BoundaryItem[]
}

/** 只看 `boundary_id`：调用方手里可能只有"答过哪些"的轻量列表。 */
export interface AnsweredBoundaryRef {
  boundary_id: string
}

export function isAnswered(boundary_id: string, policies: readonly AnsweredBoundaryRef[]): boolean {
  return policies.some((p) => p.boundary_id === boundary_id)
}

/**
 * 这次来信触发、但还没答过的边界，按注册表顺序。
 * "只问一次"由调用方的 `dedupe_key`（14 §4）与这里的 `policies` 一起保证。
 */
export function findUnansweredBoundaries(
  input: SupportIntent | Classification,
  policies: readonly AnsweredBoundaryRef[],
  opts: BoundaryLookupOptions = {},
): BoundaryItem[] {
  const registry = opts.registry ?? boundariesOf(opts.vertical)
  return registry.filter(
    (b) =>
      boundaryTriggered(b, input, opts.change_kinds ?? [], opts.l3_categories ?? []) &&
      !isAnswered(b.id, policies),
  )
}

/** 第一条没答过的边界——一次只问一个问题（36 §2.2 选择题卡）。 */
export function findUnansweredBoundary(
  input: SupportIntent | Classification,
  policies: readonly AnsweredBoundaryRef[],
  opts: BoundaryLookupOptions = {},
): BoundaryItem | undefined {
  return findUnansweredBoundaries(input, policies, opts)[0]
}

/* ------------------------------------------------------------------ */
/* 答案 → 策略                                                          */
/* ------------------------------------------------------------------ */

export type BoundaryAnswer =
  | { kind: 'option'; option_id: string }
  | { kind: 'custom'; text: string }
  | { kind: 'decline' }

export const MAX_CUSTOM_ANSWER_CHARS = 2000

export type AnswerError = 'unknown_boundary' | 'unknown_option' | 'invalid_answer'

/** 纯校验，无副作用（KefuAgent validatePolicyBoundaryAnswer 的移植）。 */
export function validateBoundaryAnswer(
  boundary_id: string,
  answer: BoundaryAnswer,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): { ok: true } | { ok: false; code: AnswerError } {
  const boundary = findBoundary(boundary_id, registry)
  if (boundary === undefined) return { ok: false, code: 'unknown_boundary' }
  if (answer.kind === 'decline') return { ok: true }
  if (answer.kind === 'option') {
    return findBoundaryOption(boundary, answer.option_id) === undefined
      ? { ok: false, code: 'unknown_option' }
      : { ok: true }
  }
  const text = answer.text.trim()
  return text.length === 0 || text.length > MAX_CUSTOM_ANSWER_CHARS
    ? { ok: false, code: 'invalid_answer' }
    : { ok: true }
}

export interface AnswerContext {
  by: PersonId | 'import'
  at: Iso8601
  source?: SupportPolicy['source']
  approval_item_id?: string
}

/**
 * 边界答案 → `SupportPolicy`。
 * `value` 是**答题那一刻的快照**：以后改注册表不回写已答的行（KefuAgent 的 value_json 语义）。
 * `decline`（"暂不回答"）不产策略——场景保持人工，且不再自动问第二次，
 * 那条"不再问"的记忆由调用方按 `dedupe_key` 保存。
 */
export function answerBoundary(
  boundary_id: string,
  answer: BoundaryAnswer,
  ctx: AnswerContext,
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): SupportPolicy | undefined {
  const check = validateBoundaryAnswer(boundary_id, answer, registry)
  if (!check.ok || answer.kind === 'decline') return undefined
  const boundary = findBoundary(boundary_id, registry)
  if (boundary === undefined) return undefined
  const source = ctx.source ?? 'approval'
  if (answer.kind === 'option') {
    const option = findBoundaryOption(boundary, answer.option_id)
    if (option === undefined) return undefined
    return {
      boundary_id,
      option_id: option.id,
      value: { ...option.value },
      statement: `${boundary.label}：${option.label}`,
      answered_by: ctx.by,
      answered_at: ctx.at,
      source,
      ...(ctx.approval_item_id === undefined ? {} : { approval_item_id: ctx.approval_item_id }),
    }
  }
  const text = answer.text.trim()
  return {
    boundary_id,
    value: { text },
    statement: `${boundary.label}：${text}`,
    answered_by: ctx.by,
    answered_at: ctx.at,
    source,
    ...(ctx.approval_item_id === undefined ? {} : { approval_item_id: ctx.approval_item_id }),
  }
}

/** 从策略里取一个数值槽（`policy.refund_window` 的 `days` 之类）。 */
export function policyValue(
  policies: readonly SupportPolicy[],
  boundary_id: string,
  key: string,
): unknown {
  return policies.find((p) => p.boundary_id === boundary_id)?.value[key]
}

export function policyNumber(
  policies: readonly SupportPolicy[],
  boundary_id: string,
  key: string,
): number | undefined {
  const v = policyValue(policies, boundary_id, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/**
 * 已确认边界的 prompt 块（KefuAgent buildAnsweredBoundariesPromptBlock 的移植）。
 * 空数组返回 `undefined`：没有边界时 prompt 里连标题都不出现，静态前缀才稳定（22 §缓存纪律）。
 */
export function answeredBoundariesBlock(
  policies: readonly SupportPolicy[],
  registry: readonly BoundaryItem[] = SUPPORT_BOUNDARIES,
): string | undefined {
  const lines: string[] = []
  for (const boundary of registry) {
    const policy = policies.find((p) => p.boundary_id === boundary.id)
    if (policy === undefined) continue
    const answer = policy.statement.includes('：')
      ? policy.statement.slice(policy.statement.indexOf('：') + 1)
      : policy.statement
    if (answer.length === 0) continue
    lines.push(`- ${boundary.label}：${answer}`)
  }
  if (lines.length === 0) return undefined
  return [
    '商户已确认的业务边界（这些是商户明确拍板的事实，优先级高于爬取到的政策页；如与知识库冲突，以本块为准）：',
    ...lines,
  ].join('\n')
}
