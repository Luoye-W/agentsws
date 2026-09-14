import { describe, expect, it } from 'vitest'
import {
  AMAZON_MARKETPLACE_TLDS,
  AMAZON_MESSAGE_ACTIONS,
  AMAZON_SLA_CRITICAL_MINUTES,
  AMAZON_SLA_REMINDER_MINUTES,
  AMAZON_SLA_WINDOW_MINUTES,
  amazonSlaCardTitle,
  buildAmazonChannelMeta,
  buildAmazonRewriteInstruction,
  detectAmazonChannel,
  evaluateAmazonOutbound,
  evaluateAmazonSlaCycle,
  hasRewritableAmazonViolation,
  isAmazonRelatedSenderDomain,
  isMarketplaceRelayAddress,
  maskAmazonRelayAddress,
  readAmazonSlaAnchor,
} from '../src/index.js'

const RELAY = 'a1b2c3d4e5f6@marketplace.amazon.com'

const inbound = (over: Partial<Parameters<typeof detectAmazonChannel>[0]> = {}) => ({
  from_email: RELAY,
  from_name: 'Anna',
  subject: 'Re: Your Amazon order 113-1234567-1234567',
  body_text: 'The charger does not fit. Please help.',
  ...over,
})

describe('Amazon 渠道识别（48 §4 L3 #2）', () => {
  it('22 个 marketplace 域一个不少，且不含 cn', () => {
    expect(AMAZON_MARKETPLACE_TLDS).toHaveLength(22)
    expect(AMAZON_MARKETPLACE_TLDS).not.toContain('cn')
  })

  it('L1：From 命中 relay 域 + 认证非 fail → 买家消息', () => {
    const d = detectAmazonChannel(inbound())
    expect(d?.message_type).toBe('buyer_message')
    expect(d?.marketplace).toBe('com')
    expect(d?.relay_address).toBe(RELAY)
    expect(d?.default_language).toBe('en')
    expect(d?.order_ids).toEqual(['113-1234567-1234567'])
    expect(d?.confidence).toBeGreaterThanOrEqual(90)
  })

  it('L1：From 不是 relay、Reply-To 是 → 照样命中，并留 relay_from_reply_to 信号', () => {
    const d = detectAmazonChannel(
      inbound({
        from_email: 'buyer@gmail.com',
        reply_to_email: 'zzzz1111yyyy@marketplace.amazon.de',
      }),
    )
    expect(d?.message_type).toBe('buyer_message')
    expect(d?.marketplace).toBe('de')
    expect(d?.default_language).toBe('de')
    expect(d?.signals).toContain('relay_from_reply_to')
  })

  it('L2：amazon.<tld> 系统域 → 系统通知；community-help@ → 公共问答', () => {
    expect(
      detectAmazonChannel(inbound({ from_email: 'order-update@amazon.co.jp' }))?.message_type,
    ).toBe('amazon_system')
    expect(
      detectAmazonChannel(inbound({ from_email: 'community-help@amazon.com' }))?.message_type,
    ).toBe('amazon_qa')
  })

  it('marketplace 子域下本地部分不合 relay 格式的地址整体不命中（不被 L2 兜成系统信）', () => {
    expect(
      detectAmazonChannel(inbound({ from_email: 'short@marketplace.amazon.com' })),
    ).toBeUndefined()
    // 但粗判据认得它——垃圾箱扫描要看一眼
    expect(isAmazonRelatedSenderDomain('short@marketplace.amazon.com')).toBe(true)
  })

  it('伪造域名不命中：marketplace.amazon.com.evil.ru', () => {
    expect(isMarketplaceRelayAddress('a1b2c3d4e5f6@marketplace.amazon.com.evil.ru')).toBe(false)
    expect(
      detectAmazonChannel(inbound({ from_email: 'a1b2c3d4e5f6@marketplace.amazon.com.evil.ru' })),
    ).toBeUndefined()
  })

  it('认证显式 fail → phishing_suspect，绝不静默丢；softfail / 缺头不算 fail', () => {
    const fail = detectAmazonChannel(inbound({ authentication_results: 'spf=fail (sender ip)' }))
    expect(fail?.message_type).toBe('phishing_suspect')
    expect(fail?.matched_rule).toBe('l1_auth_fail')
    expect(
      detectAmazonChannel(inbound({ authentication_results: 'spf=softfail' }))?.message_type,
    ).toBe('buyer_message')
    expect(detectAmazonChannel(inbound({ authentication_results: null }))?.message_type).toBe(
      'buyer_message',
    )
  })

  it('钓鱼启发：自称 + 危险动作两类同时命中才升级；只有一类只当日常句子', () => {
    const both = detectAmazonChannel(
      inbound({
        body_text: 'This is Amazon customer service. Please click the link to verify your account.',
      }),
    )
    expect(both?.message_type).toBe('phishing_suspect')
    const one = detectAmazonChannel(
      inbound({ body_text: 'I contacted Amazon customer service yesterday.' }),
    )
    expect(one?.message_type).toBe('buyer_message')
  })

  it('opt-out 与退信在买家消息之前判；returns/claims 要类别词 + 订单号双条件', () => {
    expect(
      detectAmazonChannel(inbound({ body_text: 'The buyer has chosen to opt out of messages.' }))
        ?.message_type,
    ).toBe('buyer_opt_out')
    expect(
      detectAmazonChannel(
        inbound({ body_text: 'A-to-z guarantee claim opened.', subject: 'claim' }),
      )?.message_type,
    ).toBe('buyer_message') // 没订单号 → 不定案成索赔
    expect(
      detectAmazonChannel(inbound({ body_text: 'A-to-z guarantee claim for 113-1234567-1234567.' }))
        ?.message_type,
    ).toBe('a2z_claim')
  })

  it('L3 只增信不定案：commMgrTok 与订单号只进 signals', () => {
    const d = detectAmazonChannel(
      inbound({ body_text: 'hello [commMgrTok: abc123] 113-1234567-1234567' }),
    )
    expect(d?.message_type).toBe('buyer_message')
    expect(d?.comm_mgr_tok).toBe('abc123')
    expect(d?.signals).toContain('comm_mgr_tok')
  })

  it('relay 地址打码后不含完整本地部分', () => {
    const masked = maskAmazonRelayAddress(RELAY)
    expect(masked).toMatch(/^a1b2\*+@marketplace\.amazon\.com$/)
  })

  it('channel_meta：只有买家消息族写 last_buyer_message_at，系统通知不写', () => {
    const buyer = detectAmazonChannel(inbound())
    expect(buyer).toBeDefined()
    const meta = buildAmazonChannelMeta(
      buyer as NonNullable<typeof buyer>,
      '2026-09-07T09:00:00.000Z',
    )
    expect(meta.last_buyer_message_at).toBe('2026-09-07T09:00:00.000Z')
    expect(meta.relay_address).toBe(RELAY)

    const system = detectAmazonChannel(inbound({ from_email: 'order-update@amazon.com' }))
    expect(system).toBeDefined()
    const sysMeta = buildAmazonChannelMeta(
      system as NonNullable<typeof system>,
      '2026-09-07T10:00:00.000Z',
    )
    expect('last_buyer_message_at' in sysMeta).toBe(false)
    // relay 地址缺省而不是写 null：照写 null 会把线程的回信目标抹掉
    expect('relay_address' in sysMeta).toBe(false)
  })

  it('动作表：钓鱼与只读上下文类绝不生成草稿', () => {
    expect(AMAZON_MESSAGE_ACTIONS.phishing_suspect.generates_draft).toBe(false)
    expect(AMAZON_MESSAGE_ACTIONS.phishing_suspect.needs_human_review).toBe(true)
    expect(AMAZON_MESSAGE_ACTIONS.a2z_claim.generates_draft).toBe(false)
    expect(AMAZON_MESSAGE_ACTIONS.buyer_message.restarts_sla).toBe(true)
    expect(AMAZON_MESSAGE_ACTIONS.refund_notice.restarts_sla).toBe(false)
  })
})

