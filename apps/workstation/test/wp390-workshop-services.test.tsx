/**
 * WP390（docs/105 §4 / §5）：工坊服务在工作台里的样子。
 *
 * - 推荐卡：挂在回答末尾一行「名字 · 起价 · 看看」；「看看」出卡、「不用」30 天不推；不写合作方名字；
 * - 价目单：勾几项、填数量与对象，合计当场算；没勾 / 数量不对按不动；「下单」= approve 带改过的几行；
 *   卡底那排没有点不对的「同意」（主按钮在卡身里）；
 * - 需求单：缺必答的先改；提交 = approve 带答案；下单卡写清多少、多久、能改几次、几天不点自动通过；
 * - 验收卡：通过 / 要改 / 申请退款（申请退款要写理由）；联系方式卡：自己选给哪一种；
 * - 「缺设置」卡上的「交给工坊办」；订单面板：在等你的事、消息、起草不替你答应加钱。
 */
import type {
  ServiceAcceptanceCardPayload,
  ServiceMenuCardPayload,
  ServiceOrderCardPayload,
  ServicePayCardPayload,
  ServiceRequirementsCardPayload,
  ServiceView,
  WorkshopServiceOrderDetail,
} from '@agentsws/contracts'
import { serviceCardSnapshot } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { quickActions } from '@/components/deck/deck-action-bar'
import { DeckCardView } from '@/components/deck/deck-card'
import { ServiceOrderPanel } from '@/components/workshop-services/order-panel'
import { ServiceOfferLine } from '@/components/workshop-services/service-offer-line'
import { serviceOrderAddress } from '@/lib/workshop-services-api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))
const calls: { path: string; body?: unknown }[] = []
let orderDetail: WorkshopServiceOrderDetail | undefined

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    decide: (id: string, input: unknown, asg: string) => decide(id, input, asg),
    api: async (path: string, init: { body?: unknown } = {}) => {
      calls.push({ path, ...(init.body === undefined ? {} : { body: init.body }) })
      if (path === '/v1/workshop-services/start')
        return { next: 'card', card_id: 'ap_1', message: '' }
      if (path === '/v1/workshop-services/decline') return { until: '2026-11-17T00:00:00.000Z' }
      if (path.endsWith('/draft-reply'))
        return {
          summary: '对方在说：要加一页',
          text: '收到。费用 / 范围这一块我想一想再回你。',
          needs_you: true,
        }
      if (path.startsWith('/v1/workshop-services/orders/')) return orderDetail
      return {}
    },
  }
})

beforeEach(() => {
  decide.mockClear()
  calls.length = 0
})

const base = {
  summary_zh: '一句话',
  summary_en: 'One line',
  revisions: 2,
  questions: [],
  deliverables: [],
  positions: [],
  intents: [],
  available: true,
}

const ENGAGE: ServiceView = {
  ...base,
  id: 'demo.engagement',
  kind: 'standard',
  label_zh: '社媒互动',
  label_en: 'Engagement',
  pricing_mode: 'per_unit',
  menu: [
    {
      id: 'like',
      label_zh: '点赞',
      label_en: 'Likes',
      unit_zh: '个',
      unit_en: 'each',
      credits_per_unit: 0.5,
      min_quantity: 10,
      max_quantity: 500,
      target_fields: [
        { name: 'post_url', type: 'string', required: true, max: 300, label_zh: '帖子链接' },
      ],
    },
    {
      id: 'comment',
      label_zh: '评论',
      label_en: 'Comments',
      unit_zh: '条',
      unit_en: 'each',
      credits_per_unit: 8,
      min_quantity: 1,
      max_quantity: 50,
      target_fields: [],
    },
  ],
  promise: { accept_hours: 24, deliver_hours: 24 },
  auto_accept_hours: 24,
  landing: 'resume_step',
  provider_label: 'partner_team',
}

