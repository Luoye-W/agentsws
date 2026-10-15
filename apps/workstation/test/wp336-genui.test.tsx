/**
 * WP336（决策 810–812）工作台那一侧：genui 块交给 dsh-genui 的 `/embed` 渲染层画（React 19 下真渲染）。
 * 只剩白名单里的信息类组件；没有按钮 / 链接 / 图片 / 输入框；线程里的 ```dsh-ui 同样画；
 * 渲染层画不了时退回降级的表格 / 数字。
 */
import { type AnswerComponent, filterGenuiSpec, type GenuiSpecLite } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

const { AnswerComponents } = await import('@/components/answer/answer-view')
const { default: GenuiView } = await import('@/components/answer/genui/genui-view')

/** 模型写的（夹着不该有的），先按契约过滤——与服务进程同一份。 */
const RAW = {
  title: '店里的商品',
  items: [
    {
      type: 'grid',
      cols: 2,
      items: [
        { type: 'stat', label: '在卖', value: '2', delta: '+100%' },
        { type: 'stat', label: '草稿', value: '1' },
      ],
    },
    {
      type: 'table',
      columns: ['商品', '价格', '状态'],
      rows: [
        ['蓝牙耳机', 129, '在卖'],
        ['手机壳', 29, '在卖'],
        ['充电器', 59, '草稿'],
      ],
      export: true,
    },
    { type: 'callout', tone: 'warning', content: '充电器还没上架，[去后台](https://evil.example)' },
    { type: 'chart', kind: 'bars', data: [{ label: '耳机', value: 129 }] },
    { type: 'button', label: '一键上架', action: 'publish' },
    { type: 'link', label: '后台', href: 'https://evil.example' },
    { type: 'image', src: 'https://evil.example/a.png' },
    { type: 'input', id: 'q' },
  ],
}

const filtered = (): GenuiSpecLite => {
  const { spec } = filterGenuiSpec(RAW)
  if (spec === undefined) throw new Error('过滤后是空的')
  return spec
}

describe('WP336 genui 块', () => {
  it('渲染层真画出来：数字、表格行、提示都在；没有链接 / 图片 / 输入框，按钮只有表头排序', async () => {
    const components: AnswerComponent[] = [{ kind: 'genui', spec: filtered() }]
    renderWithProviders(<AnswerComponents components={components} />)
    const block = await screen.findByTestId('answer-genui')
    await waitFor(() => expect(block.textContent).toContain('蓝牙耳机'))
    const text = block.textContent ?? ''
    for (const s of ['店里的商品', '在卖', '草稿', '手机壳', '充电器', '129', '+100%', '去后台'])
      expect(text).toContain(s)
    expect(text).not.toContain('一键上架')
    expect(block.querySelectorAll('tbody tr')).toHaveLength(3)
    for (const tag of ['a', 'img', 'input', 'select', 'textarea', 'iframe', 'video', 'audio'])
      expect(block.querySelector(tag)).toBeNull()
    // 唯一的按钮是表头的「按这一列排序」（只在本机排，不回模型）
    const buttons = [...block.querySelectorAll('button')]
    expect(buttons.map((b) => b.textContent)).toEqual(['商品', '价格', '状态'])
    for (const b of buttons) expect(b.closest('thead')).not.toBeNull()
  })

  it('就算漏网一个按钮（没过契约直接喂渲染层），也是禁用的——不给 action 处理器', async () => {
    const leaked = {
      items: [{ type: 'button', label: '危险操作', action: 'drop_all' }],
    } as unknown as GenuiSpecLite
    renderWithProviders(<GenuiView spec={leaked} fallback={<p>降级</p>} />)
    const button = await screen.findByRole('button', { name: /危险操作/u })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('渲染层画不了（插件自己判不合格）→ 退回降级的组件', async () => {
    const broken = { items: [{ type: 'table', columns: 'x', rows: 3 }] } as unknown as GenuiSpecLite
    renderWithProviders(<GenuiView spec={broken} fallback={<p data-testid="fb">降级</p>} />)
    expect(await screen.findByTestId('fb')).toBeTruthy()
  })

  it('有 echart 才拉本机打包的图表引擎，登记到插件约定的位置（不插外部 <script>）', async () => {
    // jsdom 没有 canvas：给一个什么都不画的 2d 上下文，免得引擎在后台报错
    const noop = (): void => {}
    const ctx = new Proxy(
      {},
      { get: (_t, k) => (k === 'measureText' ? () => ({ width: 0 }) : noop), set: () => true },
    )
    const spy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => ctx as unknown as CanvasRenderingContext2D)
    const before = document.querySelectorAll('script').length
    const { spec } = filterGenuiSpec({
      items: [{ type: 'echart', preset: 'funnel', data: [{ label: '访问', value: 100 }] }],
    })
    if (spec === undefined) throw new Error('空')
    renderWithProviders(<GenuiView spec={spec} fallback={null} />)
    await screen.findByTestId('answer-genui')
    const assets = (globalThis as { __GenuiAssets__?: Record<string, unknown> }).__GenuiAssets__
    expect(Object.keys(assets ?? {}).sort()).toEqual(['echartsCore', 'echartsFull'])
    expect(document.querySelectorAll('script').length).toBe(before)
    spy.mockRestore()
  })
})
