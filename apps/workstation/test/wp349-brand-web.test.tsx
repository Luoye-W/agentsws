/**
 * WP349（Luoye 10-15 改决策 881）：档案卡与设置页对比里的**来源**（联网搜到的网页，点开才列出）、
 * 联网那一步照实说（没联网 / 额度没查 / 没找到有来源的竞品）。
 */
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { BrandInsightFields } from '@/components/onboarding/brand-insight-fields'
import { BrandProfileCard, webNotes } from '@/components/onboarding/brand-profile-card'
import { compareRows } from '@/components/settings/brand-reanalyze'
import { renderWithProviders } from './helpers'

const URL = 'https://trailmark.example/'
const REVIEW = 'https://gearlab.example/trailmark-review'
const ai = <T,>(value: T, web: string[] = []) => ({
  value,
  confidence: 'low' as const,
  evidence: [
    { url: URL, locator: 'model' },
    ...web.map((url) => ({ url, locator: 'web', quote: 'Trailmark review' })),
  ],
})

const PROFILE: BrandIntakeProfile = {
  brand_name: { value: 'Trailmark', confidence: 'high', evidence: [{ url: URL, locator: 'og' }] },
  positioning: ai('给带娃徒步的家长做的轻量背包。', [REVIEW]),
  audience: ai({ buyers: '周末带孩子徒步的家长' }),
  competitors: ai(
    [
      {
        name: 'Osprey',
        reason: '同价位最常被拿来比',
        url: 'https://www.osprey.com/',
        sources: [
          { url: 'https://www.osprey.com/daypacks', title: 'Osprey daypacks' },
          { url: 'https://outdoorgear.example/alt' },
        ],
      },
      {
        name: 'Deuter',
        reason: '亲子背负系列',
        sources: [{ url: 'https://outdoorgear.example/alt', title: 'Trailmark alternatives' }],
      },
    ],
    ['https://www.osprey.com/daypacks'],
  ),
}

function card(over: Partial<React.ComponentProps<typeof BrandProfileCard>> = {}) {
  renderWithProviders(
    <BrandProfileCard
      profile={PROFILE}
      edits={{}}
      insights="done"
      onEdit={() => {}}
      onConfirm={() => {}}
      onReanalyze={() => {}}
      {...over}
    />,
  )
}

describe('WP349 档案卡：每格带来源，可点开', () => {
  it('竞品一行一个（名字 + 理由），来源收起时不铺链接，点开按竞品列出、新窗口打开', async () => {
    card({ web: { status: 'done', searches: 8, credits: 0 } })
    const value = screen.getByTestId('insight-value-competitors')
    expect(value.textContent).toContain('Osprey')
    expect(value.textContent).toContain('同价位最常被拿来比')
    expect(value.textContent).toContain('亲子背负系列')
    // 收起：卡上没有外链
    expect(screen.queryByTestId('insight-source-list-competitors')).toBeNull()
    const toggle = screen.getByTestId('insight-sources-competitors')
    expect(toggle.textContent).toBe('3')
    await userEvent.click(toggle)
    const list = screen.getByTestId('insight-source-list-competitors')
    const links = within(list).getAllByRole('link')
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://www.osprey.com/daypacks',
      'https://outdoorgear.example/alt',
      'https://outdoorgear.example/alt',
    ])
    expect(links[0]?.textContent).toBe('Osprey daypacks')
    // 没标题的画域名
    expect(links[1]?.textContent).toBe('outdoorgear.example')
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toContain('noopener')
    }
    expect(list.textContent).toContain('Deuter')
    // 定位：搜到的评测是来源；人群没有网页来源就不出那个小标
    await userEvent.click(screen.getByTestId('insight-sources-positioning'))
    expect(
      within(screen.getByTestId('insight-source-list-positioning')).getByRole('link'),
    ).toHaveProperty('href', REVIEW)
    expect(screen.queryByTestId('insight-sources-audience')).toBeNull()
    // 联网正常、有竞品：不多说一句
    expect(screen.queryByTestId('intake-web-note')).toBeNull()
  })

  it('人改过的格子不再挂网页来源（那是人的话了）', () => {
    card({ edits: { positioning: '我自己写的定位' } })
    expect(screen.queryByTestId('insight-sources-positioning')).toBeNull()
  })

  it('没联网：竞品空着，照实说「没联网，查不了竞品」（原因进问号）', () => {
    const { competitors: _c, ...rest } = PROFILE
    card({
      profile: rest,
      web: {
        status: 'off',
        reason: '没联网，查不了竞品：要先登录 DeepSeek 账号',
        searches: 0,
        credits: 0,
      },
    })
    const note = screen.getByTestId('intake-web-note')
    expect(note.textContent).toContain('没联网，查不了竞品')
    expect(screen.queryByTestId('insight-row-competitors')).toBeNull()
  })

  it('额度没查哪几部分照实说；搜了但没找到有来源的竞品也说一句', () => {
    expect(
      webNotes({ status: 'done', searches: 3, credits: 0.3, cut: ['verify', 'brand'] }, 2),
    ).toEqual([{ key: 'intake.web.cut.verify' }, { key: 'intake.web.cut.brand' }])
    expect(
      webNotes(
        { status: 'skipped', searches: 0, credits: 0, cut: ['competitors', 'verify', 'brand'] },
        0,
      ),
    ).toEqual([{ key: 'intake.web.cut.competitors' }, { key: 'intake.web.cut.brand' }])
    expect(webNotes({ status: 'done', searches: 8, credits: 0 }, 0)).toEqual([
      { key: 'intake.web.no_competitors' },
    ])
    expect(webNotes({ status: 'failed', searches: 5, credits: 0 }, 0)).toEqual([
      { key: 'intake.web.failed' },
    ])
    card({ web: { status: 'done', searches: 3, credits: 0.3, cut: ['brand'] } })
    expect(screen.getByTestId('intake-web-note').textContent).toContain('品牌评测没查')
  })

  it('设置页：档案里的竞品带着来源，同样点开', async () => {
    renderWithProviders(
      <BrandInsightFields
        values={{ competitors: PROFILE.competitors?.value ?? [] }}
        ai={['competitors']}
        onChange={() => {}}
      />,
    )
    await userEvent.click(screen.getByTestId('insight-sources-competitors'))
    expect(
      within(screen.getByTestId('insight-source-list-competitors')).getAllByRole('link'),
    ).toHaveLength(3)
  })
})

describe('WP349 设置页「重新分析一次」对比：新的一列带来源', () => {
  it('竞品按竞品列来源，定位挂搜到的评测', () => {
    const rows = compareRows({ legal_name: 'Trailmark' } as never, { profile: PROFILE })
    const comp = rows.find((r) => r.field === 'competitors')
    expect(comp?.sources.map((s) => s.about)).toEqual(['Osprey', 'Osprey', 'Deuter'])
    expect(rows.find((r) => r.field === 'positioning')?.sources[0]?.url).toBe(REVIEW)
    expect(rows.find((r) => r.field === 'audience')?.sources).toEqual([])
  })
})
