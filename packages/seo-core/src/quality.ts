/**
 * 发布前的内容质检门禁（WP154 §6；借 GEOFlow 的"发布前自动检查"这个**思路**，代码自己写——
 * GEOFlow 是 AGPL-3.0，一行都没搬）。
 *
 * 三道检查，逐句看：
 *
 * 1. **事实对得上知识库**（`fact_mismatch`）：一句话提到了某条事实卡管的那件事（保修、续航、
 *    价格……），而句子里的数字那条卡里没有 → "知识库里写的是……"；
 * 2. **数字有出处**（`unsourced_figure`）：句子里的数字在任何一条事实卡里都找不到；
 *    数字抽取用 `@agentsws/core` 的 `extractFigures`——与新闻稿那道门**同一份代码**；
 * 3. **没有违规宣称**（`banned_claim`）：绝对化用语、医疗功效……规则表放知识库、人可改
 *    （`subject.type === 'content_rule'` 的事实卡），知识库里一条都没有时用 `DEFAULT_CLAIM_RULES`。
 *
 * 不过就挡在草稿：服务端把"发布"改回"草稿"，卡上逐条说明哪句有问题（`ContentQualityResult`）。
 * 纯函数、同输入同输出、不调模型。
 */
import type {
  ContentClaimRule,
  ContentQualityIssue,
  ContentQualityResult,
  Iso8601,
} from '@agentsws/contracts'
import { extractFigures } from '@agentsws/core'

/**
 * 默认的违规宣称规则表（知识库里还没有 `content_rule` 卡时用）。
 *
 * 只收"几乎在任何市场都会出事"的那几类：绝对化用语（中国广告法第九条那一串、英文的
 * "#1 / guaranteed"）、医疗功效（普通商品宣称治疗 / 预防疾病）。行业特有的（化妆品、
 * 保健品、儿童用品）由人在知识库里加。
 */
export const DEFAULT_CLAIM_RULES: readonly ContentClaimRule[] = [
  { id: 'abs_zh_best', pattern: '最好', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_first', pattern: '第一品牌', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_only', pattern: '唯一', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_top', pattern: '顶级', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_lowest', pattern: '全网最低', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_never', pattern: '永不', category: 'absolute', reason: '绝对化用语' },
  { id: 'abs_zh_100', pattern: '100%', category: 'absolute', reason: '绝对化用语（百分之百）' },
  {
    id: 'abs_en_best',
    pattern: '\\bbest in the world\\b',
    regex: true,
    category: 'absolute',
    reason: 'Absolute claim',
  },
  { id: 'abs_en_no1', pattern: '#1', category: 'absolute', reason: 'Absolute claim ("#1")' },
  {
    id: 'abs_en_guarantee',
    pattern: '\\bguarantee(d)?\\b',
    regex: true,
    category: 'absolute',
    reason: 'Absolute claim ("guaranteed")',
  },
  {
    id: 'abs_en_never',
    pattern: '\\bnever (fails|breaks)\\b',
    regex: true,
    category: 'absolute',
    reason: 'Absolute claim',
  },
  { id: 'med_zh_cure', pattern: '治愈', category: 'medical', reason: '医疗功效宣称' },
  { id: 'med_zh_treat', pattern: '治疗', category: 'medical', reason: '医疗功效宣称' },
  { id: 'med_zh_prevent', pattern: '预防疾病', category: 'medical', reason: '医疗功效宣称' },
  { id: 'med_zh_cancer', pattern: '抗癌', category: 'medical', reason: '医疗功效宣称' },
  {
    id: 'med_en_cure',
    pattern: '\\b(cures?|heals?|treats?) (disease|cancer|diabetes|anxiety|insomnia)\\b',
    regex: true,
    category: 'medical',
    reason: 'Medical claim',
  },
  {
    id: 'med_en_fda',
    pattern: '\\bfda[- ]approved\\b',
    regex: true,
    category: 'medical',
    reason: 'Regulatory claim needs proof',
  },
]

/** 质检要看的那一份事实卡（服务端从知识库投影出来）。 */
export interface FactLike {
  id: string
  statement: string
  /** 这条卡管的那件事的几个说法（"保修" / "warranty"）；句子里出现它才算"在说这件事"。 */
  terms?: readonly string[]
}

/** 知识库里的一张卡 → 规则（不是 `content_rule` 或形状不对 → `undefined`）。 */
export function ruleFromFact(card: {
  id: string
  subject: { type: string; key: string }
  statement: string
  structured?: Record<string, unknown>
}): ContentClaimRule | undefined {
  if (card.subject.type !== 'content_rule') return undefined
  const s = card.structured ?? {}
  const pattern = typeof s.pattern === 'string' && s.pattern !== '' ? s.pattern : card.subject.key
  if (pattern.trim() === '') return undefined
  const category =
    s.category === 'absolute' || s.category === 'medical' ? s.category : ('other' as const)
  return {
    id: card.id,
    pattern,
    ...(s.regex === true ? { regex: true } : {}),
    category,
    reason: typeof s.reason === 'string' && s.reason !== '' ? s.reason : card.statement,
  }
}

/** 按句切（中英文句末标点与换行）。 */
export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])|(?<=\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
}

