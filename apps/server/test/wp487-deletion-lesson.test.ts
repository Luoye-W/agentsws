/**
 * WP487（决策 1679）：只删了几个字的修改（把「DM us」删掉再批）——服务进程这一侧。
 *
 * 1. 改了再批、只删了「DM us」：池里进一条「删掉了『DM us』」；两张卡上同样删 → 第二天出卡；
 * 2. 出卡前有模型：提炼成一句规矩（卡上选项就是那一句），先记一笔预估（`lesson.refine_planned`）；
 * 3. 没模型：卡上留规则版那一句；模型报错（超预算 / 网断）：停下，留规则版，记一笔 `lesson.refine_stopped`。
 */
import type { ApprovalItem, Assignment } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import type { SkillLessonPayload } from '../src/learning.js'

const T0 = '2026-10-21T09:00:00.000Z'

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

async function editDecide(n: number): Promise<ApprovalItem> {
  const item = await draft(n)
  return bus().decide(item.id, owner(), {
    decision_token: await tokenOf(item),
    via: 'workstation',
    action: 'approve_edited',
    edited_payload: {
      ...(item.payload as object),
      body: { subject: 'Re', text: 'Great question! for a code.' },
    },
  } as never)
}

const events = (type: string) =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id })
    .filter((e) => e.type === type)

const optionBodies = (card: ApprovalItem | undefined): string[] =>
  ((card?.payload as SkillLessonPayload | undefined)?.options ?? []).flatMap((o) =>
    'body' in o && typeof o.body === 'string' ? [o.body] : [],
  )

describe('WP487 决策 1679：只删了几个字 → 一句规矩', () => {
  it('两张卡都删掉「DM us」：池里一条「删掉了『DM us』」2 次；有模型时出卡前提炼成一句', async () => {
    await editDecide(1)
    await editDecide(2)
    const pooled = server.learning.lessons({ workspace_id: workspace() as never })
    expect(pooled.map((l) => l.text)).toEqual(['删掉了『DM us』'])
    const prompts: string[] = []
    clock.advance(24 * 60 * 60 * 1000)
    const out = await server.learning.proposeDailyFor(workspace() as never, clock.now(), {
      refine: async (p) => {
        prompts.push(p)
        return '回帖不写 DM us'
      },
    })
    expect(out.created).toHaveLength(1)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('DM us')
    const [card] = await lessonCards()
    expect(optionBodies(card).join('\n')).toContain('回帖不写 DM us')
    expect(card?.summary ?? '').toContain('删掉了')
    const planned = events('lesson.refine_planned')
    expect(planned).toHaveLength(1)
    expect(planned[0]?.payload).toMatchObject({ calls: 1, output_tokens: 80, cap: 10 })
    expect(
      Number((planned[0]?.payload as { input_tokens?: number } | undefined)?.input_tokens),
    ).toBeGreaterThan(0)
  })

  it('没模型：卡上留规则版「删掉了『DM us』」', async () => {
    await editDecide(1)
    await editDecide(2)
    clock.advance(24 * 60 * 60 * 1000)
    await server.learning.proposeDailyFor(workspace() as never, clock.now())
    const [card] = await lessonCards()
    expect(optionBodies(card).join('\n')).toContain('删掉了『DM us』')
    expect(events('lesson.refine_planned')).toHaveLength(0)
  })

  it('模型报错（超预算等）：停下、留规则版，记一笔', async () => {
    await editDecide(1)
    await editDecide(2)
    clock.advance(24 * 60 * 60 * 1000)
    await server.learning.proposeDailyFor(workspace() as never, clock.now(), {
      refine: async () => {
        throw new Error('budget exceeded')
      },
    })
    const [card] = await lessonCards()
    expect(optionBodies(card).join('\n')).toContain('删掉了『DM us』')
    expect(events('lesson.refine_stopped')[0]?.payload).toMatchObject({ reason: 'budget exceeded' })
  })
})
