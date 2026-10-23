import type { ActionJob } from '@agentsws/browser-action'
/**
 * WP491 端到端（起真进程 → 打 HTTP；插件一侧直接调本机那一份动作通道 = 替身插件，**不起浏览器、不起 ego、不碰 reddit.com**；
 * ego 是注入的假手 `egoWriter`，按剧本回「发出去了」）。
 *
 * 没发出去那一行点「修改」→ `POST /v1/social/reddit/writes/:job/revise` 还原成原来那张审核卡（工坊里审、带上次的字、
 * 记着原项）→ 那一行收起 → 卡上改字批了 → 按选路发（这里是插件）→ 留痕接着记原来那几件活。
 */
import type { Assignment, RedditWritePayload, RedditWriteView } from '@agentsws/contracts'
import { isPluginDeskCard, redditWriteNotices } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-23T09:00:00.000Z'
const SECRETS_KEY = 'e'.repeat(64)

let server: Server
let url: string
let as: Assignment
let t = Date.parse(T0)
/** 按剧本回结果的假 ego（不起 ego、不碰真网站）；`on` 切「这会儿能不能用」。 */
const ego = {
  on: false,
  calls: [] as { platform: string; text: string; url: string }[],
}
const egoWriter = {
  available: () => ego.on,
  wanted: () => true,
  run: async (cfg: { platform: string; text: string; url: string }) => {
    ego.calls.push(cfg)
    return {
      platform: cfg.platform,
      state: 'sent',
      external_id: 't1_e9',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/e9/',
      readback: 'link',
      clicked: true,
    }
  },
}

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', as.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${url}${path}`, { ...init, headers })
}
const post = (path: string, body: unknown = {}): Promise<Response> =>
  api(path, { method: 'POST', body: JSON.stringify(body) })
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function decide(id: string, edited?: RedditWritePayload): Promise<void> {
  const fresh = await server.txn.approvals.get(id)
  const token = [...(fresh?.deliveries ?? [])]
    .reverse()
    .find((d) => d.status === 'sent')?.decision_token
  if (token === undefined) throw new Error(`这张卡没有本人的 decision_token：${fresh?.state}`)
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: edited === undefined ? 'approve' : 'approve_edited',
    decision_token: token,
    via: 'workstation',
    ...(edited === undefined ? {} : { edited_payload: edited }),
  } as never)
}

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

async function openAwaiting(): Promise<ActionJob | undefined> {
  const b = await brand()
  const row = b.redditWrites?.writes().find((w) => w.state === 'awaiting')
  if (row === undefined) return undefined
  const got = await b.redditWrites?.open(row.job_id)
  return got?.ok === true ? got.job : undefined
}

const replyTarget = {
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
}

beforeEach(async () => {
  t = Date.parse(T0)
  server = await createServer({
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    scheduleIntervalMs: 0,
    startRun: false,
    env: {
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      AGENTSWS_SECRETS_KEY: SECRETS_KEY,
      AGENTSWS_EGO_WRITE: 'off',
    },
    egoWriter: egoWriter as never,
  })
  ego.on = false
  ego.calls = []
  ;({ url } = await server.listen(0))
  as = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP491「修改」= 还原成原来那张审核卡（HTTP）', () => {
  it('没发出去 → 修改 → 原卡回到待审（工坊里）、那一行收起 → 改字批了按选路发、留痕连续', async () => {
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const text = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'
    const staged = await data<{ approval_item_id: string }>(
      await post('/v1/social/reddit/stage', { target: replyTarget, text }),
    )
    await decide(staged.approval_item_id)
    t += 125_000
    await b.redditWrites.sweep()
    const first = await openAwaiting()
    b.adsActions?.result(first?.id as string, {
      outcome: 'stopped',
      message: '你点了停止，已停下。',
      step: 6,
      reads: {},
    })

    const res = await post(`/v1/social/reddit/writes/${first?.id}/revise`)
    expect(res.status).toBe(200)
    const out = await data<{ approval_item_id: string; route?: string }>(res)
    expect(out.approval_item_id).not.toBe(staged.approval_item_id)
    expect(out.route).toBeUndefined()
    const card = await server.txn.approvals.get(out.approval_item_id)
    expect(card?.state).toBe('pending')
    expect(card?.links.supersedes).toBe(staged.approval_item_id)
    expect(card?.payload).toMatchObject({
      form: 'reddit_write',
      body: { text },
      desk: 'workshop',
      revises: { approval_item_id: staged.approval_item_id, job_id: first?.id },
    })
    // 工坊里审（卡片流里看得到，不是「插件里 N 条等你发」）
    expect(isPluginDeskCard(card as never)).toBe(false)
    const rows = (await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes')))
      .rows
    expect(rows[0]).toMatchObject({ revised_to: out.approval_item_id })
    expect(redditWriteNotices(rows, new Date(t).toISOString())).toEqual([])
    // 还原过的那一条不能再「再填一次」
    expect((await post(`/v1/social/reddit/writes/${first?.id}/refill`)).status).toBe(409)

    // 卡上改字、批 → 过了取消窗口施行 → 插件（ego 关着）
    const edited = 'Hi Alice, IVRA here. Try the anti-fog insert that ships in the box.'
    const payload = card?.payload as RedditWritePayload
    await decide(out.approval_item_id, { ...payload, body: { ...payload.body, text: edited } })
    t += 125_000
    expect(await b.redditWrites.sweep()).toBe(1)
    const again = await openAwaiting()
    expect(again?.approval_id).toBe(out.approval_item_id)
    expect(again?.plan.allow.values).toEqual([edited])
    const entry = (await brand()).redditWrites
      .writes()
      .find((w) => w.approval_item_id === out.approval_item_id)
    expect(entry).toMatchObject({ state: 'filling' })
  })

  it('「再填一次」：ego 能用就工坊在 ego 里发（via ego），不交插件；读回记「已发」', async () => {
    const b = await brand()
    await b.adsActions?.next(['reddit'], 0)
    const text = 'Hi Alice, IVRA here.'
    const staged = await data<{ approval_item_id: string }>(
      await post('/v1/social/reddit/stage', { target: replyTarget, text }),
    )
    await decide(staged.approval_item_id)
    t += 125_000
    await b.redditWrites.sweep()
    const first = await openAwaiting()
    b.adsActions?.result(first?.id as string, {
      outcome: 'handover',
      message: 'Chrome 里的 Reddit 没登录（或登录掉了）。',
      step: 1,
      reads: {},
    })
    ego.on = true
    const res = await post(`/v1/social/reddit/writes/${first?.id}/refill`)
    expect(res.status).toBe(200)
    const view = await data<RedditWriteView>(res)
    expect(view).toMatchObject({ state: 'queued', route: 'ego', refills: 1 })
    await b.redditWrites.idle()
    expect(ego.calls).toHaveLength(1)
    expect(ego.calls[0]).toMatchObject({ platform: 'reddit-reply', text })
    const rows = (await data<{ rows: RedditWriteView[] }>(await api('/v1/social/reddit/writes')))
      .rows
    expect(rows[0]).toMatchObject({ state: 'sent', route: 'ego' })
    // 插件那边没有等你发的
    expect(rows.filter((r) => r.state === 'awaiting')).toHaveLength(0)
  })

  it('找不到那一条：409 照实说', async () => {
    expect((await post('/v1/social/reddit/writes/rdw_nope/revise')).status).toBe(409)
  })
})
