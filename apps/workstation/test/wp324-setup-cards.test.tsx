/**
 * WP324（决策 690）：连接卡 / 配置卡在卡片流（同一张卡在事项时间线里也是这一块）里就地连 / 就地填。
 *
 * - 连接卡：按 service 挑现成的接法（这里是本机原生表单）；口令只打连接面的 `/submit`，**不进卡的决定**；
 *   连上了卡自己点「接着做」（`approve`，没有任何值）；底下那排没有点不对的「接着做」，只有「先不连」；
 * - 配置卡：建议值预填，「保存并接着做」= `approve` 带 `values`；像口令的格子不画；
 * - 第三栏连接卡的地址：`agentsws://connect/<service>+<service>`。
 */
import type { ConnectRequestPayload, SetupRequestPayload } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quickActions } from '@/components/deck/deck-action-bar'
import { DeckCardView } from '@/components/deck/deck-card'
import { connectAddress, servicesOfAddress } from '@/components/setup/use-open-connect'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const SECRET = 'pk_live_should_never_leave_the_form'

let connected = false
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))
const submitConnection = vi.fn(async (_service: string, _input: unknown, _asg?: string) => {
  connected = true
  return { test: { ok: true, checked_at: '2026-10-14T09:00:00.000Z' } }
})
const beginConnect = vi.fn(async () => ({
  request_id: 'req_1',
  secure_form: {
    fields: [
      { name: 'account', label: '账号', required: true, secret: false },
      { name: 'api_key', label: 'API Key', required: true, secret: true },
    ],
  },
}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPositions: async () => ({
      positions: [{ position_id: 'asg_owner', role_id: 'common.owner', name: '负责人' }],
    }),
    listProviders: async () => ({
      providers: [
        {
          service: 'klaviyo_x',
          label: '邮件营销',
          auth: 'api_key',
          fields: [],
          available: true,
          data_sources: [],
          setup_guide: { summary: '', steps: [], links: [] },
        },
      ],
    }),
    listConnections: async () => ({
      connections: connected
        ? [{ id: 'c1', service: 'klaviyo_x', status: 'active', service_label: '邮件营销' }]
        : [],
    }),
    beginConnect: () => beginConnect(),
    submitConnection: (s: string, i: unknown, a?: string) => submitConnection(s, i, a),
    decide: (id: string, input: unknown, asg: string) => decide(id, input, asg),
  }
})

beforeEach(() => {
  connected = false
  decide.mockClear()
  submitConnection.mockClear()
})

function card(kind: 'connect_request' | 'setup_request', payload: unknown): DeckCard {
  const base = draftCard()
  return draftCard({
    id: `ap_${kind}`,
    kind,
    layout: 'policy',
    title: kind === 'connect_request' ? '先连上邮件营销' : '先设好目标市场',
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '接着做', reject: '先不连', snooze: '稍后' },
    detail: { ...base.detail, payload: payload as Record<string, unknown> },
  })
}

const connectPayload: ConnectRequestPayload = {
  form: 'connect_request',
  why: '这件事要用到邮件营销，连上我就接着做。',
  needs: [{ kind: 'email_marketing', service: 'klaviyo_x', name: '邮件营销', required: true }],
  risk: '连上后我只看数和起草。',
  resume: { matter_id: 'mat_1', person_id: 'per_1', assignment_id: 'asg_1' },
}

