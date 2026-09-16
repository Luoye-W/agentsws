import { SOCIAL_CHANNELS, socialChannelsOfGroup } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { loadBundledPosition, loadBundledRole } from '../src/index.js'

/** 九条职责按契约那张表读进来——**渠道清单只有那一份**（56 §2）。 */
const ROLES = SOCIAL_CHANNELS.map((c) => loadBundledRole(c.role_id))
const CONTENT = socialChannelsOfGroup('content').map((c) => loadBundledRole(c.role_id))
const COMMUNITY = socialChannelsOfGroup('community').map((c) => loadBundledRole(c.role_id))

describe('56 §2 九条渠道职责（WP72）', () => {
  it('九条都装得进来，domain 都是 social，id 与契约那张表对得上', () => {
    expect(ROLES.map((r) => r.id)).toEqual([
      'social.meta',
      'social.tiktok',
      'social.x',
      'social.youtube',
      'social.facebook-group',
      'social.reddit',
      'social.discord',
      'social.telegram-group',
      'social.whatsapp',
    ])
    expect(ROLES.every((r) => r.domain === 'social')).toBe(true)
  })

  it('每一条的连接器与契约那张表一个字不差（YouTube 与红人共用一张卡）', () => {
    for (const spec of SOCIAL_CHANNELS) {
      const role = loadBundledRole(spec.role_id)
      expect(
        role.connectors.map((c) => c.kind),
        spec.role_id,
      ).toEqual(spec.connector_kind === undefined ? [] : [spec.connector_kind])
    }
    // 56 §1：一把 key 管两条职责——两边写的是同一个 kind，不是两张 YouTube 卡
    expect(loadBundledRole('social.youtube').connectors[0]?.kind).toBe(
      loadBundledRole('kol.youtube').connectors[0]?.kind,
    )
  })

  it('Facebook 群组：没有连接卡 + `mode: browser`（Groups API 已停，56 §1）', () => {
    const role = loadBundledRole('social.facebook-group')
    expect(role.connectors).toEqual([])
    // 空的 `connectors` 有两种含义，`mode` 这一格才分得开"没连"与"没得连"
    expect(role.mode).toBe('browser')
    // 别的八条不写 `mode`（= api）
    for (const r of ROLES.filter((x) => x.id !== 'social.facebook-group'))
      expect(r.mode, r.id).toBeUndefined()
  })

  it('九条的连接器都不是必需的：没连也能排、能写、能攒审批', () => {
    for (const role of ROLES)
      expect(
        role.connectors.every((c) => c.required === false),
        role.id,
      ).toBe(true)
  })
})

describe('56 §2 内容账号组四条（发布永远 L1）', () => {
  it('三个写动作、额度是 56 §7 那两个数', () => {
    for (const role of CONTENT) {
      expect(
        role.actions.map((a) => a.id),
        role.id,
      ).toEqual(['stage_post', 'reply_comment', 'stage_profile_edit'])
      // 发帖 3 / 天、回评论 50 / 天（56 §7）
      expect(role.actions[0]?.mandate.caps, role.id).toMatchObject({ max_posts_per_day: 3 })
      expect(role.actions[0]?.mandate.window, role.id).toEqual({ max_count: 3, per: 'day' })
      expect(role.actions[1]?.mandate.caps, role.id).toMatchObject({
        max_comment_replies_per_day: 50,
      })
      expect(role.actions[1]?.mandate.window, role.id).toEqual({ max_count: 50, per: 'day' })
    }
  })

  it('发布与改资料永远人审；回评论 L2 → L3', () => {
    for (const role of CONTENT) {
      expect(role.automation.stage_post?.ceiling, role.id).toBe('L1')
      expect(role.automation.stage_post?.hard_ceiling, role.id).toBe(true)
      expect(
        role.actions.find((a) => a.id === 'stage_post')?.review_cannot_be_disabled,
        role.id,
      ).toBe(true)
      expect(role.automation.stage_profile_edit?.hard_ceiling, role.id).toBe(true)
      expect(role.automation.reply_comment?.initial, role.id).toBe('L2')
      expect(role.automation.reply_comment?.ceiling, role.id).toBe('L3')
    }
  })

  it('改账号名连提都不许提：handle 在受保护字段里', () => {
    for (const role of CONTENT) {
      const fields = role.actions.find((a) => a.id === 'stage_profile_edit')?.protected_fields ?? []
      for (const f of ['handle', 'username', 'account_id', 'external_id'])
        expect(fields, role.id).toContain(f)
    }
  })

  it('读不到群成员名册：内容组的 scopes 里没有 `community_member`', () => {
    for (const role of CONTENT) {
      const domains = role.scopes.map((s) => s.domain)
      expect(domains, role.id).toContain('social_account')
      expect(domains, role.id).toContain('community_thread')
      expect(domains, role.id).not.toContain('community_member')
      // 社媒运营一辈子不该改一件商品
      expect(role.scopes.find((s) => s.domain === 'product')?.ops, role.id).toEqual(['read'])
    }
  })
})

