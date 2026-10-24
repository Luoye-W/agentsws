/**
 * WP402 工作台那一半：
 *
 * - 连接卡那一行的问号里写明这一次换了路读的那几家（工坊云端 / 你自己的浏览器）；
 * - Amazon 运营「竞品动向」块：被 Amazon 拦了那一句（品牌级暂停）；「读不到时用你的浏览器」同意 / 撤回；
 * - 竞品变化表（积木表格）能按日期筛（决策 1145：竞品、种类、日期）；
 * - 决策 1132：第七张卡「工坊服务」留着——排最下、可拖到别处、默认收起、有等你的单亮黄点。
 */
import type { CompetitorWatchSource, CompetitorWatchView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AmazonOpsBoard } from '@/components/amazon/amazon-ops-board'
import '@/components/amazon/amazon-competitors'
import type { RailScope } from '@/components/rail/rail-scope'
import { CompetitorChangesTable, competitorStatusText } from '@/components/reports/competitor-watch'
import { setOwnBrowserConsent } from '@/lib/competitor-watch-api'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

const t = (key: string, vars?: Record<string, string | number>) => translate('zh', key, vars)

const src = (over: Partial<CompetitorWatchSource>): CompetitorWatchSource =>
  ({
    id: 'cw_shop_c_rival',
    workspace_id: 'ws_1' as never,
    kind: 'shop_catalog',
    url: 'https://rival.example',
    group: 'competitor',
    label: 'Rival',
    competitor_id: 'c_rival',
    every_hours: 24,
    added_via: 'suggest',
    status: 'ok',
    created_at: '2026-10-19T01:30:00.000Z',
    ...over,
  }) as CompetitorWatchSource

const view = (
  sources: CompetitorWatchSource[],
  extra: Partial<CompetitorWatchView> = {},
): CompetitorWatchView => ({
  settings: { enabled: true, day_start_hour: 9, every_hours: 24, new_within_days: 7 },
  sources,
  summary: {
    sources: sources.length,
    competitors: sources.length,
    ok: sources.length,
    failed: 0,
    partial: 0,
    unchecked: 0,
    failed_labels: [],
  },
  missing_adapters: [],
  ...extra,
})

let current: CompetitorWatchView | null = null
let orders: unknown[] = []
vi.mock('@/lib/workshop-services-api', async (orig) => {
  const real = await orig<typeof import('@/lib/workshop-services-api')>()
  return { ...real, listWorkshopOrders: vi.fn(async () => ({ orders })) }
})
vi.mock('@/lib/competitor-watch-api', async (orig) => {
  const real = await orig<typeof import('@/lib/competitor-watch-api')>()
  return {
    ...real,
    getCompetitorWatch: vi.fn(async () => current),
    getCompetitorChanges: vi.fn(async () => [
      {
        id: 'cc_old',
        workspace_id: 'ws_1',
        kind: 'price',
        competitor_id: 'c_rival',
        competitor: 'Rival',
        source_id: 'cw_shop_c_rival',
        source_kind: 'shop_catalog',
        product_key: 'p1',
        title: 'Trail',
        detected_at: '2026-10-05T01:00:00.000Z',
        text: { zh: 'Trail：降价 10%', en: 'Trail: price down 10%' },
      },
      {
        id: 'cc_new',
        workspace_id: 'ws_1',
        kind: 'new',
        competitor_id: 'c_rival',
        competitor: 'Rival',
        source_id: 'cw_shop_c_rival',
        source_kind: 'shop_catalog',
        product_key: 'p2',
        title: 'Ridge',
        url: 'https://rival.example/products/ridge',
        detected_at: '2026-10-18T01:00:00.000Z',
        text: { zh: 'Ridge：上新', en: 'Ridge: new' },
      },
    ]),
    runCompetitorWatch: vi.fn(async () => ({})),
    setOwnBrowserConsent: vi.fn(async (_a: string, consent: string) => ({ state: consent })),
  }
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WP402 · 连接卡：走了哪条路', () => {
  it('换了路读的那几家写进问号里（工坊云端 / 你自己的浏览器），不多占一行字', () => {
    const v = view([
      src({ last_via: 'cloud' }),
      src({ id: 'b', label: 'Ecoflow', competitor_id: 'c_e', last_via: 'extension' }),
      src({ id: 'c', label: 'Direct', competitor_id: 'c_d', last_via: 'direct' }),
    ])
    expect(competitorStatusText(v, t)).toEqual({
      text: '3 家',
      bad: false,
      who: 'Rival 是工坊云端读的；Ecoflow 是在你自己的浏览器里读的',
    })
  })
})

const amz = (over: Partial<CompetitorWatchSource> = {}) =>
  src({
    id: 'cw_amz_c_rival_US',
    kind: 'amazon_asin',
    url: 'https://www.amazon.com',
    marketplace: 'US',
    asins: ['B0TESTRG01'],
    ...over,
  })

