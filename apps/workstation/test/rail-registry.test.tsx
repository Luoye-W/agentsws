/**
 * WP95（36 §11 C 档，`docs/upstream/sidebar-compare.md` #2 / #3 / #4 / #5 / #6）：
 * **面板注册表 + 布局只存结构 + 启动不激活 + 官方形状的薄适配**。
 *
 * 这一组钉的不是某个面板长什么样，是那四条机制：
 *
 * 1. **两段式注册**：类型与身体分开，各回一个 disposer；同一个 id 注册两次直接抛；
 * 2. **谁来开某个资源**：`priority` 三档 → pattern 长度 → 注册顺序，`canOpen` 一票否决；
 * 3. **布局只存结构**：本机那一份里只有 `{ open_panel_id, width }`，按作用域分桶，
 *    **一个字的面板内容都没有**；
 * 4. **启动不激活**：没打开的面板不挂载、不发请求；刷新只恢复"开哪个"。
 *
 * 外加一条纪律（#4）：内置面板与第三方面板走**同一条**公开路——所以最后一组
 * 用一个假的"官方形状"面板过一遍适配层，它拿到的能力与内置的一模一样。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { Brain, Gauge, Globe } from 'lucide-react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PositionInstanceData } from '@/lib/api'
import { renderWithProviders } from './helpers'

const INSTANCE: PositionInstanceData = {
  position_id: 'web-ops',
  workspace_id: 'ws_1',
  name: { zh: '网站运营', en: 'Web Operations' },
  template_version: '1.1.0',
  holders: ['p_li'],
  roles: [
    {
      role_id: 'dtc.store',
      role_name: '店铺管理',
      default: true,
      assignment_ids: ['asg_store'],
      my_assignment_id: 'asg_store',
    },
  ],
  open_matters: 0,
  pending_cards: 0,
  memory_summary: '岗位层：0 段',
}

/** 记忆面板真打的那条接口——"没打开就不发请求"靠它数。 */
const getLayerMemory = vi.fn(async () => ({
  tier: 'position' as const,
  scope_id: 'web-ops',
  summary: '岗位层：1 段',
  can_edit: false,
  entries: [
    {
      id: 'm:pos:web-ops:x:sec_1',
      skill: 'customer-care',
      section_id: 'sec_1',
      heading: '改价',
      body: '这一句是**面板内容**，它一个字都不该落到本机那一份布局里。',
      origin: 'authored' as const,
      source: 'manual',
      added_by: 'per_li',
      added_at: '2026-09-18T01:00:00.000Z',
    },
  ],
}))
const getPosition = vi.fn(async () => INSTANCE)

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api')
  return {
    ...actual,
    getPosition: (...a: unknown[]) => getPosition(...(a as [])),
    getLayerMemory: (...a: unknown[]) => getLayerMemory(...(a as [])),
  }
})

const registry = await import('@/components/rail/registry')
const { adaptOfficialTab, officialSlotOf, toRailAddress } = await import(
  '@/components/rail/official-adapter'
)
const { railLayoutBucket } = await import('@/components/rail/rail-layout')
const { RightRail } = await import('@/components/rail/right-rail')
const { RailStateProvider } = await import('@/components/rail/rail-state')
const { ensureBuiltinPanels } = await import('@/components/rail/builtin-panels')
const { RIGHT_RAIL_LAYOUT_KEY } = await import('@/lib/ui-state')

function renderRail(route = '/', position = 'asg_store'): void {
  renderWithProviders(
    <RailStateProvider>
      <RightRail instances={[INSTANCE]} />
    </RailStateProvider>,
    route,
    position,
  )
}

/**
 * jsdom 这一档里 `globalThis.localStorage` 是个空对象（不是真的 Storage），
 * 所以这一组自己装一个看得见内部的替身——本来就要数"它里面多了什么"
 * （与 `local-cache.test.ts` 同一个做法）。
 */
function fakeStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, String(v))
    },
    removeItem: (k: string) => {
      map.delete(k)
    },
    clear: () => {
      map.clear()
    },
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeStorage())
  getLayerMemory.mockClear()
  getPosition.mockClear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('两段式注册（#2）', () => {
  beforeEach(() => {
    registry.resetPanelRegistry()
  })

  it('类型与身体分开注册，各回一个 disposer；注销之后注册表里就没有它了', () => {
    const Body = (): ReactNode => <p>身体</p>
    const disposeType = registry.registerPanelType({
      id: 'demo',
      label: 'rail.panel.data',
      icon: Brain,
      priority: 'extension',
    })
    expect(registry.panelType('demo')?.priority).toBe('extension')
    // 只注册了类型：图标轨上有它，但还没有身体（占位面板就是这一档）
    expect(registry.panelBody('demo')).toBeUndefined()

    const disposeBody = registry.registerPanelBody('demo', Body)
    expect(registry.panelBody('demo')).toBe(Body)

    disposeBody()
    expect(registry.panelBody('demo')).toBeUndefined()
    disposeType()
    expect(registry.panelType('demo')).toBeUndefined()
  })

  it('同一个 id 注册两次直接抛（两个实现抢一个身份，排出谁来都是错的）', () => {
    registry.registerPanelType({ id: 'dup', label: 'x', icon: Brain, priority: 'builtin' })
    expect(() =>
      registry.registerPanelType({ id: 'dup', label: 'y', icon: Gauge, priority: 'extension' }),
    ).toThrow(/dup/)
    const Body = (): ReactNode => null
    registry.registerPanelBody('dup', Body)
    expect(() => registry.registerPanelBody('dup', Body)).toThrow(/dup/)
  })

  it('图标轨按组排（这件事的 → 这一层的 → 工具），组内按注册顺序', () => {
    registry.registerPanelType({
      id: 'tool-a',
      label: 'x',
      icon: Globe,
      priority: 'builtin',
      group: 'tools',
    })
    registry.registerPanelType({
      id: 'ctx-a',
      label: 'x',
      icon: Brain,
      priority: 'builtin',
      group: 'context',
    })
    registry.registerPanelType({
      id: 'ctx-b',
      label: 'x',
      icon: Brain,
      priority: 'builtin',
      group: 'context',
    })
    expect(registry.listPanelTypes().map((p) => p.id)).toEqual(['ctx-a', 'ctx-b', 'tool-a'])
    expect(registry.panelGroups().map((g) => g.group)).toEqual(['context', 'tools'])
  })
})

describe('谁来开某个资源：priority → pattern 长度 → 注册顺序，canOpen 一票否决（#3）', () => {
  beforeEach(() => {
    registry.resetPanelRegistry()
  })

  const add = (
    id: string,
    priority: 'extension' | 'builtin' | 'fallback',
    matches: string[],
    canOpen?: (s: { address?: string }) => boolean,
  ): void => {
    registry.registerPanelType({
      id,
      label: 'x',
      icon: Brain,
      priority,
      matches,
      ...(canOpen === undefined ? {} : { canOpen }),
    })
  }

  it('extension 压过 builtin，builtin 压过 fallback', () => {
    add('f', 'fallback', ['agentsws://matter/**'])
    add('b', 'builtin', ['agentsws://matter/**'])
    add('e', 'extension', ['agentsws://matter/**'])
    expect(registry.resolvePanel({ address: 'agentsws://matter/mat_1' })?.id).toBe('e')
  })

  it('同一档里 pattern 长的赢（长的更具体）', () => {
    add('wide', 'builtin', ['agentsws://**'])
    add('narrow', 'builtin', ['agentsws://change/**'])
    expect(registry.resolvePanel({ address: 'agentsws://change/chg_1' })?.id).toBe('narrow')
  })

  it('长度也一样就按注册顺序（先注册的赢）', () => {
    add('first', 'builtin', ['agentsws://matter/**'])
    add('second', 'builtin', ['agentsws://matter/**'])
    expect(registry.resolvePanel({ address: 'agentsws://matter/mat_1' })?.id).toBe('first')
  })

  it('canOpen 说不行就轮到第二名', () => {
    add('picky', 'extension', ['agentsws://matter/**'], (s) => s.address?.endsWith('_ok') === true)
    add('plain', 'builtin', ['agentsws://matter/**'])
    expect(registry.resolvePanel({ address: 'agentsws://matter/mat_ok' })?.id).toBe('picky')
    expect(registry.resolvePanel({ address: 'agentsws://matter/mat_no' })?.id).toBe('plain')
  })

  it('没有 matches 的是"页"：不参与这场竞争；没有地址时谁都不开', () => {
    registry.registerPanelType({ id: 'page', label: 'x', icon: Brain, priority: 'extension' })
    expect(registry.resolvePanel({ address: 'agentsws://matter/mat_1' })).toBeUndefined()
    expect(registry.resolvePanel({})).toBeUndefined()
  })

  it('`*` 不跨斜杠，`**` 跨', () => {
    expect(registry.matchesAddress('agentsws://matter/*', 'agentsws://matter/mat_1')).toBe(true)
    expect(registry.matchesAddress('agentsws://matter/*', 'agentsws://matter/a/b')).toBe(false)
    expect(registry.matchesAddress('agentsws://matter/**', 'agentsws://matter/a/b')).toBe(true)
  })
})

