import { describe, expect, it } from 'vitest'
import {
  fitTaskTitle,
  isTaskBrief,
  MATTER_TITLE_MAX,
  needsTaskSplit,
  splitTaskText,
  TASK_TITLE_HEAD,
  taskTextOf,
  titleFromSummary,
} from '../src/index.js'

/** 10-07 真机那段 173 字的需求（多行）同样的形状：第一句短、后面几行细节。 */
const LONG = [
  '用 agentsws-theme 帮我搭一个英文首页。',
  '首屏放主推的三款产品，配一句卖点；下面是品牌故事、客户评价和常见问题。',
  '颜色跟品牌色走，字体用无衬线。做好之后推一个未发布主题，给我预览链接，我看过再决定要不要发布。',
  '别动现在在线的主题，也别改商品价格和库存。',
].join('\n')

describe('WP259 splitTaskText', () => {
  it('一行、不超过上限：原样当标题，没有描述', () => {
    expect(splitTaskText('  把 A 商品降价 10%  ')).toEqual({ title: '把 A 商品降价 10%' })
  })

  it('正好 120 字：不拆', () => {
    const text = '字'.repeat(MATTER_TITLE_MAX)
    expect(needsTaskSplit(text)).toBe(false)
    expect(splitTaskText(text)).toEqual({ title: text })
  })

  it('121 字一行没有句号：取前 40 字加「…」，原文进描述', () => {
    const text = '字'.repeat(MATTER_TITLE_MAX + 1)
    const out = splitTaskText(text)
    expect(out.title).toBe(`${'字'.repeat(TASK_TITLE_HEAD)}…`)
    expect(out.summary).toBe(text)
  })

  it('多行长需求：标题取第一句，描述是完整原文', () => {
    const out = splitTaskText(`\n${LONG}\n`)
    expect(out.title).toBe('用 agentsws-theme 帮我搭一个英文首页…')
    expect(out.summary).toBe(LONG)
    expect(Array.from(out.title).length).toBeLessThanOrEqual(MATTER_TITLE_MAX)
  })

  it('多行但很短：也拆（标题只要第一行）', () => {
    const out = splitTaskText('搭首页\n用品牌色')
    expect(out).toEqual({ title: '搭首页…', summary: '搭首页\n用品牌色' })
  })

  it('第一句太长：退回前 40 字', () => {
    const text = `${'很长的一句话'.repeat(10)}。后面还有`.repeat(3)
    const out = splitTaskText(text)
    expect(Array.from(out.title).length).toBe(TASK_TITLE_HEAD + 1)
    expect(out.title.endsWith('…')).toBe(true)
  })

  it('不把表情切成半个', () => {
    const text = '🎉'.repeat(130)
    const out = splitTaskText(text)
    expect(out.title).toBe(`${'🎉'.repeat(TASK_TITLE_HEAD)}…`)
  })

  it('空白：标题为空（调用方拦下，不交出去）', () => {
    expect(splitTaskText('   \n  ')).toEqual({ title: '' })
  })

  it('英文句号只在句末算（v1.2 不算）', () => {
    const text = `Ship theme v1.2 to preview. ${'x'.repeat(130)}`
    expect(splitTaskText(text).title).toBe('Ship theme v1.2 to preview…')
  })
})

describe('WP259 taskTextOf / fitTaskTitle', () => {
  it('拆出来的标题 + 原文 → 交给运行的就是原文，不重复开头', () => {
    const { title, summary } = splitTaskText(LONG)
    expect(titleFromSummary(title, summary)).toBe(true)
    expect(taskTextOf(title, summary)).toBe(LONG)
    expect(isTaskBrief(title, LONG)).toBe(true)
  })

  it('普通标题 + 上下文描述：照老规矩「标题 空格 描述」', () => {
    expect(taskTextOf('跟进这单', '从随便聊带过来的：…')).toBe('跟进这单 从随便聊带过来的：…')
    expect(taskTextOf('跟进这单', undefined)).toBe('跟进这单')
    expect(isTaskBrief('跟进这单', '跟进这单 从随便聊')).toBe(true)
  })

  it('服务端兜底：超长标题拆开，原文进描述；已有描述接在后面', () => {
    expect(fitTaskTitle({ title: LONG })).toEqual({
      title: '用 agentsws-theme 帮我搭一个英文首页…',
      summary: LONG,
    })
    const both = fitTaskTitle({ title: LONG, summary: '附：上次的预览' })
    expect(both.summary).toBe(`${LONG}\n\n附：上次的预览`)
    expect(taskTextOf(both.title, both.summary)).toBe(`${LONG}\n\n附：上次的预览`)
  })

  it('合规标题原样返回（同一个对象）', () => {
    const input = { title: '搭首页', summary: '细节', kind: 'adhoc' }
    expect(fitTaskTitle(input)).toBe(input)
  })
})