const figureKey = (v: string): string => v.replace(/[,\s_]/g, '')

function matches(rule: ContentClaimRule, sentence: string): boolean {
  if (rule.regex === true) {
    try {
      return new RegExp(rule.pattern, 'i').test(sentence)
    } catch {
      return false
    }
  }
  return sentence.toLowerCase().includes(rule.pattern.toLowerCase())
}

/**
 * 跑一遍质检。`rules` 不给（知识库里没有规则卡）就用默认表，并在结果里记 `rules_from: 'default'`。
 */
export function checkContentQuality(input: {
  body: string
  title?: string
  facts: readonly FactLike[]
  rules?: readonly ContentClaimRule[]
  now: Iso8601
}): ContentQualityResult {
  const rules =
    input.rules !== undefined && input.rules.length > 0 ? input.rules : DEFAULT_CLAIM_RULES
  const known = new Set(input.facts.flatMap((f) => extractFigures(f.statement).map(figureKey)))
  const issues: ContentQualityIssue[] = []
  const text = [input.title ?? '', input.body].filter((t) => t.trim() !== '').join('\n')
  for (const sentence of splitSentences(text)) {
    for (const rule of rules)
      if (matches(rule, sentence))
        issues.push({
          rule: 'banned_claim',
          sentence,
          detail: `${rule.reason}（命中「${rule.pattern}」）`,
        })
    const figures = extractFigures(sentence)
    if (figures.length === 0) continue
    const lower = sentence.toLowerCase()
    for (const fig of figures) {
      if (known.has(figureKey(fig))) continue
      const about = input.facts.find(
        (f) =>
          (f.terms ?? []).some((t) => t.trim() !== '' && lower.includes(t.toLowerCase())) &&
          extractFigures(f.statement).length > 0,
      )
      issues.push(
        about === undefined
          ? { rule: 'unsourced_figure', sentence, detail: `这个数字在知识库里找不到出处：${fig}` }
          : {
              rule: 'fact_mismatch',
              sentence,
              detail: `知识库里写的是「${about.statement}」，这里写的是 ${fig}`,
            },
      )
    }
  }
  return {
    passed: issues.length === 0,
    issues,
    checked_at: input.now,
    rules_from: input.rules !== undefined && input.rules.length > 0 ? 'knowledge' : 'default',
  }
}

/** 卡上那一段说明：逐条"哪句 → 哪里不对"（最多 5 条，其余说还有几条）。 */
export function qualitySummary(result: ContentQualityResult): string {
  if (result.passed) return '发布前质检通过：数字都有出处，没有违规宣称。'
  const lines = result.issues.slice(0, 5).map((i) => `「${i.sentence}」——${i.detail}`)
  const more = result.issues.length > 5 ? `\n还有 ${result.issues.length - 5} 处。` : ''
  return `没过发布前质检，先留在草稿：\n${lines.join('\n')}${more}`
}
