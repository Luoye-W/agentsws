/**
 * WP420（自查 ads-amazon A7）：职责定义里 `grounding[].tool` 点名的工具**必须真有**。
 *
 * 以前投放那几条写的 `list_ad_campaigns` / `read_spend_gate` / `route_to_site_builder` 全仓一个都没有，
 * 运行时按 `offerable` 静默丢掉——「加预算前先看总闸」那条预取从来没发生过，没人知道。
 *
 * - 投放（Google / Meta）与 Amazon 两族：一个不存在的都不许有；
 * - 别的职责：现有的那些不存在的名字记成一张「已知待修」表，**只许减不许加**（各岗位单子自己修）。
 */

import { loadBundledRoles } from '@agentsws/roles'
import * as standIns from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { POLICY_TOOL } from '../src/records.js'

/** 服务进程里真有执行器的工具名（宿主工具表 + 默认那几个读工具）。 */
const KNOWN = new Set<string>([
  'get_order',
  'get_product',
  'list_orders',
  POLICY_TOOL,
  'search_creators',
  ...Object.entries(standIns).flatMap(([name, v]) =>
    name.endsWith('TOOL_NAMES') && Array.isArray(v) ? (v as string[]) : [],
  ),
])

/** 别的岗位现有的、指向不存在工具的 grounding（各岗位单子去修；这张表只许减）。 */
const KNOWN_DEBT = new Set<string>([
  'get_brand_system',
  'list_ad_campaigns',
  'list_community_threads',
  'list_design_requests',
  'list_external_posts',
  'list_forum_threads',
  'list_mentions',
  'list_press_releases',
  'list_social_posts',
  'read_reddit',
  'read_spend_gate',
  'read_youtube_transcript',
  'route_to_community_support',
  'route_to_site_builder',
  'route_to_support',
  'search_facts',
  'shopify.docs.search',
  'shopify.order.get',
  'shopify.shop.get',
  'shopify.theme.list',
  'site.apps.catalog',
  'site.apps.list',
  'site.checklist.run',
  'site.email.list',
])

const roles = loadBundledRoles()
const missing = (prefix: RegExp) =>
  roles
    .filter((r) => prefix.test(r.id))
    .flatMap((r) => r.grounding.map((g) => ({ role: r.id, tool: g.tool })))
    .filter((x) => !KNOWN.has(x.tool))

describe('grounding 点名的工具必须真有（A7）', () => {
  it('投放 Google / Meta、Amazon 两族：一个不存在的都没有', () => {
    expect(missing(/^(ads\.(google|meta)|amz\.)/u)).toEqual([])
  })

  it('「加预算前先看总闸」那条预取指向查数工具', () => {
    for (const id of ['ads.meta', 'ads.google']) {
      const g = roles
        .find((r) => r.id === id)
        ?.grounding.find((x) => x.name === 'spend_gate_before_increase')
      expect(g).toMatchObject({ tool: 'query_ads_data', prefetch: true })
    }
  })

  it('别的职责：不存在的工具名只许减不许加（新加的必须先有执行器）', () => {
    const extra = [...new Set(missing(/./u).map((x) => x.tool))].filter((t) => !KNOWN_DEBT.has(t))
    expect(extra).toEqual([])
  })
})
