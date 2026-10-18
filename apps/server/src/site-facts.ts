/**
 * WP418（自查 A9）：上线检查单的事实**按用户真实做的授权**读。
 *
 * 以前检查单只认「高级：用自己的 Shopify 应用」那一条 OpenConnector 连接——产品默认推的两种授权
 * （连接页一键授权的云端应用、岗位页的 CLI 店铺授权）都喂不到它，于是 8 项里 7 项是「没读到」。
 * 现在多一条路：经 `shopOf(ws).auth.reader()`（云端优先、没有就 CLI，与改店工具同一个口子）跑几条
 * **写死的只读** Admin GraphQL，能读的格子填上；读不到的照旧留空（检查单照 `unknown` 记，不补一个「缺」）。
 *
 * 几条各自 try / catch：缺一项权限（如运费要 `read_shipping`）只让那一格变「没读到」，不拖垮整次巡检。
 * 支付与税没有可靠的只读口：支付只认「Shopify Payments 已开通」这一种（没开通不等于没有收款方式——可能用的是
 * PayPal，所以那时留空、不写「缺」）；税一律留空（真账号测过再补）。
 */
import { type LaunchCheckFacts, launchChecklistHeadline, shopApp } from '@agentsws/site-core'
import type { ShopifyAdminReader } from './shop-admin.js'
import { MENUS, nodes, o, s } from './shop-graphql.js'
import type { SiteFactsPort } from './site.js'

export const SITE_SHOP = `query AgentswsSiteShop {
  shop { myshopifyDomain primaryDomain { url host sslEnabled } }
}`

export const SITE_POLICIES = `query AgentswsSitePolicies {
  shop { shopPolicies { type body } }
}`

export const SITE_SHIPPING = `query AgentswsSiteShipping {
  deliveryProfiles(first: 10) {
    nodes {
      profileLocationGroups {
        locationGroupZones(first: 50) {
          nodes { zone { id name } methodDefinitions(first: 50) { nodes { id active } } }
        }
      }
    }
  }
}`

export const SITE_THEMES = `query AgentswsSiteThemes {
  themes(first: 5, roles: [MAIN]) { nodes { id name role } }
}`

export const SITE_PASSWORD = `query AgentswsSitePassword {
  onlineStore { passwordProtection { enabled } }
}`

export const SITE_PAYMENTS = `query AgentswsSitePayments {
  shopifyPaymentsAccount { activated }
}`

