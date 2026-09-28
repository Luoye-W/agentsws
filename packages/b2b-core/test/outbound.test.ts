/**
 * WP173（docs/84 §2 / §11.1）：开发信的纯函数——筛人（德奥默认不发）、按配额分批、三封模板
 * 不碰承诺词、页脚没有公司地址就没有、发信邮箱体检、回信分类。
 */
import { B2B_DE_AT_REASON } from '@agentsws/contracts'
import { scanB2bCommitments } from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import {
  type B2bProspect,
  classifyB2bReply,
  draftB2bOutreach,
  EXCLUDE_REASON_ZH,
  evaluateSenderAuth,
  hasRelationship,
  isSeparateSendingDomain,
  localDay,
  outreachFooter,
  parseModelDraft,
  parseSenderChoice,
  reviewB2bOutreach,
  screenProspects,
  senderAuthOk,
  senderChoiceOptions,
  sequenceFunnel,
  splitByQuota,
} from '../src/index.js'

const base: B2bProspect = {
  contact_id: 'c1',
  account_id: 'a1',
  name: 'Anna',
  company: 'Volthaus',
  country: 'US',
  has_email: true,
  source: { url: 'https://volthaus.example/contact', observed_at: '2026-09-20T00:00:00Z' },
  existing_relationship: false,
  suppressed: false,
  in_sequence: false,
}

describe('筛人', () => {
  it('德国 / 奥地利没有往来的默认不发，原因写得出来；已有往来的照常；确认过风险的照常', () => {
    const de = { ...base, contact_id: 'de', country: 'de' }
    const at = { ...base, contact_id: 'at', country: 'AT', existing_relationship: true }
    const out = screenProspects([base, de, at], { de_at_confirmed: false })
    expect(out.eligible.map((p) => p.contact_id)).toEqual(['c1', 'at'])
    expect(out.excluded).toEqual([{ prospect: de, reason: 'de_at' }])
    expect(EXCLUDE_REASON_ZH.de_at).toContain(B2B_DE_AT_REASON)
    const confirmed = screenProspects([de], { de_at_confirmed: true })
    expect(confirmed.eligible).toHaveLength(1)
  })

  it('抑制名单 / 在序列里 / 没邮箱 / 没来源 / 加拿大没公开来源 都剔掉', () => {
    const out = screenProspects(
      [
        { ...base, contact_id: 's', suppressed: true },
        { ...base, contact_id: 'q', in_sequence: true },
        { ...base, contact_id: 'e', has_email: false },
        { ...base, contact_id: 'n', source: { url: 'https://x.example' } },
        { ...base, contact_id: 'ca', country: 'CA' },
        { ...base, contact_id: 'ca2', country: 'CA', public_source: true },
      ],
      { de_at_confirmed: false },
    )
    expect(out.excluded.map((x) => [x.prospect.contact_id, x.reason])).toEqual([
      ['s', 'suppressed'],
      ['q', 'in_sequence'],
      ['e', 'no_email'],
      ['n', 'no_source'],
      ['ca', 'ca_no_public_source'],
    ])
    expect(out.eligible.map((p) => p.contact_id)).toEqual(['ca2'])
  })

  it('有往来：只被我们找过（contacted）不算', () => {
    expect(hasRelationship({ stage: 'contacted' })).toBe(false)
    expect(hasRelationship({ stage: 'quote' })).toBe(true)
    expect(hasRelationship({ stage: 'contacted', last_contact_at: '2026-01-01' })).toBe(true)
  })

  it('按配额分：今天的进卡，超了排明天；配额按自然日', () => {
    expect(splitByQuota([1, 2, 3, 4, 5], 3)).toEqual({ today: [1, 2, 3], later: [4, 5] })
    expect(splitByQuota([1, 2], 0)).toEqual({ today: [], later: [1, 2] })
    expect(localDay('2026-09-28T17:00:00Z', 'Asia/Shanghai')).toBe('2026-09-29')
    expect(localDay('2026-09-28T15:00:00Z', 'Asia/Shanghai')).toBe('2026-09-28')
    expect(localDay('2026-09-28T17:00:00Z', '+08:00')).toBe('2026-09-29')
    expect(localDay('2026-09-28T02:00:00Z', '-05:00')).toBe('2026-09-27')
  })
})

