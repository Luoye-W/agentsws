/**
 * WP259：「交给它」那一大段原文真的进了模型那一轮（真 `createRuntime`，direct 档，替身模型不联网）。
 *
 * 原文同时是事项描述（`matter_summary`）和这次的任务文本（brief）——模型只看到一份，
 * 不把 200 字重复喂两遍；描述与任务不一样时（随便聊带过来的上下文）照旧两份都给。
 */
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import { describe, expect, it, vi } from 'vitest'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 120_000 })

const clock: Clock = { now: () => '2026-10-07T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'stub', model: 'stub-v1', region: 'cn' }

const MARK = '首屏放主推的三款产品，每款配一句卖点'
const LONG = [
  '用 agentsws-theme 帮我搭一个英文首页，先别发布。',
  `${MARK}；下面依次是品牌故事、客户评价、常见问题和订阅邮件的入口。`,
  '颜色跟品牌色走，字体用无衬线，手机上要好看。做好之后推一个未发布主题，把预览链接给我。',
  '别动现在在线的主题，也别改商品价格和库存；有拿不准的地方先停下来问我，不要自己猜。',
].join('\n')

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.store', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

const matterWith = (summary: string): Matter =>
  ({
    id: 'mat_259',
    schema_version: 1,
    workspace_id: 'ws_1',
    kind: 'adhoc',
    title: '用 agentsws-theme 帮我搭一个英文首页，先别发布…',
    status: 'open',
    context: { summary, pinned: [], participants: [], last_activity: clock.now() },
    created_at: clock.now(),
    updated_at: clock.now(),
  }) as unknown as Matter

/** 跑一次，回模型第一轮收到的全部文字。 */
async function promptOf(matter: Matter, brief: string): Promise<string> {
  const seen: ChatMessage[][] = []
  const models = {
    async complete(req: { messages: ChatMessage[] }) {
      seen.push(req.messages)
      return {
        text: '好的，我先看看现在的主题。',
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'p',
      } satisfies Completion
    },
    async embed() {
      return []
    },
    usage: () => ({}),
    budget: () => ({}),
  } as unknown as ModelGatewayApi
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models,
    approvals: {
      create: async () => ({ id: 'apr_1', state: 'pending' }),
    } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: () => undefined,
    prefer: 'direct',
    modelRef: () => MODEL,
    hasModel: () => true,
    vertical: () => 'physical',
    dshMode: 'in-process',
  } as RuntimeOptions)
  await runtime.startRun({
    matter,
    brief,
    actor: { person_id: 'per_1', assignment_id: 'asg_1' },
  } as Parameters<typeof runtime.startRun>[0])
  const first = seen[0] ?? []
  return first
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

const count = (hay: string, needle: string): number => hay.split(needle).length - 1

describe('WP259 完整原文进首轮运行', () => {
  it('原文既是描述又是任务：模型看到全文，只一份', async () => {
    const prompt = await promptOf(matterWith(LONG), LONG)
    for (const line of LONG.split('\n')) expect(prompt).toContain(line)
    expect(count(prompt, MARK)).toBe(1)
  })

  it('描述与任务不同（随便聊带过来的上下文）：两份都在', async () => {
    const prompt = await promptOf(matterWith(`从随便聊带过来的：${MARK}`), '照这个做')
    expect(prompt).toContain('照这个做')
    expect(count(prompt, MARK)).toBe(1)
  })
})