const SITE: ServiceView = {
  ...base,
  id: 'workshop.site_build',
  kind: 'custom',
  label_zh: '工坊建站',
  label_en: 'Site build',
  pricing_mode: 'quote',
  from_credits: 800,
  questions: [
    { id: 'sell', label_zh: '卖什么', label_en: 'What', required: true },
    { id: 'market', label_zh: '目标市场', label_en: 'Market', required: true },
  ],
  milestones: [
    { id: 'brief', label_zh: '需求确认', label_en: 'Brief', share_percent: 20 },
    { id: 'design', label_zh: '设计稿', label_en: 'Design', share_percent: 40 },
    { id: 'launch', label_zh: '上线', label_en: 'Launch', share_percent: 40 },
  ],
  promise: { accept_hours: 24, quote_hours: 48, deliver_hours: 240 },
  auto_accept_hours: 168,
  landing: 'theme',
  provider_label: 'workshop_team',
}

function serviceCard(payload: ServiceOrderCardPayload, title = '卡'): DeckCard {
  const b = draftCard()
  return draftCard({
    id: 'ap_svc',
    kind: 'service_order',
    layout: 'policy',
    title,
    available_actions: ['approve', 'reject', 'snooze', 'open'],
    action_labels: { approve: '同意', reject: '先不要', snooze: '稍后' },
    ...(payload.form === 'service_acceptance'
      ? {
          options: [
            { id: 'accept', label: '通过' },
            { id: 'revise', label: '要改' },
            { id: 'dispute', label: '申请退款' },
          ],
        }
      : {}),
    detail: { ...b.detail, payload: payload as unknown as Record<string, unknown> },
  })
}
const render = (card: DeckCard): void => {
  renderWithProviders(<DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />)
}

describe('WP390 推荐卡', () => {
  it('一行「名字 · 起价 · 看看」，不写合作方名字；「看看」出卡、「不用」记下', async () => {
    renderWithProviders(
      <ServiceOfferLine
        offer={{
          service_id: 'workshop.site_build',
          kind: 'custom',
          label_zh: '工坊建站',
          label_en: 'Site build',
          pricing_mode: 'quote',
          from_credits: 800,
          provider_label: 'workshop_team',
        }}
        matterId="mat_1"
      />,
    )
    const line = screen.getByTestId('service-offer')
    expect(line.textContent).toContain('工坊建站')
    expect(line.textContent).toContain('起价 800 积分')
    expect(line.textContent).toContain('先免费聊需求')
    await userEvent.click(screen.getByTestId('service-offer-look'))
    await waitFor(() => {
      expect(calls.find((c) => c.path === '/v1/workshop-services/start')?.body).toEqual({
        service_id: 'workshop.site_build',
        matter_id: 'mat_1',
      })
    })
  })

  it('「不用」：这一项 30 天不推', async () => {
    renderWithProviders(
      <ServiceOfferLine
        offer={{
          service_id: 'demo.engagement',
          kind: 'standard',
          label_zh: '社媒互动',
          label_en: 'Engagement',
          pricing_mode: 'per_unit',
          from_credits: 5,
          provider_label: 'partner_team',
        }}
      />,
    )
    await userEvent.click(screen.getByTestId('service-offer-decline'))
    expect(await screen.findByTestId('service-offer-declined')).toBeTruthy()
    expect(calls.find((c) => c.path === '/v1/workshop-services/decline')?.body).toEqual({
      service_id: 'demo.engagement',
    })
  })
})

