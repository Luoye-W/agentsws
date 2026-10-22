/**
 * WP456-T2（WP456 §2.6，决策 1446 / 847）：工作台共用件一套。
 *
 * 钉的是规则，不是像素（像素在截图里看）：
 * - 每个件的结构、可达性（真按钮 / 链接、`aria-pressed` / `role=tab`、读屏的名字）和老测试靠的 data-*；
 * - 少字守卫靠的 `data-slot`（状态 = status、徽章 = badge、标题 = title）；
 * - 样子只在 `index.css` 的 `.ws-*` 里，而且数字都落在档位上（字号 22/16/14/13/12/11、圆角 6/8/12/16/全圆）；
 * - 分段切换全站一种：设置里那个老入口就是共用的这一个；
 * - genui 插件画的卡接到同一组档位（`genui-view.css`）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { Inbox } from 'lucide-react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import {
  CategoryTag,
  CompareBlock,
  CountBadge,
  countText,
  DecisionCard,
  DecisionCardBody,
  DecisionCardFoot,
  DecisionCardHead,
  EmptyState,
  GroupLabel,
  ListGroup,
  ListRow,
  NoticeLine,
  OptionGroup,
  PageHeader,
  SectionHeader,
  Segmented,
  SkeletonList,
  StatusPill,
  WsTag,
} from '@/components/design'
import { Segmented as SettingsSegmented } from '@/components/settings-panel/setting-row'
import { renderWithProviders } from './helpers'

const here = dirname(fileURLToPath(import.meta.url))
const CSS = readFileSync(join(here, '..', 'src', 'index.css'), 'utf8')
const GENUI_CSS = readFileSync(
  join(here, '..', 'src', 'components', 'answer', 'genui', 'genui-view.css'),
  'utf8',
)

/** index.css 里 WP456-T2 那一段（从注释开头到骨架那段收尾）。 */
function kitBlock(): string {
  const start = CSS.indexOf('WP456-T2（WP456 §2.6，决策 1446）')
  const end = CSS.indexOf('@keyframes ws-skel-sweep')
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  return CSS.slice(start, end)
}

