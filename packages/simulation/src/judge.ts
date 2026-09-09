/**
 * judge（26 §1 的 `rubric` 那一行 / 38 §2 WP32）。
 *
 * 两个 judge，职责分明：
 * - **规则 judge**：确定性、无模型、每档都跑。它只问那些"对错分明"的问题——
 *   必填项在不在、有没有说不该说的词、有没有越权替公司许诺、引没引事实卡、
 *   驳回有没有写原因。**只有它进合并门禁**（26 §4 的门禁是确定性的，不能被模型的心情左右）。
 * - **模型 judge**：主观质量（"这封信像不像人写的"），rubric 放在 pack 的 `judge/*.md` 里，
 *   `purpose: 'judge'` 走网关、pin 温度 0。**只报不拦**（26 §1：CI 无 key 时 replay 重打分）。
 *
 * 评的是"每次运行的产出"：对外草稿（含被编辑后的版本）与人的决定。
 */
import type { ApprovalItem, ModelGateway } from '@agentsws/contracts'
import type { Evidence } from './evidence.js'
import { payloadOf } from './evidence.js'
import type { PackJudgeDoc } from './pack.js'

export interface JudgeCheck {
  /** 规则 id（`required_fields` / `tone` / `no_overreach` / `cites_facts` / `decision_reason`） */
  id: string
  ok: boolean
  /** 被评的对象（审批项 id 或 decision:<id>） */
  target: string
  detail: string
}

export interface RuleJudgeResult {
  /** 通过的检查 / 总检查数；没有可评对象时记 1（不惩罚"这条场景本来就没产出"） */
  score: number
  passed: number
  total: number
  checks: JudgeCheck[]
}

export interface ModelJudgeResult {
  score: number
  model: string
  /** 模型给的分项理由（原样收下，不解释） */
  notes: string[]
  cost_base: number
  /** 没跑成（无 key / 解析失败 / 预算用完）时说明原因；有它就说明 score 不可信 */
  skipped?: string
}

export interface JudgeReport {
  rule: RuleJudgeResult
  model?: ModelJudgeResult
  /** 用了哪一份 rubric（pack 内相对路径） */
  rubric_ref?: string
}

/** 规则 judge 的配置：从 pack 的 `judge/*.md` frontmatter 读。 */
export interface RuleJudgeConfig {
  /** 一律不许出现的词（大小写不敏感） */
  banned: string[]
  /** 至少要出现其中一个（空数组 = 不检查） */
  require_any: string[]
  /** 落款必须包含（空 = 不检查） */
  signature?: string
}

export const DEFAULT_RULE_CONFIG: RuleJudgeConfig = { banned: [], require_any: [] }

