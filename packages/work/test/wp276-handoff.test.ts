/**
 * WP276（docs/95 §4.3，决策 241 / 242）：交给对方。
 *
 * 钉住的几条：
 * - 交出去主人不变，事项里 AI 不接新活；只有主人能交、不能交给自己、不能交两次
 * - 接下：主人换成接手人、之后的运行用他那条分配、发起人变参与者、发起人在这件事上的待办跟着走
 * - 不接：退回发起人，带一句可选理由；撤回只有发起人能撤
 * - 到点没人理自动退回（天数可调）
 * - 发起人那边：接下 / 不接 / 退回出一行通知，点掉就不再出；撤回不通知
 * - 待办：转交 = 交给对方；「我来」= 接下
 */
import { describe, expect, it } from 'vitest'
import { claimOf } from '../src/claim.js'
import { createWork, type Work } from '../src/service.js'
import { DAY_MS } from '../src/util.js'
import { FakeClock, seeded } from './helpers.js'

const names: Record<string, string> = { p_he: '何佳', p_lin: '林峰' }
const label = (id: string): string => names[id] ?? id

function make(): {
  work: Work
  clock: FakeClock
  events: { type: string; payload: Record<string, unknown> }[]
  runs: { person_id: string; assignment_id: string }[]
} {
  const clock = new FakeClock()
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const runs: { person_id: string; assignment_id: string }[] = []
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    random: seeded(7),
    emit: (e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
    },
    startRun: ({ actor }) => {
      runs.push(actor)
      return { run_id: `run_${runs.length}` }
    },
  })
  return { work, clock, events, runs }
}

function heMatter(work: Work): string {
  const m = work.createMatter({
    kind: 'project',
    title: 'Acme 的报价',
    participants: ['p_he'],
    position_id: 'asg_he_b2b',
    role_id: 'b2b.sales',
  })
  work.createTodo({ title: '周五前回 Acme', owner: 'p_he', matter_id: m.id })
  return m.id
}

describe('WP276 交给对方 · 事项', () => {
  it('交出去主人不变、AI 不接新活；接下后主人、分配、待办都换成接手人，发起人留作参与者', async () => {
    const { work, events, runs } = make()
    const id = heMatter(work)
    const offered = work.offer(
      { kind: 'matter', id },
      { from: 'p_he', to: 'p_lin', note: '我这周出差', label },
    )
    expect('context' in offered && offered.context.participants[0]).toBe('p_he')
    expect(work.getMatter(id)?.handoff).toMatchObject({
      state: 'offered',
      from: 'p_he',
      to: 'p_lin',
      note: '我这周出差',
    })
    // 等接的时候不接新活
    await expect(
      work.say(id, { person_id: 'p_he', assignment_id: 'asg_he_b2b', text: '再跟进一下' }),
    ).rejects.toMatchObject({ code: 'conflict' })
    // 不能再交一次
    expect(() => work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_x' })).toThrow(
      /已经在交/,
    )
    expect(work.handoffsTo('p_lin').map((i) => i.ref.id)).toEqual([id])

    work.acceptHandoff(
      { kind: 'matter', id },
      {
        person: 'p_lin',
        position_id: 'asg_lin_b2b',
        role_id: 'b2b.sales',
        cards_moved: 2,
        label,
      },
    )
    const m = work.getMatter(id)
    expect(m?.context.participants).toEqual(['p_lin', 'p_he'])
    expect(m?.position_id).toBe('asg_lin_b2b')
    expect(m?.handoff).toMatchObject({ state: 'accepted', position_id: 'asg_lin_b2b' })
    // 发起人在这件事上的待办跟着走
    expect(work.listTodos({ matter_id: id }).map((t) => t.owner)).toEqual(['p_lin'])
    // 时间线写名字，不写 id
    const texts = work.store.listMatterEvents(id).map((e) => e.text)
    expect(texts).toContain('交给 林峰，等他接')
    expect(texts).toContain('林峰 接下了')
    expect(texts.join('\n')).not.toMatch(/p_lin|p_he/)
    // 之后接手人说一句，运行用他那条分配
    await work.say(id, { person_id: 'p_lin', assignment_id: 'asg_lin_b2b', text: '我接着做' })
    expect(runs.at(-1)).toEqual({ person_id: 'p_lin', assignment_id: 'asg_lin_b2b' })
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['handoff.offered', 'handoff.accepted']),
    )
    // 事件里没有留言正文
    expect(JSON.stringify(events)).not.toContain('出差')
    // 发起人那边一行通知，点掉就没了
    expect(work.handoffsFrom('p_he').map((i) => i.handoff.state)).toEqual(['accepted'])
    work.markHandoffSeen({ kind: 'matter', id }, 'p_he')
    expect(work.handoffsFrom('p_he')).toEqual([])
    expect(work.handoffsFrom('p_he', { all: true })).toHaveLength(1)
  })

  it('只有主人能交；不能交给自己；只有接手人能接', () => {
    const { work } = make()
    const id = heMatter(work)
    expect(() => work.offer({ kind: 'matter', id }, { from: 'p_lin', to: 'p_x' })).toThrow(
      /只有正在做/,
    )
    expect(() => work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_he' })).toThrow(
      /不能交给自己/,
    )
    work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_lin' })
    expect(() => work.acceptHandoff({ kind: 'matter', id }, { person: 'p_x' })).toThrow(
      /不是交给你的/,
    )
  })

  it('不接：退回发起人带理由，主人不变；发起人有一行通知', () => {
    const { work } = make()
    const id = heMatter(work)
    work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_lin' })
    work.declineHandoff({ kind: 'matter', id }, { person: 'p_lin', reason: '太忙', label })
    const m = work.getMatter(id)
    expect(m?.context.participants).toEqual(['p_he'])
    expect(m?.handoff).toMatchObject({ state: 'declined', reason: '太忙' })
    expect(work.store.listMatterEvents(id).map((e) => e.text)).toContain('林峰 没接：太忙')
    expect(work.handoffsFrom('p_he').map((i) => i.handoff.state)).toEqual(['declined'])
    // 退回之后可以再交
    work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_lin' })
    expect(work.getMatter(id)?.handoff?.state).toBe('offered')
  })

  it('撤回：只有发起人能撤，撤了不通知', () => {
    const { work } = make()
    const id = heMatter(work)
    work.offer({ kind: 'matter', id }, { from: 'p_he', to: 'p_lin' })
    expect(() => work.withdrawHandoff({ kind: 'matter', id }, { by: 'p_lin' })).toThrow(
      /只有交出去的人/,
    )
    work.withdrawHandoff({ kind: 'matter', id }, { by: 'p_he' })
    expect(work.getMatter(id)?.handoff?.state).toBe('withdrawn')
    expect(work.handoffsFrom('p_he')).toEqual([])
    expect(work.handoffsTo('p_lin')).toEqual([])
  })

  it('到点没人理自动退回（默认 3 天，天数可调）', () => {
    const { work, clock } = make()
    const a = heMatter(work)
    const b = heMatter(work)
    work.offer({ kind: 'matter', id: a }, { from: 'p_he', to: 'p_lin' })
    work.offer({ kind: 'matter', id: b }, { from: 'p_he', to: 'p_lin', days: 5 })
    clock.advance(3 * DAY_MS - 1)
    expect(work.expireHandoffs(label)).toEqual([])
    clock.advance(1)
    expect(work.expireHandoffs(label).map((r) => r.ref.id)).toEqual([a])
    expect(work.getMatter(a)?.handoff?.state).toBe('returned')
    expect(work.store.listMatterEvents(a).map((e) => e.text)).toContain(
      '林峰 一直没接，自动退回给 何佳',
    )
    clock.advance(2 * DAY_MS)
    expect(work.expireHandoffs().map((r) => r.ref.id)).toEqual([b])
    expect(work.handoffsFrom('p_he').map((i) => i.handoff.state)).toEqual(['returned', 'returned'])
  })
})

