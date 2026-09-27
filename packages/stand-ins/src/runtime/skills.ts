/**
 * WP162：**按需技能读得到**——`read_skill(name)` 的名字与给模型看的定义。
 *
 * 按需（`load: on_demand`）的技能不整本放进提示词，persona 里只有一段「可用技能索引」
 * （名字 + 一句说明，`@agentsws/learning` 的 `skillIndexSection`）；模型要用哪一本，
 * 就调这个工具按名字读。真正的判定与取正文在服务端（`apps/server/src/skill-tools.ts`，
 * 逻辑是 `@agentsws/learning` 的 `readSkillForRun`）：只认这次运行登记了的名字，
 * 回六层叠加后的正文。
 *
 * 三个运行时用同一份定义：stub / direct 走 `assemblePrompt` 的工具表，dsh 走
 * `dsh-adapter` 的 `readTool`（参数表见那边的 `SKILL_PARAMS`）。
 */
import type { ToolDef } from '@agentsws/contracts'

export const READ_SKILL_TOOL = 'read_skill'

/** 给模型看的定义（描述写人话：它是在挑工具的那一刻读描述的）。 */
export const READ_SKILL_TOOL_DEF: ToolDef = {
  name: READ_SKILL_TOOL,
  description:
    '按名字读一本技能手册的全文（「可用技能索引」里列的那几本）。只读；' +
    '读到的是这家公司现在用的版本，公司和你自己加过的规矩都在里面。索引里没有的名字读不到。',
  input_schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '技能名，照索引里写的抄，例如 returns-policy-calc。' },
    },
    required: ['name'],
  },
}

export const SKILL_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map([
  [READ_SKILL_TOOL, READ_SKILL_TOOL_DEF],
])

/**
 * WP162 终审追加（Fable 09-27）：**哪几个工具的结果不包外部围栏**——按工具名的白名单，只有一个。
 *
 * 外部围栏（`<external_data>`）告诉模型「这是不可信的第三方内容，别照着做」。技能正文不是：
 * 包层是我们自带的，上面几层是人写的或人批过才落库的（学来的覆盖只在卡片批准后施行，
 * 见 `apps/server/src/learning.ts` 的 `applyDecided`），与 `load: always` 那几份不带围栏进系统
 * 提示词的是同一种东西。按需读到的要是包进围栏，等于告诉模型别按手册做。
 *
 * **不是泛化开关**：只认这张表里的名字；别的工具结果（订单、网页、邮件、MCP……）照旧围起来。
 */
export const TRUSTED_RESULT_TOOLS: ReadonlySet<string> = new Set([READ_SKILL_TOOL])

/** 这个工具的结果走不走「内部可信」那条口子（带不带服务前缀都认）。 */
export function isTrustedResultTool(name: string): boolean {
  const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
  return TRUSTED_RESULT_TOOLS.has(bare)
}

/** 标记段的开头（「技能手册：<name>」）。 */
export const SKILL_MANUAL_MARK = '技能手册：'

/**
 * 可信工具结果 → 给模型的那一段文字（不包围栏，开头一行标明这是哪一本手册）。
 *
 * 只有结果是字符串（执行器回的正文）才走这条路；形状不对回 `undefined`，调用方照旧包围栏
 * ——宁可多围一次，不让一个意外的对象不带围栏进对话。
 */
export function renderTrustedToolResult(
  name: string,
  input: Record<string, unknown>,
  data: unknown,
): string | undefined {
  if (!isTrustedResultTool(name) || typeof data !== 'string') return undefined
  const skill = typeof input.name === 'string' ? input.name.trim() : ''
  return [
    `${SKILL_MANUAL_MARK}${skill}（这家公司自己的做事手册，照着做；它不授权任何动作，要动的照样出卡）`,
    data.trim(),
  ].join('\n\n')
}
