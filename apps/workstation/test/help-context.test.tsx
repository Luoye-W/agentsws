/**
 * WP208（Luoye 09-30）：**右栏「教程」跟着上下文走**。
 *
 * 「点到某个岗位下的第三栏，就显示这个岗位相关的教程；点了职责，就是这个职责下相关的教程。」
 *
 * 钉住的几条：
 *
 * 1. 哪篇归谁的**真源是文章自己的 frontmatter**（`docs/help/<slug>.md` 的 `positions` / `roles`），
 *    `lib/help.ts` 的 `HELP_SCOPES` 是镜像——两份一个字都不许对不上；写到的岗位 / 职责都真有；
 * 2. 排法：职责上 = 这条职责的 → 所属岗位的 → 通用；岗位上 = 岗位的 → 通用；哪儿都不在 = 通用；
 * 3. 面板里照这个排；搜索仍然搜全部；「全部 N 篇」一下全摊开；
 * 4. frontmatter 不上页面（工作台正文、官网文档页都拿掉）。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureBuiltinPanels } from '@/components/rail/builtin-panels'
import { RailStateProvider } from '@/components/rail/rail-state'
import { resetPanelRegistry } from '@/components/rail/registry'
import { RightRail } from '@/components/rail/right-rail'
import type { PositionInstanceData } from '@/lib/api'
import {
  HELP_SCOPES,
  HELP_SLUGS,
  helpForContext,
  loadHelpArticle,
  splitHelpFrontmatter,
} from '@/lib/help'
import { renderWithProviders } from './helpers'

vi.mock('@/lib/api', async () => ({
  ...(await vi.importActual<typeof import('@/lib/api')>('@/lib/api')),
  getMySchedules: async () => [],
}))

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..')

/** 包里的岗位 id 与每个岗位下的职责 id（按字面从 yml 里读，不引 roles 包）。 */
function bundledPositions(): Map<string, Set<string>> {
  const dir = join(ROOT, 'packages/roles/positions')
  const out = new Map<string, Set<string>>()
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.yml'))) {
    const text = readFileSync(join(dir, f), 'utf8')
    const id = /^id:\s*(\S+)/m.exec(text)?.[1]
    if (id === undefined) continue
    out.set(id, new Set([...text.matchAll(/\brole:\s*([a-z0-9._-]+)/g)].map((m) => m[1] ?? '')))
  }
  return out
}

describe('哪篇归谁：frontmatter 是真源，HELP_SCOPES 是镜像', () => {
  it('每一篇中文的开头都写了 positions / roles，而且与 HELP_SCOPES 逐字相同', () => {
    for (const slug of HELP_SLUGS) {
      const raw = readFileSync(join(ROOT, 'docs/help', `${slug}.md`), 'utf8')
      expect(raw.startsWith('---\n'), `${slug}.md 开头没有 frontmatter`).toBe(true)
      const { meta } = splitHelpFrontmatter(raw)
      expect(meta, `${slug}.md 的 frontmatter 与 HELP_SCOPES 对不上`).toEqual(HELP_SCOPES[slug])
    }
  })

  it('写到的岗位都在包里；写到的职责都挂在某个岗位下', () => {
    const positions = bundledPositions()
    const roles = new Set([...positions.values()].flatMap((s) => [...s]))
    for (const slug of HELP_SLUGS) {
      for (const p of HELP_SCOPES[slug].positions)
        expect(positions.has(p), `${slug}：没有岗位 ${p}`).toBe(true)
      for (const r of HELP_SCOPES[slug].roles)
        expect(roles.has(r), `${slug}：没有职责 ${r}`).toBe(true)
    }
  })

  it('frontmatter 不上页面：取出来的正文从一级标题开始', async () => {
    const zh = await loadHelpArticle('chat-window', 'zh')
    expect(zh?.startsWith('# ')).toBe(true)
    expect(zh).not.toContain('positions:')
  })
})

