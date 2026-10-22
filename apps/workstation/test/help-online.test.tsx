/**
 * 教程上官网（私有 docs/113 §4.3–4.4）：右栏「教程」读本机服务的目录与正文——
 * 官网新加的一篇不用发版就出现；新版才有的标「新版」；版本对不上时顶上一行；本机服务没回来用随包的。
 */
import type { HelpArticleView, HelpCatalogView } from '@agentsws/contracts'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider } from '@/components/rail/rail-state'
import { resetPanelRegistry } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import { bundledHelpCatalog } from '@/lib/help'
import { openRailPanel, renderWithProviders } from './helpers'

const api = vi.hoisted(() => ({
  catalog: vi.fn<(lang: string) => Promise<HelpCatalogView>>(),
  article: vi.fn<(slug: string, lang: string) => Promise<HelpArticleView>>(),
}))

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  listCatalog: async () => [],
  listOrganizations: async () => [],
  getHelpCatalog: api.catalog,
  getHelpArticle: api.article,
}))

const ONLINE_ONLY = {
  kind: 'guide' as const,
  slug: 'brand-new',
  lang: 'zh' as const,
  title: '官网刚写的一篇',
  description: '不用发版就看得到',
  url: 'https://agentsws.com/docs/brand-new/',
  positions: [],
  roles: [],
  group: 'start' as const,
  order: 1,
  requires: '0.2.1-beta.9',
  source: 'online' as const,
  needs_newer_app: true,
}

beforeEach(() => {
  resetPanelRegistry()
  ensureBuiltinPanels()
  api.catalog.mockResolvedValue({
    lang: 'zh',
    app_version: '0.2.1-beta.8',
    items: [ONLINE_ONLY, ...bundledHelpCatalog('zh')],
  })
})

async function openHelp(): Promise<void> {
  renderWithProviders(
    <RailStateProvider>
      <RightRail />
    </RailStateProvider>,
  )
  await openRailPanel('help')
}

describe('右栏「教程」读本机服务', () => {
  it('官网新加的一篇出现在目录里，新版才有的标「新版」；点开顶上一行版本提示 + 在官网打开', async () => {
    api.article.mockResolvedValue({
      ...ONLINE_ONLY,
      markdown: '# 官网刚写的一篇\n\n正文\n',
      newer_online: false,
    })
    await openHelp()
    const item = await screen.findByText('官网刚写的一篇')
    const row = item.closest('[data-testid="help-index-item"]') as HTMLElement
    expect(within(row).getByTestId('help-new-tag').textContent).toBe('新版')
    fireEvent.click(row)
    const note = await screen.findByTestId('help-version-note')
    expect(note.textContent).toBe('0.2.1-beta.9 起才有，你这版还没有')
    expect(screen.getByTestId('help-on-site')).toBeDefined()
    expect((await screen.findByTestId('help-article')).textContent).toContain('正文')
    expect(api.article).toHaveBeenCalledWith('brand-new', 'zh')
  })

  it('给的是随包那份、官网讲的是新版：顶上一句「新版里这部分变了」', async () => {
    api.article.mockResolvedValue({
      ...bundledHelpCatalog('zh')[0],
      kind: 'guide',
      slug: 'agentsws-credits',
      lang: 'zh',
      title: '积分',
      description: '',
      positions: [],
      roles: [],
      source: 'bundled',
      needs_newer_app: false,
      newer_online: true,
      markdown: '# 积分\n\n这版的说法\n',
    })
    await openHelp()
    const rows = await screen.findAllByTestId('help-index-item')
    fireEvent.click(rows.find((r) => r.dataset.slug === 'agentsws-credits') as HTMLElement)
    expect((await screen.findByTestId('help-version-note')).textContent).toContain(
      '新版里这部分变了',
    )
  })

  it('本机服务没回来：目录与正文都用随包的', async () => {
    api.catalog.mockRejectedValue(new Error('down'))
    api.article.mockRejectedValue(new Error('down'))
    await openHelp()
    const rows = await screen.findAllByTestId('help-index-item')
    expect(rows.map((r) => r.dataset.slug)).not.toContain('brand-new')
    fireEvent.click(rows.find((r) => r.dataset.slug === 'computer-use') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByTestId('help-article').textContent).toContain('Cua Driver')
    })
    expect(screen.queryByTestId('help-version-note')).toBeNull()
  })
})
