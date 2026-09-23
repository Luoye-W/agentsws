import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Collaboration, Creator, PlatformAccount, TrackedLink } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createKolStore, KOL_TABLES } from '../src/kol.js'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-kol-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const creator = (id: string, name: string): Creator => ({
  id,
  display_name: name,
  merged_from: [],
})
const account = (id: string, creator_id: string, over: Partial<PlatformAccount> = {}) =>
  ({
    id,
    creator_id,
    channel: 'youtube',
    handle: 'jonas',
    url: 'https://www.youtube.com/@jonas',
    observed_at: '2026-09-15T00:00:00Z',
    ...over,
  }) as PlatformAccount
const collab = (id: string, creator_id: string, over: Partial<Collaboration> = {}): Collaboration =>
  ({
    id,
    creator_id,
    channel: 'youtube',
    stage: 'sourced',
    currency: 'USD',
    ...over,
  }) as Collaboration

describe('红人库存储（48 §5.2 数据面，WP67）', () => {
  it('十一张表：名字与对象类型一一对应（exchange 是 WP117b 加的往来；后四张是 WP119c 给插件面板加的）', () => {
    expect([...KOL_TABLES]).toEqual([
      'creator',
      'platform_account',
      'creator_contact',
      'collaboration',
      'deliverable',
      'tracked_link',
      'exchange',
      'account_observation',
      'content',
      'content_observation',
      'bio_link_observation',
    ])
  })

  it('内存档与 sqlite 档行为一样，而且 sqlite 关了再开数据还在', () => {
    const dir = tmp()
    const first = createKolStore({ workspace_id: 'ws_1', dbDir: dir })
    first.saveCreator(creator('cre_1', 'Jonas'))
    first.saveAccount(account('pa_1', 'cre_1'))
    first.close()

    const again = createKolStore({ workspace_id: 'ws_1', dbDir: dir })
    expect(again.creator('cre_1')?.display_name).toBe('Jonas')
    expect(again.accounts({ creator_id: 'cre_1' })).toHaveLength(1)
    again.close()
  })

  it('两个品牌各一套库：A 写的东西 B 一条都读不到（WP66 每品牌分目录）', () => {
    const a = createKolStore({ workspace_id: 'ws_a', dbDir: tmp() })
    const b = createKolStore({ workspace_id: 'ws_b', dbDir: tmp() })
    a.saveCreator(creator('cre_1', 'Jonas'))
    expect(a.creators()).toHaveLength(1)
    expect(b.creators()).toEqual([])
    a.close()
    b.close()
  })

  it('按渠道 / 阶段筛合作：同一个人两条渠道是两条合作', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    s.saveCollaboration(collab('col_1', 'cre_1', { channel: 'youtube', stage: 'agreed' }))
    s.saveCollaboration(collab('col_2', 'cre_1', { channel: 'instagram', stage: 'sourced' }))
    expect(s.collaborations({ channel: 'youtube' })).toHaveLength(1)
    expect(s.collaborations({ stage: 'sourced' }).map((c) => c.id)).toEqual(['col_2'])
    expect(s.collaborations()).toHaveLength(2)
    s.close()
  })

  it('「待审交付物」只算 pending：要求修改那条球在对方那边', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    for (const [id, review] of [
      ['dlv_1', 'pending'],
      ['dlv_2', 'changes_requested'],
      ['dlv_3', 'approved'],
    ] as const)
      s.saveDeliverable({
        id,
        collaboration_id: 'col_1',
        kind: 'video',
        due_at: '2026-10-01T00:00:00Z',
        review,
      })
    expect(s.deliverables({ pending: true }).map((d) => d.id)).toEqual(['dlv_1'])
    expect(s.deliverables({ collaboration_id: 'col_1' })).toHaveLength(3)
    s.close()
  })

  it('归因回填那三个数；链接不在就什么也不做，不凭空建一条', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    const link: TrackedLink = {
      id: 'tl_1',
      collaboration_id: 'col_1',
      url: 'https://shop.example/p/1',
      utm: { source: 'youtube', medium: 'kol', campaign: 'autumn', content: 'col_1' },
      clicks: 0,
      orders: 0,
      revenue: 0,
    }
    s.saveLink(link)
    s.recordAttribution({ tracked_link_id: 'tl_1', clicks: 120, orders: 3, revenue: 387.5 })
    expect(s.links('col_1')[0]).toMatchObject({ clicks: 120, orders: 3, revenue: 387.5 })

    s.recordAttribution({ tracked_link_id: 'tl_nope', orders: 9, revenue: 9 })
    expect(s.links()).toHaveLength(1)
    s.close()
  })

  it('合并：账号 / 联系方式 / 合作一起改挂，被合掉那条删掉，id 留在 merged_from 里', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    s.saveCreator(creator('cre_1', 'Jonas'))
    s.saveCreator(creator('cre_2', 'Jonas G'))
    s.saveAccount(account('pa_1', 'cre_1'))
    s.saveAccount(account('pa_2', 'cre_2', { channel: 'instagram' }))
    s.saveContact({
      id: 'cc_1',
      creator_id: 'cre_2',
      kind: 'email',
      value_ref: 'kol:contact:cc_1',
      source: 'import',
    })
    s.saveCollaboration(collab('col_1', 'cre_2', { channel: 'instagram' }))

    const merged = s.merge({ keep_id: 'cre_1', merge_id: 'cre_2' })
    expect(merged?.merged_from).toEqual(['cre_2'])
    expect(s.creator('cre_2')).toBeUndefined()
    // 一条孤儿都不许剩下
    expect(s.accounts({ creator_id: 'cre_1' })).toHaveLength(2)
    expect(s.contacts('cre_1')).toHaveLength(1)
    expect(s.collaborations().every((c) => c.creator_id === 'cre_1')).toBe(true)
    s.close()
  })

  it('合并的两条有一条不在就什么都不做（不半迁一半）', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    s.saveCreator(creator('cre_1', 'Jonas'))
    s.saveAccount(account('pa_1', 'cre_1'))
    expect(s.merge({ keep_id: 'cre_1', merge_id: 'cre_nope' })).toBeUndefined()
    expect(s.accounts({ creator_id: 'cre_1' })).toHaveLength(1)
    s.close()
  })

  it('联系方式存的是加密库 key 名，库里一个明文地址都没有', () => {
    const s = createKolStore({ workspace_id: 'ws_1' })
    s.saveContact({
      id: 'cc_1',
      creator_id: 'cre_1',
      kind: 'email',
      value_ref: 'kol:contact:cc_1',
      source: 'channel_about',
    })
    expect(JSON.stringify(s.contacts())).not.toContain('@')
    s.close()
  })
})
