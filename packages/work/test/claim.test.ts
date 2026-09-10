/**
 * 认领即锁 · 建之前先查 · 闲置回收（40 §3）。
 *
 * 钉住的几条：
 * - 建之前先查：撞上了**不建**，抛 `conflict / similar_in_progress` 带候选
 * - `join` / `handoff` / `force` 才放行；`force` 没写区别就是 `invalid_input`
 * - 认领即锁：第一个成功的是主人，第二个人回 `already_claimed` 并看得见主人
 * - 池里的项不进任何人的待办箱（`owner` 是占位 id）
 * - 闲置：N 天没动先提醒，再 N 天回池
 */
import { describe, expect, it } from 'vitest'
import { claimOf, DEFAULT_IDLE_DAYS, UNCLAIMED_OWNER } from '../src/claim.js'
import { filterCollidingSuggestions } from '../src/plan.js'
import { createWork, type Work } from '../src/service.js'
import { DAY_MS } from '../src/util.js'
import { FakeClock, seeded } from './helpers.js'

const TZ = 480

function make(): { work: Work; clock: FakeClock; events: string[] } {
  const clock = new FakeClock()
  const events: string[] = []
  const work = createWork({
    workspace_id: 'ws_1',
    clock,
    random: seeded(11),
    tz_offset_minutes: TZ,
    emit: (e) => {
      events.push(e.type)
    },
  })
  return { work, clock, events }
}

/** 李默正在做「核对昨天的退款单」，挂在订单 #1001 的事项上，两张卡等他定。 */
function liIsBusy(work: Work): { matter_id: string; todo_id: string } {
  const matter = work.createMatter({
    kind: 'conversation',
    title: 'Anna 的退款',
    participants: ['p_li'],
    pinned: [{ type: 'order', id: 'ord_1001' }],
    position_id: 'asg_ops',
  })
  const todo = work.createTodo({
    title: '核对昨天的退款单',
    owner: 'p_li',
    matter_id: matter.id,
    position_id: 'asg_ops',
  })
  work.onCard({
    id: 'apr_1',
    kind: 'refund',
    state: 'pending',
    title: '退款要你定',
    todo_id: todo.id,
  })
  work.onCard({ id: 'apr_2', kind: 'refund', state: 'pending', title: '再一张', todo_id: todo.id })
  return { matter_id: matter.id, todo_id: todo.id }
}

describe('建之前先查（40 §3.1）', () => {
  it('撞上了不建，抛 similar_in_progress 带候选与主人', () => {
    const { work } = make()
    liIsBusy(work)
    try {
      work.createTodoChecked({
        title: '把昨天的退款单核对一下',
        owner: 'p_chen',
        refs: [{ type: 'order', id: 'ord_1001' }],
      })
      throw new Error('本该撞车')
    } catch (e) {
      const err = e as { code?: string; details?: { reason?: string; candidates?: unknown[] } }
      expect(err.code).toBe('conflict')
      expect(err.details?.reason).toBe('similar_in_progress')
      const first = (err.details?.candidates ?? [])[0] as { owner: string; cards: number }
      expect(first.owner).toBe('p_li')
      expect(first.cards).toBe(2)
    }
    // 一条都没多出来
    expect(work.listTodos({ owner: 'p_chen' })).toHaveLength(0)
  })

  it('没撞就照建', () => {
    const { work } = make()
    liIsBusy(work)
    const made = work.createTodoChecked({ title: '给供应商打电话催货', owner: 'p_chen' })
    expect(made.todo.owner).toBe('p_chen')
    expect(made.similar_to).toEqual([])
  })

  it('join：加进对方的事项当协作者，待办挂过去', () => {
    const { work } = make()
    const { matter_id, todo_id } = liIsBusy(work)
    const made = work.createTodoChecked({
      title: '把昨天的退款单核对一下',
      owner: 'p_chen',
      refs: [{ type: 'order', id: 'ord_1001' }],
      collision: 'join',
    })
    expect(made.joined_matter_id).toBe(matter_id)
    expect(made.todo.matter_id).toBe(matter_id)
    expect(work.requireMatter(matter_id).context.participants).toContain('p_chen')
    expect(claimOf(work.requireTodo(todo_id)).collaborators).toEqual(['p_chen'])
  })

  it('handoff：交给对方，对方接下之前主人不变', () => {
    const { work, events } = make()
    liIsBusy(work)
    const made = work.createTodoChecked({
      title: '把昨天的退款单核对一下',
      owner: 'p_chen',
      refs: [{ type: 'order', id: 'ord_1001' }],
      collision: 'handoff',
    })
    expect(made.offered_to).toBe('p_li')
    expect(made.todo.owner).toBe('p_chen')
    expect(claimOf(made.todo).state).toBe('offered')
    expect(events).toContain('todo.transferred')
    expect(work.offeredTo('p_li').map((t) => t.id)).toEqual([made.todo.id])
    // 对方接下来才换主人
    const taken = work.claimTodo(made.todo.id, 'p_li')
    expect(taken.owner).toBe('p_li')
  })

  it('force 必须写一句区别（≥ 8 字），理由留在库里', () => {
    const { work } = make()
    liIsBusy(work)
    const base = {
      title: '把昨天的退款单核对一下',
      owner: 'p_chen',
      refs: [{ type: 'order', id: 'ord_1001' }] as const,
      collision: 'force' as const,
    }
    expect(() => work.createTodoChecked({ ...base, distinct_reason: '不一样' })).toThrow(/区别/)
    const made = work.createTodoChecked({
      ...base,
      distinct_reason: '我这条是另一家店的同号订单，不是李默那单',
    })
    expect(claimOf(made.todo).distinct_reason).toContain('另一家店')
    expect(made.similar_to.length).toBeGreaterThan(0)
  })
})

