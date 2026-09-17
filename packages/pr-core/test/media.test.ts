/**
 * WP78（60 §2 `media.ts`）：媒体名单、两封序列、日配额与抑制名单。
 *
 * 规则本身是 48 §5.2 / WP55 那一套，一个字没改——改的只有"发给谁""发几封"。
 */
import { describe, expect, it } from 'vitest'
import { maskEmail, nextPitch, pitchFunnel, pitchQuota, selectPitchTargets } from '../src/index.js'

const now = '2026-09-17T09:00:00Z'
const hoursAgo = (h: number) => new Date(Date.parse(now) - h * 3_600_000).toISOString()

describe('日配额（最近 24 小时，不是自然日）', () => {
  it('没发过就是满额', () => {
    expect(pitchQuota({ cap: 20, sent_at: [], now })).toMatchObject({
      remaining: 20,
      allowed: true,
    })
  })

  it('25 小时前那封不算在今天头上', () => {
    const q = pitchQuota({ cap: 2, sent_at: [hoursAgo(25), hoursAgo(1)], now })
    expect(q.sent_today).toBe(1)
    expect(q.remaining).toBe(1)
  })

  it('用满了就停', () => {
    expect(pitchQuota({ cap: 1, sent_at: [hoursAgo(1)], now }).allowed).toBe(false)
  })
})

describe('序列：两封，不是三封', () => {
  const base = { contact: 'a@x.example', suppressed: [] as string[] }

  it('还没发过 → 首封', () => {
    expect(nextPitch({ ...base, stage: 'new', sent: [] })?.step).toBe('first')
  })

  it('发过首封 → 四天后跟进一封', () => {
    const r = nextPitch({
      ...base,
      stage: 'pitched',
      sent: [{ step: 'first', at: '2026-09-13T09:00:00Z' }],
    })
    expect(r?.step).toBe('follow_up')
    expect(r?.due_at).toBe('2026-09-17T09:00:00.000Z')
  })

  it('跟进也发过了 → 没有第三封', () => {
    expect(
      nextPitch({
        ...base,
        stage: 'pitched',
        sent: [
          { step: 'first', at: hoursAgo(200) },
          { step: 'follow_up', at: hoursAgo(100) },
        ],
      }),
    ).toBeUndefined()
  })

  it('回了 / 写了我们 / 明说不写 / 在抑制名单上 → 都没有下一封', () => {
    expect(nextPitch({ ...base, stage: 'replied', sent: [] })).toBeUndefined()
    expect(nextPitch({ ...base, stage: 'covered', sent: [] })).toBeUndefined()
    expect(nextPitch({ ...base, stage: 'declined', sent: [] })).toBeUndefined()
    expect(
      nextPitch({ ...base, stage: 'new', sent: [], suppressed: ['A+tag@X.example'] }),
    ).toBeUndefined()
  })
})

describe('今天该给谁发', () => {
  const quota = pitchQuota({ cap: 2, sent_at: [], now })
  const candidates = [
    { id: 'm1', beats: ['消费电子'], stage: 'new' as const },
    { id: 'm2', beats: ['户外装备'], stage: 'new' as const },
    { id: 'm3', beats: ['消费电子'], stage: 'pitched' as const },
    { id: 'm4', beats: ['消费电子'], stage: 'new' as const },
    { id: 'm5', beats: ['消费电子'], stage: 'new' as const },
  ]
  const contacts = {
    m1: 'a@x.example',
    m2: 'b@x.example',
    m3: 'c@x.example',
    m4: 'd@x.example',
    m5: 'e@x.example',
  }

  it('四条一起判，每个被剔掉的都说得出原因', () => {
    const r = selectPitchTargets({
      candidates,
      contacts: { ...contacts, m1: '' },
      suppressed: ['D@x.example'],
      beats: ['消费电子'],
      quota,
    })
    const reasons = Object.fromEntries(r.skipped.map((s) => [s.contact_id, s.reason]))
    expect(reasons.m1).toBe('no_contact')
    expect(reasons.m2).toBe('beat_mismatch')
    expect(reasons.m3).toBe('already_in_sequence')
    expect(reasons.m4).toBe('suppressed')
    expect(r.picked.map((p) => p.contact_id)).toEqual(['m5'])
  })

  it('日配额到顶就停，剩下的记成 quota', () => {
    const r = selectPitchTargets({
      candidates,
      contacts,
      suppressed: [],
      quota: pitchQuota({ cap: 1, sent_at: [], now }),
    })
    expect(r.picked).toHaveLength(1)
    expect(r.skipped.filter((s) => s.reason === 'quota')).toHaveLength(3)
  })

  it('不给领域标签就不按领域筛（宁可多发一个，也不要一封都不发）', () => {
    const r = selectPitchTargets({ candidates, contacts, suppressed: [], quota })
    expect(r.picked.map((p) => p.contact_id)).toEqual(['m1', 'm2'])
  })
})

describe('漏斗与脱敏', () => {
  it('六档都出一行，没人的那一档是 0', () => {
    const rows = pitchFunnel([{ stage: 'new' }, { stage: 'covered' }, { stage: 'new' }])
    expect(rows).toHaveLength(6)
    expect(rows[0]).toMatchObject({ stage: 'new', count: 2 })
    expect(rows.find((r) => r.stage === 'replied')?.count).toBe(0)
  })

  it('脱敏够人认出是哪一个，不足以拿去发信', () => {
    expect(maskEmail('alice@press.example')).toBe('a***@press.example')
    expect(maskEmail('nonsense')).toBe('***')
  })
})
