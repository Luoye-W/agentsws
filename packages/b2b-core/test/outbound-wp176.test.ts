/**
 * WP176（Luoye / Fable 09-28）：「不感兴趣」只停这一轮（冷却、第二次翻倍）、DKIM 测试信收不回来时
 * 按 DNS 选择器兜底、跟进与收尾也由模型写的提示词。
 */
import { B2B_DECLINED_COOLDOWN_DAYS, B2B_DKIM_SELECTORS } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  B2B_REPLY_ACTION,
  type B2bProspect,
  coldEmailPrompt,
  cooldownLabel,
  DKIM_TEST_WAIT_MS,
  declineCooldown,
  dkimWaitedTooLong,
  EXCLUDE_REASON_ZH,
  evaluateDkimDns,
  evaluateSenderAuth,
  inCooldown,
  screenProspects,
} from '../src/index.js'

const base: B2bProspect = {
  contact_id: 'c1',
  account_id: 'a1',
  name: 'Anna',
  company: 'Volthaus',
  country: 'US',
  has_email: true,
  source: { url: 'https://volthaus.example/contact', observed_at: '2026-09-20T00:00:00Z' },
  existing_relationship: false,
  suppressed: false,
  in_sequence: false,
}

describe('不感兴趣：冷却，不进永久名单', () => {
  it('回信动作：不感兴趣 → 冷却；退订仍进名单', () => {
    expect(B2B_REPLY_ACTION.not_interested).toBe('cooldown')
    expect(B2B_REPLY_ACTION.unsubscribe).toBe('suppress')
  })

  it('默认 90 天；第二次翻倍 180；第三次 360', () => {
    expect(B2B_DECLINED_COOLDOWN_DAYS).toBe(90)
    const now = '2026-09-28T00:00:00.000Z'
    const first = declineCooldown({ prior_count: 0, base_days: 90, now })
    expect(first).toEqual({ count: 1, days: 90, until: '2026-12-27T00:00:00.000Z' })
    expect(declineCooldown({ prior_count: 1, base_days: 90, now }).days).toBe(180)
    expect(declineCooldown({ prior_count: 2, base_days: 90, now }).days).toBe(360)
    // 阈值改过就照改过的算；乱填的退回 90
    expect(declineCooldown({ prior_count: 0, base_days: 30, now }).days).toBe(30)
    expect(declineCooldown({ prior_count: 0, base_days: -1, now }).days).toBe(90)
  })

  it('冷却期内剔掉（写明到哪天）；期满能再选；不给 now 一律算冷却中', () => {
    const p = { ...base, cooldown_until: '2026-12-27T00:00:00.000Z', declined_count: 1 }
    const during = screenProspects([p], { de_at_confirmed: false, now: '2026-10-01T00:00:00Z' })
    expect(during.excluded.map((x) => x.reason)).toEqual(['cooldown'])
    expect(EXCLUDE_REASON_ZH.cooldown).toContain('冷却')
    expect(cooldownLabel(p.cooldown_until)).toContain('2026-12-27')
    const after = screenProspects([p], { de_at_confirmed: false, now: '2026-12-28T00:00:00Z' })
    expect(after.eligible.map((x) => x.contact_id)).toEqual(['c1'])
    expect(screenProspects([p], { de_at_confirmed: false }).excluded[0]?.reason).toBe('cooldown')
    expect(inCooldown(undefined, '2026-10-01T00:00:00Z')).toBe(false)
    // 退订（抑制名单）比冷却先判：永久
    const both = screenProspects([{ ...p, suppressed: true }], {
      de_at_confirmed: false,
      now: '2027-06-01T00:00:00Z',
    })
    expect(both.excluded[0]?.reason).toBe('suppressed')
  })
})

describe('DKIM：测试信收不回来就按 DNS 查', () => {
  it('等满 10 分钟才改查 DNS；不是 pending 不查', () => {
    expect(DKIM_TEST_WAIT_MS).toBe(600_000)
    const auth = { dkim: 'pending' as const, test_sent_at: '2026-09-28T01:00:00.000Z' }
    expect(dkimWaitedTooLong(auth, '2026-09-28T01:09:59.000Z')).toBe(false)
    expect(dkimWaitedTooLong(auth, '2026-09-28T01:10:00.000Z')).toBe(true)
    expect(dkimWaitedTooLong({ ...auth, dkim: 'pass' }, '2026-09-28T02:00:00.000Z')).toBe(false)
    // 老数据没有 test_sent_at：按上一次体检的时间算
    expect(
      dkimWaitedTooLong(
        { dkim: 'pending', checked_at: '2026-09-28T01:00:00.000Z' },
        '2026-09-28T01:30:00.000Z',
      ),
    ).toBe(true)
  })

  it('常见选择器里查到公钥 = DNS 已配置（未经实信验证）；空公钥 / 查不到不算；全查不成 = unknown', () => {
    expect(B2B_DKIM_SELECTORS.slice(0, 4)).toEqual(['google', 'selector1', 'selector2', 'k1'])
    const key = 'v=DKIM1; k=rsa; p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA'
    const hit = evaluateDkimDns({
      domain: 'brandmail.com',
      records: [
        { selector: 'google', txt: [] },
        { selector: 'selector1', txt: ['v=DKIM1; p='] },
        { selector: 'k1', txt: [key] },
      ],
    })
    expect(hit).toMatchObject({ dkim: 'pass', selector: 'k1' })
    expect(hit.note).toContain('未经实信验证')
    const none = evaluateDkimDns({
      domain: 'brandmail.com',
      records: [
        { selector: 'google', txt: [] },
        { selector: 'selector1', txt: undefined },
      ],
    })
    expect(none.dkim).toBe('missing')
    expect(
      evaluateDkimDns({ domain: 'x.com', records: [{ selector: 'google', txt: undefined }] }).dkim,
    ).toBe('unknown')
  })

  it('读了测试信的信头：记成实信验证', () => {
    const ev = evaluateSenderAuth({
      domain: 'brandmail.com',
      spf_txt: ['v=spf1 include:_spf.google.com ~all'],
      dmarc_txt: [],
      auth_header: 'mx.google.com; dkim=pass header.d=brandmail.com; spf=pass',
      test_sent: true,
    })
    expect(ev).toMatchObject({ dkim: 'pass', dkim_via: 'test_mail' })
    const pending = evaluateSenderAuth({ domain: 'brandmail.com', test_sent: true })
    expect(pending.dkim_via).toBeUndefined()
  })
})

describe('跟进与收尾也由模型写', () => {
  const vars = {
    first_name: 'Anna',
    company: 'Volthaus',
    our_company: 'Zhilian',
    product: 'GaN chargers',
    sender_name: 'Lin',
    first_subject: 'GaN chargers for Volthaus',
  }
  it('提示词按第几封换说法；跟进 / 收尾带首封主题，首封不带', () => {
    const first = coldEmailPrompt({ skill: 'SKILL', vars, prospect: {} })
    expect(first).toContain('**首封**')
    expect(first).not.toContain('Subject of our first email')
    const follow = coldEmailPrompt({ skill: 'SKILL', vars, prospect: {}, step: 'follow_up' })
    expect(follow).toContain('跟进')
    expect(follow).toContain('Subject of our first email (this one replies in that thread): GaN')
    const final = coldEmailPrompt({ skill: 'SKILL', vars, prospect: {}, step: 'final' })
    expect(final).toContain('收尾')
    expect(final).toContain('不回就不再打扰')
    // 都不许写承诺词
    for (const p of [first, follow, final]) expect(p).toContain('不写价格、交期')
  })
})
