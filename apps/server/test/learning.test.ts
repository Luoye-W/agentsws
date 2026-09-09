/**
 * WP29 学习回路闭环（服务进程侧）：
 * 驳回一封回信并写原因 → 池里多一条 → 次日 07:30 出一张 `skill_lesson` 选择题卡 →
 * 采纳 → 个人层 overlay 有了那条规则 → **下一次运行的 prompt 里含它**。
 *
 * 以及对照：驳回提案之后同类经验再出现，也不再提（`rejected_before`）。
 */
import type { ApprovalItem, Assignment } from '@agentsws/contracts'
import { skillPromptSections } from '@agentsws/learning'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { DEFAULT_SKILL_NAME } from '../src/learning.js'

const T0 = '2026-09-07T09:00:00.000Z'
const RULE = '退货窗口要从送达日算，不是下单日'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 29): () => number {
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
let aftersales: Assignment

const workspace = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

/** 一封待审的回信（不经运行时：这条测试要验的是"决定之后"那一段）。 */
async function draft(n: number): Promise<ApprovalItem> {
  return server.txn.approvals.create({
    workspace_id: workspace(),
    schema_version: 1,
    kind: 'outbound_draft',
    role_id: 'dtc.aftersales',
    subject: { object: { type: 'thread', id: `thr_${n}` } },
    dedupe_key: `${workspace()}:outbound_draft:thr_${n}`,
    title: `回复客户 ${n}`,
    summary: '退货请求',
    payload: {
      channel: 'email',
      to: { type: 'customer', id: 'cus_1' },
      body: { subject: 'Return', text: 'Your return window started on the order date.' },
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
    proposer: { kind: 'agent', id: 'agent', assignment_id: aftersales.id },
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
  // 投递是 create 之后才路由的，所以要从库里重读那一份
  const fresh = (await server.txn.approvals.get(item.id)) ?? item
  const d = [...fresh.deliveries].reverse().find((x) => x.to === owner() && x.status === 'sent')
  if (d === undefined) {
    throw new Error(
      `没有本人的 decision_token：state=${fresh.state} ${JSON.stringify(fresh.evidence.precheck.notes ?? [])}`,
    )
  }
  return d.decision_token
}

/** 直接调总线会绕开学习回路的包装，所以统一走 server 装配好的那一份。 */
async function decide(
  item: ApprovalItem,
  input: { action: 'approve' | 'reject'; selected_option_id?: string; reason?: string },
): Promise<ApprovalItem> {
  return server.learning.wrap(server.txn.approvals).decide(item.id, owner(), {
    decision_token: await tokenOf(item),
    via: 'workstation',
    ...input,
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
  aftersales = server.roles.assignments.create({
    person_id: server.bootstrap.person.id,
    workspace_id: server.bootstrap.workspace.id,
    role_id: 'dtc.aftersales',
    granted_by: server.bootstrap.person.id,
    ranges: [{ kind: 'store', id: 'store_1' }],
  })
})

afterEach(async () => {
  await server.close()
})

/** 走 server 装配好的总线（学习回路包过一层）。 */
async function reject(n: number, reason = RULE): Promise<void> {
  const item = await draft(n)
  await decide(item, { action: 'reject', reason })
}

describe('装配：自带技能与 07:30 那条定时任务', () => {
  it('技能库空着也会先铺一份自带技能，段落是学习回路的落脚点', () => {
    const sections = server.skills.registry.listSections(DEFAULT_SKILL_NAME)
    expect(sections.length).toBeGreaterThanOrEqual(3)
    expect(sections.map((s) => s.heading)).toContain('退货窗口计算')
  })

  it('八条系统任务里有一条 07:30 的学习回路提案', () => {
    const tasks = server.schedule.scheduler.list({ workspace_id: workspace() })
    const learning = tasks.find((t) => t.handler === 'skills.daily_lessons')
    expect(learning).toBeDefined()
    expect(learning?.trigger).toMatchObject({ kind: 'cron', expr: '30 7 * * *' })
  })
})

describe('24 §3 一条回路：驳回 → 池 → 次日提案 → 采纳 → 下次运行用新版', () => {
  it('两次同样的驳回攒出一条 lesson，次日出一张选择题卡；夜里技能一个字没改', async () => {
    const before = await server.skills.registry.resolve(DEFAULT_SKILL_NAME, {
      person_id: owner(),
      workspace_id: workspace(),
    })
    await reject(1)
    await reject(2)

    const pooled = server.learning.learning.pool.list({ workspace_id: workspace() })
    expect(pooled).toHaveLength(1)
    expect(pooled[0]?.hits).toBe(2)
    expect(pooled[0]?.signal).toBe('reject')
    expect(pooled[0]?.evidence[0]?.quote).toBe(RULE)
    // 入池不动技能
    const midway = await server.skills.registry.resolve(DEFAULT_SKILL_NAME, {
      person_id: owner(),
      workspace_id: workspace(),
    })
    expect(midway?.markdown).toBe(before?.markdown)

    clock.advance(22.5 * 3600_000) // 次日 07:30
    const fired = await server.schedule.scheduler.runDue(clock.now())
    expect(fired.some((f) => f.task.handler === 'skills.daily_lessons')).toBe(true)

    const cards = await server.learning.pendingProposals()
    expect(cards).toHaveLength(1)
    const card = cards[0] as ApprovalItem
    expect(card.kind).toBe('skill_lesson')
    expect(card.options?.map((o) => o.id)).toContain('none')
    expect(card.options?.length).toBeGreaterThanOrEqual(3)
    expect(card.evidence.diff?.after).toContain(RULE)
    // 出卡也不改技能：不批不生效
    const after = await server.skills.registry.resolve(DEFAULT_SKILL_NAME, {
      person_id: owner(),
      workspace_id: workspace(),
    })
    expect(after?.markdown).toBe(before?.markdown)
  })

  it('采纳 → 个人层 overlay 有 origin=learned；下一次运行的 prompt 含新规则', async () => {
    await reject(1)
    await reject(2)
    clock.advance(22.5 * 3600_000)
    await server.schedule.scheduler.runDue(clock.now())
    const card = (await server.learning.pendingProposals())[0] as ApprovalItem

    const out = await decide(card, { action: 'approve', selected_option_id: 'append' })
    expect(out.state).toBe('approved')

    const overlay = server.skills.registry.getOverlay(DEFAULT_SKILL_NAME, 'personal', owner())
    expect(overlay?.ops[0]).toMatchObject({ op: 'append', origin: 'learned' })
    expect(overlay?.ops[0]?.learned_from?.lessons.length).toBe(1)

    // 下次运行：`runtime.ts` 组 RunRequest 时就是拿这一份进 persona 段
    const sections = await skillPromptSections({
      skills: [{ name: DEFAULT_SKILL_NAME, tier: 'open', load: 'always' }],
      actor: { person_id: owner(), workspace_id: workspace() },
      registry: server.skills.registry,
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.text).toContain(RULE)
  })

  it('批准之后卡记成 applied（施行不是 unknown）', async () => {
    await reject(1)
    await reject(2)
    clock.advance(22.5 * 3600_000)
    await server.schedule.scheduler.runDue(clock.now())
    const card = (await server.learning.pendingProposals())[0] as ApprovalItem
    await decide(card, { action: 'approve', selected_option_id: 'append' })
    const stored = await server.txn.approvals.get(card.id)
    expect(stored?.state).toBe('applied')
    expect(stored?.apply?.attempts[0]?.result).toBe('ok')
  })

  it('技能页数据：三层 overlay 列表标出"学到的"，待审提案数对得上', async () => {
    await reject(1)
    await reject(2)
    clock.advance(22.5 * 3600_000)
    await server.schedule.scheduler.runDue(clock.now())

    const pending = await server.learning.summaries({
      person_id: owner(),
      workspace_id: workspace(),
    })
    const skill = pending.find((s) => s.name === DEFAULT_SKILL_NAME)
    expect(skill?.pending_proposals).toBe(1)
    expect(skill?.version).toBe('1.0')

    const card = (await server.learning.pendingProposals())[0] as ApprovalItem
    await decide(card, { action: 'approve', selected_option_id: 'append' })
    const after = await server.learning.summaries({
      person_id: owner(),
      workspace_id: workspace(),
    })
    const updated = after.find((s) => s.name === DEFAULT_SKILL_NAME)
    expect(updated?.pending_proposals).toBe(0)
    expect(updated?.overlays[0]?.tier).toBe('personal')
    expect(updated?.overlays[0]?.ops[0]?.origin).toBe('learned')
    expect(updated?.overlays[0]?.ops[0]?.heading).toBeDefined()
  })
})

describe('驳回一次，同类的以后不再提', () => {
  it('驳回提案 → 语义键进黑名单；同类 lesson 再出现，次日整理里是 rejected_before', async () => {
    await reject(1)
    await reject(2)
    clock.advance(22.5 * 3600_000)
    await server.schedule.scheduler.runDue(clock.now())
    const card = (await server.learning.pendingProposals())[0] as ApprovalItem
    await decide(card, { action: 'reject', reason: '这条不对，窗口本来就按下单日' })

    expect(server.learning.learning.pool.rejectedKeys(workspace())).toHaveLength(1)
    expect(server.skills.registry.listOverlays(DEFAULT_SKILL_NAME)).toEqual([])

    // 同类经验再出现两次
    await reject(3)
    await reject(4)
    clock.advance(24 * 3600_000)
    const { created, filtered } = await server.learning.proposeDaily(clock.now())
    expect(created).toEqual([])
    expect(filtered.map((f) => f.reason)).toContain('rejected_before')
    expect(await server.learning.pendingProposals()).toHaveLength(0)
  })
})

describe('技能页 API 与晋升', () => {
  it('GET /v1/skills、/v1/skills/proposals、exclude、promote 都通', async () => {
    const { url } = await server.listen(0)
    const call = async (path: string, init: RequestInit = {}): Promise<Response> => {
      const headers = new Headers(init.headers)
      headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
      headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
      if (init.body !== undefined) headers.set('content-type', 'application/json')
      return fetch(`${url}${path}`, { ...init, headers })
    }
    const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

    const list = await dataOf<{ name: string; pending_proposals: number }[]>(
      await call('/v1/skills'),
    )
    expect(list.map((s) => s.name)).toContain(DEFAULT_SKILL_NAME)

    expect(await dataOf(await call('/v1/skills/proposals'))).toEqual([])

    // 排除之后解析不出来（24 §6.7）
    const excluded = await call(`/v1/skills/${DEFAULT_SKILL_NAME}/exclude`, {
      method: 'POST',
      body: JSON.stringify({ excluded: true }),
    })
    expect(excluded.status).toBe(200)
    expect((await call(`/v1/skills/${DEFAULT_SKILL_NAME}/resolved`)).status).toBe(404)
    await call(`/v1/skills/${DEFAULT_SKILL_NAME}/exclude`, {
      method: 'POST',
      body: JSON.stringify({ excluded: false }),
    })

    // 个人层没有修改时晋升被拒（说得清为什么）
    const empty = await dataOf<{ accepted: boolean; reason?: string }>(
      await call(`/v1/skills/${DEFAULT_SKILL_NAME}/promote`, {
        method: 'POST',
        body: JSON.stringify({ section_ids: ['sec_x'], to_tier: 'company' }),
      }),
    )
    expect(empty.accepted).toBe(false)
    expect(empty.reason).toContain('没有')

    // 采纳一条之后再晋升：出一张 skill_promotion 卡
    await reject(1)
    await reject(2)
    clock.advance(22.5 * 3600_000)
    await server.schedule.scheduler.runDue(clock.now())
    const card = (await server.learning.pendingProposals())[0] as ApprovalItem
    await decide(card, { action: 'approve', selected_option_id: 'append' })
    const section_id = server.skills.registry.getOverlay(DEFAULT_SKILL_NAME, 'personal', owner())
      ?.ops[0]?.section_id
    const promoted = await dataOf<{
      accepted: boolean
      approval_item_id?: string
      reason?: string
    }>(
      await call(`/v1/skills/${DEFAULT_SKILL_NAME}/promote`, {
        method: 'POST',
        body: JSON.stringify({ section_ids: [section_id], to_tier: 'company' }),
      }),
    )
    expect(promoted.reason ?? '').toBe('')
    expect(promoted.accepted).toBe(true)
    const item = await server.txn.approvals.get(promoted.approval_item_id ?? '')
    expect(item?.kind).toBe('skill_promotion')
  })
})
