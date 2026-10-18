/**
 * WP401（决策 1090）：积木表格的通用筛选——按列取值（下拉多选）、文字搜索、日期范围；几列一起筛 = 都得对上；
 * 清空；筛法按表格 id 记在本机。面板积木只有列声明里写了 `filter` 的列出漏斗；AI 用 genui 画的表自动带。
 */

import { filterGenuiSpec } from '@agentsws/contracts'
import type { BlockData } from '@agentsws/deck'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyFilters,
  filterColumns,
  inferFilterKind,
  readTableFilters,
  TABLE_FILTER_KEY_PREFIX,
  tableFingerprint,
  writeTableFilters,
} from '@/lib/table-filter'
import { renderWithProviders } from './helpers'

// 整张面板 + 筛选控件逐个点，单条要十几秒；机器忙时 5 秒默认值必超时（int/1020 门禁）
vi.setConfig({ testTimeout: 120_000 })

const { BlockBody } = await import('@/components/blocks/block-view')
const { default: GenuiView } = await import('@/components/answer/genui/genui-view')

const SLOW = { timeout: 30_000 }

// Node 25 自带那个全局 localStorage 是残的（没有 getItem / setItem），换一份内存的
let store = new Map<string, string>()
beforeEach(() => {
  store = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v)
    },
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WP401 筛法（纯函数）', () => {
  it('看数据判怎么筛：全是数不筛、日期选起止、几种取值勾、一串字搜', () => {
    expect(inferFilterKind([1, 2, 3])).toBeUndefined()
    expect(inferFilterKind(['12', '3.5', ''])).toBeUndefined()
    expect(inferFilterKind(['2026-10-01T08:00:00Z', '2026-10-02', ''])).toBe('date')
    expect(inferFilterKind(['正面', '负面', '正面', ''])).toBe('select')
    expect(inferFilterKind(['甲说了一句', '乙说了一句', '丙说了一句'])).toBe('search')
    expect(inferFilterKind(['', ''])).toBeUndefined()
  })

  it('declared 只认写了 filter 的列；auto 每列都判；选项按屏上的字排、空的放最后', () => {
    const rows = [
      { a: 'x', b: 'paid', n: 1 },
      { a: 'y', b: '', n: 2 },
      { a: 'z', b: 'paid', n: 3 },
    ]
    const cols = [
      { key: 'a', label: 'A' },
      { key: 'b', label: 'B', filter: true as const },
      { key: 'n', label: 'N' },
    ]
    const declared = filterColumns(cols, rows, (r, k) => r[k as 'a'], 'declared')
    expect(declared.map((c) => [c.key, c.kind, c.options])).toEqual([['b', 'select', ['paid', '']]])
    const auto = filterColumns(cols, rows, (r, k) => r[k as 'a'], 'auto')
    expect(auto.map((c) => c.key)).toEqual(['a', 'b'])
  })

  it('几列一起筛 = 都得对上；勾的值已经不在选项里就当没勾', () => {
    const rows = [
      { s: '正面', d: '2026-10-01', t: 'Reddit 上有人夸' },
      { s: '负面', d: '2026-10-03', t: 'Reddit 上有人骂' },
      { s: '正面', d: '2026-10-05', t: '新闻稿' },
    ]
    const cols = filterColumns(
      [
        { key: 's', label: '情绪', filter: 'select' as const },
        { key: 'd', label: '日', filter: 'date' as const },
        { key: 't', label: '说了什么', filter: 'search' as const },
      ],
      rows,
      (r, k) => r[k as 's'],
      'declared',
    )
    const get = (r: (typeof rows)[number], k: string): string => r[k as 's']
    expect(applyFilters(rows, cols, { s: { values: ['正面'] } }, get)).toHaveLength(2)
    expect(
      applyFilters(rows, cols, { s: { values: ['正面'] }, t: { q: 'reddit' } }, get).map(
        (r) => r.d,
      ),
    ).toEqual(['2026-10-01'])
    expect(
      applyFilters(rows, cols, { d: { from: '2026-10-02', to: '2026-10-05' } }, get),
    ).toHaveLength(2)
    expect(applyFilters(rows, cols, { s: { values: ['早没了'] } }, get)).toHaveLength(3)
  })

  it('本机记住：按表格 id 一份；存坏了当没筛；全清空就忘掉', () => {
    writeTableFilters('t1', { a: { q: '耳机' }, b: { values: [] } })
    expect(localStorage.getItem(`${TABLE_FILTER_KEY_PREFIX}t1`)).toBe('{"a":{"q":"耳机"}}')
    expect(readTableFilters('t1')).toEqual({ a: { q: '耳机' } })
    expect(readTableFilters('t2')).toEqual({})
    localStorage.setItem(`${TABLE_FILTER_KEY_PREFIX}bad`, '{not json')
    expect(readTableFilters('bad')).toEqual({})
    writeTableFilters('t1', {})
    expect(readTableFilters('t1')).toEqual({})
    expect(tableFingerprint(['a'], [[1]])).toBe(tableFingerprint(['a'], [[1]]))
    expect(tableFingerprint(['a'], [[1]])).not.toBe(tableFingerprint(['a'], [[2]]))
  })
})

