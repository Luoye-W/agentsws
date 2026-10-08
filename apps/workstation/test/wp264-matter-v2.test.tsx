/**
 * WP264：事项页 v2（对话式，docs/design/matter/）。
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
import { buildItems, digestFacts, suggestionFor } from '@/components/matter/matter-model'
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

/** WP276：组织（不给 = 按 ③ 兜底）；② 里事项页「⋯」多一个「交给同事」。 */
const matterOrgs: unknown[] = []

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listOrganizations: async () => matterOrgs,
    ensureSession: async () => ({
      person: { id: 'per_1', email: 'p1@ex.com', name: '王岚' },
      workspace: { id: 'ws_1', name: 'Rollout' },
      assignments: [],
    }),
    getMatter: (...a: unknown[]) => getMatter(...(a as [])),
    postMatterMessage: (...a: unknown[]) => postMatterMessage(...(a as [])),
    retitleMatter: (...a: unknown[]) => retitleMatter(...(a as [])),
    stopMatterRuns: (...a: unknown[]) => stopMatterRuns(...(a as [])),
    askAi: (...a: unknown[]) => askAi(...(a as [])),
    decide: (...a: unknown[]) => decide(...(a as [])),
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

vi.mock('@/lib/api-peers', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api-peers')>('@/lib/api-peers')
  return {
    ...actual,
    listHandoffs: async () => ({ to_me: [], from_me: [] }),
    listColleagues: async () => ({
      colleagues: [{ person_id: 'per_2', name: '林峰', in_progress: 0, load: '空着' }],
    }),
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
  for (const f of [postMatterMessage, retitleMatter, stopMatterRuns, askAi, decide, openExternal])
    f.mockClear()
})

describe('WP264 页头', () => {
  it('短标题一行；点了就地改，Enter 存（PATCH）', async () => {
    renderMatter()
    const title = await screen.findByTestId('matter-title')
    expect(title.textContent).toContain('Rollout 英文首页 · 深色科技风')
    const u = user()
    await u.click(title)
    const input = screen.getByTestId('matter-title-input')
    await u.clear(input)
    await u.type(input, 'Rollout 首页{Enter}')
    await waitFor(() => {
      expect(retitleMatter).toHaveBeenCalledWith('mat_r', 'Rollout 首页')
    })
  })

  it('灰字行：职责名字 · 状态 · 参与者；没有待办就不出那一格', async () => {
    renderMatter()
    await waitFor(() => {
      expect(screen.getByTestId('matter-reroute').textContent).toContain('Shopify 网页模板')
    })
    expect(screen.getByTestId('matter-state').textContent).toBe('进行中')
    expect(screen.queryByTestId('matter-todos-chip')).toBeNull()
  })

  it('在跑：「⋯」里归档置灰，右边说为什么', async () => {
    current = view(
      baseTimeline(),
      {},
      {
        live: { run_id: 'run_2', started_at: new Date().toISOString(), steps: [] },
      },
    )
    renderMatter()
    const u = user()
    await u.click(await screen.findByRole('button', { name: '更多' }))
    expect(screen.getByTestId('matter-archive').hasAttribute('disabled')).toBe(true)
    expect(screen.getByTestId('matter-archive-why').textContent).toContain('还在跑')
    expect(screen.getByTestId('matter-state').textContent).toBe('在跑')
  })
})

describe('WP276 ② 交给同事', () => {
  it('「⋯」里多一个「交给同事」，点了出同事下拉（带忙闲）；整页不像公司；① 里没有这一项', async () => {
    matterOrgs.splice(0, matterOrgs.length, {
      id: 'org_1',
      legal_name: 'Rollout',
      discoverable: true,
      owner_id: 'per_1',
      role: 'owner',
      brands: 1,
      members: 2,
      solo: false,
      mode: 'peers',
      created_at: '2026-10-08T09:00:00.000Z',
    })
    try {
      renderMatter()
      const u = user()
      await u.click(await screen.findByTestId('matter-menu'))
      await u.click(await screen.findByTestId('matter-handoff'))
      expect((await screen.findByTestId('handoff-person')).textContent).toContain('林峰')
      expect(screen.getByTestId('handoff-person').textContent).toContain('空着')
      // 扫的是界面自己的字（页头、菜单、交给同事那一框）；时间线里是 AI 与人说的话，不算
      const text = `${screen.getByTestId('matter-header').textContent ?? ''}${
        screen.getByTestId('handoff-dialog').textContent ?? ''
      }`
      for (const word of [
        '主管',
        '老板',
        '上级',
        '审批',
        '部门',
        '范围',
        '并进来',
        '加入一家公司',
        '成员额度',
      ])
        expect(text, word).not.toContain(word)
    } finally {
      matterOrgs.length = 0
    }
  }, 20_000)

  it('① 个人：「⋯」里没有「交给同事」', async () => {
    matterOrgs.splice(0, matterOrgs.length, {
      id: 'org_1',
      legal_name: 'Rollout',
      discoverable: false,
      owner_id: 'per_1',
      role: 'owner',
      brands: 1,
      members: 1,
      solo: true,
      mode: 'solo',
      created_at: '2026-10-08T09:00:00.000Z',
    })
    try {
      renderMatter()
      const u = user()
      await u.click(await screen.findByTestId('matter-menu'))
      expect(screen.queryByTestId('matter-handoff')).toBeNull()
    } finally {
      matterOrgs.length = 0
    }
  })
})

