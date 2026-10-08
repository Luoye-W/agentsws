/**
 * WP264 服务端：事项页 v2 要的三样东西。
 *
 * 1. 短标题（决策 177 / 184）：首轮开跑时便宜模型单独起；起不出退回原话前 20 字；人改过的不覆盖；
 *    只在第一次运行时起。
 * 2. 下一步建议（决策 179）：AI 交代末尾的 `<next>…</next>` → `MatterEvent.next_suggestion`，正文去掉标记；
 *    提示词公共段带那一句规矩。运行时结构化给的（`RunResult.next_suggestion`）优先。
 * 3. 运行摘要（决策 182）：跑完记一条 `status` + `run_digest`（几秒、做了哪几步，人话），排在 AI 那段话前面。
 *
 * 真 `createRuntime` + 替身模型（direct 档），不联网、不花钱。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { createWork, type Work } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createMatterTitler } from '../src/matter-title.js'
import { RunStepLog, stepTextOf } from '../src/run-steps.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

let tick = Date.parse('2026-10-08T06:00:00.000Z')
const clock: Clock = {
  now: () => {
    tick += 1000
    return new Date(tick).toISOString()
  },
}
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const BRIEF =
  '用 agentsws-theme 给 Rollout 搭英文首页（变形金刚正版授权耳机音箱，美国市场）：大图横幅、主推产品占位、品牌故事、FAQ、邮件订阅；深色科技风红色点缀。推成未发布主题给我预览，先别发布。'

/** 先调一次 search_policies，然后回 `reply`。 */
function scripted(reply: string) {
  const seen: ChatMessage[][] = []
  const done = (text: string, tool_calls?: Completion['tool_calls']): Completion => ({
    text,
    ...(tool_calls === undefined ? {} : { tool_calls }),
    usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
    model: { provider: 'stub', model: 'stub-v1' },
    static_prefix_hash: 'p',
  })
  return {
    seen,
    async complete(req: { messages: ChatMessage[] }) {
      seen.push(req.messages)
      return seen.length === 1
        ? done('', [{ id: 'call_1', name: 'search_policies', input: { query: '岗位' } }])
        : done(reply)
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
  } as unknown as ModelGatewayApi & { seen: ChatMessage[][] }
}

const roles: RoleStore = {
  effectiveConfig: () => ({
    role_id: 'common.owner',
    grounding: [],
    skills: [],
    browser_scope: [],
  }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '有哪些岗位和连接',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-08T05:00:00.000Z',
  updated_at: '2026-10-08T05:00:00.000Z',
} as unknown as Matter

async function runOnce(reply: string) {
  const gateway = scripted(reply)
  const timeline: Record<string, unknown>[] = []
  const summaries: string[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models: gateway,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
  })
  runtime.bind({
    appendEvent: (_id: string, e: Record<string, unknown>) => {
      timeline.push(e)
    },
    onRunCompleted: (input: { summary: string }) => {
      summaries.push(input.summary)
    },
  } as unknown as Work)
  await runtime.startRun({
    matter,
    brief: '帮我看看有哪些岗位和连接，最该先处理哪三件事',
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  return { gateway, timeline, summaries, runtime }
}

describe('WP264 下一步建议', () => {
  it('提示词带「<next>」那一句规矩', async () => {
    const { gateway } = await runOnce('好的。')
    const system = (gateway.seen[0] ?? [])
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n')
    expect(system).toContain('<next>')
  })

  it('末尾 <next> → next_suggestion，正文去掉标记；摘要里也不留标记', async () => {
    const { timeline, summaries } = await runOnce(
      '预览好了，线上没动。要发布说一句。\n<next>发布上线</next>',
    )
    const reply = timeline.find((e) => e.kind === 'agent_message')
    expect(reply?.text).toBe('预览好了，线上没动。要发布说一句。')
    expect(reply?.next_suggestion).toBe('发布上线')
    expect(summaries.join('\n')).not.toContain('<next>')
  })

  it('没有标记：没有建议（不从正文里猜）', async () => {
    const { timeline } = await runOnce('要发布说一句。')
    const reply = timeline.find((e) => e.kind === 'agent_message')
    expect(reply?.next_suggestion).toBeUndefined()
  })
})

describe('WP264 运行摘要', () => {
  it('跑完记一条 status + run_digest，排在 AI 那段话前面；步骤是人话', async () => {
    const { timeline, runtime } = await runOnce('查好了。')
    const kinds = timeline.map((e) => e.kind)
    const digestAt = timeline.findIndex((e) => e.run_digest !== undefined)
    expect(digestAt).toBeGreaterThanOrEqual(0)
    expect(digestAt).toBeLessThan(kinds.indexOf('agent_message'))
    const digest = timeline[digestAt]?.run_digest as {
      outcome: string
      seconds: number
      steps: { text: string; status: string }[]
    }
    expect(digest.outcome).toBe('completed')
    expect(digest.seconds).toBeGreaterThan(0)
    expect(digest.steps.map((s) => s.text)).toEqual(['规矩与政策库「岗位」'])
    expect(JSON.stringify(digest)).not.toContain('search_policies')
    // 跑完就不在「正在做」里了
    expect(runtime.liveRun?.('mat_1')).toBeUndefined()
  })

  it('步骤人话：主题工具认出文件；记录里在做的那一步是 running', () => {
    expect(stepTextOf('theme_read_file', { path: 'templates/index.json' })).toBe(
      '读 templates/index.json',
    )
    expect(stepTextOf('site.theme_write_file', { path: 'config/settings_data.json' })).toBe(
      '改 config/settings_data.json',
    )
    expect(stepTextOf('theme_check', {})).toBe('主题检查')
    const log = new RunStepLog(0)
    log.call('a', 'theme_read_file', { path: 'a.json' }, 0)
    log.result('a', 'ok', 2000)
    log.call('b', 'theme_check', {}, 2000)
    expect(log.live()).toEqual([
      { text: '读 a.json', status: 'ok', seconds: 2 },
      { text: '主题检查', status: 'running' },
    ])
    // 收尾时还挂着的按失败算
    expect(log.digest('stopped', 5000).steps[1]?.status).toBe('error')
  })
})

describe('WP264 短标题', () => {
  const setup = (complete?: (prompt: string) => Promise<string>) => {
    const work = createWork({ workspace_id: 'ws_1', clock, random: () => 0.5 })
    const prompts: string[] = []
    const titler = createMatterTitler({
      work: () => work,
      complete: () =>
        complete === undefined
          ? undefined
          : async (prompt) => {
              prompts.push(prompt)
              return complete(prompt)
            },
    })
    const m = work.createMatter({
      kind: 'adhoc',
      title: '用 agentsws-theme 给 Rollout 搭英文首页…',
    })
    const kick = () =>
      titler.kick({
        matter: work.getMatter(m.id) as Matter,
        brief: BRIEF,
        actor: { assignment_id: 'asg_1' },
      })
    return { work, m, kick, prompts }
  }

  it('首轮：便宜模型起的标题落进去（ai）；原话围栏进提示词', async () => {
    const { work, m, kick, prompts } = setup(async () => '「Rollout 英文首页 · 深色科技风」')
    await kick()
    expect(work.getMatter(m.id)?.title).toBe('Rollout 英文首页 · 深色科技风')
    expect(work.getMatter(m.id)?.title_source).toBe('ai')
    expect(prompts[0]).toContain('<external_data>')
    expect(prompts[0]).toContain('Rollout')
  })

  it('模型抛错 / 没接模型 → 原话前 20 字（brief）', async () => {
    const a = setup(async () => {
      throw new Error('429')
    })
    await a.kick()
    expect(a.work.getMatter(a.m.id)?.title).toBe('用 agentsws-theme 给 Rollout 搭英文首页…')
    expect(a.work.getMatter(a.m.id)?.title_source).toBe('brief')
    const b = setup()
    await b.kick()
    expect(b.work.getMatter(b.m.id)?.title_source).toBe('brief')
  })

  it('人改过的不覆盖（起标题途中改的也一样）', async () => {
    let release: (v: string) => void = () => undefined
    const { work, m, kick } = setup(
      () =>
        new Promise<string>((r) => {
          release = r
        }),
    )
    const pending = kick()
    work.retitle(m.id, '我自己起的', 'user')
    release('AI 的标题')
    await pending
    expect(work.getMatter(m.id)?.title).toBe('我自己起的')
    expect(work.getMatter(m.id)?.title_source).toBe('user')
  })

  it('只在第一次运行时起：跑过的事项、起过标题的都不再起', async () => {
    const { work, m, kick } = setup(async () => '新标题')
    work.appendEvent(m.id, { kind: 'run', text: '跑过一次', actor: { kind: 'agent', id: 'a' } })
    expect(kick()).toBeUndefined()
    const fresh = setup(async () => '新标题')
    await fresh.kick()
    expect(fresh.kick()).toBeUndefined()
  })
})
