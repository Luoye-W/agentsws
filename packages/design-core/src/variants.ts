/**
 * 58 §2 `variants.ts`：变体计划 + 提示词组装 + 品牌系统注入。
 *
 * 三条纪律写在这个模块里：
 *
 * 1. **额度在提交之前就先说**。{@link planGeneration} 算出"这次要几张、
 *    今天还剩几张"，超了就在计划里直接标出来——与 guardrail 判的是同一个数
 *    （`max_variants_per_brief` / `max_generations_per_day`），只是这一边
 *    提前说，那一边真拦（同 `social-core` 的 `SCHEDULE_RULES`）。
 * 2. **禁忌词自查一遍，但不算数**。{@link checkPrompt} 是给起草那一跳的
 *    即时反馈；真正的强制在 guardrail 的 `design_variant` 那条 block——
 *    这一跳是 Agent 自己写的，Agent 自查不能当门。
 * 3. **没有图片模型时照样出计划**（58 §1：没有就明说"只出 brief 与规格，
 *    不出图"）。{@link planGeneration} 不碰模型，它的产物是一份"要是能出图，
 *    该这么出"的清单；出不出得了由调用方看 `gateway.images.available`。
 */

import type { DesignBrief, DesignSpec, DesignVariantPlanItem } from '@agentsws/contracts'
import { DESIGN_CAPS } from '@agentsws/contracts'
import { brandPrompt, type ResolvedBrandSystem } from './brand.js'
import { canvasOf, resolveSpec, specNoteZh } from './specs.js'

/** 一张图的最终提示词与画布。直接喂 `ImageProvider.generate`。 */
export interface VariantPrompt {
  /** 对应 `brief.variant_plan` 里那一条。 */
  plan_item_id: string
  spec_id: string
  /** `"1080x1920"`（印刷规格已按 dpi 换算成像素）。 */
  size: string
  /** 组装好的提示词：角度 + 规格硬规矩 + 品牌系统 + 禁忌。 */
  prompt: string
}

export interface GenerationPlan {
  brief_id: string
  prompts: readonly VariantPrompt[]
  /** 这次要出几张（= `prompts.length`）。 */
  n: number
  /**
   * 额度这一侧的话，人话一条一条。空数组 = 额度内。
   *
   * 里面的每一句都对应 guardrail 的一条 hit——面板上说的与提交时拦的
   * 是同一个数，不许两边各写一份。
   */
  quota_notes: readonly string[]
  /** 超没超（`true` 时提交上去会转人审，不是被拒）。 */
  over_quota: boolean
}

export interface PlanGenerationInput {
  brief: DesignBrief
  brand: ResolvedBrandSystem
  /** 今天已经出了几张（调用方从账本 / 事件日志数）。 */
  generated_today?: number
  /** 这次只出计划里的这几条（人在卡上点"这个角度再来两张"）。 */
  only_plan_item_ids?: readonly string[]
  caps?: { max_variants_per_brief?: number; max_generations_per_day?: number }
}

/**
 * brief 的变体计划 → 这一次真要发出去的那几条提示词。
 *
 * **按额度截断而不是报错**：要 10 张而上限 6 张时，出 6 张并在
 * `quota_notes` 里说清楚。报错的后果是人得回去改一个数再点一次，
 * 而他想要的东西（多看几版）本身并不过分。
 */
export function planGeneration(input: PlanGenerationInput): GenerationPlan {
  const perBrief = input.caps?.max_variants_per_brief ?? DESIGN_CAPS.max_variants_per_brief
  const daily = input.caps?.max_generations_per_day ?? DESIGN_CAPS.max_generations_per_day
  const usedToday = input.generated_today ?? 0

  const wanted = input.brief.variant_plan.filter(
    (item) => input.only_plan_item_ids === undefined || input.only_plan_item_ids.includes(item.id),
  )
  const notes: string[] = []
  let take = wanted.length
  if (take > perBrief) {
    notes.push(`这份 brief 一次最多出 ${perBrief} 张，先出 ${perBrief} 张（计划里有 ${take} 条）。`)
    take = perBrief
  }
  const left = Math.max(0, daily - usedToday)
  if (take > left) {
    notes.push(
      left === 0
        ? `今天的出图额度（${daily} 张）用完了。明天再来，或者让 owner 把额度调高。`
        : `今天还剩 ${left} 张出图额度（一天 ${daily} 张），这次先出 ${left} 张。`,
    )
    take = left
  }

  const prompts = wanted.slice(0, take).map((item) => composePrompt(item, input.brand))
  return {
    brief_id: input.brief.id,
    prompts,
    n: prompts.length,
    quota_notes: notes,
    over_quota: notes.length > 0,
  }
}

