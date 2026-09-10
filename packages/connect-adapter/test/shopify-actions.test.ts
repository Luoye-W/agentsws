/**
 * WP44：Shopify Admin 写动作 → 变更种类对照表。
 *
 * 这张表是"Agent 能操作店铺"与"写只能 stage"两件事的接缝，所以它自己要能被钉住：
 * 每一条要么有 kind，要么写清楚为什么没有；副作用表里那些 shopify 写动作都要在表里
 * 有交代；读动作一个都不许溜进来。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  actionsOfChangeKind,
  canStageAction,
  changeKindOfAction,
  defaultSideEffectsFile,
  loadSideEffectTable,
  SHOPIFY_WRITE_ACTIONS,
  shopifyWriteAction,
} from '../src/index.js'

const TABLE = loadSideEffectTable()
const YAML_TEXT = readFileSync(defaultSideEffectsFile(), 'utf8')

describe('Shopify 写动作对照表', () => {
  it('每条要么给 kind，要么写清楚为什么不能 stage —— 不许两头空', () => {
    for (const entry of SHOPIFY_WRITE_ACTIONS) {
      const has = entry.change_kind !== undefined
      const explained = (entry.not_stageable ?? '').trim().length > 0
      expect(has || explained, `${entry.action_id} 既没有 kind 也没写理由`).toBe(true)
      // 有 kind 就不该同时写"不能 stage"，那是自相矛盾
      expect(has && explained, `${entry.action_id} 又有 kind 又说不能 stage`).toBe(false)
      expect(entry.what.trim().length, `${entry.action_id} 没写它干什么`).toBeGreaterThan(0)
      expect(entry.action_id.startsWith('shopify_admin.')).toBe(true)
    }
  })

  it('表里每条在副作用表里都是 write（读动作一条都不许混进来）', () => {
    for (const entry of SHOPIFY_WRITE_ACTIONS) {
      expect(TABLE.resolve(entry.action_id), entry.action_id).toBe('write')
    }
  })

  it('副作用表里显式标 write 的 shopify 动作，都在对照表里有交代', () => {
    // 例外只有两个：GraphQL 直通与批量查询，它们的副作用取决于运行时传进来的文档
    const exempt = new Set(['shopify_admin.execute_graphql', 'shopify_admin.submit_bulk_query'])
    const declared = new Set(SHOPIFY_WRITE_ACTIONS.map((a) => a.action_id))
    const missing = [...yamlShopifyWrites()].filter((id) => !exempt.has(id) && !declared.has(id))
    expect(missing, `这些写动作还没说清楚对应哪条变更种类：${missing.join(', ')}`).toEqual([])
  })

  it('店铺运营的关键写口都有 kind：改价、上下架、详情、促销、主题发布', () => {
    expect(changeKindOfAction('shopify_admin.update_product_price')).toBe('price_change')
    expect(changeKindOfAction('shopify_admin.publish_product')).toBe('publish_product')
    expect(changeKindOfAction('shopify_admin.unpublish_product')).toBe('unpublish_product')
    expect(changeKindOfAction('shopify_admin.update_product')).toBe('listing_edit')
    expect(changeKindOfAction('shopify_admin.create_automatic_discount')).toBe('promotion')
    expect(changeKindOfAction('shopify_admin.create_discount_code')).toBe('discount_code')
    expect(changeKindOfAction('shopify_admin.publish_theme')).toBe('publish_theme')
  })

  it('缺 kind 的那几个：库存、取消订单、删除类 —— 说得出为什么', () => {
    for (const id of [
      'shopify_admin.set_inventory_quantities',
      'shopify_admin.adjust_inventory_quantities',
      'shopify_admin.cancel_order',
      'shopify_admin.delete_product',
      'shopify_admin.delete_theme',
    ]) {
      const verdict = canStageAction(id)
      expect(verdict.ok, id).toBe(false)
      if (verdict.ok) throw new Error('unreachable')
      expect(verdict.reason.length, id).toBeGreaterThan(10)
    }
    // 库存那两条要把"缺哪条 kind"说出来，报告与文档才知道要补什么
    expect(shopifyWriteAction('shopify_admin.set_inventory_quantities')?.not_stageable).toContain(
      'inventory_change',
    )
  })

  it('表里没有的动作一律不可 stage（未知即拒，和副作用表的 default: write 同一条纪律）', () => {
    const verdict = canStageAction('shopify_admin.some_new_thing')
    expect(verdict.ok).toBe(false)
  })

  it('GraphQL 直通永远不在表里：它的副作用由运行时传进来的文档决定', () => {
    expect(shopifyWriteAction('shopify_admin.execute_graphql')).toBeUndefined()
    expect(canStageAction('shopify_admin.execute_graphql').ok).toBe(false)
  })

  it('按 kind 反查得到施行时该调哪个动作', () => {
    expect(actionsOfChangeKind('price_change').map((a) => a.action_id)).toEqual([
      'shopify_admin.update_product_price',
    ])
    expect(actionsOfChangeKind('publish_theme').map((a) => a.action_id)).toEqual([
      'shopify_admin.publish_theme',
      'shopify_admin.update_theme_asset',
    ])
  })
})

/** 从副作用表的原文里挑出显式标了 write 的 shopify 动作。 */
function yamlShopifyWrites(): Set<string> {
  const out = new Set<string>()
  for (const line of YAML_TEXT.split('\n')) {
    const m = /^\s{2}(shopify_admin\.[a-z0-9_]+):\s*write\s*$/.exec(line)
    if (m?.[1] !== undefined) out.add(m[1])
  }
  return out
}
