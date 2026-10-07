/**
 * WP251（决策 119）：品牌上下文「品牌：」是这次运行所在的品牌，公司全称另起一行「公司：」；
 * 两个一样（个人用户常把公司全称填成品牌名）就不重复写。
 */
import { describe, expect, it } from 'vitest'
import { renderBrandContext } from '../src/index.js'

describe('WP251 品牌上下文的「公司：」一行', () => {
  it('品牌与公司分两行，公司紧跟品牌', () => {
    const text = renderBrandContext({ brand_name: 'Rollout', company_name: '深圳卢耶科技有限公司' })
    expect(text.split('\n').slice(0, 2)).toEqual(['品牌：Rollout', '公司：深圳卢耶科技有限公司'])
    expect(
      renderBrandContext({ brand_name: 'Rollout', company_name: 'Luoye Tech Ltd.' }, 'en'),
    ).toContain('Company: Luoye Tech Ltd.')
  })

  it('公司全称与品牌名一样（大小写、空白不算）不重复写；只有公司也照写', () => {
    expect(renderBrandContext({ brand_name: 'INMO', company_name: ' inmo ' })).toBe('品牌：INMO')
    expect(renderBrandContext({ company_name: '深圳卢耶科技有限公司' })).toBe(
      '公司：深圳卢耶科技有限公司',
    )
  })
})
