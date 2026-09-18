/**
 * WP96 交付 1：token + 共用件。
 *
 * 这里钉的不是像素，是**规则**：卡走 `.ws-card`（圆角 16、无边框、浅阴影都在这一个
 * class 里），选中态**多一个** `.ws-card-selected`（光晕 + 抬 3px），四个共用件各自
 * 的结构点都在。像素在截图里看，不在这儿。
 */
import { render, screen } from '@testing-library/react'
import { Boxes } from 'lucide-react'
import { describe, expect, it } from 'vitest'
import {
  DeltaPill,
  PositionCard,
  SparkBars,
  SparkLine,
  StatRow,
  StatTile,
  StatusPill,
  WsCard,
} from '@/components/design'
import { ProgressBar } from '@/components/ui/tremor/progress-bar'
import { ProgressCircle } from '@/components/ui/tremor/progress-circle'

describe('WsCard', () => {
  it('普通态只有 ws-card，选中态再加光晕 class', () => {
    const { rerender } = render(<WsCard data-testid="c">x</WsCard>)
    const card = screen.getByTestId('c')
    expect(card.className).toContain('ws-card')
    expect(card.className).not.toContain('ws-card-selected')
    expect(card.dataset.selected).toBeUndefined()

    rerender(
      <WsCard data-testid="c" selected>
        x
      </WsCard>,
    )
    const selected = screen.getByTestId('c')
    expect(selected.className).toContain('ws-card-selected')
    expect(selected.dataset.selected).toBe('true')
  })
})

describe('StatTile', () => {
  it('图标徽 + 大数字 + 标签 + 涨跌胶囊', () => {
    render(
      <StatTile
        icon={<Boxes />}
        tone="warn"
        value="US$8,412"
        label="总销售额"
        delta="8.2% 比上周同时"
        direction="up"
      />,
    )
    expect(screen.getByTestId('ws-stat-tile-value').textContent).toBe('US$8,412')
    expect(screen.getByText('总销售额')).toBeTruthy()
    expect(screen.getByTestId('ws-stat-tile-badge').className).toContain('bg-ws-warn-bg')
    expect(screen.getByTestId('ws-delta').dataset.direction).toBe('up')
  })

  it('数据源没连上时出 fallback，不出一个假的数', () => {
    render(<StatTile value="0" label="订单数" delta="+5" fallback={<span>去连接</span>} />)
    expect(screen.queryByTestId('ws-stat-tile-value')).toBeNull()
    expect(screen.queryByTestId('ws-delta')).toBeNull()
    expect(screen.getByText('去连接')).toBeTruthy()
  })
})

describe('StatRow', () => {
  it('行式数字 + 火花线', () => {
    render(
      <StatRow label="销售额" value="US$1,240" delta="8.2%" direction="up" spark={[1, 4, 9]} />,
    )
    const row = screen.getByTestId('ws-stat-row')
    expect(row.textContent).toContain('US$1,240')
    expect(screen.getByTestId('ws-spark-line')).toBeTruthy()
  })
})

describe('PositionCard', () => {
  it('待审大数字 + 一句状态 + 持有人 + 交给它一件事', () => {
    render(
      <PositionCard
        icon={<Boxes />}
        name="网站运营"
        pending={1}
        pendingLabel="张待审"
        line="改价 1 待审 · 库存告急 3 个 SKU"
        holders={[{ name: '岚' }, { name: '默', tone: 'info' }]}
        entryLabel="交给它一件事"
      />,
    )
    expect(screen.getByTestId('ws-position-pending').textContent).toBe('1')
    expect(screen.getAllByTestId('ws-avatar')).toHaveLength(2)
    expect(screen.getByTestId('ws-position-entry').textContent).toBe('交给它一件事')
    expect(screen.getByTestId('ws-position-card').className).not.toContain('ws-card-selected')
  })

  it('当前岗位是光晕态', () => {
    render(
      <PositionCard
        name="客服"
        pending={3}
        pendingLabel="张待审"
        line="—"
        entryLabel="交给它"
        selected
      />,
    )
    expect(screen.getByTestId('ws-position-card').className).toContain('ws-card-selected')
  })
})

describe('小件', () => {
  it('状态胶囊带 tone；涨跌默认跌了才红', () => {
    render(
      <>
        <StatusPill tone="good">待审</StatusPill>
        <DeltaPill direction="down">0.3pt</DeltaPill>
      </>,
    )
    expect(screen.getByTestId('ws-status-pill').dataset.tone).toBe('good')
    expect(screen.getByTestId('ws-delta').className).toContain('bg-ws-bad-bg')
  })

  it('火花线两种：竖条与折线', () => {
    const { container } = render(
      <>
        <SparkBars points={[1, 2, 3, 4]} />
        <SparkLine points={[1, 2, 3, 4]} />
      </>,
    )
    expect(screen.getByTestId('ws-spark-bars').children).toHaveLength(4)
    expect(container.querySelector('[data-testid="ws-spark-line"] polyline')).toBeTruthy()
  })
})

describe('Tremor Raw 本地组件', () => {
  it('进度环与进度条都报 aria 值', () => {
    render(
      <>
        <ProgressCircle value={72} label="自动化率" />
        <ProgressBar value={22} max={37} label="22" />
      </>,
    )
    const [circle, bar] = screen.getAllByRole('progressbar')
    expect(circle?.getAttribute('aria-valuenow')).toBe('72')
    expect(bar?.getAttribute('aria-valuenow')).toBe('22')
    expect(bar?.getAttribute('aria-valuemax')).toBe('37')
  })
})
