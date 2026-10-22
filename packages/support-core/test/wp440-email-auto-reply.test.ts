/**
 * WP440（docs/108 M9）：邮件客服按把握直接回——**邮件特有的那几步**（纯函数）。
 * 判定本身就是 WP428 的 `scoreChatAutoAnswer`（这里换个渠道无关的名字），那一套的用例在
 * `wp428-confidence.test.ts`，这里只钉邮件多出来的：剥引用 / 签名、能不能试、起草格式与 stub 剧本、称呼落款。
 */
import { describe, expect, it } from 'vitest'
import {
  type AutoAnswerSource,
  composeEmailReply,
  EMAIL_ANSWER_CITE_INSTRUCTION,
  EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS,
  EMAIL_QUESTION_MARK,
  emailAnswerPlan,
  emailAnswerPrompt,
  emailAnswerStubScript,
  emailAnswerSystem,
  emailAutoReplyGate,
  emailHeldShort,
  scoreAutoAnswer,
  scoreChatAutoAnswer,
  splitEmailForAnswer,
} from '../src/index.js'

const WARRANTY: AutoAnswerSource = {
  ref: 'K1',
  kind: 'fact_card',
  id: 'fc_warranty',
  label: '充电类产品的保修期是 24 个月',
  text: '充电类产品的保修期是 24 个月，从签收日算起。',
}
const CHARGER: AutoAnswerSource = {
  ref: 'K2',
  kind: 'fact_card',
  id: 'fc_charger',
  label: '充电盒用 USB-C 接口充电',
  text: '充电盒用 USB-C 接口充电，充满大约 2 小时。',
}

/** 照服务进程那样走一遍：剥 → 计划 → 起草（stub）→ 判定。 */
const run = (
  letter: string,
  sources: AutoAnswerSource[],
  strictness?: 'strict' | 'balanced' | 'loose',
) => {
  const { question } = splitEmailForAnswer(letter)
  const plan = emailAnswerPlan(question)
  const reply =
    emailAnswerStubScript([
      { role: 'system', content: emailAnswerSystem('邮件客服。') },
      { role: 'user', content: emailAnswerPrompt({ sources, question }) },
    ]) ?? ''
  return {
    question,
    plan,
    verdict: scoreAutoAnswer({
      plan,
      turn_text: question,
      reply,
      sources,
      ...(strictness === undefined ? {} : { strictness }),
    }),
  }
}

describe('WP440 · 先剥引用的旧邮件与签名', () => {
  it('「On … wrote:」以下的旧邮件剥掉', () => {
    const out = splitEmailForAnswer(
      '充电类产品保修多久？\n\nOn Mon, Oct 20, 2026 at 9:00 AM Shop <hello@shop.example> wrote:\n> 感谢您的购买\n> 有问题随时联系',
    )
    expect(out.question).toBe('充电类产品保修多久？')
    expect(out.quote_removed).toBe(true)
  })

  it('Outlook 的「From: / Sent:」引用头、「> 」行、中文「在 … 写道：」都剥掉', () => {
    expect(
      splitEmailForAnswer('请问保修期多久？\nFrom: Shop <a@b.com>\nSent: Monday\nSubject: x\nold')
        .question,
    ).toBe('请问保修期多久？')
    expect(splitEmailForAnswer('请问保修期多久？\n> 旧的\n> 更旧的').question).toBe(
      '请问保修期多久？',
    )
    expect(
      splitEmailForAnswer('请问保修期多久？\n在 2026年10月20日 周一 09:00，Shop 写道：\n旧信')
        .question,
    ).toBe('请问保修期多久？')
  })

  it('签名（落款、电话、地址、Sent from my iPhone）剥掉；正文里提到 From 的不误剥', () => {
    const out = splitEmailForAnswer(
      '你好，充电类产品的保修期是多久？\n\n谢谢\n张伟\n电话：138 0013 8000\n上海市南京西路 100 号',
    )
    expect(out.question).toBe('你好，充电类产品的保修期是多久？')
    expect(out.signature_removed).toBe(true)
    expect(
      splitEmailForAnswer('Hi,\nHow long is the warranty?\n\nSent from my iPhone').question,
    ).toBe('Hi,\nHow long is the warranty?')
    expect(
      splitEmailForAnswer(
        'Hi,\nHow long is the warranty?\n\nBest regards,\nDan Lee\n+1 415 555 0134',
      ).question,
    ).toBe('Hi,\nHow long is the warranty?')
    // 「From:」后面没跟 Sent / Date，不是引用头
    expect(
      splitEmailForAnswer('Hi\nFrom: what I read, the warranty is 2 years?').question,
    ).toContain('From: what I read')
  })

  it('整封剥空了就退回原文（宁可多判几个字，不能把问题剥没）', () => {
    expect(splitEmailForAnswer('> 只有引用').question).toBe('> 只有引用')
  })
})