/**
 * 一条计划 → 一段提示词。
 *
 * 顺序是有讲究的：**角度在最前**（它是这一版想试的东西），**规格硬规矩在中间**
 * （"主图一个字都不许有"这种话放后面模型容易忽略），**品牌系统在最后**
 * （它最长，而且是原样引用的一整段）。禁忌单独一行收尾——
 * 那一行同时是 guardrail 要查的那一行。
 */
export function composePrompt(
  item: DesignVariantPlanItem,
  brand: ResolvedBrandSystem,
): VariantPrompt {
  const spec = resolveSpec(item.spec_id)
  const parts = [item.angle_zh]
  if (spec !== undefined) parts.push(`【规格】${specNoteZh(spec)}`)
  parts.push(brandPrompt(brand))
  const forbidden = brand.system?.forbidden ?? []
  if (forbidden.length > 0) parts.push(`【绝对不许出现】${forbidden.join('、')}`)
  return {
    plan_item_id: item.id,
    spec_id: item.spec_id,
    size: spec === undefined ? '1024x1024' : canvasOf(spec),
    prompt: parts.join('\n'),
  }
}

/** 自查的结论。`ok` 为假 = **重写提示词**，不是删词后照发。 */
export interface PromptCheck {
  ok: boolean
  /** 命中的禁忌词（原样，人写的词）。 */
  hits: readonly string[]
  /** 给起草那一跳的重写指令（`ok` 为真时是空串）。 */
  rewrite_instruction: string
}

/**
 * 提示词自查（58 §1：提示词里的品牌禁忌词）。
 *
 * 与 guardrail 的 `design_variant` 那条 block **查的是同一张表**
 * （brief 的 `must_avoid` + 品牌系统的 `forbidden`）。在这里再定义一份
 * "设计版禁忌词"的后果是：同一句提示词，这边说没事，提交时被拦死，
 * 而人看不出为什么。
 *
 * 这一跳不是门（Agent 自查不能当门），它是**尽早给模型反馈**——
 * 与 `kol-core` 起草时先自查一遍是同一个位置。
 */
export function checkPrompt(prompt: string, forbidden: readonly string[] = []): PromptCheck {
  const lower = prompt.toLowerCase()
  const hits = [
    ...new Set(
      forbidden.map((t) => t.trim()).filter((t) => t !== '' && lower.includes(t.toLowerCase())),
    ),
  ]
  return {
    ok: hits.length === 0,
    hits,
    rewrite_instruction:
      hits.length === 0
        ? ''
        : `提示词里有这个品牌的禁忌：${hits.join('、')}。换个说法重写——带着它提交会被当场拦下，不是转人审。`,
  }
}

/**
 * 变体挑选卡上那一行说明（58 §3：N 张图 + "就这张 / 都不行再来"）。
 *
 * 为什么把"都不行再来"写进这一行：人挑图的时候第一反应是"这几张都不对"，
 * 而界面上如果只有"选一张"，他就会挑一张最不差的——那张后来会真的上架。
 */
export function pickCardNoteZh(plan: GenerationPlan, spec?: DesignSpec): string {
  const size = spec === undefined ? '' : `按「${spec.zh}」出的，`
  const quota = plan.quota_notes.length === 0 ? '' : ` ${plan.quota_notes.join(' ')}`
  return `${size}一共 ${plan.n} 张。挑中哪张就点「就这张」；都不行就点「都不行再来」，说一句哪儿不对，下一轮带着改。${quota}`
}
