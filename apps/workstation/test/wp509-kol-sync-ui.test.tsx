/**
 * WP509（决策 1730 B、1811）：红人同步到飞书表——中栏「同步设置」卡（就地改、「开始同步」带着改过的批）、
 * 第三栏那几行（看状态、停 / 开 / 现在同步、没有时「去设同步」把一句话填进对话框）、插件深链 `/influencer/sync` 的落点。
 */
import type { DeckCard } from '@agentsws/deck'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const decide = vi.fn(async (..._args: unknown[]) => ({}))
const getKolSyncs = vi.fn()
const controlKolSync = vi.fn(async (..._args: unknown[]) => ({}))
const getKolSyncLog = vi.fn(async (..._args: unknown[]) => ({
  rows: [
    {
      id: 'l1',
      at: '2026-10-24T02:30:00.000Z',
      trigger: 'auto',
      state: 'ok',
      message: '加了 1 行，改了 2 处。',
      appended: 1,
      updated: 2,
      fallback: 0,
      failed: 0,
      items: [],
    },
  ],
}))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    decide: (...args: unknown[]) => decide(...args),
    getKolSyncs: (...args: unknown[]) => getKolSyncs(...args),
    controlKolSync: (...args: unknown[]) => controlKolSync(...args),
    getKolSyncLog: (...args: unknown[]) => getKolSyncLog(...args),
  }
})

const { KolSyncBody, isKolSyncPayload } = await import('@/components/kol/kol-sync-body')
const { KolSyncRows } = await import('@/components/kol/kol-sync-panel')
const { influencerSyncTarget } = await import('@/pages/influencer')
const { prefillComposer, useComposerPrefill } = await import('@/lib/composer-prefill')

const payload = {
  form: 'kol_sync' as const,
  sync_id: 'ksync_1',
  name: '红人合作表',
  url: 'https://example.feishu.cn/base/AbcDef123?table=tbl1',
  kind: 'bitable' as const,
  columns: [
    { name: '红人', type: 'text', field: 'name', samples: ['Gadget Jonas'] },
    { name: '主页链接', type: 'url', field: 'url' },
    { name: '合作状态', type: 'select', options: ['待联系', '谈价中', '寄样中'], field: 'stage' },
    { name: '我也不知道', type: 'text', field: null },
    { name: '编号', type: 'readonly', field: null },
  ],
  fields: [
    { id: 'name', zh: '名字' },
    { id: 'url', zh: '主页链接' },
    { id: 'stage', zh: '合作阶段' },
    { id: 'tags', zh: '标签' },
  ],
  key_column: '主页链接',
  what: { new_creators: true, stages: true, collab_records: true },
  cadence: 'realtime' as const,
  stage_column: '合作状态',
  stage_options: ['待联系', '谈价中', '寄样中'],
  stage_map: [
    { stage: 'sourced', zh: '已找到', option: '待联系' },
    { stage: 'closed', zh: '已结案', option: null },
  ],
  allow_new_options: false,
  counts: { table_rows: 12, in_scope: 5, matched: 3, to_append: 2 },
  preview: [
    ['红人', 'Desk Fixture'],
    ['合作状态', '待联系'],
  ] as [string, string][],
}
const card = {
  id: 'ap_s',
  version: 2,
  position_id: 'asg_yt',
  layout: 'policy',
  available_actions: ['approve', 'reject', 'snooze', 'open'],
  detail: { payload },
} as unknown as DeckCard

describe('WP509 同步设置卡', () => {
  it('列对应 / 认人 / 同步什么 / 多久一次 / 对不上的阶段都能就地改；「开始同步」带着改过的批', async () => {
    expect(isKolSyncPayload(payload)).toBe(true)
    expect(isKolSyncPayload({ form: 'record_sink' })).toBe(false)
    renderWithProviders(<KolSyncBody card={card} payload={payload} />)
    expect(screen.getByTestId('kol-sync-counts').textContent).toContain('3 人已在表里')
    expect(screen.getAllByTestId('kol-sync-column')).toHaveLength(5)
    // 写不进的列没有下拉
    expect(screen.getAllByTestId('kol-sync-field')).toHaveLength(4)
    const fields = screen.getAllByTestId('kol-sync-field') as HTMLSelectElement[]
    fireEvent.change(fields[3] as HTMLSelectElement, { target: { value: 'tags' } })
    fireEvent.click(screen.getByTestId('kol-sync-what-new_creators'))
    fireEvent.click(screen.getByRole('button', { name: '每小时' }))
    fireEvent.change(screen.getByTestId('kol-sync-stage'), { target: { value: '寄样中' } })
    expect(screen.getByTestId('kol-sync-preview').textContent).toContain('Desk Fixture')
    fireEvent.click(screen.getByTestId('kol-sync-start'))
    await waitFor(() => expect(decide).toHaveBeenCalled())
    const body = decide.mock.calls[0]?.[1] as {
      action: string
      selected_option_id: string
      edited_payload: Record<string, unknown>
    }
    expect(body.action).toBe('approve')
    expect(body.selected_option_id).toBe('start')
    expect(body.edited_payload.columns).toContainEqual({ name: '我也不知道', field: 'tags' })
    expect(body.edited_payload.what).toEqual({
      new_creators: false,
      stages: true,
      collab_records: true,
    })
    expect(body.edited_payload.cadence).toBe('hourly')
    expect(body.edited_payload.key_column).toBe('主页链接')
    expect(body.edited_payload.stage_map).toContainEqual({ stage: 'closed', option: '寄样中' })
    expect(body.edited_payload.allow_new_options).toBe(false)
  })
})

