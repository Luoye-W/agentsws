/**
 * WP475（决策 1591、1592）：左下角「反馈」——按钮打开反馈框（WP481 起收进个人菜单「反馈」「我的反馈」）；一句话必填、类型默认「问题」；
 * 附上诊断信息默认勾、能展开看、能取消；联系方式默认账号邮箱；桌面壳里一键截窗口（框先收起再截）、
 * 预览能删；浏览器里粘贴图片；云不通时说「已保存，联网后自动发出」；我的反馈：状态与回复、看过了清未读；
 * 铃铛带过来的 `?feedback=mine` 打开我的反馈；⌘K 里搜得到「反馈」。
 */
import type {
  FeedbackDraftView,
  LocalFeedbackItem,
  LocalFeedbackList,
  LocalFeedbackSubmit,
} from '@agentsws/contracts'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const state: {
  draft: FeedbackDraftView
  submits: LocalFeedbackSubmit[]
  delivered: boolean
  mine: LocalFeedbackList
  seen: number
  draftCalls: unknown[]
} = {
  draft: { diagnostics: { app_version: '', os: '', locale: '', route: '', errors: [] } },
  submits: [],
  delivered: true,
  mine: { items: [] },
  seen: 0,
  draftCalls: [],
}

vi.mock('@/lib/feedback', async () => {
  const actual = await vi.importActual<typeof import('@/lib/feedback')>('@/lib/feedback')
  return {
    ...actual,
    getFeedbackDraft: async (page: unknown) => {
      state.draftCalls.push(page)
      return state.draft
    },
    submitFeedback: async (input: LocalFeedbackSubmit) => {
      state.submits.push(input)
      const item: LocalFeedbackItem = {
        client_id: `fbc_${state.submits.length}`,
        kind: input.kind,
        message: input.message,
        state: state.delivered ? 'sent' : 'queued',
        replies: [],
        unread_replies: 0,
        has_screenshot: input.screenshot !== undefined,
        has_diagnostics: input.include_diagnostics,
        created_at: '2026-10-22T08:00:00.000Z',
        updated_at: '2026-10-22T08:00:00.000Z',
      }
      return { item, delivered: state.delivered }
    },
    listMyFeedback: async () => state.mine,
    markFeedbackSeen: async () => {
      state.seen += 1
      return { unread: 0 }
    },
  }
})

const { FeedbackHost } = await import('@/components/feedback/feedback-host')
const { AccountBlock } = await import('@/components/account-block')

const DIAG = {
  app_version: '0.2.1-beta.5',
  os: 'darwin arm64 25.6.0',
  locale: 'zh-CN',
  route: '/inbox',
  shell: 'browser' as const,
  errors: ['[client] boundary /inbox TypeError: x is undefined', '[team] 连不上'],
}

const PNG_B64 = btoa('\x89PNG\r\n\x1a\nfake')

beforeEach(() => {
  state.draft = { contact: 'me@example.com', diagnostics: DIAG }
  state.submits = []
  state.delivered = true
  state.mine = { items: [] }
  state.seen = 0
  state.draftCalls = []
})

afterEach(() => {
  ;(window as unknown as { agentsws?: unknown }).agentsws = undefined
  vi.restoreAllMocks()
})

/** WP481：「反馈」在个人菜单里——点头像 / 名字，再点「反馈」。 */
function feedbackItem(which: 'account-feedback' | 'account-feedback-mine' = 'account-feedback') {
  fireEvent.click(screen.getByTestId('account-toggle'))
  return screen.getByTestId(which)
}

function shell(route = '/inbox'): void {
  renderWithProviders(
    <>
      <AccountBlock />
      <FeedbackHost />
    </>,
    route,
  )
}

