/**
 * WP496（决策 1729 A）：ego 自己说有新版本时，设置里 ego 那一行与连接卡上 ego 那一行提一句「有新版本」，
 * 点过去是 ego 下载页；不替人升级（界面上没有「升级」按钮）。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ExtensionRows, extensionRowsOf } from '@/components/rail/cards/extension-rows'
import { EgoRecommend } from '@/components/settings/ego-recommend'
import { renderWithProviders } from './helpers'

describe('WP496 ego 有新版本', () => {
  it('设置：就绪那一行后面多「有新版本」→ 下载页', () => {
    renderWithProviders(
      <EgoRecommend
        status={{
          allowed: true,
          installed: true,
          version: '2.1.0',
          connected: true,
          update_available: true,
        }}
        onRecheck={() => {}}
      />,
    )
    const link = screen.getByTestId('ego-update')
    expect(link.textContent).toBe('有新版本')
    expect(link.getAttribute('href')).toBe('https://lite.ego.app/download')
    expect(link.getAttribute('title')).toContain('不会替你升级')
  })

  it('设置：没说有新版本就不出', () => {
    renderWithProviders(
      <EgoRecommend
        status={{ allowed: true, installed: true, version: '2.1.0', connected: true }}
        onRecheck={() => {}}
      />,
    )
    expect(screen.queryByTestId('ego-update')).toBeNull()
  })

  it('连接卡：ego 那一行带「有新版本」，不算要处理', () => {
    const rows = extensionRowsOf({
      needed: true,
      paired: false,
      steps: [],
      ego_covers: ['reddit', 'social', 'kol'],
      plugin_backup: true,
      ego_update: true,
    })
    expect(rows).toEqual([
      { key: 'ego', ok: true, update: true },
      { key: 'paired', ok: true, backup: true },
    ])
    renderWithProviders(<ExtensionRows rows={rows ?? []} />)
    const tag = screen.getByTestId('connection-ego-update')
    expect(tag.textContent).toBe('有新版本')
    expect(tag.getAttribute('href')).toBe('https://lite.ego.app/download')
    expect(document.querySelector('[data-todo="true"]')).toBeNull()
  })
})
