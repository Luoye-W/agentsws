/**
 * 58 §2 `brief.ts`：**需求单 → brief，纯函数**。
 *
 * 纯到什么程度：没有 `Date.now()`（时间由调用方递进来）、没有 id 生成（同上）、
 * 没有模型调用。这一跳做的是**把一段需求整理成一份有尺寸、有禁忌、有变体计划
 * 的东西**——它是可复核的整理，不是创作。真正要模型的是 `variants.ts` 里
 * 提示词那一段的润色，而那一段也在人点之前只进队列。
 *
 * 为什么整理这一跳不交给模型：需求单里真正要的三件事——**画哪个尺寸、
 * 不许出现什么、出几版**——每一件都有确定答案（规格表、品牌系统、额度）。
 * 交给模型的结果是它偶尔把 Amazon 主图写成 1200×628，而这种错要等到
 * 上架被退回来才发现。
 */

import type {
  DesignBrief,
  DesignDuty,
  DesignRequest,
  DesignSpec,
  DesignVariantPlanItem,
} from '@agentsws/contracts'
import { DESIGN_CAPS } from '@agentsws/contracts'
import type { BrandSystemCard } from './brand.js'
import { type ResolvedBrandSystem, resolveBrandSystem } from './brand.js'
import { resolveSpec, specNoteZh, specsForDuty } from './specs.js'

export interface DraftBriefInput {
  request: DesignRequest
  /** 公司层技能里的品牌系统卡（`brand.ts` 挑一张）。空数组 = 还没设。 */
  brand_cards?: readonly BrandSystemCard[]
  /** 这次要出几版（默认 58 §6 的 `max_variants_per_brief`，6）。 */
  variants?: number
  /** brief 的 id 与时间由调用方给（这个模块不生成、不看表）。 */
  id: string
  at: string
}

export interface DraftBriefResult {
  brief: DesignBrief
  brand: ResolvedBrandSystem
  /**
   * 整理不出来的那几件事，人话一条一条列。
   *
   * **不是错误**：需求单写得糊涂是常态。brief 照样出，但这几句原样出现在
   * brief 卡上，让下需求的人一眼看到"我漏说了哪几样"（58 §3 的 brief 卡
   * 就是这一问）。编一个"合理的默认值"填进去才是真的错——那等于我们替
   * 需求方做了决定，而卡面上看不出来。
   */
  questions: readonly string[]
}

/**
 * 需求单 → brief。
 *
 * 五格怎么来的，每一格都有出处：
 *
 * | brief 的格 | 从哪来 |
 * |---|---|
 * | `spec_ids` | 需求单写了就用它的；没写就按职责的规格族给**默认那一条**并记一句问 |
 * | `goal` / `audience` / `key_message` | 需求原文里切出来；切不出来就留空并记一句问 |
 * | `copy` | 需求原文里引号 / 书名号里的那几段（人写文案习惯加引号） |
 * | `must_avoid` | 品牌系统的 `forbidden` + 规格上的硬规矩（主图不许有字…） |
 * | `variant_plan` | 规格 × 角度，张数按额度截断 |
 */
export function draftBrief(input: DraftBriefInput): DraftBriefResult {
  const { request } = input
  const brand = resolveBrandSystem(input.brand_cards ?? [], request.duty)
  const questions: string[] = []

  const specs = pickSpecs(request, questions)
  const parsed = readNeed(request.need)
  if (parsed.goal === undefined)
    questions.push('这张图要达成什么？（"让人一眼看懂它能塞进背包"这种一句话就够）')
  if (parsed.audience === undefined) questions.push('给谁看？（新客 / 老客 / 某个平台的人群）')

  const must_avoid = [...(brand.system?.forbidden ?? []), ...specs.flatMap(hardRules)].filter(
    (t, i, all) => t !== '' && all.indexOf(t) === i,
  )
  if (brand.system === undefined)
    questions.push('这个品牌还没设品牌系统（色 / 字 / 版式 / 禁忌）——出图会每张一个风格。')

  const wanted = input.variants ?? DESIGN_CAPS.max_variants_per_brief
  const variant_plan = planVariants(specs, Math.min(wanted, DESIGN_CAPS.max_variants_per_brief))

  const brief: DesignBrief = {
    id: input.id,
    workspace_id: request.workspace_id,
    request_id: request.id,
    duty: request.duty,
    goal: parsed.goal ?? '',
    audience: parsed.audience ?? '',
    key_message: parsed.key_message ?? request.title,
    copy: parsed.copy,
    spec_ids: specs.map((s) => s.id),
    must_avoid,
    ...(brand.system === undefined ? {} : { brand_system: brand.system.name }),
    variant_plan,
    created_at: input.at,
  }
  return { brief, brand, questions }
}

