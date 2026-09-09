import { describe, expect, it } from 'vitest'
import {
  CARD_ACTIONS,
  callbackLink,
  type DeliveredItem,
  decisionLinks,
  EmailDeliveryProvider,
  renderApprovalEmail,
} from '../src/delivery/email.js'
import { FakeClock, MemoryEventSink, RecordingMailer } from './helpers.js'

const CALLBACK = 'https://127.0.0.1:7788/v1/approvals/callback'

const item: DeliveredItem = {
  id: 'ap_1',
  title: '退款 39.90 USD 给 ann@customer.com',
  summary: '订单 #1001 未按时送达，客户要求退款。卡号 4111 1111 1111 1111 已在原文脱敏。',
  view: 'redacted',
  decision_token: 'tok_once_1',
  actions: ['approve', 'approve_edited', 'reject'],
}

function makeProvider(over: { resolve?: (to: string) => string | undefined } = {}) {
  const clock = new FakeClock()
  const mailer = new RecordingMailer()
  const events = new MemoryEventSink()
  const provider = new EmailDeliveryProvider({
    clock,
    mailer,
    events,
    workspace_id: 'ws_1',
    from: 'agent@shop.example',
    from_name: '中台',
    callback_url: CALLBACK,
    resolveRecipient:
      over.resolve ?? ((to) => (to === 'p_owner' ? 'owner@shop.example' : undefined)),
  })
  return { provider, mailer, events, clock }
}

describe('EmailDeliveryProvider.deliver', () => {
  it('三个按钮 = 三个带 decision_token 的链接，收件人来自注入的解析器', async () => {
    const { provider, mailer } = makeProvider()
    const out = await provider.deliver(item, 'p_owner')
    expect(out.external_id).toBeDefined()
    expect(mailer.sent).toHaveLength(1)
    const sent = mailer.sent[0]
    expect(sent?.to).toEqual(['owner@shop.example'])
    expect(sent?.from).toBe('中台 <agent@shop.example>')
    expect(sent?.subject).toContain('[审批]')

    for (const action of CARD_ACTIONS) {
      expect(sent?.text).toContain(
        `${CALLBACK}?item_id=ap_1&decision_token=tok_once_1&action=${action}`,
      )
    }
    expect(sent?.text).toContain('（本邮件为脱敏视图')
    // 卡号在渲染时再脱一次
    expect(sent?.text).not.toContain('4111 1111 1111 1111')
  })

  it('同一审批项 + 同一收件人 → 同一 external_id（可幂等重发）', async () => {
    const { provider } = makeProvider()
    const a = await provider.deliver(item, 'p_owner')
    const b = await provider.deliver(item, 'p_owner')
    expect(a.external_id).toBe(b.external_id)
    expect(provider.all()).toHaveLength(1)
  })

  it('delivery.sent 事件不带 decision_token', async () => {
    const { provider, events } = makeProvider()
    await provider.deliver(item, 'p_owner')
    const sent = events.ofType('delivery.sent')[0]
    expect(sent?.payload).toMatchObject({ item_id: 'ap_1', to: 'p_owner', view: 'redacted' })
    expect(JSON.stringify(sent?.payload)).not.toContain('tok_once_1')
  })

  it('解析不到邮箱就不投递', async () => {
    const { provider, mailer } = makeProvider()
    await expect(provider.deliver(item, 'p_nobody')).rejects.toMatchObject({ code: 'not_found' })
    expect(mailer.sent).toHaveLength(0)
  })

  it('发送失败记 delivery.failed 并抛出', async () => {
    const { provider, mailer, events } = makeProvider()
    mailer.fail = new Error('smtp refused')
    await expect(provider.deliver(item, 'p_owner')).rejects.toThrow('smtp refused')
    expect(events.ofType('delivery.failed')).toHaveLength(1)
    expect(provider.all()).toHaveLength(0)
  })

  it('render_html 注入时同时发 HTML', async () => {
    const clock = new FakeClock()
    const mailer = new RecordingMailer()
    const provider = new EmailDeliveryProvider({
      clock,
      mailer,
      workspace_id: 'ws_1',
      from: 'agent@shop.example',
      callback_url: CALLBACK,
      resolveRecipient: () => 'owner@shop.example',
      render_html: (input) =>
        `<h1>${input.title}</h1>${input.links.map((l) => `<a href="${l.url}">${l.label}</a>`).join('')}`,
    })
    await provider.deliver(item, 'p_owner')
    expect(mailer.sent[0]?.html).toContain('<a href="https://127.0.0.1:7788')
  })
})

