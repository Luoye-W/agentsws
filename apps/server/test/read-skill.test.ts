/**
 * WP162 端到端：按需技能真的进到模型。
 *
 * 真装配线（`createRuntime` + 真技能库 + 启动时那一步 `seedDefaultSkill`），职责的技能清单
 * 取自内置的 `dtc.email-marketing`（`email-sms` 按需、`brand-voice` 常驻），模型那一跳是
 * 脚本化的替身上游（direct）：第一轮 `read_skill('email-sms')`，第二轮 `read_skill('seo-judgment')`
 * （库里有、但这条职责没登记），第三轮收尾。断言：
 *
 * 1. persona 里有「可用技能索引」，列了 email-sms 与它那一句说明；常驻的 brand-voice 正文整本在；
 * 2. 工具表里有 `read_skill`；读 email-sms 拿到六层叠加后的正文，正文回到了模型的对话里；
 * 3. 别的名字被拒（「这条职责没有这个技能」）；
 * 4. 没登记按需技能的职责：工具表里没有 `read_skill`，persona 里没有索引。
 */
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  SkillRef,
} from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import { loadBundledRole, type RoleStore } from '@agentsws/roles'
import { createSkills } from '@agentsws/skills'
import { describe, expect, it } from 'vitest'
import { seedDefaultSkill } from '../src/learning.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

const clock: Clock = { now: () => '2026-09-27T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

type Seen = { messages: ChatMessage[]; tools: string[] }

function scripted(
  calls: { name: string; input?: Record<string, unknown> }[],
): ModelGatewayApi & { seen: Seen[] } {
  const seen: Seen[] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    async complete(req: { messages: ChatMessage[]; tools?: { name: string }[] }) {
      seen.push({ messages: req.messages, tools: (req.tools ?? []).map((t) => t.name) })
      const call = calls[seen.length - 1]
      return call === undefined
        ? done('看过了。')
        : done('', [{ id: `call_${seen.length}`, name: call.name, input: call.input ?? {} }])
    },
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  } as unknown as ModelGatewayApi & { seen: Seen[] }
}

function fakeRoles(role_id: string, skills: readonly SkillRef[]): RoleStore {
  return {
    effectiveConfig: () => ({ role_id, grounding: [], skills: [...skills], browser_scope: [] }),
    assignments: { get: () => undefined },
  } as unknown as RoleStore
}

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '给弃购的人写一组召回邮件',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-27T09:00:00.000Z',
  updated_at: '2026-09-27T09:00:00.000Z',
} as unknown as Matter

const textOf = (m: ChatMessage): string =>
  typeof m.content === 'string'
    ? m.content
    : m.content.map((p) => ('text' in p ? String(p.text) : '')).join('')

