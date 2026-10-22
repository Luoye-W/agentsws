/**
 * WP449（docs/109 §5.1 #7）：**「好不好被 AI 引用」打分**——五项规则、0–100、数不经模型手。
 *
 * | 项 | 满分 | 怎么数 |
 * |---|---|---|
 * | 先给答案 `answer_first` | 25 | 开头与每个小节的第一句：不是问句、不是铺垫套话、不太长 |
 * | 段落自足 `self_contained` | 20 | 段落不靠「这 / 它 / 如上所述」接上文，单独拎出来也读得懂 |
 * | 实体说清 `entity_clear` | 20 | 开头点名品牌 / 商品；标题里的词开头就出现（文不对题会扣） |
 * | 数字带出处 `figures_sourced` | 20 | 带数字的句子，数在事实卡里、或这句链着出处；一个数都没有只给一半 |
 * | 能抽成列表 / 表格 `extractable` | 15 | 两个以上小节、问句小标题、列表、表格 |
 *
 * 用在两处：内容与博客的发布前质检里给**建议**（不挡发布）；SEO 与 GEO 写 GEO 缺位的改动稿时照这五条写
 * （{@link AI_CITABILITY_RULES}）。分数只是编辑上的参考，不是「会被引用的概率」，也不承诺被引用。
 *
 * 方法借鉴 AgriciDaniel/claude-blog（MIT）的 blog-geo（逐节看能否单独引用、说法 + 证据 + 出处、
 * 实体一致、结构可抽取）与 AgriciDaniel/claude-seo（MIT）的 seo-geo；**代码一行没搬**，分项与权重是我们定的。
 */
import type { AiCitabilityCheck, AiCitabilityScore } from '@agentsws/contracts'
import { extractFigures } from '@agentsws/core'
import type { ContentBlock } from './content-text.js'
import { contentSentences } from './content-text.js'

/** 五条写法（给模型的提示词与技能里用同一份说法）。 */
export const AI_CITABILITY_RULES = {
  zh: [
    '先给答案：开头和每个小节的第一句直接回答，不铺垫',
    '段落自足：每段单独拎出来也读得懂，不用「这 / 它 / 如上所述」接上文',
    '实体说清：开头点名品牌和商品全名，全篇叫法一致',
    '数字带出处：每个数都指得回事实卡，引外面的数要链到原页',
    '能抽成列表 / 表格：步骤用编号列表，比较用表格，小标题用买家的原话提问',
  ],
  en: [
    'Answer first: the opening and the first sentence of each section answer directly',
    'Self-contained paragraphs: each reads on its own, no "this / it / as mentioned above"',
    'Clear entities: name the brand and full product name early; keep names consistent',
    'Sourced numbers: every figure traces to a fact card; outside figures link to the source page',
    'Extractable structure: numbered steps, comparison tables, question-style headings',
  ],
} as const

