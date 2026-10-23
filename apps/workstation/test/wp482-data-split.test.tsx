/**
 * WP482（决策 1643 改 B）：「数据存放位置」拆成两格——数据库 / 大文件，各自更改位置、恢复默认位置。
 *
 * - 新壳给了 `blobs` 才出第二格；旧壳只有一格（WP480 原样，调用不带 which）；
 * - 大文件那一格：确认框换说法（不做备份、旧的大文件留 7 天）；网络盘只说「断网时附件打不开」；
 * - 数据库那一格：网络盘多半句「更容易损坏，记得开着备份」（决策 1647 B）；大文件跟着它放时说「会一起搬」；
 * - 进度 / 结果只出在搬的那一格；
 * - 大文件位置连不上：那一格说一句、给「再试一次」；用到附件 / 录音的地方同一句话 + 「再试一次」。
 */
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BlobUnavailableNotice, blobUnavailableLocation } from '@/components/blob-unavailable'
import {
  type BlobLocationLike,
  type DataLocationBridgeLike,
  type DataLocationLike,
  DataLocationSetting,
  type DataMoveStatusLike,
  type DataTargetCheckLike,
} from '@/components/settings/data-location'
import { ApiClientError } from '@/lib/api'
import { renderWithProviders } from './helpers'

const w = globalThis as unknown as { agentsws?: unknown }

const DB = 'C:\\Users\\admin\\AppData\\Roaming\\@agentsws\\desktop\\data'
const NAS = 'Z:\\工坊 大文件'

const CHECK_OK: DataTargetCheckLike = {
  ok: true,
  chosen: NAS,
  target: NAS,
  bytes: 8 * 1024 ** 3,
  files: 12_000,
  free_bytes: 2000 * 1024 ** 3,
  estimate_seconds: 900,
  problems: [],
  warnings: [],
  kind: 'blobs',
}

const BLOBS: BlobLocationLike = {
  path: `${DB}\\blobs`,
  is_default: true,
  default_path: `${DB}\\blobs`,
  bytes: 8 * 1024 ** 3,
  files: 12_000,
  reachable: true,
}