describe('WP264 对话式时间线', () => {
  it('原话是第一条右气泡；同一天只出一条日期；跑完的那次只出摘要一行（开跑那条不单出）', async () => {
    renderMatter()
    const bubbles = await screen.findAllByTestId('matter-bubble')
    expect(bubbles[0]?.textContent).toBe(BRIEF)
    expect(screen.getAllByTestId('matter-day')).toHaveLength(1)
    expect(document.querySelector('[data-sys="run"]')).toBeNull()
    const digest = document.querySelector('[data-sys="digest"]') as HTMLElement
    expect(digest.textContent).toContain(
      '跑完了 · 4 分 12 秒 · 改 2 个文件 · 跑了主题检查 · 推成未发布主题',
    )
    // 默认收起，点开看步骤
    expect(within(digest).queryByTestId('matter-steps')).toBeNull()
    await user().click(within(digest).getByRole('button', { expanded: false }))
    expect(within(digest).getByTestId('matter-steps').textContent).toContain(
      '改 config/settings_data.json',
    )
  })

  it('预览嵌在那条 AI 消息里：打开预览 / 发布上线（说一句出卡）/ 看改动', async () => {
    renderMatter()
    const card = await screen.findByTestId('matter-preview-card')
    expect(card.textContent).toContain('Rollout Homepage v1 (dark tech)')
    expect(card.textContent).toContain('改了 2 个文件 · 检查 0 错 0 警')
    const u = user()
    await u.click(within(card).getByTestId('matter-preview-open'))
    expect(openExternal).toHaveBeenCalledWith('https://shop.example/?preview_theme_id=1')
    await u.click(within(card).getByTestId('matter-preview-diff'))
    expect(within(card).getByTestId('matter-preview-files').textContent).toContain(
      'templates/index.json',
    )
    await u.click(within(card).getByTestId('matter-preview-publish'))
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalledWith('mat_r', '发布上线')
    })
  })

  it('AI 正文按 Markdown 排（小标题、行内代码带色块）；长回答先折叠，「展开全文」', async () => {
    renderMatter()
    const reply = await screen.findByTestId('matter-reply')
    expect(reply.querySelector('h3')?.textContent).toBe('改了什么（2 个文件）')
    expect(reply.querySelectorAll('[data-slot="swatch"]')).toHaveLength(2)
    expect(reply.textContent).not.toContain('`')
    expect(reply.getAttribute('data-folded')).toBe('true')
    await user().click(screen.getByTestId('matter-unfold'))
    expect(screen.getByTestId('matter-reply').getAttribute('data-folded')).toBe('false')
  })

  it('卡住了：是最新一条时是卡（去连接 / 接着做）；后来接着做了就缩成一行', async () => {
    const blocked = ev({
      kind: 'status',
      at: D2,
      text: '要读店里的合集，但店铺后台连接断了',
      actor: { kind: 'system', id: 'runtime' },
      blocked: {
        reason: 'not_connected',
        connections: ['Shopify 店铺后台'],
        tools: ['list_collections'],
      },
    })
    current = view([...baseTimeline(), blocked])
    renderMatter()
    const card = await screen.findByTestId('matter-blocked-card')
    expect(card.textContent).toContain('要先连上「Shopify 店铺后台」')
    // 固定规则的建议：「连好了，接着做」
    expect(screen.getByTestId('matter-suggest').textContent).toContain('连好了，接着做')
    await user().click(within(card).getByTestId('matter-blocked-go'))
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalledWith('mat_r', '连好了，接着做')
    })
  })

  it('卡住之后人又说了一句：缩成一行灰字', async () => {
    const blocked = ev({
      kind: 'status',
      at: D2,
      text: '缺连接',
      actor: { kind: 'system', id: 'runtime' },
      blocked: { reason: 'not_connected', connections: ['Shopify 店铺后台'], tools: [] },
    })
    const said = ev({
      kind: 'human_message',
      at: D2,
      text: '接着做',
      actor: { kind: 'person', id: 'per_1' },
    })
    current = view([...baseTimeline(), blocked, said])
    renderMatter()
    await screen.findAllByTestId('matter-bubble')
    expect(screen.queryByTestId('matter-blocked-card')).toBeNull()
    expect(document.querySelector('[data-sys="blocked"]')?.textContent).toContain(
      '卡在缺连接：Shopify 店铺后台',
    )
    expect(screen.getAllByTestId('matter-day')).toHaveLength(2)
  })

  it('审批卡内嵌、能直接批；批过缩成一行「你批了 · …」', async () => {
    approvalItem = approval()
    const card = ev({ kind: 'card', at: D2, text: '发布上线', approval_item_id: 'apr_pub' })
    current = view([...baseTimeline(), card])
    renderMatter()
    const box = await screen.findByTestId('matter-card')
    expect(box.textContent).toContain('设为线上主题')
    expect(screen.getByTestId('matter-state').textContent).toBe('等你批')
    await user().click(within(box).getByTestId('matter-card-approve'))
    await waitFor(() => {
      expect(decide).toHaveBeenCalledWith(
        'apr_pub',
        expect.objectContaining({ action: 'approve', version: 3 }),
        'asg_web',
      )
    })
  })

  it('批过的卡缩成一行', async () => {
    approvalItem = approval({ state: 'applied' })
    current = view([
      ...baseTimeline(),
      ev({ kind: 'card', at: D2, text: '发布上线', approval_item_id: 'apr_pub' }),
    ])
    renderMatter()
    const done = await screen.findByTestId('matter-card-done')
    expect(done.textContent).toContain('你批了 · 把「Rollout Homepage v1 (dark tech)」设为线上主题')
  })

  it('运行中：「正在做…」+ 当前一步，点开实时步骤；输入卡发送位变「停」', async () => {
    current = view(
      baseTimeline(),
      {},
      {
        live: {
          run_id: 'run_2',
          started_at: new Date(Date.now() - 72_000).toISOString(),
          steps: [
            { text: '读 templates/index.json', status: 'ok', seconds: 2 },
            { text: '主题检查', status: 'running' },
          ],
        },
      },
    )
    renderMatter()
    const run = await screen.findByTestId('matter-running')
    expect(run.textContent).toContain('正在做…')
    expect(run.textContent).toContain('主题检查')
    expect(run.textContent).toContain('第 2 步')
    const u = user()
    await u.click(within(run).getByTestId('matter-running-now'))
    expect(within(run).getByTestId('matter-steps').textContent).toContain('读 templates/index.json')
    // 运行中不给建议
    expect(screen.queryByTestId('matter-suggest')).toBeNull()
    await u.click(screen.getByRole('button', { name: '停下这一轮' }))
    await waitFor(() => {
      expect(stopMatterRuns).toHaveBeenCalledWith('mat_r')
    })
  })
})