describe('WP390 价目单 / 需求单 / 下单卡', () => {
  it('价目单：勾两项、填对象，合计当场算；「下单」= approve 带改过的几行；卡底没有「同意」', async () => {
    const payload: ServiceMenuCardPayload = {
      form: 'service_menu',
      service: serviceCardSnapshot(ENGAGE),
      lines: [],
      idempotency_key: 'k1',
    }
    const card = serviceCard(payload, '社媒互动 · 价目单')
    expect(quickActions(card)).not.toContain('approve')
    render(card)
    const order = screen.getByTestId('service-menu-order') as HTMLButtonElement
    expect(order.disabled).toBe(true)
    fireEvent.click(screen.getByTestId('service-menu-pick-like'))
    fireEvent.change(screen.getByTestId('service-menu-qty-like'), { target: { value: '50' } })
    // 没填帖子链接按不动
    expect((screen.getByTestId('service-menu-order') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('service-menu-target-like-post_url'), {
      target: { value: 'https://reddit.com/r/x/1' },
    })
    fireEvent.click(screen.getByTestId('service-menu-pick-comment'))
    fireEvent.change(screen.getByTestId('service-menu-qty-comment'), { target: { value: '10' } })
    expect(screen.getByTestId('service-menu-total').textContent).toContain('合计 105 积分')
    await userEvent.click(screen.getByTestId('service-menu-order'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const input = decide.mock.calls[0]?.[1] as {
      action: string
      edited_payload: ServiceMenuCardPayload
    }
    expect(input.action).toBe('approve')
    expect(input.edited_payload.lines).toEqual([
      { item_id: 'like', quantity: 50, target: { post_url: 'https://reddit.com/r/x/1' } },
      { item_id: 'comment', quantity: 10 },
    ])
  })

  it('需求单：缺必答的先填；提交 = approve 带答案（先报价的写「提交，等报价」）', async () => {
    const payload: ServiceRequirementsCardPayload = {
      form: 'service_requirements',
      service: serviceCardSnapshot(SITE),
      answers: [{ question_id: 'sell', answer: '电动自行车' }],
      idempotency_key: 'k2',
    }
    render(serviceCard(payload, '工坊建站 · 需求单'))
    const submit = screen.getByTestId('service-req-submit') as HTMLButtonElement
    expect(submit.textContent).toBe('提交，等报价')
    expect(submit.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('service-req-market'), { target: { value: '美国' } })
    await userEvent.click(screen.getByTestId('service-req-submit'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const input = decide.mock.calls[0]?.[1] as { edited_payload: ServiceRequirementsCardPayload }
    expect(input.edited_payload.answers).toEqual([
      { question_id: 'sell', answer: '电动自行车' },
      { question_id: 'market', answer: '美国' },
    ])
  })

  it('下单卡：多少、多久、能改几次、几天不点自动通过、会交给做的人什么；「同意并支付」', async () => {
    const payload: ServicePayCardPayload = {
      form: 'service_pay',
      stage: 'accept_quote',
      service: serviceCardSnapshot(SITE),
      order_id: 'svo_1',
      credits: 1200,
      deliver_hours: 240,
      milestones: SITE.milestones as never,
      idempotency_key: 'k3',
    }
    render(serviceCard(payload, '工坊建站'))
    const box = screen.getByTestId('service-pay')
    expect(box.textContent).toContain('1,200 积分')
    expect(box.textContent).toContain('约 10 天 · 可改 2 次 · 7 天不点自动通过')
    expect(box.textContent).toContain('会交给做的人：需求单')
    expect(box.textContent).not.toMatch(/风险/)
    await userEvent.click(screen.getByTestId('service-pay-go'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
  })
})

describe('WP390 验收卡 / 联系方式卡', () => {
  const acceptance: ServiceAcceptanceCardPayload = {
    form: 'service_acceptance',
    order_id: 'svo_1',
    service: serviceCardSnapshot(ENGAGE),
    credits: 105,
    proof: { links: ['https://reddit.com/r/x/1'], screenshots: [], completed: [] },
    lines: [
      {
        item_id: 'like',
        quantity: 50,
        completed: 50,
        label_zh: '点赞',
        label_en: 'Likes',
        credits_per_unit: 0.5,
        credits: 25,
      },
      {
        item_id: 'comment',
        quantity: 10,
        completed: 8,
        label_zh: '评论',
        label_en: 'Comments',
        credits_per_unit: 8,
        credits: 80,
      },
    ],
    deliverables: [],
    revisions_left: 1,
    auto_accept_at: '2026-10-19T02:00:00.000Z',
  }

  it('看凭证、写明几时自动通过；通过 = 选项 accept', async () => {
    render(serviceCard(acceptance, '社媒互动 · 交付了'))
    const box = screen.getByTestId('service-acceptance')
    expect(box.textContent).toContain('评论：做了 8 / 10')
    expect(box.textContent).toContain('不点自动通过')
    await userEvent.click(screen.getByTestId('service-accept'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const picked = decide.mock.calls[0]?.[1] as { selected_option_id: string } | undefined
    expect(picked?.selected_option_id).toBe('accept')
  })

  it('申请退款要写一句为什么才交得上去', async () => {
    render(serviceCard(acceptance))
    await userEvent.click(screen.getByTestId('service-dispute'))
    const send = screen.getByTestId('service-acceptance-send') as HTMLButtonElement
    expect(send.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('service-acceptance-reason'), {
      target: { value: '评论是机器人刷的' },
    })
    await userEvent.click(screen.getByTestId('service-acceptance-send'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const input = decide.mock.calls[0]?.[1] as {
      selected_option_id: string
      edited_payload: { reason: string }
    }
    expect(input.selected_option_id).toBe('dispute')
    expect(input.edited_payload.reason).toBe('评论是机器人刷的')
  })

  it('交换联系方式：自己选给哪一种、填了才能同意', async () => {
    render(
      serviceCard({
        form: 'service_contact',
        order_id: 'svo_1',
        service: serviceCardSnapshot(SITE),
        request_id: 'ctx_1',
        reason: '约个时间过一下设计稿',
      }),
    )
    expect((screen.getByTestId('service-contact-agree') as HTMLButtonElement).disabled).toBe(true)
    await userEvent.click(screen.getByLabelText('邮箱'))
    fireEvent.change(screen.getByTestId('service-contact-value'), {
      target: { value: 'me@example.com' },
    })
    await userEvent.click(screen.getByTestId('service-contact-agree'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const agreed = decide.mock.calls[0]?.[1] as { edited_payload: { contact: unknown } } | undefined
    expect(agreed?.edited_payload.contact).toEqual({ kind: 'email', value: 'me@example.com' })
  })
})

describe('WP390 订单面板', () => {
  it('在等你的事、钱、消息；「帮我起草」不替你答应加钱（照实提醒）', async () => {
    orderDetail = {
      order: {
        id: 'svo_1',
        service_id: 'workshop.site_build',
        kind: 'custom',
        label_zh: '工坊建站',
        label_en: 'Site build',
        status: 'waiting_user',
        provider_label: 'workshop_team',
        escrow_credits: 960,
        settled_credits: 240,
        refunded_credits: 0,
        waiting_for: '上传 Logo 原图',
        revisions_left: 2,
        deliver_by: '2026-10-28T00:00:00.000Z',
        deliverables: [],
        acceptances: [],
        message_count: 2,
        actions: ['user_reply'],
        created_at: '2026-10-18T00:00:00.000Z',
        updated_at: '2026-10-18T00:00:00.000Z',
      },
      messages: [
        {
          id: 'm1',
          from: 'provider',
          kind: 'text',
          text: '首页要不要放视频？',
          at: '2026-10-18T01:00:00.000Z',
        },
      ],
      ledger: [
        {
          at: '2026-10-18T00:00:00.000Z',
          order_id: 'svo_1',
          kind: 'escrow',
          credits: 1200,
          text: '扣进托管',
        },
      ],
    }
    renderWithProviders(
      <ServiceOrderPanel address={serviceOrderAddress('svo_1')} tier="position" pathname="/" />,
    )
    const panel = await screen.findByTestId('service-order-panel')
    expect(screen.getByTestId('service-order-waiting').textContent).toContain('上传 Logo 原图')
    expect(panel.textContent).toContain('首页要不要放视频？')
    expect(panel.textContent).toContain('托管 960')
    await userEvent.click(screen.getByTestId('service-order-draft'))
    await waitFor(() => {
      expect((screen.getByTestId('service-order-reply') as HTMLTextAreaElement).value).toContain(
        '想一想再回你',
      )
    })
    expect(screen.getByTestId('service-order-needs-you')).toBeTruthy()
  })
})
