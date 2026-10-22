/**
 * WP414 端到端（真服务进程 + 替身 Reddit 回信卡；不连真 Reddit、不起浏览器）：
 *
 * 外部版块 r/Smartphones 里三张同类的「发出去」卡（换手机的帖子，AI 判断都是「和我们无关」）+
 * 一张自家版块的正常回复卡：
 *
 * 1. 否掉第一张（**不写理由**，一下生效）→ **一张都不带**（10-19 更正：没理由只处理这一张）；
 * 2. 事后补理由「不相关」→ 这一刻才按理由去找：AI（这里是 stub 剧本，同一份输入）逐张判，判为是的两张
 *    自动「不发」，每张决定上写着为什么属于这个理由；自家版块那张不动；账本有一条 `approval.followed`；
 * 3. 单张恢复一张 → 只那张回待处理；整批撤回 → 剩下那张也回来；带头那张保持「不发」；
 * 4. 「稍后」同理：没理由不跟，有理由才跟；
 * 5. 「发送」同类卡：只列回「要一起发吗」，一张都不自动发。
 * 另有「按理由判」那几件的单元：预筛、读模型回话、模型判是 / 不是、模型出错一张都不带。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createReasonJudge,
  parseVerdicts,
  prefilterByReason,
  reasonPrompt,
  similarTo,
} from '../src/card-follow.js'
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
  it('没理由只处理这一张 → 补理由才按理由找 → 单张恢复 → 整批撤回', async () => {
    const { asg, ids, own } = await setup()
    const [first, second, third] = ids as [string, string, string]

    // 1. 否掉第一张：不写理由，一下生效，一张都不带
    const out = await call<{ state: string; follow?: Follow }>(
      asg,
      `/v1/approvals/${first}/decide`,
      { action: 'reject' },
    )
    expect(out.status).toBe(200)
    expect(out.data.state).toBe('rejected')
    expect(out.data.follow).toBeUndefined()
    expect((await get(second)).state).toBe('pending')
    expect((await get(third)).state).toBe('pending')
    expect((await get(first)).decision?.reason).toBe('不要')

    // 2. 事后补理由：这一刻才按理由去找（stub 剧本判），判为是的两张一并不发
    const reason = await call<{ followers: number; follow?: Follow & { reason?: string } }>(
      asg,
      `/v1/approvals/${first}/reason`,
      { reason: '不相关' },
    )
    expect(reason.status).toBe(200)
    expect(reason.data.follow?.reason).toBe('不相关')
    expect(reason.data.follow?.applied.map((a) => a.id).sort()).toEqual([second, third].sort())
    expect((await get(first)).decision?.reason).toBe('不相关')
    for (const id of [second, third]) {
      const item = await get(id)
      expect(item.state).toBe('rejected')
      expect(item.decision?.via).toBe('batch')
      expect(item.decision?.followed?.leader_id).toBe(first)
      // 为什么判它属于这个理由，写在每张被处理的卡上
      expect(item.decision?.followed?.why).toContain('不相关')
      expect(item.decision?.reason).toContain('不相关')
    }
    expect((await get(own)).state).toBe('pending')

    // 3. 单张恢复
    const one = await call<{ restored: { id: string }[] }>(
      asg,
      `/v1/approvals/${first}/follow/undo`,
      { ids: [second] },
    )
    expect(one.data.restored.map((r) => r.id)).toEqual([second])
    expect((await get(second)).state).toBe('pending')
    expect((await get(third)).state).toBe('rejected')

    // 整批撤回（已恢复的那张跳过）
    const undo = await call<{ restored: { id: string }[]; skipped: string[] }>(
      asg,
      `/v1/approvals/${first}/follow/undo`,
      { ids: [second, third] },
    )
    expect(undo.status).toBe(200)
    expect(undo.data.restored.map((r) => r.id)).toEqual([third])
    expect(undo.data.skipped).toEqual([second])
    expect((await get(third)).state).toBe('pending')
    expect((await get(first)).state).toBe('rejected')

    // 撤回后的卡能照常再定
    const again = await call<{ state: string }>(asg, `/v1/approvals/${second}/decide`, {
      action: 'snooze',
    })
    expect(again.status).toBe(200)
  })

  it('决定时就带了理由：当场按理由跟', async () => {
    const { asg, ids, own } = await setup()
    const [first, second, third] = ids as [string, string, string]
    const out = await call<{ follow?: Follow }>(asg, `/v1/approvals/${first}/decide`, {
      action: 'reject',
      reason: '时机不对',
    })
    expect(out.data.follow?.applied.map((a) => a.id).sort()).toEqual([second, third].sort())
    expect((await get(own)).state).toBe('pending')
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

  it('「稍后」：没理由不跟；补了理由才一并推迟', async () => {
    const { asg, ids, own } = await setup()
    const [first, second] = ids as [string, string]
    const out = await call<{ follow?: Follow }>(asg, `/v1/approvals/${first}/decide`, {
      action: 'snooze',
    })
    expect(out.data.follow).toBeUndefined()
    expect((await get(second)).state).toBe('pending')
    const reason = await call<{ follow?: Follow }>(asg, `/v1/approvals/${first}/reason`, {
      reason: '等产品资料',
    })
    expect(reason.data.follow?.applied).toHaveLength(2)
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

describe('按理由判（AI 逐张；词重合只预筛）', () => {
  const card = (id: string, sub: string, title: string, reason: string): ApprovalItem =>
    ({
      id,
      kind: 'outbound_draft',
      role_id: 'social.reddit',
      title: `回帖：${title}`,
      summary: title,
      subject: { object: { type: 'external_post', id: `reddit:${id}` } },
      payload: {
        form: 'reddit_write',
        reddit: { subreddit: sub, permalink: `/r/${sub}/comments/${id}/x/`, post_title: title },
        body: { text: 'Thanks!' },
        reason,
      },
    }) as unknown as ApprovalItem
  const leader = card('a', 'Smartphones', 'Switching from Pixel to iPhone', OFF_TOPIC)
  const pool = [
    card('b', 'Smartphones', 'Best battery phone this year', OFF_TOPIC),
    card('c', 'ivraxr', 'Air3 captions keep lagging', '自家版块用户问字幕延迟，要回'),
  ]
  const base = {
    leader,
    pool,
    reason: '不相关',
    action: 'reject' as const,
    person_id: 'per_1',
    assignment_id: 'asg_1',
  }

  it('预筛：同来源 / 词重合的排前面；提示里有理由、每张候选的 id，外部文本进围栏', () => {
    const picked = prefilterByReason(leader, pool, '不相关')
    expect(picked[0]?.id).toBe('b')
    const prompt = reasonPrompt({ leader, candidates: picked, reason: '不相关', action: 'reject' })
    expect(prompt).toContain('「不相关」')
    expect(prompt).toContain('[b]')
    expect(prompt).toContain('只按这条理由判断')
    // WP471（决策 1549）：固定的判法与格式在前，这一次的理由在后——换个理由，开头一整段不变
    const other = reasonPrompt({ leader, candidates: picked, reason: '重复了', action: 'snooze' })
    const head = (p: string) => p.slice(0, p.indexOf('运营刚把'))
    expect(head(prompt).length).toBeGreaterThan(0)
    expect(head(other)).toBe(head(prompt))
  })

  it('读模型回话：只认 match 为真、id 认得出、带一句为什么的', () => {
    const text =
      '好的：[{"id":"b","match":true,"why":"也是换手机的帖子"},{"id":"c","match":false,"why":"x"},{"id":"zz","match":true,"why":"y"}]'
    expect(parseVerdicts(text, ['b', 'c'])).toEqual([{ id: 'b', why: '也是换手机的帖子' }])
    expect(parseVerdicts('不是 JSON', ['b'])).toEqual([])
  })

  it('有模型：按模型逐张判的结果（判「不是」的不带）；模型出错一张都不带', async () => {
    const prompts: string[] = []
    const judge = createReasonJudge({
      complete: () => async (prompt) => {
        prompts.push(prompt)
        return '[{"id":"b","match":true,"why":"也是和眼镜无关的换手机帖"},{"id":"c","match":false,"why":"自家用户问题"}]'
      },
    })
    expect(await judge(base)).toEqual([
      { id: 'b', why: '也是和眼镜无关的换手机帖', basis: ['same_reason'] },
    ])
    expect(prompts[0]).toContain('不相关')
    const broken = createReasonJudge({
      complete: () => async () => {
        throw new Error('上游 500')
      },
    })
    expect(await broken(base)).toEqual([])
  })

  it('没有模型（stub）：同一份输入走剧本，可重跑；自家版块那张不算', async () => {
    const judge = createReasonJudge({ complete: () => undefined })
    const out = await judge(base)
    expect(out.map((o) => o.id)).toEqual(['b'])
    expect(out[0]?.why).toContain('不相关')
    expect(await judge(base)).toEqual(out)
  })
})
