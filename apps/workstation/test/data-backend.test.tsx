/**
 * 连接页「数据后端」（WP40 / 41 §2.4）的界面用例。
 *
 * 只测四件真要紧的事：
 * 1. 看得见：现在用的是哪一档、多大、上次备份什么时候；
 * 2. 三个按钮在，当前那一档标着「正在用」；
 * 3. **凭据只经 test / save 两条路出门**，秘密字段是 password 输入框，
 *    保存后表单立刻清空（DOM 里也不留）；
 * 4. 迁移要先保存；迁移之后说清「旧后端只读留 7 天 + 重启才生效」。
 */
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageMigrationView, StorageView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const view: StorageView = {
  tier: 'local',
  database: { kind: 'sqlite', display: '/data', bytes: 2_400_000 },
  blobs: { kind: 'local', display: '/data/blobs', bytes: 51_000_000, objects: 12, encrypted: true },
  last_backup_at: '2026-09-09T22:00:00.000Z',
  env: [
    { name: 'AGENTSWS_DATA_DIR', value: '/data', secret: false },
    { name: 'DATABASE_URL', value: '（未设置：用 SQLite）', secret: false },
    { name: 'AGENTSWS_BLOB_SECRET_ACCESS_KEY', value: '（未设置）', secret: true },
  ],
  compose_url: 'https://github.com/Luoye-W/agentsws/blob/main/docker-compose.yml',
}

const getStorage = vi.fn(async () => view)
const testStorageBackend = vi.fn(async () => ({
  database: { ok: false, reason: '用户名或密码不对' },
  blobs: { ok: true, detail: '桶里现在有 0 个对象' },
}))
const saveStorageBackend = vi.fn(async () => ({ saved_fields: ['database_url'] }))
const migrateStorage = vi.fn(
  async (): Promise<StorageMigrationView> => ({
    id: 'mig_1',
    state: 'done',
    step: 'finished',
    started_at: '2026-09-10T00:00:00.000Z',
    exported_records: 9,
    previous_readonly_until: '2026-09-17T00:00:00.000Z',
  }),
)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getStorage: (...a: unknown[]) => getStorage(...(a as [])),
    testStorageBackend: (...a: unknown[]) => testStorageBackend(...(a as [])),
    saveStorageBackend: (...a: unknown[]) => saveStorageBackend(...(a as [])),
    migrateStorage: (...a: unknown[]) => migrateStorage(...(a as [])),
    getStorageMigration: async (): Promise<StorageMigrationView> => ({
      id: 'mig_1',
      state: 'done',
      step: 'finished',
      started_at: '2026-09-10T00:00:00.000Z',
    }),
  }
})

const { DataBackend } = await import('@/components/connections/data-backend')

/** 测试里唯一的「凭据」。零泄漏断言盯着它。 */
const DB_URL = 'postgres://agentsws:pg-Zq7-secret@db.example.com:5432/agentsws'

describe('数据后端（41 §2.4）', () => {
  beforeEach(() => {
    getStorage.mockClear()
    testStorageBackend.mockClear()
    saveStorageBackend.mockClear()
    migrateStorage.mockClear()
  })

  it('看得见：数据库、大文件、上次备份，各带大小', async () => {
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    const current = await screen.findByTestId('storage-current')
    expect(current.dataset.tier).toBe('local')
    expect(screen.getByTestId('storage-database').textContent).toContain('/data')
    expect(screen.getByTestId('storage-blobs').textContent).toContain('/data/blobs')
    // 加密这件事要说出来（21 §4）
    expect(current.textContent).toContain('已加密')
    expect(current.textContent).toContain('12 个对象')
    expect(screen.getByTestId('storage-last-backup').textContent).toContain('2026-09-09')
  })

  it('三个按钮在；当前那一档标着「正在用」', async () => {
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    await screen.findByTestId('storage-current')
    expect(screen.getByTestId('storage-tier-local').textContent).toContain('正在用')
    expect(screen.getByTestId('storage-tier-byo_cloud')).toBeTruthy()
    expect(screen.getByTestId('storage-tier-managed')).toBeTruthy()
  })

  it('托管档只有一段实话，没有假的开通流程', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    await screen.findByTestId('storage-current')
    await user.click(screen.getByTestId('storage-tier-managed'))
    const note = await screen.findByTestId('storage-managed')
    expect(note.textContent).toContain('还没开放')
    // 没有表单、没有「立即开通」
    expect(screen.queryByTestId('storage-form')).toBeNull()
  })

  it('接我的云：原生表单，秘密字段是 password，值只经 test / save 出门', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    await screen.findByTestId('storage-current')
    await user.click(screen.getByTestId('storage-tier-byo_cloud'))

    const form = await screen.findByTestId('storage-form')
    const url = form.querySelector('input[name="database_url"]') as HTMLInputElement
    const secret = form.querySelector('input[name="blob_secret_access_key"]') as HTMLInputElement
    // 13 §4.3：秘密字段一律 password + autocomplete off
    expect(url.type).toBe('password')
    expect(secret.type).toBe('password')
    expect(secret.getAttribute('autocomplete')).toBe('off')

    await user.type(url, DB_URL)
    await user.click(screen.getByTestId('storage-test'))
    await waitFor(() => {
      expect(testStorageBackend).toHaveBeenCalledTimes(1)
    })
    expect((testStorageBackend.mock.calls[0] as unknown[])[0]).toMatchObject({
      database_url: DB_URL,
    })
    // 测试结果一目了然：一条失败一条成功
    const result = await screen.findByTestId('storage-test-result')
    expect(result.textContent).toContain('用户名或密码不对')
    expect(result.textContent).toContain('桶里现在有 0 个对象')

    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(saveStorageBackend).toHaveBeenCalledTimes(1)
    })
    // 值发出去之后连 DOM 里也不留
    await waitFor(() => {
      expect((form.querySelector('input[name="database_url"]') as HTMLInputElement).value).toBe('')
    })
    expect(document.body.innerHTML).not.toContain('pg-Zq7-secret')
  })

  it('迁移要先保存；迁移完说清 7 天只读与「重启才生效」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    await screen.findByTestId('storage-current')
    await user.click(screen.getByTestId('storage-tier-byo_cloud'))
    await screen.findByTestId('storage-form')

    const migrateButton = screen.getByTestId('storage-migrate') as HTMLButtonElement
    expect(migrateButton.disabled).toBe(true)

    const url = document.querySelector('input[name="database_url"]') as HTMLInputElement
    await user.type(url, DB_URL)
    await user.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect((screen.getByTestId('storage-migrate') as HTMLButtonElement).disabled).toBe(false)
    })

    await user.click(screen.getByTestId('storage-migrate'))
    const progress = await screen.findByTestId('storage-migration')
    expect(progress.dataset.state).toBe('done')
    expect(progress.textContent).toContain('旧后端只读保留到 2026-09-17')
    expect(progress.textContent).toContain('重启')
  })

  it('高级：环境变量与 compose 链接；凭据只说「已设置 / 未设置」', async () => {
    const user = userEvent.setup()
    renderWithProviders(<DataBackend assignment="asg_owner" />)
    await screen.findByTestId('storage-current')
    await user.click(screen.getByTestId('storage-advanced-toggle'))
    const advanced = await screen.findByTestId('storage-advanced')
    expect(advanced.textContent).toContain('AGENTSWS_DATA_DIR')
    expect(advanced.textContent).toContain('DATABASE_URL')
    expect(advanced.textContent).toContain('（未设置）')
    expect(advanced.textContent).toContain('docker-compose.yml')
  })
})