function fakeBridge(view: Partial<DataLocationLike> = {}) {
  let listener: ((s: DataMoveStatusLike) => void) | undefined
  let next: DataTargetCheckLike | null = CHECK_OK
  const bridge: DataLocationBridgeLike = {
    get: vi.fn(async () => ({
      path: DB,
      is_default: true,
      default_path: DB,
      bytes: 300 * 1024 ** 2,
      files: 420,
      status: { state: 'idle' as const },
      blobs: BLOBS,
      ...view,
    })),
    choose: vi.fn(async () => next),
    checkDefault: vi.fn(async () => ({ ...CHECK_OK, chosen: BLOBS.path, target: BLOBS.path })),
    move: vi.fn(async () => ({
      state: 'running' as const,
      which: 'blobs' as const,
      step: 'pause',
      to: NAS,
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

describe('两格：数据库 / 大文件', () => {
  it('新壳：两格各有路径、大小；大文件默认位置说「和数据库放在一起」', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    const blobCell = await screen.findByTestId('blob-location-cell')
    const dbCell = screen.getByTestId('data-location-cell')
    expect(dbCell.textContent).toContain('数据库')
    expect(dbCell.textContent).toContain('300 MB')
    expect(blobCell.textContent).toContain('大文件')
    expect(blobCell.textContent).toContain('默认位置（和数据库放在一起）')
    expect(blobCell.textContent).toContain('8.0 GB')
    expect(screen.getByTestId('settings-data-location').textContent).toContain(
      '附件、录音这些大文件可以放 NAS 或外置硬盘',
    )
    expect(screen.queryByTestId('blob-location-reset')).toBeNull()
    fireEvent.click(screen.getByTestId('blob-location-reveal'))
    expect(f.bridge.reveal).toHaveBeenCalledWith('blobs')
  })

  it('旧壳没给 blobs：只有一格，和 WP480 一样', async () => {
    const f = fakeBridge({ blobs: undefined })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    await screen.findByTestId('data-location-path')
    expect(screen.queryByTestId('blob-location-cell')).toBeNull()
    expect(screen.getByTestId('settings-data-location').textContent).not.toContain('大文件')
  })

  it('大文件更改位置：只问大文件那一格；确认框不提备份、网络盘只说附件打不开；开搬说 chosen + blobs', async () => {
    const f = fakeBridge()
    f.nextCheck({ ...CHECK_OK, warnings: ['network'] })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('blob-location-change'))
    expect(f.bridge.choose).toHaveBeenCalledWith('blobs')
    const dialog = await screen.findByTestId('data-location-dialog')
    expect(dialog.textContent).toContain('把大文件搬到这里？')
    const facts = within(dialog).getByTestId('data-location-dialog-facts').textContent ?? ''
    expect(facts).toContain('要搬 8.0 GB（12,000 个文件），大约 15 分钟。')
    expect(facts).toContain('旧位置的大文件留 7 天再删。')
    expect(facts).not.toContain('备份')
    const warns = within(dialog).getByTestId('data-location-dialog-warnings').textContent ?? ''
    expect(warns).toContain('断网时附件打不开')
    expect(warns).not.toContain('工坊打不开')
    expect(warns).not.toContain('数据库')
    fireEvent.click(within(dialog).getByTestId('data-location-start'))
    await waitFor(() => {
      expect(f.bridge.move).toHaveBeenCalledWith('chosen', 'blobs')
    })
    // 进度只出在大文件那一格
    expect(await screen.findByTestId('blob-location-progress')).toBeTruthy()
    expect(screen.queryByTestId('data-location-progress')).toBeNull()
    expect((screen.getByTestId('data-location-change') as HTMLButtonElement).disabled).toBe(true)
  })

  it('数据库更改位置：调用不带 which；网络盘多半句「更容易损坏」；大文件跟着它放时说会一起搬', async () => {
    const f = fakeBridge()
    f.nextCheck({
      ...CHECK_OK,
      kind: undefined,
      chosen: 'Z:\\库',
      target: 'Z:\\库',
      warnings: ['network'],
      includes_blobs: true,
    })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('data-location-change'))
    expect(f.bridge.choose).toHaveBeenCalledWith()
    const dialog = await screen.findByTestId('data-location-dialog')
    expect(dialog.textContent).toContain('把数据搬到这里？')
    expect(within(dialog).getByTestId('data-location-dialog-includes-blobs').textContent).toBe(
      '大文件现在和数据库放在一起，会一起搬过去。',
    )
    const warns = within(dialog).getByTestId('data-location-dialog-warnings').textContent ?? ''
    expect(warns).toContain('断网或 NAS 关机时，工坊打不开')
    expect(warns).toContain('网络盘上的数据库更容易损坏，记得开着备份')
    fireEvent.click(within(dialog).getByTestId('data-location-start'))
    await waitFor(() => {
      expect(f.bridge.move).toHaveBeenCalledWith('chosen')
    })
  })

  it('大文件搬完 / 没搬成：结果只出在大文件那一格', async () => {
    const f = fakeBridge()
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    await screen.findByTestId('blob-location-cell')
    f.emit({ state: 'done', which: 'blobs', to: NAS, from: BLOBS.path, at: 'x' })
    expect(screen.getByTestId('blob-location-done').textContent).toBe(`大文件已搬到 ${NAS}`)
    expect(screen.queryByTestId('data-location-done')).toBeNull()
    f.emit({
      state: 'failed',
      which: 'blobs',
      code: 'copy_failed',
      step: 'copy',
      back_to: BLOBS.path,
      recovered: true,
      at: 'x',
    })
    expect(screen.getByTestId('blob-location-failed').textContent).toContain(
      '没搬成：复制的时候出错了',
    )
    expect(screen.queryByTestId('data-location-failed')).toBeNull()
  })

  it('大文件恢复默认位置：问 blobs 的检查，开搬说 default + blobs', async () => {
    const f = fakeBridge({ blobs: { ...BLOBS, path: NAS, is_default: false } })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('blob-location-reset'))
    expect(f.bridge.checkDefault).toHaveBeenCalledWith('blobs')
    const dialog = await screen.findByTestId('data-location-dialog')
    expect(dialog.textContent).toContain('把大文件搬回默认位置？')
    fireEvent.click(within(dialog).getByTestId('data-location-start'))
    await waitFor(() => {
      expect(f.bridge.move).toHaveBeenCalledWith('default', 'blobs')
    })
  })

  it('现在的大文件位置连不上时搬不了：说清为什么', async () => {
    const f = fakeBridge({ blobs: { ...BLOBS, path: NAS, is_default: false, reachable: false } })
    f.nextCheck({ ...CHECK_OK, ok: false, problems: ['source_missing'] })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    fireEvent.click(await screen.findByTestId('blob-location-change'))
    const problems = await screen.findByTestId('data-location-dialog-problems')
    expect(problems.textContent).toBe('现在放大文件的地方连不上，接好之后再搬。')
  })

  it('旧位置的大文件：留到哪天，「现在就删」只删大文件那一格的', async () => {
    const f = fakeBridge({
      blobs: { ...BLOBS, old: { path: `${DB}\\blobs-moved-x`, until: '2026-10-30T03:44:17.085Z' } },
    })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    const old = await screen.findByTestId('blob-location-old')
    expect(old.textContent).toMatch(/旧位置的大文件留到 10月30日，到时自动删除/)
    expect(screen.queryByTestId('data-location-old')).toBeNull()
    fireEvent.click(screen.getByTestId('blob-location-delete-old'))
    await screen.findByText('旧位置的大文件已删除')
    expect(f.bridge.deleteOld).toHaveBeenCalledWith('blobs')
  })
})

describe('大文件位置连不上', () => {
  it('设置里那一格：说一句、给「再试一次」（重新问壳）；打不开文件夹', async () => {
    const f = fakeBridge({ blobs: { ...BLOBS, path: NAS, is_default: false, reachable: false } })
    w.agentsws = { dataLocation: f.bridge }
    renderWithProviders(<DataLocationSetting />)
    const note = await screen.findByTestId('blob-location-unreachable')
    expect(note.textContent).toContain('现在连不上（硬盘没插或 NAS 断网）')
    expect((screen.getByTestId('blob-location-reveal') as HTMLButtonElement).disabled).toBe(true)
    // 数据库那一格照常
    expect((screen.getByTestId('data-location-change') as HTMLButtonElement).disabled).toBe(false)
    const before = vi.mocked(f.bridge.get).mock.calls.length
    fireEvent.click(screen.getByTestId('blob-location-retry'))
    await waitFor(() => {
      expect(vi.mocked(f.bridge.get).mock.calls.length).toBeGreaterThan(before)
    })
  })

  it('用到附件 / 录音的地方：认得出服务进程回的那个错，说位置，「再试一次」把刚才那件事再做一遍', () => {
    const err = new ApiClientError(503, {
      code: 'provider_unavailable',
      message: `大文件存放的位置现在连不上：${NAS}`,
      details: { reason: 'blob_location_unreachable', location: NAS },
      trace_id: 't',
    } as never)
    expect(blobUnavailableLocation(err)).toBe(NAS)
    // 别的 503 不算
    const other = new ApiClientError(503, {
      code: 'provider_unavailable',
      message: '模型不可用',
      trace_id: 't',
    } as never)
    expect(blobUnavailableLocation(other)).toBeUndefined()
    expect(blobUnavailableLocation(new Error('x'))).toBeUndefined()

    const onRetry = vi.fn()
    renderWithProviders(<BlobUnavailableNotice location={NAS} onRetry={onRetry} />)
    expect(screen.getByTestId('blob-unavailable').textContent).toContain(
      `大文件存放的位置现在连不上：${NAS}`,
    )
    fireEvent.click(screen.getByTestId('blob-unavailable-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})