/** Shopify 的政策类型 → 检查单认的那四个 handle。 */
const POLICY_HANDLE: Readonly<Record<string, string>> = {
  REFUND_POLICY: 'refund',
  PRIVACY_POLICY: 'privacy',
  TERMS_OF_SERVICE: 'terms_of_service',
  SHIPPING_POLICY: 'shipping',
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** 从一个只读口子读一遍检查单要的事实（读不到的格子留空）。 */
export async function readAdminSiteFacts(reader: ShopifyAdminReader): Promise<LaunchCheckFacts> {
  const run = async (
    name: string,
    document: string,
  ): Promise<Record<string, unknown> | undefined> => {
    try {
      return o(await reader.query({ name, document }))
    } catch {
      return undefined
    }
  }
  const out: LaunchCheckFacts = {}

  const shop = await run('site_shop', SITE_SHOP)
  if (shop !== undefined && shop.shop !== undefined) {
    const sh = o(shop.shop)
    const primary = o(sh.primaryDomain)
    const url = s(primary.url)
    const my = s(sh.myshopifyDomain)
    out.domain = {
      ...(url === undefined ? {} : { primary: url }),
      custom: url !== undefined && my !== undefined && !url.includes(my),
      ...(typeof primary.sslEnabled === 'boolean' ? { ssl: primary.sslEnabled } : {}),
    }
  }

  const policies = await run('site_policies', SITE_POLICIES)
  if (policies !== undefined && Array.isArray(o(policies.shop).shopPolicies)) {
    const present = arr(o(policies.shop).shopPolicies)
      .filter((p) => (s(o(p).body) ?? '').trim() !== '')
      .map((p) => POLICY_HANDLE[s(o(p).type) ?? ''])
      .filter((h): h is string => h !== undefined)
    out.policies = { present: [...new Set(present)].sort() }
  }

  const menus = await run('menus', MENUS)
  if (menus !== undefined && menus.menus !== undefined) {
    const rows = nodes(menus.menus)
    const count = (handle: string): number =>
      arr(o(rows.find((m) => s(m.handle) === handle)).items).length
    out.navigation = { main_menu_items: count('main-menu'), footer_menu_items: count('footer') }
  }

  const shipping = await run('site_shipping', SITE_SHIPPING)
  if (shipping !== undefined && shipping.deliveryProfiles !== undefined) {
    let zones = 0
    let rates = 0
    for (const profile of nodes(shipping.deliveryProfiles))
      for (const group of arr(profile.profileLocationGroups))
        for (const zone of nodes(o(group).locationGroupZones)) {
          zones += 1
          rates += nodes(zone.methodDefinitions).filter((m) => m.active !== false).length
        }
    out.shipping = { zones, rates }
  }

  const themes = await run('site_themes', SITE_THEMES)
  if (themes !== undefined && themes.themes !== undefined) {
    const live = nodes(themes.themes).find((t) => s(t.role) === 'MAIN' || s(t.role) === 'main')
    out.theme =
      live === undefined ? {} : { published: { id: s(live.id) ?? '', name: s(live.name) ?? '' } }
  }

  const password = await run('site_password', SITE_PASSWORD)
  const enabled = o(o(password?.onlineStore).passwordProtection).enabled
  if (typeof enabled === 'boolean') out.storefront = { password_enabled: enabled }

  const payments = await run('site_payments', SITE_PAYMENTS)
  // 只认「开通了」；没开通 / 读不到都留空（可能用的是别的收款方式，不能写成「缺」）
  if (o(payments?.shopifyPaymentsAccount).activated === true)
    out.payment = { providers: ['shopify_payments'], test_mode: false }

  return out
}

/** 一格一格补：前面的读到了就用前面的，没读到才用后面的。 */
export function mergeSiteFacts(...layers: readonly LaunchCheckFacts[]): LaunchCheckFacts {
  const out: Record<string, unknown> = {}
  for (const layer of layers)
    for (const [k, v] of Object.entries(layer))
      if (out[k] === undefined && v !== undefined) out[k] = v
  return out as LaunchCheckFacts
}

/**
 * 检查单的事实口子：先问 OpenConnector 那一条（高级接法），再问店铺授权（云端 / CLI），一格一格补齐。
 * `reader` 回 `undefined` 或抛错（没授权 / 过期）= 那一层什么都不给。
 */
export function createLayeredSiteFacts(options: {
  connect?: SiteFactsPort
  reader(): Promise<ShopifyAdminReader | undefined>
  themes?(): import('@agentsws/site-core').ThemeSummaryLike[]
}): SiteFactsPort {
  let lastStore: string | undefined
  return {
    async storeFacts() {
      const first = (await options.connect?.storeFacts().catch(() => ({}))) ?? {}
      let reader: ShopifyAdminReader | undefined
      try {
        reader = await options.reader()
      } catch {
        reader = undefined
      }
      if (reader !== undefined) lastStore = reader.store
      const second = reader === undefined ? {} : await readAdminSiteFacts(reader)
      return mergeSiteFacts(first, second)
    },
    async themes() {
      return options.themes?.() ?? []
    },
    shop: () => options.connect?.shop?.() ?? lastStore,
  }
}

/** WP418（自查 A8）：工具 `site_checklist_run` 回给模型的那一份（标题照实、每项一行）。 */
export function siteChecklistToolData(run: import('@agentsws/contracts').LaunchCheckRun): {
  headline: string
  ready: boolean
  checked_at: string
  items: {
    item: string
    state: string
    severity: string
    detail: string
    fix?: string
    who_fixes: string
  }[]
} {
  const unknown = run.items.filter((i) => i.state === 'unknown')
  const unread = unknown.filter((i) => i.severity === 'blocker').length
  return {
    headline: launchChecklistHeadline({ blockers: run.blockers, unread_blockers: unread, unknown }),
    ready: run.ready,
    checked_at: run.checked_at,
    items: run.items.map((i) => ({
      item: i.title.zh,
      state: i.state === 'ok' ? '过了' : i.state === 'missing' ? '缺' : '没读到',
      severity: i.severity === 'blocker' ? '顾客买不成' : '迟早出事',
      detail: i.detail.zh,
      ...(i.state === 'ok' || i.fix.zh === '' ? {} : { fix: i.fix.zh }),
      who_fixes: i.fixable_by === undefined ? '店主自己去后台' : i.fixable_by,
    })),
  }
}

/** WP418（自查 A16）：`site_apps_list` 回给模型的那一份（装没装、连没连、目录里干什么、收不收钱）。 */
export function siteAppsToolData(rows: readonly import('@agentsws/api').SiteAppRow[]): {
  apps: {
    id: string
    name: string
    installed: boolean
    connected: boolean
    what?: string
    pricing?: string
  }[]
  note: string
} {
  return {
    apps: rows.map((r) => {
      const entry = shopApp(r.id)
      return {
        id: r.id,
        name: r.name,
        installed: r.installed,
        connected: r.connection_id !== undefined,
        ...(entry === undefined ? {} : { what: entry.what.zh, pricing: entry.pricing }),
      }
    }),
    note: '装 / 卸 App 工坊替你做不了（还没接通）：给 App Store 链接让人自己装，装好下次巡检读回。',
  }
}

/** WP418（自查 A16）：`site_email_templates` 回给模型的那一份（不带正文，正文是外部长文本）。 */
export function siteEmailsToolData(
  rows: readonly import('@agentsws/contracts').ShopEmailTemplate[],
): {
  templates: {
    type: string
    name: string
    enabled: boolean
    subject: string
    draft_pending: boolean
    missing_variables: string[]
  }[]
  note: string
} {
  return {
    templates: rows.map((t) => ({
      type: t.notification_type,
      name: t.name.zh,
      enabled: t.enabled,
      subject: t.subject,
      draft_pending: t.pending_change_id !== undefined,
      missing_variables: [...t.missing_variables],
    })),
    note: '改通知邮件工坊替你做不了（还没接通）：把改好的那一版给人，去后台「设置 → 通知」贴进去。',
  }
}
