/**
 * WP159：知识库里「违规宣称规则」那一块——按市场分组、每条有出处、能关能改能加、组开关能拨。
 */
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { ClaimRulesData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const view: ClaimRulesData = {
  markets: ['US'],
  markets_from: 'brand_profile',
  groups: [
    { id: 'global', label: '通用', enabled: true, why: 'always' },
    { id: 'us', label: '美国（FTC）', enabled: true, why: 'market' },
    { id: 'eu_uk', label: '欧盟 / 英国', enabled: false, why: 'market' },
  ],
  rules: [
    {
      id: 'abs_zh_best',
      pattern: '最好',
      category: 'absolute',
      reason: '广告里不能用「最好 / 第一 / 顶级」这类绝对化用语。',
      market: 'global',
      source_title: '中华人民共和国广告法',
      source_url: 'https://www.gov.cn/guoqing/2021-10/29/content_5647620.htm',
      enabled: true,
      origin: 'builtin',
    },
    {
      id: 'us.made_in_usa',
      pattern: 'made in usa',
      category: 'origin',
      reason: '写「Made in USA」要几乎全部在美国生产。',
      market: 'us',
      source_title: 'FTC：Made in USA 标准',
      source_url: 'https://www.ftc.gov/business-guidance/resources/complying-made-usa-standard',
      enabled: true,
      origin: 'builtin',
    },
  ],
}
const getClaimRules = vi.fn(async () => view)
const setClaimRules = vi.fn(async (_input: unknown) => view)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getClaimRules: () => getClaimRules(),
    setClaimRules: (input: never) => setClaimRules(input),
  }
})

const { ClaimRulesSection } = await import('@/components/knowledge/claim-rules')

describe('违规宣称规则（按市场分组）', () => {
  it('按组画、每条带官方出处链接；目标市场写在顶上', async () => {
    renderWithProviders(<ClaimRulesSection />)
    expect((await screen.findByTestId('claim-markets')).textContent).toContain('US')
    const us = screen.getByTestId('claim-group-us')
    const link = within(us).getByRole('link')
    expect(link.getAttribute('href')).toContain('ftc.gov')
    expect(screen.getByTestId('claim-group-eu_uk').className).toContain('opacity-60')
  })

  it('关一条 / 开一组：各发一次 PATCH', async () => {
    renderWithProviders(<ClaimRulesSection />)
    const row = await screen.findByTestId('claim-rule-us.made_in_usa')
    await userEvent.click(within(row).getByRole('switch'))
    await waitFor(() =>
      expect(setClaimRules).toHaveBeenCalledWith({
        rule: { id: 'us.made_in_usa', enabled: false },
      }),
    )
    const eu = screen.getByTestId('claim-group-eu_uk')
    await userEvent.click(within(eu).getAllByRole('switch')[0] as HTMLElement)
    await waitFor(() =>
      expect(setClaimRules).toHaveBeenCalledWith({ group: { id: 'eu_uk', enabled: true } }),
    )
  })

  it('改理由：点小铅笔 → 改字 → 保存', async () => {
    renderWithProviders(<ClaimRulesSection />)
    const row = await screen.findByTestId('claim-rule-abs_zh_best')
    await userEvent.click(within(row).getByRole('button', { name: '改' }))
    const inputs = within(row).getAllByRole('textbox')
    await userEvent.clear(inputs[1] as HTMLElement)
    await userEvent.type(inputs[1] as HTMLElement, '入门款别写最好')
    await userEvent.click(within(row).getByRole('button', { name: '保存' }))
    await waitFor(() =>
      expect(setClaimRules).toHaveBeenCalledWith({
        rule: { id: 'abs_zh_best', pattern: '最好', reason: '入门款别写最好' },
      }),
    )
  })

  it('WP157 减字守卫：卡面说明不超上限（规则的理由在表里算数据）', async () => {
    const { reportCard, CARD_TEXT_LIMIT } = await import('./less-text-guard')
    renderWithProviders(<ClaimRulesSection />)
    await screen.findByTestId('claim-markets')
    const report = reportCard(screen.getByTestId('knowledge-claim-rules'))
    expect(report.weight, report.text).toBeLessThanOrEqual(CARD_TEXT_LIMIT)
  })
})
