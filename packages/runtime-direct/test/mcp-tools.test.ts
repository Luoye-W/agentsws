/**
 * WP44：MCP 只读工具进 direct-llm 的工具面时，描述要是真的那一份。
 *
 * `assemblePrompt` 对 allow 里的每个名字只生成一句 `stand-in tool <name>`；
 * 对这三个不够——它们的价值就在描述里那句"写之前先查、先验"。
 */
import type { RunRequest } from '@agentsws/contracts'
import { MCP_DOCS_TOOL, MCP_READ_TOOLS, MCP_VALIDATE_TOOL } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { assembleDirect } from '../src/assemble.js'

function request(allow: string[]): RunRequest {
  return {
    id: 'run_1',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'work_item',
    actor: { person_id: 'p_1', assignment_id: 'asg_1', role_id: 'dtc.ops' },
    trigger: { event_id: 'e_1', source: 'manual' },
    context: [],
    grounding: [],
    tools: { allow, connect_token: '', side_effect_policy: 'executor' },
    skills: [],
    persona: { sections: [] },
    budget: { max_tokens: 1000, max_tool_calls: 4, max_seconds: 60, max_cost_base: 1 },
    expectations: { outputs: ['answer'], must_stage_if_change_requested: false },
    runtime: {
      preset: 'dtc.ops',
      profile: 'test',
      plugins: [],
      model: { provider: 'stub', model: 'stub-v1', region: 'cn' },
      seed: 1,
    },
    idempotency_key: 'idem_1',
  }
}

describe('WP44 MCP 工具定义进 direct-llm 的工具面', () => {
  it('三个工具的描述是真的那一份，不是 stand-in 占位', () => {
    const prompt = assembleDirect(request([...MCP_READ_TOOLS, 'get_order']))
    const docs = prompt.tools.find((t) => t.name === MCP_DOCS_TOOL)
    expect(docs?.description).toContain('Read-only')
    expect(docs?.description).not.toContain('stand-in tool')
    const validate = prompt.tools.find((t) => t.name === MCP_VALIDATE_TOOL)
    // 这句是重点：告诉模型"提案之前必须先过这一关"
    expect(validate?.description).toContain('must pass this first')
    // 别的工具照旧走占位描述，一个字节都没动
    expect(prompt.tools.find((t) => t.name === 'get_order')?.description).toContain('stand-in tool')
  })

  it('只替换、不新增：allow 里没有就不出现', () => {
    const prompt = assembleDirect(request(['get_order']))
    expect(prompt.tools.map((t) => t.name)).not.toContain(MCP_DOCS_TOOL)
  })
})
