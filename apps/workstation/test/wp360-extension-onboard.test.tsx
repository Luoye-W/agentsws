/**
 * WP360（决策 947）：需要插件的岗位「装好浏览器插件」那张引导卡。
 *
 * 1. 岗位页：要插件、没配上 → 顶上那张（一句为什么 + 装 / 配对码）；「稍后」当天收起（服务端记）；
 * 2. 配上了 → 换成「还差一步」（插件里连 Reddit），做完打勾；都好了、方案没设 → 「下一步：Reddit 巡查」出方案卡；
 * 3. 都好了 / 不要插件 → 整张不画；
 * 4. 首次设置第 ④ 步：计划里有「装插件」就排在最前，「稍后再装」只收起这一屏、不挡完成；
 * 5. 阶段判断（纯函数）。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionOnboardCard, onboardPhase } from '@/components/connections/extension-onboard-card'
import { PlanList } from '@/components/onboarding/plan-list'
import { type ConnectContext, ConnectWidget } from '@/components/setup/connect-widgets'
import type { ExtensionNeedsView, OnboardingPlanView } from '@/lib/api'
import { renderWithProviders } from './helpers'

/** 现在在哪个地址（点「插件设置」之后看）。 */
function Where(): React.ReactNode {
  const loc = useLocation()
  return <span data-testid="where">{`${loc.pathname}${loc.hash}`}</span>
}

const base = (over: Partial<ExtensionNeedsView> = {}): ExtensionNeedsView => ({
  needed: true,
  uses: ['reddit'],
  roles: [{ role_id: 'social.reddit', name: { zh: '官方版块', en: 'Official Subreddit' } }],
  paired: false,
  steps: [{ step: 'reddit', done: false }],
  plans: [{ target: 'reddit.watch', name: 'Reddit 巡查', satisfied: false }],
  snoozed: false,
  ...over,
})

const state = {
  needs: base(),
  snoozed: [] as string[][],
  planned: [] as string[],
  asked: [] as (readonly string[] | undefined)[],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner', role_name: '负责人' }],
    }),
    getExtensionNeeds: async (roles: readonly string[] | undefined) => {
      state.asked.push(roles)
      return state.needs
    },
    snoozeExtensionNeeds: async (roles: readonly string[] | undefined) => {
      state.snoozed.push([...(roles ?? [])])
      state.needs = { ...state.needs, snoozed: true }
      return state.needs
    },
    askExtensionPlan: async (target: string) => {
      state.planned.push(target)
      return { card_id: 'card_1' }
    },
    getExtensionInstall: async () => {
      throw new Error('not_implemented')
    },
    listExtensionTokens: async () => ({ tokens: [] }),
    createExtensionPairing: async () => ({ code: '123456', expires_at: '2026-10-16T10:05:00Z' }),
    getConnectionDirectory: async () => ({ entries: [] }),
  }
})

