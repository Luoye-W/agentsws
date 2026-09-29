/**
 * WP188「随便聊」端到端：真装配线（路由 → FreeChatPort → 品牌模型网关 → OpenAI 兼容 provider 的 SSE），
 * 只把最外面那一跳（上游 HTTP）换成回放。钉住：
 * - 下拉里列出已配的来源、默认是「设置 → 模型」那一个；
 * - 说一句 → SSE 一段段回来，会话与话存在本机；
 * - 联网只在开时挂 `web_search`；搜索走替身，照 WP179 记 `model.usage{web_search}` 与 `web.searched`；
 * - **不产生事项、运行与卡片**；
 * - 「Agents 工坊（用积分）」模板不让填 key（`auth: 'cloud'`）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeChatFrame, FreeChatModelsView, FreeChatSessionView } from '@agentsws/api'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let server: Server
let dir: string
const upstream: Record<string, unknown>[] = []

/** 上游替身：`/models` 回一份清单；对话口按 `stream` 回 SSE 或整段；要搜时第一轮回一个工具调用。 */
const fetch: FetchLike = async (url, init) => {
  const body =
    typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  if (url.endsWith('/chat/completions')) upstream.push(body)
  const toolsOffered = Array.isArray(body.tools) && body.tools.length > 0
  const alreadySearched = JSON.stringify(body.messages ?? []).includes('"role":"tool"')
  const reply =
    toolsOffered && !alreadySearched
      ? {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    function: { name: 'web_search', arguments: '{"query":"今日汇率"}' },
                  },
                ],
              },
            },
          ],
        }
      : null
  const chunks =
    reply !== null
      ? [reply]
      : ['你好，', '有什么', '想聊的？'].map((t) => ({ choices: [{ delta: { content: t } }] }))
  const sse = `${[...chunks, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } }]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join('')}data: [DONE]\n\n`
  const json = url.endsWith('/models')
    ? { object: 'list', data: [{ id: 'deepseek-flash' }] }
    : {
        choices: [{ message: { content: 'ok' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => (body.stream === true ? sse : JSON.stringify(json)),
  }
}

const call = (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
const frames = async (res: Response): Promise<FreeChatFrame[]> =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as FreeChatFrame)

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-free-chat-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    modelFetch: fetch,
    freeChatWebSearch: async () => ({
      sources: [{ url: 'https://example.com/fx', title: '汇率', snippet: '1 美元 = 7.1 元' }],
    }),
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  const saved = await call('PUT', '/v1/models/providers/deepseek', {
    kind: 'deepseek',
    model: 'deepseek-flash',
    api_key: 'sk-free-chat-test-0001',
  })
  expect(saved.status).toBe(200)
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP188 /v1/free-chat 端到端', () => {
  it('模型下拉：列出已配的来源，默认是设置里那个；联网与公司资料可用', async () => {
    const view = await data<FreeChatModelsView>(await call('GET', '/v1/free-chat/models'))
    expect(view.choices.map((c) => c.id)).toContain('deepseek/deepseek-flash')
    expect(view.default).toBe('deepseek/deepseek-flash')
    expect(view.web_search.available).toBe(true)
    expect(view.web_search.max_searches).toBe(5)
    expect(view.knowledge.available).toBe(true)
  })

  it('说一句：SSE 一段段回来；存在本机；不产生事项 / 运行 / 卡片；用量记 free_chat', async () => {
    const ws = server.bootstrap.workspace.id
    const before = server.kernel.eventLog.readSync({ workspace_id: ws }).length
    const session = await data<FreeChatSessionView>(
      await call('POST', '/v1/free-chat/sessions', {}),
    )
    upstream.length = 0
    const res = await call('POST', `/v1/free-chat/sessions/${session.id}/messages`, {
      text: '在吗',
    })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const got = await frames(res)
    expect(got.map((f) => f.type)).toEqual(['start', 'delta', 'delta', 'delta', 'done'])
    expect(upstream[0]?.stream).toBe(true)
    expect(upstream[0]?.tools).toBeUndefined()
    const listed = await data<{ role: string; text: string }[]>(
      await call('GET', `/v1/free-chat/sessions/${session.id}/messages`),
    )
    expect(listed.map((m) => m.text)).toEqual(['在吗', '你好，有什么想聊的？'])
    const after = server.kernel.eventLog.readSync({ workspace_id: ws }).slice(before)
    const types = after.map((e) => e.type)
    expect(types.filter((t) => /^(matter|run|approval|card|todo)\./.test(t))).toEqual([])
    const usage = after.filter((e) => e.type === 'model.usage')
    expect(usage.map((e) => (e.payload as { purpose: string }).purpose)).toEqual(['free_chat'])
    // 正文不进事件日志
    expect(JSON.stringify(after)).not.toContain('在吗')
    const sessions = await data<FreeChatSessionView[]>(await call('GET', '/v1/free-chat/sessions'))
    expect(sessions[0]?.title).toBe('在吗')
  })

  it('联网开着：只在这时挂 web_search；搜到的来源回到界面；照 WP179 记用量与审计', async () => {
    const ws = server.bootstrap.workspace.id
    const before = server.kernel.eventLog.readSync({ workspace_id: ws }).length
    const session = await data<FreeChatSessionView>(
      await call('POST', '/v1/free-chat/sessions', {}),
    )
    upstream.length = 0
    const got = await frames(
      await call('POST', `/v1/free-chat/sessions/${session.id}/messages`, {
        text: '今天汇率多少',
        web_search: true,
      }),
    )
    expect(
      ((upstream[0]?.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name),
    ).toEqual(['web_search'])
    const done = got.find((f) => f.type === 'done')
    expect(done?.type === 'done' ? done.message.sources : undefined).toEqual([
      { url: 'https://example.com/fx', title: '汇率' },
    ])
    const after = server.kernel.eventLog.readSync({ workspace_id: ws }).slice(before)
    expect(after.filter((e) => e.type === 'web.searched')).toHaveLength(1)
    const purposes = after
      .filter((e) => e.type === 'model.usage')
      .map((e) => (e.payload as { purpose: string }).purpose)
    expect(purposes).toContain('web_search')
    expect(purposes).toContain('free_chat')
  })

  it('改名、删除；删了就看不到', async () => {
    const session = await data<FreeChatSessionView>(
      await call('POST', '/v1/free-chat/sessions', {}),
    )
    const renamed = await data<FreeChatSessionView>(
      await call('PATCH', `/v1/free-chat/sessions/${session.id}`, { title: '改个名' }),
    )
    expect(renamed.title).toBe('改个名')
    expect((await call('DELETE', `/v1/free-chat/sessions/${session.id}`)).status).toBe(200)
    expect((await call('GET', `/v1/free-chat/sessions/${session.id}/messages`)).status).toBe(404)
  })

  it('「Agents 工坊（用积分）」模板不让填 key', async () => {
    const view = await data<{ templates: { kind: string; label: string; auth?: string }[] }>(
      await call('GET', '/v1/models/providers'),
    )
    const cloud = view.templates.find((t) => t.kind === 'agentsws_cloud')
    expect(cloud?.label).toBe('Agents 工坊（用积分）')
    expect(cloud?.auth).toBe('cloud')
  })
})
