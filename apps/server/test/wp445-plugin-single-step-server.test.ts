/**
 * WP445（决策 1322–1324，Luoye 10-21）：Reddit 的**审与发都在插件里一步完成**——真服务进程、落盘、stub；
 * 插件那一侧用替身直接调接口（**不起浏览器、不连 Reddit**；真浏览器那一段在 `scripts/e2e-wp413-sidepanel.mjs`）。
 *
 * 1. AI 起草 → **工坊不出卡**（岗位牌堆里没有、品牌一览不算待审）→ 直接进插件「等你发」：插件快照里有它、
 *    看板上「插件里 N 条等你发」、铃铛「等你发」一条；
 * 2. 插件里改字点「打开这一条」= 批（`via: 'extension'`、改过记 `approve_edited`）+ 拿到那一件 → 人点发送 → 读回 →
 *    发出记录、学习回路、看板数字归零、铃铛收成已读；
 * 3. 「不发 + 理由」：卡驳回（理由进学习回路）；**写了理由才跟随同类**（同一串里的另外两张一并不发）、能撤回；
 *    没写理由只不发这一张；
 * 4. 老卡（WP445 之前出的、没标 `desk`、落在本人身上）照样算插件里那一种（迁移不用动数据）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ActionJob, PanelSnapshot } from '@agentsws/browser-action'
import type { Assignment, NotificationList, OutboundRecord } from '@agentsws/contracts'
import { isPluginDeskCard } from '@agentsws/contracts'
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

const target = (c: string, author: string, text: string) => ({
  kind: 'reply',
  subreddit: 'ivraxr',
  parent_fullname: `t1_${c}`,
  permalink: `/r/ivraxr/comments/abc/slug/${c}/`,
  post_title: 'Does the Air3 work with glasses?',
  parent_author: author,
  parent_text: text,
  inbox_type: 'comment_reply',
})
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

/** AI 起草好的一条交进来（与巡查自动起草同一个口：`stage`）。回卡 id。 */
async function stage(c = 'c1', author = 'alice', text = DRAFT, quote = 'Mine fogs up a bit.') {
  const staged = await data<{ staged: boolean; approval_item_id: string; message?: string }>(
    await call('/v1/social/reddit/stage', {
      method: 'POST',
      body: JSON.stringify({
        target: target(c, author, quote),
        text,
        reason: '在问戴眼镜能不能用',
      }),
    }),
  )
  expect(staged.staged, staged.message).toBe(true)
  return staged.approval_item_id
}

const snapshot = (token: string) =>
  call('/v1/extension/panel', { plugin: token }).then((r) => data<PanelSnapshot>(r))

const inPlugin = async () =>
  (await data<{ in_plugin?: number }>(await call('/v1/social/reddit/writes'))).in_plugin

