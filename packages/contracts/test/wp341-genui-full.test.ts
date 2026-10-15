/**
 * WP341（决策 847）：genui 完全融合——按钮 / 表单 / 图片 / 链接进对话，动作接工坊自己的处理器。
 * 两条不动：口令格子的值不经 AI；会改外部的照旧进账本出审批（服务端 / 工作台的测试钉住那一半）。
 */
import { describe, expect, it } from 'vitest'
import {
  filterGenuiSpec,
  GENUI_DISPLAY_RULE,
  type GenuiNodeLite,
  type GenuiSpecLite,
  genuiFencesToIm,
  genuiFencesToText,
  genuiMediaTrust,
  genuiNodes,
  parseGenuiAction,
  pickImChoice,
  QUICK_ANSWER_RULE,
  resolveGenuiAction,
  splitGenuiReply,
} from '../src/index.js'

const spec = (raw: unknown): GenuiSpecLite => {
  const s = filterGenuiSpec(raw).spec
  if (s === undefined) throw new Error('空')
  return s
}
const types = (s: GenuiSpecLite): string[] => genuiNodes(s).map((n) => n.type)
const fence = (body: unknown): string => ['```dsh-ui', JSON.stringify(body), '```'].join('\n')

const FORM = {
  items: [
    { type: 'text', content: '挑 5 条 prompt' },
    {
      type: 'checkbox',
      group: 'prompts',
      label: '夏日海边',
      action: 'toggle',
    },
    { type: 'checkbox', group: 'prompts', label: '城市夜景' },
    { type: 'select', id: 'size', label: '尺寸', options: ['1:1', '9:16'], action: 'pick' },
    { type: 'input', id: 'when', label: '哪天发', inputType: 'date' },
    { type: 'input', id: 'smtp_password', label: '邮箱密码', service: 'imap_smtp' },
    { type: 'submit', label: '就这些', groups: ['prompts'] },
  ],
}

