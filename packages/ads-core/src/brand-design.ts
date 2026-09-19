/**
 * 投放这一侧怎么用那份 `DESIGN.md`（71 §5，WP122）。
 *
 * 两件事：
 *
 * 1. **出素材时把令牌注进提示词**（{@link adDesignPrompt}）。
 * 2. **把自检结果压成卡片上的一行字**（{@link designNoteZh}）——
 *    vari­ants / publish 排版卡上那一行提示就是它。
 *
 * 第二件有一条明确的克制：**只提示，不拦人**。这一行字没有任何一条通路能
 * 变成一道闸。品牌规范是给人省事的，不是用来管住人的——一张广告图用了色板外的
 * 一个橙，很可能是投手故意的；而一个会拦住你的检查，人只会想办法关掉它。
 *
 * 所以这个文件里没有一个函数回 `boolean`。
 */
import type { BrandDesignCheckFinding, BrandDesignContext } from '@agentsws/contracts'

/** 出广告素材时贴在提示词后面的那一段。没有规范就回空串。 */
export function adDesignPrompt(design?: BrandDesignContext): string {
  return design?.present === true ? design.prompt : ''
}

/** 卡片上最多显示几条（再多就把卡片撑成一份报告了）。 */
export const MAX_DESIGN_NOTES = 3

/**
 * 自检结果 → 卡片上那一行中文。
 *
 * 一条都没有时回 `undefined`（界面按"在不在"决定画不画那一行；
 * 回一个空串会画出一行空格子，比没有更糟）。
 */
export function designNoteZh(findings: readonly BrandDesignCheckFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const shown = findings.slice(0, MAX_DESIGN_NOTES).map((f) => f.message_zh)
  const rest = findings.length - shown.length
  return rest > 0 ? `${shown.join('；')}（另有 ${String(rest)} 条）` : shown.join('；')
}

/** 英文那一行。与中文那一行分开存，不在渲染时拼字符串。 */
export function designNoteEn(findings: readonly BrandDesignCheckFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const shown = findings.slice(0, MAX_DESIGN_NOTES).map((f) => f.message_en)
  const rest = findings.length - shown.length
  return rest > 0 ? `${shown.join('; ')} (+${String(rest)} more)` : shown.join('; ')
}
