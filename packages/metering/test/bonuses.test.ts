/**
 * 赠送规则（70 §2）。
 *
 * 这一组测试真正守的是**幂等键的形状**：它不含时间、不含邮箱、不含金额。
 * 三条里任何一条破了，都会变成"定时任务跑一次就再送一遍"。
 */

import { describe, expect, it } from 'vitest'
import {
  BONUSES_FILE,
  bonusById,
  bonusExpiresAt,
  bonuses,
  isSignupBonusRef,
  SIGNUP_BONUS_ID,
  signupBonus,
  signupBonusSourceRef,
} from '../src/bonuses.js'

describe('bonuses.json', () => {
  it('注册赠送是 10 积分、granted、90 天', () => {
    const rule = signupBonus()
    expect(rule).toBeDefined()
    expect(rule?.credits).toBe(10)
    expect(rule?.kind).toBe('granted')
    expect(rule?.expires_days).toBe(90)
  })

  it('每条规则的 id 唯一，金额都大于 0', () => {
    const ids = bonuses().map((b) => b.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const b of bonuses()) expect(b.credits).toBeGreaterThan(0)
  })

  it('文件里有 as_of 与 needs_decision（价目类数据文件的惯例）', () => {
    expect(BONUSES_FILE.as_of).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(BONUSES_FILE.needs_decision.length).toBeGreaterThan(10)
  })

  it('bonusById 认不出来就回 undefined，不兜底', () => {
    expect(bonusById('没有这一条')).toBeUndefined()
  })
})

describe('signupBonusSourceRef', () => {
  it('同一个 account_id 永远算出同一串', () => {
    expect(signupBonusSourceRef('acc_1')).toBe(signupBonusSourceRef('acc_1'))
    expect(signupBonusSourceRef('acc_1')).toBe(`${SIGNUP_BONUS_ID}:acc_1`)
  })

  it('不同账号不同串', () => {
    expect(signupBonusSourceRef('acc_1')).not.toBe(signupBonusSourceRef('acc_2'))
  })

  it('串里没有数字时间戳——有的话定时任务每跑一次就重发一次', () => {
    expect(signupBonusSourceRef('acc_1')).not.toMatch(/\d{10}/)
  })

  it('isSignupBonusRef 认自己、不认别人、不认空', () => {
    expect(isSignupBonusRef(signupBonusSourceRef('acc_1'))).toBe(true)
    expect(isSignupBonusRef('admgrant:acc_1:org_1')).toBe(false)
    expect(isSignupBonusRef(undefined)).toBe(false)
    expect(isSignupBonusRef(null)).toBe(false)
  })
})

describe('bonusExpiresAt', () => {
  it('90 天之后', () => {
    const rule = signupBonus()
    expect(rule).toBeDefined()
    const at = bonusExpiresAt(rule as NonNullable<typeof rule>, '2026-09-19T00:00:00.000Z')
    expect(at).toBe('2026-12-18T00:00:00.000Z')
  })

  it('没写天数就是不过期', () => {
    expect(
      bonusExpiresAt(
        { id: 'x', label_zh: 'x', label_en: 'x', credits: 1, kind: 'purchased' },
        '2026-09-19T00:00:00.000Z',
      ),
    ).toBeUndefined()
  })
})