describe('WP341 白名单放开到全部组件', () => {
  it('按钮 / 表单 / 图片 / 链接 / mermaid / svg / 3D 都能画；动作认成宿主写法', () => {
    const s = spec({
      items: [
        { type: 'button', label: '接着看', action: 'say:再看看上周的' },
        { type: 'button', label: '去岗位', action: 'open:/positions/p1' },
        { type: 'button', label: '连 Shopify', action: 'connect:shopify_admin' },
        { type: 'button', label: '查库存', action: 'tool:list_products', args: { limit: 5 } },
        { type: 'button', label: '查库存 2', action: 'tool:list_products', args: { limit: 9 } },
        { type: 'button', label: '乱来', action: 'open://evil.example' },
        { type: 'image', src: 'https://cdn.shopify.com/s/a.png', alt: '主图' },
        { type: 'link', label: '官网', href: 'https://example.com' },
        {
          type: 'mermaid',
          code: '%%{init: {"securityLevel":"loose"}}%%\ngraph TD\nA-->B\nclick A call x()',
        },
        {
          type: 'svg',
          code: '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>',
        },
        { type: 'scene3d', meshes: [{ shape: 'box', color: '#888888' }] },
      ],
    })
    expect(types(s)).toEqual([
      'button',
      'button',
      'button',
      'button',
      'button',
      'button',
      'image',
      'link',
      'mermaid',
      'svg',
      'scene3d',
    ])
    const actions = s.items.map((n) => n.action)
    expect(actions.slice(0, 6)).toEqual([
      'say:再看看上周的',
      'open:/positions/p1',
      'connect:shopify_admin',
      'tool:list_products#1',
      'tool:list_products#2',
      undefined,
    ])
    expect(s.items[3]?.args).toEqual({ limit: 5 })
    expect(s.items[8]?.code).toBe('graph TD\nA-->B')
  })

  it('外部图片先「点开看」（标域名）；data: / javascript: 不画；带脚本的 svg 不画', () => {
    expect(genuiMediaTrust('/v1/files/a.png')).toBe('direct')
    expect(genuiMediaTrust('https://x.myshopify.com/a.png')).toBe('direct')
    expect(genuiMediaTrust('https://tracker.example/p.gif')).toBe('gate')
    expect(genuiMediaTrust('data:image/png;base64,AAAA')).toBeUndefined()
    const { spec: s, dropped } = filterGenuiSpec({
      items: [
        { type: 'image', src: 'https://tracker.example/p.gif', alt: '图' },
        { type: 'video', src: 'javascript:alert(1)' },
        { type: 'svg', code: '<svg><script>alert(1)</script></svg>' },
        { type: 'svg', code: '<svg><image href="https://evil.example/x.png"/></svg>' },
        { type: 'ws-media', media: 'image', src: 'data:x' },
      ],
    })
    expect(s?.items).toEqual([
      {
        type: 'ws-media',
        media: 'image',
        src: 'https://tracker.example/p.gif',
        alt: '图',
        host: 'tracker.example',
      },
    ])
    expect(dropped).toEqual(expect.arrayContaining(['video', 'svg', 'ws-media']))
  })

  it('口令格子（password / 像密钥的名字）换成宿主的口令格；表单格子在有提交的块里不单独发', () => {
    const s = spec(FORM)
    const nodes = genuiNodes(s)
    const secret = nodes.find((n) => n.type === 'ws-secret')
    expect(secret).toEqual({
      type: 'ws-secret',
      id: 'smtp_password',
      label: '邮箱密码',
      service: 'imap_smtp',
    })
    expect(nodes.filter((n) => n.type === 'input')).toEqual([
      { type: 'input', id: 'when', label: '哪天发', inputType: 'date' },
    ])
    expect(nodes.filter((n) => n.type !== 'submit').every((n) => n.action === undefined)).toBe(true)
    expect(nodes.find((n) => n.type === 'submit')?.action).toBe('submit')
    expect(spec({ type: 'input', inputType: 'password', label: '随便' }).items[0]?.type).toBe(
      'ws-secret',
    )
  })

  it('过滤是幂等的（工作台再过一遍同一份）', () => {
    const once = spec(FORM)
    expect(spec(once)).toEqual(once)
    const tools = spec({
      items: [{ type: 'button', label: 'a', action: 'tool:x', args: { a: 1 } }],
    })
    expect(spec(tools)).toEqual(tools)
  })
})