describe('待认领池与认领即锁（40 §3.2）', () => {
  it('池里的项没有主人，不进任何人的待办箱', () => {
    const { work, events } = make()
    const pooled = work.poolTodo({ title: '把上周的退款汇总一下', source: 'meeting' })
    expect(pooled.owner).toBe(UNCLAIMED_OWNER)
    expect(work.pool()).toHaveLength(1)
    expect(work.listTodos({ owner: 'p_chen' })).toHaveLength(0)
    expect(work.inbox('p_chen').backlog).toHaveLength(0)
    expect(events).toContain('todo.pooled')
    expect(work.poolView()[0]?.title).toBe('把上周的退款汇总一下')
  })

  it('第一个认领的是主人，第二个人回 already_claimed 并看得见主人', () => {
    const { work, events } = make()
    const pooled = work.poolTodo({ title: '把上周的退款汇总一下', source: 'meeting' })
    const mine = work.claimTodo(pooled.id, 'p_li', { position_id: 'asg_ops' })
    expect(mine.owner).toBe('p_li')
    expect(mine.position_id).toBe('asg_ops')
    expect(events).toContain('todo.claimed')
    expect(work.pool()).toHaveLength(0)
    try {
      work.claimTodo(pooled.id, 'p_chen')
      throw new Error('本该已经有主人了')
    } catch (e) {
      const err = e as { code?: string; details?: { reason?: string; owner?: string } }
      expect(err.code).toBe('conflict')
      expect(err.details?.reason).toBe('already_claimed')
      expect(err.details?.owner).toBe('p_li')
    }
  })

  it('转交：主人才能转，对方接下之前不形成责任', () => {
    const { work } = make()
    const pooled = work.poolTodo({ title: '盘一下上月库存差异' })
    work.claimTodo(pooled.id, 'p_li')
    expect(() => work.transferTodo(pooled.id, { to: 'p_chen', by: 'p_sun' })).toThrow(/主人/)
    const offered = work.transferTodo(pooled.id, { to: 'p_chen', by: 'p_li' })
    expect(offered.owner).toBe('p_li')
    expect(claimOf(offered).offered_to).toBe('p_chen')
    // 别人接不走
    expect(() => work.claimTodo(pooled.id, 'p_sun')).toThrow()
    expect(work.claimTodo(pooled.id, 'p_chen').owner).toBe('p_chen')
  })

  it('加协作者：主人还是一个，协作者进事项参与者', () => {
    const { work } = make()
    const matter = work.createMatter({ kind: 'adhoc', title: '盘库存', participants: ['p_li'] })
    const todo = work.createTodo({
      title: '盘一下上月库存差异',
      owner: 'p_li',
      matter_id: matter.id,
    })
    const next = work.addCollaborator(todo.id, 'p_sun')
    expect(next.owner).toBe('p_li')
    expect(claimOf(next).collaborators).toEqual(['p_sun'])
    expect(work.requireMatter(matter.id).context.participants).toContain('p_sun')
  })
})

describe('看得见谁在做（40 §3.3）', () => {
  it('进行中的待办带主人、开始时间、卡数；池里的不算在做', () => {
    const { work } = make()
    liIsBusy(work)
    work.poolTodo({ title: '还没人认的活' })
    const list = work.inProgress()
    const todo = list.find((i) => i.kind === 'todo')
    expect(todo?.owner).toBe('p_li')
    expect(todo?.cards).toBe(2)
    expect(list.some((i) => i.title === '还没人认的活')).toBe(false)
  })

  it('按岗位缩小范围', () => {
    const { work } = make()
    liIsBusy(work)
    work.createTodo({ title: '别的岗位的活', owner: 'p_wu', position_id: 'asg_ads' })
    expect(work.inProgress({ position_id: 'asg_ads', scope: 'position' })).toHaveLength(1)
    expect(work.inProgress({ position_id: 'asg_ops', scope: 'position' })).toHaveLength(1)
    expect(work.inProgress().length).toBeGreaterThanOrEqual(2)
  })
})

