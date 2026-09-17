/**
 * WP77（59 §2）：通知邮件模板。
 *
 * 最要紧的一条：**起草自查与 guardrail 判的是同一件事**。两边不一致的后果是
 * "这里说过得去、提上去被拦"，模型会反复试同一个错。
 */
import { evaluateGuardrail, Provenance } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import {
  checkEmailTemplate,
  emailTemplateAfter,
  NOTIFICATION_TYPES,
  notificationType,
  PREVIEW_SAMPLE,
  renderPreview,
  requiredVariables,
} from '../src/index.js'

const good = {
  notification_type: 'order_confirmation',
  subject: '你的订单 {{ order.name }} 已收到',
  body: '你好 {{ customer.first_name }}，订单 {{ order.name }} 收到了。{{ order.order_status_url }}',
  enabled: false,
}

describe('通知邮件模板（59 §2）', () => {
  it('每种列出来的通知都在必需变量表里有一行——列出来点不动的行不如没有', () => {
    for (const t of NOTIFICATION_TYPES)
      expect(requiredVariables(t.handle).length, t.handle).toBeGreaterThan(0)
    expect(notificationType('order_confirmation')?.audience).toBe('customer')
    expect(notificationType('没这封')).toBeUndefined()
  })

  it('变量齐了就过；草稿 L2、启用 L1', () => {
    expect(checkEmailTemplate(good)).toMatchObject({ ok: true, level: 'L2' })
    expect(checkEmailTemplate({ ...good, enabled: true })).toMatchObject({ ok: true, level: 'L1' })
  })

  it('缺必需变量说得出缺哪几个，而且那句话说清是拦不是转人审', () => {
    const r = checkEmailTemplate({ ...good, body: '你好 {{ customer.first_name }}，谢谢下单。' })
    expect(r.ok).toBe(false)
    expect(r.missing_variables).toEqual(['order.name', 'order.order_status_url'])
    expect(r.message).toContain('拦不是转人审')
  })

  it('没有主题行也不过——Shopify 不会拦它，我们拦', () => {
    expect(checkEmailTemplate({ ...good, subject: '   ' }).ok).toBe(false)
  })

  it('起草自查与 guardrail 判的是同一件事（同一张表、同一个函数）', () => {
    const bad = { ...good, body: '谢谢下单。' }
    expect(checkEmailTemplate(bad).ok).toBe(false)
    const target = { type: 'email_template', id: 'et_1' } as const
    const prov = new Provenance('run_1')
    prov.see([target], { full: true })
    const verdict = evaluateGuardrail(
      { kind: 'email_template_edit', target, before: {}, after: emailTemplateAfter(bad) },
      { caps: {} },
      { now: '2026-09-17T03:00:00Z', changeSet: [], windowCount: 0, provenance: prov },
      'stage',
    )
    expect(verdict.verdict).toBe('block')
    expect(verdict.hits.some((h) => h.rule === 'email_template_missing_variable')).toBe(true)

    // 反过来：自查过得去的，guardrail 也放行
    const okVerdict = evaluateGuardrail(
      { kind: 'email_template_edit', target, before: {}, after: emailTemplateAfter(good) },
      { caps: {} },
      { now: '2026-09-17T03:00:00Z', changeSet: [], windowCount: 0, provenance: prov },
      'stage',
    )
    expect(okVerdict.verdict).toBe('allow')
  })

  it('after 一定带 enabled——少带一格等于把启用那一下悄悄降成草稿', () => {
    expect(emailTemplateAfter({ ...good, enabled: true }).enabled).toBe(true)
    expect(emailTemplateAfter(good).enabled).toBe(false)
  })

  it('渲染预览只换变量，控制标签原样留着（它不是真渲染）', () => {
    const out = renderPreview(
      '{% if order.name %}订单 {{ order.name }}{% endif %} 共 {{ order.total_price }}',
      PREVIEW_SAMPLE,
    )
    expect(out).toBe('{% if order.name %}订单 #1042{% endif %} 共 ¥328.00')
    // 示例值里没有的变量原样留着，人一眼看得出那一格没填
    expect(renderPreview('{{ some.unknown }}', PREVIEW_SAMPLE)).toBe('{{ some.unknown }}')
  })
})
