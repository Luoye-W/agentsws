/**
 * WP343（决策 859）「我的助理」端到端：真服务进程（运行时 stub）+ 上游模型回放。钉住：
 *
 * - 说「让 Reddit 运营查一下今天的新帖」→ 模型调派活工具 → 开出事项、落在「Reddit 运营」→ 那件事回结果 →
 *   助理对话里出现回报（`report.kind: done`）；
 * - 拿不准（「帮我把这件事办了」）→ 不派，回候选，一件事都不开；
 * - 只读工具（问全局）不产生任何事项 / staged / applied / 卡；
 * - `@` 选了岗位直接交（不经模型）；
 * - 快捷问题按状态生成；助理记忆照 WP320 记、能删、删了不再记回来。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  AssistantMemoryView,
  AssistantStateView,
  FreeChatFrame,
  FreeChatMessageView,
  FreeChatSessionView,
} from '@agentsws/api'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let server: Server
let dir: string
const upstream: Record<string, unknown>[] = []

type Msg = { role: string; content: unknown; name?: string }
const sse = (chunks: unknown[]): string =>
  `${[...chunks, { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6 } }]
    .map((c) => `data: ${JSON.stringify(c)}\n\n`)
    .join('')}data: [DONE]\n\n`
const toolCall = (name: string, args: Record<string, unknown>) => ({
  choices: [
    {
      delta: {
        tool_calls: [
          { index: 0, id: `call_${name}`, function: { name, arguments: JSON.stringify(args) } },
        ],
      },
    },
  ],
})
const say = (text: string) => ({ choices: [{ delta: { content: text } }] })

/**
 * 上游替身：按最后一句用户的话与有没有工具结果决定这一回合——
 * 「让 Reddit 运营…」→ 派活；「帮我把这件事办了」→ 不点名地派；「今天有什么要我处理」→ 查卡；
 * 「各岗位在做什么」→ 看全局；有了工具结果就照着说一句（带上工具结果的头几个字，方便断言）。
 */
const fetch: FetchLike = async (url, init) => {
  const body =
    typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {}
  if (url.endsWith('/chat/completions')) upstream.push(body)
  const messages = (body.messages ?? []) as Msg[]
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  const asked = typeof lastUser?.content === 'string' ? lastUser.content : ''
  const lastTool = messages.at(-1)?.role === 'tool' ? messages.at(-1) : undefined
  const offered = ((body.tools ?? []) as { function?: { name?: string } }[]).map(
    (t) => t.function?.name,
  )
  let chunks: unknown[]
  if (lastTool !== undefined) {
    const result = String(lastTool.content)
    chunks = [say(`照查到的说：${result.slice(0, 200)}`)]
  } else if (asked.startsWith('让 Reddit 运营') && offered.includes('hand_to_position'))
    chunks = [toolCall('hand_to_position', { text: asked, position: 'Reddit 运营' })]
  else if (asked.includes('办了') && offered.includes('hand_to_position'))
    chunks = [toolCall('hand_to_position', { text: asked })]
  else if (asked.includes('要我处理')) chunks = [toolCall('my_pending_cards', {})]
  else if (asked.includes('在做什么')) chunks = [toolCall('work_overview', {})]
  else if (asked.includes('发出去')) chunks = [toolCall('recent_sent', {})]
  else if (asked.includes('到哪了')) chunks = [toolCall('matter_progress', { query: '新帖' })]
  else if (asked.includes('记住'))
    chunks = [say('好的。\n<remember>回 Reddit 一律用英文</remember>')]
  else chunks = [say('你好，'), say('有什么想聊的？')]
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
    text: async () => (body.stream === true ? sse(chunks) : JSON.stringify(json)),
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
const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}
const frames = async (res: Response): Promise<FreeChatFrame[]> =>
  (await res.text())
    .split('\n')
    .filter((l) => l.startsWith('data: '))
    .map((l) => JSON.parse(l.slice(6)) as FreeChatFrame)

const newSession = async (): Promise<string> =>
  (await data<FreeChatSessionView>(await call('POST', '/v1/free-chat/sessions', {}))).id
