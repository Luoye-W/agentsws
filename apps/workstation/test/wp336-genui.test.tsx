/**
 * WP336（决策 810–812）工作台那一侧：genui 块交给 dsh-genui 的 `/embed` 渲染层画（React 19 下真渲染）。
 * 只剩白名单里的信息类组件；没有按钮 / 链接 / 图片 / 输入框；线程里的 ```dsh-ui 同样画；
 * 渲染层画不了时退回几行 markdown。
 */
import { type AnswerComponent, filterGenuiSpec, type GenuiSpecLite } from '@agentsws/contracts'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { renderWithProviders } from './helpers'

/** 渲染层与图表引擎是懒加载的单独一块，机器忙时头一次转换要几秒。 */
const SLOW = { timeout: 30_000 }

const { AnswerComponents } = await import('@/components/answer/answer-view')
const { default: GenuiView } = await import('@/components/answer/genui/genui-view')
const { SafeMarkdown } = await import('@/components/ui/safe-markdown')

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
    const block = await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(block.textContent).toContain('蓝牙耳机'), SLOW)
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
    const button = await screen.findByRole('button', { name: /危险操作/u }, SLOW)
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('渲染层画不了（插件自己判不合格）→ 退回退路', async () => {
    const broken = { items: [{ type: 'table', columns: 'x', rows: 3 }] } as unknown as GenuiSpecLite
    renderWithProviders(<GenuiView spec={broken} fallback={<p data-testid="fb">降级</p>} />)
    expect(await screen.findByTestId('fb', {}, SLOW)).toBeTruthy()
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
    const view = renderWithProviders(<GenuiView spec={spec} fallback={null} />)
    await screen.findByTestId('answer-genui', {}, SLOW)
    const assets = (globalThis as { __GenuiAssets__?: Record<string, unknown> }).__GenuiAssets__
    expect(Object.keys(assets ?? {}).sort()).toEqual(['echartsCore', 'echartsFull'])
    expect(document.querySelectorAll('script').length).toBe(before)
    view.unmount() // 引擎随组件卸载释放，再还原 canvas
    spy.mockRestore()
  })
})

describe('WP336 扩大范围：所有 AI 回话正文里的 ```dsh-ui', () => {
  const fenced = (body: unknown): string =>
    [
      '今天 8 单，看下面。',
      '',
      '```dsh-ui',
      JSON.stringify(body),
      '```',
      '',
      '有问题再问我。',
    ].join('\n')

  it('随便聊的回答：就地画成 genui 块（按钮被滤），前后的话照常，不露 JSON', async () => {
    const { AssistantMessage } = await import('@/components/free-chat/message')
    const text = fenced({
      items: [
        { type: 'stat', label: '今天订单', value: '8' },
        { type: 'table', columns: ['商品', '件数'], rows: [['蓝牙耳机', 3]] },
        { type: 'button', label: '一键上架', action: 'publish' },
      ],
    })
    renderWithProviders(
      <AssistantMessage
        message={{
          id: 'm1',
          session_id: 's1',
          role: 'assistant',
          text,
          at: '2026-10-15T00:00:00Z',
        }}
        last
        onRegenerate={() => {}}
      />,
    )
    const reply = screen.getByTestId('free-chat-reply')
    expect(reply.textContent).toContain('今天 8 单，看下面。')
    expect(reply.textContent).toContain('有问题再问我。')
    const block = await screen.findByTestId('answer-genui', {}, SLOW)
    await waitFor(() => expect(block.textContent).toContain('蓝牙耳机'), SLOW)
    expect(reply.textContent).not.toContain('"items"')
    expect(reply.textContent).not.toContain('一键上架')
  })

  it('还在往外吐字（JSON 不完整）：那段先不画、一个字符的 JSON 都不露', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown
        text={'先说一句。\n```dsh-ui\n{"items":[{"type":"table","col'}
        variant="chat"
      />,
    )
    expect(container.textContent).toBe('先说一句。')
  })

  it('教程文章（不是 AI 回话）里的 ```dsh-ui 照旧当代码', () => {
    const { container } = renderWithProviders(
      <SafeMarkdown text={'```dsh-ui\n{"items":[]}\n```'} variant="article" />,
    )
    expect(container.querySelector('pre')?.textContent).toBe('{"items":[]}')
  })
})
