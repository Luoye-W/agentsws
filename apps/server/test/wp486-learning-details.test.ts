/**
 * WP486（Luoye 10-23 真机）：「昨天学到的：给「不写的东西」加一条 不要」——服务进程这一侧。
 *
 * 1. 光点「不要」（决定上记的理由是按钮名）攒不出卡；事后补了理由才算一次纠正；
 * 2. 卡上带「攒出这条的那几次纠正」（时间、哪张卡、你说的理由），正文点名是哪几张卡；
 * 3. 升级前已经进池 / 出了卡的那种坏卡，`sweepButtonOnly` 清掉（开机也跑）；
 * 4. 学习那张表与 deck / contracts 里「没写理由时代填的那一句」对齐。
 */
import type { ApprovalItem, Assignment } from '@agentsws/contracts'
import { NOT_WIRED_ACK_REASON } from '@agentsws/contracts'
import { HANDOFF_DECLINE_NO_REASON, REJECT_NO_REASON, resolveDecision } from '@agentsws/deck'
import { isButtonOnlyText } from '@agentsws/learning'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { SkillLessonPayload } from '../src/learning.js'

const T0 = '2026-10-21T09:00:00.000Z'
const RULE = '回帖里不要写 DM us，社区规则不许拉私信'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 486): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server
let clock: ReturnType<typeof makeClock>
let duty: Assignment

const workspace = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

async function draft(n: number): Promise<ApprovalItem> {
  return server.txn.approvals.create({
    workspace_id: workspace(),
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: 'dtc.support',
    subject: { object: { type: 'thread', id: `thr_${n}` } },
    dedupe_key: `${workspace()}:outbound_draft:thr_${n}`,
    title: `回帖 ${n}`,
    summary: '社区回帖',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_1' },
      body: { subject: 'Re', text: 'Great question! DM us for a code.' },
    },
    evidence: {
      run_id: `run_${n}`,
      source_events: [],
      provenance: {
        seen: [
          { type: 'customer', id: 'cus_1' },
          { type: 'thread', id: `thr_${n}` },
        ],
      },
      precheck: {},
    },
    proposer: { kind: 'agent', id: 'agent', assignment_id: duty.id },
    automation: {
      level_at_creation: 'L1',
      auto_approved: false,
      mandate_check: { within: true, caps_hit: [] },
      sampling: { selected: false },
    },
    routing: {
      recipients: [{ person: owner(), via: 'role_holder' }],
      rule: 'role_holder',
      escalation: { after_hours: 8, business_hours: true, chain: ['owner'], escalated_at: [] },
      separation_of_duties: false,
    },
    priority: 'queue',
    context: { thread_participants: ['cus_1'], verified_contacts: ['cus_1'] },
  })
}

const tokenOf = async (item: ApprovalItem): Promise<string> => {
  const fresh = (await server.txn.approvals.get(item.id)) ?? item
  const d = [...fresh.deliveries].reverse().find((x) => x.to === owner() && x.status === 'sent')
  if (d === undefined)
    throw new Error(
      `没有本人的 decision_token：state=${fresh.state} ${JSON.stringify(fresh.evidence.precheck)}`,
    )
  return d.decision_token
}

const bus = () => server.learning.wrap(server.txn.approvals)

/** 卡上点「不要」：没写理由时 deck 那一层记的就是 `REJECT_NO_REASON`（与网关同一条路）。 */
async function reject(n: number, reason?: string): Promise<ApprovalItem> {
  const item = await draft(n)
  return bus().decide(item.id, owner(), {
    decision_token: await tokenOf(item),
    via: 'workstation',
    action: 'reject',
    reason: reason ?? REJECT_NO_REASON,
  })
}

async function lessonCards(): Promise<ApprovalItem[]> {
  return server.txn.approvals.queue({
    workspace_id: workspace(),
    person_id: owner(),
    lane: 'mine',
    kind: 'skill_lesson',
  })
}