describe('内置四个面板走的就是那条公开路（#4）', () => {
  beforeEach(() => {
    registry.resetPanelRegistry()
    ensureBuiltinPanels()
  })

  it('记忆 / 技能 / 知识 / 额度都在注册表里，没有第二条内部通道', () => {
    for (const id of ['memory', 'skills', 'knowledge', 'caps']) {
      const def = registry.panelType(id)
      expect(def?.priority).toBe('builtin')
      expect(def?.scoped).toBe(true)
      expect(registry.panelBody(id)).toBeDefined()
    }
  })

  it('WP140：四个还没做的占位面板内测期间藏起来（注册表里没有，图标轨上也没有）', () => {
    // WP100 给「证据」补了身体，于是还占着位的只剩这四个
    for (const id of ['data', 'runs', 'schedules', 'files']) {
      expect(registry.panelType(id)).toBeUndefined()
      expect(registry.panelBody(id)).toBeUndefined()
    }
  })

  it('WP140：开关一拨就放出来——有类型、没身体，点开照实说"还没做"', async () => {
    registry.resetPanelRegistry()
    ensureBuiltinPanels({ showUnbuilt: true })
    for (const id of ['data', 'runs', 'schedules', 'files']) {
      expect(registry.panelType(id)).toBeDefined()
      expect(registry.panelBody(id)).toBeUndefined()
    }
    renderRail()
    fireEvent.click(screen.getByTestId('rail-icon-data'))
    expect(await screen.findByTestId('rail-placeholder')).toBeDefined()
  })

  it('WP100：「证据」也走同一条公开路——有类型也有身体', () => {
    expect(registry.panelType('evidence')?.priority).toBe('builtin')
    expect(registry.panelBody('evidence')).toBeDefined()
  })

  it('WP95 新加的两个（变更审阅 / 运行中的浏览器）也在同一张表里', () => {
    expect(registry.panelType('changes')?.matches).toContain('agentsws://matter/**')
    expect(registry.panelBody('changes')).toBeDefined()
    expect(registry.panelBody('browser')).toBeDefined()
  })
})

describe('布局只存结构、按作用域分桶（#5）', () => {
  it('桶按岗位 / 事项 / 职责算', () => {
    expect(railLayoutBucket('/matters/mat_1', 'asg_store')).toBe('matter:mat_1')
    expect(railLayoutBucket('/positions/asg_store/duties/dtc.store', 'asg_store')).toBe(
      'role:dtc.store',
    )
    expect(railLayoutBucket('/positions/asg_store', 'asg_store')).toBe('position:asg_store')
    expect(railLayoutBucket('/', 'asg_store')).toBe('position:asg_store')
    // 还没进过任何岗位：不往一个猜出来的桶里写
    expect(railLayoutBucket('/', null)).toBe('default')
  })

  it('本机那一份里只有 open_panel_id 与 width，面板内容一个字都没有', async () => {
    renderRail()
    fireEvent.click(screen.getByTestId('rail-icon-memory'))
    // 等面板真把内容取回来（这时候本机那一份是最容易被写脏的）
    expect(await screen.findByTestId('rail-panel-memory')).toBeDefined()
    await waitFor(() => {
      expect(getLayerMemory).toHaveBeenCalled()
    })

    const raw = globalThis.localStorage.getItem(RIGHT_RAIL_LAYOUT_KEY) ?? '{}'
    const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>
    expect(Object.keys(parsed)).toEqual(['position:asg_store'])
    // **只有这两格**：多一格就要回答"它是结构还是内容"
    expect(Object.keys(parsed['position:asg_store'] ?? {}).sort()).toEqual([
      'open_panel_id',
      'width',
    ])
    expect(parsed['position:asg_store']?.open_panel_id).toBe('memory')
    // 面板正文、条目 id、岗位名一个都没进来
    expect(raw).not.toContain('面板内容')
    expect(raw).not.toContain('sec_1')
    expect(raw).not.toContain('网站运营')
  })

  it('换一个作用域就是换一份布局：事项页开的那个不会跑到岗位页上', async () => {
    renderRail('/matters/mat_1', 'asg_store')
    fireEvent.click(screen.getByTestId('rail-icon-memory'))
    await screen.findByTestId('rail-panel-memory')
    const parsed = JSON.parse(
      globalThis.localStorage.getItem(RIGHT_RAIL_LAYOUT_KEY) ?? '{}',
    ) as Record<string, { open_panel_id: string | null }>
    expect(parsed['matter:mat_1']?.open_panel_id).toBe('memory')
    expect(parsed['position:asg_store']).toBeUndefined()
  })

  it('存坏了当没存过：不去渲染一个注册表里没有的面板，也不抛', () => {
    globalThis.localStorage.setItem(RIGHT_RAIL_LAYOUT_KEY, '{ 这不是 JSON')
    renderRail()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
    globalThis.localStorage.setItem(
      RIGHT_RAIL_LAYOUT_KEY,
      JSON.stringify({ 'position:asg_store': { open_panel_id: '被卸了的应用包', width: 9999 } }),
    )
    renderRail()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })
})

