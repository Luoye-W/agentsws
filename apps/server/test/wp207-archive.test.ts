/**
 * WP207：左栏职责下的对话 / 任务、自动归档（N 天、在跑 / 等批不归、新活动取消归档）、
 * 已归档列表与搜索、找回（关键词 + 模型重排，只读）、一次一件的恢复、只看本人看得见的。
 */
import type { PositionInstance } from '@agentsws/contracts'
import { createWork, DAY_MS } from '@agentsws/work'
import { describe, expect, it } from 'vitest'
import { createArchiveStateStore, createWorkArchive } from '../src/work-archive.js'

const T0 = '2026-09-20T02:00:00.000Z'

class Clock {
  at = Date.parse(T0)
  now(): string {
    return new Date(this.at).toISOString()
  }
  advance(ms: number): void {
    this.at += ms
  }
}

const me = { workspace_id: 'ws_1', person_id: 'per_me', assignment_id: 'asg_yt' }
const other = { workspace_id: 'ws_1', person_id: 'per_other', assignment_id: 'asg_other' }

const kolPosition: PositionInstance = {
  position_id: 'kol',
  workspace_id: 'ws_1',
  name: { zh: '红人营销', en: 'Influencer' },
  template_version: '1.0.0',
  holders: ['per_me'],
  roles: [
    {
      role_id: 'kol.youtube',
      role_name: 'YouTube 红人',
      default: true,
      assignment_ids: ['asg_yt'],
      my_assignment_id: 'asg_yt',
    },
    {
      role_id: 'kol.instagram',
      role_name: 'Instagram 红人',
      default: true,
      assignment_ids: ['asg_ig'],
      my_assignment_id: 'asg_ig',
    },
  ],
  open_matters: 0,
  pending_cards: 2,
  memory_summary: '',
}

function setup(options: { rerank?: (ids: string[]) => string[] | undefined } = {}) {
  const clock = new Clock()
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    emit: (e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
    },
  })
  const running = new Set<string>()
  const cards = new Map<string, number>()
  const state = createArchiveStateStore()
  const reranked: string[][] = []
  const archive = createWorkArchive({
    clock,
    work,
    state,
    positions: async (person) => (person === 'per_me' ? [kolPosition] : []),
    assignmentsOf: (person) => (person === 'per_me' ? ['asg_yt', 'asg_ig'] : ['asg_other']),
    runningMatters: () => running,
    pendingCards: async () => cards,
    personNames: async () => new Map([['per_me', '我']]),
    roleName: (id) => (id === 'kol.youtube' ? 'YouTube 红人' : undefined),
    positionName: (id) => (id === 'kol' ? '红人营销' : undefined),
    ...(options.rerank === undefined
      ? {}
      : {
          rerank: async (_actor, _q, pool) => {
            reranked.push(pool.map((p) => p.id))
            return options.rerank?.(pool.map((p) => p.id))
          },
        }),
  })
  const open = (title: string, role_id = 'kol.youtube', person = 'per_me') =>
    work.createMatter({
      kind: 'adhoc',
      title,
      entry: 'position',
      role_id,
      position_template_id: 'kol',
      position_id: person === 'per_me' ? 'asg_yt' : 'asg_other',
      participants: [person],
    })
  return { clock, work, archive, running, cards, state, events, open, reranked }
}

describe('WP207 左栏与自动归档', () => {
  it('职责下列进行中的事（按最近活动），状态小点：在跑 / 等你批 / 做完待看；岗位数 = 卡 + 待看', async () => {
    const t = setup()
    const a = t.open('美国红人样品')
    t.clock.advance(1000)
    const b = t.open('红人报价')
    t.clock.advance(1000)
    const c = t.open('帖子排期')
    t.clock.advance(1000)
    t.open('Instagram 合作', 'kol.instagram')
    t.running.add(b.id)
    t.cards.set(c.id, 1)
    t.work.appendEvent(a.id, {
      kind: 'agent_message',
      text: '样品寄出了',
      actor: { kind: 'agent', id: 'asg_yt' },
    })
    const rail = await t.archive.rail(me, {})
    expect(rail.idle_days).toBe(3)
    const kol = rail.positions[0]
    const yt = kol?.duties.find((d) => d.role_id === 'kol.youtube')
    expect(yt?.matters.map((m) => [m.title, m.state])).toEqual([
      ['美国红人样品', 'ready'],
      ['帖子排期', 'awaiting'],
      ['红人报价', 'running'],
    ])
    expect(kol?.duties.find((d) => d.role_id === 'kol.instagram')?.matters).toHaveLength(1)
    expect(kol?.awaiting).toBe(2 + 1)
    // 点开看过了 → 待看的点灭，岗位数少一
    await t.archive.seen(me, a.id)
    const after = await t.archive.rail(me, {})
    expect(after.positions[0]?.duties[0]?.matters[0]?.state).toBe('idle')
    expect(after.positions[0]?.awaiting).toBe(2)
  })

  it('默认最多 5 条 + 更多', async () => {
    const t = setup()
    for (let i = 0; i < 7; i += 1) t.open(`事 ${i}`)
    const yt = (await t.archive.rail(me, {})).positions[0]?.duties[0]
    expect(yt?.matters).toHaveLength(5)
    expect(yt?.more).toBe(2)
  })

  it('读左栏时懒扫：超过 3 天没动的归档；在跑 / 等你批的不归；别人的不动', async () => {
    const t = setup()
    const idle = t.open('美国红人样品')
    const run = t.open('在跑的')
    const card = t.open('等你批的')
    const theirs = t.open('别人的', 'kol.youtube', 'per_other')
    t.running.add(run.id)
    t.cards.set(card.id, 1)
    t.clock.advance(3 * DAY_MS + 1)
    const rail = await t.archive.rail(me, {})
    const yt = rail.positions[0]?.duties[0]
    expect(yt?.matters.map((m) => m.title).sort()).toEqual(['在跑的', '等你批的'])
    expect(yt?.archived).toBe(1)
    expect(t.work.getMatter(idle.id)?.archived_at).toBeDefined()
    expect(t.work.getMatter(theirs.id)?.archived_at).toBeUndefined()
    // 设成不自动归档：再过很久也不归
    t.state.setSettings({ idle_days: null })
    t.running.clear()
    t.cards.clear()
    t.clock.advance(30 * DAY_MS)
    await t.archive.rail(me, {})
    expect(t.work.getMatter(run.id)?.archived_at).toBeUndefined()
    // 新活动自动放回来
    t.work.appendEvent(idle.id, {
      kind: 'run',
      text: '定时任务触发',
      actor: { kind: 'system', id: 'schedule' },
    })
    expect(t.work.getMatter(idle.id)?.archived_at).toBeUndefined()
    expect(t.events.filter((e) => e.type === 'work.unarchived').map((e) => e.payload.by)).toEqual([
      'activity',
    ])
  })
})

