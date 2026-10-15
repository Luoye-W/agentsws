/**
 * WP334（决策 725 / 726）：连接卡里就地连的几样新接法。
 *
 * - 企业微信：卡里就是消息渠道页那张本机原生表单；Secret 只打 `PUT /v1/im/wecom`，不进卡的决定；
 *   连上了卡自己「接着做」（`approve`，没有任何值）；
 * - 个人微信：卡里就是扫码那一块（条款风险一行）；
 * - 接模型：卡里是开工向导第 ① 步那一个件（没有「先逛逛演示数据」那条旁路）；工坊账号 / DeepSeek 账号各是设置页那个件；
 * - 「还没接模型」不再跳设置页：开第三栏连接卡（开不出来才退回设置页的模型那一档）。
 */
import type { ConnectRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { connectFallbackPath } from '@/components/setup/use-open-connect'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const SECRET = 'wecom_secret_should_never_leave_the_form'

let wecomConnected = false
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))
const saveWecomBot = vi.fn(async (_input: { bot_id: string; secret: string }) => {
  wecomConnected = true
  return {}
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner', name: '负责人' }],
    }),
    listProviders: async () => ({ providers: [] }),
    listConnections: async () => ({ connections: [] }),
    getImStatus: async () => ({
      wechat: { bound: false, live: false, allowed: true },
      wecom: wecomConnected
        ? { configured: true, connected: true, state: 'connected', bot_id: 'BOT1' }
        : { configured: false, connected: false },
      can_manage: true,
    }),
    saveWecomBot: (input: { bot_id: string; secret: string }) => saveWecomBot(input),
    listModelProviders: async () => ({ providers: [], templates: [] }),
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.example.test' }),
    getDeepSeekAccount: async () => ({
      available: true,
      enabled: false,
      signed_in: false,
      default_model: 'deepseek-flash',
      region: 'cn',
    }),
    decide: (id: string, input: unknown, asg: string) => decide(id, input, asg),
  }
})

beforeEach(() => {
  wecomConnected = false
  decide.mockClear()
  saveWecomBot.mockClear()
})

function card(payload: ConnectRequestPayload): DeckCard {
  const base = draftCard()
  return draftCard({
    id: 'ap_connect',
    kind: 'connect_request',
    layout: 'policy',
    title: '先连上',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '接着做', reject: '先不连', snooze: '稍后' },
    detail: { ...base.detail, payload: payload as unknown as Record<string, unknown> },
  })
}

const need = (service: string, name: string): ConnectRequestPayload => ({
  form: 'connect_request',
  why: '这件事要先连上它才做得下去。',
  needs: [{ kind: service, service, name, required: true }],
  resume: { matter_id: 'mat_1', person_id: 'per_1', assignment_id: 'asg_1' },
})

describe('WP334 连接卡里的企业微信 / 微信', () => {
  it('企业微信：卡里填本机表单 → Secret 只打 /v1/im/wecom；连上了卡自己「接着做」，决定里没有任何值', async () => {
    renderWithProviders(
      <DeckCardView
        card={card(need('im:wecom', '企业微信'))}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const form = await screen.findByTestId('wecom-form')
    const inputs = form.querySelectorAll('input')
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: 'BOT1' } })
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: SECRET } })
    expect((inputs[1] as HTMLInputElement).type).toBe('password')
    fireEvent.submit(form)
    await waitFor(() => expect(saveWecomBot).toHaveBeenCalledTimes(1))
    expect(saveWecomBot.mock.calls[0]?.[0]).toEqual({ bot_id: 'BOT1', secret: SECRET })
    // 提交完表单里也不留
    expect((inputs[1] as HTMLInputElement).value).toBe('')
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1), { timeout: 6000 })
    const [id, input] = decide.mock.calls[0] as [string, Record<string, unknown>, string]
    expect(id).toBe('ap_connect')
    expect(input.action).toBe('approve')
    expect(input.edited_payload).toBeUndefined()
    expect(JSON.stringify(decide.mock.calls)).not.toContain(SECRET)
  })

  it('个人微信：卡里就是扫码那一块，条款风险一行在卡上', async () => {
    renderWithProviders(
      <DeckCardView
        card={card(need('im:wechat', '微信'))}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(await screen.findByTestId('im-wechat-scan')).toBeTruthy()
    expect(screen.queryByTestId('setup-connect-elsewhere')).toBeNull()
  })
})

describe('WP334 连接卡里的模型 / 账号', () => {
  it('接模型：卡里是向导第 ① 步那一个件，没有「先逛逛演示数据」', async () => {
    renderWithProviders(
      <DeckCardView
        card={card(need('model', 'AI 模型'))}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    expect(await screen.findByTestId('onboarding-ai')).toBeTruthy()
    expect(screen.queryByTestId('ai-demo')).toBeNull()
    expect(screen.queryByTestId('setup-connect-elsewhere')).toBeNull()
  })

  it('工坊账号：卡里是注册 / 登录表单（不跳设置页）', async () => {
    renderWithProviders(
      <DeckCardView
        card={card(need('workshop_account', 'Agents 工坊账号'))}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    await waitFor(() =>
      expect(document.querySelector('[data-testid^="setup-cloud"]')).not.toBeNull(),
    )
    expect(screen.queryByTestId('setup-connect-elsewhere')).toBeNull()
  })

  it('第三栏开不出来时退回哪一页', () => {
    expect(connectFallbackPath('model')).toBe('/settings?tab=models')
    expect(connectFallbackPath('deepseek_account')).toBe('/settings?tab=models')
    expect(connectFallbackPath('workshop_account')).toBe('/settings?tab=account')
    expect(connectFallbackPath('im:wecom')).toBe('/im-channels')
    expect(connectFallbackPath('imap_smtp')).toBe('/connections?service=imap_smtp')
  })
})