describe('WP341 宿主处理器', () => {
  it('动作写法：say / open / tool / connect / setup / submit；单个词当一句话；乱的不认', () => {
    expect(parseGenuiAction('pick')).toEqual({ kind: 'say' })
    expect(parseGenuiAction('open:agentsws://connect/shopify_admin')).toEqual({
      kind: 'open',
      to: 'agentsws://connect/shopify_admin',
    })
    expect(parseGenuiAction('open:https://evil.example')).toBeUndefined()
    expect(parseGenuiAction('tool:bad name')).toBeUndefined()
    expect(parseGenuiAction('setup:company.profile')).toEqual({
      kind: 'setup',
      target: 'company.profile',
    })
  })

  it('点按钮：发一句话 / 开页面 / 调工具（带参数）/ 开连接卡；描述里找不到的动作不做', () => {
    const s = spec({
      items: [
        { type: 'button', label: '就这条', action: 'pick' },
        { type: 'button', label: '看上周', action: 'say:再看看上周的' },
        { type: 'button', label: '查', action: 'tool:list_products', args: { limit: 5 } },
        { type: 'button', label: '连', action: 'connect:shopify_admin' },
      ],
    })
    const click = (a: string, label: string) => resolveGenuiAction(s, a, { type: 'button', label })
    expect(click('say', '就这条')).toEqual({ kind: 'say', text: '就这条' })
    expect(click('say:再看看上周的', '看上周')).toEqual({ kind: 'say', text: '再看看上周的' })
    expect(click('tool:list_products#1', '查')).toEqual({
      kind: 'tool',
      tool: 'list_products',
      args: { limit: 5 },
      label: '查',
    })
    expect(click('connect:shopify_admin', '连')).toEqual({
      kind: 'connect',
      services: ['shopify_admin'],
    })
    expect(click('tool:delete_everything#9', '删')).toEqual({ kind: 'none' })
  })

  it('交表单：用户在对话里的一条结构化回话（摘要 + ```dsh-reply）；口令格只写「已填好」', () => {
    const s = spec(FORM)
    const out = resolveGenuiAction(
      s,
      'submit',
      {
        type: 'submit',
        answers: { prompts: ['夏日海边', '城市夜景'] },
        fields: { size: '9:16', when: '2026-10-20' },
        total: 1,
        answered: 1,
      },
      ['邮箱密码'],
    )
    if (out.kind !== 'reply') throw new Error(out.kind)
    expect(out.text.split('```')[0]).toBe(
      '就这些：\n- prompts：夏日海边、城市夜景\n- 尺寸：9:16\n- 哪天发：2026-10-20\n- 邮箱密码：已填好\n\n',
    )
    const back = splitGenuiReply(out.text)
    expect(back.reply).toEqual(out.reply)
    expect(back.text.startsWith('就这些：')).toBe(true)
    expect(out.text).not.toMatch(/password|hunter2/u)
  })

  it('单个格子：选了就发「标签：值」；输入框只在回车时发', () => {
    const s = spec({
      items: [
        { type: 'select', id: 'size', label: '尺寸', options: ['1:1', '9:16'], action: 'pick' },
        { type: 'input', id: 'q', label: '想问', action: 'ask' },
      ],
    })
    expect(resolveGenuiAction(s, 'say', { type: 'select', value: '9:16', id: 'size' })).toEqual({
      kind: 'say',
      text: '尺寸：9:16',
    })
    const n = s.items[1] as GenuiNodeLite
    expect(resolveGenuiAction({ items: [n] }, 'say', { type: 'input', value: '在吗' })).toEqual({
      kind: 'none',
    })
    expect(
      resolveGenuiAction({ items: [n] }, 'say', { type: 'input', value: '在吗', submit: true }),
    ).toEqual({
      kind: 'say',
      text: '想问：在吗',
    })
  })
})

describe('WP341 聊天软件出口', () => {
  it('按钮成编号选项、回编号就当说了那句；表单成要回答的问题；口令不在聊天里要', () => {
    const raw = `挑一个：\n${fence({
      items: [
        { type: 'button', label: '改价', action: 'say:先改价' },
        { type: 'button', label: '上新', action: 'say' },
      ],
    })}`
    const im = genuiFencesToIm(raw)
    expect(im.text).toBe('挑一个：\n1. 改价\n2. 上新\n\n回编号就行。')
    expect(im.choices).toEqual(['先改价', '上新'])
    expect(pickImChoice('2', im.choices)).toBe('上新')
    expect(pickImChoice('选1', im.choices)).toBe('先改价')
    expect(pickImChoice('3', im.choices)).toBeUndefined()
    expect(pickImChoice('改价吧', im.choices)).toBeUndefined()
    const form = genuiFencesToText(fence(FORM))
    expect(form).toContain('1）prompts（夏日海边 / 城市夜景，可多选）')
    expect(form).toContain('2）尺寸（1:1 / 9:16）')
    expect(form).toContain('3）哪天发')
    expect(form).toContain('邮箱密码：请到工坊里填')
    expect(form).not.toContain('{')
  })
})

describe('WP341 给模型的规矩', () => {
  it('教按钮 / 表单什么时候用、动作怎么写、口令不进输入框；两段例子都过得了白名单', () => {
    for (const rule of [GENUI_DISPLAY_RULE, QUICK_ANSWER_RULE]) {
      const example = /```dsh-ui\n(.*)\n```/u.exec(rule)?.[1] ?? ''
      expect(filterGenuiSpec(JSON.parse(example)).dropped).toEqual([])
    }
    for (const word of ['submit', 'say:', 'connect:', 'tool:', 'dsh-reply', '口令'])
      expect(GENUI_DISPLAY_RULE).toContain(word)
  })
})
