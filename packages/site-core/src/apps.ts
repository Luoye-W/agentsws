/**
 * 插件（59 §2）：**App 目录 + 装 / 配的动作 + 与连接目录"待增加"卡的对应。**
 *
 * 这张目录与两张既有的表都不是一回事，三者各答一个问题：
 *
 * | 表 | 它回答 |
 * |---|---|
 * | 连接目录（`@agentsws/contracts` 的 `CONNECTION_DIRECTORY`） | **我们**能不能连上这一类东西、点哪张卡 |
 * | `apps/server/src/catalog.ts` | 那张卡怎么填、凭据存哪 |
 * | 这一张 | **店里**该装哪个第三方 App、装它要花什么代价 |
 *
 * 为什么要分开：Judge.me 在店里装着（顾客看得见那个评价小组件），与我们连不连得上
 * 它的 API 是两件事——一家店可以装了 Judge.me 却没把 API key 给我们，反过来也成立。
 * 两件事混成一行的后果是界面上说不清"这个 App 装了没有"到底在问哪一个。
 *
 * {@link directoryKind} 那一格就是两张表的接缝：装上了这个 App，连接目录里那张
 * "待增加"的卡才有东西可连（59 §2 那句"与连接目录待增加卡的对应"）。
 */

/** App 分类（面板上按它分组）。 */
export type ShopAppCategory =
  | 'reviews'
  | 'email_marketing'
  | 'logistics'
  | 'seo'
  | 'support'
  | 'conversion'
  | 'subscription'

/** 收钱方式。写出来是因为"装一个 App"多数时候是一笔**按月**的钱。 */
export type ShopAppPricing = 'free' | 'freemium' | 'paid'

export interface ShopAppEntry {
  /** 目录里的 id（就是 `after.app_id`）。全表唯一。 */
  id: string
  name: { zh: string; en: string }
  category: ShopAppCategory
  pricing: ShopAppPricing
  /** 一句话：它在店里干什么。 */
  what: { zh: string; en: string }
  /**
   * 装上它之后，连接目录里哪一个 kind 才连得上（`ConnectionDirectoryEntry.kind`）。
   *
   * 没有 = 这个 App 我们不打算连它的 API，它只在店面上干活。
   */
  directory_kind?: string
  /** 一句提醒：装它之前该知道的事（多数是"它会往前台注脚本"或"按月收钱"）。 */
  caution?: { zh: string; en: string }
}

/**
 * 这一版的 App 目录。
 *
 * **故意短**：目录长度不是价值，判得准才是。每一条都要说得出它对应连接目录的
 * 哪一个 kind，或者明说"我们不连它"。想加一条，先回答"装了它之后，工作台上
 * 多出什么"——答不上来就先不加。
 */
export const SHOP_APP_CATALOG: readonly ShopAppEntry[] = [
  {
    id: 'judge-me',
    name: { zh: 'Judge.me 评价', en: 'Judge.me Reviews' },
    category: 'reviews',
    pricing: 'freemium',
    what: {
      zh: '收集与展示商品评价，带邀评邮件',
      en: 'Collect and show product reviews, with review request emails',
    },
    directory_kind: 'reviews',
    caution: {
      zh: '它会往商品页注入一个小组件——装完主题那边要留位置。',
      en: 'It injects a widget into product pages; leave room for it in the theme.',
    },
  },
  {
    id: 'loox',
    name: { zh: 'Loox 图片评价', en: 'Loox Photo Reviews' },
    category: 'reviews',
    pricing: 'paid',
    what: { zh: '带买家秀图片的评价', en: 'Photo and video reviews' },
    directory_kind: 'reviews',
    caution: { zh: '没有免费档，按月收钱。', en: 'No free tier; monthly fee.' },
  },
  {
    id: 'klaviyo',
    name: { zh: 'Klaviyo 邮件营销', en: 'Klaviyo' },
    category: 'email_marketing',
    pricing: 'freemium',
    what: {
      zh: '分群、自动流与群发（群发永远是一张要人点的卡）',
      en: 'Segments, flows and campaigns (sending always needs approval)',
    },
    directory_kind: 'email_marketing',
    caution: {
      zh: '它自己会发信——装上之后弃购提醒可能与 Shopify 的通知模板重复。',
      en: 'It sends its own mail; abandoned-checkout mail may duplicate the Shopify notification.',
    },
  },
  {
    id: 'aftership',
    name: { zh: 'AfterShip 物流追踪', en: 'AfterShip' },
    category: 'logistics',
    pricing: 'freemium',
    what: { zh: '包裹轨迹与到货提醒页', en: 'Tracking pages and delivery notifications' },
    directory_kind: 'tracking',
  },
  {
    id: 'seo-manager',
    name: { zh: 'SEO 管理', en: 'SEO Manager' },
    category: 'seo',
    pricing: 'paid',
    what: { zh: '批量改 meta、查死链、结构化数据', en: 'Bulk meta edits, broken links, schema' },
    caution: {
      zh: '我们不连它的 API——它改的东西在 Shopify 那头读得到。',
      en: 'We do not connect its API; what it writes is readable from Shopify itself.',
    },
  },
  {
    id: 'gorgias',
    name: { zh: 'Gorgias 客服台', en: 'Gorgias' },
    category: 'support',
    pricing: 'paid',
    what: { zh: '把邮件 / 社媒私信收进一个工单台', en: 'One helpdesk for mail and social DMs' },
    caution: {
      zh: '与客服岗位的收件箱是同一类活——装之前先想清楚谁是真源（45）。',
      en: 'Overlaps the customer-care inbox; decide which one is the source of truth first.',
    },
  },
]

