/**
 * WP156（36 §7 第三档）：**教程文章**——打包、渲染、右栏面板、卡片上的「看教程」。
 *
 * 四组：
 * 1. 每一篇都打包进来了（中英各一份），中英标题都从文章里读得出；
 * 2. 渲染（WP157 起合进 `safe-markdown.test.tsx`，与时间线同一份）；
 * 3. 卡片上点「看教程」→ 右栏「教程」面板打开那一篇；图标轨打开是目录；
 * 4. 没有右栏时（单张卡的单测）退回对话框，点了照样看得到。
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandPalette } from '@/components/command-palette'
import { TutorialLink } from '@/components/help/tutorial-link'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider } from '@/components/rail/rail-state'
import { resetPanelRegistry } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import {
  BUNDLED_HELP_SLUGS,
  bundledHelpFiles,
  HELP_BY_VENDOR,
  helpForContext,
  helpSlugOf,
  helpTitle,
  loadHelpArticle,
} from '@/lib/help'
import { openRailPanel, renderWithProviders } from './helpers'

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  listCatalog: async () => [],
  listOrganizations: async () => [],
}))

describe('打包', () => {
  it('每一篇中英各一份都在包里，中英标题都读得出（取自文章的一级标题）', () => {
    const files = bundledHelpFiles()
    for (const slug of BUNDLED_HELP_SLUGS) {
      expect(files).toContain(`${slug}.md`)
      expect(files).toContain(`${slug}.en.md`)
      expect(helpTitle(slug, 'zh')).not.toBe(slug)
      expect(helpTitle(slug, 'en')).not.toBe(helpTitle(slug, 'zh'))
    }
  })

  it('厂商 → 教程的对照表只指向写了的那几篇', () => {
    for (const slug of Object.values(HELP_BY_VENDOR)) expect(BUNDLED_HELP_SLUGS).toContain(slug)
  })

  it('按语言取；每篇都以一个一级标题开头、带编号步骤', async () => {
    for (const slug of BUNDLED_HELP_SLUGS) {
      const zh = await loadHelpArticle(slug, 'zh')
      const en = await loadHelpArticle(slug, 'en')
      expect(zh?.startsWith('# ')).toBe(true)
      expect(en?.startsWith('# ')).toBe(true)
      expect(zh).not.toBe(en)
      expect(zh).toMatch(/^1\. /m)
      expect(en).toMatch(/^1\. /m)
    }
  })

  it('地址认得出 slug（官网新加、随包里没有的也认，面板打开时去取）；写法不对的回 undefined', () => {
    expect(helpSlugOf('agentsws://help/browser')).toBe('browser')
    expect(helpSlugOf('agentsws://help/brand-new')).toBe('brand-new')
    expect(helpSlugOf('agentsws://help/Bad_Slug')).toBeUndefined()
    expect(helpSlugOf('agentsws://file/browser')).toBeUndefined()
    expect(helpSlugOf(undefined)).toBeUndefined()
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
    // Luoye 10-23：书本图标，名字在 aria-label / 悬停提示里
    expect(link.textContent).toBe('')
    expect(link.getAttribute('aria-label')).toBe('看教程')
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
    // WP208：目录跟着上下文走——这里没有岗位，列的是通用那几篇（别的在「全部 N 篇」与搜索里）
    expect(items.map((i) => i.getAttribute('data-slug'))).toEqual(helpForContext({}).general)
    fireEvent.click(
      items.find((i) => i.getAttribute('data-slug') === 'computer-use') as HTMLElement,
    )
    await waitFor(() => {
      expect(screen.getByTestId('help-panel').getAttribute('data-slug')).toBe('computer-use')
    })
  })

  it('右上角「⋮」→「教程」打开的是目录', async () => {
    renderWithProviders(
      <RailStateProvider>
        <RightRail />
      </RailStateProvider>,
    )
    // WP372：「教程」在右上角「⋮」里
    await openRailPanel('help')
    // WP208：不在岗位上 → 只列通用；「全部 N 篇」一下全摊开
    expect(await screen.findAllByTestId('help-index-item')).toHaveLength(
      helpForContext({}).general.length,
    )
    fireEvent.click(screen.getByTestId('help-show-all'))
    expect(screen.getAllByTestId('help-index-item')).toHaveLength(BUNDLED_HELP_SLUGS.length)
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
    expect(screen.getByTestId('tutorial-link').getAttribute('aria-label')).toBe('Tutorial')
    fireEvent.click(screen.getByTestId('tutorial-link'))
    const dialog = await screen.findByRole('dialog')
    expect((await within(dialog).findByTestId('help-article')).textContent).toContain(
      'Let AI operate this computer',
    )
  })
})

describe('⌘K 里搜教程（WP157）', () => {
  beforeEach(() => {
    resetPanelRegistry()
    ensureBuiltinPanels()
  })

  it('每篇教程一行；搜「百炼」只剩那一篇，回车在右栏打开', async () => {
    let open = true
    renderWithProviders(
      <RailStateProvider>
        <CommandPalette
          open
          onOpenChange={(next) => {
            open = next
          }}
          positions={[]}
          cards={[]}
          tileLibrary={[]}
          onAddTile={() => {}}
        />
        <RightRail />
      </RailStateProvider>,
    )
    const rows = await screen.findAllByTestId('command-help')
    expect(rows.map((r) => r.getAttribute('data-slug'))).toEqual([...BUNDLED_HELP_SLUGS])
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '百炼' } })
    await waitFor(() => {
      expect(screen.getAllByTestId('command-help').map((r) => r.getAttribute('data-slug'))).toEqual(
        ['model-bailian'],
      )
    })
    fireEvent.click(screen.getByTestId('command-help'))
    expect(open).toBe(false)
    const panel = await screen.findByTestId('help-panel')
    expect(panel.getAttribute('data-slug')).toBe('model-bailian')
  })
})
