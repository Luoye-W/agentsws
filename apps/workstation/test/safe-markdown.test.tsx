/**
 * WP157：唯一的安全 markdown 渲染（`SafeMarkdown`）——时间线的 Agent 回话（WP153）与
 * 右栏教程文章（WP156）原来各有一份测试，这里合成一份。两种排法都跑同一批安全断言。
 *
 * 认：粗体、列表、编号、行内代码、标题、表格、提示框、链接（http(s) / 站内 / 教程互链）。
 * 不认：HTML（一律当字）、图片（只留说明文字）、`javascript:` / `//` / 不存在的教程（当字）。
 */
import { fireEvent, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HelpArticle } from '@/components/help/help-article'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider } from '@/components/rail/rail-state'
import { resetPanelRegistry } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import { ReplyMarkdown } from '@/components/ui/reply-markdown'
import { linkKind, parseMarkdown, SafeMarkdown } from '@/components/ui/safe-markdown'
import { renderWithProviders } from './helpers'

describe('认块', () => {
  it('标题 / 编号步骤 / 列表 / 表格 / 提示框各认各的；编号从写的那个数接着数', () => {
    const blocks = parseMarkdown(
      '# 题\n\n一段\n接着\n\n1. 甲\n2. 乙\n   - 小点\n3. 丙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 注意\n> 第二行',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'ol', 'ul', 'ol', 'table', 'quote'])
    expect(blocks[1]).toEqual({ kind: 'p', lines: ['一段', '接着'] })
    expect(blocks[4]).toEqual({ kind: 'ol', start: 3, items: ['丙'] })
    expect(blocks[5]).toEqual({
      kind: 'table',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
    expect(blocks[6]).toEqual({ kind: 'quote', lines: ['注意', '第二行'] })
  })

  it('链接地址只认三种', () => {
    expect(linkKind('https://x.example')).toBe('external')
    expect(linkKind('http://x.example/a')).toBe('external')
    expect(linkKind('help:browser')).toBe('help')
    expect(linkKind('help:nope')).toBeUndefined()
    expect(linkKind('/settings')).toBe('internal')
    expect(linkKind('//evil.example')).toBeUndefined()
    expect(linkKind('javascript:alert(1)')).toBeUndefined()
    expect(linkKind('data:text/html,x')).toBeUndefined()
  })
})

describe.each(['reply', 'article'] as const)('两种排法同一套纪律：%s', (variant) => {
  it('粗体（两种写法）、列表、编号、行内代码画出来；记号不原样露', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown
        variant={variant}
        text={
          '这个工作区有 **3 个岗位**。\n\n- __客服__：有人在岗\n- 红人营销：没人\n\n1. 连 GA4\n2. 看 `退货窗口`'
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
    expect(text).not.toContain('__')
    expect(text).not.toContain('`')
  })

  it('原始 HTML 一律当字：不出 script / img / 任何标签', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown
        variant={variant}
        text={'<script>alert(1)</script> <img src=x onerror=alert(1)> **好**'}
      />,
    )
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<script>alert(1)</script>')
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('图片外链不加载，只留说明文字', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown variant={variant} text={'看图：![店铺首页截图](https://evil.example/a.png)'} />,
    )
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('看图：店铺首页截图')
  })

  it('链接：站内用路由；http(s) 新窗口 + noopener；javascript: / // / 不存在的教程当字', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown
        variant={variant}
        text={
          '[去连接页](/settings/connections) [官方说明](https://help.example/a) [坏的](javascript:alert(1)) [也坏](//evil.example) [没这篇](help:nope)'
        }
      />,
    )
    expect(screen.getByTestId('linked-text-link').getAttribute('href')).toBe(
      '/settings/connections',
    )
    const outer = screen.getByTestId('reply-external-link')
    expect(outer.getAttribute('href')).toBe('https://help.example/a')
    expect(outer.getAttribute('target')).toBe('_blank')
    expect(outer.getAttribute('rel')).toContain('noopener')
    expect(container.querySelectorAll('a')).toHaveLength(2)
    expect(container.querySelector('button')).toBeNull()
    expect(container.textContent).toContain('[也坏](//evil.example)')
    expect(container.textContent).toContain('[坏的](javascript:alert(1)')
    expect(container.textContent).toContain('[没这篇](help:nope)')
  })

  it('表格与提示框', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown
        variant={variant}
        text={'| 方案 | 价钱 |\n|---|---|\n| 甲 | **1** |\n\n> 小心'}
      />,
    )
    expect(container.querySelectorAll('th')).toHaveLength(2)
    expect(container.querySelector('td strong')?.textContent).toBe('1')
    expect(container.querySelector('[data-slot="callout"]')?.textContent).toBe('小心')
  })
})

describe('两处都用它', () => {
  it('时间线（ReplyMarkdown）：标题画成粗体一行、段内换行照留', () => {
    const { container } = renderWithProviders(<ReplyMarkdown text={'# 小结\n第一行\n第二行'} />)
    expect(screen.getByTestId('reply-markdown').getAttribute('data-variant')).toBe('reply')
    expect(container.querySelector('h3, h4')).toBeNull()
    expect(container.querySelector('p.font-semibold')?.textContent).toBe('小结')
    expect(container.textContent).toContain('第一行\n第二行')
  })

  it('教程（HelpArticle）：标题分级、软换行拼成一段', () => {
    const { container } = renderWithProviders(<HelpArticle markdown={'# 题\n\n## 小节\n一\n二'} />)
    expect(screen.getByTestId('help-article').getAttribute('data-variant')).toBe('article')
    expect(container.querySelector('h3')?.textContent).toBe('题')
    expect(container.querySelector('h4')?.textContent).toBe('小节')
    expect(container.textContent).toContain('一 二')
  })

  it('教程互链：点了在右栏换成那一篇', async () => {
    resetPanelRegistry()
    ensureBuiltinPanels()
    renderWithProviders(
      <RailStateProvider>
        <SafeMarkdown variant="article" text={'先看 [浏览器](help:browser)。'} />
        <RightRail />
      </RailStateProvider>,
    )
    fireEvent.click(screen.getByTestId('help-cross-link'))
    const panel = await screen.findByTestId('help-panel')
    expect(panel.getAttribute('data-slug')).toBe('browser')
    expect(within(panel).getByTestId('help-back')).toBeTruthy()
  })
})