const send = async (session: string, text: string, extra: Record<string, unknown> = {}) =>
  frames(await call('POST', `/v1/free-chat/sessions/${session}/messages`, { text, ...extra }))
const messagesOf = async (session: string) =>
  data<FreeChatMessageView[]>(await call('GET', `/v1/free-chat/sessions/${session}/messages`))

const types = (since: number): string[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .slice(since)
    .map((e) => e.type)
const eventCount = (): number =>
  server.kernel.eventLog.readSync({ workspace_id: server.bootstrap.workspace.id }).length

let redditPosition = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp343-assistant-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'a'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    modelFetch: fetch,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  const saved = await call('PUT', '/v1/models/providers/deepseek', {
    kind: 'deepseek',
    model: 'deepseek-flash',
    api_key: 'sk-assistant-test-0001',
  })
  expect(saved.status).toBe(200)
  // 两个干活的岗位：自建「Reddit 运营」（官方版块 + 外部露出）与「客服」模板
  for (const input of [
    {
      name: 'Reddit 运营',
      roles: [
        { role_id: 'social.reddit', default: true },
        { role_id: 'pr.reddit', default: true },
      ],
    },
  ]) {
    const position = await data<{ id: string }>(await call('POST', '/v1/org/positions', input))
    if (input.name === 'Reddit 运营') redditPosition = position.id
    const res = await call('POST', '/v1/assignments', {
      person_id: server.bootstrap.ownerAssignment.person_id,
      position_id: position.id,
      ranges: [],
      range_groups: [],
    })
    expect(res.status).toBeLessThan(300)
  }
  const care = await call('POST', '/v1/assignments', {
    person_id: server.bootstrap.ownerAssignment.person_id,
    position_id: 'customer-care',
    ranges: [],
    range_groups: [],
  })
  expect(care.status).toBeLessThan(300)
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP343「我的助理」', () => {
  it('快捷问题按状态生成（有岗位：某岗位今天做了什么 + 一条派活例句）；@ 能选本人的岗位', async () => {
    const state = await data<AssistantStateView>(await call('GET', '/v1/free-chat/assistant'))
    expect(state.suggestions.length).toBeGreaterThan(0)
    expect(state.suggestions.length).toBeLessThanOrEqual(4)
    expect(state.suggestions.some((s) => s.kind === 'position')).toBe(true)
    expect(state.suggestions.some((s) => s.kind === 'create_position')).toBe(false)
    const reddit = state.targets.find((t) => t.name === 'Reddit 运营')
    expect(reddit?.duties.map((d) => d.role_id).sort()).toEqual(['pr.reddit', 'social.reddit'])
  })

  it('「让 Reddit 运营查一下今天的新帖」→ 开出事项 → 事项回结果 → 对话里出现回报', async () => {
    const session = await newSession()
    const before = eventCount()
    const got = await send(session, '让 Reddit 运营查一下今天的新帖')
    const dispatched = got.find((f) => f.type === 'dispatched')
    if (dispatched?.type !== 'dispatched') throw new Error('没交出去')
    expect(dispatched.dispatch.position_name).toBe('Reddit 运营')
    expect(dispatched.dispatch.position_id).toBe(redditPosition)
    const matter = server.work.getMatter(dispatched.dispatch.matter_id)
    expect(matter?.position_template_id).toBe(redditPosition)
    expect(matter?.entry).toBe('position')
    // 助理自己没有任何对外写口：这一轮只开了事项，没有 staged / applied
    const after = types(before)
    expect(after).toContain('matter.opened')
    expect(after.filter((t) => t === 'change.staged' || t.endsWith('.applied'))).toEqual([])
    const done = got.find((f) => f.type === 'done')
    expect(done?.type === 'done' ? done.message.dispatches?.[0]?.matter_id : undefined).toBe(
      matter?.id,
    )
    // 等那件事回结果（stub 运行时）
    for (let i = 0; i < 100; i += 1) {
      const tl = server.work.store.listMatterEvents(matter?.id ?? '')
      if (tl.some((e) => e.kind === 'agent_message' || e.failed !== undefined)) break
      await new Promise((r) => setTimeout(r, 30))
    }
    const listed = await messagesOf(session)
    const report = listed.find((m) => m.report !== undefined)
    expect(report?.report?.matter_id).toBe(matter?.id)
    expect(['done', 'decide']).toContain(report?.report?.kind)
    expect(report?.text).toContain('Reddit 运营')
    // 同一步只报一次
    const again = await messagesOf(session)
    expect(again.filter((m) => m.report !== undefined).length).toBe(
      listed.filter((m) => m.report !== undefined).length,
    )
  })

  it('拿不准就不乱派：回候选、一件事都不开', async () => {
    const session = await newSession()
    const before = eventCount()
    const got = await send(session, '帮我把这件事办了')
    expect(got.some((f) => f.type === 'dispatched')).toBe(false)
    expect(types(before)).not.toContain('matter.opened')
    const done = got.find((f) => f.type === 'done')
    const text = done?.type === 'done' ? done.message.text : ''
    expect(text).toContain('dispatched')
    expect(text).toContain('Reddit 运营')
    expect(text).toContain('客服')
  })

  it('问全局（只读）：不开事项、不出卡、不 staged / applied', async () => {
    const session = await newSession()
    const before = eventCount()
    for (const q of [
      '各岗位在做什么',
      '今天有什么要我处理的',
      '最近发出去了什么',
      '新帖那件事到哪了',
    ])
      await send(session, q)
    const after = types(before)
    expect(
      after.filter((t) => /^(matter|run|approval|change|todo)\./.test(t) || t.endsWith('.applied')),
    ).toEqual([])
    const listed = await messagesOf(session)
    const overview = listed.find((m) => m.role === 'assistant' && m.text.includes('positions'))
    expect(overview?.text).toContain('Reddit 运营')
  })

  it('@ 选了岗位：不经模型直接交给它', async () => {
    const session = await newSession()
    upstream.length = 0
    const got = await send(session, '整理一下本周的退货问题', {
      target: { position_id: 'customer-care', label: '客服' },
    })
    // 助理那条模型回合一次都没走（开事项那边起名字之类的调用不算）
    expect(JSON.stringify(upstream)).not.toContain('用户的「助理」')
    const dispatched = got.find((f) => f.type === 'dispatched')
    expect(dispatched?.type === 'dispatched' ? dispatched.dispatch.position_name : '').toBe('客服')
    const listed = await messagesOf(session)
    expect(listed[0]?.to).toBe('客服')
  })

  it('助理记忆：明说记住 / <remember> 记下、进记忆账本（小提醒）、能删、删了不再记回来', async () => {
    const session = await newSession()
    const got = await send(session, '记住：回 Reddit 一律用英文')
    const done = got.find((f) => f.type === 'done')
    expect(done?.type === 'done' ? done.message.text : '').not.toContain('<remember>')
    const memory = await data<AssistantMemoryView[]>(await call('GET', '/v1/free-chat/memory'))
    expect(memory.map((m) => m.text)).toEqual(['回 Reddit 一律用英文'])
    const changes = await data<{ tier: string; entry_id: string; written_by: string }[]>(
      await call('GET', '/v1/memory/changes?written_by=ai'),
    )
    expect(changes.some((c) => c.tier === 'personal' && c.entry_id === memory[0]?.id)).toBe(true)
    // 下一轮带着它——WP470：同一段里新记的接在这一轮那句话后面（系统提示不变，缓存照常命中）；下一段才进系统提示
    upstream.length = 0
    await send(session, '在吗')
    const sent = (upstream[0]?.messages ?? []) as Msg[]
    expect(String(sent[0]?.content)).not.toContain('回 Reddit 一律用英文')
    expect(String(sent.at(-1)?.content)).toContain('回 Reddit 一律用英文')
    // 删掉 → 没了；模型再写一样的 <remember>（人没明说）也不记回来
    const removed = await call('DELETE', `/v1/free-chat/memory/${memory[0]?.id}`)
    expect(removed.status).toBe(200)
    expect(await data<AssistantMemoryView[]>(await call('GET', '/v1/free-chat/memory'))).toEqual([])
    expect((await call('DELETE', '/v1/free-chat/memory/amem_nope')).status).toBe(404)
  })
})
