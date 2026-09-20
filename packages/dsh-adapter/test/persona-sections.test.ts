/**
 * WP120（69 §3 / §5）：**persona 那几段进了 dsh 的系统提示**。
 *
 * dsh 这一侧的特殊之处（16 §2）：公司端 preset 的 `systemPrompt` 白名单里
 * **`complete` 段是唯一有效段**——我们自己注册的 `agentsws:persona` 会把 dsh 自带的
 * `deployment:persona-prefix` / `-suffix` 整段遮掉。所以"persona 进没进提示"在这儿
 * 不是"多加一段"的问题，而是"**那唯一一段里有没有它**"。
 *
 * direct 那一侧同样的一组在 `packages/runtime-direct/test/persona-sections.test.ts`。
 * 两边断言的是同一件事：岗位名、职责名、「你不负责」那一段都在模型收到的文本里。
 *
 * 用**真门禁 + 裸组合**（`installGate` + 一个只装了 SystemPrompt / ToolRuntime /
 * ApprovalService 的 Context），不起 dsh 的假运行时——测的是提示词装配，
 * 不需要模型真的跑一轮。
 */
import { Provenance } from '@agentsws/core'
import { Context } from '@deepseek-ai/cordis'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import { describe, expect, it } from 'vitest'
import { installGate, PERSONA_SECTION } from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

/** 岗位那一段（69 §3：排在职责前面）。 */
const POSITION = {
  id: 'position',
  name: '红人营销',
  order: 10,
  text: [
    '你是谁：这家公司管红人合作的岗位。',
    '你负责：找人、建联、谈合作、验收、算账。',
    '你不负责：客户的退款与物流→客服；自己账号发帖→社媒运营。',
    '怎么做：先查手边已有的人和合作。',
    '口气：像个谈合作的人，具体、不许诺。',
    '必须出卡：每一封开发信。',
  ].join('\n'),
}

/** 职责那一段。 */
const ROLE = {
  id: 'role',
  name: 'YouTube 红人',
  order: 20,
  text: [
    '你是谁：红人营销岗位里做 YouTube 这条渠道的人。',
    '你负责：找频道并打分、写开发信、跟进回信。',
    '你不负责：客户退款物流→客服；自己账号发帖→社媒运营。',
    '怎么做：先查这条渠道上手边的人和合作。',
    '口气：像谈合作的人。',
    '必须出卡：每封开发信。',
  ].join('\n'),
}

/** 一个只装了提示词与工具两层的裸组合（与 `browser-seam.test.ts` 的 `bare()` 同形）。 */
async function bare(): Promise<Context> {
  const root = new Context()
  root.plugin(SystemPrompt, { includeHarnessIdentity: false })
  root.plugin(ToolRuntime, {})
  root.plugin(ApprovalService, {})
  return new Promise<Context>((resolve) => {
    root.plugin({
      name: 'probe',
      inject: ['tools', 'systemPrompt'],
      apply: (c: Context) => resolve(c),
    })
  })
}

/** 装上真门禁，回它渲染出来的那份系统提示。 */
async function systemText(sections: readonly (typeof POSITION)[]): Promise<string> {
  const req = makeRequest({ persona: { sections: [...sections] } })
  const ctx = await bare()
  const agent = { preset: req.runtime.preset, run_id: req.id }
  const scope = createScope(ctx, agent)
  const { sink } = collect()
  installGate(ctx, {
    request: req,
    sink,
    provenance: new Provenance(req.id),
    options: baseOptions(),
    buildStageIntent: () => undefined,
    buildDraftPayload: () => undefined,
    agent,
    agentCtx: scope.ctx,
  })
  const assembly = await ctx.systemPrompt.assemble()
  expect(assembly.sections.map((s) => s.name)).toContain(PERSONA_SECTION)
  return renderPrompt(assembly)
}

describe('persona 段进 dsh 的系统提示（69 §3）', () => {
  it('岗位名与职责名都在', async () => {
    const text = await systemText([POSITION, ROLE])
    expect(text).toContain('红人营销')
    expect(text).toContain('YouTube 红人')
  })

  it('「你不负责」那一段在——它是防串岗的唯一一句', async () => {
    const text = await systemText([POSITION, ROLE])
    expect(text).toContain('你不负责')
    expect(text).toContain('客户的退款与物流→客服')
  })

  it('岗位在前、职责在后（69 §3 的装配顺序）', async () => {
    const text = await systemText([POSITION, ROLE])
    expect(text.indexOf('## position')).toBeGreaterThanOrEqual(0)
    expect(text.indexOf('## position')).toBeLessThan(text.indexOf('## role'))
  })

  it('它就在**唯一有效**的那个 complete 段里（16 §2：另开一段会被遮掉）', async () => {
    const req = makeRequest({ persona: { sections: [POSITION, ROLE] } })
    const ctx = await bare()
    const agent = { preset: req.runtime.preset, run_id: req.id }
    const scope = createScope(ctx, agent)
    const { sink } = collect()
    installGate(ctx, {
      request: req,
      sink,
      provenance: new Provenance(req.id),
      options: baseOptions(),
      buildStageIntent: () => undefined,
      buildDraftPayload: () => undefined,
      agent,
      agentCtx: scope.ctx,
    })
    const assembly = await ctx.systemPrompt.assemble()
    const persona = assembly.sections.find((s) => s.name === PERSONA_SECTION)
    expect(persona?.text).toContain('你不负责')
    // dsh 自带的那两段被遮掉了：模型看不到它们，只看到我们这一段
    expect(renderPrompt(assembly)).not.toContain('DeepSeek Harness')
  })

  it('反查不出岗位时整段不出，职责那一段照旧在（54 §3「不猜一个」）', async () => {
    const text = await systemText([ROLE])
    expect(text).not.toContain('## position')
    expect(text).toContain('YouTube 红人')
  })
})
