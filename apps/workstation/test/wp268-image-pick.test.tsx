/**
 * WP268：事项里的挑图卡 / 超额卡、输入框加图（借 WP264 事项页测试的那套替身）。
 * （以下几行是 WP264 原注释）WP264：事项页 v2（对话式，docs/design/matter/）。
 *
 * 页头一行（短标题就地改 / 状态 / 「⋯」归档置灰说原因）、对话式时间线（右气泡、左 AI + Markdown、
 * 预览结果卡、运行摘要一行灰字点开看步骤、卡住卡、内嵌审批卡批了缩成一行、同日一条日期）、运行中「正在做…」、
 * 输入卡（发送 / 停 / 私聊 AI / Tab 收建议，什么时候不给建议）。
 */
import type { ApprovalItem, MatterEvent, MatterView } from '@agentsws/contracts'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const D1 = '2026-10-07T06:02:00.000Z'
const D1b = '2026-10-07T06:40:00.000Z'
const D2 = '2026-10-08T01:05:00.000Z'

const BRIEF =
  '用 agentsws-theme 给 Rollout 搭英文首页（变形金刚正版授权耳机音箱，美国市场）：大图横幅、主推产品占位、品牌故事、FAQ、邮件订阅；深色科技风红色点缀。推成未发布主题给我预览，先别发布。'
const FINAL = [
  '### 改了什么（2 个文件）',
  '- `templates/index.json`：首页 5 屏',
  '- `config/settings_data.json`：底色 `#0B0D10`、主色红 `#E11D2E`',
  '### 影响面',
  ...Array.from({ length: 16 }, (_, i) => `- 第 ${i + 1} 条说明，配色是全店级的`),
  '要发布说一句，会先出一张审批卡给你批。',
].join('\n')

let seq = 0
const ev = (over: Partial<MatterEvent> & Pick<MatterEvent, 'kind' | 'at'>): MatterEvent => {
  seq += 1
  return {
    id: `mev_${seq}`,
    matter_id: 'mat_r',
    text: '',
    actor: { kind: 'agent', id: 'asg_web' },
    ...over,
  }
}

const baseTimeline = (): MatterEvent[] => [
  ev({ kind: 'human_message', at: D1, text: BRIEF, actor: { kind: 'person', id: 'per_1' } }),
  ev({ kind: 'run', at: D1, text: 'Agent 接着这个事项跑了一次', run_id: 'run_1' }),
  ev({
    kind: 'status',
    at: D1b,
    text: '预览好了：未发布主题「Rollout Homepage v1 (dark tech)」（线上没动）。',
    actor: { kind: 'agent', id: 'site.shopify-theme' },
    preview: {
      url: 'https://shop.example/?preview_theme_id=1',
      label: 'Rollout Homepage v1 (dark tech)',
      changed_files: ['templates/index.json', 'config/settings_data.json'],
      check: { errors: 0, warnings: 0 },
    },
  }),
  ev({
    kind: 'status',
    at: D1b,
    text: '跑完了',
    run_id: 'run_1',
    run_digest: {
      seconds: 252,
      outcome: 'completed',
      steps: [
        { text: '读 templates/index.json', status: 'ok', seconds: 6 },
        { text: '改 templates/index.json', status: 'ok', seconds: 108 },
        { text: '改 config/settings_data.json', status: 'ok', seconds: 22 },
        { text: '主题检查', status: 'ok', seconds: 41 },
        { text: '推成未发布主题「Rollout Homepage v1 (dark tech)」', status: 'ok', seconds: 35 },
      ],
    },
  }),
  ev({ kind: 'agent_message', at: D1b, text: FINAL, run_id: 'run_1', next_suggestion: '发布上线' }),
]

const view = (
  timeline: MatterEvent[],
  over: Partial<MatterView['matter']> = {},
  extra: Partial<MatterView> = {},
) => ({
  matter: {
    id: 'mat_r',
    schema_version: 1 as const,
    workspace_id: 'ws_1',
    kind: 'adhoc' as const,
    title: 'Rollout 英文首页 · 深色科技风',
    title_source: 'ai' as const,
    status: 'open' as const,
    entry: 'position' as const,
    position_id: 'asg_web',
    role_id: 'site.theme',
    position_template_id: 'web-ops',
    context: { summary: '', pinned: [], participants: ['per_1'], last_activity: D1b },
    created_at: D1,
    updated_at: D1b,
    ...over,
  },
  timeline,
  has_more: false,
  todos: [],
  open_card_ids: [],
  pinned_labels: [],
  participant_labels: [{ person_id: 'per_1', label: '林舟' }],
  ...extra,
})

