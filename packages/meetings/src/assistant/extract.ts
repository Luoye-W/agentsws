/**
 * 免费默认会议助手的抽取规则（37 §4.2 第一层）。纯函数、无 IO、无模型调用——
 * 模型抽取是**可注入的回调**（`assistant/processor.ts` 的 `refine`），不是这里的默认路径。
 *
 * 四条纪律：
 * ① **注入行整行丢掉**。转写里出现"忽略以上指令""system:""[removed]"（围栏拆掉伪造标签留下的疤）
 *    这类词面，说明这句话是冲着模型来的，不是会议内容——它既不产待办也不产知识。
 * ② **本人确认前不形成责任**（31 I13）。抽出来的待办永远只是提案，`speech_state`
 *    三态：`suggested`（建议）/ `confirmed`（本人在会上认了）/ `assigned`（明确指派）。
 * ③ **点名的人不在与会者名单里 → 只到 `suggested`**。会上一句话不能给不在场的人派活。
 * ④ **高风险动作（转账 / 打款 / 改价 / 退款…）→ 一律只到 `suggested`**。
 *    这类事必须由本人在卡片上确认，会上一句话不足以形成指派。
 */
import type {
  MeetingBoundaryAnswer,
  MeetingDecision,
  MeetingKnowledgeCandidate,
  MeetingNextMeeting,
  MeetingParticipant,
  MeetingProvenance,
  MeetingTodoProposal,
  SpeechState,
  TranscriptSegment,
} from '@agentsws/contracts'
import { isDeidentified, sanitizeExternal, scanPolicySensitiveText } from '@agentsws/support-core'
import { participantMatches } from '../store-logic.js'

/* ------------------------------------------------------------------ */
/* ① 注入                                                               */
/* ------------------------------------------------------------------ */

/**
 * 注入词面。命中即整行丢掉——宁可漏一条待办，不可让别人往会议纪要里塞指令。
 * `[removed]` 是围栏（`@agentsws/core` 的 `Fence`）拆掉伪造标签后留下的疤，
 * 出现在转写里就说明原文里有 `<system>` / `<function_calls>` 之类的东西。
 */
export const INJECTION_PATTERNS: readonly RegExp[] = [
  /\[removed\]/i,
  /\bignore\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\b/i,
  /\bdisregard\s+(?:all\s+)?(?:previous|prior|above|the)\b/i,
  /\b(?:new|updated)\s+(?:system\s+)?instructions?\s*[:：]/i,
  /\bsystem\s*(?:prompt|message)\b/i,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/i,
  /\b(?:human|assistant|system|user)\s*[:：]\s*(?:you|please|ignore)/i,
  /忽略[^。；\n]{0,12}(?:指令|指示|要求|提示词|规则|内容)/,
  /(?:新的?|最新|以下)(?:系统)?(?:指令|指示|要求)\s*[:：]/,
  /(?:你|您)(?:现在)?是(?:一个|一名)/,
  /(?:请)?(?:执行|运行)以下(?:命令|指令|代码)/,
  /(?:不要|别)(?:告诉|通知)(?:任何人|老板|用户|他们)/,
  /(?:以上|上面)(?:的)?(?:内容|指令)(?:作废|无效)/,
]

export function isInjection(line: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(line))
}

/* ------------------------------------------------------------------ */
/* ④ 高风险动作                                                          */
/* ------------------------------------------------------------------ */

/** 会上一句话不足以形成指派的动作（钱、价格、不可逆的对外动作）。 */
export const HIGH_RISK_PATTERNS: readonly RegExp[] = [
  /转账|打款|付款|汇款|走账|报销|放款/,
  /退款|改价|调价|降价|涨价|折扣/,
  /\b(?:wire|transfer|pay|payment|refund|chargeback)\b/i,
  /\b(?:re)?price|discount\b/i,
  /删库|删除(?:全部|所有)?(?:数据|订单)|注销账号/,
]

export function isHighRisk(text: string): boolean {
  return HIGH_RISK_PATTERNS.some((re) => re.test(text))
}

/* ------------------------------------------------------------------ */
/* 句子                                                                 */
/* ------------------------------------------------------------------ */

export interface Utterance {
  index: number
  speaker: string | undefined
  text: string
  at_ms: number | undefined
}