describe('56 §2 社群组五条（群发永远 L1）', () => {
  it('五个写动作、额度是 56 §7 那三个数', () => {
    for (const role of COMMUNITY) {
      expect(
        role.actions.map((a) => a.id),
        role.id,
      ).toEqual([
        'approve_member',
        'stage_broadcast',
        'reply_thread',
        'stage_rules_edit',
        'moderate',
      ])
      const caps = (id: string): Record<string, unknown> =>
        role.actions.find((a) => a.id === id)?.mandate.caps ?? {}
      // 群发 1 / 周、私信 30 / 天、审核动作 20 / 天
      expect(caps('stage_broadcast'), role.id).toMatchObject({ max_broadcasts_per_week: 1 })
      expect(caps('reply_thread'), role.id).toMatchObject({ max_dm_per_day: 30 })
      expect(caps('moderate'), role.id).toMatchObject({ max_moderations_per_day: 20 })
    }
  })

  it('群发与改群规永远人审；入群审核与管理动作 L2；私信 L2 → L3', () => {
    for (const role of COMMUNITY) {
      expect(role.automation.stage_broadcast?.ceiling, role.id).toBe('L1')
      expect(role.automation.stage_broadcast?.hard_ceiling, role.id).toBe(true)
      expect(
        role.actions.find((a) => a.id === 'stage_broadcast')?.review_cannot_be_disabled,
        role.id,
      ).toBe(true)
      expect(role.automation.stage_rules_edit?.hard_ceiling, role.id).toBe(true)
      expect(role.automation.approve_member?.ceiling, role.id).toBe('L2')
      // 封禁那一档由 guardrail 按 `after.action` 升 L1，职责这一层只写到 L2
      expect(role.automation.moderate?.ceiling, role.id).toBe('L2')
      expect(role.automation.reply_thread?.initial, role.id).toBe('L2')
      expect(role.automation.reply_thread?.ceiling, role.id).toBe('L3')
    }
  })

  it('改群规先读全（`requires_record_read`），换群是受保护字段', () => {
    for (const role of COMMUNITY) {
      const rules = role.actions.find((a) => a.id === 'stage_rules_edit')
      expect(rules?.requires_record_read, role.id).toBe(true)
      expect(rules?.protected_fields, role.id).toContain('account_id')
      expect(
        role.actions.find((a) => a.id === 'stage_broadcast')?.protected_fields,
        role.id,
      ).toContain('account_id')
    }
  })

  it('社群组读得到成员名册（内容组读不到）', () => {
    for (const role of COMMUNITY) {
      const domains = role.scopes.map((s) => s.domain)
      expect(domains, role.id).toContain('community_member')
      expect(domains, role.id).toContain('community_thread')
    }
  })

  it('WhatsApp 多两格：模板消息 100 / 天 + 必须 opt-in（56 §1 / §7）', () => {
    const caps = loadBundledRole('social.whatsapp').actions.find((a) => a.id === 'stage_broadcast')
      ?.mandate.caps
    expect(caps).toMatchObject({
      max_broadcasts_per_week: 1,
      max_template_messages_per_day: 100,
      opt_in_required: true,
    })
    // 别的四条没有这两格——那是 Meta 的规矩，不是所有社群渠道的规矩
    for (const role of COMMUNITY.filter((r) => r.id !== 'social.whatsapp')) {
      const other = role.actions.find((a) => a.id === 'stage_broadcast')?.mandate.caps ?? {}
      expect(other.opt_in_required, role.id).toBeUndefined()
      expect(other.max_template_messages_per_day, role.id).toBeUndefined()
    }
  })
})