describe('WP440 · 能不能试（问模型之前）', () => {
  const base = { enabled: true, inbound_action: 'auto_reply' as const, has_recipient: true }
  it('全过 = undefined', () => {
    expect(emailAutoReplyGate(base)).toBeUndefined()
  })
  it('开关关了 / Amazon / 影子模式 / 收件人待定 / 三道门没放行：各有一句人话', () => {
    expect(emailAutoReplyGate({ ...base, enabled: false })?.kind).toBe('off')
    expect(emailAutoReplyGate({ ...base, sub_channel: 'amazon' })?.kind).toBe('excluded_channel')
    expect(emailAutoReplyGate({ ...base, shadow_mode: true })?.kind).toBe('shadow_mode')
    expect(emailAutoReplyGate({ ...base, has_recipient: false })?.kind).toBe('no_recipient')
    expect(emailAutoReplyGate({ ...base, inbound_action: 'pending_review' })?.kind).toBe(
      'not_autonomous',
    )
  })
  it('Amazon 排除是可改的一项：传一份空的就不排除', () => {
    expect(EMAIL_AUTO_REPLY_EXCLUDED_SUB_CHANNELS).toContain('amazon')
    expect(
      emailAutoReplyGate({ ...base, sub_channel: 'amazon', excluded_sub_channels: [] }),
    ).toBeUndefined()
  })
  it('卡标题后那一句（同 WP428 的理由词）', () => {
    expect(emailHeldShort('no_source')).toBe('知识库里没有')
    expect(emailHeldShort('low_confidence')).toBe('把握不够')
    expect(emailHeldShort('outbound_blocked')).toBe('出站门拦下')
    expect(emailHeldShort('whatever')).toBe('先给你看')
  })
})

