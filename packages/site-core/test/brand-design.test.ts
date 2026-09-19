import type { BrandDesignContext } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { siteDesignPrompt, themeDesignVariables } from '../src/brand-design.js'

const present: BrandDesignContext = {
  present: true,
  prompt: '【品牌设计规范｜Heritage】\n色：primary #b8422e',
  tokens: {},
  palette: ['#b8422e'],
  fonts: ['Public Sans'],
}

describe('71 §5：建站怎么用那份 DESIGN.md（WP122）', () => {
  it('没有规范就回空串 —— 建站不该因为没有品牌规范就停下来', () => {
    expect(siteDesignPrompt()).toBe('')
    expect(
      siteDesignPrompt({ present: false, prompt: '', tokens: {}, palette: [], fonts: [] }),
    ).toBe('')
  })

  it('有规范就把那段话原样接上（这里不拼，拼法只有一处）', () => {
    expect(siteDesignPrompt(present)).toBe(present.prompt)
  })

  it('令牌翻成主题变量：颜色 / 圆角 / 间距 / 阴影 / 字号各一套', () => {
    const vars = themeDesignVariables({
      colors: { primary: '#b8422e', neutral: '#f7f5f2' },
      rounded: { md: '8px' },
      spacing: { md: '16px', columns: 12 },
      shadows: { sm: '0 1px 3px rgba(0,0,0,.08)' },
      typography: { h1: { fontFamily: 'Public Sans', fontSize: '48px' } },
    })
    expect(vars['--color-primary']).toBe('#b8422e')
    expect(vars['--radius-md']).toBe('8px')
    expect(vars['--space-columns']).toBe('12')
    expect(vars['--shadow-sm']).toBe('0 1px 3px rgba(0,0,0,.08)')
    expect(vars['--font-size-h1']).toBe('48px')
  })

  it('字体族只出标题与正文两个位 —— 十几个字号各带一份会把那张表撑成噪声', () => {
    const vars = themeDesignVariables({
      typography: {
        h1: { fontFamily: 'Public Sans', fontSize: '48px' },
        h2: { fontFamily: 'Public Sans', fontSize: '32px' },
        'body-md': { fontFamily: 'Space Grotesk', fontSize: '16px' },
      },
    })
    expect(vars['--font-heading']).toBe('Public Sans')
    expect(vars['--font-body']).toBe('Space Grotesk')
    expect(
      Object.keys(vars).filter((k) => k.startsWith('--font-') && !k.includes('size')),
    ).toHaveLength(2)
  })

  it('空令牌回一张空表，不回一堆空字符串', () => {
    expect(themeDesignVariables({})).toEqual({})
  })
})