describe('连接卡（WP324）', () => {
  it('就地填本机表单 → 口令只进 /submit；连上了卡自己「接着做」，决定里没有任何值', async () => {
    const c = card('connect_request', connectPayload)
    renderWithProviders(<DeckCardView card={c} mode="zh_summary" onDecide={noop} onOpen={noop} />)
    expect(screen.getByTestId('setup-connect-risk').textContent).toContain('只看数和起草')
    // 底下那排：没有「接着做」（主按钮在卡身里），有「先不连」
    const bar = screen.getByTestId('deck-action-bar')
    expect(within(bar).queryByText('接着做')).toBeNull()
    expect(quickActions(c)).not.toContain('approve')

    await userEvent.click(await screen.findByTestId('setup-connect-start'))
    const form = await screen.findByTestId('secure-form')
    const inputs = form.querySelectorAll('input')
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: 'shop-a' } })
    fireEvent.change(inputs[1] as HTMLInputElement, { target: { value: SECRET } })
    expect((inputs[1] as HTMLInputElement).type).toBe('password')
    fireEvent.submit(form)

    await waitFor(() => expect(submitConnection).toHaveBeenCalledTimes(1))
    expect(JSON.stringify(submitConnection.mock.calls[0])).toContain(SECRET)
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1), { timeout: 4000 })
    const [id, input] = decide.mock.calls[0] as [string, Record<string, unknown>, string]
    expect(id).toBe('ap_connect_request')
    expect(input.action).toBe('approve')
    expect(input.edited_payload).toBeUndefined()
    expect(JSON.stringify(decide.mock.calls)).not.toContain(SECRET)
  })
})

describe('配置卡（WP324）', () => {
  const payload: SetupRequestPayload = {
    form: 'setup_request',
    target: 'x.region',
    why: '要知道往哪卖。',
    fields: [
      {
        key: 'region',
        label: '目标市场',
        kind: 'select',
        options: [
          { value: 'us', label: '美国' },
          { value: 'de', label: '德国' },
        ],
        suggested: 'de',
        suggested_why: '店里七成订单来自德国',
        required: true,
      },
      { key: 'api_token', label: '令牌', kind: 'text', required: false },
    ],
  }

  it('建议值预填；像口令的格子不画；保存 = approve 带 values', async () => {
    renderWithProviders(
      <DeckCardView
        card={card('setup_request', payload)}
        mode="zh_summary"
        onDecide={noop}
        onOpen={noop}
      />,
    )
    const fields = screen.getAllByTestId('setup-field')
    expect(fields.map((f) => f.dataset.key)).toEqual(['region'])
    const select = within(fields[0] as HTMLElement).getByRole('combobox') as HTMLSelectElement
    expect(select.value).toBe('de')
    await userEvent.click(screen.getByTestId('setup-fields-save'))
    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1))
    const input = decide.mock.calls[0]?.[1] as {
      action: string
      edited_payload: { values: unknown }
    }
    expect(input.action).toBe('approve')
    expect(input.edited_payload.values).toEqual({ region: 'de' })
  })
})

describe('第三栏连接卡的地址（WP324）', () => {
  it('来回不丢（带冒号的渠道 id 也认）', () => {
    const a = connectAddress(['ga4', 'im:feishu'])
    expect(a.startsWith('agentsws://connect/')).toBe(true)
    expect(servicesOfAddress(a)).toEqual(['ga4', 'im:feishu'])
    expect(servicesOfAddress('agentsws://file/x')).toEqual([])
  })
})

describe('事项时间线（WP324）', () => {
  const ev = (over: Record<string, unknown>) =>
    ({
      id: 'e1',
      matter_id: 'mat_1',
      at: '2026-10-14T09:00:00.000Z',
      kind: 'status',
      text: '这次卡在缺连接上：在下面这张卡上连好，我就接着做。',
      actor: { kind: 'system', id: 'runtime' },
      ...over,
    }) as never

  it('出了连接卡：卡住那一句缩成一行字（不再出「去连接」红卡）；没出卡的老样子照旧', async () => {
    const { buildItems } = await import('@/components/matter/matter-model')
    const withCard = buildItems(
      [
        ev({
          blocked: {
            reason: 'not_connected',
            connections: ['Meta 广告'],
            tools: [],
            card_id: 'apr_1',
          },
        }),
      ],
      { closed: false },
    )
    expect(withCard.at(-1)).toMatchObject({ kind: 'sys', variant: 'plain' })
    const old = buildItems(
      [ev({ blocked: { reason: 'not_connected', connections: ['Meta 广告'], tools: [] } })],
      { closed: false },
    )
    expect(old.at(-1)).toMatchObject({ kind: 'blocked' })
  })
})
