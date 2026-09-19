/**
 * WP120（69 §5）：**跨岗位禁语**——每条职责的定位里，那几句转向是写死的。
 *
 * 来历是一句亲测记录（69 §0 / docs/66 #1）：让红人营销岗位找红人，回出来的是客服的话。
 * 路由那一半由 `packs/dtc-3c-3p/scenarios/org/positions-stay-in-lane.yml` 钉；
 * 这一组钉的是另一半——**落到那条职责之后，它知道自己不该干什么、该转给谁**。
 *
 * 这几条断言看着像"检查文案"，但它们检查的是一件机制上的事：persona 的第三段
 * （`你不负责` / `Not yours`）是唯一一处告诉模型"这不是你的活"的地方。
 * 删掉那半句不会有任何编译错、任何场景会红——只会在半年后的某次真模型运行里，
 * 红人岗位又开始答退款窗口。所以它必须有一条机器读得懂的护栏。
 */
import { describe, expect, it } from 'vitest'
import {
  bundledPositionOfRole,
  loadBundledPosition,
  loadBundledRole,
  loadBundledRoles,
  personaTextIn,
  roleRouteTerms,
  routeWithinPosition,
  SUPERSEDED_POSITION_IDS,
} from '../src/index.js'

const zhOf = (id: string): string => personaTextIn(loadBundledRole(id).persona, 'zh')
const enOf = (id: string): string => personaTextIn(loadBundledRole(id).persona, 'en')

/** 「你不负责」那一段的正文（到下一个小标题为止）。 */
function notYours(id: string): string {
  const text = zhOf(id)
  const from = text.indexOf('你不负责')
  expect(from).toBeGreaterThanOrEqual(0)
  const to = text.indexOf('怎么做', from)
  return text.slice(from, to < 0 ? undefined : to)
}

describe('跨岗位禁语：每条职责都写死了转给谁（69 §2 第三段）', () => {
  it('红人营销那五条：客户的退款与物流转客服，自己账号发帖转社媒运营', () => {
    for (const id of ['kol.youtube', 'kol.instagram', 'kol.tiktok', 'kol.facebook', 'kol.x']) {
      const seg = notYours(id)
      expect(seg, id).toContain('客服')
      expect(seg, id).toContain('社媒运营')
      // 亲测记录里那句错误的反面：红人的定位里一个"退货窗口"都不该有
      expect(zhOf(id), id).not.toContain('退货窗口')
    }
  })

  it('客服那四条：写开发信转红人营销', () => {
    for (const id of ['dtc.support', 'dtc.live-chat', 'amz.support', 'dtc.community-support']) {
      const seg = notYours(id)
      expect(seg, id).toContain('红人营销')
    }
  })

  it('客服那四条与 36 §13.3 一致：同事教的中文原话一个字都不许进客户屏幕', () => {
    for (const id of ['dtc.support', 'dtc.live-chat', 'amz.support', 'dtc.community-support']) {
      expect(zhOf(id), id).toMatch(/原话.*一个字都不许|一个字都不许.*原话/)
    }
  })

  it('投放那四条：改商品价与促销转网站运营，自己账号发帖转社媒运营', () => {
    for (const id of ['ads.meta', 'ads.google', 'ads.tiktok', 'ads.x']) {
      const seg = notYours(id)
      expect(seg, id).toContain('网站运营')
      expect(seg, id).toContain('社媒运营')
    }
  })

  it('社媒那九条：客户问题一律转客服，哪怕它出现在评论区 / 群里', () => {
    const social = loadBundledRoles().filter((r) => r.domain === 'social')
    expect(social).toHaveLength(9)
    for (const role of social) {
      const seg = notYours(role.id)
      expect(seg, role.id).toContain('客服')
      expect(seg, role.id).toMatch(/评论区|群里/)
    }
  })

  it('设计那五条：挑哪版、上不上线、花多少钱都不是它定的', () => {
    for (const id of [
      'design.dtc',
      'design.amazon',
      'design.social',
      'design.ads',
      'design.exhibition',
    ]) {
      expect(notYours(id), id).toMatch(/挑哪版|上不上线/)
    }
  })

  it('建站那三条：页面里放什么商品、写什么文案、做什么促销都归网站运营', () => {
    for (const id of ['site.shopify-build', 'site.shopify-theme', 'site.shopify-email']) {
      expect(notYours(id), id).toContain('网站运营')
    }
  })

  it('建站内部也分得开：插件那条不去摆小组件（那是网页模板）', () => {
    // 同一个岗位里的两条职责互相点名，与社媒 X / 红人 X 是同一种边界，只是在岗位内部
    expect(notYours('site.shopify-apps')).toContain('网页模板')
    expect(notYours('site.shopify-theme')).toContain('插件')
  })

  it('公关那四条：客户的问题不归它答', () => {
    for (const id of ['pr.press', 'pr.reddit', 'pr.forums', 'pr.monitoring']) {
      expect(notYours(id), id).toContain('客服')
    }
  })

  it('同一个平台名、两个岗位：社媒的 X 与红人的 X 互相点名对方', () => {
    expect(notYours('social.x')).toContain('红人营销')
    expect(notYours('kol.x')).toContain('社媒运营')
  })

  it('英文那份也有「Not yours」那一段（英文界面下送进去的是它）', () => {
    for (const role of loadBundledRoles()) {
      expect(enOf(role.id), role.id).toContain('Not yours')
    }
  })
})

