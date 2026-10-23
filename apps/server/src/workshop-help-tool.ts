/**
 * 教程上官网（私有 docs/113 §5）：「查工坊帮助」`search_workshop_help` 的执行器与本机搜索。
 *
 * 搜的是本机帮助库（`help-library.ts`：官网拉回来存在本机的教程、工坊笔记、更新日志 + 安装包自带的教程），
 * **问题一个字都不发出去**。不引搜索库：几十篇、几百 KB，按词打分就够——
 * 英文按词，中文按相邻两个字（「连邮」「邮箱」）；标题里有的加得最多、摘要次之，正文按出现次数的对数算，常见词权重低。
 * 每篇只回最相关的那一节（按 `##` 切），截到几百字。
 */
import type { HelpCatalogEntry, HelpKind, HelpLang } from '@agentsws/contracts'
import {
  SEARCH_WORKSHOP_HELP_TOOL,
  type ToolExecutor,
  type WorkshopHelpHit,
  type WorkshopHelpResult,
} from '@agentsws/stand-ins'
import type { HelpLibrary } from './help-library.js'

export type HelpDoc = HelpCatalogEntry & { markdown: string }

const CJK = /[㐀-鿿豈-﫿]/u

/** 切词：英文 / 数字按词（两个字母以上），中文按相邻两字（单字的也留）。 */
export function helpTokens(text: string): string[] {
  const out: string[] = []
  const lower = text.toLowerCase()
  for (const m of lower.matchAll(/[a-z0-9][a-z0-9.+#-]*[a-z0-9+#]|[a-z0-9]{2,}/gu)) out.push(m[0])
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/gu) ?? []) {
    const chars = [...run]
    if (chars.length === 1) out.push(run)
    for (let i = 0; i + 1 < chars.length; i += 1) out.push(`${chars[i]}${chars[i + 1]}`)
  }
  return out
}

const count = (tokens: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>()
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1)
  return m
}

interface Section {
  heading?: string
  text: string
}

/** 按 `##` 切成几节（第一节是标题下面那段开场白）。 */
function sectionsOf(markdown: string): Section[] {
  const out: Section[] = []
  let cur: Section = { text: '' }
  for (const line of markdown.split('\n')) {
    const h = /^#{2,3}\s+(.+)$/u.exec(line)
    if (h?.[1] !== undefined) {
      if (cur.text.trim() !== '' || cur.heading !== undefined) out.push(cur)
      cur = { heading: h[1].trim(), text: '' }
    } else if (!/^#\s/u.test(line)) {
      cur.text += `${line}\n`
    }
  }
  if (cur.text.trim() !== '' || cur.heading !== undefined) out.push(cur)
  return out
}

/** 去掉行内记号，截到 `max` 个字。 */
function plain(text: string, max: number): string {
  const flat = text
    .replace(/!\[([^\]\n]*)\]\([^)\s]*\)/gu, '$1')
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, '$1')
    .replace(/\*\*|__|`/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export interface HelpSearchOptions {
  kind?: HelpKind
  limit?: number
  excerptChars?: number
}

/** 在一批文章里搜；回最相关的几篇（分数从高到低），一篇都不像就回空。 */
export function searchHelpDocs(
  docs: readonly HelpDoc[],
  query: string,
  options: HelpSearchOptions = {},
): WorkshopHelpHit[] {
  const q = [...new Set(helpTokens(query))]
  if (q.length === 0) return []
  const pool = options.kind === undefined ? docs : docs.filter((d) => d.kind === options.kind)
  const prepared = pool.map((d) => ({
    doc: d,
    title: count(helpTokens(d.title)),
    desc: count(helpTokens(d.description)),
    body: count(helpTokens(d.markdown)),
  }))
  const n = prepared.length
  const idf = new Map<string, number>()
  for (const t of q) {
    const df = prepared.filter((p) => p.title.has(t) || p.desc.has(t) || p.body.has(t)).length
    idf.set(t, Math.log(1 + n / Math.max(df, 1)))
  }
  // 至少要对上三分之一的词（一个词的问题对上那一个就行）
  const need = Math.max(1, Math.ceil(q.length / 3))
  const scored = prepared
    .map((p) => {
      let score = 0
      let matched = 0
      for (const t of q) {
        const inTitle = p.title.has(t)
        const inDesc = p.desc.has(t)
        const tf = p.body.get(t) ?? 0
        if (!inTitle && !inDesc && tf === 0) continue
        matched += 1
        const w = idf.get(t) ?? 0
        // 标题、摘要里有：说明这篇就是讲它的；正文里出现多少次只算对数
        score += w * ((inTitle ? 3 : 0) + (inDesc ? 1.5 : 0) + (tf === 0 ? 0 : 1 + Math.log(tf)))
      }
      return { p, score, matched }
    })
    .filter((x) => x.matched >= need && x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit ?? 3)
  return scored.map(({ p }) => {
    const d = p.doc
    // 最相关的那一节
    let best: Section | undefined
    let bestScore = -1
    for (const s of sectionsOf(d.markdown)) {
      const toks = count(helpTokens(`${s.heading ?? ''} ${s.text}`))
      let sc = 0
      for (const t of q) if (toks.has(t)) sc += (idf.get(t) ?? 0) * (1 + Math.log(toks.get(t) ?? 1))
      if (sc > bestScore) {
        bestScore = sc
        best = s
      }
    }
    const hit: WorkshopHelpHit = {
      kind: d.kind,
      title: d.title,
      description: d.description,
      excerpt: plain(best?.text ?? d.markdown, options.excerptChars ?? 600),
      needs_newer_app: d.needs_newer_app,
    }
    if (d.url !== undefined) hit.url = d.url
    if (best?.heading !== undefined) hit.section = best.heading
    if (d.requires !== undefined) hit.requires = d.requires
    return hit
  })
}

/** 问题是中文就先查中文那份，否则先查英文；先查的那份没有再查另一份。 */
export function searchWorkshopHelp(
  library: Pick<HelpLibrary, 'corpus'>,
  query: string,
  kind?: HelpKind,
): WorkshopHelpResult {
  const first: HelpLang = CJK.test(query) ? 'zh' : 'en'
  const second: HelpLang = first === 'zh' ? 'en' : 'zh'
  const opts = kind === undefined ? {} : { kind }
  let results = searchHelpDocs(library.corpus(first), query, opts)
  if (results.length === 0) results = searchHelpDocs(library.corpus(second), query, opts)
  return {
    query,
    results,
    message:
      results.length === 0
        ? '教程、工坊笔记和更新日志里都没找到。照实告诉用户没查到，不要编；可以建议换个说法问，或去官网 https://agentsws.com/docs/ 看全部教程。'
        : '照查到的回答：先给答案，末尾附上那一篇的 url；needs_newer_app 为 true 的说明是新版才有。',
  }
}

/** 岗位那边的执行器（所有职责都有；只读本机）。 */
export function createWorkshopHelpTool(library: () => Pick<HelpLibrary, 'corpus'>): ToolExecutor {
  return async (call) => {
    if (call.name.split('.').pop() !== SEARCH_WORKSHOP_HELP_TOOL)
      return { status: 'error', reason: 'unknown_tool' }
    const input = (call.input ?? {}) as Record<string, unknown>
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 200) : ''
    if (query === '') return { status: 'error', reason: 'query 不能为空' }
    const kind =
      input.kind === 'guide' || input.kind === 'note' || input.kind === 'changelog'
        ? input.kind
        : undefined
    return { status: 'ok', data: searchWorkshopHelp(library(), query, kind) }
  }
}