describe('WP207 已归档列表、搜索与找回', () => {
  async function archivedWorld(rerank?: (ids: string[]) => string[] | undefined) {
    const t = setup(rerank === undefined ? {} : { rerank })
    const a = t.open('美国红人样品寄送')
    t.work.appendEvent(a.id, {
      kind: 'human_message',
      text: '跟 Jake 谈好了，样品下周寄到洛杉矶',
      actor: { kind: 'person', id: 'per_me' },
    })
    const b = t.open('Instagram 帖子排期', 'kol.instagram')
    const c = t.open('退款 #1001')
    const theirs = t.open('别人的红人样品', 'kol.youtube', 'per_other')
    t.clock.advance(4 * DAY_MS)
    await t.archive.rail(me, {})
    // 别人的那件由他自己的左栏扫
    await t.archive.rail(other, {})
    return { ...t, a, b, c, theirs }
  }

  it('列表按岗位 / 职责 / 时间筛，搜正文；只列本人看得见的', async () => {
    const t = await archivedWorld()
    const all = await t.archive.archived(me, {})
    expect(all.map((m) => m.title).sort()).toEqual([
      'Instagram 帖子排期',
      '美国红人样品寄送',
      '退款 #1001',
    ])
    expect((await t.archive.archived(me, { role_id: 'kol.instagram' })).map((m) => m.id)).toEqual([
      t.b.id,
    ])
    expect(await t.archive.archived(me, { from: t.clock.now() })).toEqual([])
    const hit = await t.archive.archived(me, { q: '洛杉矶' })
    expect(hit.map((m) => m.id)).toEqual([t.a.id])
    expect(hit[0]?.snippet).toContain('洛杉矶')
    // ⌘K 的搜索：进行中与归档的都给，归档的带 archived_at
    const fresh = t.open('红人样品第二批')
    const found = await t.archive.search(me, { q: '样品' })
    expect(found.map((m) => [m.id, m.archived_at !== undefined])).toEqual([
      [fresh.id, false],
      [t.a.id, true],
    ])
  })

  it('找回只读：关键词先捞，模型重排；模型编的 id 丢掉；不恢复任何东西', async () => {
    const t = await archivedWorld((ids) => ['mat_fake', ...ids.slice().reverse()])
    const out = await t.archive.find(me, { query: '把上周跟 Jake 谈样品的对话找回来' })
    expect(out.semantic).toBe(true)
    expect(out.candidates.some((c) => c.matter_id === 'mat_fake')).toBe(false)
    expect(out.candidates.some((c) => c.matter_id === t.theirs.id)).toBe(false)
    expect(t.reranked[0]?.[0]).toBe(t.a.id)
    expect(t.work.listMatters({ archived: true })).toHaveLength(4)
    expect(t.events.some((e) => e.type === 'work.unarchived')).toBe(false)
  })

  it('没接模型：只按关键词给', async () => {
    const t = await archivedWorld()
    const out = await t.archive.find(me, { query: '红人样品' })
    expect(out.semantic).toBe(false)
    expect(out.candidates.map((c) => c.matter_id)).toEqual([t.a.id])
    expect(await t.archive.recall(me, { query: '红人样品' })).toHaveLength(1)
    expect(t.archive.hasArchived(me)).toBe(true)
  })

  it('恢复一次一件，审计记是谁；别人的事回 not_found', async () => {
    const t = await archivedWorld()
    const { matter } = await t.archive.unarchive(me, t.a.id, 'ai_suggested')
    expect(matter.archived_at).toBeUndefined()
    expect(t.work.getMatter(t.b.id)?.archived_at).toBeDefined()
    expect(t.events.filter((e) => e.type === 'work.unarchived').map((e) => e.payload.by)).toEqual([
      'ai_suggested',
    ])
    await expect(async () => t.archive.unarchive(me, t.theirs.id, 'user')).rejects.toMatchObject({
      code: 'not_found',
    })
    const rail = await t.archive.rail(me, {})
    expect(rail.positions[0]?.duties[0]?.matters.map((m) => m.id)).toEqual([t.a.id])
  })
})