describe('岗位反查（69 §3）', () => {
  it('客服那条最常用的职责反查得到它的岗位', () => {
    expect(bundledPositionOfRole('dtc.support')?.id).toBe('customer-care')
  })

  it('挂在多个岗位里就不猜一个（54 §3）', () => {
    // `dtc.content` 同时在 web-ops 与（已拆掉的）dtc-ops 里；dtc-ops 被跳过之后只剩一个
    expect(bundledPositionOfRole('dtc.content')?.id).toBe('web-ops')
    // 谁都不挂的那两条通用职责：反查不出来
    expect(bundledPositionOfRole('common.member')).toBeUndefined()
  })

  it('已拆掉的岗位模板不参与反查（只可加行的那张表）', () => {
    expect(SUPERSEDED_POSITION_IDS).toContain('dtc-ops')
    // 文件还在、读得进来——契约只加不删
    expect(loadBundledPosition('dtc-ops').id).toBe('dtc-ops')
  })
})

describe('路由那一半：每个岗位一句典型任务落到对的职责上（54 §2）', () => {
  const cases: [string, string, string][] = [
    ['kol-marketing', '在油管上找 20 个粉丝一万到十万的频道，按匹配度排给我', 'kol.youtube'],
    ['customer-care', '客服邮箱里有一笔拒付争议，帮我准备材料', 'dtc.support'],
    ['web-ops', '把 A 商品降价 10%', 'dtc.store'],
    ['social-media', '给我们自己的 Instagram 账号排一条本周的帖子', 'social.meta'],
    ['pr', '看看最近外面有没有人在提我们，负面的挑出来', 'pr.monitoring'],
  ]

  for (const [position_id, text, expected] of cases) {
    it(`${position_id}：「${text}」→ ${expected}`, () => {
      const template = loadBundledPosition(position_id)
      const profiles = template.roles.map((r) => {
        const def = loadBundledRole(r.role)
        return {
          role_id: def.id,
          role_name: def.name.zh,
          terms: roleRouteTerms(def),
          positions: [{ position_id, person_id: 'p_wang' }],
        }
      })
      const out = routeWithinPosition(text, profiles)
      expect(out.picked).toBe(expected)
    })
  }

  it('同一句话换个岗位就不该判得准（判据来自职责定义，不是从话里猜岗位）', () => {
    const template = loadBundledPosition('customer-care')
    const profiles = template.roles.map((r) => {
      const def = loadBundledRole(r.role)
      return {
        role_id: def.id,
        role_name: def.name.zh,
        terms: roleRouteTerms(def),
        positions: [{ position_id: 'customer-care', person_id: 'p_wang' }],
      }
    })
    // 客服的四条职责动作与额度逐字相同，分开它们的只有渠道——不带渠道就该问一句
    expect(routeWithinPosition('客户问退款什么时候到账', profiles).ambiguous).toBe(true)
  })
})
