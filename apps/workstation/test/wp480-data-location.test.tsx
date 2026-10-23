/**
 * WP480：设置 → 数据与隐私 →「数据放在哪」，以及同一页两处屏幕用词。
 *
 * - 有桥才出这一行；路径、大小看得见；
 * - 更改位置：壳查过的结果进确认框——要搬多少、大约多久、会暂停；网盘 / 网络盘多一句风险；不能用就说为什么；
 * - 开搬只说 `chosen` / `default`（页面传不进路径）；进度、搬完、失败（回到原位置 / 原位置也没起来）都在这一行里；
 * - 恢复默认位置走同一条路；旧位置的数据「留到哪天」+「现在就删」；
 * - 数据地图：没有中文名的对象整行收进「其他」，`approve member` 这类显示成「批入群申请」——屏幕上没有内部名。
 */
import type { TailoredOntology } from '@agentsws/ontology/view'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type DataLocationBridgeLike,
  type DataLocationLike,
  DataLocationSetting,
  type DataMoveStatusLike,
  type DataTargetCheckLike,
  durationText,
} from '@/components/settings/data-location'
import { formatAgo } from '@/lib/format'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

/** 与 screen-words 守卫同一套判法（那个文件是测试文件，不能 import）：snake_case 与 ISO 时间串。 */
const rawTokens = (text: string): string[] => [
  ...(text.match(/\b[a-z]+(?:_[a-z0-9]+)+\b/g) ?? []),
  ...(text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) ?? []),
]

const w = globalThis as unknown as { agentsws?: unknown }

const CHECK_OK: DataTargetCheckLike = {
  ok: true,
  chosen: 'D:\\工坊 数据',
  target: 'D:\\工坊 数据',
  bytes: 1.2 * 1024 ** 3,
  files: 3412,
  free_bytes: 200 * 1024 ** 3,
  estimate_seconds: 150,
  problems: [],
  warnings: [],
}

function fakeBridge(view: Partial<DataLocationLike> = {}) {
  let listener: ((s: DataMoveStatusLike) => void) | undefined
  let next: DataTargetCheckLike | null = CHECK_OK
  const bridge: DataLocationBridgeLike = {
    get: vi.fn(async () => ({
      path: 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data',
      is_default: true,
      default_path: 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data',
      bytes: 1.2 * 1024 ** 3,
      files: 3412,
      status: { state: 'idle' as const },
      ...view,
    })),
    choose: vi.fn(async () => next),
    checkDefault: vi.fn(async () => ({
      ...CHECK_OK,
      chosen: 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data',
      target: 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data',
    })),
    move: vi.fn(async (_to: 'chosen' | 'default') => ({
      state: 'running' as const,
      step: 'pause',
      to: 'D:\\工坊 数据',
      copied_bytes: 0,
      total_bytes: 0,
      files_done: 0,
      files_total: 0,
      started_at: '2026-10-23T03:44:17.085Z',
    })),
    onChange: vi.fn((l: (s: DataMoveStatusLike) => void) => {
      listener = l
      return () => {
        listener = undefined
      }
    }),
    deleteOld: vi.fn(async () => true),
    reveal: vi.fn(async () => true),
  }
  return {
    bridge,
    emit: (s: DataMoveStatusLike) => {
      act(() => {
        listener?.(s)
      })
    },
    nextCheck: (c: DataTargetCheckLike | null) => {
      next = c
    },
  }
}

beforeEach(() => {
  delete w.agentsws
})
afterEach(() => {
  delete w.agentsws
})