describe('EmailDeliveryProvider.refresh', () => {
  it('在同一线程里补一封状态邮件', async () => {
    const { provider, mailer } = makeProvider()
    const { external_id } = await provider.deliver(item, 'p_owner')
    await provider.refresh(external_id as string, '已由 张三 处理')
    expect(mailer.sent).toHaveLength(2)
    expect(mailer.sent[1]?.in_reply_to).toBe(external_id)
    expect(mailer.sent[1]?.references).toBe(external_id)
    expect(mailer.sent[1]?.text).toContain('已由 张三 处理')
    expect(provider.all()[0]?.state).toBe('已由 张三 处理')
    expect(provider.all()[0]?.refreshed_at).toBeDefined()
  })

  it('不存在的投递报 not_found', async () => {
    const { provider } = makeProvider()
    await expect(provider.refresh('<nope@x>', 'expired')).rejects.toMatchObject({
      code: 'not_found',
    })
  })
})

describe('parseCallback 只认 item_id + decision_token + action', () => {
  const { provider } = makeProvider()

  it('认回调 URL 串', () => {
    const url = callbackLink(CALLBACK, {
      item_id: 'ap_1',
      decision_token: 'tok_once_1',
      action: 'approve',
    })
    expect(provider.parseCallback(url)).toEqual({
      item_id: 'ap_1',
      decision_token: 'tok_once_1',
      action: 'approve',
    })
  })

  it('认查询串、对象、JSON 串与 URLSearchParams', () => {
    const expected = { item_id: 'ap_1', decision_token: 't', action: 'reject' as const }
    expect(provider.parseCallback('item_id=ap_1&decision_token=t&action=reject')).toEqual(expected)
    expect(provider.parseCallback({ ...expected })).toEqual(expected)
    expect(provider.parseCallback(JSON.stringify(expected))).toEqual(expected)
    expect(provider.parseCallback(new URLSearchParams({ ...expected, action: 'reject' }))).toEqual(
      expected,
    )
  })

  it('业务参数一律丢弃（14 §7 防篡改）', () => {
    const parsed = provider.parseCallback(
      `${CALLBACK}?item_id=ap_1&decision_token=t&action=approve&amount=99999&to=attacker@evil.com`,
    )
    expect(parsed).toEqual({ item_id: 'ap_1', decision_token: 't', action: 'approve' })
    expect(Object.keys(parsed ?? {})).toEqual(['item_id', 'decision_token', 'action'])
  })

  it('缺字段 / 非法动作 / 非法载荷一律 undefined', () => {
    expect(provider.parseCallback('item_id=&decision_token=t&action=approve')).toBeUndefined()
    expect(provider.parseCallback('item_id=a&action=approve')).toBeUndefined()
    expect(provider.parseCallback('item_id=a&decision_token=t&action=drop_table')).toBeUndefined()
    expect(provider.parseCallback('{bad json')).toBeUndefined()
    expect(provider.parseCallback('')).toBeUndefined()
    expect(provider.parseCallback(['a'])).toBeUndefined()
    expect(provider.parseCallback(null)).toBeUndefined()
    expect(provider.parseCallback(42)).toBeUndefined()
  })
})

describe('渲染的纯函数', () => {
  it('decisionLinks 过滤掉非 DecisionAction，默认给三个', () => {
    expect(decisionLinks(CALLBACK, item, ['approve', 'nope']).map((l) => l.action)).toEqual([
      'approve',
    ])
    expect(decisionLinks(CALLBACK, item).map((l) => l.action)).toEqual([...CARD_ACTIONS])
  })

  it('renderApprovalEmail 的正文含标题、脱敏摘要与链接', () => {
    const links = decisionLinks(CALLBACK, item)
    const mail = renderApprovalEmail(item, links)
    expect(mail.subject).toBe(`[审批] ${item.title}`)
    expect(mail.text).toContain('[redacted:card_number]')
    expect(mail.text).toContain('链接一次有效')
    expect(mail.text.split('\n').filter((l) => l.includes('http'))).toHaveLength(3)
  })

  it('full 视图不带脱敏提示', () => {
    const full = { ...item, view: 'full' as const }
    const mail = renderApprovalEmail(full, decisionLinks(CALLBACK, full))
    expect(mail.text).not.toContain('脱敏视图')
  })
})

describe('31 §3.3 出站脱敏：卡片这一路走统一入口（39 待办 D）', () => {
  const dirty: DeliveredItem = {
    ...item,
    title: '连接凭据 sk-4f9ab2c7d1e08356zq 已保存',
    summary: '客户把邮箱授权码：abcdefghijklmnop 贴进了来信里。',
  }

  it('标题与摘要里的 sk-… 与邮箱授权码都不出现在发出去的卡片里', async () => {
    const { provider, mailer } = makeProvider()
    await provider.deliver(dirty, 'p_owner')
    const sent = mailer.sent[0]
    const wire = `${sent?.subject ?? ''}\n${sent?.text ?? ''}`
    expect(wire).not.toContain('sk-4f9ab2c7d1e08356zq')
    expect(wire).not.toContain('abcdefghijklmnop')
    expect(wire).toContain('[redacted:api_key]')
    expect(wire).toContain('[redacted:mail_app_password]')
  })
})
