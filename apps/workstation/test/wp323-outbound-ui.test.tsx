/**
 * WP323：记录去处那张「定规矩」卡（一行预览、记下 / 不用两个按钮）与右栏「发出记录」。
 *
 * - 卡：只放用户交代的去处名字 + 一行预览 + 一句之后怎样；不出双格；卡上不出现表格是哪一家；
 * - 面板：记录一行一条；记录去处只在有的时候出，显示用户起的名字；写不进去才出原因与「补写」；
 *   界面上没有任何一家表格的专属设置区。
 */
import type { DeckCard } from '@agentsws/deck'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeckCardView } from '@/components/deck/deck-card'
import { noticeKeys } from '@/components/peers/handoff-strip'
import { OutboundPanel } from '@/components/rail/panels/outbound-panel'
import type { OutboundRecord, RecordSinkView } from '@/lib/outbound-api'
import { draftCard } from './fixtures'
import { renderWithProviders } from './helpers'

const state: { sinks: RecordSinkView[]; records: OutboundRecord[]; calls: string[] } = {
  sinks: [],
  records: [],
  calls: [],
}

vi.mock('@/lib/outbound-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/outbound-api')>('@/lib/outbound-api')
  return {
    ...actual,
    listOutbound: async () => state.records,
    listSinks: async () => state.sinks,
    sinkAction: async (id: string, verb: string) => {
      state.calls.push(`${verb} ${id}`)
      return {}
    },
    removeSink: async (id: string) => {
      state.calls.push(`delete ${id}`)
      return { removed: true }
    },
  }
})

const T0 = '2026-10-14T02:30:00.000Z'

beforeEach(() => {
  state.calls = []
  state.records = [
    {
      id: 'ob_1',
      workspace_id: 'ws_1' as never,
      source_key: 'approval:apv_1',
      sent_at: T0,
      channel: 'reddit',
      action: 'reply',
      kind: 'social_reply',
      destination: 'r/inmoxr',
      content: 'About 3 hours of active use.',
      link: 'https://www.reddit.com/r/inmoxr/comments/abc/_/def/',
      status: 'sent',
      follow_ups: [{ id: 'f1', at: T0, from: 'them', text: 'thanks' }],
    },
  ]
  state.sinks = [
    {
      id: 'sink_1',
      workspace_id: 'ws_1' as never,
      name: 'INMO 回复记录',
      instruction: 'x',
      adapter: 'feishu_bitable',
      url: 'https://x.feishu.cn/base/bascnAAA111',
      ref: {},
      columns: [],
      filter: {},
      state: 'broken',
      created_at: T0,
      updated_at: T0,
      last_error: { code: 'no_permission', message: '没有权限写这张表。', at: T0 },
      written: 3,
      pending: 2,
    },
  ]
})

function sinkCard(): DeckCard {
  const options = [
    { id: 'after', label: '记下' },
    { id: 'before', label: '不用' },
  ]
  const base = draftCard()
  return draftCard({
    id: 'ap_sink',
    kind: 'policy_change',
    layout: 'policy',
    title: '记录去处：INMO 回复记录',
    summary: '之后每发出去一条，照这样记一行。',
    content_variants: { zh_summary: '之后每发出去一条，照这样记一行。' },
    options,
    detail: {
      ...base.detail,
      payload: {
        form: 'record_sink',
        sink_id: 'sink_1',
        name: 'INMO 回复记录',
        options,
        target: 'workspace_policy',
        before: null,
        after: { name: 'INMO 回复记录' },
        preview: [
          ['日期', '2026/10/14'],
          ['版块', 'r/inmoxr'],
          ['备注', ''],
        ],
        sample: false,
      },
    },
  })
}

describe('WP323 记录去处的「定规矩」卡', () => {
  it('一行预览、没有双格；「记下 / 不用」两个按钮；点了带 after', () => {
    const onDecide = vi.fn()
    renderWithProviders(
      <DeckCardView card={sinkCard()} mode="zh_summary" onDecide={onDecide} onOpen={() => {}} />,
    )
    const preview = screen.getByTestId('deck-record-sink-preview')
    expect(preview.textContent).toContain('2026/10/14')
    expect(preview.textContent).toContain('—')
    expect(screen.queryByTestId('deck-before-after')).toBeNull()
    expect(screen.getByTestId('deck-card').textContent).not.toMatch(/飞书|feishu/i)
    fireEvent.click(screen.getByText('记下'))
    expect(onDecide).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'approve', selected_option_id: 'after' }),
    )
    expect(noticeKeys(sinkCard())).toEqual({
      right: { id: 'after', label: '记下' },
      left: { id: 'before', label: '不用' },
    })
  })
})

describe('WP323 右栏「发出记录」', () => {
  it('记录一行一条；去处显示用户起的名字；写不进去才出原因与「补写」', async () => {
    renderWithProviders(<OutboundPanel tier="position" pathname="/" />)
    expect(await screen.findByTestId('outbound-records')).toBeDefined()
    expect(screen.getByText('About 3 hours of active use.')).toBeDefined()
    expect(screen.getByText('回了 1 条')).toBeDefined()
    const sink = screen.getByTestId('outbound-sink')
    expect(sink.textContent).toContain('INMO 回复记录')
    expect(sink.textContent).toContain('待补写 2')
    expect(screen.getByTestId('outbound-sink-error').textContent).toBe('没有权限写这张表。')
    // 没有任何一家表格的专属设置区（没有输入框、没有应用凭据 / 表格 token 之类的字）；
    // 「例如飞书、Google 表格」只出现在问号提示那一句里
    const panel = screen.getByTestId('rail-outbound')
    expect(panel.querySelectorAll('input')).toHaveLength(0)
    expect(panel.textContent).not.toMatch(/App ID|App Secret|bitable|app_token|tenant/i)
    fireEvent.click(screen.getByTestId('outbound-sink-retry'))
    await waitFor(() => expect(state.calls).toEqual(['retry sink_1']))
  })

  it('没有去处时那一块不出；没有记录时一句话', async () => {
    state.sinks = []
    state.records = []
    renderWithProviders(<OutboundPanel tier="position" pathname="/" />)
    expect(await screen.findByTestId('outbound-empty')).toBeDefined()
    expect(screen.queryByTestId('outbound-sinks')).toBeNull()
  })
})