beforeEach(async () => {
  clock = makeClock()
  server = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    startRun: false,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com' },
  })
  duty = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.support',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP486 光点「不要」攒不出「学到」', () => {
  it('两次光点「不要」：池里没有、第二天也不出卡（原来出「加一条 不要」）', async () => {
    await reject(1)
    clock.advance(86_400_000)
    await reject(2)
    expect(server.learning.lessons({ workspace_id: workspace() })).toEqual([])
    const out = await server.learning.proposeDaily('2026-10-23T07:30:00.000Z')
    expect(out.created).toEqual([])
    expect(await lessonCards()).toEqual([])
  })

  it('「不要」之后补了理由（快捷理由 / 一句话）：这时才算一次纠正进池', async () => {
    const a = await reject(1)
    expect(server.learning.lessons({ workspace_id: workspace() })).toEqual([])
    await bus().annotate?.(a.id, owner(), { reason: RULE })
    const pooled = server.learning.lessons({ workspace_id: workspace() })
    expect(pooled).toHaveLength(1)
    // 再补一句（不是第一次补）不再算一次
    await bus().annotate?.(a.id, owner(), { reason: `${RULE}。` })
    expect(server.learning.lessons({ workspace_id: workspace() })).toHaveLength(1)
  })

  it('两次写了理由：出卡，正文点名那两张卡、详情带两条来源', async () => {
    const a = await reject(1, RULE)
    clock.advance(86_400_000)
    const b = await reject(2, RULE)
    const out = await server.learning.proposeDaily('2026-10-23T07:30:00.000Z')
    expect(out.created).toHaveLength(1)
    const card = (await lessonCards())[0]
    expect(card?.summary).toContain('10-21、10-22')
    expect(card?.summary).toContain('「回帖 1」「回帖 2」')
    expect(card?.summary).toContain(`理由是「${RULE}」`)
    const p = card?.payload as SkillLessonPayload
    expect(p.sources?.map((s) => [s.approval_item_id, s.card_title, s.quote, s.signal])).toEqual([
      [a.id, '回帖 1', RULE, 'reject'],
      [b.id, '回帖 2', RULE, 'reject'],
    ])
    expect(p.sources?.[0]?.position_id).toBe(duty.id)
  })
})