beforeEach(() => {
  state.needs = base()
  state.snoozed = []
  state.planned = []
  state.asked = []
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('岗位页顶上那张卡', () => {
  it('没配上：一行提醒（一句为什么 +「装插件」），点了才出配对码；按本岗位的职责问；稍后 → 当天收起', async () => {
    renderWithProviders(
      <ExtensionOnboardCard
        roleIds={['social.reddit', 'pr.reddit']}
        assignment="asg_reddit"
        mode="position"
      />,
    )
    const card = await screen.findByTestId('extension-onboard')
    expect(card.getAttribute('data-phase')).toBe('install')
    // WP456-T3（§3.1）：岗位页上是一行提醒，不再是占满第一屏的整卡
    expect(screen.getByTestId('extension-onboard-why').textContent).toBe(
      '先装好浏览器插件，这个岗位要靠它读 Reddit、把批过的回复填进页面',
    )
    expect(state.asked[0]).toEqual(['social.reddit', 'pr.reddit'])
    expect(screen.queryByTestId('extension-generate')).toBeNull()
    // 点「装插件」才展开：复用连接页那块配对码
    fireEvent.click(screen.getByTestId('extension-onboard-open'))
    expect(await screen.findByTestId('extension-generate')).toBeTruthy()
    fireEvent.click(screen.getByTestId('extension-onboard-later'))
    await waitFor(() => expect(screen.queryByTestId('extension-onboard')).toBeNull())
    expect(state.snoozed).toEqual([['social.reddit', 'pr.reddit']])
  })

  it('配上了：还差一步（连 Reddit）→ 做完、方案没设 → 下一步出方案卡 → 不画', async () => {
    state.needs = base({ paired: true })
    const view = renderWithProviders(
      <>
        <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />
        <Where />
      </>,
    )
    const card = await screen.findByTestId('extension-onboard')
    expect(card.getAttribute('data-phase')).toBe('steps')
    expect(screen.getByTestId('extension-onboard-step').textContent).toContain('连接 Reddit')
    expect(screen.queryByTestId('extension-generate')).toBeNull()
    // 插件设置在设置弹窗里那一项（WP356）
    fireEvent.click(screen.getByTestId('extension-onboard-settings'))
    await waitFor(() =>
      expect(screen.getByTestId('where').textContent).toBe('/settings/extension#extension'),
    )
    view.unmount()

    state.needs = base({ paired: true, steps: [{ step: 'reddit', done: true }] })
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    const go = await screen.findByTestId('extension-onboard-plan')
    expect(go.textContent).toBe('下一步：Reddit 巡查')
    fireEvent.click(go)
    await waitFor(() => expect(state.planned).toEqual(['reddit.watch']))
    await waitFor(() => expect(screen.queryByTestId('extension-onboard')).toBeNull())
  })

  it('WP409：配上之后说一行「插件已连上 · 哪个浏览器」；令牌没名字时只说「插件已连上」', async () => {
    state.needs = base({
      paired: true,
      paired_with: { label: 'Chrome · Windows', paired_at: '2026-10-18T08:00:00Z' },
    })
    const view = renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    expect((await screen.findByTestId('extension-onboard-paired-line')).textContent).toContain(
      '插件已连上 · Chrome · Windows',
    )
    view.unmount()
    state.needs = base({
      paired: true,
      paired_with: { label: '浏览器插件', paired_at: '2026-10-18T08:00:00Z' },
    })
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    const line = await screen.findByTestId('extension-onboard-paired-line')
    expect(line.textContent).toContain('插件已连上')
    expect(line.textContent).not.toContain('·')
  })

  it('WP409：看着它配上、而且都连好了（卡要收起）——仍留一行「插件已连上」', async () => {
    state.needs = base()
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['social.reddit']} assignment="asg_reddit" mode="position" />,
    )
    expect((await screen.findByTestId('extension-onboard')).getAttribute('data-phase')).toBe(
      'install',
    )
    state.needs = base({
      paired: true,
      paired_with: { label: 'Chrome · Mac', paired_at: '2026-10-18T08:00:00Z' },
      steps: [{ step: 'reddit', done: true }],
      plans: [{ target: 'reddit.watch', name: 'Reddit 巡查', satisfied: true }],
    })
    // 卡每 4 秒问一次
    await waitFor(
      () =>
        expect(screen.getByTestId('extension-onboard').getAttribute('data-phase')).toBe(
          'just-paired',
        ),
      { timeout: 6000 },
    )
    expect(screen.getByTestId('extension-onboard-paired-line').textContent).toContain(
      'Chrome · Mac',
    )
  })

  it('不要插件 / 今天稍后过：不画', async () => {
    state.needs = base({ needed: false })
    renderWithProviders(
      <ExtensionOnboardCard roleIds={['dtc.support']} assignment="asg_x" mode="position" />,
    )
    await waitFor(() => expect(state.asked.length).toBeGreaterThan(0))
    expect(screen.queryByTestId('extension-onboard')).toBeNull()
  })
})

