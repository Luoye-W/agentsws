/**
 * WP153（09-26 真账号冒烟 §1）：Agent 回话里的 markdown 安全地画出来。
 *
 * 只认粗体、列表、编号、行内代码、链接；不认 HTML、不加载图片；链接只认站内路径与 http(s)，
 * 站外的新窗口打开并带 `rel="noopener noreferrer"`。
 */
import { screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ReplyMarkdown } from '@/components/ui/reply-markdown'
import { renderWithProviders } from './helpers'

describe('ReplyMarkdown', () => {
  it('粗体、列表、编号、行内代码画出来；记号不原样露', () => {
    const { container } = renderWithProviders(
      <ReplyMarkdown
        text={
          '这个工作区有 **3 个岗位**。\n\n- **客服**：有人在岗\n- 红人营销：没人\n\n1. 连 GA4\n2. 看 `退货窗口`'
        }
      />,
    )
    expect(container.querySelectorAll('strong')).toHaveLength(2)
    expect(container.querySelector('strong')?.textContent).toBe('3 个岗位')
    expect(container.querySelectorAll('ul > li')).toHaveLength(2)
    expect(container.querySelectorAll('ol > li')).toHaveLength(2)
    expect(container.querySelector('code')?.textContent).toBe('退货窗口')
    const text = container.textContent ?? ''
    expect(text).not.toContain('**')
    expect(text).not.toContain('`')
  })

  it('原始 HTML 一律当字：不出 script / img / 任何标签', () => {
    const { container } = renderWithProviders(
      <ReplyMarkdown
        text={'<script>alert(1)</script> <img src="https://evil.example/x.png"> **好**'}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
  })

  it('图片外链不加载，只留说明文字', () => {
    const { container } = renderWithProviders(
      <ReplyMarkdown text={'看图：![店铺首页截图](https://evil.example/a.png)'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('看图：店铺首页截图')
  })

  it('链接：站内用路由；http(s) 新窗口 + noopener；javascript: / // 当字', () => {
    const { container } = renderWithProviders(
      <ReplyMarkdown
        text={
          '[去连接页](/settings/connections) [官方说明](https://help.example/a) [坏的](javascript:alert(1)) [也坏](//evil.example)'
        }
      />,
    )
    const inner = screen.getByTestId('linked-text-link')
    expect(inner.getAttribute('href')).toBe('/settings/connections')
    const outer = screen.getByTestId('reply-external-link')
    expect(outer.getAttribute('href')).toBe('https://help.example/a')
    expect(outer.getAttribute('target')).toBe('_blank')
    expect(outer.getAttribute('rel')).toContain('noopener')
    expect(container.querySelectorAll('a')).toHaveLength(2)
    expect(container.textContent).toContain('[也坏](//evil.example)')
    expect(container.textContent).toContain('[坏的](javascript:alert(1)')
  })
})
