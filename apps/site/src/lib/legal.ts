/**
 * 条款三页（用户条款、隐私政策、退款政策）：正文在 `src/content/legal/<页>.md` 与 `<页>.en.md`。
 * 源文件开头的 HTML 注释（「上线前建议律师审阅」）只给改稿的人看，不上页面。
 * 正文里的 `{{OPERATOR_LEGAL_NAME}}` 等占位由 `config.ts` 填；没填的照原样显示，一眼看得出还没填。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CONTACT_EMAIL,
  GITHUB_ISSUES_URL,
  LEGAL_EFFECTIVE_DATE,
  OPERATOR_LEGAL_NAME,
  SITE_URL,
} from '../config.js'
import { type Lang, type RenderedDoc, renderDoc, stripSourceComments } from './markdown.js'
import { repoRoot } from './paths.js'

export const LEGAL_PAGES = ['terms', 'privacy', 'refund'] as const
export type LegalPage = (typeof LEGAL_PAGES)[number]
export const LEGAL_DIR = 'apps/site/src/content/legal'

export function fillPlaceholders(text: string): string {
  const vars: Record<string, string> = {
    // 公司全称与邮箱没给之前，留着原样的 {{…}}，所以这两项不替换
    ...(OPERATOR_LEGAL_NAME.startsWith('{{') ? {} : { OPERATOR_LEGAL_NAME }),
    ...(CONTACT_EMAIL.startsWith('{{') ? {} : { CONTACT_EMAIL }),
    EFFECTIVE_DATE: LEGAL_EFFECTIVE_DATE,
    SITE_URL,
    ISSUES_URL: GITHUB_ISSUES_URL,
  }
  return text.replace(/\{\{([A-Z_]+)\}\}/gu, (whole, k: string) => vars[k] ?? whole)
}

export function legalSource(page: LegalPage, lang: Lang, root: string = repoRoot()): string {
  return readFileSync(join(root, LEGAL_DIR, lang === 'en' ? `${page}.en.md` : `${page}.md`), 'utf8')
}

export function loadLegal(page: LegalPage, lang: Lang, root: string = repoRoot()): RenderedDoc {
  const text = fillPlaceholders(stripSourceComments(legalSource(page, lang, root)))
  return renderDoc(text, { lang, helpSlugs: [], internal: 'site' })
}
