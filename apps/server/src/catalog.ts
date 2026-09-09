/**
 * 连接目录：v1 能连的六个服务，以及给**非技术用户**的"要准备什么"。
 *
 * 选型依据 31 §3 / 07 P1：v1 只做**不需要平台审核**的路径——
 * Shopify 自建应用的 Admin API token、邮箱的应用专用密码（IMAP / SMTP）。
 * Gmail 的受限 scope 要 Google 的 CASA 年度安全评估，GA4 / Search Console 要用户自己的
 * OAuth 应用；这三个都摆出来，但文案里说清楚代价，并把"任意邮箱"推荐在 Gmail 前面。
 *
 * 每条 `steps` ≤ 5 步、全是白话、带外链——用户照着做完就能把值粘进原生表单。
 */
import type { ProviderAuthOption, ProviderFieldSpec, ProviderSetupGuide } from '@agentsws/api'

export type CatalogAuth = 'oauth2' | 'api_key' | 'custom_credential'

/**
 * 同一个服务的一种接法（WP25）。
 *
 * `flow` 决定提交后走哪条装配路径：
 * - `form`：字段原样转给 `store` 指的那个凭据库（老行为）；
 * - `shopify_client_credentials`：字段是**应用凭据**，先经 `shopify-broker.ts`
 *   换成 Admin API 令牌，再把令牌 PUT 进 OpenConnector。
 */
export interface CatalogAuthOption extends ProviderAuthOption {
  flow: 'form' | 'shopify_client_credentials'
}

export interface CatalogEntry {
  /** 我们对外的 provider id。 */
  service: string
  /** OpenConnector 上游的 service 名；`local` = 上游根本没有这个 provider（08 §3 的缺口）。 */
  upstream: string | 'local'
  label: string
  auth: CatalogAuth
  /** 凭据存哪：上游凭据库，还是本机加密秘密库。 */
  store: 'openconnector' | 'local_vault'
  /** 喂哪些工作台数据源（deck 的 DataSourceId）。 */
  data_sources: string[]
  /** 默认（推荐）那条接法的字段。有 `auth_options` 时等于第一条的 `fields`。 */
  fields: ProviderFieldSpec[]
  setup_guide: ProviderSetupGuide
  data_note?: string
  /** 试连时优先挑名字里带这些词的只读 Action。 */
  smoke_hints?: string[]
  /** 两种以上接法时列出来，第一条是推荐的那条。 */
  auth_options?: CatalogAuthOption[]
}

/** 用户选的那条接法；`id` 不认识就回推荐的那条（不报错，界面可能是旧的）。 */
export function authOptionOf(entry: CatalogEntry, id?: string): CatalogAuthOption | undefined {
  const options = entry.auth_options
  if (options === undefined || options.length === 0) return undefined
  if (id === undefined) return options[0]
  return options.find((o) => o.id === id) ?? options[0]
}

/** 08 §3 覆盖对照：上游 service 名 → 我们的 provider id。 */
export const UPSTREAM_TO_SERVICE: Readonly<Record<string, string>> = {
  shopify_admin: 'shopify_admin',
  gmail: 'gmail',
  google_analytics: 'ga4',
  google_search_console: 'gsc',
  meta: 'meta_ads',
}

/**
 * Dev Dashboard 应用那条路要填的三样东西。
 *
 * 这三个名字是**我们自己的**（值进本机秘密库，不进 OpenConnector）：换到令牌之后
 * 才用上游认的 `apiKey` / `shopDomain` 把令牌 PUT 过去。
 */
