/**
 * WP350（决策 900）「我的助理」一次拆成多份——端到端：真服务进程（运行时 stub）+ 上游模型回放。钉住：
 *
 * - 附一份 .md 会议记录 → 模型调 `plan_fanout` → 方案卡（3 个岗位的事 + 2 个岗位的知识 + 待定 + 个人偏好）；
 *   出卡这一步什么都不发（没有事项、没有知识条目）；
 * - 点「就这样」（勾掉一条、改一条归属）→ 开出 3 件事（同一来源批次，事项描述里有原文）、勾掉的不发、
 *   改归属生效、归属待定的不发；要记的**直接生效**带出处写进对应岗位知识库、不出确认卡（WP357 决策 902）；
 *   个人偏好进助理记忆；
 * - 各件事回报按批次回到这段对话；同一张卡再点回冲突；
 * - WP357：知识库里改一条（旧的退役、新的生效、出处不变）、删一条（退役）；汇总卡上撤销这一批；
 * - 附件里像口令的抹掉再给模型；读不出文字的照实说。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  FreeChatFanoutView,
  FreeChatFrame,
  FreeChatMessageView,
  FreeChatSessionView,
} from '@agentsws/api'
import type { FactCard } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let server: Server
let dir: string
const upstream: Record<string, unknown>[] = []

type Msg = { role: string; content: unknown }
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

/** 替身会议记录里那几行（拆出来的每条都带原文出处）。 */
const NOTES = [
  '# 10-16 周会',
  '- Reddit 运营：回复昨天那条差评帖',
  '- 客服：整理一版退货话术',
  '- 网站运营：把 A 商品详情页卖点更新一下，周五前',
  '- 客服：把上周的工单再过一遍',
  '- 这件事谁来跟一下',
  '- 客服记住：退货期统一 30 天',
  '- 网站运营记住：运费一律满 50 包邮',
  '- 我喜欢周报用表格',
  '- 后台密码：hunter2-secret-0099',
].join('\n')

/** 模型那一步：按会议记录拆（一条一条，带模型猜的岗位）。第 4 件给了客服、人会改到网站运营。 */
const PLAN = {
  title: '10-16 周会',
  items: [
    {
      kind: 'task',
      text: '回复昨天那条差评帖',
      position: 'Reddit 运营',
      why: '会上定的',
      quote: 'Reddit 运营：回复昨天那条差评帖',
    },
    { kind: 'task', text: '整理一版退货话术', position: '客服', quote: '客服：整理一版退货话术' },
    {
      kind: 'task',
      text: '把 A 商品详情页卖点更新一下',
      position: '客服',
      due: '周五前',
      quote: '网站运营：把 A 商品详情页卖点更新一下，周五前',
    },
    {
      kind: 'task',
      text: '把上周的工单再过一遍',
      position: '客服',
      quote: '客服：把上周的工单再过一遍',
    },
    { kind: 'task', text: '这件事谁来跟一下', quote: '这件事谁来跟一下' },
    {
      kind: 'note',
      text: '退货期统一 30 天',
      position: '客服',
      quote: '客服记住：退货期统一 30 天',
    },
    {
      kind: 'note',
      text: '运费一律满 50 包邮',
      position: '网站运营',
      quote: '网站运营记住：运费一律满 50 包邮',
    },
    { kind: 'memory', text: '周报用表格' },
  ],
}

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
  if (lastTool !== undefined) chunks = [say('按岗位拆好了，看一眼，没问题就点「就这样」。')]
  else if (asked.includes('<external_data>') && offered.includes('plan_fanout'))
    chunks = [toolCall('plan_fanout', PLAN)]
  else chunks = [say('（演示）做好了。')]
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
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const messagesOf = async (session: string) =>
  data<FreeChatMessageView[]>(await call('GET', `/v1/free-chat/sessions/${session}/messages`))
const eventTypes = (since: number): string[] =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .slice(since)
    .map((e) => e.type)
const eventCount = (): number =>
  server.kernel.eventLog.readSync({ workspace_id: server.bootstrap.workspace.id }).length
const cards = async (): Promise<FactCard[]> =>
  (await data<FactCard[]>(await call('GET', '/v1/knowledge/cards'))).filter(
    (c) => c.subject.type === 'assistant_note',
  )

