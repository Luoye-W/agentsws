/**
 * lesson 抽取（24 §2、06 §3.4 的三级信号）。
 *
 * 规则版先做，理由是纪律而不是省事：**人的原话是最强的证据**，而规则抽取是
 * 确定的、可解释的、离线可跑的——同一次运行 + 同一个决定，永远抽出同一条 lesson，
 * 语义键也一样，所以"五次相同纠正 = 一条 lesson"这件事不依赖模型的心情。
 *
 * 模型抽取作为可注入回调（`modelExtract`）叠在规则之上：它只能**补**，不能改写规则版
 * 抽出来的那几条（合并时规则版优先），也不能凭空提高置信度。
 *
 * 信号强度（24 §3 / 06 §3.4 的表）：
 *
 * | 信号 | 强度 | 出来的是什么 |
 * |---|---|---|
 * | 驳回 + 原因 | strong | 一条规则（最强信号：人明说了"不对"和"为什么"） |
 * | 编辑后的差异 | strong | 一条改法（人已经把正确写法写出来了） |
 * | 指导文本（similar_cases） | strong | 一条规则 |
 * | 边界答案 | strong | 一条 boundary |
 * | guardrail 命中 | medium | 一条 boundary |
 * | 工具反复失败 | medium | 一条反例 |
 * | 运行后反思 | weak | 一条规则候选（量大，靠置信度门槛拦） |
 */
import type {
  AssignmentId,
  Iso8601,
  Lesson,
  RunEvent,
  RunId,
  WorkspaceId,
} from '@agentsws/contracts'
import { semanticKey } from './semantic.js'
import type {
  AppliesTo,
  ExtractedLesson,
  LessonEvidence,
  LessonKind,
  LessonSignal,
  LessonStrength,
} from './types.js'

/** 24 §3：信号强度 → 初始置信度。与 `@agentsws/skills` 的 `STRENGTH_CONFIDENCE` 同表。 */
export const STRENGTH_CONFIDENCE: Readonly<Record<LessonStrength, number>> = {
  strong: 0.6,
  medium: 0.4,
  weak: 0.25,
}

/** 同一个工具连着失败几次才算一条"反例"。一次失败是意外，三次是习惯。 */
export const TOOL_RETRY_THRESHOLD = 3

/** 人对一张卡的处置（14 §9 的决定事件投影）。 */
export interface HumanDecision {
  approval_item_id: string
  action: 'approve' | 'approve_edited' | 'reject' | 'redirect' | 'defer' | 'withdraw'
  at: Iso8601
  /** 驳回原因 / 编辑说明；人的原话 */
  reason?: string
  /** 编辑后的差异（14 §9 `edit_diff`）：before / after 都是正文文本 */
  edit_diff?: { before?: string; after?: string; summary?: string }
  /** 36 §2.1 指导抽屉：作用域 + 一句话 */
  instruction?: { scope: 'single_reply' | 'similar_cases' | 'global_rule'; text: string }
  /** 选择题卡（业务边界）选中的那一项 */
  boundary?: { id: string; question: string; answer: string }
}

export interface ExtractInput {
  workspace_id: WorkspaceId
  assignment_id: AssignmentId
  run_id: RunId
  at: Iso8601
  /** 这次运行用的技能与（可选的）目标段。没有段就落到技能末尾那一段（提案时定） */
  applies_to: AppliesTo
  /** 17 §2 的事件序列；不给就只看结果与人的决定 */
  events?: readonly RunEvent[]
  /** 运行结果里的反思产物（`RunResult.lessons`） */
  reflections?: readonly Lesson[]
  /** 人的决定；一次运行可能有多张卡 */
  decisions?: readonly HumanDecision[]
}

/** 模型抽取：宿主可注入；返回的每条都会被重新算语义键与置信度上限。 */
export type ModelExtractor = (input: ExtractInput) => Promise<readonly ModelLessonDraft[]>

export interface ModelLessonDraft {
  text: string
  kind: LessonKind
  section_id?: string
  /** 模型给的置信度会被夹到 weak/medium 区间：模型不能自封"强信号" */
  confidence?: number
  quote?: string
}

