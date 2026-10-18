/**
 * WP419（自查 R10 / S3 / S4）：社媒发帖与 Reddit 起草四个工具，接真服务里的巡查 / Reddit 写 / 社媒那一份
 * （替身插件读替身 Reddit JSON；不连真 Reddit、不调模型）。
 *
 * - 「有哪些评论等着回」：列出巡查里等着回的，给某一条出回复卡（卡出了那一条变「卡已出」）；
 * - 「在这个版里发一条」：没有要点不出卡；带要点出一张发新帖卡（卡上带版规）；
 * - 「排下周的内容 / 起草一条」：没登记号照实说；登记了出「发布」卡、撞车写在卡上；IG 纯文字不出卡（要素材）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type RedditFetched, runRedditRead } from '@agentsws/browser-action'
import type { RunRequest } from '@agentsws/contracts'
import {
  LIST_REDDIT_PENDING_TOOL,
  LIST_SOCIAL_POSTS_TOOL,
  type RedditPendingData,
  type SocialPostsData,
  STAGE_REDDIT_WRITE_TOOL,
  STAGE_SOCIAL_POST_TOOL,
  type StagedData,
} from '@agentsws/stand-ins'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'
import { createSocialToolExecutor } from '../src/social-tools.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-15T09:00:00.000Z')
const NOW_S = Math.floor(T0 / 1000)
let server: Server
let dir: string

const listing = (children: unknown[]) => ({ kind: 'Listing', data: { after: null, children } })
const ROUTES: Record<string, unknown> = {
  '/api/me.json': { kind: 't2', data: { name: 'ivra_official' } },
  '/message/inbox/.json': listing([
    {
      kind: 't1',
      data: {
        id: 'c9',
        name: 't1_c9',
        type: 'comment_reply',
        author: 'alice',
        body: 'does it work with iPhone?',
        subreddit: 'ivraxr',
        link_id: 't3_post1',
        parent_id: 't1_o1',
        link_title: 'Air3 setup tips',
        permalink: '/r/ivraxr/comments/post1/air3_setup/c9/',
        created_utc: NOW_S - 600,
      },
    },
  ]),
}
const fakeFetch = async (url: string): Promise<RedditFetched> => {
  const path = new URL(url).pathname
  const body = ROUTES[path] ?? (/\.json$/u.test(path) ? listing([]) : undefined)
  return body === undefined
    ? { status: 404, url, content_type: 'application/json', body: '{}' }
    : { status: 200, url, content_type: 'application/json', body: JSON.stringify(body) }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp419-tools-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(T0).toISOString() },
    env: { [SECRETS_KEY_ENV]: 'e'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const assign = (role_id: string) =>
  server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id,
  })

async function tools() {
  const brand = await server.brands.forWorkspace(server.bootstrap.workspace.id)
  const exec = createSocialToolExecutor({
    redditWatch: () => brand.redditWatch,
    redditWrites: () => brand.redditWrites,
    social: () => brand.socialService.port,
    now: () => new Date(T0).toISOString(),
  })
  const call = async <T>(
    name: string,
    input: Record<string, unknown>,
    a: { id: string; role_id: string },
  ) => {
    const res = await exec({
      name,
      input,
      request: {
        id: 'run_1',
        workspace_id: server.bootstrap.workspace.id,
        actor: { person_id: server.bootstrap.person.id, assignment_id: a.id, role_id: a.role_id },
      } as unknown as RunRequest,
    })
    return res as { status: string; data?: T; reason?: string }
  }
  return { brand, call }
}

describe('WP419 Reddit：有哪些等着回 → 出回复卡；发一条要带要点', () => {
  it('一整圈', async () => {
    const ws = server.bootstrap.workspace.id
    const a = assign('pr.reddit')
    const { brand, call } = await tools()
    const rw = brand.redditWatch
    if (rw === undefined || brand.redditPersona === undefined) throw new Error('没装')
    brand.redditPersona.set({ stance: 'team' })
    // 巡查读一轮（插件在线：先读收件箱 / 自家版块，再读整串）；口吻定了，巡查自己会先出一张
    rw.updateSettings({ own_subreddits: ['ivraxr'], brand_username: 'ivra_official' })
    for (let i = 0; i < 6; i += 1) {
      let got = rw.next({ connected: true })
      if (got.job === undefined && i === 0) {
        await rw.runNow()
        got = rw.next({ connected: true })
      }
      if (got.job !== undefined)
        await rw.result(
          got.job.id,
          await runRedditRead(got.job, {
            fetch: fakeFetch,
            sleep: async () => {},
            stopped: () => false,
            gapMs: 0,
          }),
        )
      await sleep(20)
    }
    const listed = await call<RedditPendingData>(LIST_REDDIT_PENDING_TOOL, {}, a)
    expect(listed.status).toBe('ok')
    const row = listed.data?.rows.find((r) => r.author === 'alice')
    expect(row?.text).toContain('iPhone')
    expect(row?.link).toBe('https://www.reddit.com/r/ivraxr/comments/post1/air3_setup/c9/')

    // 卡已经由巡查自动出了 → 再要一次照实说「卡已经出了」；别的职责调不了
    let cardOut = row?.state === 'card_out'
    for (let i = 0; i < 50 && !cardOut; i += 1) {
      await sleep(40)
      cardOut =
        (await call<RedditPendingData>(LIST_REDDIT_PENDING_TOOL, {}, a)).data?.rows.find(
          (r) => r.author === 'alice',
        )?.state === 'card_out'
    }
    expect(cardOut).toBe(true)
    const again = await call<StagedData>(
      STAGE_REDDIT_WRITE_TOOL,
      { mode: 'reply', item_id: row?.item_id },
      a,
    )
    expect(again.data).toMatchObject({ staged: false })
    expect(again.data?.message).toContain('已经出了')
    const blocked = await call(
      LIST_REDDIT_PENDING_TOOL,
      {},
      { id: a.id, role_id: 'social.facebook' },
    )
    expect(blocked.status).toBe('blocked')

    // 把那张卡驳回、条目放回「开着」→ AI 给它出回复卡
    const drafts = () =>
      server.txn.runtime.store
        .listApprovals({ workspace_id: ws, kind: 'outbound_draft' })
        .filter((c) => (c.payload as { form?: string }).form === 'reddit_write')
    const first = drafts()[0]
    expect(first).toBeDefined()
    rw.setStatus(row?.item_id ?? '', 'open')
    const staged = await call<StagedData>(
      STAGE_REDDIT_WRITE_TOOL,
      { mode: 'reply', item_id: row?.item_id },
      a,
    )
    expect(staged.data?.staged).toBe(true)
    expect(drafts()).toHaveLength(2)
    expect(rw.items({ reply: true }).find((x) => x.id === row?.item_id)?.status).toBe('drafting')

    // 发新帖：没要点不出卡；带要点出卡（标题按要点第一句、卡上写着你说的要点）
    const noPoints = await call<StagedData>(STAGE_REDDIT_WRITE_TOOL, { mode: 'post' }, a)
    expect(noPoints.data).toMatchObject({ staged: false })
    expect(noPoints.data?.message).toContain('要点')
    const post = await call<StagedData>(
      STAGE_REDDIT_WRITE_TOOL,
      { mode: 'post', points: 'Firmware 2.2 is out. Fixes the battery drain from 2.1.' },
      a,
    )
    expect(post.data, post.data?.message).toMatchObject({ staged: true })
    const card = drafts().find((c) => c.id === post.data?.approval_item_id)
    expect(card?.payload).toMatchObject({
      reddit: { kind: 'submit', subreddit: 'ivraxr' },
      body: { subject: expect.stringContaining('Firmware 2.2 is out') },
    })
    expect(String((card?.payload as { reason?: string } | undefined)?.reason)).toContain(
      'Firmware 2.2',
    )
    expect(card?.role_id).toBe('pr.reddit')
  })
})

describe('WP419 社媒：排下周 / 起草一条出「发布」卡', () => {
  it('没登记号照实说；登记了出卡、撞车写在卡上；IG 纯文字不出卡', async () => {
    const fb = assign('social.facebook')
    const ig = assign('social.instagram')
    const { brand, call } = await tools()
    const empty = await call<SocialPostsData>(LIST_SOCIAL_POSTS_TOOL, {}, fb)
    expect(empty.data?.accounts).toHaveLength(0)
    expect(empty.data?.note).toContain('还没登记')
    const none = await call<StagedData>(STAGE_SOCIAL_POST_TOOL, { body: 'hello' }, fb)
    expect(none.data).toMatchObject({ staged: false })

    const actor = (asg: { id: string; role_id: string }) => ({
      workspace_id: server.bootstrap.workspace.id,
      person_id: server.bootstrap.person.id,
      assignment_id: asg.id,
      role_id: asg.role_id,
    })
    await brand.socialService.port.createAccount(actor(fb) as never, {
      channel: 'facebook',
      handle: 'nordvolt',
      display_name: 'Nordvolt',
      url: 'https://www.facebook.com/nordvolt',
      external_id: '1001',
    })
    await brand.socialService.port.createAccount(actor(ig) as never, {
      channel: 'instagram',
      handle: 'nordvolt',
      display_name: 'Nordvolt IG',
      url: 'https://www.instagram.com/nordvolt',
      external_id: '2001',
    })
    const at = '2026-10-19T02:00:00.000Z'
    const one = await call<StagedData>(
      STAGE_SOCIAL_POST_TOOL,
      { body: 'Weekend camping checklist: what we pack.', scheduled_at: at },
      fb,
    )
    expect(one.data).toMatchObject({ staged: true, scheduled_at: at })
    // 同一个号同一时刻再排一条 → 撞车写在卡上
    const two = await call<StagedData>(
      STAGE_SOCIAL_POST_TOOL,
      { body: 'Another post at the same time.', scheduled_at: at },
      fb,
    )
    expect(two.data?.conflicts?.length ?? 0).toBeGreaterThan(0)
    const cal = await call<SocialPostsData>(LIST_SOCIAL_POSTS_TOOL, {}, fb)
    expect(cal.data?.posts.length).toBe(2)
    // IG 纯文字：不出卡，说要素材
    const igText = await call<StagedData>(STAGE_SOCIAL_POST_TOOL, { body: 'no media' }, ig)
    expect(igText.data).toMatchObject({ staged: false })
    expect(igText.data?.message).toContain('图片或视频')
    const igMedia = await call<StagedData>(
      STAGE_SOCIAL_POST_TOOL,
      { body: 'with media', media_refs: ['asset_1'], scheduled_at: at },
      ig,
    )
    expect(igMedia.data?.staged).toBe(true)
  })
})
