/**
 * WP419（决策 1231）：侧边栏「等你发的社媒帖子」——快照里只给交给本人的那几条；回「发好了 / 不发了」要 `social.post`
 * （新配的对都有），别人的那一条 404，交给宿主的回话带上是谁。
 */
import type { PanelPost } from '@agentsws/browser-action'
import { describe, expect, it } from 'vitest'
import type { ExtensionPanelPort, ExtensionPort } from '../src/index.js'
import { createGateway, createMemoryExtensionStore, EXTENSION_SCOPES } from '../src/index.js'
import { harness, makeClock, seeded } from './helpers.js'

const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnop'

const post = (id: string, owner?: string): PanelPost & { owner?: string } => ({
  id,
  channel: 'x',
  channel_label: 'X',
  account: 'Nordvolt',
  body: 'Weekend checklist',
  kind: 'post',
  compose_url: 'https://x.com/intent/post?text=Weekend%20checklist',
  prefilled: true,
  media: 0,
  handed_at: '2026-10-19T04:00:00.000Z',
  ...(owner === undefined ? {} : { owner }),
})

async function wired() {
  const h = await harness()
  const answers: { id: string; answer: unknown }[] = []
  const port: ExtensionPanelPort = {
    facts: async () => ({
      progress: { configured: false, reading: false, drafting: 0, pending: 0 },
      writes: [],
      records: [],
      sinks: [],
      posts: [post('sp_mine', h.person_id), post('sp_other', h.other_id), post('sp_any')],
    }),
    deliverNow: async () => ({}),
    refill: () => ({ ok: false, message: 'x' }),
    answerPost: (_s, id, answer) => {
      answers.push({ id, answer })
      return { ok: true }
    },
  }
  const store = createMemoryExtensionStore({ clock: makeClock(), random: seeded(5) })
  const gateway = createGateway({
    ...h.deps,
    extension: { store } as unknown as ExtensionPort,
    extensionPanel: port,
  })
  const req = (method: string, path: string, headers: Headers, body?: unknown) => {
    if (body !== undefined) headers.set('content-type', 'application/json')
    return gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }
  const made = await req(
    'POST',
    '/v1/extension/pairings',
    new Headers({ Authorization: `Bearer ${h.token}`, 'X-Assignment': h.assignment.id }),
    {},
  )
  const code = ((await made.json()) as { data: { code: string } }).data.code
  const paired = await req('POST', '/v1/extension/pair', new Headers({ Origin: EXT_ORIGIN }), {
    code,
  })
  const token = ((await paired.json()) as { data: { token: string } }).data.token
  const plugin = (method: string, path: string, body?: unknown) =>
    req(method, path, new Headers({ Origin: EXT_ORIGIN, Authorization: `Bearer ${token}` }), body)
  return { plugin, answers }
}

const json = async (res: Response) => ((await res.json()) as { data: Record<string, unknown> }).data

describe('WP419 侧边栏：等你发的社媒帖子', () => {
  it('新配的对带 social.post；快照只有交给本人的（和没记是谁的）', async () => {
    expect(EXTENSION_SCOPES).toContain('social.post')
    const w = await wired()
    const snap = await json(await w.plugin('GET', '/v1/extension/panel'))
    expect(snap.can_post).toBe(true)
    const posts = snap.posts as PanelPost[]
    expect(posts.map((p) => p.id)).toEqual(['sp_mine', 'sp_any'])
    expect(posts[0]).not.toHaveProperty('owner')
  })
  it('发好了（带链接）/ 不发了 交给宿主；别人的那一条 404', async () => {
    const w = await wired()
    const done = await w.plugin('POST', '/v1/extension/panel/posts/sp_mine/done', {
      link: 'https://x.com/nordvolt/status/1',
    })
    expect(done.status).toBe(200)
    const skip = await w.plugin('POST', '/v1/extension/panel/posts/sp_any/skip', {
      reason: '不合适',
    })
    expect(skip.status).toBe(200)
    expect(w.answers).toEqual([
      { id: 'sp_mine', answer: { done: true, link: 'https://x.com/nordvolt/status/1' } },
      { id: 'sp_any', answer: { done: false, reason: '不合适' } },
    ])
    expect((await w.plugin('POST', '/v1/extension/panel/posts/sp_other/done', {})).status).toBe(404)
  })
})