describe('启动不激活（#6）', () => {
  it('恢复出"开着记忆"才去取记忆；开着别的面板时记忆一条请求都不发', async () => {
    // ① 上次关掉的时候开着的是额度
    globalThis.localStorage.setItem(
      RIGHT_RAIL_LAYOUT_KEY,
      JSON.stringify({ 'position:asg_store': { open_panel_id: 'caps', width: 400 } }),
    )
    renderRail()
    // 布局恢复了（面板框在，宽度也是记下来那个）
    const frame = await screen.findByTestId('rail-panel-frame')
    expect(frame.getAttribute('data-panel')).toBe('caps')
    expect(frame.getAttribute('style')).toContain('400px')
    // 而记忆面板**没有**被挂起来，所以它那条接口一次都没打
    expect(getLayerMemory).not.toHaveBeenCalled()
  })

  // WP97 把第十三个（Office 预览）加进了工具那一组
  // WP113（63 §8）：加了「邮件助手」那一格，于是从十三个变成十四个
  // WP120（69 §4）：中组多了「角色」→ 十五个
  // WP122（71）：又加了「设计规范」那一格（`layer` 组），于是十六个
  // WP140：内测期间藏起四个还没做的占位面板（数据 / 运行中 / 定时任务 / 文件），于是十二个
  it('一个都没开的时候：十二个图标都在，但没有任何面板发请求', () => {
    renderRail()
    expect(screen.getAllByTestId(/^rail-icon-/)).toHaveLength(12)
    expect(screen.queryByTestId('rail-icon-data')).toBeNull()
    expect(getLayerMemory).not.toHaveBeenCalled()
    expect(screen.queryByTestId('rail-panel-frame')).toBeNull()
  })
})

describe('官方形状的薄适配（C 档第三件）', () => {
  beforeEach(() => {
    registry.resetPanelRegistry()
  })

  /** 一个**假的官方形状**面板：字段照抄上游 README，不引任何 `dsh-client-*`。 */
  const officialDefinition = {
    id: '@example/sidebar-notes',
    kind: 'notes',
    title: () => '便签',
    priority: 'extension' as const,
    patterns: ['dsh-resource://file/**', 'dsh-resource://file/*.md'],
    canOpen: (address: string) => !address.endsWith('.secret'),
  }

  it('slot 名与 key 照官方那句 `slots.register({ name, key }, Body)`', () => {
    expect(officialSlotOf(officialDefinition)).toEqual({
      name: 'sidebar.right.pane.tab',
      key: '@example/sidebar-notes',
    })
  })

  it('地址前缀换掉，别的一个字不动', () => {
    expect(toRailAddress('dsh-resource://file/a.md')).toBe('agentsws://file/a.md')
    expect(toRailAddress('agentsws://matter/mat_1')).toBe('agentsws://matter/mat_1')
  })

  it('挂进注册表之后，它与内置面板拿到的是同一套能力', () => {
    const Body = ({ sessionId }: { sessionId?: string }): ReactNode => (
      <p data-testid="official-body">{sessionId}</p>
    )
    const dispose = adaptOfficialTab(officialDefinition, Body, { icon: Globe, group: 'tools' })

    const def = registry.panelType('@example/sidebar-notes')
    expect(def?.label).toBe('便签')
    expect(def?.priority).toBe('extension')
    // patterns 换成了我们的地址空间
    expect(def?.matches).toEqual(['agentsws://file/**', 'agentsws://file/*.md'])
    // 排序与 canOpen 都跟内置的走同一条路
    expect(registry.resolvePanel({ address: 'agentsws://file/a.md' })?.id).toBe(
      '@example/sidebar-notes',
    )
    expect(registry.resolvePanel({ address: 'agentsws://file/a.secret' })).toBeUndefined()

    dispose()
    expect(registry.panelType('@example/sidebar-notes')).toBeUndefined()
    expect(registry.panelBody('@example/sidebar-notes')).toBeUndefined()
  })

  it('作用域走标准 props 的 sessionId（spike ③：那一格是不透明的，我们填岗位 id）', async () => {
    const Body = ({ sessionId }: { sessionId?: string }): ReactNode => (
      <p data-testid="official-body">{sessionId}</p>
    )
    ensureBuiltinPanels()
    adaptOfficialTab(
      { ...officialDefinition, title: () => '便签' },
      Body,
      // `scoped` 才拿得到 scope，所以这里显式给一个跟层走的第三方面板
      { icon: Globe, group: 'tools' },
    )
    // 第三方面板也要能跟层走：注册表里补一格（官方那一侧靠 `sessionId` 这一格表达）
    const def = registry.panelType('@example/sidebar-notes')
    if (def !== undefined) def.scoped = true

    renderRail()
    fireEvent.click(screen.getByTestId('rail-icon-@example/sidebar-notes'))
    const body = await screen.findByTestId('official-body')
    expect(body.textContent).toBe('web-ops')
  })
})
