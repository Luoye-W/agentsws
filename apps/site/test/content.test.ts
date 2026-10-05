/**
 * 内容：文档区读的是 docs/help 原文且齐全；更新日志中英成对；条款三页中英齐全、要点都在、占位只剩两个。
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CHANGELOG_DIR, changelogIds, loadChangelog } from '../src/lib/changelog.js'
import { HELP_DIR, helpFile, helpSlugs, loadHelp, parseHelpSlugs } from '../src/lib/help.js'
import { PRICING } from '../src/i18n/pricing.js'
import { fillPlaceholders, LEGAL_PAGES, legalSource, loadLegal } from '../src/lib/legal.js'
import { stripSourceComments } from '../src/lib/markdown.js'
import { repoRoot } from '../src/lib/paths.js'

const root = repoRoot()

describe('文档区 = docs/help 原文', () => {
  const slugs = helpSlugs(root)

  it('目录顺序取自工作台 HELP_SLUGS（注释里的字不算）', () => {
    expect(
      parseHelpSlugs("export const HELP_SLUGS = [\n  'a',\n  // 'x' 注释\n  'b-c',\n] as const"),
    ).toEqual(['a', 'b-c'])
    expect(slugs.length).toBeGreaterThanOrEqual(20)
    expect(slugs[0]).toBe('agentsws-credits')
  })

  it('每一篇都有中英两份，docs/help 里也没有目录漏掉的', () => {
    const files = readdirSync(join(root, HELP_DIR)).filter((f) => f.endsWith('.md'))
    for (const s of slugs) {
      expect(files).toContain(`${s}.md`)
      expect(files).toContain(`${s}.en.md`)
    }
    const onDisk = new Set(files.map((f) => f.replace(/(\.en)?\.md$/u, '')))
    expect([...onDisk].sort()).toEqual([...slugs].sort())
  })

  it('每篇都渲染得出标题；help: 互链全部指向真有的教程；正文里没有漏出的 HTML 标签', () => {
    for (const lang of ['zh', 'en'] as const) {
      for (const s of slugs) {
        const doc = loadHelp(s, lang, root)
        expect(doc.title, `${s} ${lang}`).not.toBe('')
        const raw = readFileSync(helpFile(s, lang, root), 'utf8')
        for (const m of raw.matchAll(/\]\(help:([a-z0-9-]+)\)/gu))
          expect(slugs, `${s} → ${m[1]}`).toContain(m[1])
        const tags = [...doc.html.matchAll(/<\/?([a-z0-9]+)/gu)].map((m) => m[1])
        const allowed = [
          'h2',
          'h3',
          'h4',
          'p',
          'ul',
          'ol',
          'li',
          'a',
          'strong',
          'code',
          'pre',
          'div',
          'table',
          'thead',
          'tbody',
          'tr',
          'th',
          'td',
          'span',
          'br',
        ]
        for (const tag of tags) expect(allowed, `${s} ${lang}: <${tag}>`).toContain(tag)
      }
    }
  })
})

describe('更新日志', () => {
  it('每条中英成对、日期合法、有标题与摘要，新的在前', () => {
    const ids = changelogIds(root)
    expect(ids.length).toBeGreaterThanOrEqual(3)
    const files = readdirSync(join(root, CHANGELOG_DIR))
    for (const id of ids) expect(files).toContain(`${id}.en.md`)
    for (const lang of ['zh', 'en'] as const) {
      const list = loadChangelog(lang, root)
      for (const e of list) {
        expect(e.title).not.toBe('')
        expect(e.summary).not.toBe('')
      }
      const dates = list.map((e) => e.date)
      expect([...dates].sort().reverse()).toEqual(dates)
    }
  })

  it('不出现内部派工编号（WPxxx）', () => {
    for (const f of readdirSync(join(root, CHANGELOG_DIR)))
      expect(readFileSync(join(root, CHANGELOG_DIR, f), 'utf8'), f).not.toMatch(/\bWP\d+/u)
  })
})

describe('条款三页', () => {
  it('中英各三份；「上线前建议律师审阅」只在源文件注释里，不上页面', () => {
    for (const page of LEGAL_PAGES) {
      for (const lang of ['zh', 'en'] as const) {
        const src = legalSource(page, lang, root)
        expect(src.trimStart().startsWith('<!--')).toBe(true)
        const doc = loadLegal(page, lang, root)
        expect(doc.html).not.toMatch(/律师|lawyer/iu)
        expect(doc.title).not.toBe('')
      }
    }
  })

  it('条款页上一个占位都不剩（公司全称与联系邮箱已填）', () => {
    for (const page of LEGAL_PAGES) {
      for (const lang of ['zh', 'en'] as const) {
        const left = new Set(
          [...loadLegal(page, lang, root).html.matchAll(/\{\{([A-Z_]+)\}\}/gu)].map((m) => m[1]),
        )
        expect([...left]).toEqual([])
      }
    }
    expect(fillPlaceholders('{{EFFECTIVE_DATE}} {{SITE_URL}} {{NOPE}}')).toMatch(
      /^\d{4}-\d{2}-\d{2} https:\/\/agentsws\.com \{\{NOPE\}\}$/u,
    )
  })

  it('工作单点名的要点都写到了（中文为准）', () => {
    const terms = legalSource('terms', 'zh', root)
    const privacy = legalSource('privacy', 'zh', root)
    const refund = legalSource('refund', 'zh', root)
    expect(terms).toContain('1 积分 = 人民币 1 元')
    expect(terms).toContain('永不过期')
    expect(terms).toContain('Apache License 2.0')
    expect(terms).toContain('商标')
    expect(terms).toContain('适用中华人民共和国法律')
    expect(privacy).toContain('默认留在你自己的电脑上')
    for (const who of ['Cloudflare', 'Waffo', '模型提供方', '数据接口提供方'])
      expect(privacy).toContain(who)
    expect(privacy).toContain('不设任何 Cookie')
    expect(refund).toContain('拒付')
    expect(refund).toContain('不向你追讨')
  })

  it('WP227：退款政策是「不退」+ 三种例外，条款与定价页口径一致', () => {
    for (const lang of ['zh', 'en'] as const) {
      const refund = stripSourceComments(legalSource('refund', lang, root))
      const terms = stripSourceComments(legalSource('terms', lang, root))
      const faq = JSON.stringify(PRICING[lang])
      if (lang === 'zh') {
        expect(refund).toContain('积分一经购买，不退款、不折现')
        for (const ex of ['重复扣款', '系统错误多扣', '法律强制要求']) expect(refund).toContain(ex)
        expect(refund).toContain('14 天撤销权')
        expect(refund).toContain('暂停这个账号的付费功能')
        expect(refund).toContain('开源软件不受影响')
        expect(terms).toContain('积分一经购买不退款、不折现')
        // 责任上限是另一回事，保留
        expect(terms).toContain('十二个月内实际向我们支付的金额为上限')
        expect(faq).toContain('积分买了就不退')
      } else {
        expect(refund).toContain('non-refundable once purchased')
        expect(refund).toContain('14-day right of withdrawal')
        expect(terms).toContain('non-refundable once purchased')
        expect(faq).toContain('aren’t refundable')
      }
      // 旧口径（没用掉的可以退 / 按比例退）一个字都不留
      for (const old of ['可以申请退', '按比例', 'credits can be refunded', 'pro rata', 'proportion'])
        expect(refund + terms + faq).not.toContain(old)
    }
  })
})
