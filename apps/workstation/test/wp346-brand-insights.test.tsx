/**
 * WP346（决策 872）：品牌档案第二版——档案卡与设置页的新格子、「AI 建议」标、逐格采纳。
 */
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it } from 'vitest'
import { BrandProfileCard } from '@/components/onboarding/brand-profile-card'
import { type ProfileDraft, ProfileForm } from '@/components/onboarding/profile-form'
import { compareRows } from '@/components/settings/brand-reanalyze'
import type { WorkspaceProfileView } from '@/lib/api'
import { renderWithProviders } from './helpers'

const URL = 'https://trailmark.example/'
const ai = <T,>(value: T) => ({
  value,
  confidence: 'low' as const,
  evidence: [{ url: URL, locator: 'model' }],
})

const PROFILE: BrandIntakeProfile = {
  brand_name: { value: 'Trailmark', confidence: 'high', evidence: [{ url: URL, locator: 'og' }] },
  category: ai('hiking backpacks'),
  positioning: ai('给带娃徒步的家长做的轻量背包。'),
  audience: ai({ buyers: '周末带孩子徒步的家长', concerns: ['背着累不累'] }),
  keywords: ai({ brand: ['Trailmark'], category: ['hiking daypack'], scenario: [] }),
  competitors: ai([{ name: 'Osprey', reason: '同价位' }]),
  products: {
    value: [
      {
        title: 'Summit 40',
        price_snapshot: '189.00',
        list_price_snapshot: '219.00',
        specs: [{ name: 'Capacity', value: '40 L' }],
        model_filled: ['specs'],
      },
    ],
    confidence: 'high',
    evidence: [{ url: URL, locator: 'jsonld:Product' }],
  },
}

describe('WP346 首次设置档案卡：新格子 + AI 建议', () => {
  it('人群 / 关键词 / 竞品画出来，挂「AI 建议」；改了就换成「已改」并回调整格的值', async () => {
    let latest: Record<string, unknown> = {}
    function Harness(): React.ReactNode {
      const [edits, setEdits] = useState<Record<string, unknown>>({})
      latest = edits
      return (
        <BrandProfileCard
          profile={PROFILE}
          edits={edits}
          onEdit={(field, value) => {
            setEdits((prev) => ({ ...prev, [field]: value }))
          }}
          onConfirm={() => {}}
          onReanalyze={() => {}}
        />
      )
    }
    renderWithProviders(<Harness />)
    expect(screen.getByTestId('insight-value-audience').textContent).toContain('周末带孩子徒步')
    expect(screen.getByTestId('insight-value-keywords').textContent).toContain('hiking daypack')
    // WP349：竞品一行一个——名字 + 一句理由
    expect(screen.getByTestId('insight-value-competitors').textContent).toBe('Osprey同价位')
    for (const f of ['audience', 'keywords', 'competitors', 'positioning'])
      expect(screen.getByTestId(`insight-ai-${f}`).textContent).toBe('AI 建议')
    // 品类（AI 填的）也挂
    expect(screen.getByTestId('insight-ai-category')).toBeTruthy()
    // 商品卡：原价划线、规格数（AI 补的挂标）
    expect(screen.getByTestId('intake-list-price').textContent).toContain('219')
    expect(screen.getByTestId('intake-specs').getAttribute('title')).toContain('Capacity：40 L')

    await userEvent.click(screen.getByTestId('insight-edit-audience'))
    await userEvent.type(screen.getByTestId('insight-input-audience-payer'), '家长自己')
    await userEvent.click(screen.getByTestId('insight-done-audience'))
    expect(latest.audience).toMatchObject({ buyers: '周末带孩子徒步的家长', payer: '家长自己' })
    // 改过：AI 标没了，换成「已改」
    expect(screen.queryByTestId('insight-ai-audience')).toBeNull()
    expect(screen.getByTestId('insight-edited-audience')).toBeTruthy()
  })

  it('没接模型：说一句为什么那几格空着', () => {
    renderWithProviders(
      <BrandProfileCard
        profile={{ brand_name: PROFILE.brand_name } as BrandIntakeProfile}
        edits={{}}
        insights="no_model"
        onEdit={() => {}}
        onConfirm={() => {}}
        onReanalyze={() => {}}
      />,
    )
    expect(screen.getByTestId('intake-insights-note').textContent).toContain('还没接模型')
    expect(screen.queryByTestId('insight-row-audience')).toBeNull()
  })
})

const VIEW: WorkspaceProfileView = {
  legal_name: 'Trailmark',
  brand_name: 'Trailmark',
  discoverable: false,
  vertical: 'goods',
  storefront_platform: 'shopify',
  category: 'hiking backpacks',
  positioning: '给带娃徒步的家长做的轻量背包。',
  audience: { buyers: '周末带孩子徒步的家长' },
  keywords: { brand: ['Trailmark'], category: ['hiking daypack'], scenario: [] },
  competitors: [{ name: 'Osprey', reason: '人写的' }],
  ai_suggested: ['category', 'positioning', 'audience', 'keywords'],
  website: URL,
  set_at: '2026-10-15T09:00:00.000Z',
}

describe('WP346 设置页品牌档案：逐格改、点「对」', () => {
  it('AI 建议的挂标；点 ✓ 记进 confirm_fields；改关键词随保存发上去', async () => {
    const saved: ProfileDraft[] = []
    renderWithProviders(
      <ProfileForm
        profile={VIEW}
        busy={false}
        saved={false}
        onSave={(d) => {
          saved.push(d)
        }}
      />,
    )
    expect(screen.getByTestId('insight-ai-positioning')).toBeTruthy()
    // 竞品是人写的：不挂
    expect(screen.queryByTestId('insight-ai-competitors')).toBeNull()
    // 空的格子在设置页也摆出来（能补）
    expect(within(screen.getByTestId('insight-row-price_band')).getByText('没填')).toBeTruthy()

    await userEvent.click(screen.getByTestId('insight-accept-audience'))
    expect(screen.queryByTestId('insight-ai-audience')).toBeNull()
    await userEvent.click(screen.getByTestId('insight-accept-category'))

    await userEvent.click(screen.getByTestId('insight-edit-keywords'))
    const scenario = screen.getByTestId('insight-input-keywords-scenario')
    await userEvent.type(scenario, 'hiking with kids，family trail')
    await userEvent.click(screen.getByTestId('insight-done-keywords'))
    expect(screen.queryByTestId('insight-ai-keywords')).toBeNull()

    await userEvent.click(screen.getByTestId('company-save'))
    expect(saved[0]?.confirm_fields).toEqual(['audience', 'category'])
    expect(saved[0]?.insights.keywords?.scenario).toEqual(['hiking with kids', 'family trail'])
  })
})

describe('WP346 重新分析一次：对比「现在 / 新的」', () => {
  it('一样的不列；空的 / AI 建议的默认勾上；人给的默认不勾', () => {
    const rows = compareRows(VIEW, {
      profile: {
        positioning: ai('新的定位。'),
        competitors: ai([{ name: 'Gregory', reason: '新' }]),
        keywords: ai(VIEW.keywords ?? { brand: [], category: [], scenario: [] }),
        price_band: ai('$119-$189'),
      },
    })
    expect(rows.map((r) => [r.field, r.pick, r.human])).toEqual([
      ['positioning', true, false],
      ['price_band', true, false],
      ['competitors', false, true],
    ])
  })
})
