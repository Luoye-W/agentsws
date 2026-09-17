/**
 * WP78（60 §2）：版规解析与"这一条发得了发不了"。
 *
 * 最要紧的一条：**判不准就当禁**。在别人的地盘上 fail-closed 的代价是
 * 少发一条，fail-open 的代价是整个品牌被那个版永久赶走。
 */
import { describe, expect, it } from 'vitest'
import {
  checkSubredditRules,
  DEFAULT_COOLDOWN_HOURS,
  explainRuleCheck,
  hoursSinceLastPost,
  parseSubredditRules,
} from '../src/index.js'

const now = '2026-09-17T09:00:00Z'
const parse = (rules: string[], options = {}) =>
  parseSubredditRules({ name: 'r/BuyItForLife', raw_rules: rules, observed_at: now }, options)

describe('parseSubredditRules', () => {
  it('英文写法认得出来，版名去掉 r/', () => {
    const p = parse(['No self-promotion', 'Be civil'])
    expect(p.name).toBe('BuyItForLife')
    expect(p.no_self_promotion).toBe(true)
  })

  it('中文写法也认', () => {
    expect(parse(['禁止自我推广，违者封禁']).no_self_promotion).toBe(true)
  })

  it('一条相关的话都没写 → **默认按禁**（fail-closed）', () => {
    expect(parse(['Be civil', 'No politics']).no_self_promotion).toBe(true)
  })

  it('版规明写着欢迎厂商 → 不禁（否则这条职责一条都发不出去）', () => {
    expect(parse(['Vendors welcome. Once per 7 days.']).no_self_promotion).toBe(false)
    expect(parse(['欢迎厂商帖，但请带上实测数据']).no_self_promotion).toBe(false)
  })

  it('既写着欢迎厂商又写着禁广告 → **按禁**（禁优先）', () => {
    expect(parse(['Vendors welcome', 'No advertising links']).no_self_promotion).toBe(true)
  })

  it('调用方明确说了可以，才按不禁', () => {
    const p = parse(['Be civil'], { assume_no_self_promotion: false })
    expect(p.no_self_promotion).toBe(false)
  })

  it('flair 那一条与可选的 flair 名单', () => {
    const p = parse(['Flair required: Review, Discussion, Question'])
    expect(p.flair_required).toBe(true)
    expect(p.flairs).toEqual(['Review', 'Discussion', 'Question'])
  })

  it('频率：once per 7 days / 每周一条 / 不写就用 72 小时默认值', () => {
    expect(parse(['Once per 7 days']).cooldown_per_subreddit_hours).toBe(24 * 7)
    expect(parse(['每周一条']).cooldown_per_subreddit_hours).toBe(24 * 7)
    expect(parse(['Be civil']).cooldown_per_subreddit_hours).toBe(DEFAULT_COOLDOWN_HOURS)
  })

  it('原文原样留着（外部文本不改写）', () => {
    const raw = ['No self-promotion（含外链）']
    expect(parse(raw).raw_rules).toEqual(raw)
  })
})

describe('checkSubredditRules', () => {
  const open = parse(['Be civil'], { assume_no_self_promotion: false })

  it('版规放开 + 没冷却 → 可发', () => {
    const r = checkSubredditRules({ policy: open, now })
    expect(r.ok).toBe(true)
    expect(r.reasons).toEqual([])
    expect(explainRuleCheck(r, 'BuyItForLife')).toContain('发得了')
  })

  it('禁自我推广 → 不可发，理由名与 guardrail 那一侧逐字相同', () => {
    const r = checkSubredditRules({ policy: parse(['No self-promotion']), now })
    expect(r.ok).toBe(false)
    expect(r.reasons).toContain('no_self_promotion')
    expect(explainRuleCheck(r, 'BuyItForLife')).toContain('禁自我推广')
  })

  it('要 flair 却没带 → 不可发', () => {
    const policy = { ...open, flair_required: true, flairs: ['Review'] }
    expect(checkSubredditRules({ policy, now }).reasons).toContain('flair_required')
  })

  it('带了一个这个版不认识的 flair → 不可发', () => {
    const policy = { ...open, flair_required: true, flairs: ['Review'] }
    expect(checkSubredditRules({ policy, flair: 'Ad', now }).reasons).toContain('flair_unknown')
  })

  it('冷却期内 → 不可发；过了就可以', () => {
    const policy = { ...open, cooldown_per_subreddit_hours: 72 }
    const recent = '2026-09-16T09:00:00Z'
    expect(checkSubredditRules({ policy, last_post_at: recent, now }).reasons).toContain('cooldown')
    const old = '2026-09-10T09:00:00Z'
    expect(checkSubredditRules({ policy, last_post_at: old, now }).ok).toBe(true)
  })

  it('没在这个版发过 ≠ 0 小时（第一帖不该被冷却拦下）', () => {
    expect(hoursSinceLastPost({ now })).toBeUndefined()
    const policy = { ...open, cooldown_per_subreddit_hours: 72 }
    expect(checkSubredditRules({ policy, now }).ok).toBe(true)
  })

  it('checked_at 是必填的——版规会改', () => {
    expect(checkSubredditRules({ policy: open, now }).checked_at).toBe(now)
  })
})
