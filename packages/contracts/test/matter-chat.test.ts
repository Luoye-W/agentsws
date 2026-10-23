import { describe, expect, it } from 'vitest'
import {
  cleanNextSuggestion,
  cleanShortTitle,
  fallbackShortTitle,
  NEXT_SUGGESTION_MAX,
  SHORT_TITLE_FALLBACK,
  SHORT_TITLE_MAX,
  shortTitlePrompt,
  splitNextSuggestion,
} from '../src/index.js'

const BRIEF =
  '用 agentsws-theme 给 Rovella 搭英文首页（星际机甲正版授权耳机音箱，美国市场）：大图横幅、主推产品占位、品牌故事、FAQ、邮件订阅；深色科技风红色点缀。推成未发布主题给我预览，先别发布。'

describe('WP264 短标题', () => {
  it('退路：原话前 20 字宽加「…」（中文一格、英文半格），换行压成一个空格', () => {
    expect(fallbackShortTitle(`  ${BRIEF.replace('：', '：\n')}`)).toBe(
      '用 agentsws-theme 给 Rovella 搭英文首页…',
    )
    expect(fallbackShortTitle('字'.repeat(30))).toBe(`${'字'.repeat(SHORT_TITLE_FALLBACK)}…`)
  })

  it('退路：短的原样', () => {
    expect(fallbackShortTitle('把 A 商品降价 10%')).toBe('把 A 商品降价 10%')
  })

  it('模型回来的去引号、前缀、句号；只取第一行', () => {
    expect(cleanShortTitle('标题：「Rovella 英文首页 · 深色科技风」。\n解释：……')).toBe(
      'Rovella 英文首页 · 深色科技风',
    )
    expect(cleanShortTitle('**Rovella 首页**')).toBe('Rovella 首页')
  })

  it('超长截到上限；空话回空串', () => {
    expect(Array.from(cleanShortTitle('字'.repeat(60))).length).toBe(SHORT_TITLE_MAX)
    expect(cleanShortTitle('  「」 ')).toBe('')
    expect(cleanShortTitle(undefined)).toBe('')
  })
})

describe('WP264 下一步建议 <next>', () => {
  it('末尾一行 <next> → 拿出来，正文去掉标记', () => {
    const out = splitNextSuggestion('预览好了，线上没动。\n\n要发布说一句。\n<next>发布上线</next>')
    expect(out).toEqual({ text: '预览好了，线上没动。\n\n要发布说一句。', next: '发布上线' })
  })

  it('没有标记：原样，没有建议', () => {
    expect(splitNextSuggestion('现在读首页模板。')).toEqual({ text: '现在读首页模板。' })
  })

  it('好几个取最后一个；空的 / 多行 / 超长的当没有（标记照样去掉）', () => {
    expect(splitNextSuggestion('a <next>先这样</next>\nb\n<next>「发布上线」</next>').next).toBe(
      '发布上线',
    )
    expect(splitNextSuggestion('a\n<next> </next>')).toEqual({ text: 'a' })
    expect(splitNextSuggestion(`a\n<next>${'字'.repeat(NEXT_SUGGESTION_MAX + 1)}</next>`)).toEqual({
      text: 'a',
    })
    expect(cleanNextSuggestion('一行\n两行')).toBeUndefined()
  })
})

describe('WP471（决策 1549）：起短标题——固定说明在前、这件事的原话最后', () => {
  it('两件事：原话之前逐字相同；原话在最后', () => {
    const a = shortTitlePrompt('<<<\n第一件事\n>>>')
    const b = shortTitlePrompt('<<<\n另一件事\n>>>')
    const head = (p: string) => p.slice(0, p.indexOf('<<<'))
    expect(head(a)).toContain('只回标题本身')
    expect(head(b)).toBe(head(a))
    expect(a.endsWith('>>>')).toBe(true)
  })
})