describe('数据放在哪', () => {
  it('网页里 / 旧壳没有桥：这一行不出', () => {
    const { container } = renderWithProviders(<DataLocationSetting />)
    expect(container.textContent).toBe('')
  })

  it('看得见现在的位置、大小；默认位置没有「恢复默认位置」', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    const path = await screen.findByTestId('data-location-path')
    expect(path.textContent).toContain('AppData\\Roaming\\@agentsws\\desktop\\data')
    const row = screen.getByTestId('settings-data-location')
    expect(row.textContent).toContain('默认位置')
    expect(row.textContent).toContain('1.2 GB')
    expect(row.textContent).toContain('3,412 个文件')
    expect(screen.queryByTestId('data-location-reset')).toBeNull()
    fireEvent.click(screen.getByTestId('data-location-reveal'))
    expect(f.bridge.reveal).toHaveBeenCalled()
  })

  it('更改位置 → 确认框说清要搬多少、大约多久、会暂停 → 开始搬（只说 chosen）', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-change'))
    const dialog = await screen.findByTestId('data-location-dialog')
    expect(dialog.textContent).toContain('把数据搬到这里？')
    expect(within(dialog).getByTestId('data-location-dialog-target').textContent).toBe(
      'D:\\工坊 数据',
    )
    const facts = within(dialog).getByTestId('data-location-dialog-facts').textContent ?? ''
    expect(facts).toContain('要搬 1.2 GB（3,412 个文件），大约 3 分钟。')
    expect(facts).toContain('搬的时候工坊会暂停')
    expect(facts).toContain('旧位置的数据留 7 天')
    expect(within(dialog).queryByTestId('data-location-dialog-warnings')).toBeNull()
    fireEvent.click(within(dialog).getByTestId('data-location-start'))
    await waitFor(() => {
      expect(f.bridge.move).toHaveBeenCalledWith('chosen')
    })
    expect(await screen.findByTestId('data-location-progress')).toBeTruthy()
  })

  it('网盘同步文件夹 / 网络盘：确认框里多一句风险', async () => {
    const f = fakeBridge()
    f.nextCheck({ ...CHECK_OK, warnings: ['cloud_sync', 'network'] })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-change'))
    const warns = await screen.findByTestId('data-location-dialog-warnings')
    expect(warns.textContent).toContain('网盘同步文件夹')
    expect(warns.textContent).toContain('断网或 NAS 关机时，工坊打不开')
  })

  it('不能用的文件夹：说为什么（空间不够带数字），能换一个', async () => {
    const f = fakeBridge()
    f.nextCheck({
      ...CHECK_OK,
      ok: false,
      free_bytes: 500 * 1024 ** 2,
      problems: ['no_space', 'system_dir'],
    })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-change'))
    const problems = await screen.findByTestId('data-location-dialog-problems')
    expect(problems.textContent).toContain('空间不够：要 1.4 GB，那里只剩 500 MB。')
    expect(problems.textContent).toContain('这是系统文件夹')
    expect(screen.queryByTestId('data-location-start')).toBeNull()
    f.nextCheck(null)
    fireEvent.click(screen.getByTestId('data-location-again'))
    await waitFor(() => {
      expect(f.bridge.choose).toHaveBeenCalledTimes(2)
    })
  })

  it('选框点了取消：什么都不出', async () => {
    const f = fakeBridge()
    f.nextCheck(null)
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-change'))
    await waitFor(() => {
      expect(f.bridge.choose).toHaveBeenCalled()
    })
    expect(screen.queryByTestId('data-location-dialog')).toBeNull()
  })

  it('进度就地显示：复制几 MB / 几 GB、核对几个文件；搬完说搬到了哪', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    await screen.findByTestId('data-location-path')
    const base = {
      state: 'running' as const,
      to: 'D:\\工坊 数据',
      started_at: '2026-10-23T03:44:17.085Z',
      files_total: 3412,
    }
    f.emit({
      ...base,
      step: 'copy',
      copied_bytes: 340 * 1024 ** 2,
      total_bytes: 1.2 * 1024 ** 3,
      files_done: 900,
    })
    const progress = screen.getByTestId('data-location-progress')
    expect(progress.textContent).toContain('正在复制 340 MB / 1.2 GB')
    expect(progress.textContent).toContain('别关电脑')
    expect((screen.getByTestId('data-location-change') as HTMLButtonElement).disabled).toBe(true)
    f.emit({ ...base, step: 'verify', copied_bytes: 0, total_bytes: 0, files_done: 120 })
    expect(screen.getByTestId('data-location-progress').textContent).toContain(
      '正在核对 120 / 3412 个文件',
    )
    f.emit({ ...base, step: 'backup', copied_bytes: 0, total_bytes: 0, files_done: 0 })
    expect(screen.getByTestId('data-location-progress').textContent).toContain('正在备份')
    f.emit({ state: 'done', to: 'D:\\工坊 数据', from: 'C:\\old', at: '2026-10-23T03:50:00.000Z' })
    expect(screen.getByTestId('data-location-done').textContent).toBe('已搬到 D:\\工坊 数据')
    expect(screen.queryByTestId('data-location-progress')).toBeNull()
  })

  it('失败：说一句人话原因 + 已回到原来的位置；原位置也没起来时照实说', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    await screen.findByTestId('data-location-path')
    f.emit({
      state: 'failed',
      code: 'no_space',
      step: 'copy',
      back_to: 'C:\\old',
      recovered: true,
      at: 'x',
    })
    expect(screen.getByTestId('data-location-failed').textContent).toBe(
      '没搬成：新位置的空间不够。工坊已回到原来的位置，照常在用。',
    )
    f.emit({
      state: 'failed',
      code: 'weird',
      step: 'start',
      back_to: 'C:\\old',
      recovered: false,
      at: 'x',
    })
    expect(screen.getByTestId('data-location-failed').textContent).toBe(
      '没搬成：出了点意外。原来的位置也没能重新启动，请重开工坊。',
    )
  })

  it('自定义位置：有「恢复默认位置」，走同一个确认框，开搬只说 default', async () => {
    const f = fakeBridge({ path: 'D:\\工坊 数据', is_default: false })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-reset'))
    const dialog = await screen.findByTestId('data-location-dialog')
    expect(dialog.textContent).toContain('把数据搬回默认位置？')
    fireEvent.click(within(dialog).getByTestId('data-location-start'))
    await waitFor(() => {
      expect(f.bridge.move).toHaveBeenCalledWith('default')
    })
  })

  it('旧位置的数据：留到哪天（人话日期），能「现在就删」', async () => {
    const f = fakeBridge({
      path: 'D:\\工坊 数据',
      is_default: false,
      old: { path: 'C:\\data-moved-20261023-0344', until: '2026-10-30T03:44:17.085Z' },
    })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    const old = await screen.findByTestId('data-location-old')
    expect(old.textContent).toMatch(/旧位置的数据留到 10月30日，到时自动删除/)
    fireEvent.click(screen.getByTestId('data-location-delete-old'))
    await screen.findByText('旧位置的数据已删除')
    expect(f.bridge.deleteOld).toHaveBeenCalled()
  })

  it('整行没有内部值（snake_case、ISO 时间）', async () => {
    const f = fakeBridge({
      old: { path: 'C:\\x', until: '2026-10-30T03:44:17.085Z' },
    })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    await screen.findByTestId('data-location-old')
    f.emit({
      state: 'failed',
      code: 'start_failed',
      step: 'check',
      back_to: 'C:\\old',
      recovered: true,
      at: '2026-10-23T03:44:17.085Z',
    })
    expect(rawTokens(screen.getByTestId('settings-data-location').textContent ?? '')).toEqual([])
  })

  it('时长说人话', () => {
    const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v)
    expect(durationText(20, t)).toBe('不到 1 分钟')
    expect(durationText(150, t)).toBe('大约 3 分钟')
    expect(durationText(5400, t)).toBe('大约 1.5 小时')
  })
})