describe('WP402 · Amazon「竞品动向」块', () => {
  it('同意过：写「已同意」，点「撤回」= 不用、不再问', async () => {
    current = view([amz()], { own_browser: { state: 'granted', available: true } })
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    const row = await screen.findByTestId('amzcw-own-browser')
    expect(row.getAttribute('data-state')).toBe('granted')
    expect(row.textContent).toContain('已同意')
    fireEvent.click(screen.getByTestId('amzcw-own-toggle'))
    await waitFor(() => {
      expect(setOwnBrowserConsent).toHaveBeenCalledWith('asg_amz', 'revoked')
    })
  })

  it('没开 / 没装插件：没装就不出这一行；没开的点「打开」；被拦了写停到几点', async () => {
    current = view([amz()], {
      own_browser: { state: 'revoked', available: true },
      amazon_block: {
        paused_until: new Date(Date.now() + 3_600_000).toISOString(),
        by: 'keywords',
      },
    })
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    expect((await screen.findByTestId('amzcw-paused')).textContent).toContain('Amazon 要人机验证')
    expect(screen.getByTestId('amzcw-own-browser').textContent).toContain('没开')
    fireEvent.click(screen.getByTestId('amzcw-own-toggle'))
    await waitFor(() => {
      expect(setOwnBrowserConsent).toHaveBeenCalledWith('asg_amz', 'granted')
    })
  })

  it('这台没有那条路（没装插件）：不出那一行', async () => {
    current = view([amz()], { own_browser: { state: 'unasked', available: false } })
    renderWithProviders(<AmazonOpsBoard assignment="asg_amz" />)
    await screen.findByTestId('amzcw-summary')
    expect(screen.queryByTestId('amzcw-own-browser')).toBeNull()
  })
})

const STORE: RailScope = {
  tier: 'position',
  scope_id: 'pos_web',
  name: '网站运营',
  assignment: 'asg_store',
  roles: [{ role_id: 'dtc.store', assignment: 'asg_store' }],
}

describe('WP402 · 竞品变化表是积木表格（决策 1145）', () => {
  it('按日期筛（选起止）；说了什么那一格点得开', { timeout: 120_000 }, async () => {
    const mem = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => {
        mem.set(k, v)
      },
      removeItem: (k: string) => {
        mem.delete(k)
      },
    })
    current = view([src({})])
    renderWithProviders(<CompetitorChangesTable scope={STORE} />)
    const rows = () => within(screen.getByTestId('competitor-table')).getAllByRole('row').length - 1
    await waitFor(() => expect(rows()).toBe(2))
    const link = screen.getByText('Ridge：上新').closest('a')
    expect(link?.getAttribute('href')).toBe('https://rival.example/products/ridge')
    fireEvent.click(screen.getByTestId('table-filter-detected_at'))
    fireEvent.change(await screen.findByTestId('table-filter-from-detected_at'), {
      target: { value: '2026-10-10' },
    })
    expect(rows()).toBe(1)
    expect(screen.getByTestId('table-filtered').textContent).toContain('1 / 2 行')
  })
})

describe('WP402 · 决策 1132：第七张卡「工坊服务」留着', () => {
  it('排最下、可拖到别处（顺序按人记）、默认收起', async () => {
    const { ensureBuiltinPanels } = await import('@/components/rail/builtin-panels')
    const { listRailCards } = await import('@/components/rail/registry')
    const { cardOpen } = await import('@/components/rail/rail-state')
    ensureBuiltinPanels()
    const ids = listRailCards().map((c) => c.id)
    expect(ids.at(-1)).toBe('workshop-services')
    // WP504：多了三张库卡（红人库 / 知识库 / 素材，只在用它的岗位出）；WP450 多一张「编辑日历」（同理），原来那 7 张不变
    expect(ids).toHaveLength(11)
    expect(ids.filter((id) => !id.endsWith('-library') && id !== 'seo-plan')).toHaveLength(7)
    expect(listRailCards(['workshop-services'])[0]?.id).toBe('workshop-services')
    expect(cardOpen({}, 'workshop-services')).toBe(false)
  })

  it('有等你的单：标题行亮黄点；没有单：什么都不出', async () => {
    const { useWorkshopServicesStatus } = await import('@/components/workshop-services/status')
    function Probe(): ReactNode {
      const st = useWorkshopServicesStatus({} as never, true)
      return (
        <span data-testid="svc-status" data-dot={st?.dot ?? ''}>
          {st?.summary ?? ''}
        </span>
      )
    }
    orders = [{ order: { id: 'o1', status: 'delivered' } }, { order: { id: 'o2', status: 'paid' } }]
    renderWithProviders(<Probe />)
    await waitFor(() =>
      expect(screen.getByTestId('svc-status').getAttribute('data-dot')).toBe('attention'),
    )
    expect(screen.getByTestId('svc-status').textContent).toContain('2')
  })
})
