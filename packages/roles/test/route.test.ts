/**
 * 54 §2（WP69）岗位内路由：**判据全部来自职责定义本身**，限在一个岗位的职责集合内跑。
 *
 * 这一组钉四件事：
 * 1. 同一句话在不同岗位里落到不同职责——路由是"这个岗位下像哪条活"，不是全局分类；
 * 2. 拿不准就不猜：前两名太接近 / 谁都不太像 → 没有 `picked`，候选原样递出去出选择卡；
 * 3. 岗位里只有一条职责时直接走，两条阈值都不看；
 * 4. 通用职责（`common.member` / `common.owner`）不参赛——它什么都沾，让它参赛等于没路由。
 *
 * 判据词一律读真的 yml（`packages/roles/roles/**`）：这条测试的价值就在于"改了职责定义
 * 路由跟着变"，喂假数据等于只测自己。
 */
import { describe, expect, it } from 'vitest'
import { loadBundledPosition, loadBundledRole } from '../src/load.js'
import {
  looksLikeSmallTalk,
  namedRole,
  type RouteRoleProfile,
  roleRouteTerms,
  routeWithinPosition,
  scoreRouteRoles,
  settleCloseCall,
  settleNoHit,
} from '../src/route.js'

/** 一个岗位模板展开成参赛的职责清单（每条都有人在做）。 */
function profilesOf(position_id: string): RouteRoleProfile[] {
  return loadBundledPosition(position_id).roles.map(({ role }) => {
    const def = loadBundledRole(role)
    return {
      role_id: def.id,
      role_name: def.name.zh,
      terms: roleRouteTerms(def),
      positions: [{ position_id: `asg_${def.id}`, person_id: 'p_li' }],
    }
  })
}

const WEB_OPS = profilesOf('web-ops')
const CUSTOMER_CARE = profilesOf('customer-care')

describe('54 §2 同一句话，不同岗位，不同职责', () => {
  it('「客户问退货，改价」在网站运营里是店铺管理的活', () => {
    const out = routeWithinPosition('客户问退货，改价', WEB_OPS)
    expect(out.picked).toBe('dtc.store')
    expect(out.ambiguous).toBe(false)
    // 判据词要能说出来：界面上"路由到 X 职责"旁边显示的就是它
    expect(out.candidates[0]?.why.length).toBeGreaterThan(0)
  })

  /**
   * WP72（56 §4）：客服岗位多了第四条「社群管理」之后，**一句不提渠道的客户问题
   * 在这个岗位里判不准了**——这不是退步，是 54 §2「拿不准就问一句，不猜」。
   *
   * 理由摆在职责定义上：`dtc.community-support` 与 `dtc.support` 的动作 id、额度、
   * 数据域**逐字相同**（56 §4「同一份 caps，不另起」），两条职责真正的差别只有
   * 渠道——邮箱，还是群里。所以"客户问退货"这句话本身确实不带答案，
   * 判给谁都是猜。带上渠道那个词，它立刻判得准（下面两条）。
   */
  it('同一句话在客服岗位里判不准：网站客服与社群管理只差一个渠道（WP72）', () => {
    const out = routeWithinPosition('客户问退货，改价', CUSTOMER_CARE)
    expect(out.picked).toBeUndefined()
    expect(out.ambiguous).toBe(true)
    expect(
      out.candidates
        .slice(0, 2)
        .map((c) => c.role_id)
        .sort(),
    ).toEqual(['dtc.community-support', 'dtc.support'])
    expect(out.reason).toContain('你定')
  })

  it('补上渠道就判得准：「Discord 群里」→ 社群管理（WP72）', () => {
    const out = routeWithinPosition('Discord 群里有人问退货', CUSTOMER_CARE)
    expect(out.picked).toBe('dtc.community-support')
    expect(out.ambiguous).toBe(false)
    // 判据说得出口：命中的就是那条职责 grounding 里的渠道词
    expect(out.candidates[0]?.why.join('')).toContain('Discord')
  })

  it('「把 A 商品降价 10%」→ 店铺管理（54 §5 那条模拟题的第一句）', () => {
    expect(routeWithinPosition('把 A 商品降价 10%', WEB_OPS).picked).toBe('dtc.store')
  })

  it('「客户问退货」在网站运营里仍然只有一条像：店铺管理答不了它', () => {
    // 同一条模拟题的第二句。网站运营岗位里没有客服那几条，所以这句话在这个岗位下
    // 一条都不像——54 §2：看不出来就问一句，不硬塞给店铺管理
    const out = routeWithinPosition('客户问退货', WEB_OPS)
    expect(out.picked).not.toBe('dtc.store')
  })
})

