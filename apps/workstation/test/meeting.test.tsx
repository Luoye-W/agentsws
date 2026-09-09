/**
 * 会议页的三条硬断言：
 * - 产出四栏都在，每条待办带言语状态；
 * - 拿不到麦克风时「一键录音」是禁用的（Electron 与浏览器同一条判断，不报错）；
 * - 「发认领卡」按下去打的是 `/v1/meetings/:id/outputs/send`，前端不自己造卡片。
 */
import type { Meeting, MeetingOutputs, MeetingRecord } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const T0 = '2026-09-09T09:00:00.000Z'

const meeting: Meeting = {
  id: 'mtg_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  title: '周会',
  start: T0,
  end: '2026-09-09T10:00:00.000Z',
  participants: [
    { person_id: 'per_luo', name: '罗野' },
    { name: 'Kunde', external: true },
  ],
  records: ['mrec_1'],
  sensitivity: 'restricted',
  status: 'done',
  created_by: 'per_luo',
  created_at: T0,
  updated_at: T0,
}

const record: MeetingRecord = {
  id: 'mrec_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  meeting_id: 'mtg_1',
  source: 'handed_over',
  transcript: { text: '罗野：我们决定上线。' },
  consent: { recorded_by: 'per_luo', notice_given: true },
  status: 'transcribed',
  sensitivity: 'restricted',
  ingested_by: { kind: 'person', id: 'per_luo' },
  created_at: T0,
  updated_at: T0,
}

const provenance = { record_id: 'mrec_1', quote: '让张三明天转账给供应商。', speaker: '罗野' }

const outputs: MeetingOutputs[] = [
  {
    meeting_id: 'mtg_1',
    record_id: 'mrec_1',
    decisions: [{ id: 'd1', text: '下周一上线', provenance }],
    todos: [
      {
        id: 't1',
        text: '转账给供应商',
        assignee_hint: '张三',
        speech_state: 'suggested',
        speech_state_reasons: ['high_risk_action'],
        provenance,
      },
    ],
    boundary_answers: [{ id: 'b1', question: '退货几天？', answer: '14 天', provenance }],
    knowledge: [
      {
        id: 'k1',
        layer: 'policy',
        question: '退货窗口',
        statement: '统一按 14 天算',
        hold_reasons: ['policy_sensitive'],
        provenance,
      },
    ],
    processor: 'agentsws/default-meeting-assistant',
    produced_at: T0,
  },
]

const getMeeting = vi.fn(async () => ({ meeting, records: [record] }))
const getMeetingOutputs = vi.fn(async () => outputs)
const sendMeetingCard = vi.fn(async () => ({
  approval_id: 'ap_1',
  title: '会议待办：转账给供应商',
}))
const processMeetingRecord = vi.fn(async () => ({ record, outputs: outputs[0] }))
const addMeetingRecord = vi.fn(async () => [record])

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMeeting: (...a: unknown[]) => getMeeting(...(a as [])),
    getMeetingOutputs: (...a: unknown[]) => getMeetingOutputs(...(a as [])),
    sendMeetingCard: (...a: unknown[]) => sendMeetingCard(...(a as [])),
    processMeetingRecord: (...a: unknown[]) => processMeetingRecord(...(a as [])),
    addMeetingRecord: (...a: unknown[]) => addMeetingRecord(...(a as [])),
  }
})

const { MeetingPage, canRecord } = await import('@/pages/meeting')

/** 会议页靠 `useParams()` 拿 id，所以测试也要真挂一条路由。 */
const renderPage = () =>
  renderWithProviders(
    <Routes>
      <Route path="/meetings/:id" element={<MeetingPage />} />
    </Routes>,
    '/meetings/mtg_1',
  )

describe('会议页（37 §4）', () => {
  beforeEach(() => {
    sendMeetingCard.mockClear()
    processMeetingRecord.mockClear()
  })

  it('信息 + 记录 + 产出四栏都在；待办带言语状态', async () => {
    renderPage()
    expect(await screen.findByText('周会')).toBeDefined()
    // 有外部参与者 → 敏感级显示「受限」
    expect(screen.getByText(/受限/)).toBeDefined()
    expect(screen.getByText('别人交来的')).toBeDefined()
    for (const column of ['决定', '待办提案', '边界答案', '知识候选']) {
      expect(await screen.findByText(column)).toBeDefined()
    }
    expect(await screen.findByText('建议')).toBeDefined()
    expect(screen.getByText('转账给供应商')).toBeDefined()
    expect(screen.getByText('→ 张三')).toBeDefined()
  })

  it('jsdom 里拿不到 MediaRecorder → 一键录音禁用并给出说明', async () => {
    expect(canRecord()).toBe(false)
    renderPage()
    const button = await screen.findByRole('button', { name: /一键录音/ })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/拿不到麦克风/)).toBeDefined()
  })

  it('发认领卡：打服务端的 send 入口，发过一次就变「已发出」', async () => {
    const user = userEvent.setup()
    renderPage()
    const button = await screen.findByRole('button', { name: '发认领卡' })
    await user.click(button)
    await waitFor(() => {
      expect(sendMeetingCard).toHaveBeenCalledWith('mtg_1', {
        record_id: 'mrec_1',
        kind: 'claim',
        item_id: 't1',
      })
    })
    expect(await screen.findByText('已发出')).toBeDefined()
  })

  it('处理：点一次就调 process，并把条数写成一句人话', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: '处理' }))
    await waitFor(() => {
      expect(processMeetingRecord).toHaveBeenCalledWith('mtg_1', 'mrec_1')
    })
    expect(await screen.findByText(/条决定/)).toBeDefined()
  })

  it('粘贴纪要：收进这个会议时 source = handed_over', async () => {
    const user = userEvent.setup()
    renderPage()
    const box = await screen.findByLabelText('粘贴纪要')
    await user.type(box, '罗野：我们决定上线。')
    await user.click(screen.getByRole('button', { name: '收进这个会议' }))
    await waitFor(() => {
      expect(addMeetingRecord).toHaveBeenCalledWith('mtg_1', {
        source: 'handed_over',
        text: '罗野：我们决定上线。',
        notice_given: true,
      })
    })
  })
})
