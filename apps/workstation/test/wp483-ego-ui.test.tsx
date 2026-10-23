/**
 * WP483（决策 1658 / 1659）：「推荐装 ego」那一张的三种样子 + 按 Mac / Windows 给对的那一套步骤（问号里）；
 * 首次设置里能「先不装，用插件」。
 */
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EgoRecommend } from '@/components/settings/ego-recommend'
import { EGO_EN, EGO_ZH } from '@/lib/i18n-ego'
import { renderWithProviders } from './helpers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('WP483 推荐装 ego', () => {
  it('没装：一句为什么 + 去下载（官网下载页）+ 再看一次；首次设置里多一个「先不装，用插件」', async () => {
    const recheck = vi.fn()
    const later = vi.fn()
    renderWithProviders(
      <EgoRecommend
        status={{ allowed: true, installed: false }}
        onRecheck={recheck}
        onLater={later}
      />,
    )
    expect(screen.getByTestId('ego-download').getAttribute('href')).toBe(
      'https://lite.ego.app/download',
    )
    await userEvent.click(screen.getByTestId('ego-recheck'))
    expect(recheck).toHaveBeenCalled()
    await userEvent.click(screen.getByTestId('ego-later'))
    expect(later).toHaveBeenCalled()
  })

  it('Windows 上问号里写 Windows 那一套（拦了点「仍要运行」、别以管理员身份运行）', () => {
    vi.stubGlobal('navigator', {
      ...navigator,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    })
    renderWithProviders(
      <EgoRecommend status={{ allowed: true, installed: false }} onRecheck={() => {}} />,
    )
    expect(screen.getByTestId('ego-download').getAttribute('data-os')).toBe('windows')
    expect(screen.getByTestId('ego-recommend-hint').getAttribute('data-hint') ?? '').toContain(
      '仍要运行',
    )
  })

  it('服务不在这台电脑上（不允许）：整张不出', () => {
    const { container } = renderWithProviders(
      <EgoRecommend status={{ allowed: false, installed: false }} onRecheck={() => {}} />,
    )
    expect(container.querySelector('[data-testid^="ego-"]')).toBeNull()
  })

  it('就绪：一行「ego 已就绪 · 版本」，首次用要点掉「显示通知」写在问号里', () => {
    renderWithProviders(
      <EgoRecommend
        status={{ allowed: true, installed: true, version: '2.1.0', connected: true }}
        onRecheck={() => {}}
      />,
    )
    expect(screen.getByTestId('ego-ready').textContent).toContain('2.1.0')
    expect(screen.getByTestId('ego-ready-hint').getAttribute('data-hint') ?? '').toContain('阻止')
  })

  it('中英两份词条一一对应', () => {
    expect(Object.keys(EGO_EN).sort()).toEqual(Object.keys(EGO_ZH).sort())
  })
})
