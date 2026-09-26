import type {
  ApprovalKind,
  ChangeKind,
  GateDecision,
  ObjectRef,
  PrecheckResult,
} from '@agentsws/contracts'
import { AUTONOMY_GATES, EXTERNAL_FENCE, TARGET_SCOPED_KINDS } from '@agentsws/core'
import type { ApprovalContext, NormalizedCreateInput } from './types.js'
import { deepEqual, refKey, scanSecrets } from './util.js'

const KNOWN_KINDS: ReadonlySet<string> = new Set<ApprovalKind>([
  'outbound_draft',
  'staged_change',
  'knowledge_update',
  'skill_promotion',
  'skill_lesson',
  'claim',
  'policy_change',
  'home_suggestion',
  'scheduled_task',
  'app_install',
  'app_upgrade',
  'app_uninstall',
  'upstream_upgrade',
  'join_mapping',
  'dev_handoff_result',
  // WP22 / 37 §2.4：早上的计划卡与晚上的复盘卡（契约 #19 新增的两个 kind）
  'daily_plan',
  'review',
  // WP17：本条对话的一次性缺资料提问
  'ai_question',
  // WP51 / 46 §2 I3：有人申请加入这个工作区
  'membership',
  // WP63 / 51 §2.1 数据日报：店铺日报卡（L3 自动出、看完归档）
  'daily_report',
  // WP68 / 48 §5.2：campaign 挑人清单卡（接受才按渠道分别建合作）
  'kol_campaign',
  // WP144 / docs/80：电脑操控授权卡（批了才挂提供方）
  'computer_use',
  // WP154：搜索报告卡（每日 5 件事 / 每周收入 / 每周 AI 可见度；L3 自动出、看完归档）
  'seo_report',
])

export function isKnownKind(kind: string): boolean {
  return KNOWN_KINDS.has(kind)
}

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

function asRef(v: unknown): ObjectRef | undefined {
  const o = rec(v)
  return typeof o.type === 'string' && typeof o.id === 'string'
    ? { type: o.type, id: o.id }
    : undefined
}

function textOf(payload: unknown): string {
  const p = rec(payload)
  const body = rec(p.body)
  const parts = [p.text, body.text, body.subject, p.quote, p.redaction_preview]
  return parts.filter((x): x is string => typeof x === 'string').join('\n')
}

export interface PrecheckOutcome {
  precheck: PrecheckResult
  /** 非空 = blocked，不进队列（14 §6） */
  blocked: string[]
  /** outbound_draft 生成的脱敏预览 */
  redaction_preview?: string
  /**
   * 48 §4 L3 #3：三道门的结论，原样带出来给调用方落 `guardrail.gate_decided`。
   *
   * 前置自己不发事件（它是纯函数），但门的结论必须有人记——「当时用的是哪一版
   * 规则集、三道门各怎么说」是自主发送审计链的全部内容。
   */
  gate_decisions?: GateDecision[]
  /**
   * 48 §4 L3 #3：三道门全 pass 才算「这封可以自主发」。
   *
   * `undefined` = 调用方没装这三道门（老路径），**不是** `true`——「没问过」与
   * 「问过了说可以」在自主发送这件事上必须分得开。
   */
  autonomous?: boolean
}

/**
 * 14 §6 预检：创建时自动跑，失败即 blocked（不进队列，回给提议者）。
 * 31 §3.3 收件人门禁一并在此：收件人必须在 provenance.seen，且是线程原参与者或已验证联系方式。
 */
