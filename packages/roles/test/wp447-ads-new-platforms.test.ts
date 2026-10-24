/**
 * WP447（docs/109 §6）：投放补的六条新平台职责——第一期只读、岗位里默认不勾、意图词按平台分开。
 */
import { ADS_READ_ONLY_PLATFORM_IDS, adsPlatformSpec } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import {
  loadBundledPosition,
  loadBundledRole,
  roleRouteTerms,
  routeWithinPosition,
} from '../src/index.js'

const NEW = ADS_READ_ONLY_PLATFORM_IDS.map((p) => `ads.${p}`)

describe('六条新平台职责', () => {
  it('都在投放岗位里、全部默认不勾', () => {
    const ads = loadBundledPosition('ads')
    for (const id of NEW) expect(ads.roles.find((r) => r.role === id)?.default, id).toBe(false)
    // 老四条的默认值不动
    expect(ads.roles.filter((r) => r.default).map((r) => r.role)).toEqual([
      'ads.meta',
      'ads.google',
    ])
  })

  it('一条写动作都没有（连止损暂停都没有），数据域只读', () => {
    for (const id of NEW) {
      const role = loadBundledRole(id)
      expect(role.actions, id).toEqual([])
      expect(Object.keys(role.automation), id).toEqual([])
      for (const s of role.scopes) expect(s.ops, `${id} ${s.domain}`).toEqual(['read'])
      // approval 只读本人的：不读它连一件事都开不了（岗位页开事项要它）
      // knowledge 只读（决策 1398）：毛利率事实卡要读得到，和老四条一样
      expect(role.scopes.map((s) => s.domain).sort()).toEqual([
        'ad_account',
        'analytics',
        'approval',
        'knowledge',
      ])
    }
  })

  it('连接器 kind 就是契约里那一条，而且不是必需的', () => {
    for (const p of ADS_READ_ONLY_PLATFORM_IDS) {
      const role = loadBundledRole(`ads.${p}`)
      expect(role.connectors.map((c) => c.kind)).toEqual([adsPlatformSpec(p)?.connector_kind])
      expect(role.connectors.every((c) => c.required === false)).toBe(true)
    }
  })

  it('快捷问题三条：体检、上周花了多少带回多少、哪些系列该看；面板一张概况 + 体检', () => {
    for (const id of NEW) {
      const role = loadBundledRole(id)
      expect(role.quick_prompts?.map((q) => q.id)).toEqual([
        'account_audit',
        'last_week',
        'campaigns_to_watch',
        // WP452：保本线、广告与落地页（都不碰账户）
        'break_even',
        'landing_check',
      ])
      expect(role.home_blocks.map((b) => b.query)).toEqual([
        'ads.export_spend',
        'ads.export_overview',
        'ads.export_audit',
        'ads.break_even_calc',
        'ads.landing_checks',
      ])
      // 「你不负责」里写清：改广告这一期不做
      expect(role.persona.zh).toMatch(/你不负责：改广告（这一期只读/)
    }
    expect(loadBundledRole('ads.apple').persona.zh).toContain('只推 App')
  })

  describe('投放岗位里按平台名分得开（54 §2）', () => {
    const profiles = loadBundledPosition('ads').roles.map((r) => {
      const def = loadBundledRole(r.role)
      return {
        role_id: def.id,
        role_name: def.name.zh,
        terms: roleRouteTerms(def),
        positions: [{ position_id: 'ads', person_id: 'p_wang' }],
      }
    })
    const cases: [string, string][] = [
      ['必应上周花了多少', 'ads.microsoft'],
      ['Bing 广告的报表看一下', 'ads.microsoft'],
      ['Pinterest 广告账户体检', 'ads.pinterest'],
      ['Reddit 广告花费多少', 'ads.reddit'],
      ['领英广告上周带回多少', 'ads.linkedin'],
      ['Snapchat 广告报表', 'ads.snapchat'],
      ['App Store 上的广告花了多少', 'ads.apple'],
      ['谷歌搜索广告上周花了多少', 'ads.google'],
      // 老的照旧
      ['FB 那条广告 ROAS 掉了', 'ads.meta'],
    ]
    for (const [text, expected] of cases)
      it(`「${text}」→ ${expected}`, () => {
        expect(routeWithinPosition(text, profiles).candidates[0]?.role_id).toBe(expected)
      })
  })
})