const outbound = (over: Partial<Parameters<typeof evaluateAmazonOutbound>[1]> = {}) => ({
  to_address: RELAY,
  subject: 'Re: Your Amazon order',
  original_subject: 'Your Amazon order',
  body_text: 'We received your message about order 113-1234567-1234567 and will look into it.',
  is_reply_to_buyer_thread: true,
  ...over,
})

describe('Amazon 出站硬闸（拦下 = 打回重写，不静默删改）', () => {
  it('干净正文放行，且恒要求纯文本', () => {
    const r = evaluateAmazonOutbound('amazon', outbound())
    expect(r.ok).toBe(true)
    expect(r.ok === true && r.send_as_plain_text).toBe(true)
  })

  it('外链拦，amazon.<tld> 自家链接放行', () => {
    const bad = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'See https://brandsite.com/promo' }),
    )
    expect(bad.ok).toBe(false)
    expect(bad.ok === false && bad.violations[0]?.code).toBe('external_link')
    expect(
      evaluateAmazonOutbound('amazon', outbound({ body_text: 'See https://www.amazon.de/orders' }))
        .ok,
    ).toBe(true)
  })

  it('订单号不被误判成电话号码（否则是修不好的重写死循环）', () => {
    const r = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'Order 113-1234567-1234567 is on the way.' }),
    )
    expect(r.ok).toBe(true)
  })

  it('邮箱地址拦，但买家自己的 relay alias 不算站外联系方式', () => {
    const bad = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'Write to us at help@brand.com' }),
    )
    expect(bad.ok === false && bad.violations.some((v) => v.code === 'email_address')).toBe(true)
    // 证据里只留域名侧片段：完整邮箱不进卡片与日志
    const evidence =
      bad.ok === false
        ? (bad.violations.find((v) => v.code === 'email_address')?.evidence ?? '')
        : ''
    expect(evidence).toBe('***@brand.com')
    const ok = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: `Replying to ${RELAY} as requested.` }),
    )
    expect(ok.ok).toBe(true)
  })

  it('营销语、诱评、emoji、[Important] 各拦一条', () => {
    const marketing = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'Use our promo code SAVE10.' }),
    )
    expect(
      marketing.ok === false && marketing.violations.some((v) => v.code === 'marketing_content'),
    ).toBe(true)
    const review = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'Please leave us a 5 star review.' }),
    )
    expect(
      review.ok === false && review.violations.some((v) => v.code === 'review_manipulation'),
    ).toBe(true)
    const emoji = evaluateAmazonOutbound('amazon', outbound({ body_text: 'Sorry about that 😀' }))
    expect(emoji.ok === false && emoji.violations.some((v) => v.code === 'emoji')).toBe(true)
    const marker = evaluateAmazonOutbound(
      'amazon',
      outbound({ subject: '[Important] Re: Your Amazon order' }),
    )
    expect(
      marker.ok === false && marker.violations.some((v) => v.code === 'important_marker'),
    ).toBe(true)
  })

  it('主题改写与缺 Re: 前缀都拦', () => {
    const rewritten = evaluateAmazonOutbound(
      'amazon',
      outbound({ subject: 'Re: A different subject' }),
    )
    expect(
      rewritten.ok === false && rewritten.violations.some((v) => v.code === 'subject_rewritten'),
    ).toBe(true)
    const noPrefix = evaluateAmazonOutbound('amazon', outbound({ subject: 'Your Amazon order' }))
    expect(
      noPrefix.ok === false && noPrefix.violations.some((v) => v.code === 'subject_rewritten'),
    ).toBe(true)
  })

  it('附件类型与追踪像素拦；改正文改不掉的那几条不进重写指令', () => {
    const attach = evaluateAmazonOutbound('amazon', {
      ...outbound(),
      attachments: [
        { filename: 'a.exe', size_bytes: 10, content_type: 'application/octet-stream' },
      ],
    })
    expect(attach.ok === false && attach.violations.some((v) => v.code === 'attachment_type')).toBe(
      true,
    )
    expect(attach.ok === false && hasRewritableAmazonViolation(attach.violations)).toBe(false)
    expect(attach.ok === false && buildAmazonRewriteInstruction(attach.violations)).not.toContain(
      '附件类型',
    )

    const pixel = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_html: '<img src="https://amazon.com/p.gif" width="1" height="1">' }),
    )
    expect(pixel.ok === false && pixel.violations.some((v) => v.code === 'tracking_pixel')).toBe(
      true,
    )
  })

  it('重写指令带上每一条可重写违规的中文原因（喂回模型）', () => {
    const bad = evaluateAmazonOutbound(
      'amazon',
      outbound({ body_text: 'Visit our store at https://brand.com 😀' }),
    )
    expect(bad.ok).toBe(false)
    const instruction = bad.ok === false ? buildAmazonRewriteInstruction(bad.violations) : ''
    expect(instruction).toContain('已被出站守卫拦下')
    expect(instruction).toContain('外部链接')
    expect(instruction).toContain('emoji')
  })
})

