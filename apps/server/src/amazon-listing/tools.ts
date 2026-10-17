/**
 * WP396：Listing 体检三个工具的执行器（名字 / 描述在 `@agentsws/stand-ins` 的 `runtime/amazon-listing.ts`）。
 *
 * - `read_amazon_listings`：体检一次（{@link AmazonListingCheckup.run}）。自家 ASIN 没填 → 回 `needs_setup`，运行时出配置卡；
 * - `get_listing_checkup`：最近一次的结果（不读页面）；
 * - `set_listing_check_rule`：改一条规则的建议值 / 开关 / 核对日期，或记下自家店铺名（只动本机）。
 *
 * 回给模型的数据就是存下来的那一份（数字照页面原样）；结尾那一句 `footer` 让模型照抄。
 */
import {
  LISTING_CHECKUP_FOOTER_ZH,
  type ListingCheckupItem,
  type ListingCheckupRun,
} from '@agentsws/contracts'
import {
  GET_LISTING_CHECKUP_TOOL,
  isAmazonListingRole,
  READ_AMAZON_LISTINGS_TOOL,
  SET_LISTING_CHECK_RULE_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { AmazonListingCheckup } from './service.js'

export interface AmazonListingToolsOptions {
  /** 这个品牌的体检（托管实例 / 没装 = `undefined`）。 */
  checkup(workspace_id: string): Promise<AmazonListingCheckup | undefined>
}

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
const ok = (data: unknown): ToolExecution => ({ status: 'ok', data })

/** 给模型看的一份（问题按严重程度排好；面板上看详情的提示）。 */
function runView(run: ListingCheckupRun, only?: string): Record<string, unknown> {
  const items: ListingCheckupItem[] =
    only === undefined ? run.items : run.items.filter((i) => i.asin === only.toUpperCase())
  return {
    checked_at: run.finished_at,
    summary: run.summary,
    ...(run.stopped === undefined
      ? {}
      : { stopped: run.stopped, stopped_message: run.stopped_message }),
    items: items.map((i) => ({
      asin: i.asin,
      marketplace: i.marketplace,
      url: i.url,
      status: i.status,
      ...(i.message === undefined ? {} : { message: i.message }),
      ...(i.title === undefined ? {} : { title: i.title }),
      facts: i.facts ?? {},
      not_read: ['rating', 'reviews_count', 'price'].filter(
        (k) =>
          i.status === 'checked' &&
          (i.facts as Record<string, unknown> | undefined)?.[k] === undefined,
      ),
      issues: i.issues.map((x) => ({
        severity: x.severity,
        rule_id: x.rule_id,
        rule_name: x.rule_name,
        source:
          x.source.url === undefined ? x.source.title : `${x.source.title}（${x.source.url}）`,
        source_kind: x.source.kind,
        ...(x.rule_stale ? { rule_stale: true } : {}),
        now: x.now,
        suggestion: x.suggestion,
        ...(x.draft === undefined ? {} : { draft: x.draft }),
        ...(x.design_request === undefined ? {} : { design_request: true }),
        ...(x.needs_human ? { needs_human: true } : {}),
      })),
      human_checks: i.human_checks,
      ...(i.previous === undefined ? {} : { previous: i.previous }),
    })),
    detail: '每个 ASIN 的详情（带「向设计岗下需求单」按钮）在右边面板「Listing 体检」里。',
    footer: LISTING_CHECKUP_FOOTER_ZH,
  }
}

export function createAmazonListingToolExecutor(options: AmazonListingToolsOptions): ToolExecutor {
  return async (call) => {
    const name = bare(call.name)
    const req = call.request
    if (!isAmazonListingRole(req.actor.role_id))
      return { status: 'blocked', reason: 'Listing 体检只给亚马逊店铺运营。' }
    const svc = await options.checkup(req.workspace_id)
    if (svc === undefined)
      return {
        status: 'error',
        reason: '这台机器没装 Listing 体检（托管实例读不了 Amazon 前台）。',
      }
    const input = call.input
    if (name === READ_AMAZON_LISTINGS_TOOL) {
      const asins = Array.isArray(input.asins)
        ? input.asins.filter((a): a is string => typeof a === 'string')
        : undefined
      const r = await svc.run({ trigger: 'tool', ...(asins === undefined ? {} : { asins }) })
      if (r.needs_setup !== undefined)
        return ok({ ok: false, needs_setup: r.needs_setup, message: r.message })
      if (r.run === undefined) return ok({ ok: false, message: r.message })
      return ok({
        ok: r.run.stopped !== 'unavailable',
        ...runView(r.run),
        ...(r.message === undefined ? {} : { message: r.message }),
      })
    }
    if (name === GET_LISTING_CHECKUP_TOOL) {
      const latest = svc.latest()
      const rules =
        input.rules === true
          ? svc.rules().map((r) => ({
              id: r.id,
              name: r.name.zh,
              severity: r.severity,
              enabled: r.enabled,
              params: r.params,
              source: r.source,
              checked_at: r.checked_at,
            }))
          : undefined
      if (latest === undefined)
        return ok({
          ok: false,
          message: '还没体检过。用 read_amazon_listings 体检一次。',
          ...(rules === undefined ? {} : { rules }),
        })
      return ok({
        ok: true,
        ...runView(latest, typeof input.asin === 'string' ? input.asin : undefined),
        ...(rules === undefined ? {} : { rules }),
      })
    }
    if (name === SET_LISTING_CHECK_RULE_TOOL) {
      const own = Array.isArray(input.own_sellers)
        ? input.own_sellers.filter((s): s is string => typeof s === 'string')
        : undefined
      const r = svc.setRule({
        ...(typeof input.rule_id === 'string' ? { rule_id: input.rule_id } : {}),
        ...(typeof input.params === 'object' &&
        input.params !== null &&
        !Array.isArray(input.params)
          ? { params: input.params as Record<string, unknown> }
          : {}),
        ...(typeof input.enabled === 'boolean' ? { enabled: input.enabled } : {}),
        ...(typeof input.checked_at === 'string' ? { checked_at: input.checked_at } : {}),
        ...(own === undefined ? {} : { own_sellers: own }),
      })
      return ok({
        ...r,
        ...(own === undefined ? {} : { own_sellers: await svc.ownSellers() }),
        note: '只改了本机的体检设置；下次体检按新的判。',
      })
    }
    return { status: 'error', reason: `不认识的工具：${call.name}` }
  }
}
