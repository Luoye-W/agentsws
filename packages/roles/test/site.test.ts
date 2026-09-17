/**
 * WP77（59 §1）：建站岗位四条职责 + 岗位模板 + `site.builder` 的改名迁移。
 *
 * 钉三件事：四条各自的上限与额度就是 59 §1 那张表；旧 id 读得进来、
 * 已有分配迁得过去；**description 里写得出与网站运营的分界**——54 的路由靠它，
 * 那一行不是文案是接口。
 */
import { describe, expect, it } from 'vitest'
import {
  loadBundledPosition,
  loadBundledRole,
  ROLE_ID_ALIASES,
  resolveRoleId,
} from '../src/index.js'

describe('建站岗位（59 §1 / 54）', () => {
  it('岗位模板四条，默认全勾，顺序 = 一家新店真实的先后', () => {
    const position = loadBundledPosition('site')
    expect(position.id).toBe('site')
    expect(position.name.zh).toBe('建站')
    expect(position.roles.map((r) => r.role)).toEqual([
      'site.shopify-build',
      'site.shopify-theme',
      'site.shopify-email',
      'site.shopify-apps',
    ])
    expect(position.roles.every((r) => r.default)).toBe(true)
  })

  it('四条都装得进来，而且 description 里说得出与网站运营的分界（54 的路由读它）', () => {
    for (const id of [
      'site.shopify-build',
      'site.shopify-theme',
      'site.shopify-email',
      'site.shopify-apps',
    ] as const) {
      const role = loadBundledRole(id)
      expect(role.id, id).toBe(id)
      expect(role.domain, id).toBe('dev')
      expect(role.description.length, id).toBeGreaterThan(20)
      // 每一条都要把"这件事是我的、那件事是运营的"说出来
      expect(/运营|模板|结构|装不装/.test(role.description), id).toBe(true)
    }
  })

  it('整站搭建：设置批 L2、装主题 L1 硬顶、检查单 L3', () => {
    const role = loadBundledRole('site.shopify-build')
    expect(role.actions.map((a) => a.id)).toEqual([
      'stage_store_setup',
      'stage_theme_install',
      'run_launch_checklist',
    ])
    expect(role.automation.stage_store_setup?.ceiling).toBe('L2')
    expect(role.automation.stage_theme_install?.ceiling).toBe('L1')
    expect(role.automation.stage_theme_install?.hard_ceiling).toBe(true)
    expect(
      role.actions.find((a) => a.id === 'stage_theme_install')?.review_cannot_be_disabled,
    ).toBe(true)
    expect(role.automation.run_launch_checklist?.ceiling).toBe('L3')
    // 59 §6：设置批 5 / 天
    expect(role.actions.find((a) => a.id === 'stage_store_setup')?.mandate.caps).toMatchObject({
      max_setup_batches_per_day: 5,
    })
    // 装主题要惊动所有者，而且是立刻
    const note = role.notifications.find((n) => n.event.includes('stage_theme_install'))
    expect(note?.mode).toBe('immediate')
    expect(note?.recipients).toEqual(['owner'])
  })

  it('整站搭建碰不到结账 / 支付 / 税：写域是 store_config + content，没有第三条写口', () => {
    const role = loadBundledRole('site.shopify-build')
    const writable = role.scopes.filter((s) => s.ops.includes('stage')).map((s) => s.domain)
    expect(writable.sort()).toEqual(['approval', 'content', 'store_config'])
    // 商品只读——改价不是这个岗位的事
    expect(role.scopes.find((s) => s.domain === 'product')?.ops).toEqual(['read'])
  })

  it('邮件模板：一条动作、ceiling L2（启用那一下的门在 guardrail 上，不在 yml 里）', () => {
    const role = loadBundledRole('site.shopify-email')
    expect(role.actions.map((a) => a.id)).toEqual(['stage_email_template'])
    expect(role.automation.stage_email_template?.ceiling).toBe('L2')
    // 写在 yml 里的话草稿也自动不了——分档只能在 `after.enabled` 上
    expect(role.automation.stage_email_template?.hard_ceiling).toBeUndefined()
    expect(
      role.actions.find((a) => a.id === 'stage_email_template')?.review_cannot_be_disabled,
    ).toBeUndefined()
    // 59 §6：邮件模板 10 / 天
    expect(role.actions[0]?.mandate.caps).toMatchObject({ max_template_edits_per_day: 10 })
    // 起草要看得见一张真订单
    expect(role.scopes.find((s) => s.domain === 'order')?.ops).toEqual(['read'])
  })

  it('插件：装 / 卸 L1 硬顶、改配置 L2，两条共用一条额度（59 §6：5 / 天）', () => {
    const role = loadBundledRole('site.shopify-apps')
    expect(role.actions.map((a) => a.id)).toEqual(['stage_app_install', 'stage_app_config'])
    expect(role.automation.stage_app_install?.hard_ceiling).toBe(true)
    expect(role.automation.stage_app_install?.ceiling).toBe('L1')
    expect(role.automation.stage_app_config?.ceiling).toBe('L2')
    for (const a of role.actions)
      expect(a.mandate.caps, a.id).toMatchObject({ max_app_changes_per_day: 5 })
    expect(role.actions.find((a) => a.id === 'stage_app_install')?.route_to).toBe('owner')
  })

  it('网页模板改名之后内容一个字没动：四条动作、发布仍是 hard_ceiling', () => {
    const role = loadBundledRole('site.shopify-theme')
    expect(role.actions.map((a) => a.id)).toEqual([
      'stage_theme_preview',
      'stage_publish_theme',
      'stage_page_edit',
      'stage_dev_task',
    ])
    expect(role.automation.stage_publish_theme?.hard_ceiling).toBe(true)
    // 59 §6：主题改动 20 / 天（WP44 定的那个数一个没改）
    expect(
      role.actions.find((a) => a.id === 'stage_theme_preview')?.mandate.window?.max_count,
    ).toBe(20)
  })

  it('旧 id `site.builder` 仍然读得进来，解析到网页模板那一条', () => {
    expect(resolveRoleId('site.builder')).toBe('site.shopify-theme')
    expect(ROLE_ID_ALIASES['site.builder']).toBe('site.shopify-theme')
    const role = loadBundledRole('site.builder')
    expect(role.id).toBe('site.shopify-theme')
    expect(role.name.zh).toBe('Shopify 网页模板')
  })
})
