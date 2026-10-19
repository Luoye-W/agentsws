/**
 * WP396（docs/106 §13）：Amazon 运营面板「Listing 体检」那一块 + 体检卡。
 *
 * - 摘要：几个 ASIN、几处问题、最要紧的一条；点开一个 ASIN 就地出体检卡；
 * - 每处问题带规则出处（官方带链接）；过时的规则标「这条规则可能过时」；
 * - 文案类有草稿；图片类有「向设计岗下需求单」（点了下一张单，来源是亚马逊店铺运营那条分配）；
 * - 数字读不到写「没读到」；卡底固定一句「连上 Amazon 店铺后能查到更多」；
 * - 还没 ASIN / 这里读不了：照实说，不放「现在体检」。
 */
import type { ListingCheckupView, ListingIssue } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AmazonOpsBoard } from '@/components/amazon/amazon-ops-board'
import { ListingCheckupBlock } from '@/components/amazon/listing-checkup'
import { renderWithProviders } from './helpers'

const FOOTER = '连上 Amazon 店铺后能查到更多（被压制、买不了的原因）'

const issue = (over: Partial<ListingIssue> = {}): ListingIssue => ({
  rule_id: 'title.max_chars',
  area: 'title',
  severity: 'search',
  rule_name: '标题长度',
  source: {
    kind: 'official',
    title: 'Amazon 官方公告：商品标题新要求（2025-01-21 起）',
    url: 'https://sellercentral.amazon.com/seller-forums/discussions/t/533f9cf7',
  },
  rule_checked_at: '2026-10-18',
  rule_stale: false,
  now: '标题 236 个字符，建议不超过 200',
  suggestion: '把标题收到建议长度以内',
  ...over,
})

const view = (over: Partial<ListingCheckupView> = {}): ListingCheckupView => ({
  own_asins: 2,
  rules: [],
  reader_ready: true,
  footer: { zh: FOOTER, en: 'Connect your Amazon store to see more' },
  latest: {
    id: 'lchk_1',
    started_at: '2026-10-18T08:00:00.000Z',
    finished_at: '2026-10-18T08:01:00.000Z',
    trigger: 'manual',
    items: [
      {
        asin: 'B0NORDV001',
        marketplace: 'US',
        url: 'https://www.amazon.com/dp/B0NORDV001',
        status: 'checked',
        title: 'Nordvik Granite Wallet',
        facts: { availability: 'in_stock', rating: 4.6, price: '$54.99', image_count: 2 },
        issues: [
          issue({
            severity: 'blocker',
            rule_id: 'offer.buybox_own',
            rule_name: '购物车是不是你',
            now: '购物车现在是「QuickDeals」在卖',
            source: { kind: 'practice', title: '通行做法：跟卖' },
          }),
          issue({
            rule_stale: true,
            rule_checked_at: '2025-10-18',
            draft: 'Nordvik Granite Wallet for Men',
          }),
          issue({
            rule_id: 'images.min_count',
            area: 'images',
            severity: 'improve',
            rule_name: '图片张数',
            now: '一共 2 张图，建议至少 6 张',
            design_request: { title: 'Amazon 副图：Nordvik（B0NORDV001）', need: '要副图' },
          }),
        ],
        human_checks: ['主图是不是纯白底——建议你看一眼'],
        previous: { at: '2026-10-11T08:00:00.000Z', issues: 6, fixed: 4, added: 1 },
      },
      {
        asin: 'B0NORDV002',
        marketplace: 'US',
        url: 'https://www.amazon.com/dp/B0NORDV002',
        status: 'skipped',
        message: '前面被拦了，没去读',
        issues: [],
        human_checks: [],
      },
    ],
    summary: {
      asins: 2,
      checked: 1,
      issues: 3,
      blockers: 1,
      worst: {
        asin: 'B0NORDV001',
        rule_name: '购物车是不是你',
        now: '购物车现在是「QuickDeals」在卖',
        severity: 'blocker',
      },
    },
  },
  ...over,
})

