/**
 * WP142（docs/78 §1 #5）：Agent 回话里的站内链接画成可点的；站外的一律不认。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LinkedText } from '@/components/ui/linked-text'
import { renderWithProviders } from './helpers'

describe('WP142 回话里的站内链接', () => {
  it('`[字](/路径)` → 可点的站内链接；其余文字原样', () => {
    renderWithProviders(
      <p data-testid="t">
        <LinkedText
          text={
            '在 YouTube 上找了一遍，找到 2 个：\n- Gadget Jonas（4.8 万粉）\n[去候选池看全部](/positions/asg_1?tab=view&kol=pool)\n想要更多人：[关联官方数据接口](/settings/credits) · [导入一张表](/positions/asg_1?tab=view&kol=campaign)'
          }
        />
      </p>,
    )
    const links = screen.getAllByTestId('linked-text-link')
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['去候选池看全部', '/positions/asg_1?tab=view&kol=pool'],
      ['关联官方数据接口', '/settings/credits'],
      ['导入一张表', '/positions/asg_1?tab=view&kol=campaign'],
    ])
    const text = screen.getByTestId('t').textContent ?? ''
    expect(text).toContain('- Gadget Jonas（4.8 万粉）')
    expect(text).not.toContain('](')
  })

  it('站外链接、`//` 开头的一律不画成链接（回话是模型写的）', () => {
    renderWithProviders(
      <p data-testid="t">
        <LinkedText text="[点这里](https://evil.example/x) 或 [这里](//evil.example) 或 [方括号]" />
      </p>,
    )
    expect(screen.queryAllByTestId('linked-text-link')).toHaveLength(0)
    expect(screen.getByTestId('t').textContent).toContain('[点这里](https://evil.example/x)')
  })
})
