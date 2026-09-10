/**
 * 任务路由：判据全部来自职责定义本身（04 / 05），所以这份用例用的是 packs 里
 * 那三份真定义的字段——改了职责定义，路由跟着变，不用改代码。
 */
import { describe, expect, it } from 'vitest'
import {
  forbiddenTools,
  MIN_CONFIDENCE,
  roleTermsOf,
  routeTask,
  SECRETARY_TOOLS,
} from '../src/index.js'
import { ADS, AFTERSALES, OPS, roleProfile } from './helpers.js'

const ROLES = [
  roleProfile(AFTERSALES, [{ position_id: 'a_chen', person_id: 'p_chen' }]),
  roleProfile(OPS, [{ position_id: 'a_li', person_id: 'p_li' }]),
  roleProfile(ADS, [{ position_id: 'a_wu', person_id: 'p_wu' }]),
]

describe('从职责定义里抽判据词', () => {
  it('名字、description 的短语、grounding 的意图词、动作 id、数据域都算', () => {
    const terms = roleTermsOf(AFTERSALES).map((t) => t.text)
    expect(terms).toContain('独立站售后客服')
    expect(terms).toContain('退款')
    expect(terms).toContain('改地址')
    expect(terms).toContain('包裹')
    // stage_refund 那个动作带出来的人话词
    expect(terms).toContain('退钱')
    // scopes.order 带出来的
    expect(terms).toContain('订单')
  })

  it('单字判据词（`退`）权重被压低', () => {
    const short = roleTermsOf(AFTERSALES).find((t) => t.text === '退')
    const long = roleTermsOf(AFTERSALES).find((t) => t.text === '退款')
    expect(short).toBeDefined()
    expect(short?.weight ?? 0).toBeLessThan(long?.weight ?? 0)
  })
})

describe('一件活该谁做', () => {
  it('客户投诉包裹破损要退款 → 售后，出的是一件活不是一个问题', () => {
    const v = routeTask({ text: '这个客户投诉说包裹破损，要退款，处理一下', roles: ROLES })
    expect(v.kind).toBe('task')
    expect(v.role_id).toBe('dtc.aftersales')
    expect(v.owner).toBe('p_chen')
    expect(v.confidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE)
    expect(v.reason).toContain('独立站售后客服')
  })

  it('改详情页价格 → 运营', () => {
    const v = routeTask({ text: '把主推款的详情页价格改一下', roles: ROLES })
    expect(v.role_id).toBe('dtc.ops')
    expect(v.owner).toBe('p_li')
  })

  it('把低效广告暂停、加否词 → 投放', () => {
    const v = routeTask({ text: '把那条低效广告暂停，顺便加几个否词', roles: ROLES })
    expect(v.role_id).toBe('ads.performance')
    expect(v.owner).toBe('p_wu')
  })

  it('看不出属于谁就不指名（进"没人认领"的车道）', () => {
    const v = routeTask({ text: '帮我订个会议室', roles: ROLES })
    expect(v.role_id).toBeUndefined()
    expect(v.owner).toBeUndefined()
    expect(v.reason).toContain('没人认领')
  })
})

describe('专业问题不是一件活', () => {
  it('「退货窗口外能不能退？」判成问题，转售后', () => {
    const v = routeTask({ text: '退货窗口外能不能退？', roles: ROLES })
    expect(v.kind).toBe('question')
    expect(v.role_id).toBe('dtc.aftersales')
    expect(v.reason).toContain('专业问题')
  })

  it('分不清的时候当成一件活（出一张等人认领的卡比替人回答安全）', () => {
    expect(routeTask({ text: '把这个客户投诉处理一下', roles: ROLES }).kind).toBe('task')
  })
})

describe('通用职责不参赛', () => {
  it('common.member / common.owner 不参与路由竞争', () => {
    const withCommon = [
      ...ROLES,
      {
        role_id: 'common.member',
        role_name: '工作区成员',
        terms: roleTermsOf({ id: 'common.member', description: '个人任务、退款、广告、详情页' }),
        positions: [{ position_id: 'a_x', person_id: 'p_x' }],
      },
    ]
    const v = routeTask({ text: '客户要退款', roles: withCommon })
    expect(v.role_id).toBe('dtc.aftersales')
    expect(v.scores.some((s) => s.role_id === 'common.member')).toBe(false)
  })
})

describe('秘书的工具面是只读的（41 §1.4）', () => {
  it('白名单里没有任何 connect.* 或写外部系统的动作', () => {
    expect(forbiddenTools([...SECRETARY_TOOLS])).toEqual([])
    expect(SECRETARY_TOOLS.some((t) => t.startsWith('connect.'))).toBe(false)
  })

  it('混进一个写外部系统的动作会被抓出来', () => {
    expect(forbiddenTools(['connect.proxy'])).toEqual(['connect.proxy'])
    expect(forbiddenTools(['send_email'])).toEqual(['send_email'])
    expect(forbiddenTools(['stage_refund'])).toEqual(['stage_refund'])
  })

  it('唯一的写动作是"写本人自己的日历"', () => {
    expect(SECRETARY_TOOLS.filter((t) => t.includes('write'))).toEqual(['calendar.write_own'])
  })
})