describe('闲置回收（40 §3.5）', () => {
  it('N 天没动先提醒，再 N 天回池', () => {
    const { work, clock, events } = make()
    const pooled = work.poolTodo({ title: '盘一下上月库存差异' })
    work.claimTodo(pooled.id, 'p_li')

    expect(work.sweepIdleTodos().reminded).toEqual([])

    clock.advance(DEFAULT_IDLE_DAYS * DAY_MS)
    expect(work.sweepIdleTodos().reminded).toEqual([pooled.id])
    expect(events).toContain('todo.idle_reminded')
    // 同一轮不重复提醒
    expect(work.sweepIdleTodos().reminded).toEqual([])

    clock.advance(DEFAULT_IDLE_DAYS * DAY_MS)
    const swept = work.sweepIdleTodos()
    expect(swept.recycled).toEqual([pooled.id])
    expect(events).toContain('todo.recycled')
    const back = work.requireTodo(pooled.id)
    expect(back.owner).toBe(UNCLAIMED_OWNER)
    expect(claimOf(back).recycled).toBe(1)
    expect(work.pool()).toHaveLength(1)
  })

  it('自己建的待办不会被回收（它从来没进过池）', () => {
    const { work, clock } = make()
    work.createTodo({ title: '买咖啡', owner: 'p_li' })
    clock.advance(30 * DAY_MS)
    const swept = work.sweepIdleTodos()
    expect(swept.reminded).toEqual([])
    expect(swept.recycled).toEqual([])
  })

  it('有卡等着定就不算闲置（人在等 Agent，不是没动）', () => {
    const { work, clock } = make()
    const pooled = work.poolTodo({ title: '盘一下上月库存差异' })
    const todo = work.claimTodo(pooled.id, 'p_li')
    work.onCard({
      id: 'apr_9',
      kind: 'refund',
      state: 'pending',
      title: '要你定',
      todo_id: todo.id,
    })
    clock.advance(30 * DAY_MS)
    expect(work.sweepIdleTodos().reminded).toEqual([])
  })

  it('事项时间线上动过就重新计时', () => {
    const { work, clock } = make()
    const matter = work.createMatter({ kind: 'adhoc', title: '盘库存', participants: ['p_li'] })
    const pooled = work.poolTodo({ title: '盘一下上月库存差异', matter_id: matter.id })
    const todo = work.claimTodo(pooled.id, 'p_li')
    clock.advance(3 * DAY_MS)
    work.appendEvent(matter.id, {
      kind: 'note',
      text: '问了仓库',
      actor: { kind: 'person', id: 'p_li' },
      todo_id: todo.id,
    })
    clock.advance(3 * DAY_MS)
    expect(work.sweepIdleTodos().reminded).toEqual([])
    clock.advance(3 * DAY_MS)
    expect(work.sweepIdleTodos().reminded).toEqual([todo.id])
  })
})

describe('分配时防撞（40 §3.4）', () => {
  it('每日计划里撞上「别人正在做的」那几条不建议，理由是 in_progress_elsewhere', () => {
    const { kept, filtered } = filterCollidingSuggestions({
      suggestions: [
        {
          id: 'sug_1',
          kind: 'create',
          title: '核对昨天的退款单',
          reason: '目标落后',
          selected: true,
        },
        {
          id: 'sug_2',
          kind: 'create',
          title: '给供应商打电话催货',
          reason: '目标落后',
          selected: true,
        },
      ],
      in_progress: [
        {
          kind: 'todo',
          id: 'td_a',
          title: '核对昨天的退款单',
          owner: 'p_li',
          collaborators: [],
          status: 'doing',
          refs: [],
          item_kind: 'manual',
          started_at: '2026-09-09T01:00:00.000Z',
          last_activity: '2026-09-09T01:00:00.000Z',
          cards: 1,
        },
      ],
      person_id: 'p_chen',
      now: '2026-09-09T01:00:00.000Z',
      tz_offset_minutes: TZ,
    })
    expect(kept.map((s) => s.id)).toEqual(['sug_2'])
    expect(filtered).toEqual([
      {
        suggestion_id: 'sug_1',
        reason: 'in_progress_elsewhere',
        owner: 'p_li',
        conflicts_with: 'td_a',
      },
    ])
  })

  it('自己正在做的不算撞车（那本来就是他的活）', () => {
    const { work } = make()
    liIsBusy(work)
    const { plan, filtered } = work.todayPlanWithFilter({ person_id: 'p_li', goals: [] })
    expect(filtered).toEqual([])
    expect(plan.suggestions.length).toBeGreaterThanOrEqual(0)
  })

  it('别人正在做的那条不会出现在我的计划建议里', () => {
    const { work } = make()
    liIsBusy(work)
    // 陈晓的 backlog 里有一条与李默在做的重名
    work.createTodo({ title: '核对昨天的退款单', owner: 'p_chen', horizon: 'backlog' })
    const { plan } = work.todayPlanWithFilter({ person_id: 'p_chen', goals: [] })
    // 指着自己那条待办的建议照给（promote 有 todo_id，不算撞车）
    expect(
      plan.suggestions.every((s) => s.todo_id !== undefined || s.title !== '核对昨天的退款单'),
    ).toBe(true)
  })
})