describe('排法', () => {
  it('职责上：这条职责的 → 所属岗位的 → 通用；一篇只出现一次', () => {
    const g = helpForContext({ role_id: 'dtc.live-chat', position_id: 'customer-care' })
    expect(g.role).toEqual(['chat-window'])
    expect(g.position).toEqual(['conn-shopify', 'conn-email', 'conn-marketing-logistics'])
    expect(g.general).toContain('agentsws-credits')
    expect(g.general).not.toContain('chat-window')
    const all = [...g.role, ...g.position, ...g.general]
    expect(new Set(all).size).toBe(all.length)
  })

  it('岗位上：这个岗位的 + 通用；别的岗位的不在这里', () => {
    const g = helpForContext({ position_id: 'b2b' })
    expect(g.role).toEqual([])
    expect(g.position).toEqual(['conn-email', 'b2b-sending-domain'])
    expect([...g.position, ...g.general]).not.toContain('conn-linkedin')
  })

  it('哪儿都不在：只有通用（两个字段都空的那几篇）', () => {
    const g = helpForContext({})
    expect(g.role).toEqual([])
    expect(g.position).toEqual([])
    for (const slug of g.general) {
      expect(HELP_SCOPES[slug].positions).toEqual([])
      expect(HELP_SCOPES[slug].roles).toEqual([])
    }
  })
})

const CARE: PositionInstanceData = {
  position_id: 'customer-care',
  workspace_id: 'ws_1',
  name: { zh: '客服', en: 'Customer Care' },
  template_version: '1.0.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.live-chat',
      role_name: '在线聊天',
      default: true,
      assignment_ids: ['asg_chat'],
      my_assignment_id: 'asg_chat',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '',
}

describe('右栏「教程」面板按上下文排', () => {
  beforeEach(() => {
    resetPanelRegistry()
    ensureBuiltinPanels()
  })

  function openHelp(route: string): void {
    renderWithProviders(
      <RailStateProvider>
        <RightRail instances={[CARE]} />
      </RailStateProvider>,
      route,
      'asg_chat',
    )
    fireEvent.click(screen.getByTestId('rail-icon-help'))
  }

  it('在职责页：三组依次是这条职责的、这个岗位的、通用', async () => {
    openHelp('/positions/asg_chat/duties/dtc.live-chat')
    await screen.findByTestId('help-panel')
    const groups = screen.getAllByTestId('help-index-group')
    expect(groups.map((g) => g.dataset.group)).toEqual(['role', 'position', 'general'])
    expect(
      within(groups[0] as HTMLElement)
        .getAllByTestId('help-index-item')
        .map((i) => i.dataset.slug),
    ).toEqual(['chat-window'])
    expect((groups[0] as HTMLElement).textContent).toContain('这条职责的')
  })

  it('在岗位页：岗位的 + 通用', async () => {
    openHelp('/positions/asg_chat')
    await screen.findByTestId('help-panel')
    expect(screen.getAllByTestId('help-index-group').map((g) => g.dataset.group)).toEqual([
      'position',
      'general',
    ])
  })

  it('搜索搜全部（别的岗位的也搜得到）；「全部 N 篇」一下全摊开', async () => {
    openHelp('/positions/asg_chat')
    await screen.findByTestId('help-panel')
    expect(screen.queryByText('LinkedIn：公司主页与老板本人号')).toBeNull()
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: 'linkedin' } })
    const hits = within(screen.getByTestId('help-search-hits')).getAllByTestId('help-index-item')
    expect(hits.map((i) => i.dataset.slug)).toEqual(['conn-linkedin'])
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: '没有这一篇' } })
    expect(screen.getByTestId('help-search-empty')).toBeDefined()
    fireEvent.change(screen.getByTestId('help-search'), { target: { value: '' } })
    fireEvent.click(screen.getByTestId('help-show-all'))
    expect(screen.getAllByTestId('help-index-item')).toHaveLength(HELP_SLUGS.length)
  })
})