describe('WP264 输入卡', () => {
  it('空时发送置灰；Enter 发送、Shift+Enter 换行', async () => {
    renderMatter()
    const box = await screen.findByLabelText('在这个事项里说一句')
    expect(screen.getByRole('button', { name: '发送（Enter）' }).hasAttribute('disabled')).toBe(
      true,
    )
    const u = user()
    await u.type(box, '第一行{Shift>}{Enter}{/Shift}第二行')
    expect((box as HTMLTextAreaElement).value).toBe('第一行\n第二行')
    await u.keyboard('{Enter}')
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalledWith('mat_r', '第一行\n第二行')
    })
  })

  it('建议：AI 结构化的下一步浅灰显示；Tab 收下变正文；打别的字就没了', async () => {
    renderMatter()
    const box = (await screen.findByLabelText('在这个事项里说一句')) as HTMLTextAreaElement
    expect(screen.getByTestId('matter-suggest').textContent).toContain('发布上线')
    const u = user()
    await u.click(box)
    await u.keyboard('{Tab}')
    expect(box.value).toBe('发布上线')
    expect(screen.queryByTestId('matter-suggest')).toBeNull()
    await u.clear(box)
    await u.type(box, '把深色只用在首页')
    expect(screen.queryByTestId('matter-suggest')).toBeNull()
  })

  it('没有明确下一步就不给（普通占位字）', async () => {
    const tl = baseTimeline().map((e) =>
      e.kind === 'agent_message' ? { ...e, next_suggestion: undefined } : e,
    )
    current = view(tl as MatterEvent[])
    renderMatter()
    const box = await screen.findByLabelText('在这个事项里说一句')
    expect(screen.queryByTestId('matter-suggest')).toBeNull()
    expect(box.getAttribute('placeholder')).toBe('回复，或交代新要求…')
  })

  it('私聊 AI：整卡换模式、问一句只你看得见；关掉就没了；可「转给 Agent」', async () => {
    renderMatter()
    await screen.findByTestId('matter-say')
    const u = user()
    const toggle = screen.getByRole('switch', { name: /私聊 AI/ })
    await u.click(toggle)
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByTestId('matter-private-tag')).toBeDefined()
    // 私聊模式不给建议
    expect(screen.queryByTestId('matter-suggest')).toBeNull()
    const box = screen.getByLabelText('问 AI 一句，只你看得见…')
    await u.type(box, '只想首页深色要改哪里？{Enter}')
    await waitFor(() => {
      expect(askAi).toHaveBeenCalledWith({
        scope: { matter_id: 'mat_r' },
        question: '只想首页深色要改哪里？',
      })
    })
    const pair = await screen.findByTestId('matter-private-pair')
    await within(pair).findByTestId('ask-ai-answer')
    expect(postMatterMessage).not.toHaveBeenCalled()
    await u.click(within(pair).getByTestId('matter-private-forward'))
    await waitFor(() => {
      expect(postMatterMessage).toHaveBeenCalledWith('mat_r', '只想首页深色要改哪里？')
    })
    expect(screen.queryByTestId('matter-private-pair')).toBeNull()
  })

  it('已关闭的事项：输入框还在，占位「说一句就重新打开」', async () => {
    const tl = baseTimeline().map((e) =>
      e.kind === 'agent_message' ? { ...e, next_suggestion: undefined } : e,
    )
    current = view(tl as MatterEvent[], { status: 'closed', closed_at: D2 })
    renderMatter()
    const box = await screen.findByLabelText('在这个事项里说一句')
    expect(box.getAttribute('placeholder')).toBe('这件事已关闭，说一句就重新打开')
    expect(box.hasAttribute('disabled')).toBe(false)
    expect(screen.getByTestId('matter-closed-line')).toBeDefined()
    expect(screen.getByTestId('matter-state').textContent).toBe('已完成')
  })
})

