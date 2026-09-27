/**
 * WP162：`read_skill` 的名字、给模型看的定义、人话名，以及它进 stub / direct 工具表的样子。
 *
 * 只有工具面里有 `read_skill` 的运行（这条职责登记了按需技能）才多这一条定义；
 * 别的运行的工具表逐字不变。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  assemblePrompt,
  humanizeToolNames,
  READ_SKILL_TOOL,
  READ_SKILL_TOOL_DEF,
  TOOL_WORDS_ZH,
} from '../src/index.js'

const req = (allow: string[]): RunRequest =>
  ({
    id: 'run_1',
    actor: { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'dtc.support' },
    persona: { sections: [] },
    skills: [],
    context: [],
    tools: { allow, connect_token: '', side_effect_policy: 'executor' },
    expectations: { outputs: ['draft'], must_stage_if_change_requested: false },
  }) as unknown as RunRequest

describe('read_skill 的定义', () => {
  it('名字、必填参数 name、描述说人话', () => {
    expect(READ_SKILL_TOOL).toBe('read_skill')
    expect(READ_SKILL_TOOL_DEF.input_schema).toMatchObject({ required: ['name'] })
    expect(READ_SKILL_TOOL_DEF.description).toContain('技能手册')
  })

  it('人话名是「技能手册」（名词口径），回复里露了也换掉', () => {
    expect(TOOL_WORDS_ZH.read_skill).toBe('技能手册')
    expect(humanizeToolNames('我先用 `read_skill` 翻了一下')).toBe('我先用「技能手册」翻了一下')
  })

  it('工具面里有它才进工具表，带真描述；没有它的运行工具表不变', () => {
    const withIt = assemblePrompt(req(['get_order', READ_SKILL_TOOL])).tools
    expect(withIt.find((t) => t.name === READ_SKILL_TOOL)).toEqual(READ_SKILL_TOOL_DEF)
    const without = assemblePrompt(req(['get_order'])).tools
    expect(without.map((t) => t.name)).toEqual(['get_order'])
    expect(without[0]?.description).toBe('stand-in tool get_order')
  })
})
