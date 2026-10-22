/**
 * WP468（决策 1510）：Reddit 草稿出卡前去 Markdown 记号（新版评论框是富文本，记号会照原样发出去）。
 */
import { describe, expect, it } from 'vitest'
import { redditPlainText, redditPlainTitle } from '../src/index.js'

describe('redditPlainText：残留的 Markdown 记号转纯文字', () => {
  it('粗体 / 斜体 / 删除线 / 行内代码去掉记号，字留着', () => {
    expect(redditPlainText('This is **really** good and __also__ this.')).toBe(
      'This is really good and also this.',
    )
    expect(redditPlainText('I *think* the _firmware_ fixed it, ~~maybe~~ `v2.1`.')).toBe(
      'I think the firmware fixed it, maybe v2.1.',
    )
    expect(redditPlainText('***both***')).toBe('both')
  })

  it('链接：[字](网址) → 字 (网址)；字就是网址或是空的 → 只留网址', () => {
    expect(redditPlainText('See [our guide](https://example.com/guide) for steps.')).toBe(
      'See our guide (https://example.com/guide) for steps.',
    )
    expect(redditPlainText('[https://example.com/a](https://example.com/a)')).toBe(
      'https://example.com/a',
    )
    expect(redditPlainText('[example.com](https://www.example.com/)')).toBe(
      'https://www.example.com/',
    )
    expect(redditPlainText('[](https://example.com)')).toBe('https://example.com')
    expect(redditPlainText('![pic](https://i.example.com/a.png)')).toBe(
      'pic (https://i.example.com/a.png)',
    )
    expect(redditPlainText('Docs: <https://example.com/docs>')).toBe(
      'Docs: https://example.com/docs',
    )
    expect(redditPlainText('[帮助页](https://example.com/help "标题")')).toBe(
      '帮助页 (https://example.com/help)',
    )
  })

  it('网址本身一个字不动（里面的 __ / * / 括号都不当记号）', () => {
    expect(redditPlainText('Read https://x.com/a__b__c and https://x.com/*star*')).toBe(
      'Read https://x.com/a__b__c and https://x.com/*star*',
    )
    expect(redditPlainText('[wiki](https://en.wikipedia.org/wiki/Foo_(bar))')).toBe(
      'wiki (https://en.wikipedia.org/wiki/Foo_(bar))',
    )
    expect(redditPlainText('**Link:** https://example.com/a_b_c.')).toBe(
      'Link: https://example.com/a_b_c.',
    )
  })

  it('行首标题记号去掉，留那一行字', () => {
    expect(redditPlainText('# Update\n\n## What changed ##\nText')).toBe(
      'Update\n\nWhat changed\nText',
    )
    // 「#1」不是标题
    expect(redditPlainText('#1 tip: restart it')).toBe('#1 tip: restart it')
  })

  it('不该动的不动：用户名里的下划线、乘号、列表、引用、中文', () => {
    expect(redditPlainText('Thanks u/some_user_name!')).toBe('Thanks u/some_user_name!')
    expect(redditPlainText('It is 5 * 3 * 2 = 30')).toBe('It is 5 * 3 * 2 = 30')
    expect(redditPlainText('- one\n- two\n> quoted')).toBe('- one\n- two\n> quoted')
    expect(redditPlainText('这个我去确认一下再回你。')).toBe('这个我去确认一下再回你。')
    expect(redditPlainText('snake_case_name and 2*x')).toBe('snake_case_name and 2*x')
  })

  it('代码块围栏去掉、转义还原、段落之间留一个空行', () => {
    expect(redditPlainText('```\nsettings > reset\n```')).toBe('settings > reset')
    expect(redditPlainText('Price is \\*not\\* final')).toBe('Price is *not* final')
    expect(redditPlainText('First para.  \n\n\n\nSecond para.')).toBe('First para.\n\nSecond para.')
  })

  it('标题一行：同样去记号、换行收成空格', () => {
    expect(redditPlainTitle('**New** firmware\nis out')).toBe('New firmware is out')
  })
})
