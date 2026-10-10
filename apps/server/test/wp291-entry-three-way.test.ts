/**
 * WP291（决策 356，Luoye 10-10）：岗位入口三分——简单问答当场出组件 / 多轮进会话 / 干活开任务。
 *
 * 真装配线（路由 → 岗位面 → 工作模型 → 运行时 → 模型网关），只把最外面那一跳（模型上游的 HTTP）
 * 换成替身：判断那一次按原话回固定的类别，跑活那一次回一句话 + ```answer 表格。不联网、不花钱。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MatterEvent } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

const WEB_OPS_ROLES = ['dtc.store', 'dtc.content', 'dtc.email-marketing', 'dtc.fulfillment']

/** 判断那一次的替身：原话 → 模型回的那段字（`undefined` = 照常回 JSON 里的类别）。 */
const JUDGE: Record<string, string> = {
  店里有哪些商品: '{"kind":"quick","why":"查一下商品"}',
  帮我想想详情页怎么优化: '{"kind":"chat","why":"要多轮讨论"}',
  上架一个草稿商品: '{"kind":"task","why":"要动手"}',
  今天有几单: '我觉得这是个简单问题',
}

const TABLE_ANSWER = [
  '店里现在有 2 件商品，都在卖。',
  '',
  '```answer',
  '{"components":[{"kind":"table","columns":["商品","价格","状态"],"rows":[["蓝牙耳机",129,"在卖"],["手机壳",29,"在卖"]]},{"kind":"metric","items":[{"label":"在卖","value":2,"unit":"件"}]}]}',
  '```',
].join('\n')

let server: Server | undefined
let dir: string | undefined
const runPrompts: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
  runPrompts.length = 0
})

const reply = (content: string) => {
  const json = {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 9, completion_tokens: 3 },
  }
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  }
}

const fakeModel: FetchLike = async (url, init) => {
  if (url.endsWith('/models'))
    return {
      ok: true,
      status: 200,
      json: async () => ({ object: 'list', data: [{ id: 'deepseek-flash' }] }),
      text: async () => '{}',
    }
  const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {
    messages?: { role: string; content: unknown }[]
  }
  const all = (body.messages ?? [])
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
  if (all.includes('分成三类之一')) {
    const said = /<external_data>\n?([\s\S]*?)\n?<\/external_data>/u.exec(all)?.[1]?.trim() ?? ''
    return reply(JUDGE[said] ?? '{"kind":"quick"}')
  }
  runPrompts.push(all)
  return reply(all.includes('哪些商品') ? TABLE_ANSWER : '好的，我们一起看看。')
}

async function boot(withModel = true): Promise<Server> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp291-'))
  const s = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    modelFetch: fakeModel,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  server = s
  for (const role_id of WEB_OPS_ROLES)
    s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: s.bootstrap.workspace.id,
      role_id,
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'store', id: 'store_1' }],
    })
  if (withModel) {
    const saved = await call('PUT', '/v1/models/providers/deepseek', {
      kind: 'deepseek',
      model: 'deepseek-flash',
      api_key: 'sk-wp291-test-0001',
    })
    expect(saved.status).toBe(200)
  }
  return s
}