/** 需求单要哪几个规格。写了就用它的，写错的原样报出来，一个都没写就给默认那一条。 */
function pickSpecs(request: DesignRequest, questions: string[]): DesignSpec[] {
  const known: DesignSpec[] = []
  for (const id of request.spec_ids) {
    const spec = resolveSpec(id)
    if (spec === undefined) questions.push(`需求单里写的规格 \`${id}\` 我不认识，请从规格表里挑。`)
    else known.push(spec)
  }
  if (known.length > 0) return known
  const fallback = specsForDuty(request.duty)[0]
  if (fallback === undefined) {
    questions.push('这条职责还没有规格表，尺寸得你来定。')
    return []
  }
  questions.push(`需求单没写尺寸，先按「${fallback.zh}」来——不对的话在卡上改一下。`)
  return [fallback]
}

/**
 * 规格上的硬规矩 → 禁忌词。
 *
 * 只把**能当词查**的那几条翻过来（`max_text_chars === 0` → "文字""水印"），
 * 因为 `must_avoid` 的下游是 guardrail 的字符串匹配。安全区、出血这类
 * 数字约束留在 `specNoteZh` 里给人看，翻成词只会误伤。
 */
function hardRules(spec: DesignSpec): string[] {
  return spec.max_text_chars === 0 ? ['文字', '水印', 'text overlay', 'watermark'] : []
}