describe('WP440 · 同一套判定（邮件直接调用 scoreChatAutoAnswer）', () => {
  it('scoreAutoAnswer 就是 scoreChatAutoAnswer（不另写一份）', () => {
    expect(scoreAutoAnswer).toBe(scoreChatAutoAnswer)
  })

  it('有出处的单问题 → 直接发，回复里没有出处标记与自评行', () => {
    const { verdict } = run('请问充电类产品保修期多久？', [WARRANTY])
    expect(verdict.send).toBe(true)
    expect(verdict.sources_used.map((s) => s.id)).toEqual(['fc_warranty'])
    expect(verdict.text).not.toContain('[K1]')
    expect(verdict.text).not.toContain('把握')
  })

  it('签名里有电话 → 不因此转人（个人信息只看回复）', () => {
    const { verdict, question } = run(
      '你好，请问充电类产品保修期多久？\n\n谢谢\n张伟\n手机：13800138000',
      [WARRANTY],
    )
    expect(question).not.toContain('138')
    expect(verdict.send).toBe(true)
    // 剥不剥签名都不该因电话转人：访客 / 来信人自己留的不算（决策 1303）
    const raw = scoreAutoAnswer({
      plan: emailAnswerPlan('请问充电类产品保修期多久？手机 13800138000'),
      turn_text: '请问充电类产品保修期多久？手机 13800138000',
      reply: '充电类产品的保修期是 24 个月，从签收日算起[K1]。\n把握：90',
      sources: [WARRANTY],
    })
    expect(raw.hold?.kind).not.toBe('personal_info')
  })

  it('一封问了两件事、一件没出处 → 整封不发', () => {
    const { verdict } = run('充电类产品保修期多久？另外你们的客服电话营业到几点？', [WARRANTY])
    expect(verdict.send).toBe(false)
    expect(verdict.hold?.kind).toBe('low_confidence')
    expect(verdict.reasons.join('')).toContain('第 2 句')
  })

  it('两件事都有出处 → 逐句过、能发', () => {
    const { verdict } = run('充电类产品保修期多久？充电盒用什么接口充电？', [WARRANTY, CHARGER])
    expect(verdict.factors.sentences).toBe(2)
    expect(verdict.send).toBe(true)
  })

  it('知识库里没有 → 不发（没出处）', () => {
    const { verdict } = run('请问你们发不发货到冰岛？', [])
    expect(verdict.send).toBe(false)
    expect(verdict.hold?.kind).toBe('no_source')
  })

  it('退款 → 计划就不是 answer（一律转人，不问模型）', () => {
    const plan = emailAnswerPlan('我想退款，订单 #1002 能不能退？')
    expect(plan.action === 'answer' && !plan.money_touch).toBe(false)
  })

  it('缺资料的那一类邮件里不追问：照样按材料答（答不了的那一件会转人）', () => {
    // 聊天里问保修没说型号先追问；邮件里不追问
    expect(emailAnswerPlan('请问充电类产品保修期多久？').action).toBe('answer')
  })
})

describe('WP440 · 起草格式与称呼落款', () => {
  it('prompt 里有材料编号、格式要求与「新写的部分」', () => {
    const p = emailAnswerPrompt({
      sources: [WARRANTY],
      question: '保修多久？',
      subject: 'Warranty',
    })
    expect(p).toContain('[K1] ')
    expect(p).toContain('<external_data>')
    // WP471：格式要求在系统提示里（固定在前），用户消息里只有这一封的材料与来信
    expect(p).not.toContain(EMAIL_ANSWER_CITE_INSTRUCTION)
    expect(emailAnswerSystem('邮件客服。')).toContain(EMAIL_ANSWER_CITE_INSTRUCTION)
  })

  it('WP471（决策 1549）：同一品牌两封信——系统提示逐字相同，来信在用户消息最后', () => {
    const base = '你是这家店的邮件客服。'
    const a = emailAnswerPrompt({ sources: [WARRANTY], question: '保修多久？', subject: 'A' })
    const b = emailAnswerPrompt({ sources: [WARRANTY], question: '能寄到加拿大吗？', subject: 'B' })
    expect(emailAnswerSystem(base)).toBe(emailAnswerSystem(base))
    expect(a).not.toBe(b)
    for (const p of [a, b]) {
      expect(p.indexOf('材料：')).toBeLessThan(p.indexOf(EMAIL_QUESTION_MARK))
      expect(p.trimEnd().endsWith('</external_data>')).toBe(true)
    }
  })

  it('stub 剧本只认邮件直接回那一次', () => {
    expect(emailAnswerStubScript([{ role: 'user', content: '随便一句' }])).toBeUndefined()
  })

  it('中文来信：「您好」+ 回答 + 落款；英文来信：Hi + Best regards', () => {
    const zh = composeEmailReply({
      answer: '保修期是 24 个月。',
      question: '保修多久？',
      from_display: '张伟',
    })
    expect(zh).toBe('张伟，您好：\n\n保修期是 24 个月。\n\n客服团队')
    const en = composeEmailReply({
      answer: 'The warranty is 24 months.',
      question: 'How long is the warranty?',
      from_display: 'Dan Lee',
    })
    expect(en).toBe('Hi Dan,\n\nThe warranty is 24 months.\n\nBest regards,\nCustomer Support')
    // 显示名是邮箱地址：不拿来称呼
    expect(
      composeEmailReply({ answer: 'x', question: 'q?', from_display: 'dan@example.com' }),
    ).toMatch(/^Hi,/)
  })
})
