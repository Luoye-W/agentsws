/**
 * 40 §1.2 / E1「个人数据也在公司库，但管理员只有迁移 / 归档 / 销毁三个动作，没有读」。
 *
 * 这三个方法的签名本身就是那条规则：它们只回**条数**，一个字的正文都不返回。
 */
import type { ObjectRef } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledge, type Knowledge } from '../src/index.js'
import { memoryFact, testClock, WS } from './fixtures.js'

const LEAVER: ObjectRef = { type: 'person', id: 'p_limo' }
const SUCCESSOR: ObjectRef = { type: 'person', id: 'p_wanglan' }
const OTHER_WS = 'ws_2'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})

const make = (): Knowledge => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS })
  open.push(k)
  return k
}

/** 一条工作相关的（带本工作区域引用）+ 一条别的工作区的（属于他自己）。 */
const seed = async (k: Knowledge): Promise<void> => {
  await k.memory.write([
    memoryFact({ key: 'customer_pref', value: '只收邮件', subject: LEAVER, workspace_id: WS }),
  ])
  await k.memory.write([
    memoryFact({ key: 'my_habit', value: '早上先看队列', subject: LEAVER, workspace_id: OTHER_WS }),
  ])
}

describe('个人记忆的迁移 / 销毁（管理员没有读）', () => {
  it('countSubject 按「工作相关 / 其余」分开数，只回数字', async () => {
    const k = make()
    await seed(k)
    expect(k.memory.countSubject(LEAVER, { workspace_id: WS })).toEqual({
      total: 2,
      work: 1,
      personal: 1,
    })
    expect(k.memory.countSubject({ type: 'person', id: 'p_nobody' })).toEqual({
      total: 0,
      work: 0,
      personal: 0,
    })
  })

  it('migrateSubject 只搬本工作区的那些；他自己的留在原处', async () => {
    const k = make()
    await seed(k)
    expect(k.memory.migrateSubject(LEAVER, SUCCESSOR, { workspace_id: WS })).toBe(1)
    expect(k.memory.countSubject(LEAVER).total).toBe(1)
    const moved = await k.memory.recall(SUCCESSOR, { workspace_id: WS })
    expect(moved.map((f) => f.key)).toEqual(['customer_pref'])
    // 幂等：再搬一次是 0 条
    expect(k.memory.migrateSubject(LEAVER, SUCCESSOR, { workspace_id: WS })).toBe(0)
  })

  it('eraseSubject 三档：本工作区 / 其余 / 全部', async () => {
    const a = make()
    await seed(a)
    expect(a.memory.eraseSubject(LEAVER, { workspace_id: WS, scope: 'workspace' })).toBe(1)
    expect(a.memory.countSubject(LEAVER).total).toBe(1)

    const b = make()
    await seed(b)
    expect(b.memory.eraseSubject(LEAVER, { workspace_id: WS, scope: 'other' })).toBe(1)
    expect(b.memory.countSubject(LEAVER, { workspace_id: WS })).toMatchObject({ work: 1 })

    const c = make()
    await seed(c)
    expect(c.memory.eraseSubject(LEAVER)).toBe(2)
    expect(c.memory.countSubject(LEAVER).total).toBe(0)
    expect(await c.memory.recall(LEAVER, { workspace_id: WS })).toHaveLength(0)
  })

  it('没有默认工作区、也没显式给 → 迁移与按范围擦除都是 0 条（不猜）', async () => {
    const k = createKnowledge({ clock: testClock() })
    open.push(k)
    await k.memory.write([memoryFact({ subject: LEAVER, workspace_id: WS })])
    expect(k.memory.migrateSubject(LEAVER, SUCCESSOR)).toBe(0)
    expect(k.memory.eraseSubject(LEAVER, { scope: 'workspace' })).toBe(0)
    expect(k.memory.countSubject(LEAVER)).toMatchObject({ total: 1, work: 0, personal: 1 })
  })
})