describe('上次备份说人话', () => {
  const t = (k: string, v?: Record<string, string | number>) => translate('zh', k, v)
  const now = new Date(2026, 9, 23, 15, 0)
  it('今天 / 昨天给钟点，再早给几天前，一个月以上给日期；读不懂的不上屏', () => {
    expect(formatAgo(new Date(2026, 9, 23, 11, 44).toISOString(), 'zh', t, now)).toBe('今天 11:44')
    expect(formatAgo(new Date(2026, 9, 22, 9, 5).toISOString(), 'zh', t, now)).toBe('昨天 09:05')
    expect(formatAgo(new Date(2026, 9, 20, 9, 5).toISOString(), 'zh', t, now)).toBe('3 天前')
    expect(formatAgo(new Date(2026, 7, 1, 9, 5).toISOString(), 'zh', t, now)).toBe('8月1日')
    expect(formatAgo('garbage', 'zh', t, now)).toBeUndefined()
    expect(formatAgo(undefined, 'zh', t, now)).toBeUndefined()
  })
})

// ── 数据地图：不露内部名 ───────────────────────────────────────────────

const MAP: TailoredOntology = {
  assignment_id: 'asg_1',
  role_id: 'social.community',
  objects: [
    {
      id: 'order',
      label: '订单',
      read_range: 'assigned',
      source_of_truth: 'platform_api',
      freshness: 'cached:300',
      read_via: [],
    },
    {
      id: 'community_member',
      label: 'community_member',
      read_range: 'assigned',
      source_of_truth: 'platform_api',
      freshness: 'realtime',
      read_via: [],
    },
    {
      id: 'mystery_thing' as never,
      label: 'mystery_thing',
      read_range: 'workspace',
      source_of_truth: 'human',
      freshness: 'authored',
      read_via: [],
    },
  ],
  actions: [
    {
      id: 'approve_member',
      object: 'community_member',
      label: 'approve member（community_member）',
      risk_class: 'medium',
      requires_approval: true,
    },
    {
      id: 'stage_broadcast',
      object: 'community_member',
      label: 'stage broadcast（community_member）',
      risk_class: 'medium',
      requires_approval: true,
    },
    {
      id: 'zzz_unknown_action',
      object: 'community_member',
      label: 'zzz unknown action（community_member）',
      risk_class: 'low',
      requires_approval: true,
    },
    {
      id: 'poke_mystery',
      object: 'mystery_thing' as never,
      label: 'poke mystery（mystery_thing）',
      risk_class: 'low',
      requires_approval: true,
    },
  ],
  links: [],
} as unknown as TailoredOntology

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getPositionOntology: async () => MAP }
})

describe('数据地图不露内部名', () => {
  it('community_member → 社群成员；approve member → 批入群申请；认不出的动作算「另 N 项」；没中文名的对象收进「其他」', async () => {
    const { DataMapPanel } = await import('@/components/data-map')
    renderWithProviders(<DataMapPanel position="asg_1" />)
    const table = await screen.findByTestId('data-map-table')
    const rows = [...table.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('订单')
    expect(rows[1]).toContain('社群成员')
    expect(rows[1]).toContain('批入群申请')
    expect(rows[1]).toContain('群发公告')
    expect(rows[1]).toContain('另 1 项')
    const other = screen.getByTestId('data-map-other')
    expect(other.textContent).toContain('其他（另外 1 类）')
    expect(other.textContent).toContain('另 1 项')
    const text = table.textContent ?? ''
    expect(text).not.toContain('community_member')
    expect(text).not.toContain('approve member')
    expect(text).not.toContain('mystery')
    expect(rawTokens(text)).toEqual([])
  })
})
