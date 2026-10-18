/**
 * WP414 端到端（真服务进程 + 替身 Reddit 回信卡；不连真 Reddit、不起浏览器）：
 *
 * 外部版块 r/Smartphones 里三张同类的「发出去」卡（换手机的帖子，AI 判断都是「和我们无关」）+
 * 一张自家版块的正常回复卡：
 *
 * 1. 否掉第一张（**不写理由**，一下生效）→ 同类的另外两张自动「不发」，每张决定上写着为什么算同类；
 *    自家版块那张不动；账本里有一条 `approval.followed`；
 * 2. 事后补一句理由 → 带头那张与跟着的两张都补上；
 * 3. 撤回 → 那两张回到待处理（能再批），带头那张保持「不发」；
 * 4. 「发送」同类卡：只列回「要一起发吗」，一张都不自动发。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { similarTo } from '../src/card-follow.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const T0 = Date.parse('2026-10-19T09:00:00.000Z')
let server: Server
let dir: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'wp414-follow-'))
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

const OFF_TOPIC = '换手机的帖子，和我们的智能眼镜无关，回了也没价值'

async function setup(): Promise<{ asg: string; ids: string[]; own: string }> {
  const ws = server.bootstrap.workspace.id
  const person_id = server.bootstrap.person.id
  const asg = server.roles.assignments.create({
    person_id,
    workspace_id: ws,
    granted_by: person_id,
    ranges: [{ kind: 'store' as const, id: 'store_1' }],
    role_id: 'social.reddit',
  })
  const brand = await server.brands.forWorkspace(ws)
  const actor = { workspace_id: ws, person_id, assignment_id: asg.id, role_id: 'social.reddit' }
  const stage = async (
    sub: string,
    post: string,
    author: string,
    title: string,
    reason: string,
  ): Promise<string> => {
    const out = await brand.redditWrites.stage(actor as never, {
      target: {
        kind: 'comment',
        subreddit: sub,
        parent_fullname: `t3_${post}`,
        permalink: `/r/${sub}/comments/${post}/x/`,
        post_title: title,
        parent_author: author,
      },
      text: `Thanks for sharing, ${author}.`,
      reason,
    })
    if (!out.staged) throw new Error(out.message)
    return out.approval_item_id
  }
  const ids = [
    await stage(
      'Smartphones',
      'p1',
      'alice',
      'Switching from Pixel to iPhone, worth it?',
      OFF_TOPIC,
    ),
    await stage(
      'Smartphones',
      'p2',
      'bob',
      'Which phone has the best battery this year?',
      OFF_TOPIC,
    ),
    await stage('Smartphones', 'p3', 'cat', 'Upgrading my old Galaxy, need advice', OFF_TOPIC),
  ]
  const own = await stage(
    'ivraxr',
    'p9',
    'dan',
    'Air3 captions keep lagging',
    '自家版块用户问字幕延迟，要回',
  )
  return { asg: asg.id, ids, own }
}

const call = async <T>(
  asg: string,
  path: string,
  body: unknown,
): Promise<{ status: number; data: T }> => {
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${server.bootstrap.internalToken}`,
        'X-Assignment': asg,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  )
  const json = (await res.json()) as { data: T }
  return { status: res.status, data: json.data }
}

const get = async (id: string): Promise<ApprovalItem> => {
  const item = await server.txn.approvals.get(id)
  if (item === undefined) throw new Error(`没有这张卡：${id}`)
  return item
}

interface Follow {
  action: string
  applied: { id: string; why: string; basis: string[] }[]
  suggested: { id: string }[]
}

describe('WP414 同类卡跟着前一个决定（替身 Reddit 回信卡）', () => {
  it('否掉第一张 → 后两张自动不发（自家版块那张不动）→ 补理由 → 撤回', async () => {
    const { asg, ids, own } = await setup()
    const [first, second, third] = ids as [string, string, string]

    // 1. 否掉第一张：不写理由，一下生效
    const out = await call<{ state: string; follow?: Follow }>(
      asg,
      `/v1/approvals/${first}/decide`,
      { action: 'reject' },
    )
    expect(out.status).toBe(200)
    expect(out.data.state).toBe('rejected')
    expect(out.data.follow?.applied.map((a) => a.id).sort()).toEqual([second, third].sort())
    for (const id of [second, third]) {
      const item = await get(id)
      expect(item.state).toBe('rejected')
      expect(item.decision?.via).toBe('batch')
      expect(item.decision?.followed?.leader_id).toBe(first)
      // 判断「同类」的理由写在每张被处理的卡上
      expect(item.decision?.followed?.why).toContain('r/Smartphones')
    }
    expect((await get(own)).state).toBe('pending')
    expect((await get(first)).decision?.reason).toBe('不要')

    // 2. 事后补理由（快捷理由 chip）
    const reason = await call<{ followers: number }>(asg, `/v1/approvals/${first}/reason`, {
      reason: '不相关',
      follower_ids: [second, third],
    })
    expect(reason.status).toBe(200)
    expect(reason.data.followers).toBe(2)
    expect((await get(first)).decision?.reason).toBe('不相关')
    expect((await get(second)).decision?.reason).toContain('不相关')

    // 3. 撤回：两张回到待处理，带头那张不动
    const undo = await call<{ restored: { id: string }[]; skipped: string[] }>(
      asg,
      `/v1/approvals/${first}/follow/undo`,
      { ids: [second, third] },
    )
    expect(undo.status).toBe(200)
    expect(undo.data.restored.map((r) => r.id).sort()).toEqual([second, third].sort())
    expect((await get(second)).state).toBe('pending')
    expect((await get(third)).state).toBe('pending')
    expect((await get(first)).state).toBe('rejected')

    // 撤回后的卡能照常再定
    const again = await call<{ state: string }>(asg, `/v1/approvals/${second}/decide`, {
      action: 'snooze',
    })
    expect(again.status).toBe(200)
  })

  it('「发送」：同类卡只列回「要一起发吗」，一张都不自动发', async () => {
    const { asg, ids } = await setup()
    const [first, second, third] = ids as [string, string, string]
    const out = await call<{ state: string; follow?: Follow }>(
      asg,
      `/v1/approvals/${first}/decide`,
      { action: 'approve' },
    )
    expect(out.status).toBe(200)
    expect(out.data.follow?.applied).toEqual([])
    expect(out.data.follow?.suggested.map((s) => s.id).sort()).toEqual([second, third].sort())
    expect((await get(second)).state).toBe('pending')
    expect((await get(third)).state).toBe('pending')
  })

  it('「稍后」：同类卡一并推迟', async () => {
    const { asg, ids, own } = await setup()
    const [first, second] = ids as [string, string]
    const out = await call<{ follow?: Follow }>(asg, `/v1/approvals/${first}/decide`, {
      action: 'snooze',
    })
    expect(out.data.follow?.applied).toHaveLength(2)
    expect((await get(second)).state).toBe('deferred')
    expect((await get(own)).state).toBe('pending')
  })
})

describe('similarTo（哪几张算同类）', () => {
  const card = (over: {
    id: string
    sub: string
    post: string
    reason?: string
    summary?: string
    form?: string
  }): ApprovalItem =>
    ({
      id: over.id,
      kind: 'outbound_draft',
      role_id: 'social.reddit',
      title: `回复 ${over.id}`,
      summary: over.summary ?? '',
      subject: { object: { type: 'external_post', id: `reddit:${over.id}` } },
      payload: {
        form: over.form ?? 'reddit_write',
        reddit: { subreddit: over.sub, permalink: `/r/${over.sub}/comments/${over.post}/x/` },
        ...(over.reason === undefined ? {} : { reason: over.reason }),
      },
    }) as unknown as ApprovalItem

  it('同一个帖子 → 同类', () => {
    const hit = similarTo(
      card({ id: 'a', sub: 'x', post: 'p1' }),
      card({ id: 'b', sub: 'x', post: 'p1' }),
    )
    expect(hit?.basis).toEqual(['same_object'])
  })

  it('同一来源但判断依据不同 → 不算（自家版块不会被一锅端）', () => {
    const a = card({ id: 'a', sub: 'ivraxr', post: 'p1', reason: '用户问字幕延迟' })
    const b = card({ id: 'b', sub: 'ivraxr', post: 'p2', reason: '用户夸续航，顺手道谢' })
    expect(similarTo(a, b)).toBeUndefined()
  })

  it('同一来源 + 判断依据相近 → 同类，理由写来源', () => {
    const a = card({ id: 'a', sub: 'Smartphones', post: 'p1', reason: OFF_TOPIC })
    const b = card({ id: 'b', sub: 'Smartphones', post: 'p2', reason: OFF_TOPIC })
    expect(similarTo(a, b)?.why).toContain('r/Smartphones')
  })

  it('卡面不同（不是同一种「发出去」卡）→ 不算', () => {
    const a = card({ id: 'a', sub: 'x', post: 'p1' })
    const b = card({ id: 'b', sub: 'x', post: 'p1', form: 'other' })
    expect(similarTo(a, b)).toBeUndefined()
  })
})
