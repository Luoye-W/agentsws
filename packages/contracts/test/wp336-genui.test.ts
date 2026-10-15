/**
 * WP336（决策 810–812）：当场回答的 ```dsh-ui 写法——白名单过滤（服务进程 / 模拟 / 工作台同一份）。
 * 红线：按钮、表单、图片音视频、链接、svg、mermaid、3D、action、自定义配色、外链一律不过。
 */
import { describe, expect, it } from 'vitest'
import {
  filterGenuiSpec,
  GENUI_ALLOWED_TYPES,
  GENUI_LIMITS,
  type GenuiNodeLite,
  genuiToAnswerComponents,
  hasAnswerFence,
  QUICK_ANSWER_GENUI_RULE,
  QUICK_ANSWER_RULE,
  quickAnswerRule,
  quickAnswerUiOf,
  splitAnswer,
  validateAnswerComponent,
} from '../src/index.js'

const fence = (body: unknown): string => ['```dsh-ui', JSON.stringify(body), '```'].join('\n')

/** 树里所有节点的类型（深度优先）。 */
function typesOf(items: readonly GenuiNodeLite[]): string[] {
  return items.flatMap((n) => [
    n.type,
    ...(Array.isArray(n.items) && n.type !== 'list' && n.type !== 'timeline'
      ? typesOf(n.items as GenuiNodeLite[])
      : []),
  ])
}

describe('WP336 ```dsh-ui 取出与过滤', () => {
  it('取出一块 genui：表格行数 / 数字原样，正文第一段是那一句话', () => {
    const raw = [
      '店里有 3 件商品，2 件在卖。',
      '',
      fence({
        items: [
          { type: 'stat', label: '在卖', value: 2 },
          {
            type: 'table',
            columns: ['商品', '价格'],
            rows: [
              ['蓝牙耳机', 129],
              ['手机壳', 29],
              ['充电器', 59],
            ],
          },
        ],
      }),
    ].join('\n')
    expect(hasAnswerFence(raw)).toBe(true)
    const a = splitAnswer(raw)
    expect(a.lead).toBe('店里有 3 件商品，2 件在卖。')
    expect(a.text).not.toContain('```')
    expect(a.components).toHaveLength(1)
    const c = a.components[0]
    if (c?.kind !== 'genui') throw new Error('不是 genui')
    expect(typesOf(c.spec.items)).toEqual(['stat', 'table'])
    expect(c.spec.items[0]).toEqual({ type: 'stat', label: '在卖', value: '2' })
    expect(c.spec.items[1]?.rows).toEqual([
      ['蓝牙耳机', 129],
      ['手机壳', 29],
      ['充电器', 59],
    ])
  })

  it('红线：按钮 / 表单 / 图片 / 音视频 / 链接 / svg / mermaid / 3D 一律丢，卡片里的也丢', () => {
    const { spec, dropped } = filterGenuiSpec({
      items: [
        { type: 'button', label: '立即下单', action: 'buy' },
        { type: 'input', id: 'q', placeholder: '输入' },
        { type: 'image', src: 'https://evil.example/x.png' },
        { type: 'video', src: 'https://evil.example/x.mp4' },
        { type: 'audio', src: 'https://evil.example/x.mp3' },
        { type: 'link', label: '点这里', href: 'https://evil.example' },
        { type: 'svg', content: '<svg onload="x()"/>' },
        { type: 'mermaid', source: 'graph TD; A-->B' },
        { type: 'scene3d', meshes: [] },
        { type: 'submit', label: '提交', action: 'go' },
        {
          type: 'card',
          title: '本周',
          accent: '#ff0000',
          items: [
            {
              type: 'text',
              content: '看 [这里](https://evil.example) 和 [那里](javascript:alert(1))',
            },
            { type: 'button', label: '买', action: 'buy' },
          ],
        },
      ],
    })
    expect(dropped).toEqual(
      expect.arrayContaining(['button', 'input', 'image', 'video', 'audio', 'link', 'svg']),
    )
    expect(dropped).toEqual(expect.arrayContaining(['mermaid', 'scene3d', 'submit']))
    expect(spec?.items).toEqual([
      { type: 'card', title: '本周', items: [{ type: 'text', content: '看 这里 和 那里' }] },
    ])
    expect(
      filterGenuiSpec({ type: 'text', content: '[[套](https://a.example)](https://b.example)' })
        .spec?.items[0]?.content,
    ).toBe('套')
    const json = JSON.stringify(spec)
    for (const bad of ['http', 'javascript', 'action', 'accent', '#ff0000', 'src'])
      expect(json).not.toContain(bad)
  })

  it('去掉 action、过滤 / 排序 / 导出 / 展开行、自定义配色；echart 只认四种预设、不收 option', () => {
    const { spec, dropped } = filterGenuiSpec({
      items: [
        {
          type: 'table',
          columns: ['商品'],
          rows: [['耳机']],
          filter: 'q',
          sortField: 's',
          export: true,
          details: [[{ type: 'button', label: 'x' }]],
          action: 'open',
        },
        {
          type: 'chart',
          kind: 'bars',
          data: [{ label: 'A', value: 1, color: '#f00' }],
          palette: ['#f00'],
        },
        {
          type: 'echart',
          preset: 'funnel',
          data: [{ label: '访问', value: 100 }],
          palette: ['#f00'],
        },
        { type: 'echart', preset: 'radar', data: [{ label: 'A', value: 1 }] },
        { type: 'echart', option: { series: [{ type: 'custom' }] } },
        { type: 'badge', label: '新', tone: 'accent', icon: 'https://evil.example/i.png' },
      ],
    })
    expect(spec?.items).toEqual([
      { type: 'table', columns: ['商品'], rows: [['耳机']] },
      { type: 'chart', data: [{ label: 'A', value: 1 }], kind: 'bars' },
      { type: 'echart', preset: 'funnel', data: [{ label: '访问', value: 100 }] },
      { type: 'badge', label: '新', tone: 'accent' },
    ])
    expect(dropped).toEqual(['echart'])
  })

  it('单个组件、一串组件都认；不认识的类型、空表、坏 JSON 不画', () => {
    expect(filterGenuiSpec({ type: 'steps', items: [{ title: '一' }] }).spec?.items).toEqual([
      { type: 'steps', steps: [{ title: '一' }] },
    ])
    expect(filterGenuiSpec([{ type: 'text', content: 'a' }]).spec?.items).toHaveLength(1)
    expect(
      filterGenuiSpec({ type: 'genui', items: [{ type: 'text', content: 'a' }] }).spec,
    ).toEqual({
      items: [{ type: 'text', content: 'a' }],
    })
    expect(filterGenuiSpec({ items: [{ type: 'table', columns: ['a'], rows: [] }] }).spec).toBe(
      undefined,
    )
    const bad = splitAnswer('今天 8 单。\n```dsh-ui\n{"items":[{"type":"table",\n```')
    expect(bad.lead).toBe('今天 8 单。')
    expect(bad.components).toEqual([])
  })

  it('上限：表格 50 行 8 列、最多 4 层、最多 60 个节点', () => {
    const rows = Array.from({ length: 80 }, (_, i) => Array.from({ length: 12 }, (_, j) => i * j))
    const table = filterGenuiSpec({
      items: [{ type: 'table', columns: Array.from({ length: 12 }, (_, i) => `c${i}`), rows }],
    }).spec?.items[0]
    expect(table?.rows).toHaveLength(GENUI_LIMITS.tableRows)
    expect(table?.columns).toHaveLength(GENUI_LIMITS.tableCols)
    let deep: unknown = { type: 'text', content: '底' }
    for (let i = 0; i < 6; i += 1) deep = { type: 'card', items: [deep] }
    expect(filterGenuiSpec({ items: [deep] }).spec).toBe(undefined)
    const many = Array.from({ length: 100 }, (_, i) => ({ type: 'text', content: `${i}` }))
    expect(filterGenuiSpec({ items: many }).spec?.items).toHaveLength(GENUI_LIMITS.nodes)
  })

  it('过滤是幂等的：接口回来的 genui 块再校验一遍结果不变', () => {
    const { spec } = filterGenuiSpec({
      title: '今天',
      items: [
        {
          type: 'grid',
          cols: 2,
          items: [{ type: 'stat', label: '订单', value: '8', delta: '+12%' }],
        },
      ],
    })
    if (spec === undefined) throw new Error('空')
    expect(validateAnswerComponent({ kind: 'genui', spec })).toEqual({ kind: 'genui', spec })
    expect(validateAnswerComponent({ kind: 'genui', spec: { items: [{ type: 'button' }] } })).toBe(
      undefined,
    )
  })
})

