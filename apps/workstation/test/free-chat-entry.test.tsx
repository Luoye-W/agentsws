/**
 * WP188 的几处入口与修正：
 * - ⌘K 里有「新对话」；「交给岗位去做」带着对话打开 ⌘K 时只列岗位，选一个就交过去；
 * - 设置 → 模型 →「加一个」里的「Agents 工坊（用积分）」**没有 key 输入框**：没关联时是「先关联账号」，
 *   卡名是「Agents 工坊（用积分）」，图标是我们的品牌标记（不是字母圆圈）。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProviderTemplate, PositionInstanceData, PositionSummary } from '@/lib/api'
import { renderWithProviders } from './helpers'

const opened: { id: string; input: Record<string, unknown> }[] = []

const CLOUD_TEMPLATE: ModelProviderTemplate = {
  kind: 'agentsws_cloud',
  label: 'Agents 工坊（用积分）',
  summary: '不填 key、不注册。关联一次 Agents 工坊账号就能用，按积分扣，随时切回自己的 key。',
  vendor: 'agentsws-cloud',
  vendor_label: 'Agents 工坊（用积分）',
  vendor_summary: '不填 key、不注册。',
  plan_label: '按积分',
  plan_order: 1,
  auth: 'cloud',
  default_base_url: 'https://cloud.agentsws.com/v1/ai',
  default_model: 'deepseek-flash',
  region: 'cn',
  steps: [],
  links: [],
}

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    listCatalog: async () => [],
    openMatterAtPosition: async (id: string, input: Record<string, unknown>) => {
      opened.push({ id, input })
      return { matter: { id: 'mat_1' }, ambiguous: false, reason: '' }
    },
    listModelProviders: async () => ({ providers: [], templates: [CLOUD_TEMPLATE] }),
    getModelDefaults: async () => ({
      default: '',
      by_purpose: {},
      budget: {},
      choices: [],
    }),
    getModelUsage: async () => ({
      since: '2026-09-29T00:00:00.000Z',
      rows: [],
      total: undefined,
      budget: { used_base: 0, cap_base: 0, frozen: false },
    }),
    getModelPricing: async () => ({ vendors: [] }),
    getModelImage: async () => ({ configured: false, official: false, choices: [] }),
    getCloudAccount: async () => ({ linked: false, cloud_base_url: 'https://cloud.agentsws.dev' }),
    getCloudCredits: async () => ({ linked: false, reason: '还没关联 Agents 工坊账号。' }),
    getDeepSeekAccount: async () => ({ state: 'signed_out' }),
  }
})

const { CommandPalette } = await import('@/components/command-palette')
const { ModelsPanel } = await import('@/components/models/models-panel')

const INSTANCES: PositionInstanceData[] = [
  {
    position_id: 'web-ops',
    workspace_id: 'ws_1',
    name: { zh: '网站运营', en: 'Web Operations' },
    template_version: '1.0.0',
    holders: ['per_li'],
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
  },
]
const SUMMARIES: PositionSummary[] = []

describe('WP188 ⌘K', () => {
  it('有「新对话」', async () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={SUMMARIES}
        instances={INSTANCES}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
      />,
    )
    expect((await screen.findByTestId('command-new-chat')).textContent).toBe('新对话')
  })

  it('带着对话打开：只列岗位，选一个就把这件事交过去', async () => {
    renderWithProviders(
      <CommandPalette
        open
        onOpenChange={() => {}}
        positions={SUMMARIES}
        instances={INSTANCES}
        cards={[]}
        tileLibrary={[]}
        onAddTile={() => {}}
        handoff={{ title: '帮我写一封退货邮件', summary: '从随便聊带过来的：…' }}
      />,
    )
    const rows = await screen.findAllByTestId('command-handoff')
    expect(rows.map((r) => r.textContent)).toEqual(['网站运营'])
    expect(screen.queryByTestId('command-new-chat')).toBeNull()
    await userEvent.click(rows[0] as HTMLElement)
    await waitFor(() => {
      expect(opened).toEqual([
        {
          id: 'asg_store',
          input: { title: '帮我写一封退货邮件', summary: '从随便聊带过来的：…' },
        },
      ])
    })
  })
})

describe('WP188 设置 → 模型 →「Agents 工坊（用积分）」', () => {
  it('卡上没有 key 输入框：没关联是「先关联账号」；名字与品牌标记', async () => {
    renderWithProviders(<ModelsPanel assignment="asg_owner" />)
    const card = (await screen.findAllByTestId('model-template')).find(
      (c) => c.dataset.kind === 'agentsws_cloud',
    )
    if (card === undefined) throw new Error('没有积分那张卡')
    expect(card.textContent).toContain('Agents 工坊（用积分）')
    expect(await within(card).findByTestId('model-cloud-link-account')).toBeDefined()
    // 没有通用的「填 API key」，也没有任何输入框
    expect(card.textContent).not.toContain('填 API key')
    expect(card.querySelector('input')).toBeNull()
    // 图标是品牌标记（一组方块），不是字母「A」圆圈
    expect(card.querySelector('[data-icon^="letter-"]')).toBeNull()
    expect(card.querySelector('svg rect')).not.toBeNull()
  })
})
