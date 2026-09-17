/**
 * 上线检查单（59 §2）：**一家店能不能开门，逐项问一遍。**
 *
 * 为什么它是纯函数：检查单的价值在"同一份事实每次得到同一张清单"。读店铺设置、
 * 读主题列表、读已装 App 是数据面的事（`apps/server/src/site.ts`），判断"够不够
 * 上线"是这里的事。两边分开，模拟层才能拿一份写死的事实跑出确定的结果。
 *
 * 八项从 59 §1 那一行抄来：域名 / 支付 / 税 / 运费 / 政策页 / 导航 / 必装 App /
 * 主题发布。其中**支付与税这两项只读不改**——51 §1 N0 / §3 N2 明说这两样没有写
 * 动作，所以它们的 `fix` 写的是"去后台自己点"，而不是"我来提一条改动"。
 * 检查单说得出缺什么，不等于建站岗位补得了它，这两件事在卡面上要分得开。
 */
import type { RoleId } from '@agentsws/contracts'

/** 检查单上的一格（顺序即出场顺序：先能不能收钱，再好不好看）。 */
export type LaunchCheckId =
  | 'domain'
  | 'payment'
  | 'tax'
  | 'shipping'
  | 'policies'
  | 'navigation'
  | 'required_apps'
  | 'theme_published'

export const LAUNCH_CHECK_IDS: readonly LaunchCheckId[] = [
  'domain',
  'payment',
  'tax',
  'shipping',
  'policies',
  'navigation',
  'required_apps',
  'theme_published',
]

/**
 * 缺了它能不能开门。
 *
 * - `blocker`：缺了顾客根本买不成（没有支付方式、主题没发布）。
 * - `warning`：能买，但迟早出事（政策页缺一张、导航是空的）。
 */
export type LaunchSeverity = 'blocker' | 'warning'

/** Shopify 必备的四张政策页（缺哪一张，`missing_policies` 里就有哪一张）。 */
export const REQUIRED_POLICY_PAGES: readonly string[] = [
  'refund',
  'privacy',
  'terms_of_service',
  'shipping',
]

/**
 * "必装 App"的默认清单：**空的**。
 *
 * 一家店该装什么 App 取决于它卖什么（做定制的要个性化 App，做订阅的要订阅 App）。
 * 写死一份默认清单只会让每个新店一上来就看到三条它用不上的缺项——所以默认不判，
 * 由品牌自己在 `LaunchCheckOptions.required_apps` 里填。
 */
export const DEFAULT_REQUIRED_APPS: readonly string[] = []

/** 跑一次检查单要的全部事实。每一格都可缺——缺就是"这一项还没读到"，照 `unknown` 记。 */
export interface LaunchCheckFacts {
  domain?: {
    /** 顾客在地址栏里看到的那个域名。 */
    primary?: string
    /** `false` = 还挂在 `xxx.myshopify.com` 上。 */
    custom?: boolean
    ssl?: boolean
  }
  payment?: {
    /** 已启用的收款方式（`shopify_payments` / `paypal` / …）。 */
    providers?: readonly string[]
    /** `true` = 还在测试模式，顾客付的是假钱。 */
    test_mode?: boolean
  }
  tax?: {
    /** 至少配了一个征税区域。 */
    configured?: boolean
    regions?: readonly string[]
  }
  shipping?: {
    /** 配了几个发货区域。 */
    zones?: number
    /** 这些区域里一共有几条运费。区域配了但一条费率都没有 = 顾客结不了账。 */
    rates?: number
  }
  policies?: {
    /** 已经写好的政策页 handle。 */
    present?: readonly string[]
  }
  navigation?: {
    /** 主菜单里有几个条目。 */
    main_menu_items?: number
    /** 页脚菜单里有几个条目。 */
    footer_menu_items?: number
  }
  apps?: {
    /** 已装 App 的 id。 */
    installed?: readonly string[]
  }
  theme?: {
    /** 线上那一份主题（`theme list` 里 role = main 的那条）。 */
    published?: { id: string; name: string }
    /** 线上那一份还是 Shopify 送的默认主题、一个字没改过。 */
    is_default_untouched?: boolean
  }
}

export interface LaunchCheckOptions {
  /** 这家店认为"必须装"的 App id。默认空（见 {@link DEFAULT_REQUIRED_APPS}）。 */
  required_apps?: readonly string[]
  /** 检查跑在什么时候（进卡面与账本的 `after.checked_at`）。 */
  at?: string
}