export function runPrecheck<P>(
  input: NormalizedCreateInput<P>,
  ctx: ApprovalContext = {},
): PrecheckOutcome {
  const blocked: string[] = []
  const notes: string[] = []
  const precheck: PrecheckResult = { ...input.evidence.precheck }
  const seen = new Set((input.evidence.provenance?.seen ?? []).map(refKey))
  const payload = input.payload as unknown
  const p = rec(payload)
  const writeKinds: ApprovalKind[] = ['outbound_draft', 'staged_change']

  // provenance（写类必查）
  if (writeKinds.includes(input.kind)) {
    const targets: ObjectRef[] = []
    const target = asRef(p.target) ?? input.subject.object
    targets.push(target)
    const to = asRef(p.to)
    if (input.kind === 'outbound_draft' && to) targets.push(to)
    const missing = targets.filter((t) => !seen.has(refKey(t)))
    if (missing.length > 0) {
      precheck.provenance = 'fail'
      blocked.push('provenance_missing')
      notes.push(`本次运行未读取过：${missing.map(refKey).join(', ')}`)
    } else precheck.provenance = 'ok'
  }

  // 31 §3.3 收件人门禁
  let redaction_preview: string | undefined
  if (input.kind === 'outbound_draft') {
    const to = asRef(p.to)
    const allowed = new Set([...(ctx.thread_participants ?? []), ...(ctx.verified_contacts ?? [])])
    if (!to || !allowed.has(to.id)) {
      blocked.push('recipient_gate')
      notes.push('收件人不是线程原参与者，也不是已验证联系方式（31 §3.3）')
    }
    redaction_preview =
      typeof p.redaction_preview === 'string' ? p.redaction_preview : textOf(payload)
    precheck.redaction = ctx.precheck_overrides?.redaction ?? 'ok'
    if (precheck.redaction === 'fail') {
      blocked.push('redaction')
      notes.push('含机密字段且接收方无权')
    }
  }

  // 围栏：外部文本进 payload 前必须已清洗（未清洗 = 执行器的 bug）。
  //
  // 判据是「有没有围栏该拦的构造」，**不是** `sanitizeText(t) !== t`——后者把 NFKC 归一
  // 也算成违规，而归一对所有文本都生效：一句带全角逗号的中文（人写的指导、中文草稿）
  // 归一后就与原文不等，于是每张卡都 blocked。这是 WP24 起 `landInstruction` 产的
  // skill_lesson 卡进不了队列的根因。
  const text = textOf(payload)
  const violations = text ? EXTERNAL_FENCE.findViolations(text) : []
  if (violations.length > 0) {
    precheck.fencing = 'fail'
    blocked.push('fencing')
    notes.push(`payload 含未围栏的外部文本标记：${violations.join(', ')}`)
  } else if (text) precheck.fencing = 'ok'

  // 密钥扫描（所有 kind）
  const secrets = scanSecrets(payload)
  if (secrets.length > 0) {
    precheck.secret_scan = 'fail'
    blocked.push('secret_scan')
    notes.push(`payload 含密钥 / 卡号形态：${secrets.join(', ')}`)
  } else precheck.secret_scan = 'ok'

  // 语义 diff：空 diff 不建项
  if (['knowledge_update', 'skill_promotion', 'skill_lesson'].includes(input.kind)) {
    const diff = input.evidence.diff
    if (!diff || deepEqual(diff.before, diff.after)) {
      precheck.semantic_diff = 'empty'
      blocked.push('empty_diff')
      notes.push('语义 diff 为空，不建项')
    } else precheck.semantic_diff = 'ok'
  }

  // 44 G2：目标商品不在这个岗位管的范围里 —— 越权，卡直接 blocked，不进任何人的队列。
  //
  // 判定发生在职责层（`roles.targetInRange`），这里只认结论：没给就是调用方还不认
  // 范围模型（老路径一个字不用改），给了 `ok: false` 就拦。
  if (input.kind === 'staged_change' && TARGET_SCOPED_KINDS.has(p.kind as ChangeKind)) {
    const scope = ctx.target_in_range
    if (scope !== undefined) {
      precheck.target_in_range = scope.ok ? 'ok' : 'fail'
      if (!scope.ok) {
        blocked.push('target_in_range')
        notes.push(scope.reason ?? '这件商品不在这个岗位管的范围里（44 G2）')
      }
    }
  }

  // 改前必读（listing_edit）。
  //
  // WP63 起「改前必读」的完整名单在 `@agentsws/core` 的 `RECORD_READ_KINDS` 里
  // （文案 / 集合 / 评价回复），真正的强制在 **guardrail** 那一层——它看的是这次运行
  // 的 provenance（读没读过全记录是**事实**）。这里这一条只认调用方自报的
  // `evidence.precheck.record_read`，是给还没接 provenance 的老路径留的旧门，
  // 所以**不跟着扩**：扩了等于让新 kind 一律 blocked（没人会去填那个自报字段）。
  if (input.kind === 'staged_change' && p.kind === 'listing_edit') {
    const target = asRef(p.target) ?? input.subject.object
    const full = new Set(ctx.precheck_overrides?.record_read === 'ok' ? [refKey(target)] : [])
    precheck.record_read = full.has(refKey(target))
      ? 'ok'
      : (input.evidence.precheck.record_read ?? 'fail')
    if (precheck.record_read === 'fail') {
      blocked.push('record_read')
      notes.push('改前没读过全记录')
    }
  }

  // 48 §4 L3 #3：三道「不自主」的门。
  //
  // 这里**只记录不改状态**：门说「不自主」不等于这张卡不该建，只等于它不能自己
  // 发出去——卡照常进队列，等人按。fail-closed 在门里面（`gate_error` 与 `fail`
  // 同样算不自主），前置这一层只忠实转录。
  let gate_decisions: GateDecision[] | undefined
  let autonomous: boolean | undefined
  const gates = ctx.gates
  if (gates !== undefined) {
    gate_decisions = gates
    autonomous = true
    for (const decision of gates) {
      if (!AUTONOMY_GATES.includes(decision.gate)) continue
      const verdict = decision.status === 'pass' ? 'ok' : decision.status
      precheck[decision.gate] = verdict
      if (decision.status !== 'pass') {
        autonomous = false
        notes.push(
          `门 ${decision.gate} 说不自主：${decision.reason ?? decision.status}（规则集 ${decision.ruleset_hash.slice(0, 12)}）`,
        )
      }
    }
  }

  // 48 §4 L3 #2：Amazon 站内信的出站硬闸。
  //
  // 与上面三道门不同，这一条是 **block**：不是「这封信不能自己发」，是「这封信
  // 根本不能这样发出去」。重写指令原样进 notes，回给起草那一跳——拦下是打回重写，
  // 不是静默删改后照发。
  const amazon = ctx.amazon_outbound
  if (input.kind === 'outbound_draft' && amazon !== undefined) {
    precheck.amazon_outbound = amazon.ok ? 'ok' : 'fail'
    if (!amazon.ok) {
      blocked.push('amazon_outbound')
      notes.push(
        `Amazon 站内信出站守卫拦下（${(amazon.codes ?? []).join(', ')}）：${amazon.rewrite_instruction ?? '按社区规范重写正文'}`,
      )
    }
  }

  // 额度：超额不是失败，是 L1 路由
  // 14：契约只要求给等级；没给 mandate_check 的由 normalizeCreateInput 补成「没核过」→ 复核
  precheck.mandate = input.automation.mandate_check.within ? 'within' : 'review'

  if (notes.length > 0) precheck.notes = [...(precheck.notes ?? []), ...notes]
  return {
    precheck,
    blocked,
    ...(redaction_preview !== undefined ? { redaction_preview } : {}),
    ...(gate_decisions === undefined ? {} : { gate_decisions }),
    ...(autonomous === undefined ? {} : { autonomous }),
  }
}
