/**
 * WP333（决策 584）：个人微信卡片链接 `/cards/<卡号>` 打开就是那一张卡。
 *
 * - 还没定的：照常能定，决定带这张卡所在职责的分配；
 * - 已经定过的：照实说一句，卡还能看；
 * - 找不到（404）：一句人话 + 回首页。
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiClientError } from '@/lib/api'
import { CardPage } from '@/pages/card'
import { renderWithProviders } from './helpers'

const D = '2026-10-15T08:00:00.000Z'

const approval = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'apr_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'outbound_draft',
  revision: 2,
  role_id: 'support.aftersales',
  subject: { object: { type: 'thread', id: 'thr_1' } },
  dedupe_key: 'dk_1',
  title: '回复：小蓝灯什么时候到',
  summary: '您好，已经安排发出，预计周五到。',
  payload: {},
  evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
  proposer: { kind: 'agent', id: 'agent_1' },
  automation: {
    level_at_creation: 'L1',
    auto_approved: false,
    mandate_check: { within: true, caps_hit: [] },
    sampling: { selected: false },
  },
  routing: {
    recipients: [{ person: 'per_1', via: 'owner' }],
    rule: 'owner',
    escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
    separation_of_duties: false,
  },
  priority: 'queue',
  state: 'pending',
  deliveries: [],
  links: { children: [] },
  created_at: D,
  updated_at: D,
  ...over,
})

const state: { item: ApprovalItem | Error } = { item: approval() }
const decide = vi.fn(async (..._a: unknown[]) => ({}))

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getApproval: async () => {
      if (state.item instanceof Error) throw state.item
      return state.item
    },
    getPositions: async () => ({
      positions: [
        { position_id: 'asg_ops', role_id: 'site.theme', role_name: '网页' },
        { position_id: 'asg_cs', role_id: 'support.aftersales', role_name: '售后客服' },
      ],
      tile_library: [],
      max_tiles: 4,
    }),
    decide: (...a: unknown[]) => decide(...a),
  }
})

vi.setConfig({ testTimeout: 20_000 })

const open = (id = 'apr_1') =>
  renderWithProviders(
    <Routes>
      <Route path="/cards/:id" element={<CardPage />} />
      <Route path="/" element={<p data-testid="home" />} />
    </Routes>,
    `/cards/${id}`,
  )

beforeEach(() => {
  state.item = approval()
  decide.mockClear()
})

describe('WP333 卡片链接页', () => {
  it('还没定的：打开就是那一张，能定；决定带卡所在职责的分配', async () => {
    open()
    expect(await screen.findByText('回复：小蓝灯什么时候到')).toBeTruthy()
    expect(screen.getByTestId('card-page').getAttribute('data-card')).toBe('apr_1')
    expect(screen.queryByTestId('card-page-settled')).toBeNull()
    const approve = screen
      .getByTestId('card-page')
      .querySelector('button[data-action="approve"]') as HTMLButtonElement
    fireEvent.click(approve)
    await waitFor(() => {
      expect(decide).toHaveBeenCalledTimes(1)
    })
    const [id, body, assignment] = decide.mock.calls[0] as [string, { action: string }, string]
    expect(id).toBe('apr_1')
    expect(body.action).toBe('approve')
    expect(assignment).toBe('asg_cs')
    expect((await screen.findByTestId('card-page-receipt')).textContent).toBe('处理好了')
  })

  it('已经定过的：照实说一句，卡还能看、没有「发送」', async () => {
    state.item = approval({ state: 'approved' })
    open()
    expect(await screen.findByTestId('card-page-settled')).toBeTruthy()
    expect(screen.getByText('回复：小蓝灯什么时候到')).toBeTruthy()
    expect(
      screen.getByTestId('card-page').querySelector('button[data-action="approve"]'),
    ).toBeNull()
  })

  it('找不到：一句人话 + 回首页', async () => {
    state.item = new ApiClientError(404, { code: 'not_found', message: 'nope' })
    open('apr_zzz')
    expect((await screen.findByTestId('card-page-missing')).textContent).toContain('找不到这张卡')
    fireEvent.click(screen.getByTestId('card-page-home'))
    expect(await screen.findByTestId('home')).toBeTruthy()
  })
})