/**
 * 段落 → 逐句。
 *
 * **先过围栏清洗再切**（`sanitizeExternal` = `EXTERNAL_FENCE.sanitizeText`）：
 * ① 伪造的 `<system>` / `<function_calls>` 标签在这里变成 `[removed]`，正好被注入判定捞走；
 * ② 清洗是幂等的，所以抽出来的 `quote` 本身就是"已清洗的外部文本"——
 *    产出直接进审批项 payload 时不会再被 14 §6 的围栏预检拦下（`fencing: fail`）。
 *
 * 中英标点都切；切完仍带说话人与时间点，出处才回得去。
 */
export function utterances(segments: readonly TranscriptSegment[]): Utterance[] {
  const out: Utterance[] = []
  for (const raw of segments) {
    const seg = { ...raw, text: sanitizeExternal(raw.text) }
    if (isInjection(seg.text)) continue
    const pieces = seg.text
      .split(/(?<=[。！？；!?;])\s*|\n+/)
      .map((s) => s.trim())
      .filter((s) => s !== '')
    for (const piece of pieces) {
      if (isInjection(piece)) continue
      out.push({
        index: out.length,
        speaker: seg.speaker,
        text: piece,
        at_ms: seg.start_ms,
      })
    }
  }
  return out
}

function provenanceOf(record_id: string, u: Utterance): MeetingProvenance {
  return {
    record_id,
    quote: u.text,
    ...(u.speaker === undefined ? {} : { speaker: u.speaker }),
    ...(u.at_ms === undefined ? {} : { at_ms: u.at_ms }),
  }
}

const trimTail = (s: string): string => s.replace(/[\s，,。；;！!？?、]+$/u, '').trim()

/* ------------------------------------------------------------------ */
/* 决定                                                                 */
/* ------------------------------------------------------------------ */

const DECISION_PATTERNS: readonly RegExp[] = [
  /(?:我们|大家|团队)?(?:最终)?(?:决定|定了|拍板|敲定|就这么定)\s*[:：]?\s*(.+)/,
  /(?:结论|决议)\s*[:：]\s*(.+)/,
  /\b(?:we|the team)\s+(?:have\s+)?(?:decided|agreed)\s+(?:that\s+|to\s+)?(.+)/i,
  /\bdecision\s*[:：]\s*(.+)/i,
]

