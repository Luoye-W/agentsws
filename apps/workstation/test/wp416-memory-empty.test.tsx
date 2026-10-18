/**
 * WP416（自查 kol U12）：岗位设置 · 记忆——全空时只说一行，不再六段各说两遍、出六个没用的按钮。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const getLayerMemory = vi.fn(async () => ({ summary: '岗位层还没攒下东西', entries: [] }))
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return { ...actual, getLayerMemory: (...a: unknown[]) => getLayerMemory(...(a as [])) }
})

const { MemoryLayers } = await import('@/components/position/position-settings')

describe('WP416 记忆全空', () => {
  it('岗位层 + 五条职责都空：只一行「还没有记忆」，没有「提到这一层」按钮', async () => {
    renderWithProviders(
      <MemoryLayers
        positionId="pos_kol"
        name="红人营销"
        roles={['youtube', 'instagram', 'tiktok', 'facebook', 'x'].map((c) => ({
          role_id: `kol.${c}`,
          role_name: c,
        }))}
      />,
    )
    expect((await screen.findByTestId('memory-none')).textContent).toContain('还没有记忆')
    expect(screen.queryAllByTestId('promote-to-layer')).toHaveLength(0)
    expect(document.body.textContent).not.toContain('还没攒下东西')
  })
})
