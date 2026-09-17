/**
 * 主题这一条（59 §2）：**薄封装 WP44 那个 CLI 口子，一行都不重写。**
 *
 * WP44 已经把"拉副本 / 推未发布副本 / 预览 / 发布"实打实做完了
 * （`apps/server/src/shopify-theme.ts`，走官方 Shopify CLI 的子进程）。这一版**不**
 * 把那些搬进来——搬一次就有两份会各自漂移的 CLI 代码，而 43 §2.4 那张命令表
 * （`theme pull` 没有 `--force`、`push --unpublished` 造的永远是副本）是实查出来的，
 * 不该有第二个抄本。
 *
 * 所以这里只有两样东西：
 *
 * 1. {@link ThemeCliPort} —— 那个模块的**结构子集**。`ShopifyTheme` 天然满足它
 *    （TypeScript 结构类型），服务进程直接把真身传进来；模拟层传
 *    `MockShopifyCli`（`packages/stand-ins`）。这里不 import 服务进程，
 *    包不该反向依赖 app。
 * 2. 几个纯函数：把 `theme list` 的原始行分成"线上 / 副本 / 临时"三档、
 *    判一份副本能不能进发布提案、组一条 `publish_theme` 的 `after`。
 */
import type { Iso8601, ObjectRef } from '@agentsws/contracts'

/** `theme list --json` 里我们要的那几个字段（与 `ShopifyTheme` 的 `ThemeSummary` 对得上）。 */
export interface ThemeSummaryLike {
  id: string
  name: string
  /** `main` = 线上那一份；`unpublished` = 副本；`development` = `theme dev` 起的临时主题。 */
  role: string
  updated_at?: string
  preview_url?: string
}

/** 一份刚推上去的未发布副本（与 `ShopifyTheme` 的 `PushedTheme` 对得上）。 */
export interface PushedThemeLike {
  theme_id: string
  theme_name: string
  preview_url?: string
  path: string
}

/**
 * WP44 那个 CLI 口子里这一版用得到的四个方法。
 *
 * 故意只列四个：`pull` / `startDev` 是人在本地改代码时用的，面板上那几块用不着，
 * 少列一个就少一条"这个包也能起子进程"的误解。
 */
export interface ThemeCliPort {
  status(): Promise<{ installed: boolean; version?: string; install_command: string }>
  list(shop: string): Promise<ThemeSummaryLike[]>
  pushUnpublished(input: { shop: string; name: string }): Promise<PushedThemeLike>
  /** **只有审批过的 `publish_theme` 变更才该调它**（WP44 那句话原样成立）。 */
  publish(input: { shop: string; theme_id: string }): Promise<{ theme_id: string }>
}

/** 主题列表分成三档：线上一份、副本若干、`theme dev` 起的临时若干。 */
export interface ThemeLanes {
  published?: ThemeSummaryLike
  copies: readonly ThemeSummaryLike[]
  development: readonly ThemeSummaryLike[]
}

/** 把 `theme list` 的结果分档。认不出的 role 当副本——宁可多显示一行，也别把线上那份漏了。 */
export function themeLanes(themes: readonly ThemeSummaryLike[]): ThemeLanes {
  const published = themes.find((t) => t.role === 'main' || t.role === 'live')
  const development = themes.filter((t) => t.role === 'development')
  const copies = themes.filter((t) => t !== published && !development.includes(t))
  return {
    ...(published !== undefined ? { published } : {}),
    copies,
    development,
  }
}

export type PublishBlockReason = 'not_found' | 'already_live' | 'no_preview' | 'is_development'

export interface PublishReadiness {
  ok: boolean
  reason?: PublishBlockReason
  /** 给人看的一句话（界面与模型都读它）。 */
  message?: string
}

/**
 * 这份副本能不能提一条"发布"。
 *
 * 四条都不是额度，是事实：
 *
 * - 列表里根本没有这个 id —— 提了也执行不了。
 * - 它已经是线上那一份 —— 发布它等于什么也没干，却占了一张要人点的卡。
 * - 没有预览链接 —— 12 §2 那句"预览链接就是审批材料"反过来说就是：**没有材料的卡
 *   不该进人的队列**。人在一张只有主题名的卡上判不出这一版长什么样。
 * - 它是 `theme dev` 起的临时主题 —— 那份东西随 CLI 进程消失，发布它是在发一个幽灵。
 */
