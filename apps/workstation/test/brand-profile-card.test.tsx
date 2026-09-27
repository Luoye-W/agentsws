/**
 * 分析完那一屏的品牌档案卡（WP121，70 §3.5）。
 *
 * 五组断言，每一组盯的都是"这张卡**不做什么**"：
 *
 * 1. 抓不到又没改过的格子**整行不出**——一行空格子比没有这一行更糟；
 * 2. 「请确认」**只挂在低把握的格子上**，高把握的一个标都不挂；
 * 3. 出处不铺在外面，在 tooltip 里（36 §7）；
 * 4. 改过的格子挂的是「已改」，不是「请确认」——那一格已经是他说了算的；
 * 5. 改动往上抛给父组件（受控），卡自己不攒状态。
 */
import type { BrandIntakeProfile } from '@agentsws/contracts'
import { cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { BrandProfileCard } from '@/components/onboarding/brand-profile-card'
import { renderWithProviders } from './helpers'

const PROFILE: BrandIntakeProfile = {
  brand_name: {
    value: 'Nordvik Supply',
    confidence: 'high',
    evidence: [{ url: 'https://nordvik.example/', locator: 'jsonld:Organization.name' }],
  },
  one_liner: {
    value: '耐用的日常随身装备',
    // 模型从正文里抽的 → 要用户看一眼
    confidence: 'low',
    evidence: [{ url: 'https://nordvik.example/pages/about', locator: 'model' }],
  },
  logo_url: {
    value: 'https://nordvik.example/logo.png',
    confidence: 'high',
    evidence: [{ url: 'https://nordvik.example/', locator: 'jsonld:Organization.logo' }],
  },
  primary_color: {
    value: '#1f3a5f',
    confidence: 'medium',
    evidence: [{ url: 'https://nordvik.example/', locator: 'meta:theme-color' }],
  },
  products: {
    value: [
      { title: 'Granite Wallet', price_snapshot: '€49', image_url: 'https://x.example/w.jpg' },
    ],
    confidence: 'high',
    evidence: [{ url: 'https://nordvik.example/', locator: 'jsonld:Product' }],
  },
  markets: {
    value: ['SE'],
    confidence: 'medium',
    evidence: [{ url: 'https://nordvik.example/', locator: 'og:locale' }],
  },
  policies: {
    value: [
      { kind: 'refund', summary: '60 天无理由退', url: 'https://nordvik.example/policies/refund' },
    ],
    confidence: 'medium',
    evidence: [{ url: 'https://nordvik.example/', locator: 'probe:/policies/*' }],
  },
}

function paint(overrides: Partial<React.ComponentProps<typeof BrandProfileCard>> = {}): {
  onEdit: ReturnType<typeof vi.fn>
  onConfirm: ReturnType<typeof vi.fn>
} {
  const onEdit = vi.fn()
  const onConfirm = vi.fn()
  renderWithProviders(
    <BrandProfileCard
      profile={PROFILE}
      edits={{}}
      onEdit={onEdit}
      onConfirm={onConfirm}
      onReanalyze={vi.fn()}
      {...overrides}
    />,
  )
  return { onEdit, onConfirm }
}

describe('WP121 品牌档案卡', () => {
  it('抓到的格子画出来；抓不到的那几行整行不出', () => {
    paint()
    expect(screen.getByTestId('intake-value-brand_name').textContent).toBe('Nordvik Supply')
    expect(screen.getByTestId('intake-value-one_liner').textContent).toBe('耐用的日常随身装备')
    // 这一轮没抓到客服邮箱与品类 —— 不画一行空格子出来
    expect(screen.queryByTestId('intake-row-support_email')).toBeNull()
    expect(screen.queryByTestId('intake-row-category')).toBeNull()
  })

  it('能画的不写字：logo、色块、商品缩略图、标签', () => {
    paint()
    expect(screen.getByTestId('intake-logo').getAttribute('src')).toBe(
      'https://nordvik.example/logo.png',
    )
    expect(screen.getByTestId('intake-color').getAttribute('title')).toBe('#1f3a5f')
    expect(screen.getByTestId('intake-products').textContent).toContain('Granite Wallet')
    expect(screen.getByTestId('intake-products').textContent).toContain('€49')
    // WP142：市场 `SE` 说人话 →「瑞典」
    expect(screen.getByTestId('intake-row-markets').textContent).toContain('瑞典')
    // 政策不逐条铺开，只说读到了几份
    expect(screen.getByTestId('intake-policies').textContent).toContain('1')
  })

  it('「请确认」只挂在低把握那一格上', () => {
    paint()
    expect(screen.getByTestId('intake-tag-one_liner').textContent).toBe('请确认')
    // 高把握的一个标都不挂：到处都挂等于哪儿都没挂
    expect(screen.queryByTestId('intake-tag-brand_name')).toBeNull()
  })

  it('出处在 tooltip 里，不铺在外面（36 §7）', () => {
    paint()
    const title = screen.getByTestId('intake-tag-one_liner').getAttribute('title') ?? ''
    expect(title).toContain('https://nordvik.example/pages/about')
    expect(title).toContain('model')
  })

  it('改过的格子挂「已改」而不是「请确认」', () => {
    paint({ edits: { one_liner: '我自己写的一句话' } })
    expect(screen.getByTestId('intake-tag-one_liner').textContent).toBe('已改')
    expect(screen.getByTestId('intake-value-one_liner').textContent).toBe('我自己写的一句话')
  })

  it('点铅笔改一格：往上抛给父组件，卡自己不攒状态', async () => {
    const user = userEvent.setup()
    const { onEdit } = paint()
    await user.click(screen.getByTestId('intake-edit-brand_name'))
    await user.type(screen.getByTestId('intake-input-brand_name'), '！')
    expect(onEdit).toHaveBeenCalledWith('brand_name', 'Nordvik Supply！')
  })

  it('「看着没问题」抛上去；两个按钮在忙的时候都点不动', async () => {
    const user = userEvent.setup()
    const { onConfirm } = paint()
    await user.click(screen.getByTestId('intake-confirm'))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    cleanup()
    paint({ busy: true })
    expect((screen.getByTestId('intake-confirm') as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByTestId('intake-reanalyze') as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('WP166 档案卡上的市场：可增删、出处进问号、推不出就请选', () => {
  it('去掉一个、加一个：往上抛国家码数组', async () => {
    const user = userEvent.setup()
    const { onEdit } = paint({
      profile: {
        ...PROFILE,
        markets: {
          value: ['US', 'CA'],
          confidence: 'medium',
          evidence: [
            { url: 'https://nordvik.example/policies/shipping-policy', locator: 'policy:shipping' },
            { url: 'https://nordvik.example/', locator: 'hreflang' },
          ],
        },
      },
    })
    const chips = screen.getAllByTestId('market-chip').map((c) => c.textContent)
    expect(chips).toEqual(['美国', '加拿大'])
    // 出处在问号里：「我们从官网的配送政策、语言版本看出来的」
    expect(screen.getByTestId('markets-origin').getAttribute('data-hint')).toBe(
      '我们从官网的配送政策、语言版本看出来的',
    )
    await user.click(screen.getByTestId('market-remove-CA'))
    expect(onEdit).toHaveBeenLastCalledWith('markets', ['US'])
    await user.selectOptions(screen.getByTestId('market-add'), 'GB')
    expect(onEdit).toHaveBeenLastCalledWith('markets', ['US', 'CA', 'GB'])
  })

  it('改过就用改过的那一份，问号说「你自己选的」；删光了明说请选一下', () => {
    paint({ edits: { markets: ['DE'] } })
    expect(screen.getAllByTestId('market-chip').map((c) => c.textContent)).toEqual(['德国'])
    expect(screen.getByTestId('markets-origin').getAttribute('data-hint')).toBe('你自己选的')
    cleanup()
    paint({ edits: { markets: [] } })
    expect(screen.getByTestId('markets-empty').textContent).toBe('没看出来，请选一下')
  })

  it('没推出来：这一行照样在，说「没看出来，请选一下」，没有问号', () => {
    const { markets: _m, ...rest } = PROFILE
    paint({ profile: rest })
    expect(screen.getByTestId('markets-empty').textContent).toBe('没看出来，请选一下')
    expect(screen.queryByTestId('markets-origin')).toBeNull()
  })
})