describe('WP486 升级时撤掉已经出了的坏卡', () => {
  it('池里的「不要」标成 refuted；据此出的待审卡记成过期；再跑一次什么都不做', async () => {
    // 造 WP486 之前的样子：两条「不要」直接入池，再按老样子出一张卡
    const pool = server.learning.learning.pool
    const old = {
      workspace_id: workspace(),
      assignment_id: duty.id,
      run_id: 'run_1',
      applies_to: { skill: 'customer-care' },
      kind: 'anti_example' as const,
      signal: 'reject' as const,
      strength: 'strong' as const,
      text: '不要',
      confidence: 0.6,
      evidence: [{ quote: '不要', at: T0, approval_item_id: 'ap_x' }],
      semantic_key: 'k_bare',
    }
    const l = pool.pool(old)
    pool.pool({ ...old, run_id: 'run_2' })
    pool.mark(l.id, 'proposed')
    const bad = await server.txn.approvals.create({
      workspace_id: workspace(),
      schema_version: 1,
      kind: 'skill_lesson',
      role_id: 'common.owner',
      subject: { object: { type: 'skill', id: 'customer-care' } },
      dedupe_key: `${workspace()}:skill_lesson:customer-care:old`,
      title: '昨天学到的：给「不写的东西」加一条 不要',
      summary: '2 次同类纠正攒出来的一条。采纳就写进你的个人层，不采纳以后不再提。',
      payload: {
        form: 'skill_lesson',
        skill: 'customer-care',
        section_id: 's1',
        heading: '不写的东西',
        semantic_key: 'k_bare',
        proposed_text: '不要',
        options: [
          { id: 'append', label: '加一句：不要', op: 'append', section_id: 's1', body: '不要' },
          { id: 'none', label: '都不要' },
        ],
        hits: 2,
        confidence: 0.75,
        lessons: [l.id],
        quotes: ['不要'],
        run_ids: ['run_1', 'run_2'],
      },
      evidence: {
        source_events: [],
        diff: { before: '不写价格', after: '不写价格\n\n不要', summary: '「不写的东西」追加一条' },
        provenance: { seen: [{ type: 'skill', id: 'customer-care' }] },
        precheck: { permission_diff: 'ok' },
      },
      proposer: { kind: 'system', id: 'learning' },
      automation: {
        level_at_creation: 'L1',
        auto_approved: false,
        mandate_check: { within: true, caps_hit: [] },
        sampling: { selected: false },
      },
      routing: {
        recipients: [{ person: owner(), via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 72, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: [
        { id: 'append', label: '加一句：不要' },
        { id: 'none', label: '都不要' },
      ],
    })
    expect(bad.state, JSON.stringify(bad.evidence.precheck)).not.toBe('blocked')
    expect((await lessonCards()).map((i) => i.id)).toEqual([bad.id])

    const swept = await server.learning.sweepButtonOnly()
    expect(swept).toEqual({ lessons: 1, cards: 1 })
    expect((await server.txn.approvals.get(bad.id))?.state).toBe('expired')
    expect(await lessonCards()).toEqual([])
    expect(pool.get(l.id)?.status).toBe('refuted')
    expect(await server.learning.sweepButtonOnly()).toEqual({ lessons: 0, cards: 0 })
  })
})

describe('WP486 「没写理由时代填的那一句」与学习那张表对齐', () => {
  it('deck / contracts 里的占位理由，学习回路一律认作「没写理由」', () => {
    for (const r of [REJECT_NO_REASON, HANDOFF_DECLINE_NO_REASON, NOT_WIRED_ACK_REASON])
      expect(isButtonOnlyText(r), r).toBe(true)
    // 连接卡 / 配置卡「先不连 / 先不设」：从 deck 的 resolveDecision 现取（别靠抄）
    for (const kind of ['connect_request', 'setup_request'] as const) {
      const r = resolveDecision(
        {
          kind,
          version: 1,
          available_actions: ['reject'],
          detail: { payload: {} },
        } as never,
        { action: 'reject' } as never,
        { now: T0 },
      )
      expect(isButtonOnlyText((r as { reason?: string }).reason), kind).toBe(true)
    }
  })
})

describe('WP486 端到端（真服务进程 + 替身 Reddit 回信卡，走 HTTP：/decide、/reason）', () => {
  it('两张回帖卡光点「不要」→ 不进池不出卡；事后补一句理由 → 那一下才进池', async () => {
    const ws = workspace()
    const person_id = owner()
    const asg = server.roles.assignments.create({
      person_id,
      workspace_id: ws,
      granted_by: person_id,
      ranges: [{ kind: 'store' as const, id: 'store_1' }],
      role_id: 'social.reddit',
    })
    const brand = await server.brands.forWorkspace(ws)
    const actor = { workspace_id: ws, person_id, assignment_id: asg.id, role_id: 'social.reddit' }
    const stage = async (post: string, title: string): Promise<string> => {
      const out = await brand.redditWrites.stage(actor as never, {
        target: {
          kind: 'comment',
          subreddit: 'ivraxr',
          parent_fullname: `t3_${post}`,
          permalink: `/r/ivraxr/comments/${post}/x/`,
          post_title: title,
          parent_author: 'dan',
        },
        text: 'Great question! DM us and we will sort it out.',
        reason: '自家版块用户提问，要回',
      })
      if (!out.staged) throw new Error(out.message)
      return out.approval_item_id
    }
    const call = async (path: string, body: unknown): Promise<number> => {
      const res = await server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${server.bootstrap.internalToken}`,
            'X-Assignment': asg.id,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        }),
      )
      return res.status
    }
    const a = await stage('p1', 'Air3 captions keep lagging')
    const b = await stage('p2', 'How long is the warranty?')
    expect(await call(`/v1/approvals/${a}/decide`, { action: 'reject' })).toBe(200)
    expect(await call(`/v1/approvals/${b}/decide`, { action: 'reject' })).toBe(200)
    expect((await server.txn.approvals.get(a))?.decision?.reason).toBe(REJECT_NO_REASON)
    expect(server.learning.lessons({ workspace_id: ws })).toEqual([])
    const out = await server.learning.proposeDailyFor(ws, '2026-10-23T07:30:00.000Z')
    expect(out.created).toEqual([])

    expect(await call(`/v1/approvals/${a}/reason`, { reason: RULE })).toBe(200)
    const pooled = server.learning.lessons({ workspace_id: ws })
    expect(pooled).toHaveLength(1)
  })
})
