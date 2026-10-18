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

  it('WP409：配上了说配的是哪一个（浏览器 · 系统）；没配上 / 老接线不说', async () => {
    const withWhom = { label: 'Chrome · Windows', paired_at: '2026-10-18T08:00:00.000Z' }
    const { ob, state } = make({ pairedWith: () => withWhom })
    expect((await ob.needs(actor)).paired_with).toBeUndefined()
    state.paired = true
    expect((await ob.needs(actor)).paired_with).toEqual(withWhom)
    // 职责不要插件也照样说（工坊别处也用这一份）
    expect((await ob.needs(actor, ['ads.tiktok'])).paired_with).toEqual(withWhom)
    const old = make()
    old.state.paired = true
    expect('paired_with' in (await old.ob.needs(actor))).toBe(false)
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
      'note:这个岗位要用浏览器插件读 Reddit、把批过的回复填进页面，还没装。在下面这张卡上装好、配个对就行。',
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

  it('WP416：「要你处理」里还开着装插件那张连接卡 → needs 带上卡 id；配上了就不带', async () => {
    const { ob, state } = make({ openConnectCard: async () => 'card_ext' })
    const v = await ob.needs(actor, ['social.reddit'])
    expect(v.connect_card_id).toBe('card_ext')
    state.paired = true
    expect((await ob.needs(actor, ['social.reddit'])).connect_card_id).toBeUndefined()
  })

  it('WP419（自查 P7）：这件事落到的那条职责不要插件（信息监控）就不带——同岗位别的职责要也不带', async () => {
    const { ob, log } = make()
    const monitoring = { ...actor, role_id: 'ads.tiktok' }
    expect(
      await ob.nudge({
        actor: monitoring,
        matter_id: 'm1',
        role_ids: ['ads.tiktok', 'social.reddit'],
      }),
    ).toBe(false)
    expect(log).toEqual([])
  })

  it('卡上那一句为什么按用途拼', () => {
    expect(extensionWhy(['reddit', 'kol'])).toBe(
      '这个岗位要靠浏览器插件读 Reddit、把批过的回复填进页面、在 YouTube / Instagram / TikTok 页面上收红人。装一次、配个对，以后跟着工坊自己更新。',
    )
  })

  it('WP421：这一次做事的职责自己用不上插件（写新闻稿）就不带，哪怕同岗位别的职责要', async () => {
    const { ob, log } = make()
    expect(
      await ob.nudge({
        actor: { ...actor, role_id: 'pr.press' },
        matter_id: 'm1',
        role_ids: ['pr.press', 'pr.reddit'],
      }),
    ).toBe(false)
    expect(log).toEqual([])
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