describe('56 边界：客户的问题转客服（54 §2 路由靠 description 与意图词）', () => {
  it('九条的 description 里都写着"客户的问题不归我，转客服"', () => {
    for (const role of ROLES) expect(role.description, role.id).toContain('客户的问题不归我')
  })

  it('九条都带一条"转客服"的 grounding，意图词涵盖订单 / 退款 / 物流', () => {
    for (const role of ROLES) {
      const g = role.grounding?.find((x) => x.name === 'customer_question_goes_to_support')
      expect(g, role.id).toBeDefined()
      expect(g?.tool, role.id).toBe('route_to_community_support')
      for (const t of ['订单', '退款', '物流']) expect(g?.intent_terms, role.id).toContain(t)
    }
  })

  it('九条职责的意图词两两不同——在一个岗位里它是唯一分得开它们的东西', () => {
    const firsts = ROLES.map((r) => r.grounding?.[0]?.name)
    expect(new Set(firsts).size).toBe(ROLES.length)
    // 每条的第一组意图词里都得有这条渠道自己的名字
    expect(loadBundledRole('social.discord').grounding?.[0]?.intent_terms).toContain('Discord')
    expect(loadBundledRole('social.reddit').grounding?.[0]?.intent_terms).toContain('Reddit')
  })
})

describe('56 §4 客服的第四条职责：社群管理', () => {
  const role = () => loadBundledRole('dtc.community-support')

  it('动作与额度沿用 `dtc.support` 那一份，一个数都不差', () => {
    const community = role()
    const support = loadBundledRole('dtc.support')
    expect(community.actions.map((a) => a.id)).toEqual(support.actions.map((a) => a.id))
    for (const a of support.actions) {
      const same = community.actions.find((x) => x.id === a.id)
      // 同一个客户在邮件里问和在群里问，能拿到的补偿必须一样
      expect(same?.mandate, a.id).toEqual(a.mandate)
    }
  })

  it('读线程、不读成员名册（56 §4）', () => {
    const domains = role().scopes.map((s) => s.domain)
    expect(domains).toContain('community_thread')
    expect(domains).not.toContain('community_member')
    // 订单那一侧与网站客服一样
    expect(domains).toContain('order')
    expect(role().scopes.find((s) => s.domain === 'order')?.ops).toEqual(['read'])
  })

  it('回复 L2 → L3（群里的一条回复所有人都看得见）', () => {
    expect(role().automation.reply_customer?.initial).toBe('L2')
    expect(role().automation.reply_customer?.ceiling).toBe('L3')
    // `target` 与 `dtc.support` 那条一模一样（47 的登记表按动作 id 归并，
    // 同一个 id 指向两个对象的话，网站客服会莫名其妙丢掉这条动作）
    expect(role().actions.find((a) => a.id === 'reply_customer')?.target).toBe('customer')
    // 回到哪条线程去是**读域**的事：`community_thread` 在 scopes 里
    expect(role().scopes.map((s) => s.domain)).toContain('community_thread')
  })

  it('description 里写清两边的分界（54 §2 的路由判据）', () => {
    expect(role().description).toContain('客户的问题归我')
    expect(role().description).toContain('社媒运营')
  })

  it('八张社媒卡全是可选的：一张都没连，转客服卡照样进得来', () => {
    const optional = role().connectors.filter((c) => !c.required)
    for (const kind of [
      'meta_graph',
      'tiktok_content',
      'x_api',
      'youtube_data',
      'reddit',
      'discord_bot',
      'telegram_bot',
      'whatsapp_business',
    ])
      expect(optional.map((c) => c.kind)).toContain(kind)
    // 订单、退款、折扣码那张卡是必需的——答客户问题离不开它
    expect(
      role()
        .connectors.filter((c) => c.required)
        .map((c) => c.kind),
    ).toEqual(['shopify'])
  })
})

describe('56 §2 / §4 两个岗位模板', () => {
  it('社媒运营 = 九条，默认勾 Meta / TikTok / YouTube（56 §6）', () => {
    const position = loadBundledPosition('social-media')
    expect(position.name.zh).toBe('社媒运营')
    expect(position.roles.map((r) => r.role)).toEqual(SOCIAL_CHANNELS.map((c) => c.role_id))
    expect(position.roles.filter((r) => r.default).map((r) => r.role)).toEqual([
      'social.meta',
      'social.tiktok',
      'social.youtube',
    ])
  })

  it('客服 = 四条，社群管理默认也勾上（56 §4）', () => {
    const position = loadBundledPosition('customer-care')
    expect(position.roles.map((r) => r.role)).toEqual([
      'dtc.support',
      'dtc.live-chat',
      'amz.support',
      'dtc.community-support',
    ])
    expect(position.roles.every((r) => r.default)).toBe(true)
  })
})