let current = view(baseTimeline())
const getMatter = vi.fn(async () => current)
const postMatterMessage = vi.fn(async () => ({ event: baseTimeline()[0] }))
const retitleMatter = vi.fn(async () => ({ matter: current.matter }))
const stopMatterRuns = vi.fn(async () => ({ stopped: 1 }))
const askAi = vi.fn(async () => ({
  answer: '全店配色在「主题设置 → 颜色」里。',
  answer_hash: 'h',
  grounded_on: [],
}))
const decide = vi.fn(async () => ({}))
const uploadBrandAsset = vi.fn(async () => ({
  asset: { id: 'dasset_up1', file_url: '/v1/brand-assets/dasset_up1/file' },
}))
const openExternal = vi.fn()
let approvalItem: ApprovalItem | undefined

const approval = (over: Partial<ApprovalItem> = {}): ApprovalItem => ({
  id: 'apr_pub',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'outbound_draft',
  revision: 3,
  role_id: 'site.theme',
  subject: { object: { type: 'thread', id: 'thr_1' } },
  dedupe_key: 'dk_1',
  title: '把「Rollout Homepage v1 (dark tech)」设为线上主题',
  summary: '访客马上看到新首页\n配色是全店级：商品页、购物车也会变深色',
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
  created_at: D2,
  updated_at: D2,
  ...over,
})

vi.mock('@/components/connections/bridge', async () => {
  const actual = await vi.importActual<typeof import('@/components/connections/bridge')>(
    '@/components/connections/bridge',
  )
  return { ...actual, openExternal: (url: string) => openExternal(url) }
})

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    postMatterMessage: (...a: unknown[]) => postMatterMessage(...(a as [])),
    retitleMatter: (...a: unknown[]) => retitleMatter(...(a as [])),
    stopMatterRuns: (...a: unknown[]) => stopMatterRuns(...(a as [])),
    askAi: (...a: unknown[]) => askAi(...(a as [])),
    decide: (...a: unknown[]) => decide(...(a as [])),
    brandAssetObjectUrl: async (u: string) => `blob:${u}`,
    uploadBrandAsset: (...a: unknown[]) => uploadBrandAsset(...(a as [])),
    getApproval: async () => {
      if (approvalItem === undefined) throw new Error('not found')
      return approvalItem
    },
    getPosition: async () => ({
      position_id: 'web-ops',
      roles: [
        {
          role_id: 'site.theme',
          role_name: 'Shopify 网页模板',
          assignment_ids: ['asg_web'],
          my_assignment_id: 'asg_web',
        },
      ],
    }),
  }
})
vi.mock('@/lib/work-archive', async () => {
  const actual = await vi.importActual<typeof import('@/lib/work-archive')>('@/lib/work-archive')
  return {
    ...actual,
    getWorkRail: async () => ({ positions: [] }),
    markMatterSeen: async () => undefined,
  }
})

const { MatterPage } = await import('@/pages/matter')

const renderMatter = () =>
  renderWithProviders(
    <Routes>
      <Route path="/matters/:id" element={<MatterPage />} />
    </Routes>,
    '/matters/mat_r',
  )
const user = () => userEvent.setup({ delay: null, pointerEventsCheck: 0 })

beforeEach(() => {
  current = view(baseTimeline())
  approvalItem = undefined
  for (const f of [
    postMatterMessage,
    retitleMatter,
    stopMatterRuns,
    askAi,
    decide,
    openExternal,
    uploadBrandAsset,
  ])
    f.mockClear()
})

const variants = [1, 2, 3].map((i) => ({
  id: `asset:dasset_${i}`,
  asset_id: `dasset_${i}`,
  url: `/v1/brand-assets/dasset_${i}/file`,
  label: `第 ${i} 张`,
  width: 1536,
  height: 1024,
}))
const pickPayload = {
  form: 'image_pick',
  variants,
  options: [
    ...variants.map((v) => ({ id: v.id, label: v.label })),
    { id: 'again', label: '再来一版' },
  ],
  job: { operation: 'generate', prompt: 'hero', size: '1536x1024', n: 3 },
  model_label: 'gpt-image-1',
  credits: 1.5,
  again_credits: 1.5,
  upload: true,
  run_id: 'run_2',
}
const pickCardEvent = () =>
  ev({ kind: 'card', at: D2, text: '挑一张图', approval_item_id: 'apr_pick' })