describe('WP509 第三栏「同步到表格」', () => {
  it('一个都没有：一句话 +「去设同步」把那一句填进对话框', async () => {
    getKolSyncs.mockResolvedValueOnce({ syncs: [], ego: true, setup_path: '/influencer/sync' })
    const got: string[] = []
    const on = (e: Event) => got.push((e as CustomEvent<string>).detail)
    window.addEventListener('agentsws:composer-prefill', on)
    renderWithProviders(<KolSyncRows assignment="asg_yt" />)
    fireEvent.click(await screen.findByTestId('kol-sync-setup'))
    expect(got).toEqual(['把红人同步到我的飞书表 '])
    window.removeEventListener('agentsws:composer-prefill', on)
  })

  it('写不进去的亮红点、点开有原因与留痕；停 / 现在同步走接口', async () => {
    getKolSyncs.mockResolvedValue({
      ego: true,
      setup_path: '/influencer/sync',
      syncs: [
        {
          id: 'ksync_1',
          name: '红人合作表',
          url: payload.url,
          kind: 'bitable',
          state: 'broken',
          cadence: 'realtime',
          what: payload.what,
          columns: [{ column: '合作状态', field: 'stage', field_name: '合作阶段' }],
          problem: 'ego 里还没登录飞书——在 ego 里登录一下，工坊下一轮自动接着同步。',
          pending: true,
          totals: { appended: 3, updated: 5, fallback: 0 },
        },
      ],
    })
    renderWithProviders(<KolSyncRows assignment="asg_yt" />)
    const row = await screen.findByTestId('kol-sync-row')
    expect(row.getAttribute('data-todo')).toBe('true')
    fireEvent.click(screen.getByText('红人合作表'))
    expect((await screen.findByTestId('kol-sync-problem')).textContent).toContain('登录')
    expect(await screen.findByText('加了 1 行，改了 2 处。')).toBeTruthy()
    fireEvent.click(screen.getByTestId('kol-sync-pause'))
    await waitFor(() => expect(controlKolSync).toHaveBeenCalledWith('ksync_1', 'pause', 'asg_yt'))
    fireEvent.click(screen.getByTestId('kol-sync-run'))
    await waitFor(() => expect(controlKolSync).toHaveBeenCalledWith('ksync_1', 'run', 'asg_yt'))
  })
})

describe('WP509 插件深链 /influencer/sync', () => {
  const positions = [
    { position_id: 'pos_ops', role_id: 'common.owner' },
    { position_id: 'pos_kol', role_id: 'kol.youtube' },
  ]
  it('落到红人营销岗位、对话框预填那一句；带 status=1 开「连接」那一格；没有红人岗位去首页', () => {
    expect(influencerSyncTarget(positions, new URLSearchParams(), '把红人同步到我的飞书表 ')).toBe(
      `/positions/pos_kol?ask=${encodeURIComponent('把红人同步到我的飞书表 ').replace(/%20/g, '+')}`,
    )
    expect(influencerSyncTarget(positions, new URLSearchParams('status=1'), 'x')).toBe(
      '/positions/pos_kol?panel=connections',
    )
    expect(influencerSyncTarget([], new URLSearchParams(), 'x')).toBe('/?ask=x')
  })

  it('对话框那一侧：地址栏的 ?ask= 读一次就收掉；页面里的按钮也能填', () => {
    window.history.replaceState(null, '', '/positions/pos_kol?ask=hello')
    const got: string[] = []
    function Probe(): null {
      useComposerPrefill((t: string) => {
        got.push(t)
      })
      return null
    }
    renderWithProviders(<Probe />)
    expect(got).toEqual(['hello'])
    expect(window.location.search).toBe('')
    act(() => prefillComposer('again'))
    expect(got).toEqual(['hello', 'again'])
  })
})