const state = {
  view: view() as ListingCheckupView | null,
  run: vi.fn(async (..._a: unknown[]) => ({})),
  design: vi.fn(async (..._a: unknown[]) => ({ request: { id: 'dreq_1' } })),
}

vi.mock('@/lib/amazon-listing-api', () => ({
  amazonListingKey: (a: string) => ['amazon-listing', a],
  getAmazonListing: async () => state.view,
  runAmazonListing: (...a: unknown[]) => state.run(...a),
  requestListingDesign: (...a: unknown[]) => state.design(...a),
}))

beforeEach(() => {
  state.view = view()
  state.run.mockClear()
  state.design.mockClear()
})

describe('WP396 「Listing 体检」块', () => {
  it('摘要：几个 ASIN、几处问题、最要紧的一条；填进 Amazon 运营面板那一块', async () => {
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    const summary = await screen.findByTestId('alst-summary')
    expect(summary.textContent).toContain('2 个 ASIN · 3 处问题')
    expect(screen.getByTestId('alst-worst').textContent).toContain('B0NORDV001 购物车是不是你')
    expect(screen.queryByTestId('amzops-empty-listing')).toBeNull()
    fireEvent.click(screen.getByTestId('alst-run'))
    await waitFor(() => expect(state.run).toHaveBeenCalledWith('asg_amz'))
  })

  it('点开一个 ASIN：体检卡——出处、过时标记、草稿、设计需求单、没读到、卡底那一句、上次修了几处', async () => {
    renderWithProviders(<ListingCheckupBlock assignment="asg_amz" />)
    fireEvent.click((await screen.findAllByTestId('alst-asin'))[0] as HTMLElement)
    const card = screen.getByTestId('alst-card')
    expect(screen.getAllByTestId('alst-issue')).toHaveLength(3)
    // WP420（自查 U21）：出处收进问号 / 链接图标的提示里；「现在 → 建议」一行
    const sources = screen.getAllByTestId('alst-source')
    expect(sources[0]?.getAttribute('aria-label')).toContain('通行做法')
    expect(sources[1]?.getAttribute('href')).toMatch(/^https:\/\/sellercentral/)
    expect(screen.getAllByTestId('alst-now-fix')[0]?.textContent).toContain('→')
    expect(screen.getAllByTestId('alst-design')).toHaveLength(1)
    expect(screen.getAllByTestId('alst-stale')).toHaveLength(1)
    expect(screen.getByTestId('alst-stale').textContent).toBe('这条规则可能过时')
    expect(screen.getByTestId('alst-draft').textContent).toContain('Nordvik Granite Wallet for Men')
    expect(screen.getByTestId('alst-facts').textContent).toContain('评分数 没读到')
    expect(screen.getByTestId('alst-facts').textContent).toContain('$54.99')
    expect(screen.getByTestId('alst-footer').textContent).toBe(FOOTER)
    expect(screen.getByTestId('alst-previous').textContent).toBe(
      '上次 6 处，修了 4 处，新冒出 1 处',
    )
    expect(screen.getByTestId('alst-human').textContent).toContain('白底')
    expect(card.textContent).not.toMatch(/改价|上架|提交/)
    fireEvent.click(screen.getByTestId('alst-design'))
    await waitFor(() =>
      expect(state.design).toHaveBeenCalledWith('asg_amz', {
        title: 'Amazon 副图：Nordvik（B0NORDV001）',
        need: '要副图',
      }),
    )
    expect(await screen.findByText('已下单给设计岗')).toBeTruthy()
  })

  it('还没 ASIN、读不了：照实说，不放「现在体检」', async () => {
    const { latest: _l, ...rest } = view()
    state.view = { ...rest, own_asins: 0, reader_ready: false }
    renderWithProviders(<ListingCheckupBlock assignment="asg_amz" />)
    expect(await screen.findByText(/还不知道你家有哪些 ASIN/)).toBeTruthy()
    expect(screen.getByText('这里读不了 Amazon 前台（要桌面版）')).toBeTruthy()
    expect(screen.queryByTestId('alst-run')).toBeNull()
  })
})