describe('54 §2 拿不准就不猜', () => {
  it('一个判据词都没命中：没有 picked，候选是空的', () => {
    const out = routeWithinPosition('帮我订一下明天的会议室', WEB_OPS)
    expect(out.picked).toBeUndefined()
    expect(out.ambiguous).toBe(true)
    expect(out.candidates).toHaveLength(0)
    expect(out.reason).toContain('先问一句')
  })

  it('哪条都沾一点（第一名份额不够）：出候选，不猜', () => {
    // "商品"三条客服职责各命中一次，谁也不比谁像
    const out = routeWithinPosition('把 A 商品降价 10%', CUSTOMER_CARE)
    expect(out.picked).toBeUndefined()
    expect(out.ambiguous).toBe(true)
    expect(out.candidates.length).toBeGreaterThanOrEqual(2)
    // 候选是排好序的，界面直接拿来当选择卡的选项
    const scores = out.candidates.map((c) => c.score)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    expect(out.reason).toContain('你定')
  })

  it('前两名分差小于 0.15：一样不猜', () => {
    const near: RouteRoleProfile[] = [
      {
        role_id: 'x.one',
        role_name: '甲',
        terms: [{ text: '退款', from: 'action', weight: 2 }],
        positions: [{ position_id: 'asg_1', person_id: 'p_li' }],
      },
      {
        role_id: 'x.two',
        role_name: '乙',
        terms: [
          { text: '退款', from: 'action', weight: 2 },
          { text: '客户', from: 'domain', weight: 0.6 },
        ],
        positions: [{ position_id: 'asg_2', person_id: 'p_li' }],
      },
    ]
    // 乙 2.6 / 甲 2 → 份额 0.57 : 0.43，差 0.14 < 0.15
    const out = routeWithinPosition('客户要退款', near)
    expect(out.picked).toBeUndefined()
    expect(out.ambiguous).toBe(true)
    expect(out.reason).toBe('这件事像「乙」也像「甲」，你定')
  })
})

describe('54 §2 边界', () => {
  it('岗位下只有一条职责：直接走，不看阈值', () => {
    const one = WEB_OPS.slice(0, 1)
    const out = routeWithinPosition('随便一句和这条职责毫无关系的话', one)
    expect(out.picked).toBe(one[0]?.role_id)
    expect(out.ambiguous).toBe(false)
    expect(out.candidates[0]?.score).toBe(1)
  })

  it('通用职责不参赛：岗位里的 common.member 不会被路由到', () => {
    const withCommon: RouteRoleProfile[] = [
      ...WEB_OPS,
      {
        role_id: 'common.member',
        role_name: '普通成员',
        terms: [{ text: '个人任务', from: 'description', weight: 1.2 }],
        positions: [{ position_id: 'asg_m', person_id: 'p_li' }],
      },
    ]
    const out = routeWithinPosition('客户问退货，改价', withCommon)
    expect(out.picked).toBe('dtc.store')
    expect(out.candidates.map((c) => c.role_id)).not.toContain('common.member')
  })

  it('打分函数本身是稳定的：同一句话跑两遍一模一样', () => {
    const a = scoreRouteRoles('客户问退货，改价', WEB_OPS)
    const b = scoreRouteRoles('客户问退货，改价', WEB_OPS)
    expect(a).toEqual(b)
  })
})

describe('WP153：问工作区本身的事，交给「公司设置与授权」', () => {
  const owner: RouteRoleProfile = {
    role_id: 'common.owner',
    role_name: '公司设置与授权',
    terms: [],
    positions: [],
  }
  const analytics: RouteRoleProfile = {
    role_id: 'dtc.analytics',
    role_name: '独立站运营',
    terms: [],
    positions: [],
  }

  it('负责人岗位上问「有哪些岗位和连接」→ 公司设置与授权（不是独立站运营）', () => {
    const out = routeWithinPosition('帮我看看有哪些岗位和连接，最该先处理哪三件事', [
      owner,
      analytics,
    ])
    expect(out.picked).toBe('common.owner')
    expect(out.ambiguous).toBe(false)
  })

  it('别的问法照旧：公司设置与授权不参赛', () => {
    const out = routeWithinPosition('上周的转化率怎么样', [owner, analytics])
    expect(out.picked).toBe('dtc.analytics')
  })

  it('本人没持有公司设置与授权时不走这条', () => {
    const out = routeWithinPosition('有哪些岗位和连接', [analytics])
    expect(out.picked).toBe('dtc.analytics')
  })
})

