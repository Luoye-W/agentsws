/**
 * WP403（决策 1134）：工作台里的追加费用与订单附件。
 *
 * - 追加卡（`service_pay`、`stage: 'extra'`）：写清加多少、为什么、交付顺延多久；「同意并支付」= approve；
 * - 订单面板：「在等你补材料」那一格能直接传文件（multipart 交给本机）；附件列表里你传的、交付文件都能下载，
 *   过了保留期的只留名字；对方要追加时标黄一行；同意过的追加写在钱那一行上面；太大的文件本机先拦。
 */
import type {
  ServicePayCardPayload,
  ServiceView,
  WorkshopServiceOrderDetail,
} from '@agentsws/contracts'
import { serviceCardSnapshot } from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { ServiceOrderPanel } from '@/components/workshop-services/order-panel'
import { serviceOrderAddress } from '@/lib/workshop-services-api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const noop = (): void => {}
const decide = vi.fn(async (_id: string, _input: unknown, _asg: string) => ({}))
let orderDetail: WorkshopServiceOrderDetail | undefined

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    decide: (id: string, input: unknown, asg: string) => decide(id, input, asg),
    api: async (path: string) =>
      path.startsWith('/v1/workshop-services/orders/') ? orderDetail : {},
  }
})

const fetches: { url: string; method: string; body?: unknown }[] = []
const realFetch = globalThis.fetch
beforeEach(() => {
  decide.mockClear()
  fetches.length = 0
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    fetches.push({ url, method: init?.method ?? 'GET', body: init?.body })
    if (url.endsWith('/attachments') && init?.method === 'POST')
      return new Response(
        JSON.stringify({
          data: {
            id: 'att_00000000000000cc',
            name: 'logo.svg',
            content_type: 'image/svg+xml',
            size: 6,
            sha256: 'c'.repeat(64),
            from: 'user',
            purpose: 'material',
            uploaded_at: '2026-10-18T03:00:00.000Z',
          },
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    return new Response('<svg/>', { status: 200, headers: { 'content-type': 'image/svg+xml' } })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

const SITE: ServiceView = {
  id: 'workshop.site_build',
  kind: 'custom',
  label_zh: '工坊建站',
  label_en: 'Site build',
  summary_zh: '一句话',
  summary_en: 'One line',
  pricing_mode: 'quote',
  from_credits: 800,
  revisions: 2,
  questions: [],
  deliverables: [],
  positions: [],
  intents: [],
  available: true,
  promise: { accept_hours: 24, quote_hours: 48, deliver_hours: 240 },
  auto_accept_hours: 168,
  landing: 'theme',
  provider_label: 'workshop_team',
}

const ORDER = {
  id: 'svo_1',
  service_id: 'workshop.site_build',
  kind: 'custom' as const,
  label_zh: '工坊建站',
  label_en: 'Site build',
  status: 'waiting_user' as const,
  provider_label: 'workshop_team' as const,
  total_credits: 1300,
  escrow_credits: 1300,
  settled_credits: 0,
  refunded_credits: 0,
  waiting_for: '上传 Logo 原图',
  revisions_left: 2,
  deliverables: [],
  acceptances: [],
  message_count: 0,
  actions: ['user_reply' as const],
  extras: [
    {
      id: 'x1',
      credits: 300,
      reason: '会上定了加两页',
      status: 'accepted' as const,
      requested_at: '2026-10-18T01:00:00.000Z',
    },
    {
      id: 'x2',
      credits: 50,
      reason: '加一段动画',
      status: 'pending' as const,
      requested_at: '2026-10-18T02:00:00.000Z',
    },
  ],
  attachments: [
    {
      id: 'att_00000000000000aa',
      name: '需求确认书.pdf',
      content_type: 'application/pdf',
      size: 4096,
      sha256: 'a'.repeat(64),
      from: 'provider' as const,
      purpose: 'delivery' as const,
      uploaded_at: '2026-10-18T02:00:00.000Z',
    },
    {
      id: 'att_00000000000000bb',
      name: '旧稿.pdf',
      content_type: 'application/pdf',
      size: 10,
      sha256: 'b'.repeat(64),
      from: 'provider' as const,
      purpose: 'delivery' as const,
      uploaded_at: '2026-10-18T02:00:00.000Z',
      expired: true as const,
    },
  ],
  created_at: '2026-10-18T00:00:00.000Z',
  updated_at: '2026-10-18T00:00:00.000Z',
}

describe('WP403 追加卡', () => {
  it('写清加多少、为什么、交付顺延多久；「同意并支付」= approve', async () => {
    const payload: ServicePayCardPayload = {
      form: 'service_pay',
      stage: 'extra',
      service: serviceCardSnapshot(SITE),
      order_id: 'svo_1',
      credits: 300,
      deliver_hours: 48,
      extra_id: 'x1',
      extra_reason: '会上定了加两页',
      idempotency_key: 'k',
    }
    const b = draftCard()
    const card: DeckCard = draftCard({
      id: 'ap_extra',
      kind: 'service_order',
      layout: 'policy',
      title: '工坊建站 · 追加费用',
      available_actions: ['approve', 'reject', 'snooze', 'open'],
      action_labels: { approve: '同意', reject: '先不要', snooze: '稍后' },
      detail: { ...b.detail, payload: payload as unknown as Record<string, unknown> },
    })
    renderWithProviders(
      <DeckCardView card={card} mode="zh_summary" onDecide={noop} onOpen={noop} />,
    )
    const box = screen.getByTestId('service-pay')
    expect(box.getAttribute('data-stage')).toBe('extra')
    expect(box.textContent).toContain('追加 300 积分')
    expect(box.textContent).toContain('会上定了加两页')
    expect(box.textContent).toContain('交付顺延约 2 天')
    await userEvent.click(screen.getByTestId('service-pay-go'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
  })
})

describe('WP403 订单面板：附件与追加', () => {
  const panel = async () => {
    orderDetail = { order: ORDER, messages: [], ledger: [] }
    renderWithProviders(
      <ServiceOrderPanel address={serviceOrderAddress('svo_1')} tier="position" pathname="/" />,
    )
    return screen.findByTestId('service-order-panel')
  }

  it('在等你补材料那一格能直接传文件；附件能下载，过了保留期的只留名字；追加标黄、同意过的写出来', async () => {
    const root = await panel()
    const waiting = screen.getByTestId('service-order-waiting')
    expect(waiting.querySelector('[data-testid="service-order-upload"]')).not.toBeNull()
    expect(screen.getByTestId('service-order-extra').textContent).toContain(
      '想追加 50 积分：加一段动画',
    )
    expect(screen.getByTestId('service-order-extras').textContent).toContain('300')
    const files = screen.getByTestId('service-order-files')
    expect(files.textContent).toContain('需求确认书.pdf')
    expect(files.textContent).toContain('交付文件 · 4 KB')
    expect(files.textContent).toContain('旧稿.pdf')
    expect(files.textContent).toContain('已过保留期')
    expect(screen.getAllByTestId('service-order-download')).toHaveLength(1)
    expect(root.textContent).not.toContain('合作方')

    // 传一份：multipart 交给本机
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })
    fireEvent.change(screen.getByTestId('service-order-file'), { target: { files: [file] } })
    await waitFor(() => {
      expect(fetches.some((f) => f.url === '/v1/workshop-services/orders/svo_1/attachments')).toBe(
        true,
      )
    })
    const sent = fetches.find((f) => f.url.endsWith('/attachments'))
    expect(sent?.method).toBe('POST')
    expect(sent?.body).toBeInstanceOf(FormData)
  })

  it('太大的文件本机先拦，不往上传', async () => {
    await panel()
    const big = new File(['x'], 'big.bin')
    Object.defineProperty(big, 'size', { value: 25 * 1024 * 1024 + 1 })
    fireEvent.change(screen.getByTestId('service-order-file'), { target: { files: [big] } })
    expect((await screen.findByTestId('service-order-file-error')).textContent).toContain('25 MB')
    expect(fetches.some((f) => f.url.endsWith('/attachments'))).toBe(false)
  })
})
