/**
 * WP357（Luoye 10-16 真机：把 Excel 拖进「Reddit 运营」岗位页的输入框没反应）——岗位页输入框能附资料。
 *
 * 钉住：拖进 xlsx → 框里一个小签，发出去 `openMatterAtPosition` 带着 `files`（base64，读字在服务端）；
 * 只附不说话 → 这句话是「看一下附上的资料：…」；认不出的文件说一句；没交出去附件放回框里。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, type OpenAtPositionData, type PositionInstanceData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const VIEW: PositionInstanceData = {
  position_id: 'site-builder',
  workspace_id: 'ws_1',
  name: { zh: '建站', en: 'Site' },
  template_version: '1.0.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'site.theme',
      role_name: 'Shopify 网页模板',
      default: true,
      assignment_ids: ['asg_theme'],
      my_assignment_id: 'asg_theme',
    },
    {
      role_id: 'site.copy',
      role_name: '页面文案',
      default: false,
      assignment_ids: ['asg_copy'],
      my_assignment_id: 'asg_copy',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
}

const PICKED: OpenAtPositionData = {
  matter: {
    id: 'mat_1',
    title: '参考甲方的表格改我们的记录表',
    entry: 'position',
    role_id: 'site.theme',
  },
  picked: { role_id: 'site.theme', role_name: 'Shopify 网页模板', assignment_id: 'asg_theme' },
  candidates: [],
  ambiguous: false,
  reason: '路由到「Shopify 网页模板」',
  run_id: 'run_1',
}

const openMatterAtPosition = vi.fn(async (..._args: unknown[]) => PICKED)
const createMatterWithRole = vi.fn(async (..._args: unknown[]) => ({
  matter: { id: 'mat_2' },
  run_id: 'run_2',
}))
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    openMatterAtPosition: (...args: unknown[]) => openMatterAtPosition(...args),
    createMatterWithRole: (...args: unknown[]) => createMatterWithRole(...args),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const { PositionHandoff } = await import('@/components/position/position-handoff')

const XLSX = new File([new Uint8Array([0x50, 0x4b, 3, 4])], '甲方记录表.xlsx', {
  type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
})
const drop = (files: File[]): void => {
  fireEvent.drop(screen.getByTestId('matter-say'), { dataTransfer: { files, types: ['Files'] } })
}
const type = (value: string): void => {
  fireEvent.change(screen.getByTestId('position-entry-input'), { target: { value } })
}
const submit = (): void => {
  fireEvent.click(screen.getByTestId('matter-send'))
}

beforeEach(() => {
  openMatterAtPosition.mockReset()
  openMatterAtPosition.mockResolvedValue(PICKED)
  navigate.mockClear()
})

describe('WP357 岗位页输入框附资料', () => {
  it('拖进 xlsx → 小签；说一句交出去，带着 files', async () => {
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} />)
    drop([XLSX])
    expect((await screen.findByTestId('matter-doc')).textContent).toContain('甲方记录表.xlsx')
    type('参考甲方的表格改我们的记录表')
    submit()
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalledWith('asg_theme', {
        title: '参考甲方的表格改我们的记录表',
        files: [{ name: '甲方记录表.xlsx', data: 'UEsDBA==' }],
      })
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_1')
    expect(screen.queryByTestId('matter-doc')).toBeNull()
  })

  it('只附不说话：这句话是「看一下附上的资料：…」', async () => {
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} />)
    drop([XLSX])
    await screen.findByTestId('matter-doc')
    submit()
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalledWith('asg_theme', {
        title: '看一下附上的资料：「甲方记录表.xlsx」',
        files: [{ name: '甲方记录表.xlsx', data: 'UEsDBA==' }],
      })
    })
  })

  it('认不出的文件说一句；没交出去附件放回框里', async () => {
    openMatterAtPosition.mockRejectedValueOnce(
      new ApiClientError(500, { code: 'internal', message: '出错了' }),
    )
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} />)
    drop([new File(['x'], 'setup.exe', { type: 'application/octet-stream' })])
    expect((await screen.findByTestId('matter-attach-rejected')).textContent).toContain('.xlsx')
    drop([XLSX])
    await screen.findByTestId('matter-doc')
    type('看看')
    submit()
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalled()
    })
    expect((await screen.findByTestId('matter-doc')).textContent).toContain('甲方记录表.xlsx')
  })
})