const slaState = (over: Record<string, unknown> = {}) => ({
  thread_id: 'thr_1',
  last_buyer_message_at: '2026-09-07T00:00:00.000Z',
  ...over,
})

describe('Amazon 24h SLA 三档（唯一时钟锚 + 三个幂等字段）', () => {
  it('三档阈值就是 1440 / 720 / 240 分钟', () => {
    expect(AMAZON_SLA_WINDOW_MINUTES).toBe(1440)
    expect(AMAZON_SLA_REMINDER_MINUTES).toBe(720)
    expect(AMAZON_SLA_CRITICAL_MINUTES).toBe(240)
  })

  it('无锚 = 原地不动（只读上下文线程天然不进表）', () => {
    expect(evaluateAmazonSlaCycle({ thread_id: 't' }, '2026-09-07T09:00:00.000Z').kind).toBe('none')
    expect(readAmazonSlaAnchor({ marketplace: 'com' })).toBeUndefined()
    expect(readAmazonSlaAnchor({ last_buyer_message_at: '2026-09-07T00:00:00.000Z' })).toBe(
      Date.parse('2026-09-07T00:00:00.000Z'),
    )
  })

  it('剩余 > 12h 不出卡；≤ 12h 出提醒；≤ 4h 出告警并吸收提醒档', () => {
    expect(evaluateAmazonSlaCycle(slaState(), '2026-09-07T06:00:00.000Z').kind).toBe('none')
    const reminder = evaluateAmazonSlaCycle(slaState(), '2026-09-07T13:00:00.000Z')
    expect(reminder.kind).toBe('reminder')
    const critical = evaluateAmazonSlaCycle(slaState(), '2026-09-07T21:00:00.000Z')
    expect(critical.kind).toBe('critical')
    expect(critical.kind === 'critical' && critical.absorbs_reminder).toBe(true)
  })

  it('幂等：本轮出过的卡不再出；新一轮买家来信把锚推前 = 自动重新武装', () => {
    const fired = slaState({ reminder_fired_at: '2026-09-07T13:00:00.000Z' })
    expect(evaluateAmazonSlaCycle(fired, '2026-09-07T14:00:00.000Z').kind).toBe('none')
    const nextCycle = slaState({
      last_buyer_message_at: '2026-09-08T00:00:00.000Z',
      reminder_fired_at: '2026-09-07T13:00:00.000Z',
    })
    expect(evaluateAmazonSlaCycle(nextCycle, '2026-09-08T13:00:00.000Z').kind).toBe('reminder')
  })

  it('回了就闭账并收掉还开着的卡；窗口内 within、窗口外 miss', () => {
    const within = evaluateAmazonSlaCycle(
      slaState({ last_outbound_at: '2026-09-07T05:00:00.000Z' }),
      '2026-09-07T06:00:00.000Z',
    )
    expect(within.kind === 'account' && within.outcome).toBe('within')
    expect(within.kind === 'account' && within.resolves_open_cards).toBe(true)
    const miss = evaluateAmazonSlaCycle(
      slaState({ last_outbound_at: '2026-09-08T05:00:00.000Z' }),
      '2026-09-08T06:00:00.000Z',
    )
    expect(miss.kind === 'account' && miss.outcome).toBe('miss')
  })

  it('没回且过了截止：先出告警，告警出过之后闭账 miss', () => {
    const late = evaluateAmazonSlaCycle(slaState(), '2026-09-08T02:00:00.000Z')
    expect(late.kind).toBe('critical')
    const accounted = evaluateAmazonSlaCycle(
      slaState({ escalation_fired_at: '2026-09-08T02:00:00.000Z' }),
      '2026-09-08T03:00:00.000Z',
    )
    expect(accounted.kind === 'account' && accounted.outcome).toBe('miss')
  })

  it('卡片标题同周期逐字相同、跨周期必不同', () => {
    const a = evaluateAmazonSlaCycle(slaState(), '2026-09-07T13:00:00.000Z')
    const b = evaluateAmazonSlaCycle(slaState(), '2026-09-07T14:00:00.000Z')
    expect(a.kind === 'reminder' && b.kind === 'reminder' && a.cycle_stamp === b.cycle_stamp).toBe(
      true,
    )
    const next = evaluateAmazonSlaCycle(
      slaState({ last_buyer_message_at: '2026-09-08T00:00:00.000Z' }),
      '2026-09-08T13:00:00.000Z',
    )
    expect(
      next.kind === 'reminder' && a.kind === 'reminder' && next.cycle_stamp !== a.cycle_stamp,
    ).toBe(true)
    expect(amazonSlaCardTitle('reminder', 'thr_1', '2026-09-08 00:00 UTC')).toContain('thr_1')
  })
})
