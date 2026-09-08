import { describe, expect, it } from 'vitest'
import {
  buildReplyHeaders,
  htmlToText,
  normalizeAddress,
  normalizeMessageId,
  normalizeText,
  parseReferences,
  replySubject,
  stripQuotedTail,
  threadExternalId,
} from '../src/email/mime.js'

describe('htmlToText', () => {
  it('把块级标签折成换行并解实体', () => {
    const text = htmlToText(
      '<div>Hi&nbsp;Ann,</div><p>My order <b>#1001</b> is late.</p><br>Thanks &amp; regards',
    )
    expect(text).toBe('Hi Ann,\nMy order #1001 is late.\n\nThanks & regards')
  })

  it('扔掉 script / style / 注释', () => {
    const text = htmlToText(
      '<style>p{color:red}</style><!-- hidden --><script>alert(1)</script><p>visible</p>',
    )
    expect(text).toBe('visible')
    expect(text).not.toContain('alert')
  })

  it('去掉 blockquote 与 gmail_quote 引用尾巴', () => {
    const text = htmlToText(
      '<div>New question here.</div><div class="gmail_quote"><blockquote>On Tue, Ann wrote:<br>previous body</blockquote></div>',
    )
    expect(text).toBe('New question here.')
    expect(text).not.toContain('previous body')
  })

  it('数字实体也解', () => {
    expect(htmlToText('<p>Caf&#233; &#x26; bar</p>')).toBe('Café & bar')
  })
})

describe('stripQuotedTail', () => {
  it('切掉 "On ... wrote:" 之后的引用', () => {
    const body = [
      'Any update?',
      '',
      'On Tue, Sep 8, 2026 at 10:00 Ann wrote:',
      '> earlier text',
    ].join('\n')
    expect(stripQuotedTail(body)).toBe('Any update?')
  })

  it('"On" 与 "wrote:" 跨行也算', () => {
    const body = [
      'Any update?',
      '',
      'On Tue, Sep 8, 2026 at 10:00,',
      'Ann <ann@x.com>',
      'wrote:',
      '> earlier',
    ].join('\n')
    expect(stripQuotedTail(body)).toBe('Any update?')
  })

  it('切掉 Outlook 的 -----Original Message----- 与 From: 头', () => {
    expect(stripQuotedTail('Thanks!\n\n-----Original Message-----\nFrom: Ann')).toBe('Thanks!')
    expect(stripQuotedTail('Thanks!\n\nFrom: Ann <ann@x.com>\nSent: Tuesday')).toBe('Thanks!')
  })

  it('切掉中文写道与 > 引用', () => {
    expect(stripQuotedTail('收到\n\n在 2026年9月8日，Ann 写道：\n> 上一封')).toBe('收到')
    expect(stripQuotedTail('ok\n> quoted')).toBe('ok')
  })

  it('没有引用尾巴时只做规整', () => {
    expect(stripQuotedTail('line1\n\n\n\nline2   \n')).toBe('line1\n\nline2')
  })
})

describe('normalizeText', () => {
  it('统一换行、压空行与多余空格', () => {
    expect(normalizeText('a\r\n\r\n\r\n\r\nb   c')).toBe('a\n\nb c')
  })
})

describe('线程头', () => {
  it('normalizeMessageId 补尖括号', () => {
    expect(normalizeMessageId('abc@x')).toBe('<abc@x>')
    expect(normalizeMessageId('<abc@x>')).toBe('<abc@x>')
    expect(normalizeMessageId('  ')).toBeUndefined()
    expect(normalizeMessageId(undefined)).toBeUndefined()
  })

  it('parseReferences 保序去重', () => {
    expect(parseReferences('<a@x> <b@x> <a@x>')).toEqual(['<a@x>', '<b@x>'])
    expect(parseReferences(['<a@x>', '<b@x>'])).toEqual(['<a@x>', '<b@x>'])
    expect(parseReferences(undefined)).toEqual([])
  })

  it('thread id 取 References 首个，否则 In-Reply-To，否则本封', () => {
    expect(threadExternalId({ references: ['<root@x>', '<b@x>'], message_id: '<c@x>' })).toBe(
      '<root@x>',
    )
    expect(threadExternalId({ in_reply_to: 'b@x', message_id: '<c@x>' })).toBe('<b@x>')
    expect(threadExternalId({ message_id: 'c@x' })).toBe('<c@x>')
    expect(threadExternalId({})).toBeUndefined()
  })

  it('replySubject 不叠加 Re:', () => {
    expect(replySubject('Order #1001')).toBe('Re: Order #1001')
    expect(replySubject('Re: Order #1001')).toBe('Re: Order #1001')
    expect(replySubject('RE: Order')).toBe('RE: Order')
    expect(replySubject(undefined)).toBe('Re:')
  })

  it('buildReplyHeaders 把被回的那封接到 References 末尾', () => {
    const h = buildReplyHeaders({
      subject: 'Order #1001',
      reply_to_message_id: '<m2@x>',
      references: ['<m1@x>'],
    })
    expect(h).toEqual({
      subject: 'Re: Order #1001',
      in_reply_to: '<m2@x>',
      references: '<m1@x> <m2@x>',
    })
  })

  it('buildReplyHeaders 不重复已有的 message id，也容忍没有线程头', () => {
    expect(
      buildReplyHeaders({ reply_to_message_id: '<m1@x>', references: ['<m1@x>'] }).references,
    ).toBe('<m1@x>')
    expect(buildReplyHeaders({ subject: 'x' })).toEqual({ subject: 'Re: x' })
  })
})

describe('normalizeAddress', () => {
  it('取尖括号里的地址并小写', () => {
    expect(normalizeAddress('Ann Lee <Ann@Example.COM>')).toBe('ann@example.com')
    expect(normalizeAddress(' bob@example.com ')).toBe('bob@example.com')
  })
})
