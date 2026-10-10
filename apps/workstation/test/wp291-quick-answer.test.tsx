/**
 * WP291（决策 356）工作台那一侧：岗位里问一句——
 * 当场问答就在输入框下面答（一句话 + 表格 + 数字，带「依据」）；「接着聊」转成会话线程、「当成任务做」
 * 转成任务并进线程、「关掉」收起；判成任务的发出去直接进线程；没跑成说人话 + 重试。
 */
import type { AnswerComponent } from '@agentsws/contracts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenAtPositionData, PositionInstanceData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const VIEW: PositionInstanceData = {
  position_id: 'web-ops',
  workspace_id: 'ws_1',
  name: { zh: '网站运营', en: 'Web ops' },
  template_version: '1.0.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.store',
      role_name: '店铺管理',
      default: true,
      assignment_ids: ['asg_store'],
      my_assignment_id: 'asg_store',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
}

const COMPONENTS: AnswerComponent[] = [
  {
    kind: 'table',
    columns: ['商品', '价格', '状态'],
    rows: [
      ['蓝牙耳机', 129, '在卖'],
      ['手机壳', 29, '草稿'],
    ],
    total: 12,
  },
  { kind: 'metric', items: [{ label: '在卖', value: 11, unit: '件', delta_pct: 10 }] },
]

const QUICK: OpenAtPositionData = {
  mode: 'quick',
  entry: { kind: 'quick', by: 'model' },
  answer: {
    outcome: 'answered',
    text: '店里有 12 件商品，11 件在卖。',
    lead: '店里有 12 件商品，11 件在卖。',
    components: COMPONENTS,
    sources: ['店里的商品列表'],
  },
  matter: { id: 'mat_q', title: '店里有哪些商品', entry: 'position', ask: true },
  candidates: [],
  ambiguous: false,
  reason: '',
}

const TASK: OpenAtPositionData = {
  mode: 'task',
  matter: { id: 'mat_t', title: '上架一个草稿商品', entry: 'position' },
  candidates: [],
  ambiguous: false,
  reason: '',
}

let release: (() => void) | undefined
const openMatterAtPosition = vi.fn(async (..._args: unknown[]) => QUICK)
const continueQuickAnswer = vi.fn(async (..._args: unknown[]) => ({ matter: { id: 'mat_q' } }))
const promoteAskMatter = vi.fn(async (..._args: unknown[]) => ({
  matter: { id: 'mat_q', title: 'x' },
  run_id: 'run_2',
}))
const navigate = vi.fn()

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    openMatterAtPosition: (...args: unknown[]) => openMatterAtPosition(...args),
    continueQuickAnswer: (...args: unknown[]) => continueQuickAnswer(...args),
    promoteAskMatter: (...args: unknown[]) => promoteAskMatter(...args),
  }
})

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => navigate }
})

const { PositionHandoff } = await import('@/components/position/position-handoff')
const { resetQuickAnswer } = await import('@/components/position/quick-answer-store')
const { AnswerComponents } = await import('@/components/answer/answer-view')

const ask = (value: string): void => {
  fireEvent.change(screen.getByTestId('position-entry-input'), { target: { value } })
  fireEvent.click(screen.getByTestId('matter-send'))
}

beforeEach(() => {
  act(() => {
    resetQuickAnswer()
  })
  openMatterAtPosition.mockReset()
  openMatterAtPosition.mockResolvedValue(QUICK)
  continueQuickAnswer.mockClear()
  promoteAskMatter.mockClear()
  navigate.mockClear()
  release = undefined
})