export interface LaunchCheckItem {
  id: LaunchCheckId
  title: { zh: string; en: string }
  /** `true` = 这一项过了；`false` = 缺项；`unknown` = 这次没读到，不当成缺项也不当成过。 */
  state: 'ok' | 'missing' | 'unknown'
  severity: LaunchSeverity
  /** 一句话：现在是什么样。 */
  detail: { zh: string; en: string }
  /** 一句话：怎么补。**支付与税这两条写的是"去后台自己点"**（51 §3 N2）。 */
  fix: { zh: string; en: string }
  /** 谁来补。`undefined` = 建站岗位补不了（支付 / 税），只能店主自己去后台。 */
  fixable_by?: RoleId
}

export interface LaunchChecklist {
  items: readonly LaunchCheckItem[]
  /** 缺项（`state === 'missing'`），按 blocker 在前排序。 */
  missing: readonly LaunchCheckItem[]
  /** 这次没读到的那几项。 */
  unknown: readonly LaunchCheckItem[]
  blockers: number
  warnings: number
  /** 一个 blocker 都没有 = 能开门（warning 不拦）。 */
  ready: boolean
  checked_at: string
  /** 缺的政策页 handle（界面上直接列出来）。 */
  missing_policies: readonly string[]
  /** 缺的必装 App id。 */
  missing_apps: readonly string[]
}

const SEVERITY: Record<LaunchCheckId, LaunchSeverity> = {
  domain: 'warning',
  payment: 'blocker',
  tax: 'warning',
  shipping: 'blocker',
  policies: 'warning',
  navigation: 'warning',
  required_apps: 'warning',
  theme_published: 'blocker',
}

const TITLES: Record<LaunchCheckId, { zh: string; en: string }> = {
  domain: { zh: '域名', en: 'Domain' },
  payment: { zh: '收款方式', en: 'Payments' },
  tax: { zh: '税', en: 'Taxes' },
  shipping: { zh: '运费', en: 'Shipping rates' },
  policies: { zh: '政策页', en: 'Policy pages' },
  navigation: { zh: '导航', en: 'Navigation' },
  required_apps: { zh: '必装 App', en: 'Required apps' },
  theme_published: { zh: '主题发布', en: 'Published theme' },
}

/**
 * 建站岗位里谁来补这一项。
 *
 * 支付与税**没有人**——不是"还没分配"，是 51 §3 N2 明说这两样不给写动作。
 * 界面上那句"去后台自己点"就是照这一格渲染的。
 */
const FIXER: Partial<Record<LaunchCheckId, RoleId>> = {
  domain: 'site.shopify-build',
  shipping: 'site.shopify-build',
  policies: 'site.shopify-build',
  navigation: 'site.shopify-build',
  required_apps: 'site.shopify-apps',
  theme_published: 'site.shopify-theme',
}

const item = (
  id: LaunchCheckId,
  state: LaunchCheckItem['state'],
  detail: { zh: string; en: string },
  fix: { zh: string; en: string },
): LaunchCheckItem => {
  const by = FIXER[id]
  return {
    id,
    title: TITLES[id],
    state,
    severity: SEVERITY[id],
    detail,
    fix,
    ...(by !== undefined ? { fixable_by: by } : {}),
  }
}

const BACKEND_ONLY = {
  zh: '这一项建站岗位没有写动作（51 §3 N2）——请店主自己去 Shopify 后台点一下。',
  en: 'No write action exists for this (51 §3 N2) — the owner has to set it in the Shopify admin.',
}

/**
 * 跑一次上线检查单。纯函数：同一份事实进去，同一张清单出来。
 *
 * 读不到的那几项记 `unknown` 而不是 `missing`：一次因为令牌过期没读到支付设置的巡检，
 * 不该在卡面上写成"这家店没有收款方式"。两者在界面上是两种颜色。
 */