async function runOnce(input: {
  role_id: string
  skills: readonly SkillRef[]
  calls: { name: string; input?: Record<string, unknown> }[]
  extra?: Partial<RuntimeOptions>
}) {
  const skills = createSkills({ clock, random: () => 0.5 })
  await seedDefaultSkill(skills, 'ws_1')
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const gateway = scripted(input.calls)
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles: fakeRoles(input.role_id, input.skills),
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => MODEL,
    skills: skills.registry,
    ...input.extra,
  })
  const { run_id } = await runtime.startRun({
    matter,
    brief: '弃购的人太多了，帮我写一组召回邮件',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const results = events
    .filter((e) => e.type === 'tool.result')
    .map((e) => e.payload as { status: string; reason?: string })
  return { run_id, events, gateway, results, skills }
}

const EMAIL = loadBundledRole('dtc.email-marketing')

describe('WP162 端到端：挂了 email-sms 的职责（direct 替身上游）', () => {
  it('职责清单里 email-sms 是按需的', () => {
    const byName = new Map(EMAIL.skills.map((s) => [s.name, s.load]))
    expect(byName.get('email-sms')).toBe('on_demand')
  })

  it('索引里有它；read_skill 拿到正文；别的名字被拒', async () => {
    const { gateway, results } = await runOnce({
      role_id: EMAIL.id,
      skills: EMAIL.skills,
      calls: [
        { name: 'read_skill', input: { name: 'email-sms' } },
        { name: 'read_skill', input: { name: 'seo-judgment' } },
      ],
    })
    const first = gateway.seen[0]
    expect(first?.tools).toContain('read_skill')
    const persona = textOf(first?.messages[0] as ChatMessage)
    expect(persona).toContain('## skill_index 可用技能')
    expect(persona).toMatch(/- email-sms：邮件与短信营销的做法/)
    // 按需的正文不在 persona 里（要读才有）
    expect(persona).not.toContain('## 你做什么')

    expect(results.map((r) => r.status)).toEqual(['ok', 'blocked'])
    expect(results[1]?.reason).toContain('这条职责没有这个技能')
    const second = gateway.seen[1]?.messages.map(textOf).join('\n') ?? ''
    expect(second).toContain('## 你做什么')
    const third = gateway.seen[2]?.messages.map(textOf).join('\n') ?? ''
    expect(third).toContain('这条职责没有这个技能：seo-judgment')
  })

  it('终审追加：read_skill 的结果不包外部围栏、开头标明是哪一本；别的工具结果照旧包；没登记的照旧被拒', async () => {
    const { gateway, results } = await runOnce({
      role_id: EMAIL.id,
      skills: EMAIL.skills,
      calls: [
        { name: 'read_skill', input: { name: 'email-sms' } },
        { name: 'search_policies', input: { query: 'email' } },
        { name: 'read_skill', input: { name: 'seo-judgment' } },
      ],
      /*
       * 一个真能回 ok 的普通只读工具，拿来对照围栏。原来借的是 Dev MCP 文档查询；WP236 起 Dev MCP
       * 只给建站类职责（`site.*`），邮件营销的工具面里没有它，换成记录源的「规矩与政策库」。
       */
      extra: {
        source: {
          executeTool: async () => ({ status: 'ok', data: { text: 'Shopify Email 文档一段' } }),
        },
      },
    })
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok', 'blocked'])
    const toolMsgs = (gateway.seen[3]?.messages ?? []).filter((m) => m.role === 'tool').map(textOf)
    const skillMsg = toolMsgs.find((t) => t.includes('## 你做什么')) ?? ''
    expect(skillMsg.startsWith('技能手册：email-sms')).toBe(true)
    expect(skillMsg).not.toContain('<external_data>')
    const docMsg = toolMsgs.find((t) => t.includes('Shopify Email 文档一段')) ?? ''
    expect(docMsg).toContain('<external_data>')
    expect(toolMsgs.some((t) => t.includes('这条职责没有这个技能：seo-judgment'))).toBe(true)
  })

  it('读到的是叠加后的那一份：公司层加的规矩也在', async () => {
    const skills = createSkills({ clock, random: () => 0.5 })
    await seedDefaultSkill(skills, 'ws_1')
    await skills.registry.putFromMarkdown({
      markdown: '---\nname: email-sms\n---\n\n## 本店规矩\n\n周末不群发。\n',
      tier: 'company',
      owner: 'per_owner' as never,
      version: '1.0',
      workspace_id: 'ws_1',
    })
    const { gateway, results } = await runOnce({
      role_id: EMAIL.id,
      skills: EMAIL.skills,
      calls: [{ name: 'read_skill', input: { name: 'email-sms' } }],
      extra: { skills: skills.registry },
    })
    expect(results.map((r) => r.status)).toEqual(['ok'])
    expect(gateway.seen[1]?.messages.map(textOf).join('\n')).toContain('周末不群发。')
  })

  it('常驻 + 按需都挂的职责（内容与搜索）：brand-voice 整本在 persona，seo-judgment 在索引', async () => {
    const content = loadBundledRole('dtc.content')
    const { gateway } = await runOnce({ role_id: content.id, skills: content.skills, calls: [] })
    const persona = textOf(gateway.seen[0]?.messages[0] as ChatMessage)
    expect(persona).toContain('## skill_brand-voice brand-voice')
    expect(persona).toContain('## 数字与承诺')
    expect(persona).toMatch(/- seo-judgment：/)
    // 索引排在全部技能正文之后
    expect(persona.indexOf('## skill_index')).toBeGreaterThan(
      persona.indexOf('## skill_brand-voice'),
    )
  })

  it('没登记按需技能的职责（设计）：工具表里没有 read_skill，persona 里没有索引', async () => {
    const design = loadBundledRole('design.dtc')
    const { gateway } = await runOnce({ role_id: design.id, skills: design.skills, calls: [] })
    const first = gateway.seen[0]
    expect(first?.tools).not.toContain('read_skill')
    const persona = textOf(first?.messages[0] as ChatMessage)
    expect(persona).not.toContain('skill_index')
    // brand-system 是公司层动态来源（店主写了才有），包里不给默认正文
    expect(persona).not.toContain('skill_brand-system')
  })

  it('没接技能库（老装配）：一样没有 read_skill，点名调也是没接', async () => {
    const { gateway, results } = await runOnce({
      role_id: EMAIL.id,
      skills: EMAIL.skills,
      calls: [{ name: 'read_skill', input: { name: 'email-sms' } }],
      extra: { skills: undefined as never },
    })
    expect(gateway.seen[0]?.tools).not.toContain('read_skill')
    expect(results[0]?.status).not.toBe('ok')
  })
})
