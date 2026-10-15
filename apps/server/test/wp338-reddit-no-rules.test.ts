/**
 * WP338（决策 664 / 783，Luoye 10-15 直接指令）：Reddit 不替用户定推广规矩。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 公关外部发帖 / 回帖：不推断「禁推广」、不设冷却；版规原文上卡（没读到写「没读到版规」） | a、b 去掉 |
 * | 每天 / 每周几条：默认不限；用户设了才数，到了不出卡并照实说 | c 改成可设置 |
 * | 上限按滚动窗口数；只数出了卡的 | 数法 |
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createPrStore } from '../src/pr.js'
import { createPrService } from '../src/pr-service.js'
import { createRedditLimits } from '../src/reddit-write/limits.js'

const WS = 'ws_r' as never
const T0 = Date.parse('2026-10-15T09:00:00.000Z')

function prMake(opts: { rules?: string[]; limits?: ReturnType<typeof createRedditLimits> } = {}) {
  const store = createPrStore({ workspace_id: WS })
  const staged: { after: Record<string, unknown>; notes?: string[] }[] = []
  const svc = createPrService({
    workspace_id: WS,
    store,
    clock: { now: () => '2026-10-15T09:00:00.000Z' },
    approvals: {} as never,
    ledger: {
      stage: async (input) => {
        staged.push(input as never)
        return {
          ok: true,
          change: { id: `ch_${staged.length}` },
          approval: { id: `ap_${staged.length}`, automation: { level_at_creation: 'L1' } },
        } as never
      },
      list: async () => [],
    },
    effectiveConfig: () => {
      throw new Error('no config')
    },
    appendEvent: () => {},
    random: () => 0.5,
    holdersOf: () => [],
    owner: async () => undefined,
    rulesText: async () => opts.rules,
    ...(opts.limits === undefined ? {} : { limits: opts.limits }),
  })
  return { svc, store, staged }
}

const actor = {
  workspace_id: WS,
  person_id: 'p_1',
  assignment_id: 'as_1',
  role_id: 'pr.reddit',
} as never
const post = {
  platform: 'reddit',
  venue: 'r/SmartGlasses',
  kind: 'post' as const,
  title: 'How we fixed fogging on our glasses',
  body: 'A teardown of the anti-fog insert.',
}

describe('WP338 公关在别人的版发帖：不替人判，版规原文上卡', () => {
  it('没读到版规：照样出卡（以前按「保守默认」当成禁推广拦下），卡上写「没读到版规」', async () => {
    const m = prMake()
    const out = await m.svc.port.proposeExternalPost(actor, post)
    expect(out.staged).toBe(true)
    expect(out.rules_explained).toBe('没读到版规')
    expect(m.staged[0]?.after).toMatchObject({ rules_read: false, sub_rules: [] })
  })

  it('版规写着禁自我推广：不拦，原文上卡，人看了自己判', async () => {
    const rules = ['Rule 1: No self-promotion', 'Be civil']
    const m = prMake({ rules })
    const out = await m.svc.port.proposeExternalPost(actor, post)
    expect(out.staged).toBe(true)
    expect(out.rules_explained).toBe('版规 2 条')
    expect(m.staged[0]?.after).toMatchObject({ sub_rules: rules, rules_read: true })
    expect((m.staged[0]?.notes ?? []).join('\n')).toContain('No self-promotion')
  })

  it('同一个版连着发：不设冷却，第二条照样出卡', async () => {
    const m = prMake({ rules: ['Vendors welcome. Once per 7 days.'] })
    const a = await m.svc.port.proposeExternalPost(actor, post)
    const b = await m.svc.port.proposeExternalPost(actor, { ...post, body: 'Second post.' })
    expect([a.staged, b.staged]).toEqual([true, true])
  })
})

describe('WP338 每天几条：用户设，默认不限', () => {
  it('默认不限：连发 25 条都出卡', async () => {
    let now = T0
    const limits = createRedditLimits({ nowMs: () => now })
    const m = prMake({ limits })
    for (let i = 0; i < 25; i++) {
      now += 1000
      expect((await m.svc.port.proposeExternalPost(actor, { ...post, body: `n${i}` })).staged).toBe(
        true,
      )
    }
  })

  it('设了一天 2 条：第三条不出卡并照实说；过了 24 小时又能出', async () => {
    let now = T0
    const limits = createRedditLimits({ nowMs: () => now })
    limits.set({ pr_posts: 2 })
    const m = prMake({ limits })
    expect((await m.svc.port.proposeExternalPost(actor, { ...post, body: 'a' })).staged).toBe(true)
    expect((await m.svc.port.proposeExternalPost(actor, { ...post, body: 'b' })).staged).toBe(true)
    const third = await m.svc.port.proposeExternalPost(actor, { ...post, body: 'c' })
    expect(third.staged).toBe(false)
    expect(third.message).toContain('到了你设的上限 2 条')
    now += 24 * 3_600_000 + 1
    expect((await m.svc.port.proposeExternalPost(actor, { ...post, body: 'd' })).staged).toBe(true)
  })

  it('发帖和回帖分开数；只数出了卡的', async () => {
    const limits = createRedditLimits({ nowMs: () => T0 })
    limits.set({ pr_posts: 1 })
    expect(limits.check('pr_replies')).toBeUndefined()
    limits.note('pr_posts')
    expect(limits.check('pr_posts')).toBeDefined()
    expect(limits.check('pr_replies')).toBeUndefined()
  })

  it('落盘：重开还记得设了多少；配置卡空着 = 不限、乱填照实说', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp338-'))
    try {
      const a = createRedditLimits({ nowMs: () => T0, dir })
      a.set({ social_replies: 30 })
      const b = createRedditLimits({ nowMs: () => T0, dir })
      expect(b.get()).toEqual({ social_replies: 30 })
      const target = b.setupTarget()
      await target.apply({ social_replies_per_day: '' })
      expect(b.get()).toEqual({})
      await expect(target.apply({ pr_posts_per_day: '-3' })).rejects.toThrow('正整数')
      // 默认不限 = 不缺什么；人说要设才出卡
      expect(await target.satisfied()).toBe(true)
      b.want()
      expect(await target.satisfied()).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