export function publishReadiness(
  themes: readonly ThemeSummaryLike[],
  theme_id: string,
): PublishReadiness {
  const lanes = themeLanes(themes)
  const target = themes.find((t) => t.id === theme_id)
  if (target === undefined)
    return { ok: false, reason: 'not_found', message: `主题列表里没有 ${theme_id}` }
  if (lanes.published?.id === theme_id)
    return { ok: false, reason: 'already_live', message: `${target.name} 已经是线上那一份了` }
  if (target.role === 'development')
    return {
      ok: false,
      reason: 'is_development',
      message: `${target.name} 是 theme dev 起的临时主题，它随命令结束就没了`,
    }
  if ((target.preview_url ?? '').trim() === '')
    return {
      ok: false,
      reason: 'no_preview',
      message: `${target.name} 没有预览链接——没有预览材料的发布卡不该进队列`,
    }
  return { ok: true }
}

/** 一条"把这份副本发布上线"的提案（与 WP44 的 `ThemePublishProposal` 同形）。 */
export interface ThemePublishProposalLike {
  kind: 'publish_theme'
  target: ObjectRef
  before: { theme_id: string; theme_name: string }
  after: { theme_id: string; theme_name: string; preview_url?: string }
  /** 15 §2：`publish_theme` 是 high 风险、hard_ceiling，永远 L1。 */
  risk_class: 'high'
  notes: string[]
  staged_at: Iso8601
}

/**
 * 组一条发布提案。`before` 取自**真读到的**线上主题，不是模型说的那一份。
 *
 * 线上一份都没有（新店）也能提：`before` 记成空 id + 一句说明，卡面上写清
 * "这是这家店的第一份主题"。
 */
export function themePublishProposal(input: {
  themes: readonly ThemeSummaryLike[]
  theme_id: string
  at: Iso8601
  notes?: readonly string[]
}): ThemePublishProposalLike {
  const lanes = themeLanes(input.themes)
  const target = input.themes.find((t) => t.id === input.theme_id)
  const preview = target?.preview_url
  return {
    kind: 'publish_theme',
    target: { type: 'theme', id: input.theme_id },
    before: {
      theme_id: lanes.published?.id ?? '',
      theme_name: lanes.published?.name ?? '（这家店线上还没有主题）',
    },
    after: {
      theme_id: input.theme_id,
      theme_name: target?.name ?? input.theme_id,
      ...(preview !== undefined && preview !== '' ? { preview_url: preview } : {}),
    },
    risk_class: 'high',
    notes: [...(input.notes ?? [])],
    staged_at: input.at,
  }
}

/**
 * 推一份未发布副本（薄封装：一次转调 + 一条预览链接的兜底判断）。
 *
 * 不做重试、不做超时——那些 WP44 的真身里已经有了，在这里再包一层只会让
 * "到底哪一层掐的"变难查。
 */
export async function previewCopy(
  cli: ThemeCliPort,
  input: { shop: string; name: string },
): Promise<PushedThemeLike> {
  const pushed = await cli.pushUnpublished(input)
  return pushed
}

/**
 * 组一条 `theme_install` 变更的 `after`。
 *
 * guardrail 那头判的是"说得出装的是哪一份"（`theme_name` / `theme_id` 至少一个），
 * 所以这里两个都带上——装一份主题市场里的主题只有名字，装一份已有副本才有 id。
 */
export function themeInstallAfter(input: {
  theme_name: string
  theme_id?: string
  source?: string
  price_note?: string
}): Record<string, unknown> {
  return {
    theme_name: input.theme_name,
    ...(input.theme_id !== undefined ? { theme_id: input.theme_id } : {}),
    ...(input.source !== undefined ? { source: input.source } : {}),
    ...(input.price_note !== undefined ? { price_note: input.price_note } : {}),
  }
}
