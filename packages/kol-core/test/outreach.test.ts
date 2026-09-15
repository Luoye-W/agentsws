import { KOL_OUTREACH_FORBIDDEN } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import {
  draftOutreach,
  nextInSequence,
  type OutreachVars,
  outreachQuota,
  reviewOutreachBody,
  SEQUENCE_DAYS,
  scanForbiddenPromises,
  selectOutreachTargets,
} from '../src/index.js'

const vars: OutreachVars = {
  creator_name: 'Jonas',
  brand: 'Nordvolt',
  brand_pitch: '我们做桌面充电这一类东西。',
  product: 'Nordvolt 65W 充电器',
  reason: '你那条讲桌面收纳的视频里正好缺一个充电位，',
  sender_name: '李默',
  channel: 'youtube',
}

describe('开发信起草（48 §5.2）', () => {
  it('三封模板都起得出来，而且本身一个承诺词都没有', () => {
    for (const step of ['first', 'follow_up', 'final'] as const) {
      const d = draftOutreach(step, vars)
      expect(d.ok, step).toBe(true)
      expect(d.forbidden_hits, step).toEqual([])
      expect(d.subject.length, step).toBeGreaterThan(0)
      expect(d.body, step).toContain('Jonas')
      expect(d.body, step).toContain('Nordvolt')
    }
  })

  it('收尾那封写明不再打扰——序列里没有第四封', () => {
    expect(draftOutreach('final', vars).body).toContain('最后一封')
  })

  it('渠道换了说法就换：YouTube 说"频道"，X 说"账号"', () => {
    expect(draftOutreach('first', vars).body).toContain('频道')
    expect(draftOutreach('first', { ...vars, channel: 'x' }).body).toContain('账号')
  })

  it('变量缺了就不起草：拿一封写着 {{product}} 的信去问人要不要发更糟', () => {
    const d = draftOutreach('first', { ...vars, product: '  ' })
    expect(d.ok).toBe(false)
    expect(d.missing_vars).toEqual(['product'])
    expect(d.body).toBe('')
  })
})

describe('禁承诺（48 §5.1）', () => {
  it('词表就是 core 里那一份，不抄第二张', () => {
    expect(scanForbiddenPromises('我们付你 800 美元')).toEqual(['我们付你'])
    expect(KOL_OUTREACH_FORBIDDEN).toContain('我们付你')
  })

  it('大小写不敏感，三类都扫得到', () => {
    expect(scanForbiddenPromises('We Will Pay you later')).toContain('we will pay')
    expect(scanForbiddenPromises('FREE SAMPLE for you')).toContain('free sample')
    expect(scanForbiddenPromises('这一条保证出单')).toContain('保证出单')
  })

  it('改过之后要再扫一遍——模板干净不等于这一封干净', () => {
    const base = draftOutreach('first', vars)
    const edited = { subject: base.subject, body: `${base.body}\n对了，我们付你 500 刀。` }
    const r = reviewOutreachBody(edited)
    expect(r.ok).toBe(false)
    expect(r.forbidden_hits).toContain('我们付你')
    // 一句人话，而且说清楚该怎么办
    expect(r.message).toContain('建一条合作')
  })

  it('干净的信复查放行，`message` 是空串', () => {
    const base = draftOutreach('follow_up', vars)
    expect(reviewOutreachBody(base)).toEqual({ ok: true, forbidden_hits: [], message: '' })
  })
})

describe('日配额与序列', () => {
  const now = '2026-09-15T12:00:00Z'
  const hoursAgo = (n: number): string => new Date(Date.parse(now) - n * 3_600_000).toISOString()

  it('配额只看最近 24 小时（昨天发的不算今天的）', () => {
    const q = outreachQuota({ cap: 30, sent_at: [hoursAgo(1), hoursAgo(5), hoursAgo(30)], now })
    expect(q.sent_today).toBe(2)
    expect(q.remaining).toBe(28)
    expect(q.allowed).toBe(true)
  })

  it('到顶就 allowed: false（真正的拦在 guardrail，这里的数是给卡面看的）', () => {
    const q = outreachQuota({ cap: 2, sent_at: [hoursAgo(1), hoursAgo(2)], now })
    expect(q).toMatchObject({ remaining: 0, allowed: false })
  })

  it('序列三封：首封 → 3 天跟进 → 7 天收尾', () => {
    expect(SEQUENCE_DAYS).toEqual({ first: 0, follow_up: 3, final: 7 })
    const first = { step: 'first' as const, at: '2026-09-01T00:00:00Z' }
    const second = nextInSequence({
      sent: [first],
      replied: false,
      contact: 'a@x.com',
      suppressed: [],
    })
    expect(second?.step).toBe('follow_up')
    expect(second?.due_at).toBe('2026-09-04T00:00:00.000Z')
    const third = nextInSequence({
      sent: [first, { step: 'follow_up', at: '2026-09-04T00:00:00Z' }],
      replied: false,
      contact: 'a@x.com',
      suppressed: [],
    })
    expect(third?.step).toBe('final')
    expect(third?.due_at).toBe('2026-09-08T00:00:00.000Z')
  })

  it('三种情况没有下一封：回过信了、收尾发过了、在抑制名单上', () => {
    const sent = [{ step: 'first' as const, at: '2026-09-01T00:00:00Z' }]
    expect(
      nextInSequence({ sent, replied: true, contact: 'a@x.com', suppressed: [] }),
    ).toBeUndefined()
    expect(
      nextInSequence({
        sent: [...sent, { step: 'final', at: '2026-09-08T00:00:00Z' }],
        replied: false,
        contact: 'a@x.com',
        suppressed: [],
      }),
    ).toBeUndefined()
    // 归一化认得出 `a+kol@x.com` 与 `a@x.com` 是同一个人（core 的那一份规则）
    expect(
      nextInSequence({ sent, replied: false, contact: 'A+kol@x.com', suppressed: ['a@x.com'] }),
    ).toBeUndefined()
  })
})

describe('挑今天发给谁：名单、重复、配额一起看（分三处调总有一处会漏）', () => {
  it('三种剔除各有说法', () => {
    const out = selectOutreachTargets({
      candidates: [
        { creator_id: 'c1', contact: 'anna@example.com' },
        { creator_id: 'c2', contact: 'bob@example.com' },
        { creator_id: 'c3', contact: 'cara@example.com' },
        { creator_id: 'c4', contact: 'dan@example.com' },
      ],
      suppressed: ['ANNA@example.com'],
      already_contacted: ['c2'],
      quota: { cap: 30, sent_today: 29, remaining: 1, allowed: true },
    })
    expect(out.picked.map((p) => p.creator_id)).toEqual(['c3'])
    expect(out.skipped).toEqual([
      { creator_id: 'c1', reason: 'suppressed' },
      { creator_id: 'c2', reason: 'already_contacted' },
      { creator_id: 'c4', reason: 'quota' },
    ])
  })
})