describe('样子只写在 .ws-* 里，数字落在档位上', () => {
  it('字号只用 22 / 16 / 14 / 13 / 12 / 11', () => {
    const sizes = [...kitBlock().matchAll(/font-size:\s*(\d+)px/g)].map((m) => Number(m[1]))
    expect(sizes.length).toBeGreaterThan(10)
    for (const px of sizes) expect([22, 16, 14, 13, 12, 11]).toContain(px)
  })

  it('圆角只用 6 / 8 / 12 / 16（卡）/ 全圆', () => {
    const radii = [...kitBlock().matchAll(/border-radius:\s*([^;]+);/g)].map((m) => m[1]?.trim())
    expect(radii.length).toBeGreaterThan(10)
    for (const r of radii)
      expect(['6px', '8px', '12px', '9999px', 'var(--ws-radius-card)']).toContain(r)
  })

  it('不写死颜色（#fff 只给红底上的白字），全走 token', () => {
    const hex = [...kitBlock().matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
    expect(hex.every((h) => h === '#fff')).toBe(true)
  })

  it('分段切换选中格深浅两套底色', () => {
    expect(CSS).toMatch(/:root \{[\s\S]*--ws-seg-on: var\(--ws-card\)/)
    expect(CSS).toMatch(/\.dark \{[\s\S]*--ws-seg-on: color-mix\(in srgb, var\(--ws-ink\) 10%/)
  })
})

describe('页头 / 节标题 / 分组名', () => {
  it('页头：h1 标题 22 + 一行灰字 + 右边操作', () => {
    render(
      <PageHeader title="待办" sub="今天 3 件" actions={<button type="button">记一条</button>} />,
    )
    const h1 = screen.getByRole('heading', { level: 1, name: '待办' })
    expect(h1.className).toContain('ws-phead-title')
    expect(screen.getByText('今天 3 件').className).toContain('ws-phead-sub')
    expect(screen.getByRole('button', { name: '记一条' }).closest('.ws-phead-acts')).not.toBeNull()
  })

  it('节标题带灰色计数；分组名算标题（少字守卫不量）', () => {
    render(
      <>
        <SectionHeader title="今天要做" count={3} />
        <GroupLabel count={2}>本周</GroupLabel>
      </>,
    )
    const h2 = screen.getByRole('heading', { level: 2 })
    expect(h2.textContent).toBe('今天要做3')
    expect(within(h2).getByText('3').className).toContain('ws-sec-count')
    expect(screen.getByText('本周').getAttribute('data-slot')).toBe('title')
  })
})

describe('列表组 / 行', () => {
  it('给 onClick 是整行按钮、右边「›」；给 to 是链接；都不给就是一行', () => {
    const onClick = vi.fn()
    render(
      <MemoryRouter>
        <ListGroup data-testid="g">
          <ListRow onClick={onClick} end="3 个要处理">
            消息
          </ListRow>
          <ListRow to="/todos">待办</ListRow>
          <ListRow end="09:40">回 Anna 的邮件</ListRow>
        </ListGroup>
      </MemoryRouter>,
    )
    expect(screen.getByTestId('g').className).toContain('ws-group')
    const btn = screen.getByRole('button', { name: /消息/ })
    expect(btn.className).toContain('ws-row-act')
    expect(btn.querySelector('.ws-row-chev')).not.toBeNull()
    fireEvent.click(btn)
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('link', { name: /待办/ }).getAttribute('href')).toBe('/todos')
    const plain = screen.getByText('回 Anna 的邮件').closest('[data-slot="list-row"]')
    expect(plain?.tagName).toBe('DIV')
    expect(plain?.querySelector('.ws-row-chev')).toBeNull()
  })
})

describe('标签三种', () => {
  it('状态药丸 = 点 + 字（.ws-pill），颜色跟 tone', () => {
    render(<StatusPill tone="warn">等你批</StatusPill>)
    const pill = screen.getByTestId('ws-status-pill')
    expect(pill.className).toContain('ws-pill')
    expect(pill.className).toContain('text-ws-warn')
    expect(pill.querySelector('.ws-pill-dot')).not.toBeNull()
    expect(pill.getAttribute('data-slot')).toBe('status')
  })

  it('分类标签灰底没有点；WsTag 是同一个样子', () => {
    render(
      <>
        <CategoryTag>售后</CategoryTag>
        <CategoryTag outline>演示</CategoryTag>
        <WsTag>退款</WsTag>
      </>,
    )
    expect(screen.getByText('售后').className).toBe('ws-tag')
    expect(screen.getByText('演示').className).toContain('ws-tag-outline')
    expect(screen.getByText('退款').className).toContain('ws-tag')
    expect(screen.getByText('售后').querySelector('.ws-pill-dot')).toBeNull()
  })

  it('数字徽章：99 以上写 99+；brand / alert / 挂角', () => {
    expect(countText(5)).toBe('5')
    expect(countText(100)).toBe('99+')
    render(
      <>
        <CountBadge n={3} data-testid="a" />
        <CountBadge n={120} tone="alert" corner data-testid="b" />
      </>,
    )
    expect(screen.getByTestId('a').textContent).toBe('3')
    expect(screen.getByTestId('a').getAttribute('data-tone')).toBe('neutral')
    const b = screen.getByTestId('b')
    expect(b.textContent).toBe('99+')
    expect(b.getAttribute('data-tone')).toBe('alert')
    expect(b.className).toContain('ws-count-corner')
    expect(b.getAttribute('data-slot')).toBe('badge')
  })
})

describe('分段切换（全站一种）', () => {
  it('几选一：aria-pressed，点别的才回调；计数、testId、data-value 都挂上', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        label="视图"
        testId="seg"
        value="open"
        onChange={onChange}
        options={[
          { value: 'open', label: '没人接的', count: 8, testId: 'v-open' },
          { value: 'all', label: '全部', testId: 'v-all' },
        ]}
      />,
    )
    const group = screen.getByRole('group', { name: '视图' })
    expect(group.getAttribute('data-testid')).toBe('seg')
    expect(group.className).toContain('ws-seg')
    const open = screen.getByTestId('v-open')
    expect(open.getAttribute('aria-pressed')).toBe('true')
    expect(open.getAttribute('data-on')).toBe('true')
    expect(open.getAttribute('data-value')).toBe('open')
    expect(within(open).getByText('8').className).toContain('ws-seg-count')
    fireEvent.click(open)
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('v-all'))
    expect(onChange).toHaveBeenCalledWith('all')
  })

  it('页签语义：role=tablist / tab + aria-selected；reselect 时点选中那格也回调', () => {
    const onChange = vi.fn()
    render(
      <Segmented
        kind="tabs"
        size="sm"
        reselect
        label="设定"
        value="role"
        onChange={onChange}
        options={[
          { value: 'role', label: '角色' },
          { value: 'caps', label: '额度' },
        ]}
      />,
    )
    const list = screen.getByRole('tablist', { name: '设定' })
    expect(list.className).toContain('ws-seg-sm')
    const tab = screen.getByRole('tab', { name: '角色' })
    expect(tab.getAttribute('aria-selected')).toBe('true')
    fireEvent.click(tab)
    expect(onChange).toHaveBeenCalledWith('role')
  })

  it('设置里那个老入口就是共用的这一个（不再是品牌绿实底那份）', () => {
    expect(SettingsSegmented).toBe(Segmented)
  })
})

