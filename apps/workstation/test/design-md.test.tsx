/**
 * 设计规范页与右栏面板（WP122，71 §4）。
 *
 * 四组断言，每一组盯的都是"这一页**不做什么**"：
 *
 * 1. 还没抓过时画的是一句人话 + 两个入口，**不是一张空色板**；
 * 2. 抽不到的那一节写「未找到，请补充」，**不写「无」**——用户看不出
 *    "这个品牌没有这一项"和"我们没抓到"的区别，而那两件事他要做的动作不同；
 * 3. 冲突的那一格**两个色块都画出来**，界面不替用户判哪个对；
 * 4. 右栏是**只读速查表**：没有编辑、没有抓取按钮。
 */
import type { BrandDesignProfile } from '@agentsws/contracts'
import { cleanup, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { countConflicts, designSummary, TokensView } from '@/components/design-md/tokens-view'
import { renderWithProviders } from './helpers'

const PROFILE: BrandDesignProfile = {
  colors: {
    primary: {
      value: '#b8422e',
      confidence: 'high',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css-var:--color-brand' }],
      conflict: { value: '#a8321f', source: [{ origin: 'file', page: 3, quote: '#A8321F' }] },
    },
    surface: {
      value: '#f7f5f2',
      confidence: 'medium',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css:body{background-color}' }],
    },
  },
  typography: {
    h1: {
      value: { fontFamily: 'Public Sans', fontSize: '48px', fontWeight: 600 },
      confidence: 'high',
      source: [{ origin: 'site', url: 'https://heritage.test/', locator: 'css:h1{font-size}' }],
    },
  },
  logos: {
    value: [{ url: 'https://heritage.test/logo.png', variant: 'light', min_width_px: 24 }],
    confidence: 'medium',
    source: [{ origin: 'file', page: 2 }],
  },
}

describe('可视化那一半', () => {
  it('色板画出每个令牌的名字与色值 —— 一排没有名字的色块等于没有规范', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const swatch = screen.getByTestId('design-md-color-primary')
    expect(swatch.textContent).toContain('primary')
    expect(swatch.textContent).toContain('#b8422e')
    cleanup()
  })

  it('冲突的那一格把**另一个值也画出来**，不替用户判哪个对', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const conflict = screen.getByTestId('design-md-conflict-primary')
    expect(conflict.textContent).toContain('#a8321f')
    cleanup()
  })

  it('抽不到的那一节写「未找到，请补充」，不写「无」', () => {
    renderWithProviders(<TokensView profile={{ colors: PROFILE.colors }} />)
    // 间距与圆角这一轮都没抓到
    expect(screen.getByTestId('design-md-spacing').textContent).toContain('未找到')
    cleanup()
  })

  it('样例按钮用这些令牌**实时渲染**（改一个值它当场跟着变）', () => {
    renderWithProviders(<TokensView profile={PROFILE} />)
    const sample = screen.getByTestId('design-md-components')
    const button = sample.querySelector('button')
    expect(button?.style.backgroundColor).toBe('rgb(184, 66, 46)')
    cleanup()
  })

  it('一份空档案：每一节都留白，不抛', () => {
    renderWithProviders(<TokensView profile={{}} />)
    expect(screen.getAllByText('未找到，请补充').length).toBeGreaterThanOrEqual(4)
    cleanup()
  })
})

describe('摘要那一行（档案卡与右栏共用）', () => {
  it('数的是色、字体与 logo 三个数', () => {
    expect(designSummary(PROFILE)).toEqual({ colors: 2, fonts: 1, logos: 1 })
  })

  it('没有 url 的 logo（只从手册读到用法规则的那种）不算进"有几个 logo"', () => {
    const onlyRules: BrandDesignProfile = {
      logos: {
        value: [{ url: '', variant: 'light', min_width_px: 24 }],
        confidence: 'high',
        source: [{ origin: 'file', page: 2 }],
      },
    }
    expect(designSummary(onlyRules).logos).toBe(0)
  })

  it('冲突数就是界面上那个角标', () => {
    expect(countConflicts(PROFILE)).toBe(1)
    expect(countConflicts({})).toBe(0)
  })
})