/** 模型抽取的置信度上限：它是补充证据，不是人的原话。 */
export const MODEL_CONFIDENCE_CAP = STRENGTH_CONFIDENCE.medium

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** 一句话规则的长度上限：卡片上要读得完，overlay 里也不该塞一整封信。 */
export const RULE_MAX_CHARS = 240

function ruleText(s: string): string {
  const t = clean(s)
  return t.length <= RULE_MAX_CHARS ? t : `${t.slice(0, RULE_MAX_CHARS - 1)}…`
}

/** 驳回原因里出现这些词，说明人在说"别这么干" → 反例而不是规则。 */
const NEGATIVE_MARKERS = [
  '不要',
  '别',
  '不能',
  '不该',
  '禁止',
  '不准',
  'never',
  "don't",
  'do not',
  'stop',
  'avoid',
]

export function kindOfReason(reason: string): LessonKind {
  const lower = reason.toLowerCase()
  return NEGATIVE_MARKERS.some((m) => lower.includes(m)) ? 'anti_example' : 'rule'
}

interface DraftSpec {
  text: string
  kind: LessonKind
  signal: LessonSignal
  strength: LessonStrength
  evidence: LessonEvidence
  section_id?: string
  confidence?: number
}

function build(input: ExtractInput, spec: DraftSpec): ExtractedLesson {
  const section_id = spec.section_id ?? input.applies_to.section_id
  const applies_to: AppliesTo = {
    skill: input.applies_to.skill,
    ...(section_id === undefined ? {} : { section_id }),
  }
  return {
    workspace_id: input.workspace_id,
    assignment_id: input.assignment_id,
    run_id: input.run_id,
    applies_to,
    kind: spec.kind,
    signal: spec.signal,
    strength: spec.strength,
    text: ruleText(spec.text),
    confidence: spec.confidence ?? STRENGTH_CONFIDENCE[spec.strength],
    evidence: [spec.evidence],
    semantic_key: semanticKey({
      skill: applies_to.skill,
      ...(applies_to.section_id === undefined ? {} : { section_id: applies_to.section_id }),
      kind: spec.kind,
      text: ruleText(spec.text),
    }),
  }
}

/** 编辑差异 → 人改出来的那句话。只取 after 里 before 没有的行，取不到就整段 after。 */
export function diffAddition(before: string | undefined, after: string): string {
  const old = new Set(
    (before ?? '')
      .split(/\n+/)
      .map(clean)
      .filter((l) => l !== ''),
  )
  const added = after
    .split(/\n+/)
    .map(clean)
    .filter((l) => l !== '' && !old.has(l))
  return added.length > 0 ? added.join(' ') : clean(after)
}

/**
 * 规则版抽取。同步、纯函数：同样的入参永远同样的产物。
 */