export function extractDecisions(
  us: readonly Utterance[],
  record_id: string,
  id: (n: number) => string,
): MeetingDecision[] {
  const out: MeetingDecision[] = []
  for (const u of us) {
    for (const re of DECISION_PATTERNS) {
      const m = re.exec(u.text)
      if (m === null) continue
      const text = trimTail(m[1] ?? '')
      if (text.length < 2) break
      out.push({ id: id(out.length), text, provenance: provenanceOf(record_id, u) })
      break
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 待办提案                                                              */
/* ------------------------------------------------------------------ */

interface TodoHit {
  text: string
  assignee?: string
  base: SpeechState
}

/** 第一人称承诺 → `confirmed`（说话人自己认下来的）。 */
const SELF_PATTERNS: readonly RegExp[] = [
  /^(?:我)(?:来|去|会|这边)?\s*(跟进|负责|处理|做|准备|安排|写|发|出|对接|确认)\s*(.*)$/,
  /^\s*(?:i(?:'ll| will| can| am going to))\s+(.+)$/i,
  /^\s*我(?:这边|来|去|会)\s*(.{2,})$/,
]

/** 点名指派 → `assigned`（还要过③④两条降级规则）。 */
const NAME = '(?:[\\u4e00-\\u9fa5]{2,4}?|[A-Za-z][A-Za-z.]{0,19}?)'
const ASSIGN_PATTERNS: readonly RegExp[] = [
  new RegExp(`^(?:让|请|麻烦)\\s*(${NAME})\\s*(?:来|去)?\\s*(.{2,})$`),
  new RegExp(`^(${NAME})\\s*(?:来)?(?:负责|跟进)\\s*(.{2,})$`),
  /^([A-Z][A-Za-z]{1,20})\s+(?:will|should|to)\s+(.+)$/,
  /^\s*(?:action item|todo)\s*[:：]\s*([^\s，,。；;：:]{1,20})\s*[-—]\s*(.+)$/i,
]

/** 泛泛的应该 / 需要 → `suggested`。 */
const SUGGEST_PATTERNS: readonly RegExp[] = [
  /^(?:我们|大家|团队)?\s*(?:应该|需要|要|得|最好)\s*(.+)$/,
  /^\s*(?:we|someone|somebody)\s+(?:should|need to|needs to|must|have to)\s+(.+)$/i,
  /^\s*(?:action item|todo|待办)\s*[:：]\s*(.+)$/i,
  /^(?:下一步|接下来)\s*[:：]?\s*(.+)$/,
]

function todoHit(text: string): TodoHit | undefined {
  for (const re of SELF_PATTERNS) {
    const m = re.exec(text)
    if (m === null) continue
    const rest = [m[1], m[2]].filter((p) => p !== undefined && p !== '').join('')
    if (trimTail(rest).length < 2) continue
    return { text: trimTail(rest), base: 'confirmed' }
  }
  for (const re of ASSIGN_PATTERNS) {
    const m = re.exec(text)
    if (m === null) continue
    const who = (m[1] ?? '').trim()
    const what = trimTail(m[2] ?? '')
    if (who === '' || what.length < 2) continue
    return { text: what, assignee: who, base: 'assigned' }
  }
  for (const re of SUGGEST_PATTERNS) {
    const m = re.exec(text)
    if (m === null) continue
    const what = trimTail(m[1] ?? '')
    if (what.length < 2) continue
    return { text: what, base: 'suggested' }
  }
  return undefined
}

const DUE_PATTERNS: readonly [RegExp, number][] = [
  [/今天|today/i, 0],
  [/明天|tomorrow/i, 1],
  [/后天/, 2],
  [/下周|next week/i, 7],
]

/** 会上说的"明天""下周"→ 相对今天的到期日（只到天，时间点留给人改）。 */
export function dueFrom(text: string, now: string): string | undefined {
  for (const [re, days] of DUE_PATTERNS) {
    if (!re.test(text)) continue
    const base = Date.parse(now)
    if (Number.isNaN(base)) return undefined
    return new Date(base + days * 86_400_000).toISOString()
  }
  return undefined
}

export interface TodoContext {
  record_id: string
  participants: readonly MeetingParticipant[]
  now: string
  id: (n: number) => string
}

export function extractTodos(us: readonly Utterance[], ctx: TodoContext): MeetingTodoProposal[] {
  const out: MeetingTodoProposal[] = []
  for (const u of us) {
    const hit = todoHit(u.text)
    if (hit === undefined) continue

    const reasons: string[] = []
    let state: SpeechState = hit.base
    let person_id: string | undefined

    if (hit.assignee !== undefined) {
      const found = ctx.participants.find((p) => participantMatches(p, hit.assignee as string))
      if (found === undefined) {
        // ③ 不在场的人不接活
        state = 'suggested'
        reasons.push('assignee_not_in_meeting')
      } else {
        person_id = found.person_id
      }
    }
    if (hit.base === 'confirmed') {
      if (u.speaker === undefined) {
        // 不知道是谁说的「我来」，就不能算本人认了
        state = 'suggested'
        reasons.push('speaker_unknown')
      } else {
        const self = ctx.participants.find((p) => participantMatches(p, u.speaker as string))
        if (self === undefined) {
          // 说话人不在与会名单里 → 认领卡没人可发，只能当建议
          state = 'suggested'
          reasons.push('speaker_not_in_meeting')
        } else {
          person_id = self.person_id
        }
      }
    }
    if (isHighRisk(u.text) && state !== 'suggested') {
      // ④ 钱与价格的事，会上一句话不算指派
      state = 'suggested'
      reasons.push('high_risk_action')
    }

    const due = dueFrom(u.text, ctx.now)
    out.push({
      id: ctx.id(out.length),
      text: hit.text,
      ...(hit.assignee === undefined ? {} : { assignee_hint: hit.assignee }),
      ...(person_id === undefined ? {} : { assignee_person_id: person_id }),
      speech_state: state,
      speech_state_reasons: reasons,
      ...(due === undefined ? {} : { due }),
      provenance: provenanceOf(ctx.record_id, u),
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 边界答案                                                              */
/* ------------------------------------------------------------------ */

const QUESTION = /[?？]\s*$/

/**
 * 边界问答 = 一句**政策敏感的问句** + 下一句**别人给的答案**。
 * 只有政策敏感的才算——"几点吃饭"不是业务边界。
 */
export function extractBoundaryAnswers(
  us: readonly Utterance[],
  record_id: string,
  id: (n: number) => string,
): MeetingBoundaryAnswer[] {
  const out: MeetingBoundaryAnswer[] = []
  for (let i = 0; i < us.length - 1; i += 1) {
    const q = us[i] as Utterance
    const a = us[i + 1] as Utterance
    if (!QUESTION.test(q.text)) continue
    if (!scanPolicySensitiveText(q.text).policy_sensitive) continue
    if (QUESTION.test(a.text)) continue
    if (q.speaker !== undefined && a.speaker !== undefined && q.speaker === a.speaker) continue
    if (trimTail(a.text).length < 2) continue
    out.push({
      id: id(out.length),
      question: q.text,
      answer: trimTail(a.text),
      provenance: provenanceOf(record_id, a),
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 知识候选                                                              */
/* ------------------------------------------------------------------ */

/** 陈述句里带"口径"的：政策 / 参数 / 数字承诺。客户或外部人说的话永远不是知识。 */
const STATEMENT_PATTERNS: readonly RegExp[] = [
  /(?:按|照|统一按|一律按)\s*(.+?)\s*(?:算|来|处理|执行)/,
  /(?:我们的|公司的)?(?:政策|规定|口径|标准|流程)\s*(?:是|为)\s*[:：]?\s*(.+)/,
  /\b(?:our|the)\s+(?:policy|rule|standard)\s+is\s+(.+)/i,
]

export interface KnowledgeContext {
  record_id: string
  /** 外部参与者的称呼；他们说的话不进知识库。 */
  externalSpeakers: readonly string[]
  id: (n: number) => string
}

export function extractKnowledge(
  us: readonly Utterance[],
  ctx: KnowledgeContext,
): MeetingKnowledgeCandidate[] {
  const out: MeetingKnowledgeCandidate[] = []
  const external = new Set(ctx.externalSpeakers.map((s) => s.trim().toLowerCase()))
  for (const u of us) {
    if (u.speaker !== undefined && external.has(u.speaker.trim().toLowerCase())) continue
    const matched = STATEMENT_PATTERNS.some((re) => re.test(u.text))
    const scan = scanPolicySensitiveText(u.text)
    if (!matched && !(scan.policy_sensitive && scan.commitments.length > 0)) continue
    const statement = trimTail(u.text)
    if (statement.length < 6) continue
    const hold: string[] = []
    if (scan.policy_sensitive) hold.push('policy_sensitive')
    if (scan.commitments.length > 0) hold.push('contains_commitment')
    if (!isDeidentified(statement)) hold.push('not_deidentified')
    // 会议原话永远只是原料，不是知识（06 §2.6）：出处层一律要人审
    hold.push('source_layer')
    out.push({
      id: ctx.id(out.length),
      layer: scan.policy_sensitive ? 'policy' : 'fact',
      question: statement.slice(0, 80),
      statement,
      hold_reasons: hold,
      provenance: provenanceOf(ctx.record_id, u),
    })
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 下次会议                                                              */
/* ------------------------------------------------------------------ */

const NEXT_MEETING_PATTERNS: readonly RegExp[] = [
  /下(?:次|一次)(?:会议|会|例会)?\s*(?:定在|约在|安排在|定|是)\s*(.+)/,
  /\bnext\s+meeting\s+(?:is\s+)?(?:on\s+|at\s+)?(.+)/i,
]

export function extractNextMeeting(
  us: readonly Utterance[],
  record_id: string,
): MeetingNextMeeting | undefined {
  for (const u of us) {
    for (const re of NEXT_MEETING_PATTERNS) {
      const m = re.exec(u.text)
      if (m === null) continue
      const note = trimTail(m[1] ?? '')
      if (note.length < 2) continue
      return { note, provenance: provenanceOf(record_id, u) }
    }
  }
  return undefined
}
