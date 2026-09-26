/**
 * WP156（36 §7 第三档）：**教程文章**——打包、渲染、右栏面板、卡片上的「看教程」。
 *
 * 四组：
 * 1. 每一篇都打包进来了（中英各一份），标题都有词条；
 * 2. 渲染只认那几种写法，**不插 HTML**，`javascript:` 之类的地址不做成链接；
 * 3. 卡片上点「看教程」→ 右栏「教程」面板打开那一篇；图标轨打开是目录；
 * 4. 没有右栏时（单张卡的单测）退回对话框，点了照样看得到。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { HelpArticle, linkKind, parseHelpBlocks } from '@/components/help/help-article'
import { TutorialLink } from '@/components/help/tutorial-link'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider } from '@/components/rail/rail-state'
import { resetPanelRegistry } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import {
  bundledHelpFiles,
  HELP_BY_VENDOR,
  HELP_SLUGS,
  helpSlugOf,
  loadHelpArticle,
} from '@/lib/help'
import { translate } from '@/lib/i18n'
import { renderWithProviders } from './helpers'

describe('打包', () => {
  it('每一篇中英各一份都在包里，标题两种语言都有词条', () => {
    const files = bundledHelpFiles()
    for (const slug of HELP_SLUGS) {
      expect(files).toContain(`${slug}.md`)
      expect(files).toContain(`${slug}.en.md`)
      expect(translate('zh', `help.${slug}.title`)).not.toBe(`help.${slug}.title`)
      expect(translate('en', `help.${slug}.title`)).not.toBe(translate('zh', `help.${slug}.title`))
    }
  })

  it('厂商 → 教程的对照表只指向写了的那几篇', () => {
    for (const slug of Object.values(HELP_BY_VENDOR)) expect(HELP_SLUGS).toContain(slug)
  })

  it('按语言取；每篇都以一个一级标题开头、带编号步骤（占位那篇除外）', async () => {
    for (const slug of HELP_SLUGS) {
      const zh = await loadHelpArticle(slug, 'zh')
      const en = await loadHelpArticle(slug, 'en')
      expect(zh?.startsWith('# ')).toBe(true)
      expect(en?.startsWith('# ')).toBe(true)
      expect(zh).not.toBe(en)
      if (slug !== 'search-data') expect(zh).toMatch(/^1\. /m)
    }
  })

  it('地址认得出 slug；认不得的回 undefined', () => {
    expect(helpSlugOf('agentsws://help/browser')).toBe('browser')
    expect(helpSlugOf('agentsws://help/nope')).toBeUndefined()
    expect(helpSlugOf('agentsws://file/browser')).toBeUndefined()
    expect(helpSlugOf(undefined)).toBeUndefined()
  })
})

describe('渲染', () => {
  it('标题 / 编号步骤 / 列表 / 表格 / 提示框各认各的；编号跨段接着数', () => {
    const blocks = parseHelpBlocks(
      '# 题\n\n一段\n接着\n\n1. 甲\n2. 乙\n   - 小点\n3. 丙\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> 注意',
    )
    expect(blocks.map((b) => b.kind)).toEqual(['h', 'p', 'ol', 'ul', 'ol', 'table', 'quote'])
    expect(blocks[1]).toEqual({ kind: 'p', text: '一段 接着' })
    expect(blocks[4]).toEqual({ kind: 'ol', start: 3, items: ['丙'] })
    expect(blocks[5]).toEqual({
      kind: 'table',
      rows: [
        ['a', 'b'],
        ['1', '2'],
      ],
    })
  })

  it('只有 http(s) / help: / 站内地址做成链接；javascript: 当文字；尖括号不变成标签', () => {
    expect(linkKind('https://x.example')).toBe('external')
    expect(linkKind('help:browser')).toBe('help')
    expect(linkKind('help:nope')).toBeUndefined()
    expect(linkKind('/settings')).toBe('internal')
    expect(linkKind('//evil.example')).toBeUndefined()
    expect(linkKind('javascript:alert(1)')).toBeUndefined()
    const { container } = renderWithProviders(
      <HelpArticle
        markdown={
          '看 [官网](https://x.example) 与 [坏的](javascript:alert(1))，<img src=x onerror=alert(1)> **粗** `码`'
        }
      />,
    )
    const links = container.querySelectorAll('a')
    expect(links).toHaveLength(1)
    expect(links[0]?.getAttribute('href')).toBe('https://x.example')
    expect(links[0]?.getAttribute('rel')).toContain('noopener')
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.querySelector('strong')?.textContent).toBe('粗')
    expect(container.querySelector('code')?.textContent).toBe('码')
  })
})

describe('右栏「教程」面板', () => {
  beforeEach(() => {
    resetPanelRegistry()
    ensureBuiltinPanels()
  })

  it('卡片上点「看教程」→ 右栏打开那一篇；「全部教程」回目录，目录里点一篇换过去', async () => {
    renderWithProviders(
      <RailStateProvider>
        <TutorialLink slug="browser" />
        <RightRail />
      </RailStateProvider>,
      '/settings',
    )
    const link = screen.getByTestId('tutorial-link')
    expect(link.textContent).toBe('看教程')
    fireEvent.click(link)
    const panel = await screen.findByTestId('help-panel')
    expect(panel.getAttribute('data-slug')).toBe('browser')
    const article = await within(panel).findByTestId('help-article')
    expect(article.textContent).toContain('让 AI 用浏览器')
    // 外链都在文章里（从卡片上挪过来的那两个商店地址）
    expect(
      [...article.querySelectorAll('a')].map((a) => a.getAttribute('href')).join(' '),
    ).toContain('chromewebstore.google.com')

    fireEvent.click(within(panel).getByTestId('help-back'))
    const items = await screen.findAllByTestId('help-index-item')
    expect(items.map((i) => i.getAttribute('data-slug'))).toEqual([...HELP_SLUGS])
    fireEvent.click(
      items.find((i) => i.getAttribute('data-slug') === 'computer-use') as HTMLElement,
    )
    await waitFor(() => {
      expect(screen.getByTestId('help-panel').getAttribute('data-slug')).toBe('computer-use')
    })
  })

  it('图标轨上点「教程」打开的是目录', async () => {
    renderWithProviders(
      <RailStateProvider>
        <RightRail />
      </RailStateProvider>,
    )
    fireEvent.click(screen.getByTestId('rail-icon-help'))
    expect(await screen.findAllByTestId('help-index-item')).toHaveLength(HELP_SLUGS.length)
  })
})

describe('没有右栏时', () => {
  it('点「看教程」退回对话框，同一篇照样看得到', async () => {
    renderWithProviders(<TutorialLink slug="computer-use" />)
    fireEvent.click(screen.getByTestId('tutorial-link'))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('让 AI 操作这台电脑', { selector: 'h2' })).toBeTruthy()
    expect((await within(dialog).findByTestId('help-article')).textContent).toContain('Cua Driver')
  })

  it('英文界面取英文那一份', async () => {
    const { AppProvider } = await import('@/lib/app-context')
    const { QueryClient, QueryClientProvider } = await import('@tanstack/react-query')
    const { MemoryRouter } = await import('react-router-dom')
    render(
      <QueryClientProvider client={new QueryClient()}>
        <AppProvider initialTheme="light" initialLang="en" initialPosition="asg_1">
          <MemoryRouter>
            <TutorialLink slug="computer-use" />
          </MemoryRouter>
        </AppProvider>
      </QueryClientProvider>,
    )
    expect(screen.getByTestId('tutorial-link').textContent).toBe('Tutorial')
    fireEvent.click(screen.getByTestId('tutorial-link'))
    const dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByTestId('help-article')).textContent).toContain(
      'Let AI operate this computer',
    )
  })
})
