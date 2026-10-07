/**
 * WP255（决策 144）：工作台「回复」按钮背后的两条口子，端到端（起真进程 → 打 HTTP；Reddit 一侧是内存里的
 * old.reddit 替身，**不访问 reddit.com、不起浏览器**；没接模型 → 起草退回模板并照实说）。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 自家版队列里一条 → 记成一条线程（同一条只记一次、不判类、不出卡） | 回帖卡要挂在线程上 |
 * | 起草：没接模型给一句模板 + 「这次没用 AI」；不出卡、不落库 | 人改了再出卡 |
 * | 出卡走 `/v1/social/threads/:id/reply`：一张回帖卡，不直接发 | 同 WP254 |
 * | 承诺话术打回 400，原因原话回来（界面就地显示） | 同客服回信那道门 |
 * | 社群线程列表那一条（Discord 演示线程）同样能起草、出卡 | 两个入口同一条路 |
 */
import type { Assignment, OwnSubQueueView } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createFakeOldReddit, type FakeOldReddit } from '../src/reddit-official-browser/stand-in.js'

const T0 = '2026-10-07T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)
const ORIGIN = 'https://old.reddit.com'

let server: Server
let url: string
let reddit: Assignment
let discord: Assignment
let site: FakeOldReddit

const api = async (path: string, init: RequestInit = {}, as?: Assignment): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', (as ?? reddit).id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}, as?: Assignment): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) }, as)
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

beforeEach(async () => {
  site = createFakeOldReddit(ORIGIN)
  site.queues.modqueue = [
    {
      kind: 't3',
      id: 'held1',
      title: 'My review',
      body: 'Display is sharp, the hinge feels solid.',
      author: 'bob',
      reports: [],
    },
  ]
  server = await createServer({
    quiet: true,
    clock: { now: () => T0 },
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_SECRETS_KEY: SECRETS_KEY },
    redditOfficialBrowser: {
      origin: ORIGIN,
      openPage: site.opener(),
      sleep: async () => undefined,
    },
  })
  ;({ url } = await server.listen(0))
  const grant = (role_id: string) =>
    server.roles.assignments.create({
      person_id: server.bootstrap.person.id,
      workspace_id: server.bootstrap.workspace.id,
      granted_by: server.bootstrap.person.id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id,
    })
  reddit = grant('social.reddit')
  discord = grant('social.discord')
})

afterEach(async () => {
  await server.close()
})

const cardCount = async (): Promise<number> =>
  (await server.txn.runtime.store.listApprovals({ workspace_id: server.bootstrap.workspace.id }))
    .length

async function ownSubItem(): Promise<{ account_id: string; item_id: string }> {
  const account = await data<{ id: string }>(
    await post('/v1/social/accounts', {
      channel: 'reddit',
      handle: 'r/inmoxr',
      display_name: 'INMO XR',
      url: 'https://www.reddit.com/r/inmoxr/',
      external_id: 'inmoxr',
      own_subreddit: true,
    }),
  )
  await post('/v1/social/reddit-browser/login')
  site.loggedIn = true
  await post('/v1/social/reddit-browser/check')
  const q = await data<OwnSubQueueView>(await api('/v1/social/own-sub/queue'))
  const item = q.items.find((i) => i.id === 't3_held1')
  expect(item).toBeDefined()
  return { account_id: account.id, item_id: 't3_held1' }
}