/** 把 pack 的 judge 文档解析成规则配置 + rubric 正文。 */
export function judgeConfigOf(docs: readonly PackJudgeDoc[]): {
  config: RuleJudgeConfig
  rubric?: string
  ref?: string
} {
  const doc = docs[0]
  if (doc === undefined) return { config: DEFAULT_RULE_CONFIG }
  const list = (key: string): string[] =>
    (doc.meta[key] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  const signature = doc.meta.signature?.trim()
  return {
    config: {
      banned: list('banned'),
      require_any: list('require_any'),
      ...(signature === undefined || signature.length === 0 ? {} : { signature }),
    },
    rubric: doc.body.trim(),
    ref: doc.path,
  }
}

/** 15 §5：说"已经退给你了"只有在真施行之后才成立。 */
const CLAIMS_DONE = [
  'has been refunded',
  'have refunded',
  'refund has been issued',
  'the money is back',
  '已经退款',
  '已退款',
  '已经退给',
]
/** 承诺公司控制不了的事（22 / 话术层）：具体到日的送达承诺。 */
const OVERPROMISE = [
  'guaranteed delivery',
  'will arrive tomorrow',
  'will be delivered on',
  '保证送达',
  '一定能在',
]

function bodyOf(item: ApprovalItem): string {
  const payload = (item.decision?.edited_payload ?? item.payload) as {
    body?: { subject?: unknown; text?: unknown }
  }
  return String(payload.body?.text ?? '')
}

function subjectOf(item: ApprovalItem): string {
  const payload = (item.decision?.edited_payload ?? item.payload) as {
    body?: { subject?: unknown }
  }
  return String(payload.body?.subject ?? '')
}

/**
 * 规则 judge。对每一张对外草稿跑五条检查、对每一个决定跑一条。
 * 一条检查 = 一分；没有可评对象时 score = 1。
 */
export function runRuleJudge(
  evidence: Evidence,
  config: RuleJudgeConfig = DEFAULT_RULE_CONFIG,
): RuleJudgeResult {
  const checks: JudgeCheck[] = []
  const add = (id: string, target: string, ok: boolean, detail: string): void => {
    checks.push({ id, target, ok, detail })
  }
  const applied = evidence.events.some((e) => e.type === 'change.applied')
  const injectedFactCards = evidence.runs.some((r) =>
    r.request.context.some((c) => c.kind === 'fact_card'),
  )

  for (const item of evidence.approvals.filter((i) => i.kind === 'outbound_draft')) {
    const body = bodyOf(item)
    const subject = subjectOf(item)
    const lower = body.toLowerCase()

    // ① 必填项：主题、正文、落款
    const hasSignature =
      config.signature === undefined || config.signature.length === 0
        ? body
            .trim()
            .split('\n')
            .filter((l) => l.trim().length > 0).length > 1
        : body.includes(config.signature)
    add(
      'required_fields',
      item.id,
      subject.trim().length > 0 && body.trim().length > 20 && hasSignature,
      `subject=${subject.length} body=${body.length} signature=${hasSignature}`,
    )

    // ② 语气：不许出现的词
    const banned = config.banned.filter((w) => lower.includes(w.toLowerCase()))
    add(
      'tone',
      item.id,
      banned.length === 0,
      banned.length === 0 ? '没有禁用词' : `出现了：${banned.join(', ')}`,
    )

    // ③ 不越权：没施行就不能说已经退了，也不许承诺控制不了的事
    const claims = CLAIMS_DONE.filter((w) => lower.includes(w.toLowerCase()))
    const promises = OVERPROMISE.filter((w) => lower.includes(w.toLowerCase()))
    add(
      'no_overreach',
      item.id,
      (claims.length === 0 || applied) && promises.length === 0,
      `claims=[${claims.join(', ')}] promises=[${promises.join(', ')}] applied=${applied}`,
    )

    // ④ 引用事实卡：上下文里注入过事实卡的运行，草稿必须引一张
    const cites = item.evidence.citations ?? []
    add('cites_facts', item.id, !injectedFactCards || cites.length > 0, `citations=${cites.length}`)

    // ⑤ 至少提到一次订单/关键要素
    if (config.require_any.length > 0) {
      const hit = config.require_any.filter((w) => lower.includes(w.toLowerCase()))
      add(
        'require_any',
        item.id,
        hit.length > 0,
        hit.length > 0 ? `命中 ${hit.join(', ')}` : `一个都没提：${config.require_any.join(', ')}`,
      )
    }
  }

  // 决定：驳回必须写原因（14 §9 负样本要有理由才进 lesson 池）
  for (const e of evidence.events.filter((x) => x.type === 'approval.decided')) {
    const p = payloadOf(e)
    if (p.action !== 'reject') continue
    const reason = typeof p.reason === 'string' ? p.reason : ''
    add(
      'decision_reason',
      `decision:${String(e.subject?.id ?? '?')}`,
      reason.trim().length > 0,
      reason.trim().length > 0 ? '有原因' : '驳回没写原因',
    )
  }

  const passed = checks.filter((c) => c.ok).length
  return {
    score: checks.length === 0 ? 1 : passed / checks.length,
    passed,
    total: checks.length,
    checks,
  }
}

export interface ModelJudgeInput {
  gateway: Pick<ModelGateway, 'complete'>
  evidence: Evidence
  rubric: string
  meta: {
    workspace_id: string
    assignment_id: string
    role_id: string
    run_id: string
  }
  /** 这次打分最多花多少（基准货币）；网关按 run_id 累计。 */
  max_cost_base?: number
}

const SCORE_RE = /"score"\s*:\s*(-?\d+(?:\.\d+)?)/

/**
 * 模型 judge（22 §2：`purpose: 'judge'` 固定 pin）。**只报不拦。**
 * 拿不到分（无 provider / 解析失败 / 预算用完）就返回 `skipped`，不抛。
 */
export async function runModelJudge(input: ModelJudgeInput): Promise<ModelJudgeResult> {
  const drafts = input.evidence.approvals
    .filter((i) => i.kind === 'outbound_draft')
    .map((i) => `--- draft ${i.id} ---\n主题：${subjectOf(i)}\n正文：\n${bodyOf(i)}`)
  if (drafts.length === 0) {
    return { score: 1, model: 'none', notes: [], cost_base: 0, skipped: '这条场景没有对外草稿' }
  }
  try {
    const completion = await input.gateway.complete({
      messages: [
        {
          role: 'system',
          content:
            `${input.rubric}\n\n` +
            '只输出一个 JSON 对象：{"score": 0..1, "notes": ["一句话理由", ...]}。不要解释，不要代码块。',
        },
        { role: 'user', content: drafts.join('\n\n') },
      ],
      seed: 0,
      ...(input.max_cost_base === undefined ? {} : { max_cost_base: input.max_cost_base }),
      meta: { ...input.meta, purpose: 'judge' },
    })
    const text = completion.text
    const m = SCORE_RE.exec(text)
    const model = `${completion.model.provider}/${completion.model.model}`
    if (m?.[1] === undefined) {
      return {
        score: 0,
        model,
        notes: [],
        cost_base: completion.usage.cost_base,
        skipped: `模型没给出可解析的 score：${text.slice(0, 120)}`,
      }
    }
    let notes: string[] = []
    try {
      const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) as {
        notes?: unknown
      }
      if (Array.isArray(parsed.notes)) notes = parsed.notes.map((n) => String(n))
    } catch {
      notes = []
    }
    return {
      score: Math.min(1, Math.max(0, Number.parseFloat(m[1]))),
      model,
      notes,
      cost_base: completion.usage.cost_base,
    }
  } catch (err) {
    const e = err as { message?: string }
    return {
      score: 0,
      model: 'unavailable',
      notes: [],
      cost_base: 0,
      skipped: e.message ?? String(err),
    }
  }
}
