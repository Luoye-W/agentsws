/**
 * WP467（Luoye 10-22 Windows 真机）：Reddit「填入」就在原帖页里填——服务端这一半（真服务进程、落盘、stub；
 * 插件那一侧用替身直接调接口，**不起浏览器、不连 Reddit**；真浏览器那一段在 `scripts/e2e-wp413-sidepanel.mjs`）。
 *
 * 1. 侧边栏的写带上帖子 id / 回的那条评论（插件按它找用户已经开着的原帖页、认人自己发出去的那一条）；
 * 2. 人自己发出去了（插件在原帖页认出来的 / 贴链接 / 认最近一条）→ 核过回写「已记录」：错帖不记、帖子链接不算、
 *    认出来的要文本相近、同一条不记两次；插件那一件正在等你点发送的收掉；
 * 3. 老的那一件（WP445 之前排的，可能写着 old.reddit）人点「填入」时按现在的写法重新拼。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionJob, PanelSnapshot } from '@agentsws/browser-action'
import type { Assignment, OutboundRecord } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-21T09:00:00.000Z')
const EXT_ORIGIN = 'chrome-extension://mlbfinfiigagllemohnopbhfdghagijg'
let t = T0
let server: Server
let dir: string
let reddit: Assignment

const call = async (path: string, init: RequestInit & { plugin?: string; owner?: true } = {}) => {
  const headers = new Headers(init.headers)
  if (init.plugin !== undefined) {
    headers.set('Origin', EXT_ORIGIN)
    if (init.plugin !== '') headers.set('Authorization', `Bearer ${init.plugin}`)
  } else {
    headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
    headers.set(
      'X-Assignment',
      init.owner === true ? server.bootstrap.ownerAssignment.id : reddit.id,
    )
  }
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(new Request(`http://127.0.0.1${path}`, { ...init, headers }))
}
const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

const replyTarget = {
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: 't1_c1',
  permalink: '/r/ivraxr/comments/abc/slug/c1/',
  post_title: 'Does the Air3 work with glasses?',
  parent_author: 'alice',
  parent_text: 'Mine fogs up a bit when I wear glasses.',
  inbox_type: 'comment_reply',
}
const DRAFT = 'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses.'

const brand = () => server.brands.forWorkspace(server.bootstrap.workspace.id)

async function pairPlugin(): Promise<string> {
  const made = await data<{ code: string }>(
    await call('/v1/extension/pairings', { method: 'POST', body: '{}', owner: true }),
  )
  const issued = await data<{ token: string }>(
    await call('/v1/extension/pair', {
      method: 'POST',
      plugin: '',
      body: JSON.stringify({ code: made.code }),
    }),
  )
  return issued.token
}

/** 出卡 → 在工坊里点「发送」（批）→ 过取消窗口施行。回卡 id。 */
async function stageAndSend(text = DRAFT): Promise<string> {
  const staged = await data<{ staged: boolean; approval_item_id: string; message?: string }>(
    await call('/v1/social/reddit/stage', {
      method: 'POST',
      body: JSON.stringify({ target: { ...replyTarget }, text, reason: '在问戴眼镜能不能用' }),
    }),
  )
  expect(staged.staged, staged.message).toBe(true)
  const id = staged.approval_item_id
  const fresh = await server.txn.approvals.get(id)
  const token = fresh?.deliveries.find((d) => d.status === 'sent')?.decision_token as string
  await server.txn.approvals.decide(id, server.bootstrap.person.id, {
    action: 'approve',
    decision_token: token,
    via: 'workstation',
  })
  t += 125_000
  expect(await (await brand()).redditWrites.sweep()).toBe(1)
  return id
}

const snapshot = (token: string) =>
  call('/v1/extension/panel', { plugin: token }).then((r) => data<PanelSnapshot>(r))

