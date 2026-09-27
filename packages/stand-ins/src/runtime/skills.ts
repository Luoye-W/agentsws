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