const call = (method: string, path: string, body?: unknown): Promise<Response> => {
  const s = server as Server
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
  headers.set('X-Assignment', s.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return s.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const dataOf = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

interface OpenView {
  mode?: 'quick' | 'ask' | 'task'
  entry?: { kind: string; by: string }
  answer?: {
    outcome: string
    text: string
    lead?: string
    components?: { kind: string; columns?: string[]; rows?: unknown[][] }[]
    sources: string[]
  }
  matter: { id: string; ask?: boolean }
  run_id?: string
}

const open = async (title: string, extra: Record<string, unknown> = {}): Promise<OpenView> =>
  dataOf<OpenView>(await call('POST', '/v1/positions/web-ops/matters', { title, ...extra }))

const timeline = (id: string): MatterEvent[] => (server as Server).work.store.listMatterEvents(id)
const openMatters = async (): Promise<number> =>
  (await dataOf<{ open_matters: number }>(await call('GET', '/v1/positions/web-ops'))).open_matters
const routedEvents = (): Record<string, unknown>[] =>
  (server as Server).kernel.eventLog
    .readSync({ workspace_id: (server as Server).bootstrap.workspace.id })
    .filter((e) => e.type === 'matter.routed')
    .map((e) => e.payload as Record<string, unknown>)

describe('WP291 三分：模型判', () => {
  it('quick：当场答，回「一句话 + 表格 + 数字」，不建事项（任何列表都不见它）', async () => {
    const s = await boot()
    const out = await open('店里有哪些商品', { detach: true })
    expect(out.mode).toBe('quick')
    expect(out.entry).toEqual({ kind: 'quick', by: 'model' })
    expect(out.answer?.outcome).toBe('answered')
    expect(out.answer?.lead).toBe('店里现在有 2 件商品，都在卖。')
    expect(out.answer?.components?.map((c) => c.kind)).toEqual(['table', 'metric'])
    expect(out.answer?.components?.[0]?.rows).toEqual([
      ['蓝牙耳机', 129, '在卖'],
      ['手机壳', 29, '在卖'],
    ])
    // 不建事项：默认列表（左栏会话历史）、会话列表、岗位「工作」、在办数都不见它
    expect(s.work.listMatters().map((m) => m.id)).not.toContain(out.matter.id)
    expect(s.work.listMatters({ asks: true }).map((m) => m.id)).not.toContain(out.matter.id)
    expect(await openMatters()).toBe(0)
    const work = await call('GET', '/v1/positions/web-ops/work')
    expect(await work.text()).not.toContain(out.matter.id)
    // 只在岗位「记录」里找得到
    const listed = await dataOf<{
      answers: { matter_id: string; question: string; lead: string }[]
    }>(await call('GET', '/v1/positions/web-ops/answers'))
    expect(listed.answers).toEqual([
      expect.objectContaining({
        matter_id: out.matter.id,
        question: '店里有哪些商品',
        lead: '店里现在有 2 件商品，都在卖。',
      }),
    ])
    // 判断理由只进本机事件；当场问答那次运行带「当场问答」那段规矩
    expect(routedEvents().at(-1)).toMatchObject({
      entry: { kind: 'quick', by: 'model', why: '查一下商品' },
    })
    expect(runPrompts.some((p) => p.includes('当场问答') && p.includes('```answer'))).toBe(true)
  })

  it('chat：进会话线程（detach 立刻回事项 id），会话在左栏会话历史里，不进工作', async () => {
    const s = await boot()
    const out = await open('帮我想想详情页怎么优化', { detach: true })
    expect(out.mode).toBe('ask')
    expect(out.entry).toEqual({ kind: 'chat', by: 'model' })
    expect(out.matter.ask).toBe(true)
    expect(s.work.listMatters().map((m) => m.id)).toContain(out.matter.id)
    expect(await openMatters()).toBe(0)
  })

  it('task：建任务、按路由到的职责做，线程里头一句「记成了任务，按「X」做」，detach 立刻回线程地址', async () => {
    const s = await boot()
    const out = await open('上架一个草稿商品', { detach: true })
    expect(out.mode).toBe('task')
    expect(out.entry).toEqual({ kind: 'task', by: 'model' })
    expect(out.matter.ask).toBeUndefined()
    expect(out.matter.id).toMatch(/^mat_/)
    expect(await openMatters()).toBe(1)
    const lines = timeline(out.matter.id)
    const human = lines.findIndex((e) => e.kind === 'human_message')
    const task = lines.findIndex((e) => e.route?.task === true)
    expect(human).toBeGreaterThanOrEqual(0)
    expect(task).toBe(human + 1)
    expect(lines[task]?.text).toBe('记成了任务，按「店铺管理」做')
    expect(s.work.getMatter(out.matter.id)?.role_id).toBe('dtc.store')
  })

  it('坏 JSON → 退回规则（问 → quick），理由里记着退回的原因', async () => {
    await boot()
    const out = await open('今天有几单')
    expect(out.mode).toBe('quick')
    expect(out.entry).toEqual({ kind: 'quick', by: 'rules' })
    expect(routedEvents().at(-1)).toMatchObject({
      entry: { kind: 'quick', by: 'rules', fallback: 'bad_json' },
    })
  })

  it('判断那一次过网关计量（用途 classify）', async () => {
    const s = await boot()
    await open('帮我想想详情页怎么优化', { detach: true })
    const usage = s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === 'model.usage')
      .map((e) => (e.payload as { purpose?: string }).purpose)
    expect(usage).toContain('classify')
  })
})

describe('WP291 三分：没接模型', () => {
  it('没接模型 → 规则：问 → quick（stub 跑活照样回答），交办 → task', async () => {
    await boot(false)
    const q = await open('现在店铺里有哪些产品')
    expect(q.mode).toBe('quick')
    expect(q.entry).toEqual({ kind: 'quick', by: 'rules' })
    expect(q.answer?.outcome).toBe('answered')
    expect(q.answer?.lead).not.toBe('')
    expect(routedEvents().at(-1)).toMatchObject({ entry: { fallback: 'no_model' } })
    const t = await open('把 A 商品降价 10%', { detach: true })
    expect(t.mode).toBe('task')
  })
})

describe('WP291 判错的补救', () => {
  it('「接着聊」：变成一段会话（进左栏会话历史），线程里一问一答都在', async () => {
    const s = await boot()
    const out = await open('店里有哪些商品')
    const res = await call('POST', `/v1/matters/${out.matter.id}/continue`)
    expect(res.status).toBe(200)
    const m = s.work.getMatter(out.matter.id)
    expect(m?.ask).toBeDefined()
    expect(m?.ask?.quick).toBeUndefined()
    expect(s.work.listMatters().map((x) => x.id)).toContain(out.matter.id)
    const kinds = timeline(out.matter.id).map((e) => e.kind)
    expect(kinds).toContain('human_message')
    expect(kinds).toContain('agent_message')
    // 之后不在「记录」的当场问答里
    const listed = await dataOf<{ answers: unknown[] }>(
      await call('GET', '/v1/positions/web-ops/answers'),
    )
    expect(listed.answers).toEqual([])
  })

  it('在当场问答的线程里再说一句 = 接着聊', async () => {
    const s = await boot()
    const out = await open('店里有哪些商品')
    const res = await call('POST', `/v1/matters/${out.matter.id}/messages`, {
      text: '哪件卖得最好',
    })
    expect(res.status).toBe(201)
    expect(s.work.getMatter(out.matter.id)?.ask?.quick).toBeUndefined()
    expect(s.work.listMatters().map((x) => x.id)).toContain(out.matter.id)
  })

  it('「当成任务做」：转成任务并按原话再跑一次（这次不带当场问答那段）', async () => {
    const s = await boot()
    const out = await open('店里有哪些商品')
    const before = runPrompts.length
    const res = await dataOf<{ matter: { id: string }; run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/promote`, { run: true }),
    )
    expect(res.run_id).toBeDefined()
    expect(s.work.getMatter(out.matter.id)?.ask).toBeUndefined()
    expect(await openMatters()).toBe(1)
    for (let i = 0; i < 50 && runPrompts.length === before; i += 1)
      await new Promise((r) => setTimeout(r, 20))
    expect(runPrompts.length).toBeGreaterThan(before)
    expect(runPrompts.at(-1)).not.toContain('当场问答')
  })

  it('老调用方 promote 不带 body：只转不跑', async () => {
    await boot()
    const out = await open('店里有哪些商品')
    const res = await dataOf<{ run_id?: string }>(
      await call('POST', `/v1/matters/${out.matter.id}/promote`),
    )
    expect(res.run_id).toBeUndefined()
  })
})