const boot = (ext: string) =>
  createServer({
    dbDir: dir,
    quiet: true,
    clock: { now: () => new Date(t).toISOString() },
    env: {
      [SECRETS_KEY_ENV]: 'e'.repeat(64),
      AGENTSWS_OWNER_EMAIL: 'owner@example.com',
      AGENTSWS_EXTENSION_DIR: ext,
      AGENTSWS_VERSION: '0.2.1-beta.5',
    },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: false,
  })

beforeEach(async () => {
  t = T0
  dir = mkdtempSync(join(tmpdir(), 'wp467-in-place-'))
  // 桌面版放插件的固定文件夹（里面是工坊带的那一版）
  const ext = join(dir, 'chrome-extension')
  mkdirSync(ext, { recursive: true })
  writeFileSync(
    join(ext, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.2.1', version_name: '0.2.1-beta.5' }),
  )
  server = await boot(ext)
  reddit = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
  ;(await brand()).redditWatch?.updateSettings({ brand_username: 'ivra_official' })
})
afterEach(async () => {
  await server?.close()
  rmSync(dir, { recursive: true, force: true })
})

const sent = (token: string, job: string, input: Record<string, unknown>) =>
  call(`/v1/extension/panel/writes/${job}/sent`, {
    method: 'POST',
    plugin: token,
    body: JSON.stringify(input),
  }).then(async (r) => ({
    status: r.status,
    body: await data<{ ok: boolean; message?: string }>(r),
  }))

describe('WP467 人自己在 Reddit 上发出去了，回写「已记录」', () => {
  it('侧边栏的写带上帖子 id 与回的那条评论（插件按它找开着的原帖页）', async () => {
    const token = await pairPlugin()
    await stageAndSend()
    const w = (await snapshot(token)).writes[0]
    expect(w).toMatchObject({ target_post: 'abc', target_parent: 't1_c1', kind: 'reply' })
  })

  it('贴链接：错帖不记、帖子链接不算、对的那一条记上（发出记录带编号与链接）；再记一次不算错；同一条不能记给两条草稿', async () => {
    const token = await pairPlugin()
    const id = await stageAndSend()
    const job = (await snapshot(token)).writes[0]?.job_id as string
    const wrong = await sent(token, job, {
      how: 'link',
      permalink: 'https://www.reddit.com/r/ivraxr/comments/zzz/other/new9/',
    })
    expect(wrong.body).toMatchObject({
      ok: false,
      message: expect.stringContaining('不是这个帖子里的'),
    })
    const postOnly = await sent(token, job, {
      how: 'link',
      permalink: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/',
    })
    expect(postOnly.body).toMatchObject({
      ok: false,
      message: expect.stringContaining('评论自己的链接'),
    })
    const okLink = await sent(token, job, {
      how: 'link',
      permalink: 'https://www.reddit.com/r/ivraxr/comments/abc/comment/new1/?utm_source=share',
    })
    expect(okLink.body.ok, okLink.body.message).toBe(true)
    const records = await data<OutboundRecord[]>(await call('/v1/outbound/records'))
    expect(records[0]).toMatchObject({
      approval_item_id: id,
      external_id: 't1_new1',
      link: 'https://www.reddit.com/r/ivraxr/comments/abc/comment/new1/',
      content: DRAFT,
    })
    const snap = await snapshot(token)
    expect(snap.writes[0]).toMatchObject({ state: 'sent' })
    expect(snap.progress).toMatchObject({ sent_today: 1, awaiting: 0 })
    expect(
      (await sent(token, job, { how: 'link', permalink: '/r/ivraxr/comments/abc/comment/new1/' }))
        .body.ok,
    ).toBe(true)
    // 第二条草稿：拿同一条去记，不行
    t += 60_000
    await stageAndSend('Another draft for the same thread, about the insert.')
    const second = (await snapshot(token)).writes.find((x) => x.state === 'awaiting')
      ?.job_id as string
    const dup = await sent(token, second, {
      how: 'link',
      permalink: '/r/ivraxr/comments/abc/comment/new1/',
    })
    expect(dup.body).toMatchObject({ ok: false, message: expect.stringContaining('另一条草稿') })
    // 别人的 / 没有的那一条 404
    expect(
      (await sent(token, 'rdw_nope', { how: 'link', permalink: '/r/x/comments/abc/comment/q1/' }))
        .status,
    ).toBe(404)
  })

  it('插件在原帖页认出来的：字和草稿差太多不记；相近的记上，按真发出去的字记、改了多少进学习回路', async () => {
    const token = await pairPlugin()
    await stageAndSend()
    const job = (await snapshot(token)).writes[0]?.job_id as string
    const far = await sent(token, job, {
      how: 'seen',
      permalink: '/r/ivraxr/comments/abc/comment/new2/',
      fullname: 't1_new2',
      text: 'Totally unrelated words about pricing in Japan.',
      author: 'ivra_official',
    })
    expect(far.body).toMatchObject({ ok: false, message: expect.stringContaining('差太多') })
    const PASTED =
      'Hi Alice, IVRA here. The anti-fog insert in the box helps a lot with glasses. Enjoy!'
    const near = await sent(token, job, {
      how: 'seen',
      permalink: '/r/ivraxr/comments/abc/comment/new2/',
      fullname: 't1_new2',
      text: PASTED,
      author: 'ivra_official',
    })
    expect(near.body.ok, near.body.message).toBe(true)
    const records = await data<OutboundRecord[]>(await call('/v1/outbound/records'))
    expect(records[0]).toMatchObject({
      content: PASTED,
      draft_content: DRAFT,
      external_id: 't1_new2',
    })
    const rows = await data<{ rows: { pasted?: boolean; sent_text?: string }[] }>(
      await call('/v1/social/reddit/writes'),
    )
    expect(rows.rows[0]).toMatchObject({ pasted: true, sent_text: PASTED })
  })

  it('插件正在填、等你点发送时你自己记了：那一件收掉（不会两边都记）', async () => {
    const token = await pairPlugin()
    await stageAndSend()
    const w = (await snapshot(token)).writes[0]
    const opened = await data<{ ok: boolean; job?: ActionJob }>(
      await call(`/v1/extension/panel/writes/${w?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    const job = opened.job as ActionJob
    const b = await brand()
    expect(
      b.adsActions?.progress(job.id, { step: 7, of: 8, label: '填好了，等你点发送' }),
    ).toMatchObject({ stop: false })
    const out = await sent(token, job.id, {
      how: 'link',
      permalink: '/r/ivraxr/comments/abc/comment/new3/',
    })
    expect(out.body.ok).toBe(true)
    expect(
      b.adsActions?.progress(job.id, { step: 8, of: 8, label: '填好了，等你点发送' }),
    ).toMatchObject({ stop: true })
  })

  it('老的那一件（WP445 之前排的、可能写着 old.reddit）：人点「填入」时按现在的写法重新拼一件，字不变', async () => {
    const token = await pairPlugin()
    await stageAndSend()
    const before = (await snapshot(token)).writes[0]?.job_id as string
    // 模拟老进度：落盘那一份没有「第几版写法」
    await server.close()
    const find = (d: string): string | undefined => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name)
        if (e.isDirectory()) {
          const hit = find(p)
          if (hit !== undefined) return hit
        } else if (p.endsWith(join('reddit-writes', 'state.json'))) return p
      }
      return undefined
    }
    const file = find(dir) as string
    const state = JSON.parse(readFileSync(file, 'utf8')) as { entries: { plan_v?: number }[] }
    for (const e of state.entries) delete e.plan_v
    writeFileSync(file, JSON.stringify(state))
    server = await boot(join(dir, 'chrome-extension'))
    const opened = await data<{ ok: boolean; job?: ActionJob; message?: string }>(
      await call(`/v1/extension/panel/writes/${before}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    expect(opened.ok, opened.message).toBe(true)
    const job = opened.job as ActionJob
    expect(job.id).not.toBe(before)
    expect(job.plan.allow.values).toEqual([DRAFT])
    expect(job.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
      post: 'abc',
    })
  })
})
