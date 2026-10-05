/**
 * WP224（Luoye 10-05）：毛利率事实卡**按职责白名单**才看得到——负责人、店铺管理、投放四条；
 * 客服、社媒、公关、红人这些对外说话的岗位检索不到（过滤下推：检索、list、get 三处都零命中）。
 */
import { GROSS_MARGIN_SUBJECT_TYPE, GROSS_MARGIN_VISIBLE_ROLES } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createKnowledge, type GrantedActor, type Knowledge } from '../src/index.js'
import { activated, aftersales, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})

/** 与客服同样的知识读权限，只换职责（证明拦它的是职责白名单，不是数据域 / 敏感度）。 */
const as = (role_id: string): GrantedActor => ({
  ...aftersales(),
  person_id: `per_${role_id}`,
  assignment_id: `asg_${role_id}`,
  role_id,
})

async function seeded(): Promise<{ k: Knowledge; marginId: string }> {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS })
  open.push(k)
  const margin = await activated(
    k,
    cardInput({
      domain: 'company',
      scope: [],
      subject: { type: GROSS_MARGIN_SUBJECT_TYPE, id: 'brand', key: 'gross_margin:brand' },
      statement: '整个品牌的毛利率是 40%（负责人在公司页填写）',
      structured: { scope: 'brand', margin_pct: 40 },
    }),
  )
  // 一张普通事实卡：谁都照旧看得到
  await activated(k, cardInput({ domain: 'company', scope: [], statement: '德国站退货窗口 14 天' }))
  return { k, marginId: margin.id }
}

describe('毛利率事实卡：按职责白名单', () => {
  it('白名单就是负责人、店铺管理、投放四条', () => {
    expect([...GROSS_MARGIN_VISIBLE_ROLES].sort()).toEqual(
      ['ads.google', 'ads.meta', 'ads.tiktok', 'ads.x', 'common.owner', 'dtc.store'].sort(),
    )
  })

  it('客服检索不到、list 不到、get 不到；普通事实卡照旧看得到', async () => {
    const { k, marginId } = await seeded()
    const support = as('dtc.support')
    const hits = await k.retrieval.search({ text: '毛利率', actor: support })
    expect(hits.hits.map((h) => h.fact_card_id)).not.toContain(marginId)
    const listed = await k.store.list({ workspace_id: WS }, support)
    expect(listed.map((c) => c.subject.type)).not.toContain(GROSS_MARGIN_SUBJECT_TYPE)
    expect(listed.length).toBe(1)
    expect(await k.store.get(marginId, support)).toBeUndefined()
  })

  it('社媒、公关、红人也检索不到', async () => {
    const { k, marginId } = await seeded()
    for (const role of ['social.instagram', 'pr.monitoring', 'kol.youtube']) {
      const hits = await k.retrieval.search({ text: '毛利率', actor: as(role) })
      expect(
        hits.hits.map((h) => h.fact_card_id),
        role,
      ).not.toContain(marginId)
    }
  })

  it('投放、店铺、负责人检索得到', async () => {
    const { k, marginId } = await seeded()
    for (const role of ['ads.meta', 'ads.google', 'dtc.store', 'common.owner']) {
      const hits = await k.retrieval.search({ text: '毛利率', actor: as(role) })
      expect(
        hits.hits.map((h) => h.fact_card_id),
        role,
      ).toContain(marginId)
      expect((await k.store.get(marginId, as(role)))?.id, role).toBe(marginId)
    }
  })
})