let redditPosition = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp350-fanout-'))
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
    api_key: 'sk-fanout-test-0001',
  })
  expect(saved.status).toBe(200)
  const reddit = await data<{ id: string }>(
    await call('POST', '/v1/org/positions', {
      name: 'Reddit 运营',
      roles: [{ role_id: 'social.reddit', default: true }],
    }),
  )
  redditPosition = reddit.id
  for (const position_id of [reddit.id, 'customer-care', 'web-ops']) {
    const res = await call('POST', '/v1/assignments', {
      person_id: server.bootstrap.ownerAssignment.person_id,
      position_id,
      ranges: [],
      range_groups: [],
    })
    expect(res.status).toBeLessThan(300)
  }
})

afterAll(async () => {
  await server.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('WP350 助理一次拆成多份', () => {
  let session = ''
  let plan: FreeChatFanoutView | undefined

  it('附一份会议记录 → 方案卡（按岗位、待定、偏好、口令那条不出）；出卡这一步什么都不发', async () => {
    session = await newSession()
    const before = eventCount()
    const got = await frames(
      await call('POST', `/v1/free-chat/sessions/${session}/messages`, {
        text: '这是今天的会议记录，帮我分下去',
        files: [{ name: '10-16 周会纪要.md', data: b64(NOTES) }],
      }),
    )
    const start = got.find((f) => f.type === 'start')
    // 界面拿到的附件只有名字与字数，不带正文
    expect(start?.type === 'start' ? start.user?.attachments?.[0]?.name : '').toBe(
      '10-16 周会纪要.md',
    )
    expect(start?.type === 'start' ? start.user?.attachments?.[0]?.text : 'x').toBeUndefined()
    // 口令那一行抹掉了才进模型；界面上说了一句
    expect(got.some((f) => f.type === 'notice' && f.text.includes('像口令'))).toBe(true)
    expect(JSON.stringify(upstream.at(-1))).not.toContain('hunter2-secret-0099')
    expect(JSON.stringify(upstream.at(-2) ?? upstream.at(-1))).toContain('退货期统一 30 天')
    const frame = got.find((f) => f.type === 'fanout')
    if (frame?.type !== 'fanout') throw new Error('没出方案卡')
    plan = frame.fanout
    expect(plan.status).toBe('proposed')
    expect(plan.title).toBe('10-16 周会')
    expect(plan.source).toEqual({ name: '10-16 周会纪要.md', kind: 'meeting' })
    const tasks = plan.items.filter((i) => i.kind === 'task')
    expect(tasks.map((i) => i.position_name ?? '待定')).toEqual([
      'Reddit 运营',
      '客服',
      '客服',
      '客服',
      '待定',
    ])
    expect(tasks[4]?.unsure).toBeDefined()
    expect(plan.items.filter((i) => i.kind === 'note').map((i) => i.position_name)).toEqual([
      '客服',
      '网站运营',
    ])
    expect(plan.items.find((i) => i.kind === 'memory')?.text).toBe('周报用表格')
    expect(plan.positions.map((p) => p.name).sort()).toEqual(['Reddit 运营', '客服', '网站运营'])
    // 什么都没发
    const after = eventTypes(before)
    expect(after).not.toContain('matter.opened')
    expect(after.filter((t) => t.startsWith('approval.'))).toEqual([])
    expect(await cards()).toEqual([])
    // 方案卡存在那条回复上
    const listed = await messagesOf(session)
    expect(listed.find((m) => m.fanout !== undefined)?.fanout?.batch_id).toBe(plan.batch_id)
    expect(listed.find((m) => m.role === 'user')?.attachments?.[0]?.text).toBeUndefined()
  })

  it('就这样（勾掉一条、改一条归属）→ 3 件事同一批次、知识直接生效带出处、无确认卡、偏好进记忆；勾掉 / 待定的不发', async () => {
    if (plan === undefined) throw new Error('没有方案卡')
    const id = (text: string) => plan?.items.find((i) => i.text === text)?.id as string
    const before = eventCount()
    const res = await call('POST', `/v1/free-chat/sessions/${session}/fanout/${plan.batch_id}`, {
      items: [
        { id: id('把 A 商品详情页卖点更新一下'), position_id: 'web-ops' },
        { id: id('把上周的工单再过一遍'), drop: true },
      ],
    })
    expect(res.status).toBe(200)
    const out = await data<{ plan: FreeChatMessageView; summary?: FreeChatMessageView }>(res)
    expect(out.plan.fanout?.status).toBe('sent')
    const summary = out.summary?.fanout_summary
    if (summary === undefined) throw new Error('没有汇总')
    expect(summary.batch_id).toBe(plan.batch_id)
    expect(summary.skipped).toEqual({ dropped: 1, unsure: 1, secret: 0 })
    expect(summary.memories).toBe(1)
    const byName = Object.fromEntries(summary.groups.map((g) => [g.name, g]))
    expect(byName['Reddit 运营']?.tasks.length).toBe(1)
    expect(byName['客服']?.tasks.length).toBe(1)
    expect(byName['客服']?.notes).toBe(1)
    expect(byName['网站运营']?.tasks.length).toBe(1)
    expect(byName['网站运营']?.notes).toBe(1)
    // 三件事：各落在对的岗位，事项描述里有原文出处
    const dispatched = out.summary?.dispatches ?? []
    expect(dispatched.length).toBe(3)
    expect(new Set(dispatched.map((d) => d.batch_id))).toEqual(new Set([plan.batch_id]))
    const matters = dispatched.map((d) => server.work.getMatter(d.matter_id))
    expect(matters.map((m) => m?.position_template_id).sort()).toEqual(
      [redditPosition, 'customer-care', 'web-ops'].sort(),
    )
    const site = matters.find((m) => m?.position_template_id === 'web-ops')
    expect(site?.context.summary).toContain('网站运营：把 A 商品详情页卖点更新一下，周五前')
    expect(site?.context.summary).toContain('截止：周五前')
    expect(site?.context.summary).toContain('10-16 周会')
    expect(eventTypes(before).filter((t) => t === 'matter.opened').length).toBe(3)
    // 勾掉的、待定的没开
    expect(matters.some((m) => m?.title.includes('工单'))).toBe(false)
    expect(matters.some((m) => m?.title.includes('谁来跟'))).toBe(false)
    // 知识：直接生效（决策 902）、出处 = 这份资料、归在对的岗位
    const notes = await cards()
    expect(notes.map((c) => [c.statement, c.status, c.subject.id]).sort()).toEqual(
      [
        ['运费一律满 50 包邮', 'active', 'web-ops'],
        ['退货期统一 30 天', 'active', 'customer-care'],
      ].sort(),
    )
    expect(new Set(summary.note_card_ids)).toEqual(new Set(notes.map((c) => c.id)))
    expect(eventTypes(before).filter((t) => t === 'knowledge.card.activated').length).toBe(2)
    expect(notes[0]?.provenance[0]?.ref).toBe(`assistant:${plan.batch_id}`)
    expect(notes[0]?.provenance[0]?.locator).toBe('10-16 周会')
    expect(notes.find((c) => c.subject.id === 'customer-care')?.provenance[0]?.quote).toContain(
      '退货期统一 30 天',
    )
    // 不再出第二张「要记的 N 条」确认卡
    expect(summary.knowledge_card_id).toBeUndefined()
    const events = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .slice(before)
    expect(JSON.stringify(events)).not.toContain('assistant_notes')
    expect(out.summary?.text).toContain('已经记进知识库')
    // 偏好进助理记忆
    const memory = await data<{ text: string; written_by: string }[]>(
      await call('GET', '/v1/free-chat/memory'),
    )
    expect(memory.some((m) => m.text === '周报用表格' && m.written_by === 'person')).toBe(true)
    // 同一张卡再点：冲突
    const again = await call(
      'POST',
      `/v1/free-chat/sessions/${session}/fanout/${plan.batch_id}`,
      {},
    )
    expect(again.status).toBe(409)
  })

  it('各件事的回报按批次回到这段对话', async () => {
    if (plan === undefined) throw new Error('没有方案卡')
    const ids = (await messagesOf(session)).flatMap((m) =>
      m.fanout_summary === undefined ? [] : m.fanout_summary.groups.flatMap((g) => g.tasks),
    )
    for (let i = 0; i < 200; i += 1) {
      const done = ids.every((t) =>
        server.work.store
          .listMatterEvents(t.matter_id)
          .some((e) => e.kind === 'agent_message' || e.failed !== undefined || e.kind === 'card'),
      )
      if (done) break
      await new Promise((r) => setTimeout(r, 30))
    }
    const reports = (await messagesOf(session)).filter((m) => m.report !== undefined)
    expect(new Set(reports.map((r) => r.report?.matter_id))).toEqual(
      new Set(ids.map((t) => t.matter_id)),
    )
    expect(reports.every((r) => r.report?.batch_id === plan?.batch_id)).toBe(true)
    expect(reports.every((r) => r.report?.batch_title === '10-16 周会')).toBe(true)
  })

  it('WP357：知识库里改一条（就地改、出处不变、旧句留痕）、删一条；汇总卡上撤销这一批', async () => {
    const before = await cards()
    const ship = before.find((c) => c.statement === '运费一律满 50 包邮')
    const ret = before.find((c) => c.statement === '退货期统一 30 天')
    if (ship === undefined || ret === undefined) throw new Error('没有那两条')
    const edited = await call('PATCH', `/v1/free-chat/notes/${ship.id}`, {
      statement: '运费一律满 60 包邮',
    })
    expect(edited.status).toBe(200)
    const next = await data<FactCard>(edited)
    expect(next.id).toBe(ship.id)
    expect(next.statement).toBe('运费一律满 60 包邮')
    expect(next.status).toBe('active')
    expect(next.subject.id).toBe('web-ops')
    expect(next.provenance).toEqual(ship.provenance)
    const previous = (next.structured?.previous ?? []) as { statement: string }[]
    expect(previous[0]?.statement).toBe('运费一律满 50 包邮')
    // 空的不行；不存在的 404
    expect((await call('PATCH', `/v1/free-chat/notes/${ship.id}`, { statement: ' ' })).status).toBe(
      400,
    )
    expect((await call('DELETE', '/v1/free-chat/notes/fact_nope')).status).toBe(404)
    // 删一条 = 退役（留痕不删）；删过的再删 404
    const removed = await call('DELETE', `/v1/free-chat/notes/${ret.id}`)
    expect(removed.status).toBe(200)
    expect((await cards()).find((c) => c.id === ret.id)?.status).toBe('retired')
    expect((await call('DELETE', `/v1/free-chat/notes/${ret.id}`)).status).toBe(404)
    // 撤销这一批：还生效的那条（改过的）退役；撤过的再点 409
    const undo = await call(
      'POST',
      `/v1/free-chat/sessions/${session}/fanout/${plan?.batch_id}/undo-notes`,
    )
    expect(undo.status).toBe(200)
    const undone = (await data<{ summary: FreeChatMessageView }>(undo)).summary.fanout_summary
    expect(undone?.notes_undone_at).toBeDefined()
    expect(undone?.notes_undone).toBe(1)
    expect((await cards()).map((c) => c.status)).toEqual(['retired', 'retired'])
    expect(
      (await call('POST', `/v1/free-chat/sessions/${session}/fanout/${plan?.batch_id}/undo-notes`))
        .status,
    ).toBe(409)
    const listed = (await messagesOf(session)).find((m) => m.fanout_summary !== undefined)
    expect(listed?.fanout_summary?.notes_undone_at).toBeDefined()
  })

  it('不用了：什么都不发；读不出文字的附件照实说', async () => {
    const s2 = await newSession()
    const got = await frames(
      await call('POST', `/v1/free-chat/sessions/${s2}/messages`, {
        text: '再分一次',
        files: [
          { name: '纪要.md', data: b64(NOTES) },
          { name: '扫描件.pdf', data: b64('%PDF-1.4\n%%EOF') },
        ],
      }),
    )
    expect(got.some((f) => f.type === 'notice' && f.text.includes('扫描件.pdf'))).toBe(true)
    const frame = got.find((f) => f.type === 'fanout')
    if (frame?.type !== 'fanout') throw new Error('没出方案卡')
    const before = eventCount()
    const res = await call('POST', `/v1/free-chat/sessions/${s2}/fanout/${frame.fanout.batch_id}`, {
      dismiss: true,
    })
    const out = await data<{ plan: FreeChatMessageView; summary?: FreeChatMessageView }>(res)
    expect(out.plan.fanout?.status).toBe('dismissed')
    expect(out.summary).toBeUndefined()
    expect(eventTypes(before)).not.toContain('matter.opened')
    // 别人会话里的卡 / 不存在的批次：not_found
    const nope = await call('POST', `/v1/free-chat/sessions/${s2}/fanout/fan_nope`, {})
    expect(nope.status).toBe(404)
  })
})