const BY_ID = new Map(SHOP_APP_CATALOG.map((a) => [a.id, a]))

/** 查一条 App；目录里没有的回 undefined。 */
export function shopApp(id: string): ShopAppEntry | undefined {
  return BY_ID.get(id)
}

/** 一条已装 App（读回来的事实）。 */
export interface InstalledApp {
  id: string
  /** 店里显示的名字（目录里没有的 App 也得显示得出来）。 */
  name?: string
  installed_at?: string
  /** 它要了哪些权限（Shopify 的 scope 串）。 */
  scopes?: readonly string[]
}

export interface AppInventoryRow {
  id: string
  name: { zh: string; en: string }
  installed: boolean
  /** 目录里有这一条吗。`false` = 店里装了个我们不认识的 App（照样列出来）。 */
  known: boolean
  category?: ShopAppCategory
  pricing?: ShopAppPricing
  directory_kind?: string
  /** 装上了、而且连接目录里那张卡还没连上 —— 界面上那条"去连接"就是它。 */
  connectable: boolean
  caution?: { zh: string; en: string }
}

/**
 * 把"目录"与"店里真装了什么"并成面板上那一张表。
 *
 * 两头都要列全：目录里有、店里没装的是**可以装**（一张 L1 的卡）；店里装了、
 * 目录里没有的是**我们不认识的 App**——后者尤其要列出来，一个悄悄装上的 App
 * 可能正在往前台注脚本，看不见比看得见危险。
 */
export function appInventory(input: {
  installed: readonly InstalledApp[]
  /** 连接目录里已经连上的 kind（`reviews` / `email_marketing` / …）。 */
  connected_kinds?: readonly string[]
}): AppInventoryRow[] {
  const connected = new Set(input.connected_kinds ?? [])
  const installedById = new Map(input.installed.map((a) => [a.id, a]))
  const rows: AppInventoryRow[] = []
  for (const entry of SHOP_APP_CATALOG) {
    const isInstalled = installedById.has(entry.id)
    rows.push({
      id: entry.id,
      name: entry.name,
      installed: isInstalled,
      known: true,
      category: entry.category,
      pricing: entry.pricing,
      ...(entry.directory_kind !== undefined ? { directory_kind: entry.directory_kind } : {}),
      connectable:
        isInstalled && entry.directory_kind !== undefined && !connected.has(entry.directory_kind),
      ...(entry.caution !== undefined ? { caution: entry.caution } : {}),
    })
  }
  for (const app of input.installed) {
    if (BY_ID.has(app.id)) continue
    rows.push({
      id: app.id,
      name: { zh: app.name ?? app.id, en: app.name ?? app.id },
      installed: true,
      known: false,
      connectable: false,
      caution: {
        zh: '这个 App 不在我们的目录里——它要了什么权限、往前台注了什么，得你自己去后台看一眼。',
        en: 'Not in our catalog — check its scopes and storefront scripts in the admin yourself.',
      },
    })
  }
  return rows
}

/**
 * 装上了、但连接目录那张"待增加"的卡还没连 —— 面板上那条"去连接"读它。
 *
 * 59 §2 那句"与连接目录待增加卡的对应"落在这一个函数上：装 App 与连 API 是两步，
 * 第一步做完了不提醒第二步，用户会以为装完就有数据。
 */
export function pendingConnections(rows: readonly AppInventoryRow[]): AppInventoryRow[] {
  return rows.filter((r) => r.connectable)
}

/**
 * 组一条 `app_install` 变更的 `after`。
 *
 * `operation` 必填且只有两个值：guardrail 判的就是它——一张说不清是装还是卸的卡，
 * 人点不下去。
 */
export function appInstallAfter(input: {
  app_id: string
  operation: 'install' | 'uninstall'
  reason?: string
}): Record<string, unknown> {
  const entry = BY_ID.get(input.app_id)
  return {
    app_id: input.app_id,
    operation: input.operation,
    ...(entry !== undefined
      ? { app_name: entry.name.zh, pricing: entry.pricing, category: entry.category }
      : {}),
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  }
}

/** 组一条 `app_config` 变更的 `after`（settings 原样带上，卡面上逐项显示差异）。 */
export function appConfigAfter(input: {
  app_id: string
  settings: Record<string, unknown>
}): Record<string, unknown> {
  return { app_id: input.app_id, ...input.settings }
}