describe('WP255 自家版待处理里的「回复」', () => {
  it('记成线程（只记一次、不出卡）→ 起草（没接模型：模板 + 照实说）→ 出回帖卡、不直接发', async () => {
    const input = await ownSubItem()
    const cardsBefore = await cardCount()

    const first = await data<{ thread_id: string }>(await post('/v1/social/own-sub/thread', input))
    const again = await data<{ thread_id: string }>(await post('/v1/social/own-sub/thread', input))
    expect(again.thread_id).toBe(first.thread_id)
    const rows = await data<{ rows: { id: string; external_id: string; surface: string }[] }>(
      await api(`/v1/social/threads?account_id=${input.account_id}`),
    )
    expect(rows.rows.filter((r) => r.external_id === 't3_held1')).toEqual([
      expect.objectContaining({ id: first.thread_id, surface: 'thread' }),
    ])
    // 记线程不判类、不出卡
    expect(await cardCount()).toBe(cardsBefore)

    const draft = await data<{ text: string; source: string; note?: string; warning?: string }>(
      await post(`/v1/social/threads/${first.thread_id}/reply-draft`),
    )
    expect(draft).toMatchObject({ source: 'template', text: 'Hi u/bob, thanks for sharing this!' })
    expect(draft.note).toContain('没用 AI')
    expect(draft.warning).toBeUndefined()
    // 起草不出卡
    expect(await cardCount()).toBe(cardsBefore)

    const staged = await data<{ staged: boolean; approval_item_id?: string }>(
      await post(`/v1/social/threads/${first.thread_id}/reply`, {
        text: `${draft.text} Glad the hinge holds up.`,
      }),
    )
    expect(staged.staged).toBe(true)
    const card = await server.txn.approvals.get(staged.approval_item_id as string)
    expect(card).toMatchObject({
      kind: 'outbound_draft',
      payload: {
        form: 'social_reply',
        channel: 'reddit',
        thread_id: first.thread_id,
        body: { text: 'Hi u/bob, thanks for sharing this! Glad the hinge holds up.' },
      },
    })
    expect(site.posts).toEqual([])
  })

  it('承诺话术：打回 400、原因原话回来，不出卡', async () => {
    const input = await ownSubItem()
    const { thread_id } = await data<{ thread_id: string }>(
      await post('/v1/social/own-sub/thread', input),
    )
    const before = await cardCount()
    const bad = await post(`/v1/social/threads/${thread_id}/reply`, {
      text: 'We will refund you 100% tomorrow, guaranteed.',
    })
    expect(bad.status).toBe(400)
    const body = (await bad.json()) as { code: string; message: string }
    expect(body.code).toBe('invalid_input')
    expect(body.message).toContain('第一人称承诺')
    expect(await cardCount()).toBe(before)
  })

  it('队列里没有的那一条（刷新过 / 别的版）→ 404，不凭空记线程', async () => {
    const input = await ownSubItem()
    const miss = await post('/v1/social/own-sub/thread', { ...input, item_id: 't3_gone' })
    expect(miss.status).toBe(404)
    const wrong = await post('/v1/social/own-sub/thread', { ...input, account_id: 'sa_other' })
    expect(wrong.status).toBe(404)
  })
})

describe('WP255 社群线程列表里的「回复」（Discord）', () => {
  it('入站线程 → 起草（中文原话给中文模板）→ 出卡；不存在的线程 404', async () => {
    const account = await data<{ id: string }>(
      await post(
        '/v1/social/accounts',
        {
          channel: 'discord',
          handle: 'inmo-community',
          display_name: 'INMO 社群',
          url: 'https://discord.gg/inmo',
          external_id: 'guild_1',
        },
        discord,
      ),
    )
    const view = await data<{ thread: { id: string } }>(
      await post(
        '/v1/social/threads',
        {
          account_id: account.id,
          external_id: 'dc_msg_1',
          surface: 'thread',
          author_external_id: 'u_9',
          author_handle: 'linaw',
          text: '刚收到眼镜，佩戴很舒服，分享一下！',
        },
        discord,
      ),
    )
    const id = view.thread.id
    const draft = await data<{ text: string; source: string }>(
      await post(`/v1/social/threads/${id}/reply-draft`, {}, discord),
    )
    expect(draft).toEqual(
      expect.objectContaining({ source: 'template', text: 'linaw 你好，谢谢分享！' }),
    )
    const staged = await data<{ staged: boolean }>(
      await post(`/v1/social/threads/${id}/reply`, { text: '谢谢分享，戴着舒服就好～' }, discord),
    )
    expect(staged.staged).toBe(true)
    expect((await post('/v1/social/threads/ct_nope/reply-draft', {}, discord)).status).toBe(404)
  })
})