const SHOPIFY_DEV_APP_FIELDS: ProviderFieldSpec[] = [
  {
    name: 'shop_domain',
    label: '店铺域名',
    secret: false,
    required: true,
    kind: 'text',
    placeholder: 'your-store.myshopify.com',
    hint: '后台地址栏那一整串也行（admin.shopify.com/store/… 我们自己认得出来）',
  },
  {
    name: 'client_id',
    label: '客户端 ID',
    secret: false,
    required: true,
    kind: 'text',
    hint: 'Dev Dashboard 里那个应用的 Settings 页上，Client ID 那一行',
  },
  {
    name: 'client_secret',
    label: '客户端密钥',
    secret: true,
    required: true,
    kind: 'password',
    hint: '同一页上的 Client secret。只存在这台电脑的加密库里，不上传、不进日志',
  },
]

const SHOPIFY_DEV_APP_GUIDE: ProviderSetupGuide = {
  summary:
    '在 Shopify 的 Dev Dashboard 里建一个应用、装到你的店上，把 Client ID 和密钥填过来。' +
    '访问令牌 24 小时过期，我们自己续，你不用管。',
  steps: [
    '打开 Shopify Dev Dashboard（partners 后台里的 Apps），点 Create app，分发方式选"自定义"',
    // 括号里给上原文：Dev Dashboard 的界面上只显示英文 scope 名，
    // 用户要照着一个个勾，不给原文等于让他自己猜哪一行对应"订单读写"
    '在应用的版本配置里勾上权限：订单读写（read_orders / write_orders）、退货读写' +
      '（read_returns / write_returns）、客户读取（read_customers）、商品读取（read_products）',
    '点 Install app，选中你要接的那家店（必须是同一个组织下的店）',
    '回应用的 Settings 页，抄下 Client ID 与 Client secret',
    '把店铺域名和这两个值填进下面的表单——密钥只存在这台电脑上',
  ],
  links: [
    {
      label: 'Shopify 客户端凭据换令牌',
      url: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials',
    },
    { label: 'Shopify Dev Dashboard', url: 'https://dev.shopify.com/dashboard' },
  ],
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    service: 'shopify_admin',
    upstream: 'shopify_admin',
    label: 'Shopify 店铺',
    auth: 'api_key',
    store: 'openconnector',
    data_sources: ['shop'],
    // 09-09 实测：上游目录里 `shopify_admin.get_shop` 是只读、零必填参数，正好当试连
    smoke_hints: ['get_shop', 'shop', 'list_locations'],
    fields: SHOPIFY_DEV_APP_FIELDS,
    setup_guide: SHOPIFY_DEV_APP_GUIDE,
    auth_options: [
      {
        id: 'dev_app',
        label: 'Dev Dashboard 应用（客户端 ID + 密钥）',
        summary: '2025 年之后 Shopify 推荐的做法。填一次 ID 和密钥，令牌到期我们自己换，不用你管。',
        recommended: true,
        auth: 'api_key',
        flow: 'shopify_client_credentials',
        fields: SHOPIFY_DEV_APP_FIELDS,
        setup_guide: SHOPIFY_DEV_APP_GUIDE,
      },
      {
        id: 'access_token',
        label: '自定义应用访问令牌（shpat_…）',
        summary: '老办法。店铺后台里建的"自定义应用"直接给一串令牌，粘过来就行，不会过期。',
        auth: 'api_key',
        flow: 'form',
        // 09-09 实测：上游的字段 id 是 `apiKey` / `shopDomain`，写别的名字会被 400 顶回来
        fields: [
          {
            name: 'shopDomain',
            label: '店铺域名',
            secret: false,
            required: true,
            kind: 'text',
            placeholder: 'your-store.myshopify.com',
            hint: '就是后台地址里 admin.shopify.com/store/ 后面那一段，写全 .myshopify.com',
          },
          {
            name: 'apiKey',
            label: 'Admin API 访问令牌',
            secret: true,
            required: true,
            kind: 'password',
            placeholder: 'shpat_…',
            hint: '只显示一次，关掉页面就看不到了；没抄下来就重新装一次应用',
          },
        ],
        setup_guide: {
          summary:
            '在自己的 Shopify 后台建一个"自定义应用"，把它的访问令牌粘过来。不用申请、不用审核。',
          steps: [
            '打开 Shopify 后台 → 设置 → 应用和销售渠道 → 开发应用',
            '点"创建应用"，名字随便写（比如 agentsws）',
            '在"配置 Admin API 权限"里勾上：订单读写、退货读写、客户读取、商品读取',
            '保存后点"安装应用"，页面上会出现一串 shpat_ 开头的访问令牌',
            '把店铺域名和这串令牌填进下面的表单——令牌只显示一次，先复制',
          ],
          links: [
            {
              label: 'Shopify 自定义应用官方说明',
              url: 'https://help.shopify.com/manual/apps/app-types/custom-apps',
            },
          ],
        },
      },
    ],
  },
  {
    service: 'imap_smtp',
    upstream: 'local',
    label: '任意邮箱（IMAP / SMTP）',
    auth: 'custom_credential',
    store: 'local_vault',
    data_sources: [],
    fields: [
      {
        name: 'email',
        label: '邮箱地址',
        secret: false,
        required: true,
        kind: 'email',
        placeholder: 'support@yourbrand.com',
        hint: '填完点一下别处，我们会自动认出是哪家邮箱、把下面的服务器地址填好',
      },
      {
        name: 'password',
        label: '密码 / 授权码',
        secret: true,
        required: true,
        kind: 'password',
        hint: '国内邮箱（QQ、163、腾讯企业邮）都要用"授权码"，不是你平时登录的那个密码',
      },
      {
        name: 'smtp_password',
        label: '发信专用密码',
        secret: true,
        required: false,
        kind: 'password',
        hint: '留空就用上面那一个。只有极少数邮箱收发两套密码，才要单独填',
      },
      {
        name: 'username',
        label: '登录用户名',
        secret: false,
        required: false,
        kind: 'text',
        hint: '留空即可——多数邮箱的用户名就是邮箱地址本身',
      },
      {
        name: 'imap_host',
        label: '收信服务器（IMAP）',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: 'imap.qq.com',
      },
      {
        name: 'imap_port',
        label: '收信端口',
        secret: false,
        required: false,
        kind: 'number',
        default: '993',
      },
      {
        name: 'smtp_host',
        label: '发信服务器（SMTP）',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: 'smtp.qq.com',
      },
      {
        name: 'smtp_port',
        label: '发信端口',
        secret: false,
        required: false,
        kind: 'number',
        default: '465',
      },
    ],
    setup_guide: {
      summary:
        '最省事的一条路：不用向任何平台申请。填上邮箱地址，我们自动认出是哪家、把服务器地址填好；' +
        '你只要去邮箱里开一个"授权码"。',
      steps: [
        '登录你的邮箱网页版，找到"设置 → 账号"或"账号安全"',
        '打开 IMAP / SMTP 服务（很多邮箱默认是关着的）',
        '生成一个"授权码"（也叫应用专用密码、客户端专用密码）',
        '把邮箱地址和这串授权码填进下面的表单——服务器地址会自动带出来',
        '点"保存并测试"：收信登录和发信握手都通过才算连上',
      ],
      links: [
        { label: 'QQ 邮箱授权码', url: 'https://service.mail.qq.com/detail/0/75' },
        {
          label: '163 邮箱授权码',
          url: 'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b',
        },
        { label: 'Gmail 应用专用密码', url: 'https://support.google.com/accounts/answer/185833' },
      ],
    },
  },
  {
    service: 'gmail',
    upstream: 'gmail',
    label: 'Gmail（Google 授权）',
    auth: 'oauth2',
    store: 'openconnector',
    fields: [],
    data_sources: [],
    smoke_hints: ['profile', 'me', 'labels'],
    data_note:
      'Gmail 的读写属于 Google 的"受限权限"，经第三方服务器访问要做一年一次的 CASA 安全评估。' +
      'v1 走你自己的 OAuth 应用；只想收发客服信的话，上面的"任意邮箱"更省事。',
    setup_guide: {
      summary: '要你自己在 Google Cloud 建一个 OAuth 应用。只想收发邮件的话，先看"任意邮箱"。',
      steps: [
        '打开 Google Cloud Console，新建一个项目',
        '在"API 和服务"里启用 Gmail API',
        '配置 OAuth 同意屏幕，用户类型选"内部"（组织内部使用可以免掉第三方安全评估）',
        '建一个"OAuth 客户端 ID"，类型选"Web 应用"，回调地址填本机 OpenConnector 的地址',
        '把客户端 ID 与密钥配进 OpenConnector，然后回来点"去授权"',
      ],
      links: [
        { label: 'Google OAuth 客户端', url: 'https://console.cloud.google.com/apis/credentials' },
        {
          label: 'Google 受限权限与 CASA 评估',
          url: 'https://support.google.com/cloud/answer/9110914',
        },
      ],
    },
  },
  {
    service: 'ga4',
    upstream: 'google_analytics',
    label: 'Google Analytics 4',
    auth: 'oauth2',
    store: 'openconnector',
    fields: [],
    data_sources: ['ga4'],
    smoke_hints: ['account', 'propert', 'list'],
    data_note: '连上之后岗位面板里的 GA4 那一块会亮起来；具体的活跃用户 / 事件数据下一版接。',
    setup_guide: {
      summary: '用你自己的 Google OAuth 应用授权一次。GA4 的分析数据不属于受限权限，不用安全评估。',
      steps: [
        '在 Google Cloud Console 里启用 Google Analytics Data API',
        '建一个 OAuth 客户端 ID（可以和 Gmail 共用一个项目）',
        '把客户端 ID 与密钥配进 OpenConnector',
        '回来点"去授权"，在 Google 页面上选你要接的那个 GA4 媒体资源',
      ],
      links: [
        {
          label: 'GA4 Data API',
          url: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
        },
      ],
    },
  },
  {
    service: 'gsc',
    upstream: 'google_search_console',
    label: 'Google Search Console',
    auth: 'oauth2',
    store: 'openconnector',
    fields: [],
    data_sources: ['gsc'],
    smoke_hints: ['site', 'list'],
    data_note: '连上之后岗位面板里的 Search Console 那一块会亮起来；查询词与落地页数据下一版接。',
    setup_guide: {
      summary: '和 GA4 同一个 Google 项目，多启用一个 API 就行。',
      steps: [
        '在 Google Cloud Console 里启用 Search Console API',
        '沿用 GA4 那个 OAuth 客户端 ID',
        '把客户端 ID 与密钥配进 OpenConnector',
        '回来点"去授权"，选你已经验证过所有权的那个站点',
      ],
      links: [
        { label: 'Search Console API', url: 'https://developers.google.com/webmaster-tools' },
      ],
    },
  },
  {
    service: 'meta_ads',
    upstream: 'meta',
    label: 'Meta 广告（Facebook / Instagram）',
    auth: 'oauth2',
    store: 'openconnector',
    fields: [],
    data_sources: ['ads'],
    smoke_hints: ['me', 'account', 'adaccount'],
    data_note: '连上之后岗位面板里的广告后台那一块会亮起来；花费 / ROAS 数据下一版接。',
    setup_guide: {
      summary: '要你自己在 Meta 开发者后台建一个应用。审核周期比前面几个长，不急的话可以最后接。',
      steps: [
        '打开 Meta for Developers，建一个"商务"类型的应用',
        '给它加上"营销 API"产品',
        '在应用设置里拿到应用编号与密钥',
        '把这两个值配进 OpenConnector',
        '回来点"去授权"，选你要接的广告账户',
      ],
      links: [{ label: 'Meta for Developers', url: 'https://developers.facebook.com/apps' }],
    },
  },
]

export function catalogEntry(service: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.service === service)
}

/** 上游 service → 我们的 provider id（不认识的原样返回）。 */
export function serviceOfUpstream(upstream: string): string {
  return UPSTREAM_TO_SERVICE[upstream] ?? upstream
}
