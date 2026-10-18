/**
 * WP398：Amazon 词库三个工具的执行器（名字 / 描述在 `@agentsws/stand-ins` 的 `runtime/amazon-keywords.ts`）。
 *
 * - `read_amazon_keywords`：刷新一次（读前台联想词 + 拆 Listing + 算差距）；
 * - `get_amazon_keywords`：看词库与差距（不读页面）；
 * - `mark_amazon_keyword`：标一个词 / 自己加一个词（只动本机）。
 *
 * 回给模型的就是存下来的那一份；`sort_note` 让模型照抄（一期没有搜索量）。
 */
import {
  AMAZON_KEYWORD_MARKS,
  AMAZON_KEYWORD_OTHER_BRAND_ZH,
  AMAZON_KEYWORD_SORT_NOTE_ZH,
  AMAZON_KEYWORD_SOURCES,
  type AmazonKeywordBankView,
  type AmazonKeywordMark,
  type AmazonKeywordQuery,
  type AmazonKeywordRow,
  type AmazonKeywordSource,
} from '@agentsws/contracts'
import {
  AMAZON_KEYWORDS_ADDRESS,
  GET_AMAZON_KEYWORDS_TOOL,
  isAmazonKeywordRole,
  MARK_AMAZON_KEYWORD_TOOL,
  READ_AMAZON_KEYWORDS_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { AmazonKeywordBank } from './service.js'

export interface AmazonKeywordToolsOptions {
  /** 这个品牌的词库（托管实例 / 没装 = `undefined`）。 */
  bank(workspace_id: string): Promise<AmazonKeywordBank | undefined>
}

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
const ok = (data: unknown): ToolExecution => ({ status: 'ok', data })

const marksOf = (v: unknown): AmazonKeywordMark[] =>
  Array.isArray(v)
    ? v.filter((m): m is AmazonKeywordMark => AMAZON_KEYWORD_MARKS.includes(m as AmazonKeywordMark))
    : []

const rowView = (r: AmazonKeywordRow): Record<string, unknown> => ({
  id: r.id,
  term: r.term,
  sources: r.sources,
  competitors: r.competitors,
  in_own_text: r.in_own_text,
  gap: r.gap,
  ...(r.marks.length === 0 ? {} : { marks: r.marks }),
  ...(r.other_brand === undefined
    ? {}
    : { other_brand: r.other_brand, warning: AMAZON_KEYWORD_OTHER_BRAND_ZH }),
})

/** 给模型看的摘要（每个自家 ASIN 的差距词前 15 个）。 */
function summary(v: AmazonKeywordBankView, asin?: string): Record<string, unknown> {
  const gaps = asin === undefined ? v.gaps : v.gaps.filter((g) => g.asin === asin.toUpperCase())
  return {
    total: v.total,
    gap_terms: v.gap_terms,
    other_brand_terms: v.other_brand_terms,
    by_source: v.by_source,
    ...(v.updated_at === undefined ? {} : { updated_at: v.updated_at }),
    listings_split: v.listings,
    gaps: gaps.map((g) => ({
      asin: g.asin,
      marketplace: g.marketplace,
      ...(g.title === undefined ? {} : { title: g.title }),
      competitors_compared: g.competitors_compared,
      common_gap_terms: g.common,
      terms: g.terms.slice(0, 15).map((t) => ({
        id: t.id,
        term: t.term,
        competitors: t.competitors,
        competitor_names: t.competitor_names,
        missing_words: t.missing_words,
      })),
    })),
    sort_note: AMAZON_KEYWORD_SORT_NOTE_ZH,
    open: AMAZON_KEYWORDS_ADDRESS,
    detail: `完整词表（可按来源筛、可标记）在第三栏：回答里放一个按钮 action=open:${AMAZON_KEYWORDS_ADDRESS}。`,
  }
}

export function createAmazonKeywordToolExecutor(options: AmazonKeywordToolsOptions): ToolExecutor {
  return async (call) => {
    const name = bare(call.name)
    const req = call.request
    if (!isAmazonKeywordRole(req.actor.role_id))
      return { status: 'blocked', reason: 'Amazon 词库只给亚马逊店铺运营。' }
    const bank = await options.bank(req.workspace_id)
    if (bank === undefined)
      return { status: 'error', reason: '这台机器没装 Amazon 词库（托管实例读不了 Amazon 前台）。' }
    const input = call.input
    if (name === READ_AMAZON_KEYWORDS_TOOL) {
      const seeds = Array.isArray(input.seeds)
        ? input.seeds.filter((s): s is string => typeof s === 'string')
        : undefined
      const r = await bank.refresh({
        trigger: 'tool',
        ...(seeds === undefined ? {} : { seeds }),
        ...(typeof input.marketplace === 'string' ? { marketplace: input.marketplace } : {}),
        ...(input.autocomplete === false ? { autocomplete: false } : {}),
      })
      return ok({
        ok: r.refresh.autocomplete.status !== 'failed' || r.refresh.listings.own > 0,
        refresh: {
          autocomplete: r.refresh.autocomplete,
          listings: r.refresh.listings,
          added: r.refresh.added,
          gap_terms: r.refresh.gap_terms,
        },
        ...summary(r.view),
      })
    }
    if (name === GET_AMAZON_KEYWORDS_TOOL) {
      const v = bank.view()
      if (v.total === 0 && v.updated_at === undefined)
        return ok({ ok: false, message: '还没有词库。用 read_amazon_keywords 刷新一次。' })
      const q: AmazonKeywordQuery = {
        ...(AMAZON_KEYWORD_SOURCES.includes(input.source as AmazonKeywordSource)
          ? { source: input.source as AmazonKeywordSource }
          : {}),
        ...(marksOf([input.mark])[0] === undefined ? {} : { mark: marksOf([input.mark])[0] }),
        ...(input.gap === true ? { gap: true } : {}),
        ...(input.other_brand === true ? { other_brand: true } : {}),
        ...(typeof input.q === 'string' ? { q: input.q } : {}),
        limit: typeof input.limit === 'number' ? Math.min(100, Math.max(1, input.limit)) : 30,
      }
      const page = bank.list(q)
      return ok({
        ok: true,
        ...summary(v, typeof input.asin === 'string' ? input.asin : undefined),
        rows: { total: page.total, items: page.items.map(rowView) },
      })
    }
    if (name === MARK_AMAZON_KEYWORD_TOOL) {
      const r = bank.mark({
        ...(typeof input.id === 'string' ? { id: input.id } : {}),
        ...(typeof input.term === 'string' ? { term: input.term } : {}),
        ...(typeof input.marketplace === 'string' ? { marketplace: input.marketplace } : {}),
        add: marksOf(input.add),
        remove: marksOf(input.remove),
      })
      if (!r.ok) return ok({ ok: false, message: r.message })
      return ok({
        ok: true,
        keyword: { id: r.keyword.id, term: r.keyword.term, marks: r.keyword.marks },
        note: '只改了本机词库；Amazon 上什么都没动。',
      })
    }
    return { status: 'error', reason: `不认识的工具：${call.name}` }
  }
}