describe('WP237 同一个人的几条职责打平：不问人，按分高的那条做', () => {
  const REDDIT = ['social.reddit', 'pr.reddit'].map((id) => {
    const def = loadBundledRole(id)
    return {
      role_id: def.id,
      role_name: def.name.zh,
      terms: roleRouteTerms(def),
      positions: [{ position_id: `asg_${def.id}`, person_id: 'p_li' }],
    }
  })

  it('Reddit 运营 + Reddit 营销 合并成一个岗位：「Reddit 调研」打平 → 按模板顺序取第一条，另一条留作「换成」', () => {
    const raw = routeWithinPosition('帮我做一份 Reddit 调研', REDDIT)
    expect(raw.ambiguous).toBe(true)
    const out = settleCloseCall(raw, ['social.reddit', 'pr.reddit'])
    expect(out.ambiguous).toBe(false)
    expect(out.settled).toBe(true)
    // 分数一样时不按 id 字典序（那会落到 pr.reddit），按岗位里职责的先后
    expect(out.picked).toBe('social.reddit')
    expect(out.alternatives?.map((c) => c.role_id)).toEqual(['pr.reddit'])
    expect(out.reason).toContain('按「Reddit 运营」来做的')
    expect(out.reason).toContain('要换成「Reddit 营销」点这里')
  })

  it('谁都不太像（四条各沾一点）照旧拿不准——那时替人选就是瞎猜', () => {
    const raw = routeWithinPosition('把 A 商品降价 10%', CUSTOMER_CARE)
    expect(raw.ambiguous).toBe(true)
    const out = settleCloseCall(
      raw,
      CUSTOMER_CARE.map((r) => r.role_id),
    )
    expect(out.ambiguous).toBe(true)
    expect(out.picked).toBeUndefined()
    expect(out.settled).toBeUndefined()
  })

  it('一个判据词都没命中也照旧拿不准；判得准的原样返回', () => {
    const none = settleCloseCall(routeWithinPosition('嗯', REDDIT))
    expect(none.ambiguous).toBe(true)
    const clear = routeWithinPosition('把 A 商品降价 10%', WEB_OPS)
    expect(settleCloseCall(clear)).toBe(clear)
  })

  it('一句话里点名了某条职责就认它（取最长的名字）', () => {
    const roles = [
      { role_id: 'social.reddit', names: ['Reddit 运营', 'Reddit Ops'] },
      { role_id: 'pr.reddit', names: ['Reddit 营销'] },
    ]
    expect(namedRole('按 Reddit 运营这条来，开始吧。', roles)).toBe('social.reddit')
    expect(namedRole('按reddit营销做', roles)).toBe('pr.reddit')
    expect(namedRole('开始吧', roles)).toBeUndefined()
  })
})

describe('WP237（Fable 代定）一个都没命中：按岗位里职责的先后取第一条；打招呼不算交活', () => {
  const duties = [
    { role_id: 'social.reddit', role_name: 'Reddit 运营' },
    { role_id: 'pr.reddit', role_name: 'Reddit 营销' },
  ]

  it('没命中 → 第一条，其余留作「换成」', () => {
    const out = settleNoHit({ candidates: [], ambiguous: true, reason: '' }, duties)
    expect(out.picked).toBe('social.reddit')
    expect(out.ambiguous).toBe(false)
    expect(out.alternatives?.map((c) => c.role_id)).toEqual(['pr.reddit'])
    expect(out.reason).toContain(
      '看不出更像哪条，先按「Reddit 运营」来做的；要换成「Reddit 营销」点这里',
    )
  })

  it('谁都不太像（有候选但都弱）不归它管，原样返回', () => {
    const raw = routeWithinPosition('把 A 商品降价 10%', CUSTOMER_CARE)
    expect(settleNoHit(raw, duties)).toBe(raw)
  })

  it('打招呼 / 客套 / 应一声是 small talk；正经话不是', () => {
    for (const t of ['你好', '您好！', 'hi', 'Hello~', '在吗？', '谢谢', '嗯嗯', '好的。', ''])
      expect(looksLikeSmallTalk(t)).toBe(true)
    for (const t of ['整理一下', '看看这周', '你好，帮我查下订单', '开始吧'])
      expect(looksLikeSmallTalk(t)).toBe(false)
  })
})