/** 引号里的那几段（人写文案习惯加引号）。 */
const QUOTED = /[“"「『]([^”"」』]{1,60})[”"」』]/g
/**
 * 带冒号的**明写**优先，软提示（"想要…""为了…"）在后。
 *
 * 顺序有讲究："下周上新，想要一张 IG 的方图。目标：让人看懂它能塞进背包。"
 * 这句里两种都命中了，而人真正想说的目标在"目标："后面。软提示排在前面的
 * 后果是 brief 上写着"目标：一张 IG 的方图"——一句什么都没说的话。
 */
const GOAL = [/(?:目标|goal)\s*[:：]\s*(.{4,60})/, /(?:为了|想要|希望|要做到)\s*(.{4,60})/]
const AUDIENCE = [
  /(?:受众|给谁看|人群|audience)\s*[:：]\s*(.{2,40})/,
  /(?:受众|给谁看|面向|人群|audience)\s*[:：]?\s*(.{2,40})/,
]
const MESSAGE = [
  /(?:主张|卖点|一句话|key message)\s*[:：]\s*(.{2,60})/,
  /(?:主张|卖点|一句话|key message)\s*(.{2,60})/,
]

/**
 * 从需求原文里切出四样。
 *
 * **切不出来就留空**，不猜。这段文本是别的岗位（甚至顾客的一句话）写的，
 * 拿正则去"理解"它已经到极限了；猜一个目标出来，brief 卡上看起来像模像样，
 * 而它是我们编的。
 */
export function readNeed(need: string): {
  goal?: string
  audience?: string
  key_message?: string
  copy: readonly string[]
} {
  const line = (patterns: readonly RegExp[]): string | undefined => {
    for (const re of patterns) {
      const m = re.exec(need)
      const value = m?.[1]?.split(/[。；;\n]/)[0]?.trim()
      if (value !== undefined && value !== '') return value
    }
    return undefined
  }
  const copy: string[] = []
  for (const m of need.matchAll(QUOTED)) {
    const text = m[1]?.trim()
    if (text !== undefined && text !== '') copy.push(text)
  }
  const goal = line(GOAL)
  const audience = line(AUDIENCE)
  const key_message = line(MESSAGE)
  return {
    ...(goal === undefined ? {} : { goal }),
    ...(audience === undefined ? {} : { audience }),
    ...(key_message === undefined ? {} : { key_message }),
    copy,
  }
}

/**
 * 规格 × 角度 → 变体计划。
 *
 * **张数按规格摊匀**：要 6 张、有 2 个规格，就是每个规格 3 张，不是第一个
 * 规格 6 张第二个 0 张。角度按 {@link ANGLES} 轮，轮完再从头——同一个规格
 * 出 5 张而只有 4 个角度时，第 5 张与第 1 张同角度但提示词里带序号，
 * 模型出来的仍然是两张不同的图。
 */
export function planVariants(
  specs: readonly DesignSpec[],
  total: number,
): readonly DesignVariantPlanItem[] {
  if (specs.length === 0 || total <= 0) return []
  const plan: DesignVariantPlanItem[] = []
  const per = Math.max(1, Math.floor(total / specs.length))
  for (const spec of specs) {
    for (let i = 0; i < per && plan.length < total; i += 1) {
      const angle = ANGLES[i % ANGLES.length] ?? ANGLES[0]
      if (angle === undefined) continue
      plan.push({
        id: `${spec.id}#${i + 1}`,
        spec_id: spec.id,
        angle_zh: angle.zh,
        angle_en: angle.en,
        // 提示词在这里只是**骨架**：品牌系统与禁忌由 `variants.ts` 注入
        prompt: `${angle.zh}。${specNoteZh(spec)}`,
      })
    }
  }
  // 摊不匀剩下的，补在第一个规格上
  let i = per
  while (plan.length < total) {
    const spec = specs[0]
    if (spec === undefined) break
    const angle = ANGLES[i % ANGLES.length] ?? ANGLES[0]
    if (angle === undefined) break
    plan.push({
      id: `${spec.id}#${i + 1}`,
      spec_id: spec.id,
      angle_zh: angle.zh,
      angle_en: angle.en,
      prompt: `${angle.zh}。${specNoteZh(spec)}`,
    })
    i += 1
  }
  return plan
}

/**
 * 变体的角度（58 §1「变体计划」）。
 *
 * 四个而不是一个"随便出几版"：变体的意义是**同一件事的不同讲法**，
 * 四个讲法覆盖了电商素材里绝大多数的差别（产品本身 / 用起来什么样 /
 * 多大 / 卖点摊开）。角度一样、只换个随机种子出来的六张图，人挑起来
 * 等于没得挑。
 */
export const ANGLES: readonly { zh: string; en: string }[] = [
  {
    zh: '产品本身：干净背景、正面视角、细节清楚',
    en: 'Product only: clean background, front view',
  },
  { zh: '用起来什么样：真实场景里有人在用', en: 'In use: a real scene with someone using it' },
  { zh: '多大：与常见物件同框做尺寸参照', en: 'Scale: next to an everyday object for size' },
  { zh: '卖点摊开：几个关键点分块排列', en: 'Feature breakdown: key points laid out' },
]

/** brief → 给人看的那一段（58 §3 brief 卡的正文）。 */
export function briefSummaryZh(result: DraftBriefResult): string {
  const { brief } = result
  const lines = [
    `目标：${brief.goal === '' ? '（需求单没说）' : brief.goal}`,
    `受众：${brief.audience === '' ? '（需求单没说）' : brief.audience}`,
    `一句话：${brief.key_message}`,
    `尺寸：${brief.spec_ids.map((id) => resolveSpec(id)?.zh ?? id).join('、')}`,
    `出 ${brief.variant_plan.length} 版：${[...new Set(brief.variant_plan.map((v) => v.angle_zh.split('：')[0]))].join(' / ')}`,
  ]
  if (brief.copy.length > 0) lines.push(`图上文案：${brief.copy.join(' / ')}`)
  if (brief.must_avoid.length > 0) lines.push(`不许出现：${brief.must_avoid.join('、')}`)
  lines.push(result.brand.note)
  if (result.questions.length > 0) lines.push(`还得你说一句：${result.questions.join(' ')}`)
  return lines.join('\n')
}