beforeEach(async () => {
  t = T0
  dir = mkdtempSync(join(tmpdir(), 'wp445-desk-'))
  const ext = join(dir, 'chrome-extension')
  mkdirSync(ext, { recursive: true })
  writeFileSync(
    join(ext, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, version: '0.2.1', version_name: '0.2.1-beta.5' }),
  )
  server = await createServer({
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

describe('WP445 审与发在插件里一步完成', () => {
  it('AI 起草 → 工坊不出卡 → 插件「等你发」→ 改字打开（= 批）→ 人点发送 → 读回 → 记录 / 学习 / 看板数字', async () => {
    const token = await pairPlugin()
    const id = await stage()

    // ① 工坊不出卡：卡标「插件里审」，岗位牌堆里没有、品牌一览不算待审
    const card = await server.txn.approvals.get(id)
    expect(card?.payload).toMatchObject({ form: 'reddit_write', desk: 'plugin' })
    expect(card !== undefined && isPluginDeskCard(card)).toBe(true)
    const deck = await call(`/v1/positions/${reddit.id}/cards`)
    expect(deck.status).toBe(200)
    expect(JSON.stringify(await data(deck))).not.toContain(id)
    // 看板上一行：插件里 1 条等你发
    expect(await inPlugin()).toBe(1)
    // 铃铛「等你发」一条（告诉发起人）
    await server.notifications.flush()
    const bell = await data<NotificationList>(await call('/v1/notifications?view=unread'))
    expect(bell.items.filter((n) => n.category === 'outbound')).toHaveLength(1)
    expect(bell.items.some((n) => n.text.includes('等你批'))).toBe(false)

    // ② 插件「等你发」里有它：原帖、被回的那句、为什么回、草稿全文；顶上等你发 1 条
    const snap = await snapshot(token)
    expect(snap.cards).toHaveLength(1)
    expect(snap.cards[0]).toMatchObject({
      id,
      kind: 'reply',
      post_title: 'Does the Air3 work with glasses?',
      parent_author: 'alice',
      reason: '在问戴眼镜能不能用',
      draft: { text: DRAFT },
    })
    expect(snap.progress.awaiting).toBe(1)
    // 插件的定时领活领不到任何东西（没人点，什么页面都不开）
    expect((await (await brand()).adsActions?.next(['reddit'], 0))?.job).toBeUndefined()

    // ③ 改了字点「打开这一条」：批（插件里批，改过记 approve_edited）+ 交给插件那一件
    const SIDE = 'Hi Alice, the Air3 fits over most prescription frames, and the insert helps.'
    const filled = await data<{ ok: boolean; write?: { job_id: string; state: string } }>(
      await call(`/v1/extension/panel/cards/${id}/fill`, {
        method: 'POST',
        plugin: token,
        body: JSON.stringify({ text: SIDE, version: snap.cards[0]?.version }),
      }),
    )
    expect(filled.ok).toBe(true)
    expect(filled.write?.state).toBe('awaiting')
    const decided = await server.txn.approvals.get(id)
    expect(decided?.decision).toMatchObject({ via: 'extension', action: 'approve_edited' })
    const opened = await data<{ ok: boolean; job?: ActionJob; message?: string }>(
      await call(`/v1/extension/panel/writes/${filled.write?.job_id}/open`, {
        method: 'POST',
        plugin: token,
        body: '{}',
      }),
    )
    expect(opened.ok, opened.message).toBe(true)
    const job = opened.job as ActionJob
    expect(job.plan.allow.values).toEqual([SIDE])
    expect(job.plan.steps[0]).toMatchObject({
      op: 'goto',
      url: 'https://www.reddit.com/r/ivraxr/comments/abc/slug/c1/',
      // WP467：带上帖子 id（已经开着这个帖子就地填）
      post: 'abc',
    })
    // 发送按钮不在白名单里（人点）
    expect(JSON.stringify(job.plan.allow.click)).not.toMatch(/submit|save|comment-submit/iu)
    // 插件里那一张没了、看板还算一条（等你在页面上点发送之前都算）
    const mid = await snapshot(token)
    expect(mid.cards).toHaveLength(0)

    // ④ 人在页面上点了发送 → 读回
    ;(await brand()).adsActions?.result(job.id, {
      outcome: 'done',
      message: '做完了。',
      step: 6,
      reads: {
        fullname: 't1_new1',
        permalink: '/r/ivraxr/comments/abc/comment/new1/',
        sent_text: SIDE,
      },
    })
    const records = await data<OutboundRecord[]>(await call('/v1/outbound/records'))
    expect(records[0]).toMatchObject({
      content: SIDE,
      external_id: 't1_new1',
      approval_item_id: id,
      approved_via: 'extension',
    })
    expect(await inPlugin()).toBe(0)
    const done = await snapshot(token)
    expect(done.progress).toMatchObject({ sent_today: 1, awaiting: 0 })
    // 改动进学习回路（插件里改了再批 = 「改了再批」那一条路）
    const pooled = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'lesson.pooled')
    expect(pooled.length).toBeGreaterThan(0)
    await server.notifications.flush()
    const after = await data<NotificationList>(await call('/v1/notifications?view=unread'))
    expect(after.items.some((n) => n.category === 'outbound')).toBe(false)
  })

  it('不发：没写理由只不发这一张；写了理由 → 同类的一并不发（能撤回）、理由进学习回路', async () => {
    const token = await pairPlugin()
    const a = await stage(
      'c1',
      'alice',
      'Hi Alice, the insert helps with fog.',
      'Fogs up with glasses.',
    )
    const b = await stage(
      'c2',
      'bob',
      'Hi Bob, the insert helps with fog.',
      'Fogs up with glasses too.',
    )
    const c = await stage(
      'c3',
      'carol',
      'Hi Carol, the insert helps with fog.',
      'Same fog problem here.',
    )
    const lone = await stage('c4', 'dan', 'Hi Dan, thanks!', 'Love it.')
    expect(await inPlugin()).toBe(4)

    // 没写理由：只不发这一张
    const plain = await call(`/v1/extension/panel/cards/${lone}/skip`, {
      method: 'POST',
      plugin: token,
      body: '{}',
    })
    expect(await data(plain)).toEqual({ ok: true })
    expect((await server.txn.approvals.get(lone))?.state).toBe('rejected')
    expect((await server.txn.approvals.get(a))?.state).toBe('pending')

    // 写了理由：AI 按理由判同类（stub 走剧本：同一个帖子、同一话题），一并不发
    const skipped = await data<{
      ok: boolean
      followed?: { leader_id: string; ids: string[]; titles: string[] }
    }>(
      await call(`/v1/extension/panel/cards/${a}/skip`, {
        method: 'POST',
        plugin: token,
        body: JSON.stringify({ reason: '不相关' }),
      }),
    )
    expect(skipped.ok).toBe(true)
    const leader = await server.txn.approvals.get(a)
    expect(leader?.state).toBe('rejected')
    expect(leader?.decision).toMatchObject({ via: 'extension', reason: '不相关' })
    const followed = skipped.followed?.ids ?? []
    expect(followed.length).toBeGreaterThan(0)
    expect(followed.every((x) => x === b || x === c)).toBe(true)
    for (const f of followed)
      expect((await server.txn.approvals.get(f))?.decision?.followed?.leader_id).toBe(a)
    // 理由进学习回路（驳回带理由）
    const rejected = server.kernel.eventLog
      .readSync({ workspace_id: server.bootstrap.workspace.id })
      .filter((e) => e.type === 'approval.decided' && e.payload?.reason === '不相关')
    expect(rejected.length).toBeGreaterThan(0)

    // 撤回：那几张回到「等你发」
    const undo = await data<{ restored: number }>(
      await call(`/v1/extension/panel/cards/${a}/follow/undo`, {
        method: 'POST',
        plugin: token,
        body: JSON.stringify({ ids: followed }),
      }),
    )
    expect(undo.restored).toBe(followed.length)
    const back = await snapshot(token)
    expect(back.cards.map((x) => x.id).sort()).toEqual([b, c].sort())
    expect(await inPlugin()).toBe(2)
    // 别人的 / 不存在的卡：404
    const nope = await call('/v1/extension/panel/cards/ap_nope/skip', {
      method: 'POST',
      plugin: token,
      body: '{}',
    })
    expect(nope.status).toBe(404)
  })

  it('老卡迁移：WP445 之前出的卡（没标 desk、落在本人身上）照样在插件「等你发」里、工坊不出', async () => {
    const token = await pairPlugin()
    const id = await stage()
    // 抹掉 desk 那一格，模拟 WP445 之前出的卡
    const item = server.txn.runtime.store.getApproval(id)
    if (item === undefined) throw new Error('卡没了')
    const { desk: _d, ...payload } = item.payload as Record<string, unknown>
    server.txn.runtime.store.putApproval({ ...item, payload })
    const old = server.txn.runtime.store.getApproval(id)
    expect((old?.payload as { desk?: string } | undefined)?.desk).toBeUndefined()
    expect(old !== undefined && isPluginDeskCard(old)).toBe(true)
    expect((await snapshot(token)).cards.map((c) => c.id)).toEqual([id])
    expect(
      JSON.stringify(await data(await call(`/v1/positions/${reddit.id}/cards`))),
    ).not.toContain(id)
  })
})
