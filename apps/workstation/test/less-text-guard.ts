/**
 * WP156（36 §7 第 3 条）：**卡片上的可见说明文字有上限**——守卫的量法。
 *
 * 卡片上只留：图标 + 标题、一句说明、方案切换、操作按钮、状态与结果。量的是"人要读的说明字"，
 * 所以这些**不算**：
 *
 * - 问号里的话（`[data-slot=hint]`，文字在 `aria-label` 里，本来就不在 textContent）；
 * - 标题：`h1`–`h6`、卡片标题（`[data-slot=card-title]`）、小节 / 步骤标题（`[data-slot=title]`）——
 *   "图标 + 标题"本来就该在卡上；
 * - 操作：按钮、输入框、下拉、表单（`form` 整个——表单里每格的说明已经是问号）、链接、
 *   **带输入或 `for=` 指着输入框的 `<label>`**（字段名 / 单选 / 勾选的名字就是那个操作的名字）；
 * - 状态与结果：`role=status` / `role=alert` / `[data-slot=status]` / `[data-slot=error]` /
 *   `.text-destructive`、数字与清单（`[data-slot=data]`）、数据表格（`table`）、驱动原话（`pre`）、
 *   状态徽章（`[data-slot=badge]`，WP157 加）；
 * - WP157 加：开关两头的选项名（`[data-slot=option]`，"用我的 / 用 Agents 工坊的"——操作的名字）；
 * - 卡里套着的另一张卡（`[data-slot=card]`）：它单独量；
 * - 必须一眼可见的：安全承诺（`[data-slot=safety-note]`）、风险提示（`[data-slot=warning]`）——
 *   它们另有一条规矩：**压到一句**（{@link SAFETY_LIMIT}）；
 * - 读屏专用（`.sr-only`）与图标。
 *
 * **怎么数字**：一个汉字算一个；一串连着的英文字母 / 数字算一个（"DeepSeek" 是一个，"API key" 是两个）；
 * 标点与空白不算。英文界面不在这条守卫里量（测试按中文渲染）。
 */

/** 一张卡片上可见说明文字的上限（汉字）。Luoye 09-26：看起来不累、排版不乱。 */
export const CARD_TEXT_LIMIT = 60

/** 安全承诺 / 风险提示一条的上限：压到一句。 */
export const SAFETY_LIMIT = 40

const NOT_COUNTED = [
  '[data-slot="hint"]',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  '[data-slot="card-title"]',
  '[data-slot="title"]',
  '[data-slot="data"]',
  '[data-slot="badge"]',
  '[data-slot="option"]',
  '[data-slot="card"]',
  'button',
  '[role="button"]',
  'input',
  'select',
  'textarea',
  'option',
  'form',
  'a',
  'table',
  'pre',
  'svg',
  '.sr-only',
  '[role="status"]',
  '[role="alert"]',
  '[data-slot="status"]',
  '[data-slot="error"]',
  '[data-slot="safety-note"]',
  '[data-slot="warning"]',
  '.text-destructive',
].join(',')

/** 按上面的数法数"字"。 */
export function weightOf(text: string): number {
  const han = text.match(/\p{Script=Han}/gu)?.length ?? 0
  const words = text.match(/[A-Za-z0-9]+/g)?.length ?? 0
  return han + words
}

/** 这张卡上**人要读的说明字**（去掉上面那些之后剩下的文字）。 */
export function visibleProse(card: Element): string {
  const clone = card.cloneNode(true) as Element
  // 带输入的 label、指着一个输入框的 label（`for=`）先摘：字段名就是那个操作的名字
  for (const label of [...clone.querySelectorAll('label')])
    if (label.hasAttribute('for') || label.querySelector('input, select, textarea') !== null)
      label.remove()
  for (const el of [...clone.querySelectorAll(NOT_COUNTED)]) el.remove()
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
}

export interface CardReport {
  /** 可见说明字数。 */
  weight: number
  text: string
  /** 卡片里的 `<ol>`（步骤清单）有几个——规矩是 0。 */
  ordered: number
  /** 外链（`http(s)://`）里不是操作的那几个——规矩是最多 1 个。 */
  externalLinks: string[]
  /** 超过一句的安全承诺 / 风险提示。 */
  longSafety: string[]
}

export function reportCard(card: Element): CardReport {
  const text = visibleProse(card)
  return {
    weight: weightOf(text),
    text,
    // 三步小勾叉（连得上 / 文字能回 / 看得懂图）是结果，不是"怎么做"——标了状态的不算
    ordered: [...card.querySelectorAll('ol')].filter(
      (ol) => ol.closest('[data-slot="status"], [role="status"]') === null,
    ).length,
    externalLinks: [...card.querySelectorAll('a[href^="http"]')]
      .filter((a) => a.getAttribute('data-slot') !== 'action')
      .map((a) => a.getAttribute('href') ?? ''),
    longSafety: [...card.querySelectorAll('[data-slot="safety-note"], [data-slot="warning"]')]
      .map((el) => (el.textContent ?? '').trim())
      .filter((s) => weightOf(s) > SAFETY_LIMIT),
  }
}