describe('WP264 纯函数', () => {
  it('预览挂到紧跟着的 AI 消息；中间隔着人话就自己一条', () => {
    const tl = baseTimeline()
    const items = buildItems(tl, { closed: false, roleId: 'site.theme' })
    const ai = items.find((i) => i.kind === 'ai')
    expect(ai?.kind === 'ai' && ai.preview?.preview?.label).toBe('Rollout Homepage v1 (dark tech)')
    const split = [tl[2] as MatterEvent, ev({ kind: 'human_message', at: D1b, text: '嗯' })]
    const alone = buildItems(split, { closed: false })
    expect(alone.filter((i) => i.kind === 'ai')).toHaveLength(1)
  })

  it('建议：在跑 / 人刚说完不给；卡上主按钮优先于 AI 下一步', () => {
    const items = buildItems(baseTimeline(), { closed: false })
    expect(suggestionFor({ items, busy: false, blockedSay: 'x' })).toBe('发布上线')
    expect(suggestionFor({ items, busy: true, blockedSay: 'x' })).toBeUndefined()
    expect(suggestionFor({ items, busy: false, blockedSay: 'x', cardAction: '批准发布' })).toBe(
      '批准发布',
    )
    const said = buildItems(
      [...baseTimeline(), ev({ kind: 'human_message', at: D2, text: '好' })],
      {
        closed: false,
      },
    )
    expect(suggestionFor({ items: said, busy: false, blockedSay: 'x' })).toBeUndefined()
  })

  it('运行摘要：同一个文件读 / 改多次只算一个', () => {
    expect(
      digestFacts({
        seconds: 1,
        outcome: 'completed',
        steps: [
          { text: '改 a.json', status: 'ok' },
          { text: '改 a.json', status: 'ok' },
          { text: '读 b.json', status: 'ok' },
          { text: '改 c.json', status: 'error' },
        ],
      }),
    ).toEqual({ read: 1, changed: 1, checked: false, pushed: false })
  })
})
