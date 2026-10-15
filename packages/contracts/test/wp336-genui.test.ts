/**
 * WP336（决策 810–812）：当场回答的 ```dsh-ui 写法——白名单过滤（服务进程 / 模拟 / 工作台同一份）。
 * 红线：按钮、表单、图片音视频、链接、svg、mermaid、3D、action、自定义配色、外链一律不过。
 */
import { describe, expect, it } from 'vitest'
import {
  filterGenuiSpec,
  GENUI_ALLOWED_TYPES,
  GENUI_DISPLAY_RULE,
  GENUI_LIMITS,
  type GenuiNodeLite,
  genuiFencesToText,
  genuiToText,
  QUICK_ANSWER_RULE,
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

describe('WP336 给模型的规矩（决策 823：只有 ```dsh-ui 一套）', () => {
  it('当场问答那段：只查只答、教 ```dsh-ui、数字照原样；例子过得了白名单；没有 ```answer', () => {
    expect(QUICK_ANSWER_RULE).toContain('```dsh-ui')
    expect(QUICK_ANSWER_RULE).not.toContain('```answer')
    expect(QUICK_ANSWER_RULE).toContain('不出卡')
    expect(QUICK_ANSWER_RULE).toContain('原样')
    for (const t of ['text', 'card', 'grid', 'stat', 'table', 'chart', 'echart'])
      expect(GENUI_ALLOWED_TYPES).toContain(t)
    const example = /```dsh-ui\n(.*)\n```/u.exec(QUICK_ANSWER_RULE)?.[1] ?? ''
    expect(filterGenuiSpec(JSON.parse(example)).dropped).toEqual([])
  })

  it('老的 ```answer 段不再认：原样留在正文里，不出组件', () => {
    const a = splitAnswer(
      '今天 8 单。\n```answer\n{"components":[{"kind":"metric","items":[]}]}\n```',
    )
    expect(a.components.every((c) => c.kind !== 'genui')).toBe(true)
    expect(
      validateAnswerComponent({ kind: 'table', columns: ['a'], rows: [['x']] }),
    ).toBeUndefined()
    expect(
      validateAnswerComponent({ kind: 'metric', items: [{ label: 'a', value: 1 }] }),
    ).toBeUndefined()
  })
})

describe('WP336 扩大范围：所有对话运行 + 画不了组件的地方', () => {
  it('所有对话运行那段精简版：教 ```dsh-ui、说清对外内容不用', () => {
    expect(GENUI_DISPLAY_RULE).toContain('```dsh-ui')
    expect(GENUI_DISPLAY_RULE).toContain('对外内容')
    expect(GENUI_DISPLAY_RULE.split('\n').length).toBeLessThanOrEqual(6)
    const example = /```dsh-ui\n(.*)\n```/u.exec(GENUI_DISPLAY_RULE)?.[1] ?? ''
    expect(filterGenuiSpec(JSON.parse(example)).dropped).toEqual([])
  })

  it('genui → 几行字：markdown（退路）表格成表；plain（聊天软件）一行一条、超了说共几行；卡片拆开、图表成标签：值', () => {
    const spec = {
      title: '今天',
      items: [
        { type: 'stat' as const, label: '订单', value: '8', delta: '+12%' },
        { type: 'stat' as const, label: '销售额', value: '¥1,280' },
        {
          type: 'table' as const,
          columns: ['商品', '价格'],
          rows: [
            ['耳机', 129],
            ['手机壳', 29],
          ],
        },
        {
          type: 'card' as const,
          title: '趋势',
          items: [{ type: 'chart' as const, data: [{ label: '周一', value: 3 }] }],
        },
        { type: 'callout' as const, title: '注意', content: '两件缺货' },
      ],
    }
    expect(genuiToText(spec)).toBe(
      '**今天**\n\n订单 8（+12%） · 销售额 ¥1,280\n\n| 商品 | 价格 |\n| --- | --- |\n| 耳机 | 129 |\n| 手机壳 | 29 |\n\n**趋势**\n\n- 周一：3\n\n注意：两件缺货',
    )
    expect(genuiToText(spec, { style: 'plain', maxRows: 1 })).toBe(
      '今天\n\n订单 8（+12%） · 销售额 ¥1,280\n\n· 耳机，129\n（共 2 行）\n\n趋势\n\n- 周一：3\n\n注意：两件缺货',
    )
  })

  it('发到聊天软件前：```dsh-ui 换成几行字，坏的整段去掉，别的字原样', () => {
    const raw = [
      '今天 8 单。',
      fence({
        items: [
          { type: 'stat', label: '订单', value: '8' },
          { type: 'button', label: 'x' },
        ],
      }),
      '还有一段。',
      '```dsh-ui\n{"items":[\n```',
    ].join('\n')
    expect(genuiFencesToText(raw)).toBe('今天 8 单。\n订单 8\n还有一段。')
    expect(genuiFencesToText('没有组件')).toBe('没有组件')
  })
})
