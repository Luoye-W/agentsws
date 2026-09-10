/**
 * 05 §3 `handover` 的「真转」（40 §1.2 第三条规则、E2）。
 *
 * 05 一直只把 `handover_to` 透传给撤销的那条分配，在办的事项与未完的待办一条都不动；
 * 这几条用例钉的就是它现在真的动了，而且**只动该动的那些**。
 */
import { describe, expect, it } from 'vitest'
import { createWork } from '../src/index.js'
import { FakeClock, seeded } from './helpers.js'

const WS = 'ws_1'
const LEAVER = 'p_limo'
const SUCCESSOR = 'p_wanglan'

const make = () => {
  const clock = new FakeClock()
  return {
    clock,
    work: createWork({ workspace_id: WS, clock, random: seeded(), tz_offset_minutes: 480 }),
  }
}

describe('Work.handover：在办的事项与未完的待办真转接手人', () => {
  it('参与者换人、未完待办换主人，时间线上留一行', () => {
    const { work } = make()
    const matter = work.createMatter({
      kind: 'conversation',
      title: '退款单核对',
      participants: [LEAVER, 'p_other'],
    })
    const open = work.createTodo({ title: '核对退款单', owner: LEAVER, matter_id: matter.id })

    const out = work.handover({ from: LEAVER, to: SUCCESSOR, by: 'p_owner', reason: '李默离职' })

    expect(out.matters).toEqual([matter.id])
    expect(out.todos).toEqual([open.id])
    expect(work.requireMatter(matter.id).context.participants).toEqual([SUCCESSOR, 'p_other'])
    expect(work.requireTodo(open.id).owner).toBe(SUCCESSOR)
    const timeline = work.matterView(matter.id).timeline
    expect(timeline.some((e) => e.kind === 'status' && e.text.includes('李默离职'))).toBe(true)
    expect(timeline.some((e) => e.kind === 'todo' && e.text.startsWith('待办交接'))).toBe(true)
  })

  it('历史不改主人：关掉的事项、做完 / 放弃的待办一条都不动', () => {
    const { work } = make()
    const closed = work.createMatter({ kind: 'adhoc', title: '已经结了', participants: [LEAVER] })
    work.closeMatter(closed.id, { unfinished: 'keep' })
    const done = work.createTodo({ title: '做完的', owner: LEAVER })
    work.complete(done.id)
    const dropped = work.createTodo({ title: '放弃的', owner: LEAVER })
    work.drop(dropped.id)

    const out = work.handover({ from: LEAVER, to: SUCCESSOR })

    expect(out.matters).toHaveLength(0)
    expect(out.todos).toHaveLength(0)
    expect(work.requireTodo(done.id).owner).toBe(LEAVER)
    expect(work.requireTodo(dropped.id).owner).toBe(LEAVER)
    expect(work.requireMatter(closed.id).context.participants).toEqual([LEAVER])
  })

  it('幂等：再跑一次是 0 条（离职动作「可重跑」靠这一条）', () => {
    const { work } = make()
    work.createMatter({ kind: 'adhoc', title: '在办', participants: [LEAVER] })
    work.createTodo({ title: '没做完', owner: LEAVER })

    const first = work.handover({ from: LEAVER, to: SUCCESSOR })
    expect(first.matters).toHaveLength(1)
    expect(first.todos).toHaveLength(1)

    const second = work.handover({ from: LEAVER, to: SUCCESSOR })
    expect(second.matters).toHaveLength(0)
    expect(second.todos).toHaveLength(0)
  })

  it('接手人已经在参与者里 → 不重复加一遍', () => {
    const { work } = make()
    const matter = work.createMatter({
      kind: 'adhoc',
      title: '两个人一起做的',
      participants: [LEAVER, SUCCESSOR],
    })
    work.handover({ from: LEAVER, to: SUCCESSOR })
    expect(work.requireMatter(matter.id).context.participants).toEqual([SUCCESSOR])
  })

  it('待办挂在别的库里没有的事项上 → 照样换主人，不炸', () => {
    const { work } = make()
    const matter = work.createMatter({ kind: 'adhoc', title: '有事项的', participants: ['p_x'] })
    const todo = work.createTodo({ title: '挂着的', owner: LEAVER, matter_id: matter.id })
    const out = work.handover({ from: LEAVER, to: SUCCESSOR })
    expect(out.todos).toEqual([todo.id])
    expect(work.requireTodo(todo.id).owner).toBe(SUCCESSOR)
  })
})