const mentions = (): BlockData =>
  ({
    block: {
      id: 'pr.monitoring.mentions',
      placement: 'role_view',
      component: 'table',
      title: '提及流',
      query: 'pr.mentions',
      source: 'google_alerts',
    },
    range: 'last_7d',
    status: 'ok',
    payload: {
      columns: [
        { key: 'published_at', label: '什么时候', filter: 'date' },
        { key: 'origin', label: '在哪儿', filter: 'select' },
        { key: 'sentiment', label: '情绪', filter: 'select' },
        { key: 'body', label: '说了什么', filter: 'search' },
        { key: 'n', label: '赞', align: 'right', format: 'count' },
      ],
      rows: [
        {
          published_at: '2026-10-01',
          origin: 'reddit.com',
          sentiment: '正面',
          body: '耳机音质好',
          n: 3,
        },
        {
          published_at: '2026-10-03',
          origin: 'reddit.com',
          sentiment: '负面',
          body: '耳机断连',
          n: 1,
        },
        {
          published_at: '2026-10-05',
          origin: 'news.example',
          sentiment: '正面',
          body: '新品发布',
          n: 9,
        },
        {
          published_at: '2026-10-07',
          origin: 'news.example',
          sentiment: '',
          body: '评测：耳机',
          n: 2,
        },
      ],
    },
  }) as unknown as BlockData

const bodyRows = (): number =>
  within(screen.getByTestId('block-table')).getAllByRole('row').length - 1

const pick = async (col: string, value: string): Promise<void> => {
  fireEvent.click(screen.getByTestId(`table-filter-${col}`))
  const panel = await screen.findByTestId(`table-filter-panel-${col}`)
  const opt = within(panel)
    .getAllByTestId(`table-filter-opt-${col}`)
    .find((b) => b.getAttribute('data-value') === value)
  if (opt === undefined) throw new Error(`没有 ${value}`)
  fireEvent.click(opt)
}