describe('WP268 挑图卡', () => {
  it('三张并排（图带令牌取）、写明会传店铺；用这张 = 带选项批', async () => {
    approvalItem = approval({
      id: 'apr_pick',
      kind: 'image_pick',
      title: '挑一张图：挂到首页「hero」',
      payload: pickPayload,
      options: pickPayload.options,
    })
    current = view([...baseTimeline(), pickCardEvent()])
    renderMatter()
    const box = await screen.findByTestId('image-pick-card')
    expect(box.textContent).toContain('花了 1.5 积分')
    expect(box.textContent).toContain('传到店铺「文件」')
    expect(within(box).getAllByTestId('image-pick-variant')).toHaveLength(3)
    await waitFor(() => {
      expect(box.querySelectorAll('img')[1]?.getAttribute('src')).toBe(
        'blob:/v1/brand-assets/dasset_2/file',
      )
    })
    expect(screen.getByTestId('matter-state').textContent).toBe('等你批')
    await user().click(within(box).getAllByTestId('image-pick-use')[1] as HTMLElement)
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'apr_pick',
        expect.objectContaining({ action: 'approve', selected_option_id: 'asset:dasset_2' }),
        'asg_web',
      )
    })
  })

  it('再来一版（带预估积分）= 选「again」；都不要 = 带原因驳回', async () => {
    approvalItem = approval({ id: 'apr_pick', kind: 'image_pick', payload: pickPayload })
    current = view([...baseTimeline(), pickCardEvent()])
    renderMatter()
    const box = await screen.findByTestId('image-pick-card')
    const again = within(box).getByTestId('image-pick-again')
    expect(again.textContent).toContain('约 1.5 积分')
    await user().click(again)
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'apr_pick',
        expect.objectContaining({ selected_option_id: 'again' }),
        'asg_web',
      )
    })
    await user().click(within(box).getByTestId('image-pick-none'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'apr_pick',
        expect.objectContaining({ action: 'reject', reason: '都不要' }),
        'asg_web',
      )
    })
  })

  it('超额卡：继续出 / 不出了', async () => {
    approvalItem = approval({
      id: 'apr_pick',
      kind: 'image_budget',
      title: '再出 2 张图，约 1 积分，要继续吗？',
      summary: '这件事这一轮已经出了 8 张（单次上限 8 张）。批了才出，不批一分不花。',
      payload: { form: 'image_budget', credits: 1 },
    })
    current = view([...baseTimeline(), pickCardEvent()])
    renderMatter()
    const box = await screen.findByTestId('image-budget-card')
    expect(box.textContent).toContain('约 1 积分')
    await user().click(within(box).getByTestId('image-budget-go'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'apr_pick',
        expect.objectContaining({ action: 'approve' }),
        'asg_web',
      )
    })
  })

  it('批过的挑图卡缩成一行', async () => {
    approvalItem = approval({
      id: 'apr_pick',
      kind: 'image_pick',
      payload: pickPayload,
      state: 'approved_edited',
    })
    current = view([...baseTimeline(), pickCardEvent()])
    renderMatter()
    expect(await screen.findByTestId('matter-card-done')).toBeTruthy()
    expect(screen.queryByTestId('image-pick-card')).toBeNull()
  })
})

describe('WP268 输入框加图', () => {
  it('「+」选图 → 进素材库（带事项）→ 发话时带上素材 id', async () => {
    renderMatter()
    const attach = await screen.findByTestId('matter-attach')
    expect((attach as HTMLButtonElement).disabled).toBe(false)
    const input = screen
      .getByTestId('matter-say')
      .querySelector('input[type="file"]') as HTMLInputElement
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'box.png', {
      type: 'image/png',
    })
    await user().upload(input, file)
    await waitFor(() => {
      expect(uploadBrandAsset).toHaveBeenCalledWith(file, { matter_id: 'mat_r' })
    })
    expect(await screen.findByTestId('matter-attachments')).toBeTruthy()
    const u = user()
    await u.type(screen.getByLabelText('在这个事项里说一句'), '用这张做首页横幅{Enter}')
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalled()
    })
    const said = String((postMatterMessage.mock.calls[0] as unknown[])[1] ?? '')
    expect(said).toContain('用这张做首页横幅')
    expect(said).toContain('dasset_up1')
  })
})