export function extractLessons(input: ExtractInput): ExtractedLesson[] {
  const out: ExtractedLesson[] = []

  for (const d of input.decisions ?? []) {
    const ev = (quote: string): LessonEvidence => ({
      quote,
      at: d.at,
      run_id: input.run_id,
      approval_item_id: d.approval_item_id,
    })

    // ① 驳回原因：最强信号
    if (d.action === 'reject' && d.reason !== undefined && clean(d.reason) !== '') {
      out.push(
        build(input, {
          text: d.reason,
          kind: kindOfReason(d.reason),
          signal: 'reject',
          strength: 'strong',
          evidence: ev(d.reason),
        }),
      )
    }
    // ② 编辑差异 → 改法
    if (d.edit_diff !== undefined && clean(d.edit_diff.after ?? '') !== '') {
      const added = diffAddition(d.edit_diff.before, d.edit_diff.after ?? '')
      if (added !== '') {
        out.push(
          build(input, {
            text: added,
            kind: 'example',
            signal: 'edit_diff',
            strength: 'strong',
            evidence: ev(added),
          }),
        )
      }
    }
    // ③ 指导（similar_cases）→ 规则。single_reply 只管这一条，不进学习回路；
    //    global_rule 走 05 的策略层，学习回路更不该碰（24 §3「策略层永不进学习回路」）
    if (d.instruction !== undefined && d.instruction.scope === 'similar_cases') {
      out.push(
        build(input, {
          text: d.instruction.text,
          kind: kindOfReason(d.instruction.text),
          signal: 'redirect',
          strength: 'strong',
          evidence: ev(d.instruction.text),
        }),
      )
    }
    // ④ 边界答案 → boundary
    if (d.boundary !== undefined) {
      out.push(
        build(input, {
          text: `${d.boundary.question} → ${d.boundary.answer}`,
          kind: 'boundary',
          signal: 'redirect',
          strength: 'strong',
          evidence: ev(d.boundary.answer),
        }),
      )
    }
  }

  // ⑤ 运行内摩擦：同一工具连着失败 ≥ 3 次
  const failures = new Map<string, { count: number; reason?: string }>()
  const callTool = new Map<string, string>()
  for (const e of input.events ?? []) {
    if (e.type === 'tool.call') callTool.set(e.call_id, e.tool)
    if (e.type === 'tool.result' && e.status !== 'ok') {
      const tool = callTool.get(e.call_id) ?? e.call_id
      const prev = failures.get(tool) ?? { count: 0 }
      failures.set(tool, {
        count: prev.count + 1,
        ...(e.reason === undefined ? {} : { reason: e.reason }),
      })
    }
  }
  for (const [tool, f] of [...failures.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (f.count < TOOL_RETRY_THRESHOLD) continue
    const text = `${tool} 连着失败 ${f.count} 次${f.reason === undefined ? '' : `：${f.reason}`}，别再按现在这个用法调它`
    out.push(
      build(input, {
        text,
        kind: 'anti_example',
        signal: 'tool_retry',
        strength: 'medium',
        evidence: { quote: text, at: input.at, run_id: input.run_id },
      }),
    )
  }

  // ⑥ 运行后反思：弱但量大，靠置信度门槛拦在提案之外
  for (const r of input.reflections ?? []) {
    if (clean(r.text) === '') continue
    out.push(
      build(input, {
        text: r.text,
        kind: 'rule',
        signal: 'reflection',
        strength: r.strength,
        confidence: Math.min(r.confidence, STRENGTH_CONFIDENCE[r.strength]),
        evidence: { quote: r.text, at: input.at, run_id: input.run_id },
        ...(r.section_id === undefined ? {} : { section_id: r.section_id }),
      }),
    )
  }

  return dedupeByKey(out)
}

/** 同一次抽取里键重复的合并成一条（证据并起来）。先来的赢——规则版顺序即优先级。 */
export function dedupeByKey(lessons: readonly ExtractedLesson[]): ExtractedLesson[] {
  const byKey = new Map<string, ExtractedLesson>()
  for (const l of lessons) {
    const hit = byKey.get(l.semantic_key)
    if (hit === undefined) {
      byKey.set(l.semantic_key, { ...l, evidence: [...l.evidence] })
      continue
    }
    hit.confidence = Math.max(hit.confidence, l.confidence)
    for (const e of l.evidence) {
      if (!hit.evidence.some((x) => x.quote === e.quote && x.at === e.at)) hit.evidence.push(e)
    }
  }
  return [...byKey.values()]
}

/**
 * 规则版 + 模型版。模型只能补规则版没抽到的键，且置信度被夹到 medium 以下。
 */
export async function extractLessonsWithModel(
  input: ExtractInput,
  modelExtract: ModelExtractor,
): Promise<ExtractedLesson[]> {
  const rules = extractLessons(input)
  const known = new Set(rules.map((l) => l.semantic_key))
  const drafts = await modelExtract(input)
  const extra: ExtractedLesson[] = []
  for (const d of drafts) {
    if (clean(d.text) === '') continue
    const lesson = build(input, {
      text: d.text,
      kind: d.kind,
      signal: 'reflection',
      strength: 'weak',
      confidence: Math.min(d.confidence ?? STRENGTH_CONFIDENCE.weak, MODEL_CONFIDENCE_CAP),
      evidence: { quote: d.quote ?? d.text, at: input.at, run_id: input.run_id },
      ...(d.section_id === undefined ? {} : { section_id: d.section_id }),
    })
    if (known.has(lesson.semantic_key)) continue
    known.add(lesson.semantic_key)
    extra.push(lesson)
  }
  return [...rules, ...extra]
}
