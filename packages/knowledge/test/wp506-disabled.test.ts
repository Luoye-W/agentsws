/**
 * WP506（决策 1789 B）：停用的知识条目**在检索层被排除**——长上下文档（整库注入）与关键词档都取不到；
 * `list` 缺省照样给（面板要看见才能启用回来），`enabled: true` 只给没停用的（Agent 取用的那几处）。
 * 启用回来原样；老库跑一次 migrate 就补上两列。
 */
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledge, type Knowledge, type KnowledgeEvent, migrate } from '../src/index.js'
import { activated, admin, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = (extra: Partial<Parameters<typeof createKnowledge>[0]> = {}) => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS, ...extra })
  open.push(k)
  return k
}

describe('WP506 停用的知识条目', () => {
  it('两档检索都排除停用的；启用回来照旧取得到，状态不变', async () => {
    const events: KnowledgeEvent[] = []
    const k = make({ emit: (e) => events.push(e) })
    const a = await activated(k, cardInput())
    const b = await activated(
      k,
      cardInput({
        subject: { type: 'fact_card', key: 'policy.return.window' },
        statement: '退货窗口 30 天，从签收算起',
      }),
    )
    const ids = async (mode: 'context' | 'lexical'): Promise<string[]> =>
      (await k.retrieval.search({ text: '退货', actor: admin(), mode })).hits
        .map((h) => h.fact_card_id)
        .sort()
    expect(await ids('context')).toEqual([a.id, b.id].sort())

    const off = await k.store.setDisabled(a.id, 'p_owner', true)
    expect(off.status).toBe('active')
    expect(off.disabled_by).toBe('p_owner')
    expect(off.disabled_at).toBeDefined()
    expect(await ids('context')).toEqual([b.id])
    expect(await ids('lexical')).toEqual([b.id])
    // precheck 的 matched 也只看候选集（停用的不算「库里有」）
    await k.store.setDisabled(b.id, 'p_owner', true)
    const pre = await k.retrieval.search({ text: '退货', actor: admin(), precheck: true })
    expect(pre.relevant).toBe(false)

    // 列表：缺省都给，`enabled: true` 只给没停用的
    expect(await k.store.list({ workspace_id: WS }, admin())).toHaveLength(2)
    expect(await k.store.list({ workspace_id: WS, enabled: true }, admin())).toHaveLength(0)

    const on = await k.store.setDisabled(a.id, 'p_owner', false)
    expect(on.disabled_at).toBeUndefined()
    expect(on.disabled_by).toBeUndefined()
    expect(await ids('context')).toEqual([a.id])
    expect(events.map((e) => e.type)).toEqual(
      expect.arrayContaining(['knowledge.card.disabled', 'knowledge.card.enabled']),
    )
  })

  it('已经是这个状态就不重写（updated_at 不跳）', async () => {
    const clock = testClock()
    const k = make({ clock })
    const a = await activated(k, cardInput())
    const off = await k.store.setDisabled(a.id, 'p_owner', true)
    clock.advanceDays(1)
    const again = await k.store.setDisabled(a.id, 'p_owner', true)
    expect(again.updated_at).toBe(off.updated_at)
    expect(again.disabled_at).toBe(off.disabled_at)
  })

  it('老库（没有停用那两列）跑一次 migrate 就补上，老卡当没停用', () => {
    const db = new Database(':memory:')
    migrate(db)
    db.exec('ALTER TABLE fact_cards DROP COLUMN disabled_at')
    db.exec('ALTER TABLE fact_cards DROP COLUMN disabled_by')
    const before = (db.prepare('PRAGMA table_info(fact_cards)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(before).not.toContain('disabled_at')
    migrate(db)
    const after = (db.prepare('PRAGMA table_info(fact_cards)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(after).toEqual(expect.arrayContaining(['disabled_at', 'disabled_by']))
    db.close()
  })
})