describe('WP276 交给对方 · 待办', () => {
  it('转交 = 交给对方；「我来」= 接下；不接回到发起人手上', () => {
    const { work } = make()
    const t1 = work.createTodo({ title: '核对样品单', owner: 'p_he' })
    work.transferTodo(t1.id, { to: 'p_lin', by: 'p_he', note: '你熟这个客户' })
    expect(work.requireTodo(t1.id).owner).toBe('p_he')
    expect(work.requireTodo(t1.id).handoff).toMatchObject({
      state: 'offered',
      note: '你熟这个客户',
    })
    expect(claimOf(work.requireTodo(t1.id)).state).toBe('offered')
    work.claimTodo(t1.id, 'p_lin', { position_id: 'asg_lin_b2b' })
    const got = work.requireTodo(t1.id)
    expect(got.owner).toBe('p_lin')
    expect(got.position_id).toBe('asg_lin_b2b')
    expect(got.handoff?.state).toBe('accepted')
    expect(claimOf(got).state).toBe('claimed')

    const t2 = work.createTodo({ title: '寄样', owner: 'p_he' })
    work.offer({ kind: 'todo', id: t2.id }, { from: 'p_he', to: 'p_lin' })
    work.declineHandoff({ kind: 'todo', id: t2.id }, { person: 'p_lin' })
    const back = work.requireTodo(t2.id)
    expect(back.owner).toBe('p_he')
    expect(claimOf(back)).toMatchObject({ state: 'claimed' })
    expect(claimOf(back).offered_to).toBeUndefined()
    expect(work.offeredTo('p_lin')).toEqual([])
  })

  it('撞车时「交给他」也是一次交给对方（带到期）', () => {
    const { work } = make()
    const m = work.createMatter({
      kind: 'conversation',
      title: 'Anna 的退款',
      participants: ['p_lin'],
      pinned: [{ type: 'order', id: 'ord_1' }],
    })
    work.createTodo({ title: '核对 Anna 的退款单', owner: 'p_lin', matter_id: m.id })
    const out = work.createTodoChecked({
      title: '核对 Anna 的退款单',
      owner: 'p_he',
      refs: [{ type: 'order', id: 'ord_1' }],
      collision: 'handoff',
      handoff_days: 2,
    })
    expect(out.offered_to).toBe('p_lin')
    expect(out.todo.handoff).toMatchObject({ state: 'offered', from: 'p_he', to: 'p_lin' })
    expect(work.handoffsTo('p_lin').map((i) => i.ref.id)).toEqual([out.todo.id])
  })
})
