import { describe, expect, it } from 'vitest'
import {
  affiliateCode,
  applyUtm,
  attributeOrders,
  buildUtm,
  KOL_UTM_MEDIUM,
  parseUtm,
} from '../src/index.js'

describe('UTM 往返（48 §5.2）', () => {
  const utm = buildUtm({
    channel: 'youtube',
    campaign: 'Autumn Desk 2026',
    collaboration_id: 'col_1',
  })

  it('生成的形状固定：渠道当 source、medium 恒为 kol、合作 id 进 content', () => {
    expect(utm).toEqual({
      source: 'youtube',
      medium: KOL_UTM_MEDIUM,
      campaign: 'autumn-desk-2026',
      content: 'col_1',
    })
  })

  it('content 里不放红人的名字（UTM 出现在公开链接上 = 把合作名单贴出去）', () => {
    expect(JSON.stringify(utm)).not.toContain('jonas')
  })

  it('挂上去再读回来，一模一样；原有的参数留着', () => {
    const url = applyUtm('https://shop.example/p/charger?variant=65w', utm)
    expect(new URL(url).searchParams.get('variant')).toBe('65w')
    expect(parseUtm(url)).toEqual(utm)
  })

  it('半份 UTM 读不回来（留着它只会在归因表上多一行"合作：不知道"）', () => {
    expect(parseUtm('https://shop.example/p/1?utm_source=youtube')).toBeUndefined()
    expect(parseUtm('不是链接')).toBeUndefined()
  })

  it('联盟码念得出、打得对：全大写、只留字母数字；撞了就 +1', () => {
    expect(affiliateCode({ handle: '@gadget.jonas' })).toBe('GADGETJO10')
    expect(affiliateCode({ handle: '@gadget.jonas', attempt: 1 })).toBe('GADGETJO11')
    expect(affiliateCode({ handle: '中文名' })).toBe('KOL10')
  })
})

describe('订单归因：匹配不上就说匹配不上', () => {
  const links = [
    {
      id: 'tl_1',
      collaboration_id: 'col_1',
      utm: buildUtm({ channel: 'youtube', campaign: 'autumn', collaboration_id: 'col_1' }),
      affiliate_code: 'JONAS10',
    },
    {
      id: 'tl_2',
      collaboration_id: 'col_2',
      utm: buildUtm({ channel: 'instagram', campaign: 'autumn', collaboration_id: 'col_2' }),
    },
  ]

  it('折扣码优先于 UTM，且两条判据都在结果上写清楚', () => {
    const out = attributeOrders(links, [
      {
        id: 'ord_1',
        discount_codes: ['jonas10'],
        landing_site: applyUtm('https://shop.example/p/1', links[1]?.utm as never),
        total: 129,
        currency: 'USD',
      },
    ])
    expect(out.matched[0]).toMatchObject({
      order_id: 'ord_1',
      tracked_link_id: 'tl_1',
      collaboration_id: 'col_1',
      basis: 'affiliate_code',
    })
  })

  it('没有折扣码时按 utm_content 归', () => {
    const out = attributeOrders(links, [
      {
        id: 'ord_2',
        landing_site: applyUtm('https://shop.example/p/1', links[1]?.utm as never),
        total: 59,
        currency: 'USD',
      },
    ])
    expect(out.matched[0]).toMatchObject({ tracked_link_id: 'tl_2', basis: 'utm_content' })
  })

  it('别人家的 utm_content 撞上我们的合作 id 不算（medium 也要对上）', () => {
    const out = attributeOrders(links, [
      {
        id: 'ord_3',
        landing_site:
          'https://shop.example/p/1?utm_source=google&utm_medium=cpc&utm_campaign=autumn&utm_content=col_1',
        total: 59,
        currency: 'USD',
      },
    ])
    expect(out.matched).toEqual([])
    expect(out.unmatched).toEqual(['ord_3'])
  })

  it('归不上的进 unmatched，绝不按时间窗口猜给谁', () => {
    const out = attributeOrders(links, [
      { id: 'ord_4', total: 20, currency: 'USD' },
      { id: 'ord_5', landing_site: 'https://shop.example/p/1', total: 20, currency: 'USD' },
    ])
    expect(out.matched).toEqual([])
    expect(out.unmatched).toEqual(['ord_4', 'ord_5'])
  })

  it('按链接汇总：订单数与收入，归因表那一块直接用', () => {
    const out = attributeOrders(links, [
      { id: 'o1', discount_codes: ['JONAS10'], total: 100.5, currency: 'USD' },
      { id: 'o2', discount_codes: ['JONAS10'], total: 49.5, currency: 'USD' },
    ])
    expect(out.by_link).toEqual([
      {
        tracked_link_id: 'tl_1',
        collaboration_id: 'col_1',
        orders: 2,
        revenue: 150,
        currency: 'USD',
      },
    ])
  })
})