describe('WP336 回退：降级成 ```answer 三种', () => {
  it('genui: false → 数字成一组、表格成表格、字成一段', () => {
    const raw = [
      '今天 8 单。',
      fence({
        items: [
          { type: 'stat', label: '订单', value: '8', delta: '+12%' },
          { type: 'stat', label: '销售额', value: '¥1,280' },
          { type: 'table', columns: ['商品', '件数'], rows: [['耳机', 3]] },
          { type: 'callout', tone: 'warning', title: '注意', content: '两件缺货' },
        ],
      }),
    ].join('\n')
    const a = splitAnswer(raw, { genui: false })
    expect(a.components.map((c) => c.kind)).toEqual(['metric', 'table', 'text'])
    expect(a.components[0]).toEqual({
      kind: 'metric',
      items: [
        { label: '订单', value: '8', delta_pct: 12 },
        { label: '销售额', value: '¥1,280' },
      ],
    })
    expect(a.components[2]).toEqual({ kind: 'text', text: '注意：两件缺货' })
  })

  it('图表降成两列表格；卡片拆开', () => {
    const out = genuiToAnswerComponents({
      items: [
        {
          type: 'card',
          title: '趋势',
          items: [{ type: 'chart', data: [{ label: '周一', value: 3 }] }],
        },
      ],
    })
    expect(out.map((c) => c.kind)).toEqual(['text', 'table'])
  })

  it('开关：只有明写 answer 才切回；两套规矩各教各的围栏', () => {
    expect(quickAnswerUiOf(undefined)).toBe('genui')
    expect(quickAnswerUiOf('ANSWER ')).toBe('answer')
    expect(quickAnswerUiOf('whatever')).toBe('genui')
    expect(quickAnswerRule('answer')).toBe(QUICK_ANSWER_RULE)
    expect(quickAnswerRule('genui')).toBe(QUICK_ANSWER_GENUI_RULE)
    expect(QUICK_ANSWER_GENUI_RULE).toContain('```dsh-ui')
    expect(QUICK_ANSWER_GENUI_RULE).toContain('不出卡')
    expect(QUICK_ANSWER_GENUI_RULE).toContain('原样')
    // 规矩里教的组件都在白名单里
    for (const t of ['text', 'card', 'grid', 'stat', 'table', 'chart', 'echart'])
      expect(GENUI_ALLOWED_TYPES).toContain(t)
    // 例子本身过得了白名单
    const example = /```dsh-ui\n(.*)\n```/u.exec(QUICK_ANSWER_GENUI_RULE)?.[1] ?? ''
    expect(filterGenuiSpec(JSON.parse(example)).dropped).toEqual([])
  })
})