describe('一行提醒 / 空状态 / 骨架', () => {
  it('一行提醒：浅底一行，图标按 tone 上色，右边一个链接，data-* 带过去', () => {
    const onClick = vi.fn()
    render(
      <NoticeLine
        data-testid="n"
        tone="bad"
        action={{
          label: '去连接',
          onClick,
          testId: 'go',
          data: { 'data-connect': 'shopify' },
        }}
      >
        还没连店铺
      </NoticeLine>,
    )
    const n = screen.getByTestId('n')
    expect(n.className).toContain('ws-notice')
    expect(n.getAttribute('data-tone')).toBe('bad')
    expect(n.getAttribute('data-slot')).toBe('status')
    expect(n.querySelector('.ws-notice-icon')).not.toBeNull()
    const go = screen.getByTestId('go')
    expect(go.className).toContain('ws-link')
    expect(go.getAttribute('data-connect')).toBe('shopify')
    fireEvent.click(go)
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('空状态：灰图标 + 一句话 + 一个链接（站内地址就是链接）', () => {
    render(
      <MemoryRouter>
        <EmptyState icon={Inbox} text="没有要你处理的" action={{ label: '看全部', to: '/todos' }} />
      </MemoryRouter>,
    )
    const box = screen.getByText('没有要你处理的').parentElement
    expect(box?.className).toContain('ws-empty')
    expect(box?.querySelector('.ws-empty-icon')).not.toBeNull()
    expect(screen.getByRole('link', { name: '看全部' }).className).toContain('ws-link')
  })

  it('骨架列表：和真行一样排（勾选框 + 半行字 + 右边小块），读屏念一句', () => {
    render(<SkeletonList rows={3} label="加载中" />)
    const s = screen.getByRole('status', { name: '加载中' })
    expect(s.getAttribute('aria-busy')).toBe('true')
    const rows = s.querySelectorAll('[data-slot="skeleton-row"]')
    expect(rows).toHaveLength(3)
    expect(rows[0]?.className).toContain('ws-row')
    expect(rows[0]?.querySelectorAll('.ws-skel')).toHaveLength(3)
  })
})

describe('决定卡外壳', () => {
  it('卡 / 头 / 身 / 底各走一个类；快捷键灰字在最右；标题算标题', () => {
    render(
      <DecisionCard data-testid="d">
        <DecisionCardHead end={<span>证据 3</span>}>
          <CategoryTag>售后</CategoryTag>
          <StatusPill tone="warn">等你批</StatusPill>
        </DecisionCardHead>
        <DecisionCardBody title="Anna 要退 #1001" desc="这周碰到 3 次">
          <CompareBlock beforeLabel="现在" before="拒绝" afterLabel="改成" after="退一半" />
        </DecisionCardBody>
        <DecisionCardFoot keys="↑ 稍后">
          <button type="button">通过</button>
        </DecisionCardFoot>
      </DecisionCard>,
    )
    const d = screen.getByTestId('d')
    expect(d.className).toContain('ws-dcard')
    expect(d.querySelector('.ws-dcard-head-end')?.textContent).toBe('证据 3')
    expect(screen.getByText('Anna 要退 #1001').getAttribute('data-slot')).toBe('title')
    expect(screen.getByText('这周碰到 3 次').className).toContain('ws-dcard-desc')
    expect(screen.getByText('退一半').closest('[data-after="true"]')).not.toBeNull()
    expect(screen.getByText('↑ 稍后').className).toContain('ws-dcard-keys')
  })

  it('选项组：整行可点，选中那行 aria-pressed', () => {
    const onChange = vi.fn()
    render(
      <OptionGroup
        label="怎么处理"
        value="a"
        onChange={onChange}
        options={[
          { id: 'a', label: '全额退款', note: '推荐' },
          { id: 'b', label: '退一半' },
        ]}
      />,
    )
    expect(screen.getByRole('group', { name: '怎么处理' }).className).toContain('ws-opts')
    const a = screen.getByRole('button', { name: /全额退款/ })
    expect(a.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: '退一半' }))
    expect(onChange).toHaveBeenCalledWith('b')
  })
})