describe('三封模板与自查', () => {
  const vars = {
    first_name: 'Anna',
    company: 'Volthaus',
    our_company: 'Zhilian 3C',
    product: 'GaN chargers',
    sender_name: 'Leo',
  }

  it('三封都不碰承诺词；首封主题不是 Re:，跟进回在同一条线程', () => {
    const first = draftB2bOutreach('first', vars)
    const follow = draftB2bOutreach('follow_up', { ...vars, first_subject: first.subject })
    const final = draftB2bOutreach('final', { ...vars, first_subject: first.subject })
    for (const d of [first, follow, final]) {
      expect(scanB2bCommitments(`${d.subject}\n${d.body}`)).toEqual([])
      expect(reviewB2bOutreach(d).ok).toBe(true)
    }
    expect(first.subject).toBe('GaN chargers for Volthaus')
    expect(follow.subject).toBe('Re: GaN chargers for Volthaus')
    expect(final.body).toContain("won't follow up again")
  })

  it('自查拦价格与首封的假 Re:', () => {
    const r = reviewB2bOutreach({
      step: 'first',
      subject: 'Re: chargers',
      body: 'Our unit price is USD 3.2 and MOQ 500.',
    })
    expect(r.ok).toBe(false)
    expect(r.fake_reply).toBe(true)
    expect(r.hits).toEqual(expect.arrayContaining(['价格', '起订量']))
  })

  it('页脚：没公司地址就没有；首封带来源与怎么查怎么删', () => {
    expect(
      outreachFooter({ company_name: 'Zhilian', postal_address: ' ', step: 'first' }),
    ).toBeUndefined()
    const f = outreachFooter({
      company_name: 'Zhilian',
      postal_address: '8 Keji Rd, Shenzhen, China',
      step: 'first',
      source: base.source,
    })
    expect(f).toContain('8 Keji Rd')
    expect(f).toContain('unsubscribe')
    expect(f).toContain('volthaus.example (2026-09-20)')
    const f2 = outreachFooter({ company_name: 'Z', postal_address: 'X', step: 'final' })
    expect(f2).not.toContain('We found')
  })

  it('模型回文解析：Subject + 正文，太短不收', () => {
    expect(parseModelDraft('Subject: Hi\n\nshort')).toBeUndefined()
    expect(parseModelDraft(`Subject: GaN for Volthaus\n\n${'x'.repeat(60)}`)?.subject).toBe(
      'GaN for Volthaus',
    )
  })
})

