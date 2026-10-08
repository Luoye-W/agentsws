/**
 * WP275（决策 259）：① 个人里进待认领池的活直接记到唯一那个人名下——
 * 不进「待认领」、不用点「我来」；② ③（或不知道）照旧进池。模式变了下一条就跟着变。
 */
import { describe, expect, it } from 'vitest'
import { claimOf, UNCLAIMED_OWNER } from '../src/claim.js'
import { createWork } from '../src/service.js'
import { FakeClock, seeded } from './helpers.js'

function make(sole: { current: string | undefined }) {
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const work = createWork({
    workspace_id: 'ws_1',
    clock: new FakeClock(),
    random: seeded(11),
    tz_offset_minutes: 480,
    soleOwner: () => sole.current,
    emit: (e) => {
      events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
    },
  })
  return { work, events }
}

describe('WP275 ① 进池的活直接是你的', () => {
  it('① 个人：记到唯一那个人名下，池里没有、待办箱里有；认领记录照写', () => {
    const sole = { current: 'p_wang' as string | undefined }
    const { work, events } = make(sole)
    const matter = work.createMatter({ kind: 'conversation', title: '周会', participants: [] })
    const todo = work.poolTodo({
      title: '把上周的退款汇总一下',
      source: 'meeting',
      matter_id: matter.id,
    })
    expect(todo.owner).toBe('p_wang')
    expect(claimOf(todo).state).toBe('claimed')
    expect(claimOf(todo).pooled_at).toBeDefined()
    expect(work.pool()).toHaveLength(0)
    expect(work.listTodos({ owner: 'p_wang' }).map((t) => t.id)).toContain(todo.id)
    const pooled = events.find((e) => e.type === 'todo.pooled')
    expect(pooled?.payload.sole_owner).toBe(true)
  })

  it('② ③（不给人）：照旧进池等人认', () => {
    const sole = { current: 'p_wang' as string | undefined }
    const { work } = make(sole)
    sole.current = undefined // 第二个人进来了
    const todo = work.poolTodo({ title: '盘一下上月库存差异' })
    expect(todo.owner).toBe(UNCLAIMED_OWNER)
    expect(work.pool()).toHaveLength(1)
  })
})