describe('WP291 岗位页当场回答', () => {
  it('发出去先出「…」，答了是一句话 + 表格 + 数字；不跳页；框里的字清了', async () => {
    openMatterAtPosition.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve(QUICK)
          }
        }),
    )
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    const pending = await screen.findByTestId('quick-answer')
    expect(pending.getAttribute('data-state')).toBe('pending')
    expect(pending.textContent).toContain('店里有哪些商品')
    expect((screen.getByTestId('position-entry-input') as HTMLTextAreaElement).value).toBe('')
    await act(async () => {
      release?.()
    })
    await waitFor(() => {
      expect(screen.getByTestId('quick-answer').getAttribute('data-state')).toBe('done')
    })
    expect(screen.getByTestId('quick-answer-lead').textContent).toBe(
      '店里有 12 件商品，11 件在卖。',
    )
    const table = screen.getByTestId('answer-table')
    expect(table.querySelectorAll('tbody tr')).toHaveLength(2)
    expect(table.textContent).toContain('蓝牙耳机')
    expect(screen.getByTestId('answer-table-total').textContent).toBe('列了 2 行，共 12 行')
    expect(screen.getByTestId('answer-metric').textContent).toContain('11')
    expect(navigate).not.toHaveBeenCalled()
    // 回答区不加标题、不加说明段
    expect(screen.getByTestId('quick-answer').querySelector('h2, h3, h4')).toBeNull()
  })

  it('「依据」小链接：点开是读了哪些数据', async () => {
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    const basis = await screen.findByTestId('quick-answer-basis')
    expect(basis.textContent).toBe('依据 · 1')
    fireEvent.click(basis)
    expect(screen.getByTestId('quick-answer-sources').textContent).toContain('店里的商品列表')
  })

  it('「接着聊」：转成会话线程（带上这一问一答）并进去', async () => {
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    fireEvent.click(await screen.findByTestId('quick-answer-continue'))
    await waitFor(() => {
      expect(continueQuickAnswer).toHaveBeenCalledWith('mat_q')
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_q')
  })

  it('「当成任务做」：转成任务、按原话再跑一次，并进线程', async () => {
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    fireEvent.click(await screen.findByTestId('quick-answer-task'))
    await waitFor(() => {
      expect(promoteAskMatter).toHaveBeenCalledWith('mat_q', { run: true })
    })
    expect(navigate).toHaveBeenCalledWith('/matters/mat_q')
  })

  it('「关掉」：回答收起；同一时间只留最近一个', async () => {
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    await screen.findByTestId('quick-answer-lead')
    openMatterAtPosition.mockResolvedValueOnce({
      ...QUICK,
      answer: {
        ...(QUICK.answer as NonNullable<OpenAtPositionData['answer']>),
        lead: '今天 8 单。',
        components: [],
      },
    })
    ask('今天几单')
    await waitFor(() => {
      expect(screen.getByTestId('quick-answer-lead').textContent).toBe('今天 8 单。')
    })
    expect(screen.getAllByTestId('quick-answer')).toHaveLength(1)
    fireEvent.click(screen.getByTestId('quick-answer-close'))
    expect(screen.queryByTestId('quick-answer')).toBeNull()
  })

  it('判成任务：发出去直接进它的线程（不静默只加一行）', async () => {
    openMatterAtPosition.mockResolvedValueOnce(TASK)
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('上架一个草稿商品')
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/matters/mat_t')
    })
    expect(screen.queryByTestId('quick-answer')).toBeNull()
  })

  it('没跑成：一句人话 + 重试；重试按当场问答再来一次（不再判）', async () => {
    openMatterAtPosition.mockResolvedValueOnce({
      ...QUICK,
      answer: {
        outcome: 'failed',
        text: '',
        lead: '',
        components: [],
        sources: [],
        failure: '店铺授权过期了，去岗位页重新授权',
      },
    })
    renderWithProviders(<PositionHandoff id="asg_store" view={VIEW} />)
    ask('店里有哪些商品')
    expect((await screen.findByTestId('quick-answer-failed')).textContent).toBe(
      '没跑成：店铺授权过期了，去岗位页重新授权',
    )
    expect(screen.queryByTestId('quick-answer-continue')).toBeNull()
    fireEvent.click(screen.getByTestId('quick-answer-retry'))
    await waitFor(() => {
      expect(openMatterAtPosition).toHaveBeenLastCalledWith('asg_store', {
        title: '店里有哪些商品',
        mode: 'quick',
      })
    })
  })
})

describe('WP291 组件按契约画', () => {
  it('一段字照原样（不当 HTML）；认不得的组件不画', () => {
    renderWithProviders(
      <AnswerComponents
        components={[
          { kind: 'text', text: '<b>不是粗体</b>' },
          { kind: 'gallery', images: [] } as unknown as AnswerComponent,
        ]}
      />,
    )
    expect(screen.getByTestId('answer-text').textContent).toBe('<b>不是粗体</b>')
    expect(screen.getByTestId('answer-components').querySelector('b')).toBeNull()
    expect(screen.getByTestId('answer-components').children).toHaveLength(1)
  })
})