describe('genui 和工作台同一套档位（决策 847）', () => {
  it('插件的卡 / 控件 / 字号令牌接到工作台的值上，而且盖得过插件根节点自己的声明', () => {
    expect(GENUI_CSS).toContain('.ws-genui.ws-genui [data-genui]')
    const block = GENUI_CSS.slice(GENUI_CSS.indexOf('.ws-genui.ws-genui [data-genui]'))
    expect(block).toContain('--dsl-g-radius-surface: var(--ws-radius-card)')
    expect(block).toContain('--dsl-g-radius-control: 8px')
    expect(block).toContain('--dsl-g-shadow-card: var(--ws-card-edge), var(--ws-shadow)')
    expect(block).toContain('--dsl-g-border-surface: transparent')
    for (const [name, px] of [
      ['body', 14],
      ['title', 13],
      ['meta', 12],
      ['h3', 16],
    ] as const)
      expect(block).toContain(`--dsl-g-font-${name}: ${px}px`)
  })
})

describe('组件一览页', () => {
  it('/ui-kit 一页摆全（页头、分段切换、列表组、提醒、空状态、骨架、决定卡）', async () => {
    const { default: UiKitPage } = await import('@/pages/ui-kit')
    renderWithProviders(<UiKitPage />, '/ui-kit')
    const page = screen.getByTestId('ui-kit')
    expect(within(page).getByRole('heading', { level: 1, name: '组件一览' })).toBeDefined()
    expect(page.querySelector('.ws-seg')).not.toBeNull()
    expect(page.querySelector('.ws-group')).not.toBeNull()
    expect(page.querySelector('.ws-notice')).not.toBeNull()
    expect(page.querySelector('.ws-empty')).not.toBeNull()
    expect(page.querySelector('[data-slot="skeleton"]')).not.toBeNull()
    expect(page.querySelector('.ws-dcard')).not.toBeNull()
  })
})
