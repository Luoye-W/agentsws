/**
 * WP360：`createExtensionOnboarding` 的几条规矩（替身，不起服务）。
 *
 * - 配上了 / 今天点过稍后 / 这条分配带过 / 职责不要插件 → 第一次对话不带卡；
 * - 投放岗：配上之后两步（Google / Meta 后台）各自打勾，方案卡只一张（广告账户）；
 * - 稍后只记一次（当天再点不重复记）；
 * - 时间线上先说一句、再出卡；复用的卡多说一句在哪儿。
 */
import type { BrowserExtensionUse } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  createExtensionOnboarding,
  type ExtensionOnboardingOptions,
  extensionWhy,
} from '../src/extension-onboarding.js'

const ROLES: Record<string, BrowserExtensionUse[] | undefined> = {
  'ads.google': ['google_ads'],
  'ads.meta': ['meta_ads'],
  'ads.tiktok': undefined,
  'social.reddit': ['reddit'],
}
const actor = {
  workspace_id: 'ws_1' as never,
  person_id: 'p_1',
  assignment_id: 'asg_1',
  role_id: 'social.reddit',
}

function make(over: Partial<ExtensionOnboardingOptions> = {}) {
  const log: string[] = []
  const state = { paired: false, snoozed: false, prompted: false, reused: false }
  const ob = createExtensionOnboarding({
    role: (id) =>
      id in ROLES
        ? {
            id: id as never,
            name: { zh: id, en: id },
            ...(ROLES[id] === undefined ? {} : { browser_extension: { uses: ROLES[id] ?? [] } }),
          }
        : undefined,
    heldRoleIds: () => ['ads.google', 'ads.meta', 'ads.tiktok'],
    paired: () => state.paired,
    stepDone: async (_ws, step) =>
      step === 'google_ads' ? true : step === 'meta_ads' ? false : undefined,
    planTarget: async (_ws, target) =>
      target === 'ads.accounts' ? { name: '广告账户', satisfied: false } : undefined,
    askPlan: async () => ({ card_id: 'card_plan' }),
    snoozedToday: () => state.snoozed,
    recordSnooze: () => {
      log.push('snooze')
      state.snoozed = true
    },
    prompted: () => state.prompted,
    askConnect: async () => {
      log.push('card')
      return { card_id: 'card_ext', reused: state.reused }
    },
    note: (_ws, _m, text) => {
      log.push(`note:${text}`)
    },
    recordPrompt: () => {
      log.push('prompted')
      state.prompted = true
    },
    ...over,
  })
  return { ob, log, state }
}

describe('WP360 引导装插件（替身）', () => {
  it('投放岗：两家后台各一步、方案卡只一张；不要插件的职责不算', async () => {
    const { ob } = make()
    const v = await ob.needs({ ...actor, role_id: 'ads.google' })
    expect(v).toMatchObject({
      needed: true,
      uses: ['google_ads', 'meta_ads'],
      steps: [
        { step: 'google_ads', done: true },
        { step: 'meta_ads', done: false },
      ],
      plans: [{ target: 'ads.accounts', name: '广告账户', satisfied: false }],
    })
    expect(v.roles.map((r) => r.role_id)).toEqual(['ads.google', 'ads.meta'])
    expect((await ob.needs(actor, ['ads.tiktok'])).needed).toBe(false)
  })

  it('稍后当天只记一次', async () => {
    const { ob, log } = make()
    expect((await ob.snooze(actor)).snoozed).toBe(true)
    expect((await ob.snooze(actor)).snoozed).toBe(true)
    expect(log.filter((x) => x === 'snooze')).toHaveLength(1)
  })

  it('第一次对话：先说一句再出卡；只带一次；配上了 / 稍后了 / 不要插件都不带', async () => {
    const { ob, log, state } = make()
    expect(await ob.nudge({ actor, matter_id: 'm1', role_ids: ['ads.tiktok'] })).toBe(false)
    expect(await ob.nudge({ actor, matter_id: 'm1', role_ids: ['social.reddit'] })).toBe(true)
    expect(log).toEqual([
      `note:${extensionWhy(['reddit'])}先在下面这张卡上装好、配对，我就能用上它。`,
      'card',
      'prompted',
    ])
    expect(await ob.nudge({ actor, matter_id: 'm2', role_ids: ['social.reddit'] })).toBe(false)

    const again = make()
    again.state.snoozed = true
    expect(await again.ob.nudge({ actor, matter_id: 'm1' })).toBe(false)
    const paired = make()
    paired.state.paired = true
    expect(await paired.ob.nudge({ actor, matter_id: 'm1' })).toBe(false)
    void state
  })

  it('复用的卡：多说一句在「要你处理」里', async () => {
    const { ob, log, state } = make()
    state.reused = true
    expect(await ob.nudge({ actor, matter_id: 'm1' })).toBe(true)
    expect(log.some((x) => x.includes('之前已经出过'))).toBe(true)
  })

  it('方案卡只接本人岗位要的那几张', async () => {
    const { ob } = make()
    expect(await ob.plan(actor, 'ads.accounts')).toEqual({ card_id: 'card_plan' })
    expect(await ob.plan(actor, 'reddit.watch')).toEqual({})
  })
})
