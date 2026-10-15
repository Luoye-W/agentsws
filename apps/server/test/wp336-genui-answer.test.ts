/**
 * WP336（决策 810–812）：当场回答换 dsh-genui 的 ```dsh-ui 写法。
 *
 * 同 WP291 的真装配线，只把模型上游的 HTTP 换成替身：替身回一句话 + ```dsh-ui，里面故意夹着按钮 /
 * 图片 / 3D / 外链 / 自定义配色。断言回出去的是过滤后的一块 genui；回退开关切到 answer 时，教的是
 * ```answer、回出去的是降级后的表格 / 数字。不联网、不花钱。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QUICK_ANSWER_UI_ENV } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { quickAnswerForIm } from '../src/im-position-ask.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

const WEB_OPS_ROLES = ['dtc.store', 'dtc.content', 'dtc.email-marketing', 'dtc.fulfillment']

/** 判断那一次的替身：原话 → 模型回的那段字（`undefined` = 照常回 JSON 里的类别）。 */
const JUDGE: Record<string, string> = {
  店里有哪些商品: '{"kind":"quick","why":"查一下商品"}',
}

const GENUI_ANSWER = [
  '店里现在有 2 件商品，都在卖。',
  '',
  '```dsh-ui',
  JSON.stringify({
    items: [
      { type: 'stat', label: '在卖', value: '2', delta: '+100%' },
      {
        type: 'table',
        columns: ['商品', '价格', '状态'],
        rows: [
          ['蓝牙耳机', 129, '在卖'],
          ['手机壳', 29, '在卖'],
        ],
        export: true,
      },
      { type: 'button', label: '一键上架', action: 'publish' },
      { type: 'image', src: 'https://evil.example/a.png' },
      { type: 'scene3d', meshes: [] },
      { type: 'callout', content: '详情见 [后台](https://evil.example/admin)', accent: '#f00' },
    ],
  }),
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
  delete process.env[QUICK_ANSWER_UI_ENV]
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
  if (all.includes('上游会挂的问题'))
    return { ok: false, status: 500, json: async () => ({}), text: async () => 'boom' }
  return reply(all.includes('哪些商品') ? GENUI_ANSWER : '好的，我们一起看看。')
}

async function boot(withModel = true): Promise<Server> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp336-'))
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
    components?: {
      kind: string
      columns?: string[]
      rows?: unknown[][]
      spec?: { items: Record<string, unknown>[] }
      items?: unknown[]
    }[]
    sources: string[]
  }
  matter: { id: string; ask?: boolean }
  run_id?: string
}

const open = async (title: string, extra: Record<string, unknown> = {}): Promise<OpenView> =>
  dataOf<OpenView>(await call('POST', '/v1/positions/web-ops/matters', { title, ...extra }))

describe('WP336 当场回答 ```dsh-ui', () => {
  it('回出去的是过滤后的一块 genui：按钮 / 图片 / 3D / 外链 / 配色都没了，数字照替身原样', async () => {
    await boot()
    const out = await open('店里有哪些商品', { detach: true })
    expect(out.mode).toBe('quick')
    expect(out.answer?.lead).toBe('店里现在有 2 件商品，都在卖。')
    expect(out.answer?.components?.map((c) => c.kind)).toEqual(['genui'])
    const items = out.answer?.components?.[0]?.spec?.items ?? []
    expect(items.map((n) => n.type)).toEqual(['stat', 'table', 'callout'])
    expect(items[0]).toEqual({ type: 'stat', label: '在卖', value: '2', delta: '+100%' })
    expect(items[1]?.rows).toEqual([
      ['蓝牙耳机', 129, '在卖'],
      ['手机壳', 29, '在卖'],
    ])
    expect(items[2]).toEqual({ type: 'callout', content: '详情见 后台' })
    const json = JSON.stringify(out.answer?.components)
    for (const bad of ['button', 'image', 'scene3d', 'http', 'action', 'export', '#f00'])
      expect(json).not.toContain(bad)
    // 这次运行教的是 ```dsh-ui 子集
    expect(runPrompts.some((p) => p.includes('当场问答') && p.includes('```dsh-ui'))).toBe(true)
    // 「记录」里的那一句照旧
    const listed = await dataOf<{ answers: { lead: string }[] }>(
      await call('GET', '/v1/positions/web-ops/answers'),
    )
    expect(listed.answers.map((a) => a.lead)).toEqual(['店里现在有 2 件商品，都在卖。'])
  })

  it('回退开关 answer：教 ```answer；模型仍写 ```dsh-ui 的，降级成数字 + 表格 + 一段字', async () => {
    process.env[QUICK_ANSWER_UI_ENV] = 'answer'
    await boot()
    const out = await open('店里有哪些商品', { detach: true })
    expect(out.answer?.components?.map((c) => c.kind)).toEqual(['metric', 'table', 'text'])
    expect(out.answer?.components?.[1]?.rows).toEqual([
      ['蓝牙耳机', 129, '在卖'],
      ['手机壳', 29, '在卖'],
    ])
    const prompt = runPrompts.find((p) => p.includes('当场问答')) ?? ''
    expect(prompt).toContain('```answer')
    expect(prompt).not.toContain('```dsh-ui')
  })
})

describe('WP336 聊天软件里', () => {
  it('genui 块压成几行字：数字一行、表格一行一条', () => {
    const text = quickAnswerForIm({
      lead: '店里有 2 件商品。',
      text: '',
      components: [
        {
          kind: 'genui',
          spec: {
            items: [
              { type: 'stat', label: '在卖', value: '2' },
              { type: 'table', columns: ['商品', '价格'], rows: [['蓝牙耳机', 129]] },
            ],
          },
        },
      ],
    })
    expect(text).toBe('店里有 2 件商品。\n在卖 2\n· 蓝牙耳机，129')
  })
})
