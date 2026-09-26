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