describe('首次设置第 ④ 步', () => {
  const plan = (over: Partial<OnboardingPlanView> = {}): OnboardingPlanView => ({
    connectors: [],
    skills: [],
    positions: [
      {
        position_id: 'custom:0',
        name: 'Reddit 运营',
        role_ids: ['social.reddit'],
        already_held: false,
      },
    ],
    model_configured: true,
    model_first: false,
    role_ids: ['social.reddit'],
    extension: { uses: ['reddit'], needed_by: ['官方版块'], paired: false },
    ...over,
  })

  it('装插件排在最前；稍后再装只收起这一屏', async () => {
    renderWithProviders(<PlanList plan={plan({ model_first: true })} />)
    const card = await screen.findByTestId('extension-onboard')
    expect(card.getAttribute('data-mode')).toBe('onboarding')
    const list = screen.getByTestId('onboarding-plan')
    expect(list.firstElementChild).toBe(card)
    expect(state.asked[0]).toEqual(['social.reddit'])
    fireEvent.click(screen.getByTestId('extension-onboard-later'))
    await waitFor(() => expect(screen.queryByTestId('extension-onboard')).toBeNull())
    expect(state.snoozed).toEqual([])
    expect(screen.getByTestId('onboarding-plan-model')).toBeTruthy()
  })

  it('计划里没有「装插件」就不出', async () => {
    const { extension: _drop, ...rest } = plan()
    renderWithProviders(<PlanList plan={rest} />)
    await screen.findByTestId('onboarding-plan')
    expect(screen.queryByTestId('extension-onboard')).toBeNull()
  })
})

describe('对话里那张「先连上插件」连接卡', () => {
  const ctx: ConnectContext = {
    owner: 'asg_owner',
    providers: [],
    isConnected: () => false,
    refresh: () => {},
  }
  it('只缺配对：少字版（装 + 配对码），不铺整节插件设置', async () => {
    renderWithProviders(
      <ConnectWidget
        need={{ kind: 'extension', service: 'extension', name: '插件', required: true }}
        ctx={ctx}
      />,
    )
    await screen.findByTestId('extension-install-pair')
    expect(screen.getByTestId('extension-generate')).toBeTruthy()
    expect(screen.queryByTestId('extension-section')).toBeNull()
  })
  it('要连广告后台：仍是完整那一节', async () => {
    renderWithProviders(
      <ConnectWidget
        need={{ kind: 'ads_backend', service: 'extension', name: '插件', required: true }}
        ctx={ctx}
      />,
    )
    await screen.findByTestId('extension-section')
  })
})

describe('阶段判断', () => {
  it('按配没配上 / 步 / 方案 / 稍后 / 哪一处', () => {
    expect(onboardPhase(undefined, 'position')).toBe('hidden')
    expect(onboardPhase(base(), 'position')).toBe('install')
    expect(onboardPhase(base({ snoozed: true }), 'position')).toBe('hidden')
    expect(onboardPhase(base({ snoozed: true }), 'onboarding')).toBe('install')
    // WP416：「要你处理」里已经有那张装插件连接卡 → 岗位页顶上不再重复出（首次设置那一屏照旧）
    expect(onboardPhase(base({ connect_card_id: 'card_ext' }), 'position')).toBe('hidden')
    expect(onboardPhase(base({ connect_card_id: 'card_ext' }), 'onboarding')).toBe('install')
    expect(onboardPhase(base({ paired: true }), 'position')).toBe('steps')
    // 查不了的那一步不拦人
    expect(onboardPhase(base({ paired: true, steps: [{ step: 'reddit' }] }), 'position')).toBe(
      'plan',
    )
    expect(
      onboardPhase(base({ paired: true, steps: [{ step: 'reddit', done: true }] }), 'position', [
        'reddit.watch',
      ]),
    ).toBe('hidden')
    expect(
      onboardPhase(base({ paired: true, steps: [{ step: 'reddit', done: true }] }), 'onboarding'),
    ).toBe('paired')
  })
})
