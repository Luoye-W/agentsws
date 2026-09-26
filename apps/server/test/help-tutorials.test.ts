/**
 * WP156（36 §7 第 7 条「信息一条都不丢」）：模型「加一个」那几张卡上**不再铺步骤与外链**，
 * 它们搬进了教程文章 `docs/help/<slug>.md`（工作台右栏「教程」面板）。
 *
 * 这一条盯住搬家没丢东西：每条模板（`MODEL_TEMPLATES`）的**每个外链**，都出现在它那家对应的
 * 中文教程里；每条模板的方案名也出现在里面（人照着卡上的方案名能在文章里找到那一节）。
 *
 * 厂商 → 教程的对照与工作台 `apps/workstation/src/lib/help.ts` 的 `HELP_BY_VENDOR` 同一份；
 * 这里再写一遍是因为两个包互不依赖（改了那边这里会红，正好提醒补文章）。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/catalog.js'
import { MODEL_TEMPLATES } from '../src/models.js'

const HELP = join(dirname(fileURLToPath(import.meta.url)), '../../../docs/help')

const HELP_BY_VENDOR: Record<string, string> = {
  deepseek: 'model-deepseek',
  'openai-compatible': 'model-openai-compatible',
  bailian: 'model-bailian',
  openai: 'model-openai',
  anthropic: 'model-anthropic',
  'agentsws-cloud': 'agentsws-credits',
}

describe('模型模板的步骤与外链都搬进了教程（WP156）', () => {
  it('每一家都有教程', () => {
    for (const tpl of MODEL_TEMPLATES) {
      expect(tpl.vendor, `${tpl.label} 没有 vendor`).toBeDefined()
      expect(HELP_BY_VENDOR[tpl.vendor ?? ''], `${tpl.vendor} 没有对应的教程`).toBeDefined()
    }
  })

  it('每条模板的每个外链都在对应的中文教程里；方案名也在', () => {
    for (const tpl of MODEL_TEMPLATES) {
      const slug = HELP_BY_VENDOR[tpl.vendor ?? '']
      const zh = readFileSync(join(HELP, `${slug}.md`), 'utf8')
      const en = readFileSync(join(HELP, `${slug}.en.md`), 'utf8')
      for (const link of tpl.links) {
        // 站内的（云那张卡的「价目表与余额」→ /settings）在文章里写成设置页的站内链接
        if (link.url.startsWith('/')) {
          expect(zh, `${slug}.md 缺站内链接 ${link.url}`).toContain(`](${link.url}`)
          continue
        }
        expect(zh, `${slug}.md 缺 ${link.label}（${link.url}）`).toContain(link.url)
        expect(en, `${slug}.en.md 缺 ${link.label}（${link.url}）`).toContain(link.url)
      }
      const plan = (tpl.plan_label ?? '').replace(/（.*）$/, '')
      if (plan !== '' && tpl.kind !== 'agentsws_cloud')
        expect(zh, `${slug}.md 里找不到方案「${plan}」`).toContain(plan)
    }
  })
})

/**
 * WP157：连接页的 provider 卡也不再铺「要准备什么」的步骤与外链——搬进了每类连接一篇的教程
 * （`docs/help/conn-*.md`）。对照与工作台 `lib/help.ts` 的 `HELP_BY_SERVICE` 同一份。
 */
const HELP_BY_SERVICE: Record<string, string> = {
  shopify_admin: 'conn-shopify',
  imap_smtp: 'conn-email',
  gmail: 'conn-google',
  ga4: 'conn-google',
  gsc: 'conn-google',
  youtube_data: 'conn-google',
  google_ads: 'conn-google',
  google_alerts: 'conn-google',
  meta_ads: 'conn-meta',
  instagram_graph: 'conn-meta',
  facebook_graph: 'conn-meta',
  meta_graph: 'conn-meta',
  meta_marketing: 'conn-meta',
  whatsapp_business: 'conn-meta',
  tiktok_research: 'conn-tiktok',
  tiktok_content: 'conn-tiktok',
  tiktok_ads: 'conn-tiktok',
  x_api: 'conn-x',
  x_ads: 'conn-x',
  reddit: 'conn-community',
  discord_bot: 'conn-community',
  telegram_bot: 'conn-community',
  klaviyo: 'conn-marketing-logistics',
  shopify_email: 'conn-marketing-logistics',
  aftership: 'conn-marketing-logistics',
  track17: 'conn-marketing-logistics',
}

/** 步骤正文里顺手写着的网址（Reddit 的应用页、Google Alerts）也算外链。 */
const URL_IN_TEXT = /https?:\/\/[^\s，。）)]+/g

describe('连接目录的步骤与外链都搬进了教程（WP157）', () => {
  it('每个连接都有教程', () => {
    for (const entry of CATALOG)
      expect(HELP_BY_SERVICE[entry.service], `${entry.service} 没有对应的教程`).toBeDefined()
  })

  it('每个连接的每个外链（含步骤里写着的）都在中英两份教程里；名字在中文那份里', () => {
    for (const entry of CATALOG) {
      const slug = HELP_BY_SERVICE[entry.service]
      const zh = readFileSync(join(HELP, `${slug}.md`), 'utf8')
      const en = readFileSync(join(HELP, `${slug}.en.md`), 'utf8')
      const urls = [
        ...entry.setup_guide.links.map((l) => l.url),
        ...entry.setup_guide.steps.flatMap((s) => s.match(URL_IN_TEXT) ?? []),
      ]
      for (const url of urls) {
        expect(zh, `${slug}.md 缺 ${entry.service} 的 ${url}`).toContain(url)
        expect(en, `${slug}.en.md 缺 ${entry.service} 的 ${url}`).toContain(url)
      }
      expect(zh, `${slug}.md 里找不到「${entry.label}」`).toContain(entry.label)
      // 步骤条数对得上：每个连接那一节至少有它那么多条编号步骤（拆开写可以多，不能少）
      const section = zh.slice(zh.indexOf(`## ${entry.label}`))
      const next = section.indexOf('\n## ', 3)
      const body = next === -1 ? section : section.slice(0, next)
      const numbered = body.match(/^\d+\. /gm)?.length ?? 0
      expect(numbered, `${slug}.md「${entry.label}」一节的步骤少了`).toBeGreaterThanOrEqual(
        entry.setup_guide.steps.length,
      )
    }
  })
})
