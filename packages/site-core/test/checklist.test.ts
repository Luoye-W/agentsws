/**
 * WP77（59 §2）：上线检查单。
 *
 * 三件事要钉住：读不到 ≠ 缺（两种颜色）；blocker 与 warning 分得开；
 * **支付与税那两项补不了**——`fixable_by` 为空是 51 §3 N2 在代码里的样子。
 */
import { describe, expect, it } from 'vitest'
import { launchCheckAfter, runLaunchChecklist } from '../src/index.js'

const full = {
  domain: { primary: 'glassbowl.com', custom: true, ssl: true },
  payment: { providers: ['shopify_payments'], test_mode: false },
  tax: { configured: true, regions: ['US', 'CN'] },
  shipping: { zones: 2, rates: 3 },
  policies: { present: ['refund', 'privacy', 'terms_of_service', 'shipping'] },
  navigation: { main_menu_items: 5, footer_menu_items: 4 },
  apps: { installed: ['judge-me'] },
  theme: { published: { id: 't1', name: 'Dawn 定制版' }, is_default_untouched: false },
}

describe('上线检查单（59 §2）', () => {
  it('八项齐了 = 能开门，一个缺项都没有', () => {
    const r = runLaunchChecklist(full, { at: '2026-09-17T02:00:00Z' })
    expect(r.items).toHaveLength(8)
    expect(r.missing).toEqual([])
    expect(r.ready).toBe(true)
    expect(r.blockers).toBe(0)
    expect(r.checked_at).toBe('2026-09-17T02:00:00Z')
  })

  it('没读到 ≠ 缺：空事实进去，八项全是 unknown，不算缺项也不算过', () => {
    const r = runLaunchChecklist({})
    expect(r.unknown.map((i) => i.id)).toEqual([
      'domain',
      'payment',
      'tax',
      'shipping',
      'policies',
      'navigation',
      'theme_published',
    ])
    // 必装 App 默认不判（没指定清单），所以它是 ok 不是 unknown
    expect(r.items.find((i) => i.id === 'required_apps')?.state).toBe('ok')
    expect(r.missing).toEqual([])
    expect(r.ready).toBe(true)
  })

  it('缺项按 blocker 在前排；能不能开门只看 blocker', () => {
    const r = runLaunchChecklist({
      ...full,
      domain: { primary: 'x.myshopify.com', custom: false },
      payment: { providers: [], test_mode: false },
    })
    expect(r.missing.map((i) => i.id)).toEqual(['payment', 'domain'])
    expect(r.blockers).toBe(1)
    expect(r.warnings).toBe(1)
    expect(r.ready).toBe(false)
  })

  it('还开着测试模式 = 缺项（顾客付的是假钱）', () => {
    const r = runLaunchChecklist({ ...full, payment: { providers: ['paypal'], test_mode: true } })
    const pay = r.items.find((i) => i.id === 'payment')
    expect(pay?.state).toBe('missing')
    expect(pay?.detail.zh).toContain('测试模式')
  })

  it('支付与税补不了——fixable_by 为空，fix 写的是"去后台自己点"（51 §3 N2）', () => {
    const r = runLaunchChecklist(full)
    for (const id of ['payment', 'tax'] as const) {
      const row = r.items.find((i) => i.id === id)
      expect(row?.fixable_by, id).toBeUndefined()
    }
    const broken = runLaunchChecklist({ ...full, tax: { configured: false } })
    expect(broken.items.find((i) => i.id === 'tax')?.fix.zh).toContain('后台')
    // 其余六项都说得出谁来补
    for (const id of ['domain', 'shipping', 'policies', 'navigation', 'theme_published'] as const)
      expect(r.items.find((i) => i.id === id)?.fixable_by, id).toBeDefined()
  })

  it('政策页缺哪几张列得出来；运费有区域没费率照样结不了账', () => {
    const r = runLaunchChecklist({
      ...full,
      policies: { present: ['refund'] },
      shipping: { zones: 3, rates: 0 },
    })
    expect(r.missing_policies).toEqual(['privacy', 'terms_of_service', 'shipping'])
    const ship = r.items.find((i) => i.id === 'shipping')
    expect(ship?.state).toBe('missing')
    expect(ship?.severity).toBe('blocker')
  })

  it('必装 App 只在这家店指定了清单时才判', () => {
    const none = runLaunchChecklist(full)
    expect(none.missing_apps).toEqual([])
    const some = runLaunchChecklist(full, { required_apps: ['judge-me', 'klaviyo'] })
    expect(some.missing_apps).toEqual(['klaviyo'])
    expect(some.items.find((i) => i.id === 'required_apps')?.state).toBe('missing')
  })

  it('线上主题还是出厂样子 = 缺项（它有主题，但那不叫"做好了"）', () => {
    const r = runLaunchChecklist({
      ...full,
      theme: { published: { id: 't0', name: 'Dawn' }, is_default_untouched: true },
    })
    const theme = r.items.find((i) => i.id === 'theme_published')
    expect(theme?.state).toBe('missing')
    expect(theme?.severity).toBe('blocker')
  })

  it('launchCheckAfter 把每一格都带上——空清单会被 guardrail 当场拦下', () => {
    const after = launchCheckAfter(runLaunchChecklist(full, { at: '2026-09-17T02:00:00Z' }))
    expect((after.items as unknown[]).length).toBe(8)
    expect(after.checked).toBe(8)
    expect(after.ready).toBe(true)
  })
})