describe('WP401 面板积木表格', () => {
  it('只有写了 filter 的列有漏斗；漏斗只有图标', () => {
    renderWithProviders(<BlockBody data={mentions()} />)
    for (const k of ['published_at', 'origin', 'sentiment', 'body'])
      expect(screen.getByTestId(`table-filter-${k}`).textContent).toBe('')
    expect(screen.queryByTestId('table-filter-n')).toBeNull()
    expect(screen.queryByTestId('table-filtered')).toBeNull()
  })

  it('下拉多选 + 搜文字 + 日期范围一起筛，表下出「n / 4 行」，清空回全表', async () => {
    renderWithProviders(<BlockBody data={mentions()} />)
    expect(bodyRows()).toBe(4)
    await pick('sentiment', '正面')
    expect(bodyRows()).toBe(2)
    expect(screen.getByTestId('table-filter-sentiment').getAttribute('data-active')).toBe('true')
    fireEvent.click(screen.getByTestId('table-filter-body'))
    fireEvent.change(await screen.findByTestId('table-filter-q-body'), {
      target: { value: '耳机' },
    })
    expect(bodyRows()).toBe(1)
    expect(screen.getByTestId('table-filtered').textContent).toContain('1 / 4 行')
    fireEvent.click(screen.getByTestId('table-filter-published_at'))
    fireEvent.change(await screen.findByTestId('table-filter-from-published_at'), {
      target: { value: '2026-10-02' },
    })
    expect(screen.getByTestId('table-filtered').textContent).toContain('没有对得上的')
    fireEvent.click(screen.getByTestId('table-filtered-clear'))
    expect(bodyRows()).toBe(4)
    expect(screen.queryByTestId('table-filtered')).toBeNull()
  })

  it('空着的那一格也能勾（「（空着）」）', async () => {
    renderWithProviders(<BlockBody data={mentions()} />)
    await pick('sentiment', '')
    expect(bodyRows()).toBe(1)
    expect(screen.getByTestId('block-table').textContent).toContain('评测：耳机')
  })

  it('记住筛法：按积木 id 存在本机，重新打开还在；别的积木不串', async () => {
    const first = renderWithProviders(<BlockBody data={mentions()} />)
    await pick('origin', 'news.example')
    expect(bodyRows()).toBe(2)
    await waitFor(() =>
      expect(readTableFilters('pr.monitoring.mentions')).toEqual({
        origin: { values: ['news.example'] },
      }),
    )
    first.unmount()
    renderWithProviders(<BlockBody data={mentions()} />)
    expect(bodyRows()).toBe(2)
    expect(screen.getByTestId('table-filtered').textContent).toContain('2 / 4 行')
    const other = mentions()
    other.block = { ...other.block, id: 'pr.press.mentions' }
    renderWithProviders(<BlockBody data={other} />)
    expect(screen.getAllByTestId('block-table')[1]?.querySelectorAll('tbody tr').length).toBe(4)
  })
})

describe('WP401 AI 用 genui 画的表自动带筛选', () => {
  const spec = () => {
    const { spec } = filterGenuiSpec({
      items: [
        {
          type: 'table',
          columns: ['订单', '状态', '金额'],
          rows: [
            ['#1001', '待发货', 30],
            ['#1002', '已发货', 45],
            ['#1003', '待发货', 12],
            ['#1004', '已发货', 80],
          ],
        },
      ],
    })
    if (spec === undefined) throw new Error('空')
    return spec
  }

  it('表上一个漏斗：状态勾一项、订单搜一下；金额（全是数）不筛；记在本机', async () => {
    renderWithProviders(<GenuiView spec={spec()} fallback={null} />)
    const wrap = await screen.findByTestId('genui-table-filter', {}, SLOW)
    const rows = (): number => wrap.querySelectorAll('tbody tr').length
    await waitFor(() => expect(rows()).toBe(4))
    fireEvent.click(screen.getByTestId('table-filter-menu'))
    const panel = await screen.findByTestId('table-filter-menu-panel')
    expect(
      within(panel)
        .getAllByRole('group')
        .map((g) => g.querySelector('legend')?.textContent),
    ).toEqual(['订单', '状态'])
    const opt = within(panel)
      .getAllByTestId('table-filter-opt-1')
      .find((b) => b.getAttribute('data-value') === '待发货')
    if (opt === undefined) throw new Error('没有待发货')
    fireEvent.click(opt)
    await waitFor(() => expect(rows()).toBe(2))
    fireEvent.change(within(panel).getByTestId('table-filter-q-0'), { target: { value: '1003' } })
    await waitFor(() => expect(rows()).toBe(1))
    expect(screen.getByTestId('table-filtered').textContent).toContain('1 / 4 行')
    const keys = [...store.keys()].filter((k) => k.startsWith(`${TABLE_FILTER_KEY_PREFIX}genui.`))
    expect(keys).toHaveLength(1)
    fireEvent.click(screen.getByTestId('table-filter-clear'))
    await waitFor(() => expect(rows()).toBe(4))
  })

  it('不到 3 行的表不出漏斗', async () => {
    const { spec: small } = filterGenuiSpec({
      items: [
        {
          type: 'table',
          columns: ['订单', '状态'],
          rows: [
            ['#1', '待发货'],
            ['#2', '待发货'],
          ],
        },
      ],
    })
    if (small === undefined) throw new Error('空')
    renderWithProviders(<GenuiView spec={small} fallback={null} />)
    await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(document.querySelectorAll('tbody tr').length).toBe(2))
    expect(screen.queryByTestId('table-filter-menu')).toBeNull()
  })
})
