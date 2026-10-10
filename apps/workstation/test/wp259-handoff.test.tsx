/**
 * WP259 工作台那一侧：「交给它」超过 120 字被 400 静默拒收（10-07 真机 ci.15）。
 *
 * 钉住：
 * - 长文本 / 多行：标题「第一句…」，完整原文作描述交出去（岗位入口与「用这条职责开」两条路）；
 * - 用职责开带 `run: true`（开完立刻起首轮运行）；
 * - 正好 120 字不拆；空白交不出去；
 * - 提交中按钮显示「正在交…」；没交出去框下说一句人话（含服务端那句），字还在框里；
 * - 职责页「用这条职责开一件事」与 ⌘K 一句话交给职责同一套。
 */
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError, type OpenAtPositionData, type PositionInstanceData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const LONG = [
  '用 agentsws-theme 帮我搭一个英文首页，先别发布。',
  '首屏放主推的三款产品，每款配一句卖点；下面依次是品牌故事、客户评价、常见问题和订阅邮件的入口。',
  '颜色跟品牌色走，字体用无衬线，手机上要好看。做好之后推一个未发布主题，把预览链接给我。',
].join('\n')
const LONG_TITLE = '用 agentsws-theme 帮我搭一个英文首页，先别发布…'

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
  matter: { id: 'mat_1', title: LONG_TITLE, entry: 'position', role_id: 'site.theme' },
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

const type = (value: string): void => {
  fireEvent.change(screen.getByTestId('position-entry-input'), { target: { value } })
}
// WP287：岗位页用事项页同一个输入框——发送是框内的箭头（`matter-send`）
const sendButton = (): HTMLButtonElement => screen.getByTestId('matter-send') as HTMLButtonElement
const submit = (): void => {
  fireEvent.click(sendButton())
}

beforeEach(() => {
  openMatterAtPosition.mockReset()
  openMatterAtPosition.mockResolvedValue(PICKED)
  createMatterWithRole.mockReset()
  createMatterWithRole.mockResolvedValue({ matter: { id: 'mat_2' }, run_id: 'run_2' })
  navigate.mockClear()
})

describe('WP259 交给它：长文本照收', () => {
  it('职责「自动」：多行长需求 → 标题取第一句…，完整原文作描述', async () => {
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type(`  ${LONG}\n`)
    submit()
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalledWith('asg_theme', {
        title: LONG_TITLE,
        summary: LONG,
      })
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_1')
  })

  it('WP287：不让人选职责——没有「职责：自动」下拉，也没有写着「交给它」的按钮', () => {
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    expect(screen.queryByTestId('position-handoff-duty')).toBeNull()
    expect(screen.queryByText('交给它')).toBeNull()
  })

  it('正好 120 字一行：原样当标题，不拆', async () => {
    const text = '字'.repeat(120)
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type(text)
    submit()
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenCalledWith('asg_theme', { title: text })
    })
  })

  it('空白：按钮是灰的，交不出去', () => {
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type('   \n  ')
    expect(sendButton().disabled).toBe(true)
    submit()
    expect(openMatterAtPosition).not.toHaveBeenCalled()
  })
})

describe('WP259 交给它：出错说人话、提交中有进行态', () => {
  it('提交中：发送键灰着（不重复交）', async () => {
    let release: (v: OpenAtPositionData) => void = () => undefined
    openMatterAtPosition.mockImplementationOnce(
      () =>
        new Promise<OpenAtPositionData>((resolve) => {
          release = resolve
        }),
    )
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type('把首页 banner 换成秋季款')
    submit()
    await waitFor(() => {
      expect(sendButton().disabled).toBe(true)
    })
    await act(async () => {
      release(PICKED)
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_1')
  })

  it('服务端 400：框下一句「没交出去：<服务端那句>」，字还在框里，按钮能再点', async () => {
    openMatterAtPosition.mockRejectedValueOnce(
      new ApiClientError(400, {
        code: 'invalid_input',
        message: 'title: Too big: expected string to have <=120 characters',
      }),
    )
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type(LONG)
    submit()
    const alert = await screen.findByTestId('handoff-error')
    expect(alert.textContent).toBe(
      '没交出去：title: Too big: expected string to have <=120 characters',
    )
    expect(alert.getAttribute('role')).toBe('alert')
    expect((screen.getByTestId('position-entry-input') as HTMLTextAreaElement).value).toBe(LONG)
    expect(sendButton().disabled).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
    // 人一改字，那句错误就收起来
    type(`${LONG}。`)
    expect(screen.queryByTestId('handoff-error')).toBeNull()
  })

  it('连不上服务（fetch 没出门）：也说一句，不静默', async () => {
    openMatterAtPosition.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    renderWithProviders(<PositionHandoff id="asg_theme" view={VIEW} hero />)
    type('把首页 banner 换成秋季款')
    submit()
    const alert = await screen.findByTestId('handoff-error')
    expect(alert.textContent?.startsWith('没交出去：')).toBe(true)
    expect(alert.textContent).not.toBe('没交出去：')
  })
})
