/**
 * WP56 第 2 件：溯源链（48 §4 #6）。
 *
 * 分成三组：指纹抽得准不准（纯函数）、分层排序对不对（纯函数）、
 * 源页改了之后那条链走不走得通（落库）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildProvenanceForPrompt,
  createKnowledge,
  diffFactFingerprints,
  extractFactFingerprint,
  isCommitmentCard,
  type Knowledge,
  LAST_VERIFIED_UNKNOWN,
  rankByVerification,
  resolveProvenanceGrade,
  verificationTierRank,
} from '../src/index.js'
import { activated, admin, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = () => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS })
  open.push(k)
  return k
}

const keys = (fp: Record<string, string | number>) => Object.keys(fp).filter((k) => k !== 'version')

describe('事实指纹', () => {
  it('抽得出五类受管辖数值', () => {
    const fp = extractFactFingerprint(
      '退货窗口 30 天，退货运费由客户承担，重新入库费 $15，补偿上限 20%，结算币种 USD。',
    )
    expect(keys(fp)).toContain('duration:day:30')
    expect(keys(fp)).toContain('money:USD:15')
    expect(keys(fp)).toContain('percent:20')
    expect(keys(fp)).toContain('responsibility:payer_customer')
    expect(keys(fp)).toContain('responsibility:restocking_fee')
  })

  it('措辞 / 排版 / 链接 / 日期戳一律不产生指纹项', () => {
    const a = extractFactFingerprint('Returns within **30 days**. See https://x.com/policy')
    const b = extractFactFingerprint(
      '<p>Returns within 30 days.</p> Last updated 2026-07-25. [policy](https://y.com/p)',
    )
    expect(keys(a)).toEqual(keys(b))
    expect(diffFactFingerprints(a, b).material).toBe(false)
  })

  it('周归一化成天，2026 年不是期限', () => {
    expect(keys(extractFactFingerprint('2 weeks'))).toContain('duration:day:14')
    expect(keys(extractFactFingerprint('自 2026 年起'))).toEqual([])
  })

  it('¥ 没有上下文时只记币种不记金额（宁可漏判不误判）', () => {
    const fp = extractFactFingerprint('手续费 ¥30')
    expect(keys(fp)).toContain('currency:YEN_AMBIGUOUS')
    expect(keys(fp).some((k) => k.startsWith('money:'))).toBe(false)
    expect(keys(extractFactFingerprint('手续费 ¥30 人民币'))).toContain('money:CNY:30')
  })

  it('30 天 → 14 天是实质变更，只加一段包邮文案不是', () => {
    const before = extractFactFingerprint('退货窗口 30 天')
    expect(diffFactFingerprints(before, extractFactFingerprint('退货窗口 14 天')).material).toBe(
      true,
    )
    const added = diffFactFingerprints(
      before,
      extractFactFingerprint('退货窗口 30 天，满 $50 包邮'),
      {
        restrict_to_before_categories: true,
      },
    )
    expect(added.material).toBe(false)
  })

  it('词表升版一律判非实质（不让升版把全库刷成 stale）', () => {
    const before = { version: 1, 'duration:day:30': 30 }
    const after = { version: 2, 'duration:day:14': 14 }
    const verdict = diffFactFingerprints(before, after)
    expect(verdict.material).toBe(false)
    expect(verdict.version_mismatch).toBe(true)
  })

  it('任一侧抽不出事实就判非实质（只标 stale，不改口径）', () => {
    expect(
      diffFactFingerprints(
        extractFactFingerprint('退货窗口 30 天'),
        extractFactFingerprint('敬请期待'),
      ).material,
    ).toBe(false)
  })
})

describe('溯源分层', () => {
  it('等级是读取时派生的：有源 hash → tracked，有文档出处 → cited，其余 unverified', () => {
    expect(
      resolveProvenanceGrade({
        provenance: [{ source: 'human', ref: '王总说的', at: '2026-09-01T00:00:00.000Z' }],
        source_content_hash: 'h1',
      }),
    ).toBe('tracked')
    expect(
      resolveProvenanceGrade({
        provenance: [{ source: 'web', ref: 'https://x.com/p', at: '2026-09-01T00:00:00.000Z' }],
      }),
    ).toBe('cited')
    expect(
      resolveProvenanceGrade({
        provenance: [{ source: 'human', ref: '王总说的', at: '2026-09-01T00:00:00.000Z' }],
      }),
    ).toBe('unverified')
  })

  it('分层顺序冻结，层内保序，quarantined 被排除', () => {
    const items = [
      { id: 'u1', provenance_grade: 'unverified' as const },
      { id: 's1', provenance_grade: 'tracked' as const, verification_state: 'stale' as const },
      { id: 'c1', provenance_grade: 'cited' as const },
      {
        id: 'q1',
        provenance_grade: 'tracked' as const,
        verification_state: 'quarantined' as const,
      },
      { id: 't1', provenance_grade: 'tracked' as const },
      { id: 'c2', provenance_grade: 'cited' as const },
    ]
    expect(rankByVerification(items).map((x) => x.id)).toEqual(['t1', 'c1', 'c2', 'u1', 's1'])
    expect(
      verificationTierRank({ provenance_grade: 'tracked', verification_state: 'quarantined' }),
    ).toBe(null)
  })

  it('unverified 不阻断使用：它照样排在所有 stale 前面', () => {
    const ranked = rankByVerification([
      {
        id: 'stale_tracked',
        provenance_grade: 'tracked' as const,
        verification_state: 'stale' as const,
      },
      { id: 'unverified', provenance_grade: 'unverified' as const },
    ])
    expect(ranked.map((x) => x.id)).toEqual(['unverified', 'stale_tracked'])
  })
})

describe('prompt 渲染', () => {
  it('last_verified_at 为空时如实写「未记录」，绝不拿 created_at 冒充', async () => {
    const k = make()
    const card = await activated(k, cardInput())
    expect(card.created_at).not.toBe('')
    const rendered = buildProvenanceForPrompt(card)
    expect(rendered.last_verified_at).toBe(LAST_VERIFIED_UNKNOWN)
    expect(rendered.last_verified_at).not.toContain('2026-09-09')
  })

  it('有核实日期就渲染成日期（只到天）', async () => {
    const k = make()
    const card = await activated(k, cardInput({ last_verified_at: '2026-09-01T10:11:12.000Z' }))
    expect(buildProvenanceForPrompt(card).last_verified_at).toBe('2026-09-01')
  })
})

describe('承诺类永不自动激活', () => {
  it('policy 层与承诺类来源文件都算承诺类', () => {
    const p = { source: 'document' as const, ref: '08-policies.md', at: '2026-09-01T00:00:00.000Z' }
    expect(isCommitmentCard({ layer: 'policy', provenance: [p] })).toBe(true)
    expect(isCommitmentCard({ layer: 'fact', provenance: [p] })).toBe(true)
    expect(
      isCommitmentCard({
        layer: 'fact',
        provenance: [{ source: 'document', ref: '06-troubleshooting.md', at: p.at }],
      }),
    ).toBe(false)
  })

  it('Agent 自动激活承诺类被拦下，人点头照常放行', async () => {
    const k = make()
    const card = await k.store.propose(
      cardInput({
        provenance: [{ source: 'document', ref: '08-policies.md', at: '2026-09-01T00:00:00.000Z' }],
      }),
    )
    await expect(k.store.activate(card.id, 'per_owner', { by_agent: true })).rejects.toMatchObject({
      code: 'forbidden',
    })
    const ok = await k.store.activate(card.id, 'per_owner')
    expect(ok.status).toBe('active')
  })

  it('不是承诺类的，Agent 自动激活照旧', async () => {
    const k = make()
    const card = await k.store.propose(
      cardInput({
        subject: { type: 'fact_card', key: 'shipping.cutoff' },
        statement: '下午三点前的单当天发',
        structured: {},
        provenance: [
          { source: 'document', ref: '06-troubleshooting.md', at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    )
    expect((await k.store.activate(card.id, 'per_owner', { by_agent: true })).status).toBe('active')
  })
})

describe('源页复核', () => {
  const page30 = '# 退货政策\n\n德国站退货窗口 30 天，退货运费由客户承担。'
  const page30Reworded =
    '# 退货政策（2026 版）\n\n德国站的退货窗口是 **30 天**，退货运费由客户承担。'
  const page14 = '# 退货政策\n\n德国站退货窗口 14 天，退货运费由客户承担。'

  const setup = async () => {
    const k = make()
    const src = k.intake.addSource({
      workspace_id: WS,
      kind: 'website',
      ref: 'https://shop.example/returns',
      parser: 'html',
    })
    const card = await activated(
      k,
      cardInput({
        statement: '德国站退货窗口 30 天，退货运费由客户承担',
        structured: { return_window_days: 30 },
        provenance: [
          { source: 'web', ref: 'https://shop.example/returns', at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    )
    // 第一次同步：只记 hash
    const first = await k.recheck.syncSource({ source: src, content: page30 })
    expect(first.plan.first_sync).toBe(true)
    const synced = k.intake.markSynced(src.id, 1, first.plan.content_hash)
    return { k, src: synced, card }
  }

  it('内容 hash 没变 → 什么都不做', async () => {
    const { k, src } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page30 })
    expect(res.plan.changed).toBe(false)
    expect(res.rechecks).toHaveLength(0)
  })

  it('改了措辞、受管辖数值没变 → 自动回鲜，只记 source_changed_at', async () => {
    const { k, src, card } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page30Reworded })
    expect(res.plan.changed).toBe(true)
    expect(res.refreshed).toContain(card.id)
    expect(res.rechecks).toHaveLength(0)
    const after = k.store.getUnchecked(card.id)
    expect(after?.verification_state).toBe('fresh')
    expect(after?.source_changed_at).not.toBeUndefined()
    // 口径一个字没动
    expect(after?.statement).toBe(card.statement)
  })

  it('30 天 → 14 天 → 派生卡 stale + 一张复核卡，口径先不动', async () => {
    const { k, src, card } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page14 })
    expect(res.stale).toContain(card.id)
    expect(res.rechecks).toHaveLength(1)
    const after = k.store.getUnchecked(card.id)
    expect(after?.verification_state).toBe('stale')
    expect(after?.statement).toBe(card.statement)
    expect(res.rechecks[0]?.categories).toContain('duration')
  })

  it('同一页连改两次只开一张复核卡', async () => {
    const { k, src } = await setup()
    await k.recheck.syncSource({ source: src, content: page14 })
    const again = await k.recheck.syncSource({ source: src, content: '退货窗口 7 天' })
    expect(k.recheck.list(WS, { status: 'open' })).toHaveLength(1)
    expect(again.rechecks).toHaveLength(1)
  })

  it('答「确认没变」→ 卡回鲜，last_verified_at 记到今天', async () => {
    const { k, src, card } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page14 })
    const id = res.rechecks[0]?.id as string
    await k.recheck.resolve(id, { resolution: 'unchanged', by: 'per_owner' })
    const after = k.store.getUnchecked(card.id)
    expect(after?.verification_state).toBe('fresh')
    expect(after?.last_verified_at).toBe('2026-09-09T09:00:00.000Z')
    expect(after?.statement).toBe(card.statement)
  })

  it('答「按新值更新」→ 卡回鲜换成新口径，旧值进历史案例', async () => {
    const { k, src, card } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page14 })
    const id = res.rechecks[0]?.id as string
    const out = await k.recheck.resolve(id, { resolution: 'adopt_new', by: 'per_owner' })
    const after = k.store.getUnchecked(card.id)
    expect(after?.verification_state).toBe('fresh')
    expect(after?.statement).toContain('14 天')
    const archived = k.store.getUnchecked(out.archived_card_id as string)
    expect(archived?.layer).toBe('historical_case')
    expect(archived?.statement).toContain('30 天')
    expect(archived?.as_of).not.toBeUndefined()
  })

  it('答「忽略」→ 卡留在 stale（源确实变了，不当它没发生）', async () => {
    const { k, src, card } = await setup()
    const res = await k.recheck.syncSource({ source: src, content: page14 })
    await k.recheck.resolve(res.rechecks[0]?.id as string, {
      resolution: 'ignore',
      by: 'per_owner',
    })
    expect(k.store.getUnchecked(card.id)?.verification_state).toBe('stale')
  })

  it('隔离态只有人能解除：源再变也不动它', async () => {
    const { k, src, card } = await setup()
    await k.store.patch(card.id, { verification_state: 'quarantined' })
    const res = await k.recheck.syncSource({ source: src, content: page14 })
    expect(res.stale).toHaveLength(0)
    expect(k.store.getUnchecked(card.id)?.verification_state).toBe('quarantined')
  })

  it('四条事件都发得出来', async () => {
    const seen: string[] = []
    const k = createKnowledge({
      clock: testClock(),
      workspace_id: WS,
      emit: (e) => seen.push(e.type),
    })
    open.push(k)
    const src = k.intake.addSource({
      workspace_id: WS,
      kind: 'website',
      ref: 'https://shop.example/returns',
      parser: 'html',
    })
    const card = await activated(
      k,
      cardInput({
        statement: '德国站退货窗口 30 天',
        provenance: [
          { source: 'web', ref: 'https://shop.example/returns', at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    )
    const first = await k.recheck.syncSource({ source: src, content: page30 })
    const synced = k.intake.markSynced(src.id, 1, first.plan.content_hash)
    const res = await k.recheck.syncSource({ source: synced, content: page14 })
    await k.recheck.resolve(res.rechecks[0]?.id as string, {
      resolution: 'adopt_new',
      by: 'per_owner',
    })
    expect(seen).toContain('knowledge.card.stale')
    expect(seen).toContain('knowledge.recheck.opened')
    expect(seen).toContain('knowledge.card.refreshed')
    expect(seen).toContain('knowledge.recheck.resolved')
    expect(card.id).not.toBe('')
  })

  it('stale 仍然检索得到（降权不是下架），quarantined 才排除', async () => {
    const { k, src, card } = await setup()
    await k.recheck.syncSource({ source: src, content: page14 })
    const hit = await k.retrieval.search({ text: '退货窗口', actor: admin() })
    expect(hit.hits.some((h) => h.fact_card_id === card.id)).toBe(true)
    await k.store.patch(card.id, { verification_state: 'quarantined' })
    const after = await k.retrieval.search({ text: '退货窗口', actor: admin() })
    expect(after.hits.some((h) => h.fact_card_id === card.id)).toBe(false)
  })
})