const FILLER = [
  /^(in today'?s|in this (article|post|guide)|have you ever|are you (looking|wondering)|when it comes to|let'?s (dive|talk|take)|welcome to|it'?s no secret)/i,
  /^(in der heutigen|in diesem (artikel|beitrag)|hast du dich|haben sie sich|willkommen)/i,
  /^(dans cet article|vous êtes-vous|bienvenue)/i,
  /^(随着|在当今|你是否|您是否|相信很多人|众所周知|本文将|今天我们|今天来)/,
]

const DANGLING = [
  /^(this|that|these|those)\s+(is|are|was|were|means|meant|makes|will|can|also|way|one)\b/i,
  /^(it|they|he|she)\b/i,
  /^(as (mentioned|noted|shown|discussed|we said)|see above|above,|also,)/i,
  /^(dies|das ist|wie oben|wie bereits)\b/i,
  /^(cela|ceci|comme mentionné)\b/i,
  /^(这|它|上述|如上|以上|其|此外|另外|同时)/,
]

const cjk = (s: string): boolean => /[㐀-鿿]/.test(s)
const words = (s: string): number =>
  cjk(s) ? Math.ceil(s.replace(/\s/g, '').length / 2) : s.split(/\s+/).filter(Boolean).length

interface Section {
  heading?: ContentBlock
  blocks: ContentBlock[]
}

function sections(blocks: readonly ContentBlock[]): { title?: string; parts: Section[] } {
  const parts: Section[] = [{ blocks: [] }]
  let title: string | undefined
  for (const b of blocks) {
    if (b.kind === 'heading' && (b.level ?? 2) <= 1) {
      title ??= b.text
      continue
    }
    if (b.kind === 'heading' && (b.level ?? 2) === 2) {
      parts.push({ heading: b, blocks: [] })
      continue
    }
    parts[parts.length - 1]?.blocks.push(b)
  }
  return {
    ...(title === undefined ? {} : { title }),
    parts: parts.filter(
      (p) => p.heading !== undefined || p.blocks.some((b) => b.kind !== 'heading'),
    ),
  }
}

function firstSentence(sec: Section): string | undefined {
  const first = sec.blocks.find((b) => b.kind !== 'heading')
  if (first === undefined) return undefined
  // 问题下面直接一张表：表本身就是答案（表头那一行算第一句）
  if (first.kind === 'table_row') return first.text
  return contentSentences([first])[0]?.text
}

function answersFirst(s: string | undefined): boolean {
  if (s === undefined) return false
  if (/[?？]\s*$/.test(s)) return false
  if (FILLER.some((re) => re.test(s.trim()))) return false
  return words(s) <= 40
}

const pts = (max: number, ratio: number): number =>
  Math.round(max * Math.max(0, Math.min(1, ratio)))

const termsOf = (s: string): string[] =>
  cjk(s)
    ? [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(s)]
        .filter((x) => x.isWordLike === true && x.segment.length >= 2)
        .map((x) => x.segment.toLowerCase())
    : s
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((w) => w.length > 3)

/**
 * 打分。`entities` 是品牌名、商品名（开头要点名的那几个）；`knownFigures` 是事实卡里的数（归一过的，
 * 比法同质检：去掉逗号空格）。纯函数、同输入同输出。
 */
export function scoreAiCitability(input: {
  blocks: readonly ContentBlock[]
  entities?: readonly string[]
  knownFigures?: ReadonlySet<string>
}): AiCitabilityScore {
  const { title, parts } = sections(input.blocks)
  const checks: AiCitabilityCheck[] = []

  // 1 先给答案
  const firsts = parts.map((p) => ({ name: p.heading?.text ?? '开头', s: firstSentence(p) }))
  const good = firsts.filter((f) => answersFirst(f.s))
  const miss = firsts.find((f) => !answersFirst(f.s))
  checks.push({
    id: 'answer_first',
    label: '先给答案',
    max: 25,
    points: pts(25, firsts.length === 0 ? 0 : good.length / firsts.length),
    detail: `${firsts.length} 段里 ${good.length} 段第一句就给了答案`,
    ...(miss === undefined
      ? {}
      : { hint: `「${miss.name}」那段第一句先给结论（别用问句或套话开头，40 词以内）` }),
  })

  // 2 段落自足
  const paras = input.blocks.filter((b) => b.kind === 'paragraph' && words(b.text) >= 6)
  const dangling = paras.filter((b) => DANGLING.some((re) => re.test(b.text)))
  checks.push({
    id: 'self_contained',
    label: '段落自足',
    max: 20,
    points: pts(20, paras.length === 0 ? 0 : 1 - dangling.length / paras.length),
    detail: `${paras.length} 段里 ${paras.length - dangling.length} 段单独拎出来也读得懂`,
    ...(dangling[0] === undefined
      ? {}
      : { hint: `「${dangling[0].text.slice(0, 24)}…」开头靠上文，把「这 / 它」换成说的那样东西` }),
  })

  // 3 实体说清
  const intro = [title ?? '', ...(parts[0]?.blocks ?? []).map((b) => b.text)]
    .join(' ')
    .toLowerCase()
  const entities = (input.entities ?? []).filter((e) => e.trim() !== '')
  const named = entities.some((e) => intro.includes(e.toLowerCase()))
  const titleTerms = title === undefined ? [] : [...new Set(termsOf(title))]
  const opening = (parts[0]?.blocks ?? [])
    .map((b) => b.text)
    .join(' ')
    .toLowerCase()
  const covered = titleTerms.filter((t) => opening.includes(t))
  const match = titleTerms.length === 0 ? 0 : covered.length / titleTerms.length
  checks.push({
    id: 'entity_clear',
    label: '实体说清',
    max: 20,
    points: (named ? 10 : 0) + pts(10, match >= 0.5 ? 1 : match * 2),
    detail: `${named ? '开头点了品牌 / 商品名' : '开头没点品牌 / 商品名'}；标题里的词开头出现了 ${covered.length}/${titleTerms.length} 个`,
    ...(named && match >= 0.5
      ? {}
      : { hint: named ? '开头一两句把标题说的那件事讲出来' : '开头一两句写出品牌与商品全名' }),
  })

  // 4 数字带出处
  const sentences = contentSentences(input.blocks.filter((b) => b.kind !== 'heading'))
  const withFig = sentences.filter((s) => extractFigures(s.text).length > 0)
  const known = input.knownFigures ?? new Set<string>()
  const sourced = withFig.filter(
    (s) =>
      s.links.some((l) => /^https?:\/\//i.test(l)) ||
      extractFigures(s.text).every((f) => known.has(f.replace(/[,\s_]/g, ''))),
  )
  checks.push({
    id: 'figures_sourced',
    label: '数字带出处',
    max: 20,
    points: withFig.length === 0 ? 10 : pts(20, sourced.length / withFig.length),
    detail:
      withFig.length === 0
        ? '正文里没有具体的数'
        : `${withFig.length} 句带数字，${sourced.length} 句指得回事实卡或链着出处`,
    ...(withFig.length === 0
      ? { hint: '用事实卡里的具体参数（容量、尺寸、保修）把答案说实' }
      : sourced.length < withFig.length
        ? { hint: '没出处的数删掉，或者链到原页' }
        : {}),
  })

  // 5 能抽成列表 / 表格
  const h2 = parts.filter((p) => p.heading !== undefined)
  const question = h2.some((p) => /[?？]\s*$/.test(p.heading?.text ?? ''))
  const list = input.blocks.some((b) => b.kind === 'list_item')
  const table = input.blocks.some((b) => b.kind === 'table_row')
  const ex = (h2.length >= 2 ? 4 : 0) + (question ? 3 : 0) + (list ? 4 : 0) + (table ? 4 : 0)
  const lacking = [
    h2.length >= 2 ? '' : '分小节',
    question ? '' : '用买家的问题做小标题',
    list ? '' : '步骤写成编号列表',
    table ? '' : '比较写成表格',
  ].filter((x) => x !== '')
  checks.push({
    id: 'extractable',
    label: '能抽成列表 / 表格',
    max: 15,
    points: ex,
    detail: `${h2.length} 个小节${question ? '、有问句小标题' : ''}${list ? '、有列表' : ''}${table ? '、有表格' : ''}`,
    ...(lacking.length === 0 ? {} : { hint: `可以${lacking.slice(0, 2).join('、')}` }),
  })

  return { score: checks.reduce((a, c) => a + c.points, 0), checks }
}

/** 卡上那一行（只给分数与最该改的两条）。 */
export function citabilityLine(s: AiCitabilityScore): string {
  const weak = [...s.checks]
    .filter((c) => c.hint !== undefined && c.points < c.max)
    .sort((a, b) => a.points / a.max - b.points / b.max)
    .slice(0, 2)
    .map((c) => c.hint)
  return `好不好被 AI 引用：${s.score}/100${weak.length === 0 ? '' : `。建议：${weak.join('；')}`}（只是建议，不挡发布）`
}
