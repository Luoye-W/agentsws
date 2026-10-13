/**
 * WP304（决策 445）：建站先选主题——**高级主题**（我们自己的、付费）与**店里的免费主题**两条路。
 *
 * 高级主题按店铺一次性买断（$80 = 560 积分）；买了才从云端私有存储下载、推到这家店（云端那一半是私有云 WP305）。
 * 主题文件只进用户自己的工作目录与他的店，不进安装包、不进日志；开源仓里没有它的任何代码。
 *
 * 这里是工坊与云之间的约定（`CloudApi` 那张表引用这里的类型）与两张卡（选主题 / 买高级主题）的载荷。
 */

/** 高级主题一家店一次的价格（积分；按 $20 = 140 积分折算）。 */
export const PREMIUM_THEME_PRICE_CREDITS = 560
/** 同一个价格的美元说法（卡上「$80」）。 */
export const PREMIUM_THEME_PRICE_USD = 80

/**
 * 云上三条路（私有云 WP305 定稿，10-13）：令牌动作集 `store`；成功 `{ data }`、失败 `{ code, message, details }`；
 * `shop` 是 `xxx.myshopify.com`（云上大小写 / `https://` / 尾斜杠都认）。下载回的是 zip 流（文件在包根），
 * 版本与 sha256 在响应头 {@link PREMIUM_THEME_HEADERS}。
 */
export const PREMIUM_THEME_PATHS = {
  entitlement: '/v1/themes/premium/entitlement',
  purchase: '/v1/themes/premium/purchase',
  download: '/v1/themes/premium/download',
} as const

/** 下载那条路回的两个响应头。 */
export const PREMIUM_THEME_HEADERS = {
  version: 'X-Agentsws-Theme-Version',
  sha256: 'X-Agentsws-Theme-Sha256',
} as const

/** Shopify 主题商店里 Horizon 那一页（店里没有能改的免费主题时，卡上给这个链接）。 */
export const HORIZON_THEME_STORE_URL = 'https://themes.shopify.com/themes/horizon'

/** `GET /v1/themes/premium/entitlement?shop=` 的查询。 */
export interface PremiumThemeQuery {
  /** `xxx.myshopify.com` */
  shop: string
}

/**
 * `GET /v1/themes/premium/entitlement?shop=` 回的：这家店买没买、多少钱、最新版本。
 * 云上私有桶没绑 / 还没上架也是 200，`available: false`——卡上「即将开放」。
 */
export interface PremiumThemeEntitlement {
  shop?: string
  theme_id?: string
  owned: boolean
  price_credits: number
  latest_version?: string | null
  /** 云上能不能卖 / 能不能下（`false` = 即将开放）。老一点的回话没有这一格 = 能。 */
  available?: boolean
  owned_since?: string
  /** 怎么来的（买的 / 运营赠送的）。 */
  source?: string
  /** 卡上的预览图（云上给了才出；没有就是占位）。 */
  preview_image_url?: string
  /** 示例店链接（云上给了才出）。 */
  example_url?: string
}

/** `POST /v1/themes/premium/purchase` 的请求体。 */
export interface PremiumThemePurchaseRequest {
  shop: string
}

/** 买成了：新买 201（`already_owned: false`、扣 560）；同一家店再买 200（`already_owned: true`、`charged_credits: 0`）。 */
export interface PremiumThemePurchaseResult {
  owned?: true
  shop?: string
  charged_credits: number
  already_owned?: boolean
  /** 扣完之后的可用积分（云上给了才有）。 */
  balance?: number
}

/** `GET /v1/themes/premium/download?shop=&version=` 的查询（`version` 不给 = 最新）。 */
export interface PremiumThemeDownloadQuery {
  shop: string
  version?: string
}

/**
 * WP305 定稿下载回的是 **zip 流**（版本与 sha256 在响应头 {@link PREMIUM_THEME_HEADERS}），不是这个 JSON。
 * 这个形状是兜底：版本 + sha256，外加**二选一**——短时签名地址（`url`，只认 https）或整包（`content_base64`）。
 * 工坊按头几个字节认 `zip` / `tar.gz`；顶层可以多一层目录。
 */
export interface PremiumThemeDownload {
  version: string
  /** 整包的 sha256（十六进制）；下载后核对，对不上不装。 */
  sha256: string
  url?: string
  expires_at?: string
  content_base64?: string
  format?: 'tar.gz' | 'zip'
}

/** 选主题卡上高级主题那一行的状态。 */
export type PremiumThemeStatus =
  /** 没买：点了出一张「花钱」卡（560 积分），人点了才扣 */
  | 'buy'
  /** 这家店买过了：点了直接下载、推一份未发布预览 */
  | 'owned'
  /** 云上还没开（接口不在 / 没就绪）：卡上「即将开放」，不能选 */
  | 'soon'
  /** 还没登录工坊账号：不能选（登录后再出卡） */
  | 'needs_account'

/** 选主题卡（`theme_choice`）的载荷。选项 id：`premium` 或 `store:<主题 id>`。 */
export interface ThemeChoicePayload {
  form: 'theme_choice'
  shop: string
  premium: {
    status: PremiumThemeStatus
    price_credits: number
    price_usd: number
    latest_version?: string
    preview_image_url?: string
    example_url?: string
  }
  /** 店里现有的主题（最多探 6 份）：能改的进选项，太老的（不是 Online Store 2.0）只列不选。 */
  store_themes: {
    id: string
    name: string
    role: string
    theme_name?: string
    theme_version?: string
    usable: boolean
  }[]
  theme_store_url: string
  options: { id: string; label: string }[]
  /** 选完接着做哪件事（起底之后按原话再跑一次）。 */
  matter_id?: string
  brief?: string
  assignment_id?: string
  /** 起过底的工作目录要换掉（人说「换主题」时）。 */
  replace?: boolean
}

/** 买高级主题卡（`theme_purchase`，「花钱」家族）的载荷。 */
export interface ThemePurchasePayload {
  form: 'theme_purchase'
  shop: string
  price_credits: number
  price_usd: number
  matter_id?: string
  brief?: string
  assignment_id?: string
  replace?: boolean
}