describe('入口与反馈框', () => {
  it('个人菜单「反馈」打开；一句话必填；类型默认问题；联系方式默认账号邮箱；诊断信息默认勾、能展开看', async () => {
    shell()
    const button = feedbackItem()
    expect(button.getAttribute('title')).toContain('告诉我们')
    fireEvent.click(button)
    const send = await screen.findByTestId('feedback-send')
    expect((send as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByTestId('feedback-kind-bug').getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      expect((screen.getByTestId('feedback-contact') as HTMLInputElement).value).toBe(
        'me@example.com',
      )
    })
    expect((screen.getByTestId('feedback-diag') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByTestId('feedback-diag-label').getAttribute('title')).toContain(
      '不含业务内容',
    )
    expect(screen.queryByTestId('feedback-diag-view')).toBeNull()
    fireEvent.click(screen.getByTestId('feedback-diag-toggle'))
    const view = screen.getByTestId('feedback-diag-view')
    expect(view.textContent).toContain('0.2.1-beta.5')
    expect(view.textContent).toContain('/inbox')
    expect(view.textContent).toContain('最近的错误（2 条）')
    // 页面报给本机的只有路径（没有查询串）、语言、壳
    expect(state.draftCalls[0]).toMatchObject({
      route: '/inbox',
      locale: 'zh-CN',
      shell: 'browser',
    })
  })

  it('发出去：带上类型、联系方式、诊断与否；成功说「收到了」、表单清空', async () => {
    shell()
    fireEvent.click(feedbackItem())
    fireEvent.change(await screen.findByTestId('feedback-message'), {
      target: { value: '收件箱点开是空白' },
    })
    fireEvent.click(screen.getByTestId('feedback-kind-idea'))
    fireEvent.click(screen.getByTestId('feedback-diag'))
    fireEvent.change(screen.getByTestId('feedback-contact'), { target: { value: 'x@y.example' } })
    fireEvent.click(screen.getByTestId('feedback-send'))
    expect(await screen.findByTestId('feedback-sent')).toBeTruthy()
    expect(state.submits[0]).toMatchObject({
      kind: 'idea',
      message: '收件箱点开是空白',
      contact: 'x@y.example',
      include_diagnostics: false,
      route: '/inbox',
      locale: 'zh-CN',
      shell: 'browser',
    })
    expect((screen.getByTestId('feedback-message') as HTMLTextAreaElement).value).toBe('')
  })

  it('云不通：说「已保存，联网后自动发出」', async () => {
    state.delivered = false
    shell()
    fireEvent.click(feedbackItem())
    fireEvent.change(await screen.findByTestId('feedback-message'), {
      target: { value: '断网了' },
    })
    fireEvent.click(screen.getByTestId('feedback-send'))
    expect((await screen.findByTestId('feedback-queued')).textContent).toBe(
      '已保存，联网后自动发出',
    )
  })

  it('桌面壳：一键截窗口（截的时候框先收起）、预览能删；截好的图跟着发出去', async () => {
    const seenOpen: boolean[] = []
    const captureWindow = vi.fn(async () => {
      seenOpen.push(screen.queryByTestId('feedback-message') !== null)
      return { content_type: 'image/jpeg' as const, data_base64: PNG_B64 }
    })
    ;(window as unknown as { agentsws?: unknown }).agentsws = {
      version: '0.2.1-beta.5',
      captureWindow,
    }
    shell()
    fireEvent.click(feedbackItem())
    fireEvent.change(await screen.findByTestId('feedback-message'), {
      target: { value: '按钮错位' },
    })
    await act(async () => {
      fireEvent.click(screen.getByTestId('feedback-shot-capture'))
      await new Promise((r) => setTimeout(r, 400))
    })
    await waitFor(() => {
      expect(screen.getByTestId('feedback-shot-preview')).toBeTruthy()
    })
    expect(captureWindow).toHaveBeenCalledTimes(1)
    expect(seenOpen).toEqual([false])
    // 字没丢
    expect((screen.getByTestId('feedback-message') as HTMLTextAreaElement).value).toBe('按钮错位')
    fireEvent.click(screen.getByTestId('feedback-shot-remove'))
    expect(screen.queryByTestId('feedback-shot-preview')).toBeNull()
    await act(async () => {
      fireEvent.click(screen.getByTestId('feedback-shot-capture'))
      await new Promise((r) => setTimeout(r, 400))
    })
    await screen.findByTestId('feedback-shot-preview')
    fireEvent.click(screen.getByTestId('feedback-send'))
    await screen.findByTestId('feedback-sent')
    expect(state.submits[0]).toMatchObject({
      shell: 'desktop',
      app_version: '0.2.1-beta.5',
      screenshot: { content_type: 'image/jpeg', data_base64: PNG_B64 },
    })
  })

  it('浏览器里：没有一键截图，粘贴一张图就附上', async () => {
    shell()
    fireEvent.click(feedbackItem())
    await screen.findByTestId('feedback-message')
    expect(screen.queryByTestId('feedback-shot-capture')).toBeNull()
    expect(screen.getByTestId('feedback-shot-pick').getAttribute('title')).toContain('粘贴')
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    await act(async () => {
      fireEvent.paste(screen.getByTestId('feedback-dialog'), {
        clipboardData: { files: [file], types: ['Files'] },
      })
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(await screen.findByTestId('feedback-shot-preview')).toBeTruthy()
  })
})

describe('我的反馈', () => {
  it('状态与回复；有未读回复就标看过了；没发出去的写「待发出」', async () => {
    state.mine = {
      items: [
        {
          client_id: 'fbc_2',
          id: 'fb_2',
          kind: 'bug',
          message: '设置页打不开',
          state: 'sent',
          status: 'fixed',
          replies: [{ at: '2026-10-22T09:00:00.000Z', text: '修好了，更新到最新版就行' }],
          unread_replies: 1,
          has_screenshot: true,
          has_diagnostics: true,
          created_at: '2026-10-22T08:00:00.000Z',
          updated_at: '2026-10-22T09:00:00.000Z',
        },
        {
          client_id: 'fbc_1',
          kind: 'idea',
          message: '希望能导出',
          state: 'queued',
          replies: [],
          unread_replies: 0,
          has_screenshot: false,
          has_diagnostics: false,
          created_at: '2026-10-21T08:00:00.000Z',
          updated_at: '2026-10-21T08:00:00.000Z',
        },
      ],
    }
    shell()
    // WP481：个人菜单里的「我的反馈」
    fireEvent.click(feedbackItem('account-feedback-mine'))
    const items = await screen.findAllByTestId('feedback-mine-item')
    expect(items).toHaveLength(2)
    expect(items[0]?.textContent).toContain('已修')
    expect(items[0]?.textContent).toContain('修好了，更新到最新版就行')
    expect(items[1]?.textContent).toContain('待发出')
    await waitFor(() => {
      expect(state.seen).toBe(1)
    })
  })

  it('铃铛带过来的 ?feedback=mine 直接打开我的反馈；空的时候一句话', async () => {
    shell('/inbox?feedback=mine')
    expect(await screen.findByTestId('feedback-mine')).toBeTruthy()
    expect(screen.getByTestId('feedback-mine').textContent).toContain('还没有反馈')
  })
})

describe('⌘K', () => {
  it('搜「反馈」有这一行；选了关掉面板、打开反馈框', async () => {
    const { CommandPalette } = await import('@/components/command-palette')
    const closed: boolean[] = []
    renderWithProviders(
      <>
        <CommandPalette
          open
          onOpenChange={(v) => {
            closed.push(v)
          }}
          positions={[]}
          instances={[]}
          cards={[]}
          tileLibrary={[]}
          onAddTile={() => {}}
        />
        <FeedbackHost />
      </>,
    )
    const row = await screen.findByTestId('command-feedback')
    expect(row.textContent).toBe('反馈')
    fireEvent.click(row)
    expect(closed).toEqual([false])
    expect(await screen.findByTestId('feedback-message')).toBeTruthy()
  })
})

describe('铃铛', () => {
  it('「你的反馈有了回复」指向 ?feedback=mine：人在首页也不算已经看过', async () => {
    const { isSamePage } = await import('@/components/notifications/use-system-notify')
    expect(isSamePage('/?feedback=mine', '/')).toBe(false)
    expect(isSamePage('/settings', '/settings')).toBe(true)
  })
})