describe('发信邮箱', () => {
  it('单独域名判断与选择卡选项（单独在前，主域名带风险提示）', () => {
    expect(isSeparateSendingDomain('leo@trybrand.com', ['brand.com'])).toBe(true)
    expect(isSeparateSendingDomain('leo@mail.brand.com', ['brand.com'])).toBe(false)
    const opts = senderChoiceOptions({
      mailboxes: ['hello@brand.com', 'leo@trybrand.com'],
      primary_domains: ['brand.com'],
    })
    expect(opts.map((o) => o.id)).toEqual(['separate:leo@trybrand.com', 'primary:hello@brand.com'])
    expect(opts[1]?.label).toContain('连累')
    const none = senderChoiceOptions({
      mailboxes: ['hello@brand.com'],
      primary_domains: ['brand.com'],
    })
    expect(none.map((o) => o.kind)).toEqual(['separate_setup', 'primary'])
    expect(parseSenderChoice('primary:hello@brand.com')).toEqual({
      kind: 'primary',
      address: 'hello@brand.com',
    })
    expect(parseSenderChoice('bogus')).toBeUndefined()
  })

  it('体检：SPF 缺 / 多条 / +all；DKIM 等测试信、签错域名算没过；DMARC 缺只提示', () => {
    const ok = evaluateSenderAuth({
      domain: 'trybrand.com',
      spf_txt: ['v=spf1 include:_spf.mx.example ~all'],
      dmarc_txt: [],
      auth_header:
        'mx.example; dkim=pass header.d=trybrand.com; spf=pass smtp.mailfrom=leo@trybrand.com',
      test_sent: true,
    })
    expect(ok).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'missing' })
    expect(senderAuthOk(ok)).toBe(true)
    expect(evaluateSenderAuth({ domain: 'a.com', spf_txt: [], test_sent: false }).spf).toBe(
      'missing',
    )
    expect(
      evaluateSenderAuth({ domain: 'a.com', spf_txt: ['v=spf1 a', 'v=spf1 mx'], test_sent: false })
        .spf,
    ).toBe('fail')
    expect(
      evaluateSenderAuth({ domain: 'a.com', spf_txt: ['v=spf1 +all'], test_sent: false }).spf,
    ).toBe('fail')
    const pending = evaluateSenderAuth({
      domain: 'a.com',
      spf_txt: ['v=spf1 ~all'],
      test_sent: true,
    })
    expect(pending.dkim).toBe('pending')
    expect(senderAuthOk(pending)).toBe(false)
    const wrong = evaluateSenderAuth({
      domain: 'trybrand.com',
      spf_txt: ['v=spf1 ~all'],
      auth_header: 'mx; dkim=pass header.d=provider-mail.example; spf=pass',
      test_sent: true,
    })
    expect(wrong.dkim).toBe('fail')
    expect(wrong.notes.join()).toContain('provider-mail.example')
    const spfFail = evaluateSenderAuth({
      domain: 'trybrand.com',
      spf_txt: ['v=spf1 ~all'],
      auth_header: 'mx; dkim=pass header.d=trybrand.com; spf=softfail',
      test_sent: true,
    })
    expect(spfFail.spf).toBe('fail')
  })
})

describe('回信分类', () => {
  const now = '2026-09-30T02:00:00Z'
  it('有意向 / 要资料 / 问价 / 不感兴趣 / 退订 / 晚点', () => {
    const c = (text: string): string => classifyB2bReply({ subject: 'Re: x', text, now }).klass
    expect(c('Sounds good, tell me more.')).toBe('interested')
    expect(c('Please send your catalog.')).toBe('wants_info')
    expect(c('What is your pricing for 1k units?')).toBe('asks_price')
    expect(c('No thanks, we already have a supplier.')).toBe('not_interested')
    expect(c('Please unsubscribe me.')).toBe('unsubscribe')
    expect(c('Not now, maybe next quarter.')).toBe('later')
    expect(c('ok')).toBe('unknown')
  })

  it('引用的原信里那句"Not interested? Reply unsubscribe"不算', () => {
    const text =
      'Yes, interested!\n\nOn Mon, Leo <leo@trybrand.com> wrote:\n> Not interested? Reply "unsubscribe"'
    expect(classifyB2bReply({ subject: 'Re: x', text, now }).klass).toBe('interested')
  })

  it('自动回复：认得出回来日期（不算回信）', () => {
    const r = classifyB2bReply({
      subject: 'Automatic reply: GaN chargers for Volthaus',
      text: 'I am out of the office and will be back on October 6.',
      now,
    })
    expect(r.klass).toBe('auto_reply')
    expect(r.return_date).toBe('2026-10-06')
  })

  it('漏斗：格子固定，空的也出', () => {
    const f = sequenceFunnel([
      { status: 'active', steps: [{ step: 'first', at: now }] },
      { status: 'queued', steps: [] },
      { status: 'handed_to_sales', steps: [{ step: 'first', at: now }] },
    ])
    expect(f.map((x) => x.count)).toEqual([1, 0, 1, 0, 0, 1, 0, 0])
  })
})