export function runLaunchChecklist(
  facts: LaunchCheckFacts,
  options: LaunchCheckOptions = {},
): LaunchChecklist {
  const items: LaunchCheckItem[] = []

  // ── 域名 ────────────────────────────────────────────────────────────
  if (facts.domain === undefined)
    items.push(
      item(
        'domain',
        'unknown',
        { zh: '没读到域名设置', en: 'Domain settings not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else if (facts.domain.custom !== true)
    items.push(
      item(
        'domain',
        'missing',
        {
          zh: `还挂在 ${facts.domain.primary ?? 'xxx.myshopify.com'} 上，没有自己的域名`,
          en: 'Still on the myshopify.com subdomain',
        },
        {
          zh: '把买好的域名接到这家店上；域名本身要店主去注册商那边改解析。',
          en: 'Point your own domain at this shop; DNS changes happen at your registrar.',
        },
      ),
    )
  else
    items.push(
      item(
        'domain',
        'ok',
        {
          zh: `${facts.domain.primary ?? '自有域名'}${facts.domain.ssl === false ? '（证书还没好）' : ''}`,
          en: facts.domain.primary ?? 'Custom domain',
        },
        { zh: '', en: '' },
      ),
    )

  // ── 收款方式（只读；51 §3 N2）─────────────────────────────────────────
  if (facts.payment === undefined)
    items.push(
      item(
        'payment',
        'unknown',
        { zh: '没读到支付设置', en: 'Payment settings not read' },
        BACKEND_ONLY,
      ),
    )
  else {
    const providers = facts.payment.providers ?? []
    const testing = facts.payment.test_mode === true
    if (providers.length === 0 || testing)
      items.push(
        item(
          'payment',
          'missing',
          testing
            ? { zh: '还开着测试模式，顾客付的是假钱', en: 'Still in test mode — no real money' }
            : { zh: '一个收款方式都没启用，顾客结不了账', en: 'No payment provider enabled' },
          BACKEND_ONLY,
        ),
      )
    else
      items.push(
        item(
          'payment',
          'ok',
          { zh: `已启用 ${providers.join('、')}`, en: `Enabled: ${providers.join(', ')}` },
          { zh: '', en: '' },
        ),
      )
  }

  // ── 税（只读；51 §3 N2）──────────────────────────────────────────────
  if (facts.tax === undefined)
    items.push(
      item('tax', 'unknown', { zh: '没读到税务设置', en: 'Tax settings not read' }, BACKEND_ONLY),
    )
  else if (facts.tax.configured !== true)
    items.push(
      item(
        'tax',
        'missing',
        { zh: '一个征税区域都没配', en: 'No tax region configured' },
        BACKEND_ONLY,
      ),
    )
  else
    items.push(
      item(
        'tax',
        'ok',
        {
          zh: `已配 ${(facts.tax.regions ?? []).length} 个区域`,
          en: `${(facts.tax.regions ?? []).length} region(s) configured`,
        },
        { zh: '', en: '' },
      ),
    )

  // ── 运费 ────────────────────────────────────────────────────────────
  if (facts.shipping === undefined)
    items.push(
      item(
        'shipping',
        'unknown',
        { zh: '没读到运费设置', en: 'Shipping not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else {
    const zones = facts.shipping.zones ?? 0
    const rates = facts.shipping.rates ?? 0
    if (zones === 0 || rates === 0)
      items.push(
        item(
          'shipping',
          'missing',
          zones === 0
            ? { zh: '一个发货区域都没有', en: 'No shipping zone' }
            : {
                zh: `${zones} 个区域里一条运费都没有，顾客结不了账`,
                en: 'Zones exist but no rates',
              },
          {
            zh: '按发往哪些国家配区域，每个区域至少一条运费（免运费也算一条）。',
            en: 'Add a zone per destination group with at least one rate (free shipping counts).',
          },
        ),
      )
    else
      items.push(
        item(
          'shipping',
          'ok',
          { zh: `${zones} 个区域 / ${rates} 条运费`, en: `${zones} zone(s), ${rates} rate(s)` },
          { zh: '', en: '' },
        ),
      )
  }

  // ── 政策页 ──────────────────────────────────────────────────────────
  const present = new Set(facts.policies?.present ?? [])
  const missingPolicies =
    facts.policies === undefined ? [] : REQUIRED_POLICY_PAGES.filter((p) => !present.has(p))
  if (facts.policies === undefined)
    items.push(
      item(
        'policies',
        'unknown',
        { zh: '没读到政策页', en: 'Policies not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else if (missingPolicies.length > 0)
    items.push(
      item(
        'policies',
        'missing',
        { zh: `缺 ${missingPolicies.join('、')}`, en: `Missing: ${missingPolicies.join(', ')}` },
        {
          zh: '把缺的那几张写出来挂上（退换货与隐私是多数支付渠道的硬要求）。',
          en: 'Write and attach the missing ones (refund and privacy are required by most payment providers).',
        },
      ),
    )
  else
    items.push(
      item('policies', 'ok', { zh: '四张都有', en: 'All four present' }, { zh: '', en: '' }),
    )

  // ── 导航 ────────────────────────────────────────────────────────────
  if (facts.navigation === undefined)
    items.push(
      item(
        'navigation',
        'unknown',
        { zh: '没读到菜单', en: 'Menus not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else {
    const main = facts.navigation.main_menu_items ?? 0
    const footer = facts.navigation.footer_menu_items ?? 0
    if (main === 0)
      items.push(
        item(
          'navigation',
          'missing',
          { zh: '主菜单是空的', en: 'Main menu is empty' },
          {
            zh: '至少放上全部商品、关于我们与联系方式；政策页挂在页脚菜单里。',
            en: 'Add at least Catalog, About and Contact; policies go in the footer menu.',
          },
        ),
      )
    else
      items.push(
        item(
          'navigation',
          'ok',
          { zh: `主菜单 ${main} 项 / 页脚 ${footer} 项`, en: `${main} main, ${footer} footer` },
          { zh: '', en: '' },
        ),
      )
  }

  // ── 必装 App ────────────────────────────────────────────────────────
  const required = options.required_apps ?? DEFAULT_REQUIRED_APPS
  const installed = new Set(facts.apps?.installed ?? [])
  const missingApps = facts.apps === undefined ? [] : required.filter((id) => !installed.has(id))
  if (required.length === 0)
    items.push(
      item(
        'required_apps',
        'ok',
        { zh: '这家店没有指定必装 App', en: 'No required apps declared' },
        { zh: '', en: '' },
      ),
    )
  else if (facts.apps === undefined)
    items.push(
      item(
        'required_apps',
        'unknown',
        { zh: '没读到已装 App', en: 'Installed apps not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else if (missingApps.length > 0)
    items.push(
      item(
        'required_apps',
        'missing',
        { zh: `缺 ${missingApps.join('、')}`, en: `Missing: ${missingApps.join(', ')}` },
        {
          zh: '装 App 永远要你点一下——建站岗位提一张卡，你看清是哪一家、收不收钱再批。',
          en: 'Installing an app always needs your approval — the role proposes a card, you decide.',
        },
      ),
    )
  else
    items.push(
      item('required_apps', 'ok', { zh: '都装上了', en: 'All installed' }, { zh: '', en: '' }),
    )

  // ── 主题发布 ────────────────────────────────────────────────────────
  if (facts.theme === undefined)
    items.push(
      item(
        'theme_published',
        'unknown',
        { zh: '没读到主题列表', en: 'Themes not read' },
        {
          zh: '先连上这家店再跑一次检查单。',
          en: 'Connect the shop, then run the checklist again.',
        },
      ),
    )
  else if (facts.theme.published === undefined)
    items.push(
      item(
        'theme_published',
        'missing',
        { zh: '线上没有主题', en: 'No published theme' },
        {
          zh: '推一份副本、看过预览再发布——发布永远要你点一下。',
          en: 'Push a copy, review the preview, then publish — publishing always needs your approval.',
        },
      ),
    )
  else if (facts.theme.is_default_untouched === true)
    items.push(
      item(
        'theme_published',
        'missing',
        {
          zh: `线上是 ${facts.theme.published.name}，还是出厂的样子`,
          en: `${facts.theme.published.name} is still untouched default`,
        },
        {
          zh: '在未发布副本上改好、看过预览再发布。',
          en: 'Work on an unpublished copy, review the preview, then publish.',
        },
      ),
    )
  else
    items.push(
      item(
        'theme_published',
        'ok',
        { zh: `线上是 ${facts.theme.published.name}`, en: `Live: ${facts.theme.published.name}` },
        { zh: '', en: '' },
      ),
    )

  const missing = items.filter((i) => i.state === 'missing')
  const order: Record<LaunchSeverity, number> = { blocker: 0, warning: 1 }
  const sorted = [...missing].sort((a, b) => order[a.severity] - order[b.severity])
  const blockers = missing.filter((i) => i.severity === 'blocker').length
  return {
    items,
    missing: sorted,
    unknown: items.filter((i) => i.state === 'unknown'),
    blockers,
    warnings: missing.length - blockers,
    ready: blockers === 0,
    checked_at: options.at ?? '',
    missing_policies: missingPolicies,
    missing_apps: missingApps,
  }
}

/**
 * 把一次巡检的结论组成 `launch_check` 变更的 `after`。
 *
 * `items` 非空是 guardrail 的硬判断（空清单 = 一项都没查，与"全过了"长得一样），
 * 所以这里原样把每一格带上，不做裁剪。
 */
export function launchCheckAfter(result: LaunchChecklist): Record<string, unknown> {
  return {
    items: result.items.map((i) => ({ id: i.id, state: i.state, severity: i.severity })),
    checked: result.items.length,
    blockers: result.blockers,
    warnings: result.warnings,
    ready: result.ready,
    checked_at: result.checked_at,
  }
}
