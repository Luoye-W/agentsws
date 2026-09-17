/**
 * 连接目录（54（将改号 55）§4 第一层；18 §1 之外的那张"总表"）。
 *
 * 三层里的**第一层**：所有能接的东西的登记表。另外两层是
 * 「岗位连接清单」（岗位页那张"连上这 N 个就能开工"的卡，只列这个岗位要的）
 * 与「职责 preset」（官方 `agent-presets` 承载，本期不做）。
 *
 * 为什么这张表住在契约里而不是服务进程里：
 *
 * - 职责模板（05 §1.2 `ConnectorDependency`）写的是 `kind`（`email` / `shop` / `youtube_data`），
 *   岗位清单、向导清单、连接页、面板的"去连接"四处都要把同一个 kind 翻成同一句人话。
 *   翻译表只能有一份，否则四处各写各的，改一个名字要改四处。
 * - `apps/server/src/catalog.ts` 那张表是**按 provider（service）**列的——它回答的是
 *   "这张卡怎么填、字段是什么、凭据存哪"，是连接页那一侧的事实。这张表是**按 kind** 列的，
 *   回答的是"职责问的这个 kind 是什么东西、现在有没有、点哪张卡"。两张表按
 *   {@link ConnectionDirectoryEntry.service} 对上，谁也不抄谁。
 *
 * **这张表里永远没有凭据、也没有任何一条真实连接。** `fields` 只有字段**描述**
 * （名字、要不要、是不是密码），值只走 13 §4.3 的原生表单那一条路。
 * 运行时状态（已连 / 未连 / 出错）由服务进程在返回前贴上来，不写死在这里。
 *
 * 36 §2：条目里不出现任何原始店铺 id / 账号 id——目录说的是"哪一类东西"，
 * 具体连了哪家店是 `Connection.identity` 的事。
 */

/** 目录分类（连接页"添加连接"按它分组；顺序即出场顺序）。 */
export type ConnectionCategory =
  | 'storefront'
  | 'mailbox'
  | 'marketplace'
  | 'analytics'
  | 'ads'
  | 'social'
  | 'marketing'
  /** WP78（60 §5）：公共关系——品牌监控的 RSS 与新闻稿分发。 */
  | 'pr'
  | 'logistics'
  | 'payment'
  | 'reviews'
  | 'im'
  | 'dev'
  /** WP76（58 §1）：设计工具（Figma / Canva）。两条现在都是「待增加」。 */
  | 'design'
  | 'custom'

/**
 * 鉴权方式。
 *
 * - `oauth`：去平台的授权页点同意（Google / Meta / Amazon SP-API）。
 * - `api_key`：后台生成一串密钥，粘进原生表单。
 * - `client_credentials`：客户端 id + 密钥换令牌（Shopify Dev Dashboard、企业微信）。
 * - `qr`：扫码（微信 ClawBot）。
 * - `password`：账号 + 密码 / 授权码（IMAP / SMTP）。
 * - `none`：不用鉴权（本机 stdio MCP 服务器、内建聊天窗）。
 */
export type ConnectionAuth = 'oauth' | 'api_key' | 'client_credentials' | 'qr' | 'password' | 'none'

/**
 * 接法（54（将改号 55）§4 那一列"模式"）。
 *
 * - `openconnector_provider`：走 OpenConnector 的 provider（08）。
 * - `mcp_server`：一台 MCP 服务器（官方 / 自定义）。
 * - `channel_adapter`：对话渠道适配器（18 §2 入站管线；dsh 没有这一层，我们自己做）。
 * - `browser`：靠官方 `dsh-browser-use` 在浏览器里干（54（将改号 55）§3）。
 * - `builtin`：这个进程自己就是那一头（内建聊天窗）。
 */
export type ConnectionMode =
  | 'openconnector_provider'
  | 'mcp_server'
  | 'channel_adapter'
  | 'browser'
  | 'builtin'

/**
 * 读写分类（54（将改号 55）§3 那一栏、`gate.ts` 的 `classifySideEffect` 同一套词）。
 *
 * 取这条连接**能做到的最重的那一件事**：能发信 / 能改单 = `write_external`，
 * 只读 = `read_external`，根本不出这台机器 = `local`。拿不准一律按写
 * （与浏览器工具的未知名兜底同一条纪律）。
 */
export type ConnectionSideEffect = 'read_external' | 'write_external' | 'local'

/**
 * 这一条现在有没有。
 *
 * - `available`：点得动，能连上。
 * - `planned`：登记在册、还没做。**明着列出来**而不是藏起来——用户在目录里找不到
 *   「评价应用」时只会以为是自己没找到（与 `apps/server/src/catalog.ts` 的
 *   `planned` 同一条理由）。
 */
export type ConnectionAvailability = 'available' | 'planned'

/** 原生表单的一个字段**描述**。值永远不经这里（13 §4.3）。 */
export interface ConnectionFieldSpec {
  name: string
  label: { zh: string; en: string }
  /** `true` = 界面上一律 `type=password` + `autocomplete=off`，且只进加密库。 */
  secret: boolean
  required: boolean
  kind?: 'text' | 'password' | 'email' | 'number' | 'url' | 'select' | 'headers'
  placeholder?: string
  /** `kind: 'select'` 的可选值。 */
  options?: readonly string[]
  hint?: { zh: string; en: string }
}

/** 连接目录的一条。 */
export interface ConnectionDirectoryEntry {
  /** 职责模板 `connectors[].kind` 用的那个名字（05 §1.2）。全表唯一。 */
  kind: string
  name: { zh: string; en: string }
  category: ConnectionCategory
  auth: ConnectionAuth
  mode: ConnectionMode
  fields: readonly ConnectionFieldSpec[]
  side_effect: ConnectionSideEffect
  /** 外链（平台文档）或站内路由（`/im-channels`）。 */
  docs_url?: string
  status: ConnectionAvailability
  /**
   * 连接页上对应那张卡的 provider id（`apps/server/src/catalog.ts` 的 `service`）。
   * 没有 = 目录里有它、连接页上还没有卡（`status: 'planned'` 的多数是这种）。
   */
  service?: string
  /**
   * 同一件事的**别名 kind**：职责模板里历史上写过的另一个名字。
   *
   * 只加不删。`amazon`（`amz/support.yml` 写的）与 `amazon_sp`（SP-API 的正名）、
   * `gsc`（连接目录里 provider 的名字）与 `search_console`（职责模板写的）都是这么对上的。
   */
  aliases?: readonly string[]
  /**
   * `true` = 这个 kind 不直接对应一张卡，要**按公司档案解析**（51 §1 N0）。
   * 只有平台中立的 `shop`：Shopify 的工作区解析成 Shopify 店铺，WooCommerce 的解析成 WooCommerce。
   */
  resolved_by_profile?: boolean
  /** 一句人话：这是什么 / 为什么还没做。界面上的灰字。 */
  note?: { zh: string; en: string }
}

// ── 几组复用的字段描述 ────────────────────────────────────────────────

const OAUTH_NO_FIELDS: readonly ConnectionFieldSpec[] = []

/** 只要一串 API key 的那一类。 */
const apiKeyField = (hintZh: string, hintEn: string): readonly ConnectionFieldSpec[] => [
  {
    name: 'api_key',
    label: { zh: 'API 密钥', en: 'API key' },
    secret: true,
    required: true,
    kind: 'password',
    hint: { zh: hintZh, en: hintEn },
  },
]

/**
 * 自定义 MCP 服务器的字段（54（将改号 55）§4「自定义 MCP 服务器也是一个条目」）。
 *
 * 本期只做**保存、校验与探测**：连一次、把它报的 tools 列表存下来。
 * **不接进运行时**——把 MCP 服务器挂到 Agent 上是官方 `mcp-client` 按 preset 的事
 * （54（将改号 55）§2 / §4 第三层），那要等官方 Agent 层引进来。
 */
const MCP_FIELDS: readonly ConnectionFieldSpec[] = [
  {
    name: 'name',
    label: { zh: '名字', en: 'Name' },
    secret: false,
    required: true,
    kind: 'text',
    placeholder: 'my-tools',
    hint: {
      zh: '你自己起的名字，全局唯一；只能用小写字母、数字、短横线',
      en: 'Your own name for it; globally unique; lower-case letters, digits and dashes only',
    },
  },
  {
    name: 'transport',
    label: { zh: '连法', en: 'Transport' },
    secret: false,
    required: true,
    kind: 'select',
    options: ['stdio', 'streamable-http'],
    hint: {
      zh: '本机跑一个命令就选 stdio；连一台远端服务器就选 streamable-http',
      en: 'Pick stdio to run a local command, streamable-http to reach a remote server',
    },
  },
  {
    name: 'command',
    label: { zh: '命令', en: 'Command' },
    secret: false,
    required: false,
    kind: 'text',
    placeholder: 'npx',
    hint: { zh: 'stdio 才要：要跑的那个可执行文件', en: 'stdio only: the executable to run' },
  },
  {
    name: 'args',
    label: { zh: '参数', en: 'Arguments' },
    secret: false,
    required: false,
    kind: 'text',
    placeholder: '-y @scope/some-mcp-server',
    hint: { zh: '空格分隔；stdio 才要', en: 'Space separated; stdio only' },
  },
  {
    name: 'url',
    label: { zh: '地址', en: 'URL' },
    secret: false,
    required: false,
    kind: 'url',
    placeholder: 'https://example.com/mcp',
    hint: {
      zh: 'streamable-http 才要；必须是 https（本机 127.0.0.1 除外）',
      en: 'streamable-http only; must be https (except 127.0.0.1)',
    },
  },
  {
    name: 'headers',
    label: { zh: '请求头', en: 'Headers' },
    secret: true,
    required: false,
    kind: 'headers',
    hint: {
      zh: '一行一个 `名字: 值`。值当凭据看：只进本机加密库，不进日志、不进模型',
      en: 'One `Name: value` per line. Treated as credentials: encrypted vault only, never logged or shown to the model',
    },
  },
]

// ── 登记表 ────────────────────────────────────────────────────────────

/**
 * **连接目录**。一条 = 职责模板问得出来的一个 `kind`。
 *
 * 覆盖三样，一样不能少（否则岗位清单上会出现一条查不到名字的行）：
 * ① 所有职责模板 `connectors[].kind`（`packages/roles/roles/**.yml` 与 `packs/`、`role-packs/`）；
 * ② 红人五条渠道的 `connector_kind`（`kol.ts` 的 `KOL_CHANNELS`）；
 * ③ 已经有 OpenConnector provider 的那几家（邮箱 / Shopify / WooCommerce / GA4 / Search Console / Meta）。
 *
 * 顺序 = 连接页"添加连接"里的出场顺序（先分类、类内按重要性）。
 */
export const CONNECTION_DIRECTORY: readonly ConnectionDirectoryEntry[] = [
  // ── 店铺后台 ────────────────────────────────────────────────────────
  {
    kind: 'shop',
    name: { zh: '店铺后台', en: 'Storefront' },
    category: 'storefront',
    auth: 'none',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    status: 'available',
    resolved_by_profile: true,
    note: {
      zh: '平台中立的那一条：职责写 `shop`，具体连哪一家看公司档案里的「网站是用什么搭的」。',
      en: 'Platform-neutral: roles ask for `shop`; which platform it resolves to comes from the workspace profile.',
    },
  },
  {
    kind: 'shopify',
    name: { zh: 'Shopify 店铺', en: 'Shopify' },
    category: 'storefront',
    auth: 'client_credentials',
    mode: 'openconnector_provider',
    service: 'shopify_admin',
    aliases: ['shopify_admin'],
    fields: [
      {
        name: 'shop_domain',
        label: { zh: '店铺域名', en: 'Shop domain' },
        secret: false,
        required: true,
        kind: 'text',
        placeholder: 'your-store.myshopify.com',
      },
      {
        name: 'client_id',
        label: { zh: '客户端 ID', en: 'Client ID' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'client_secret',
        label: { zh: '客户端密钥', en: 'Client secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials',
    status: 'available',
  },
  {
    kind: 'woocommerce',
    name: { zh: 'WooCommerce 店铺', en: 'WooCommerce' },
    category: 'storefront',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'woocommerce',
    fields: [
      {
        name: 'site_url',
        label: { zh: '网站地址', en: 'Site URL' },
        secret: false,
        required: true,
        kind: 'url',
      },
      {
        name: 'consumer_key',
        label: { zh: 'Consumer key', en: 'Consumer key' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'consumer_secret',
        label: { zh: 'Consumer secret', en: 'Consumer secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://woocommerce.github.io/woocommerce-rest-api-docs/',
    status: 'planned',
    note: {
      zh: 'OpenConnector 容器里已经有这个 provider，缺的是动作对照表（51 §1「下一个平台」）。',
      en: 'The OpenConnector provider exists; the action mapping is what is still missing.',
    },
  },
  // ── 邮箱 ────────────────────────────────────────────────────────────
  {
    kind: 'email',
    name: { zh: '邮箱', en: 'Mailbox' },
    category: 'mailbox',
    auth: 'password',
    mode: 'openconnector_provider',
    service: 'imap_smtp',
    fields: [
      {
        name: 'email',
        label: { zh: '邮箱地址', en: 'Email address' },
        secret: false,
        required: true,
        kind: 'email',
      },
      {
        name: 'password',
        label: { zh: '密码 / 授权码', en: 'Password / app password' },
        secret: true,
        required: true,
        kind: 'password',
        hint: {
          zh: '国内邮箱一律用「授权码」，不是平时登录那个密码',
          en: 'Most mail providers want an app password, not your login password',
        },
      },
    ],
    side_effect: 'write_external',
    status: 'available',
    note: {
      zh: '任意 IMAP / SMTP 邮箱；Gmail 走 Google 授权那张卡也算这一条。',
      en: 'Any IMAP / SMTP mailbox; the Gmail OAuth card satisfies this one too.',
    },
  },
  // ── 平台电商 ────────────────────────────────────────────────────────
  {
    kind: 'amazon_sp',
    name: { zh: '亚马逊 SP-API', en: 'Amazon SP-API' },
    category: 'marketplace',
    aliases: ['amazon'],
    auth: 'oauth',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    docs_url: 'https://developer-docs.amazon.com/sp-api/',
    status: 'planned',
    note: {
      zh: '还没接：亚马逊客服现在靠买家消息寄生在客服邮箱上（Amazon relay 地址），退款额度等 SP-API 接上再给。',
      en: 'Not wired yet: Amazon buyer messages arrive through the support mailbox relay for now.',
    },
  },
  // ── 数据分析 ────────────────────────────────────────────────────────
  {
    kind: 'ga4',
    name: { zh: 'Google Analytics 4', en: 'Google Analytics 4' },
    category: 'analytics',
    auth: 'oauth',
    mode: 'openconnector_provider',
    service: 'ga4',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'read_external',
    docs_url: 'https://developers.google.com/analytics/devguides/reporting/data/v1',
    status: 'available',
  },
  {
    kind: 'search_console',
    name: { zh: 'Google Search Console', en: 'Google Search Console' },
    category: 'analytics',
    auth: 'oauth',
    mode: 'openconnector_provider',
    service: 'gsc',
    // 职责模板写 `search_console`，连接目录里 provider 叫 `gsc`——两个名字都要认得
    aliases: ['gsc'],
    fields: OAUTH_NO_FIELDS,
    side_effect: 'read_external',
    docs_url: 'https://developers.google.com/webmaster-tools',
    status: 'available',
  },
  // ── 广告 ────────────────────────────────────────────────────────────
  {
    kind: 'meta',
    name: { zh: 'Meta 广告', en: 'Meta Ads' },
    category: 'ads',
    auth: 'oauth',
    mode: 'openconnector_provider',
    service: 'meta_ads',
    aliases: ['meta_ads'],
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    docs_url: 'https://developers.facebook.com/apps',
    status: 'available',
  },
  /*
   * WP75（57 §1）：**投放岗位那四张卡**。
   *
   * 与上面那条 `meta`（旧的"Meta 广告"只读数据源）的关系：那一条喂的是首页
   * `ads` 那个数据源；这四条是**四条平台职责各自的连接**，要的是能动预算的权限。
   *
   * 与社媒那张 `meta_graph` 的关系（57 §1）：**分两张卡，可复用同一次授权**。
   * 现实里同一次 OAuth 能把两边的权限一起授下来，但卡分开——这条要
   * `ads_management`，那条要 `pages_manage_posts`。做成一张的后果是
   * "想发个帖子"要先授权"能动广告预算"（04 §5 那条分离理由）。
   *
   * Meta / Google **可连**（`@agentsws/ads-core` 里有真调用），X / TikTok
   * 照 WP64 骨架卡的老规矩标着"还没接"、点不动——每一条的 `note` 写的是
   * **接口现实**（申请制 / developer token / Business Center 授权），
   * 说在前面，比让人填完之后撞一堵墙强。
   */
  {
    kind: 'meta_marketing',
    name: { zh: 'Meta Marketing API（投放）', en: 'Meta Marketing API (Ads)' },
    category: 'ads',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'meta_marketing',
    fields: [
      {
        name: 'access_token',
        label: { zh: '访问令牌', en: 'Access token' },
        secret: true,
        required: true,
        kind: 'password',
        hint: {
          zh: '要带 `ads_management` 权限的那一把。与社媒那张卡可以是同一次授权换出来的，但权限要另加。',
          en: 'Must carry `ads_management`. It can come from the same OAuth grant as the social card, but that scope is extra.',
        },
      },
      {
        name: 'business_id',
        label: { zh: '商务管理平台 id', en: 'Business Manager id' },
        secret: false,
        required: false,
        kind: 'text',
        hint: {
          zh: '填了就按商务管理平台列账户；留空就列这把 token 自己能看到的广告账户。',
          en: 'With it we list the Business Manager’s accounts; without it, the accounts this token owns.',
        },
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://developers.facebook.com/docs/marketing-apis',
    status: 'available',
    note: {
      zh: '与社媒那张 `meta_graph` 是**两张卡**：这条要 `ads_management`（能动预算），那条要 `pages_manage_posts`（能发帖）。同一次授权可以一起授，但别把两把钥匙做成一把。',
      en: 'Separate from the `meta_graph` social card: this one needs `ads_management`, that one `pages_manage_posts`. One grant can cover both, but they stay two keys.',
    },
  },
  {
    kind: 'google_ads',
    name: { zh: 'Google Ads API', en: 'Google Ads API' },
    category: 'ads',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'google_ads',
    fields: [
      {
        name: 'access_token',
        label: { zh: '访问令牌', en: 'Access token' },
        secret: true,
        required: true,
        kind: 'password',
      },
      {
        name: 'developer_token',
        label: { zh: 'Developer token', en: 'Developer token' },
        secret: true,
        required: true,
        kind: 'password',
        hint: {
          zh: '在 Google Ads 后台的 API Center 单独申请并过审（基础访问权限够用）。**与 OAuth 授权是两件事**——缺它的时候上游回 401，但"重新连一次"解决不了。',
          en: 'Applied for separately in the Ads API Center. Missing it returns 401, and re-authorising will not fix that.',
        },
      },
      {
        name: 'customer_id',
        label: { zh: '客户 id', en: 'Customer id' },
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '1234567890',
        hint: {
          zh: '后台右上角那串十位数字，**不带横杠**。',
          en: 'The ten digits in the top-right of the Ads UI, without dashes.',
        },
      },
      {
        name: 'login_customer_id',
        label: { zh: '经理账户 id', en: 'Manager (MCC) id' },
        secret: false,
        required: false,
        kind: 'text',
        hint: {
          zh: '用 MCC 管别人的账户时填；自己管自己的留空。',
          en: 'Only when managing accounts through an MCC.',
        },
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://developers.google.com/google-ads/api/docs/start',
    status: 'available',
    note: {
      zh: '三样东西缺一不可：OAuth 令牌、**developer token**（要单独申请过审）、客户 id。Merchant Center 的商品 feed 也归这条职责，但那一侧还没接。',
      en: 'Three things are required: the OAuth token, a reviewed developer token, and the customer id. Merchant Center feeds belong to this role but are not wired yet.',
    },
  },
  {
    kind: 'x_ads',
    name: { zh: 'X Ads API', en: 'X Ads API' },
    category: 'ads',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      '批下来之后在 X 广告后台拿的那把 token',
      'The token issued after your Ads API application is approved',
    ),
    side_effect: 'write_external',
    docs_url: 'https://developer.x.com/en/docs/x-ads-api',
    status: 'planned',
    note: {
      zh: '申请制：要先有广告账户、提交 Ads API 申请、说明用途、等人工审核。社媒那条买的 X API **付费档管不到这一侧**——两套授权。没接上之前排计划、攒提案、看额度照常。',
      en: 'Application-gated and separate from the paid X API tier used by the social role. Planning and approvals work without it.',
    },
  },
  {
    kind: 'tiktok_ads',
    name: { zh: 'TikTok Ads（Business API）', en: 'TikTok Ads (Business API)' },
    category: 'ads',
    auth: 'client_credentials',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'app_id',
        label: { zh: 'App id', en: 'App id' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'secret',
        label: { zh: 'App secret', en: 'App secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://business-api.tiktok.com/portal/docs',
    status: 'planned',
    note: {
      zh: '要先在 Business Center 里把广告账户授权给一个过了审的开发者应用；与社媒那条的 Content Posting API 是**两套申请**。Spark Ads 还要有机账号那一侧再给一次授权码。',
      en: 'Requires Business Center authorisation of a reviewed developer app, separately from the Content Posting API. Spark Ads needs one more grant from the organic account.',
    },
  },
  // ── 社媒与红人（48 §5.1 五条渠道）────────────────────────────────────
  {
    kind: 'youtube_data',
    name: { zh: 'YouTube Data API', en: 'YouTube Data API' },
    category: 'social',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      'Google Cloud 里启用 YouTube Data API v3 之后生成的那串 key',
      'The key you get after enabling YouTube Data API v3 in Google Cloud',
    ),
    side_effect: 'read_external',
    docs_url: 'https://developers.google.com/youtube/v3',
    status: 'planned',
    note: {
      zh: '全站一天 10000 单位配额，不是按工作区算的。没连也能干活——找人先用导入你手上那张表。',
      en: 'A site-wide 10k unit daily quota. Sourcing works without it via imports and the public library.',
    },
  },
  {
    kind: 'facebook_graph',
    name: { zh: 'Facebook Graph API', en: 'Facebook Graph API' },
    category: 'social',
    auth: 'oauth',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'read_external',
    docs_url: 'https://developers.facebook.com/docs/graph-api',
    status: 'planned',
    note: {
      zh: '读主页与群组博主要 Meta 的主页权限，审核制。',
      en: 'Reading pages and group creators needs reviewed Meta page permissions.',
    },
  },
  {
    kind: 'instagram_graph',
    name: { zh: 'Instagram Graph API', en: 'Instagram Graph API' },
    category: 'social',
    auth: 'oauth',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'read_external',
    docs_url: 'https://developers.facebook.com/docs/instagram-platform',
    status: 'planned',
    note: {
      zh: '它没有「按关键词搜人」这回事，只能按名字查指名的账号。',
      en: 'It has no keyword creator search — only lookups of accounts you already name.',
    },
  },
  {
    kind: 'tiktok_research',
    name: { zh: 'TikTok Research API', en: 'TikTok Research API' },
    category: 'social',
    auth: 'client_credentials',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'client_key',
        label: { zh: 'Client key', en: 'Client key' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'client_secret',
        label: { zh: 'Client secret', en: 'Client secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
    ],
    side_effect: 'read_external',
    docs_url: 'https://developers.tiktok.com/doc/about-research-api',
    status: 'planned',
    note: {
      zh: '申请制：要向 TikTok 提交用途说明，批了才有数据。',
      en: 'Application-gated: TikTok must approve your stated research use.',
    },
  },
  {
    kind: 'x_api',
    name: { zh: 'X API', en: 'X API' },
    category: 'social',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      'X 开发者后台里那串 Bearer token',
      'The bearer token from the X developer portal',
    ),
    side_effect: 'read_external',
    docs_url: 'https://developer.x.com/en/docs/x-api',
    status: 'planned',
    note: { zh: '官方接口是付费档，数据供给要花钱。', en: 'The official API is a paid tier.' },
  },
  /*
   * WP72（56 §1）：**社媒运营那八张卡**。
   *
   * 与红人那五条的关系：`youtube_data` 与 `x_api` **就是上面那两条**，不新建
   * （56 §1「YouTube 与红人岗位的是同一张卡」）——一把 key 管两条职责，写成两个
   * kind 的后果是用户在连接页上看到两张 YouTube，连了一张另一张还说没连。
   *
   * Facebook 群组**在这张表里没有一条**：Groups API 已经停了，它走第三栏的受控
   * 浏览器（职责 yml 里那格 `mode: browser`）。目录里给它一张点不动的卡，
   * 比不给更糟——点进去无处可点。
   *
   * 每一条的 `note` 写的是**接口现实**（56 §1 末行）：申请制、付费档、模板 +
   * opt-in + 24h 窗口。说在前面，比让人填完之后撞一堵墙强。
   */
  {
    kind: 'meta_graph',
    name: { zh: 'Meta Graph API（FB 主页 + IG）', en: 'Meta Graph API (Page + Instagram)' },
    category: 'social',
    auth: 'oauth',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    // 这条是**发内容**用的，不是读别人的号：与上面那条 `facebook_graph` 分得开
    side_effect: 'write_external',
    docs_url: 'https://developers.facebook.com/docs/pages-api',
    status: 'available',
    service: 'meta_graph',
    note: {
      zh: '一把 token 管 FB 主页 + IG 商业号。连上就能读，**能发要过 App Review**——那是两件事。',
      en: 'One token covers the FB Page and the IG business account. Reading works at once; publishing needs App Review.',
    },
  },
  {
    kind: 'tiktok_content',
    name: { zh: 'TikTok Content Posting API', en: 'TikTok Content Posting API' },
    category: 'social',
    auth: 'client_credentials',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'client_key',
        label: { zh: 'Client key', en: 'Client key' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'client_secret',
        label: { zh: 'Client secret', en: 'Client secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
    // WP73：适配器接上了真调用（两跳发布 + 状态轮询），所以这张卡点得动了。
    // 申请没批下来的后果退回它该有的样子：上游回 403，我们说"要先申请"。
    status: 'available',
    service: 'tiktok_content',
    note: {
      zh: '申请制，且与红人那条用的 Research API **要分别申请**。发布是两跳（init 拿 publish_id，再轮询状态）。没批下来之前排期、草稿、审批照常。',
      en: 'Application-gated, and applied for separately from the Research API. Publishing takes two hops (init, then poll status). Scheduling and drafts work without it.',
    },
  },
  {
    kind: 'reddit',
    name: { zh: 'Reddit API', en: 'Reddit API' },
    category: 'social',
    auth: 'client_credentials',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'client_id',
        label: { zh: 'Client ID', en: 'Client ID' },
        secret: false,
        required: true,
        kind: 'text',
      },
      {
        name: 'client_secret',
        label: { zh: 'Client secret', en: 'Client secret' },
        secret: true,
        required: true,
        kind: 'password',
      },
      {
        name: 'user_agent',
        label: { zh: 'User-Agent', en: 'User-Agent' },
        secret: false,
        required: true,
        kind: 'text',
        hint: {
          zh: 'Reddit 只认这个格式：`平台:应用 id:版本 (by /u/你的用户名)`。写错一律 429。',
          en: 'Reddit only accepts `platform:app-id:version (by /u/you)`. Anything else gets 429.',
        },
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://www.reddit.com/dev/api',
    // WP73：适配器接上了真调用（发帖 / 回帖 / 版务动作 / 置顶公告）。
    status: 'available',
    service: 'reddit',
    note: {
      zh: '要先注册一个 script / web 应用。连不上最常见的原因是 User-Agent 写错了，不是密钥错了。一分钟最多 60 次调用，超了我们自己先排队。',
      en: 'Register a script or web app first. A malformed User-Agent — not a bad key — is the usual cause of failures. 60 calls per minute; we queue beyond that ourselves.',
    },
  },
  // ── 公共关系（WP78 / 60 §5）─────────────────────────────────────────
  //
  // Reddit **不在这里**：`pr.reddit` 用的就是上面那张 `reddit` 卡（60 分界行——
  // 社媒管我们自己的版、公关管别人的版，一把 key 管两条职责）。
  // 论坛（Quora / 知乎）也不在：它们没有公开写接口，走第三栏受控浏览器，
  // 职责 yml 里标的是 `mode: browser`——目录里给它一张点不动的卡比不给更糟。
  {
    kind: 'google_alerts',
    name: { zh: 'Google Alerts（品牌监控）', en: 'Google Alerts' },
    category: 'pr',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'feed_url',
        label: { zh: 'RSS 地址', en: 'RSS feed URL' },
        secret: false,
        required: true,
        kind: 'url',
        hint: {
          zh: '在 Google Alerts 里把这条提醒的「投递方式」改成 RSS，再复制那个地址。**这个地址本身就是密钥**（谁拿到谁看得见这条提醒）。',
          en: 'Switch the alert delivery to RSS in Google Alerts, then copy the feed URL. **The URL is the secret** — anyone holding it can read the alert.',
        },
      },
      {
        name: 'brand_terms',
        label: { zh: '要盯的词', en: 'Terms to watch' },
        secret: false,
        required: false,
        kind: 'text',
        hint: {
          zh: '选填。Reddit 那一侧的全站搜索用它；Google Alerts 那边盯什么是你自己设的，我们改不了。',
          en: 'Optional; used for the Reddit-wide search. What Google Alerts watches is set on their side.',
        },
      },
    ],
    // 只读一条 feed，不改外面任何东西
    side_effect: 'read_external',
    docs_url: 'https://www.google.com/alerts',
    status: 'available',
    service: 'google_alerts',
    note: {
      zh: '免费、不用申请、不要 key——这是唯一一个不违反谁的条款的新闻监控入口。它有延迟（几小时到一天）也会漏，所以它**不是**全网监控；拉不到的时候面板会照实说"这条 feed 没拉到"，不会显示今天 0 条。',
      en: "Free, no application, no key — the only news-monitoring entry point that breaks nobody's terms. It lags (hours to a day) and misses things, so it is not full-web monitoring. When a pull fails the panel says so rather than showing zero mentions.",
    },
  },
  {
    kind: 'press_distribution',
    name: { zh: '新闻稿分发', en: 'Press distribution' },
    category: 'pr',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [],
    side_effect: 'write_external',
    status: 'planned',
    note: {
      zh: '把稿子一次发给一批媒体的那类服务（美通社 / 商业资讯这一派）。它们要合同、要企业账号、按条收费——现在给一张表单是骗人。在接上之前，分发那一跳出的是一张卡 + 一份可以直接复制的稿件正文，你自己发出去；**不假装已经发出去了**。',
      en: 'Newswire services that blast a release to a media list. They need contracts, corporate accounts and per-release fees — a form here today would be a lie. Until then, distribution produces an approval card plus a copy-ready release body that you send yourself.',
    },
  },
  {
    kind: 'discord_bot',
    name: { zh: 'Discord 机器人', en: 'Discord bot' },
    category: 'social',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'bot_token',
        label: { zh: '机器人令牌', en: 'Bot token' },
        secret: true,
        required: true,
        kind: 'password',
        hint: {
          zh: '开发者后台 Bot 页那串令牌。请求头写的是 `Bot <token>`，不是 `Bearer`。',
          en: 'The token from the Bot page. The header is `Bot <token>`, not `Bearer`.',
        },
      },
      {
        name: 'guild_id',
        label: { zh: '服务器 id', en: 'Server (guild) id' },
        secret: false,
        required: true,
        kind: 'text',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://discord.com/developers/docs/intro',
    status: 'available',
    service: 'discord_bot',
    note: {
      zh: '建一个应用、加一个 Bot、把它邀请进你的服务器。禁言是设一个到期时刻，到点自动解除。',
      en: 'Create an app, add a bot, invite it to your server. Timeouts are an expiry instant, cleared automatically.',
    },
  },
  {
    kind: 'telegram_bot',
    name: { zh: 'Telegram 机器人', en: 'Telegram bot' },
    category: 'social',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'bot_token',
        label: { zh: '机器人令牌', en: 'Bot token' },
        secret: true,
        required: true,
        kind: 'password',
        hint: {
          zh: '跟 @BotFather 说 /newbot 就给你。**这串东西在 URL 的路径上**，所以我们的日志会专门抹掉它。',
          en: 'Ask @BotFather for /newbot. It travels in the URL path, so our logs redact it explicitly.',
        },
      },
      {
        name: 'chat_id',
        label: { zh: '群 / 频道 id', en: 'Chat or channel id' },
        secret: false,
        required: true,
        kind: 'text',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://core.telegram.org/bots/api',
    status: 'available',
    service: 'telegram_bot',
    note: {
      zh: '把机器人拉进群并给管理员权限，否则删消息与禁言都做不了。业务错误在 200 里，看的是 `ok` 那一格。',
      en: 'Add the bot to the group as an admin, or moderation calls do nothing. Business errors come back inside a 200 with `ok: false`.',
    },
  },
  {
    kind: 'whatsapp_business',
    name: { zh: 'WhatsApp Business API', en: 'WhatsApp Business API' },
    category: 'social',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: [
      {
        name: 'access_token',
        label: { zh: '访问令牌', en: 'Access token' },
        secret: true,
        required: true,
        kind: 'password',
      },
      {
        name: 'phone_number_id',
        label: { zh: '号码 id', en: 'Phone number id' },
        secret: false,
        required: true,
        kind: 'text',
      },
    ],
    side_effect: 'write_external',
    docs_url: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    // WP73：适配器接上了真调用（模板消息群发 + 24h 窗口内的自由文本回复）。
    // 两道硬闸（模板名必填、opt-in 必须核过）在适配器这一层再查一遍。
    status: 'available',
    service: 'whatsapp_business',
    note: {
      zh: '要过商业验证。主动发消息**只能用审批过的模板，且收件人必须先 opt-in**；对方来过消息之后有 24 小时窗口能自由回复。这三条是 Meta 的规矩，违反了封的是这个号。',
      en: 'Business verification required. Outbound messages need an approved template and prior opt-in; free-form replies only inside the 24-hour customer window. These are Meta rules — breaking them gets the number banned.',
    },
  },
  // ── 营销 ────────────────────────────────────────────────────────────
  {
    kind: 'email_marketing',
    name: { zh: '邮件营销', en: 'Email marketing' },
    category: 'marketing',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'klaviyo',
    fields: apiKeyField(
      'Klaviyo 后台 Settings → API keys，只勾读权限就够',
      'Klaviyo Settings → API keys; read-only scope is enough',
    ),
    side_effect: 'read_external',
    docs_url: 'https://developers.klaviyo.com/en/reference/api_overview',
    status: 'planned',
    note: {
      zh: '只读分群、模板与活动效果。群发永远是一张要人点头的卡（51 §2.3），不走这条连接。',
      en: 'Read-only segments, templates and campaign results; sending always goes through an approval card.',
    },
  },
  // ── 物流 ────────────────────────────────────────────────────────────
  {
    kind: 'tracking',
    name: { zh: '物流追踪', en: 'Shipment tracking' },
    category: 'logistics',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'aftership',
    fields: apiKeyField(
      'AfterShip 后台 Settings → API keys，只勾读权限',
      'AfterShip Settings → API keys, read-only',
    ),
    side_effect: 'read_external',
    docs_url: 'https://www.aftership.com/docs/tracking/quickstart/api-quick-start',
    status: 'planned',
    note: {
      zh: '只读轨迹：包裹到哪了、有没有异常。不回写单号——那是标记发货那条变更的事（51 §2.4）。',
      en: 'Read-only tracking; writing tracking numbers back belongs to the fulfilment change, not here.',
    },
  },
  // ── 支付与纠纷 ──────────────────────────────────────────────────────
  {
    kind: 'payment_dispute',
    name: { zh: '支付纠纷', en: 'Payment disputes' },
    category: 'payment',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      '支付服务商后台生成的只读密钥',
      'A read-only key from your payment provider',
    ),
    side_effect: 'read_external',
    status: 'planned',
    note: {
      zh: '还没接：拒付与争议先靠店铺后台那一份，客服岗位没有它照样能干活。',
      en: 'Not wired yet: chargebacks come from the storefront for now.',
    },
  },
  // ── 评价 ────────────────────────────────────────────────────────────
  {
    kind: 'reviews',
    name: { zh: '评价应用', en: 'Reviews app' },
    category: 'reviews',
    auth: 'api_key',
    mode: 'openconnector_provider',
    service: 'judgeme',
    fields: apiKeyField('Judge.me 后台里的 API token', 'The API token from the Judge.me admin'),
    side_effect: 'write_external',
    docs_url: 'https://judge.me/api/docs',
    status: 'planned',
    note: {
      zh: '接上之后店铺管理岗位的差评表与邀评就有数了；Loox 排在它后面。',
      en: 'Once wired, the store role gets its bad-review list and review invites; Loox comes after.',
    },
  },
  // ── 聊天渠道 ────────────────────────────────────────────────────────
  {
    kind: 'chat_widget',
    name: { zh: '网站在线聊天窗', en: 'Website chat widget' },
    category: 'im',
    auth: 'none',
    mode: 'builtin',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    status: 'available',
    note: {
      zh: '这个进程自己就是那一头：把一段代码贴进网站就通了，不用连任何第三方。',
      en: 'This process is the other end: paste one snippet into your site and it works.',
    },
  },
  {
    kind: 'wechat_clawbot',
    name: { zh: '个人微信（ClawBot）', en: 'Personal WeChat (ClawBot)' },
    category: 'im',
    auth: 'qr',
    mode: 'channel_adapter',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    // WP85 定的路由名；那一页做出来之前点过去是一页"还没做"
    docs_url: '/im-channels',
    status: 'planned',
    note: {
      zh: '「我的代理」的微信入口：本人问自己的代理、收自己的卡片。同事加不了、不能进群、收不到别人发给你的消息。',
      en: 'A personal line to your own agent only: colleagues cannot add it, it cannot join groups.',
    },
  },
  {
    kind: 'wecom_bot',
    name: { zh: '企业微信机器人', en: 'WeCom bot' },
    category: 'im',
    auth: 'client_credentials',
    mode: 'channel_adapter',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    docs_url: '/im-channels',
    status: 'planned',
    note: {
      zh: '团队渠道：审批卡推送、同事在群里 @ 代理。',
      en: 'The team channel: approval cards and @-mentions in group chats.',
    },
  },
  // ── 开发 ────────────────────────────────────────────────────────────
  {
    kind: 'github',
    name: { zh: 'GitHub', en: 'GitHub' },
    category: 'dev',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      '一枚只读的 fine-grained personal access token',
      'A read-only fine-grained personal access token',
    ),
    side_effect: 'read_external',
    docs_url: 'https://docs.github.com/en/rest',
    status: 'planned',
    note: {
      zh: '建站岗位读主题仓库用；没有它主题读写照样走 Shopify 那条。',
      en: 'Used by the site-builder role to read a theme repo; theme editing itself goes through Shopify.',
    },
  },
  // ── 设计（WP76，58 §1 末行「Figma / Canva 登记待增加」）──────────────
  //
  // 两条都是 `planned`，而且短期内不会变。明着列出来而不是藏起来的理由与
  // 「评价应用」那几条逐字相同：用户在目录里找不到 Figma 时只会以为是自己
  // 没找到，然后去问一遍。
  //
  // **没有这两条，设计岗位照样能用**：出图走模型网关的图片槽（22），
  // 素材存 blob store（41 §2），需求单与 brief 在自己的库里。
  // Figma / Canva 接上之后多的是"把定稿的那一张同步过去""从现成的模板起稿"，
  // 不是"没有它就出不了图"。
  {
    kind: 'figma',
    name: { zh: 'Figma', en: 'Figma' },
    category: 'design',
    auth: 'api_key',
    mode: 'openconnector_provider',
    fields: apiKeyField(
      '一枚 Figma personal access token（设置页 → Security → Personal access tokens）',
      'A Figma personal access token (Settings → Security → Personal access tokens)',
    ),
    // 接上之后要往文件里写（同步定稿、建 frame），按最重的那件事算
    side_effect: 'write_external',
    docs_url: 'https://www.figma.com/developers/api',
    status: 'planned',
    note: {
      zh: '设计岗位用：把定稿的那一张同步进设计文件，或者从现成的模板起稿。没有它照样出 brief、出图、入库。',
      en: 'For the design position: sync a finished asset into a design file, or start from an existing template. Everything else works without it.',
    },
  },
  {
    kind: 'canva',
    name: { zh: 'Canva', en: 'Canva' },
    category: 'design',
    auth: 'oauth',
    mode: 'openconnector_provider',
    fields: OAUTH_NO_FIELDS,
    side_effect: 'write_external',
    docs_url: 'https://www.canva.dev/docs/connect/',
    status: 'planned',
    note: {
      zh: '设计岗位用：套现成模板出一版，或者把定稿导出成各平台尺寸。没有它照样出 brief、出图、入库。',
      en: 'For the design position: lay out a version from a template, or export a finished asset to each platform size. Everything else works without it.',
    },
  },
  // ── 自定义 ──────────────────────────────────────────────────────────
  {
    kind: 'mcp_server',
    name: { zh: '自定义 MCP 服务器', en: 'Custom MCP server' },
    category: 'custom',
    auth: 'none',
    mode: 'mcp_server',
    fields: MCP_FIELDS,
    // 一台 MCP 服务器能干什么我们事先不知道，按 54（将改号 55）§3 的兜底规矩算写
    side_effect: 'write_external',
    docs_url: 'https://modelcontextprotocol.io/docs/concepts/transports',
    status: 'available',
    note: {
      zh: '保存、校验、探测（连一次、把它报的工具列出来），并按职责挂到 Agent 上：职责模板写 `mcp:<名字>` 就进那条职责的 preset。',
      en: "Saved, validated, probed, and mounted per role: a role template naming `mcp:<name>` gets it in that role's preset.",
    },
  },
]

/** 分类 → 中英名（连接页"添加连接"的分组标题）。顺序即出场顺序。 */
export const CONNECTION_CATEGORIES: readonly {
  id: ConnectionCategory
  name: { zh: string; en: string }
}[] = [
  { id: 'storefront', name: { zh: '店铺后台', en: 'Storefront' } },
  { id: 'mailbox', name: { zh: '邮箱', en: 'Mailbox' } },
  { id: 'marketplace', name: { zh: '平台电商', en: 'Marketplaces' } },
  { id: 'analytics', name: { zh: '数据分析', en: 'Analytics' } },
  { id: 'ads', name: { zh: '广告', en: 'Ads' } },
  { id: 'social', name: { zh: '社媒与红人', en: 'Social & creators' } },
  { id: 'marketing', name: { zh: '营销', en: 'Marketing' } },
  { id: 'pr', name: { zh: '公共关系', en: 'Public relations' } },
  { id: 'logistics', name: { zh: '物流', en: 'Logistics' } },
  { id: 'payment', name: { zh: '支付', en: 'Payments' } },
  { id: 'reviews', name: { zh: '评价', en: 'Reviews' } },
  { id: 'im', name: { zh: '聊天渠道', en: 'Chat channels' } },
  { id: 'dev', name: { zh: '开发', en: 'Developer' } },
  // WP76（58 §1）
  { id: 'design', name: { zh: '设计', en: 'Design' } },
  { id: 'custom', name: { zh: '自定义', en: 'Custom' } },
]

/**
 * 按 kind 查一条（认别名）。认不出来的回 `undefined`——**不编一条出来**：
 * 目录上多一行查不到来源的假条目，比缺一行更难查。
 */
export function connectionDirectoryEntry(kind: string): ConnectionDirectoryEntry | undefined {
  return CONNECTION_DIRECTORY.find((e) => e.kind === kind || (e.aliases?.includes(kind) ?? false))
}

/** 这个 kind 在目录里的规范名（认别名；认不出来就原样回去）。 */
export function canonicalConnectionKind(kind: string): string {
  return connectionDirectoryEntry(kind)?.kind ?? kind
}

/** 目录里能点得动的那些（`status: 'available'`）。 */
export function availableConnectionKinds(): string[] {
  return CONNECTION_DIRECTORY.filter((e) => e.status === 'available').map((e) => e.kind)
}

/** 按分类分组（顺序照 {@link CONNECTION_CATEGORIES}；空分类不出现）。 */
export function connectionDirectoryByCategory(): {
  category: ConnectionCategory
  name: { zh: string; en: string }
  entries: ConnectionDirectoryEntry[]
}[] {
  const out: {
    category: ConnectionCategory
    name: { zh: string; en: string }
    entries: ConnectionDirectoryEntry[]
  }[] = []
  for (const c of CONNECTION_CATEGORIES) {
    const entries = CONNECTION_DIRECTORY.filter((e) => e.category === c.id)
    if (entries.length > 0) out.push({ category: c.id, name: c.name, entries })
  }
  return out
}

// ── 自定义 MCP 服务器（保存 / 校验 / 探测）────────────────────────────

export type McpTransport = 'stdio' | 'streamable-http'

/**
 * 一台已登记的自定义 MCP 服务器。
 *
 * **这里没有请求头的值**：`header_names` 只有名字，值在本机加密库里
 * （13 §4.3 同一条纪律——Bearer token 与密码一个待遇）。
 */
export interface McpServerRecord {
  name: string
  transport: McpTransport
  /** stdio：可执行文件与参数。 */
  command?: string
  args?: readonly string[]
  /** streamable-http：服务器地址。 */
  url?: string
  /** 存了哪几个请求头（**只有名字**）。 */
  header_names: readonly string[]
  /**
   * WP86（55 §4 第三层）：这台服务器上**哪几个工具是只读的**（原始工具名，不带
   * `mcp__<serverName>__` 前缀）。
   *
   * 为什么要人来勾：MCP 协议**没有**读写标注，一台自定义服务器能干什么我们事先
   * 不知道（目录条目因此整条按 `write_external` 兜底）。门禁的读写分类
   * （`dsh-adapter` 的 `classifySideEffect`）只认这张表：**列进来的按 `read_external`，
   * 表外的一律按 `write_external`**——公司端（`executor`）因此一调就拒。
   * 空数组 ≡ 没有只读工具 ≡ 这台服务器在公司端一个工具都调不动，这是有意的最严默认。
   */
  read_tools?: readonly string[]
  /** 最近一次探测的结果；从没探测过就没有。 */
  probe?: McpProbeResult
  created_at: string
  updated_at: string
}

/** 探测一次的结果：连上了没有、它报了哪些工具。 */
export interface McpProbeResult {
  ok: boolean
  at: string
  /** 它报的工具（只留名字与一句说明，入参 schema 不进这里——那是运行时的事）。 */
  tools: readonly { name: string; description?: string }[]
  /** 没连上时机器读的原因码。 */
  reason?: string
  /** 没连上时给人看的那一句。 */
  detail?: string
}

/** 名字的规矩：小写字母、数字、短横线，1–64 位。`serverName` 全局唯一（54 §4）。 */
export const MCP_SERVER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 一条自定义 MCP 服务器的登记入参（`headers` 的值是凭据，只走这一次）。 */
export interface McpServerInput {
  name: string
  transport: McpTransport
  command?: string
  args?: readonly string[]
  url?: string
  headers?: Readonly<Record<string, string>>
  /** WP86：哪几个工具是只读的（见 {@link McpServerRecord.read_tools}）。 */
  read_tools?: readonly string[]
}

/**
 * 校验一条登记（**纯函数，不联网**）。回一串问题；空数组 = 没问题。
 *
 * 为什么校验住在契约里：服务进程要用它挡住坏的登记，工作台要用它在用户还没点
 * 保存之前就说清楚缺什么。两边各写一份的话，界面放过去的东西服务端会拒，
 * 用户只会看到一句没头没尾的报错。
 */
export function validateMcpServer(input: McpServerInput): string[] {
  const problems: string[] = []
  if (!MCP_SERVER_NAME_RE.test(input.name))
    problems.push('名字只能用小写字母、数字与短横线，且不能以短横线开头')
  if (input.transport === 'stdio') {
    if ((input.command ?? '').trim() === '') problems.push('stdio 要填「命令」')
    if ((input.url ?? '').trim() !== '') problems.push('stdio 不要填「地址」')
  } else {
    const url = (input.url ?? '').trim()
    if (url === '') problems.push('streamable-http 要填「地址」')
    else {
      let parsed: URL | undefined
      try {
        parsed = new URL(url)
      } catch {
        problems.push('「地址」不是一个合法的 URL')
      }
      if (parsed !== undefined) {
        const local = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost'
        // 请求头里多半是一枚 token；明文 http 发出去等于把它交给同一个网络里的任何人
        if (parsed.protocol !== 'https:' && !local)
          problems.push('「地址」必须是 https（本机 127.0.0.1 / localhost 除外）')
      }
    }
    if ((input.command ?? '').trim() !== '') problems.push('streamable-http 不要填「命令」')
  }
  for (const name of Object.keys(input.headers ?? {})) {
    // HTTP 头名字的字符集（RFC 9110 token）；放宽会让人把整行 `a: b` 当名字填进来
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) problems.push(`请求头的名字不合法：${name}`)
  }
  // WP86：只读清单里放的是**这台服务器报出来的原始工具名**，不是带前缀的全名。
  // 让人填错方向（把 `mcp__x__echo` 粘进来）的话门禁会一条都对不上，静默地更严——
  // 与其让它静默，不如在保存这一刻说清楚。
  for (const tool of input.read_tools ?? []) {
    if (tool.trim() === '') problems.push('只读工具名不能是空的')
    else if (tool.startsWith(MCP_TOOL_PREFIX))
      problems.push(`只读工具填原始名字就行，不要带 ${MCP_TOOL_PREFIX} 前缀：${tool}`)
  }
  return problems
}

// ── WP86（55 §4 第三层）：职责 ↔ MCP 服务器 ↔ 工具名 ─────────────────────

/**
 * 职责模板里指名一台**自定义 MCP 服务器**的 `connectors[].kind` 前缀。
 *
 * 目录里的 `mcp_server` 那一条说的是"可以接自定义 MCP 服务器"这件事本身；
 * 一条职责要用**哪一台**，写成 `mcp:<name>`（`name` 就是登记时起的那个）。
 * 这样"谁用哪台"仍然由职责模板说了算（55 §4：preset 由模板生成、用户不手编），
 * 界面上不需要再来一张"这台服务器给哪些职责用"的勾选表。
 */
export const MCP_CONNECTOR_PREFIX = 'mcp:'

/** `mcp:my-tools` → `my-tools`；不是这种 kind 就回 `undefined`。 */
export function customMcpServerOfKind(kind: string): string | undefined {
  if (!kind.startsWith(MCP_CONNECTOR_PREFIX)) return undefined
  const name = kind.slice(MCP_CONNECTOR_PREFIX.length)
  return MCP_SERVER_NAME_RE.test(name) ? name : undefined
}

/** 官方 `mcp-client` 给工具起名的前缀（`mcp__<serverName>__<rawName>`）。 */
export const MCP_TOOL_PREFIX = 'mcp__'

/** 上游 `mcp-client` 的 `serverName` 字符集与长度（`[A-Za-z0-9_-]{1,32}`）。 */
export const MCP_SERVER_NAME_MAX = 32

/** FNV-1a 32 位；只用来在名字太长时给一个稳定的短后缀（不是密码学用途）。 */
function shortHash(value: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 一条连接在 dsh 那边的 `serverName`：`<workspace>_<kind>`。
 *
 * 上游要求 `serverName` 在**一个注册作用域内全局唯一**，而我们一个进程装得下多个
 * 品牌（52 O1）：不带 workspace 的话，品牌 A 的 `shopify` 与品牌 B 的 `shopify`
 * 会撞名，后挂的那个直接加载失败。字符集与 32 位长度限制也在这里守住——
 * 超了就截断 + 挂一个稳定的短哈希，**不**悄悄截成两个一样的名字。
 */
export function mcpServerNameFor(workspace_id: string, kind: string): string {
  const clean = (v: string): string => v.replace(/[^A-Za-z0-9_-]/g, '_')
  const joined = `${clean(workspace_id)}_${clean(kind)}`
  if (joined.length <= MCP_SERVER_NAME_MAX) return joined
  return `${joined.slice(0, MCP_SERVER_NAME_MAX - 9)}_${shortHash(joined)}`
}

/** `(serverName, rawName)` → 模型看见的那个名字（上游 `mcp-client` 的命名规则）。 */
export function mcpToolName(serverName: string, rawName: string): string {
  return `${MCP_TOOL_PREFIX}${serverName}__${rawName}`
}

/**
 * 反过来：`mcp__ws_local_shopify__get_order` → `{ server: 'ws_local_shopify', tool: 'get_order' }`。
 *
 * 分隔符是**第一个** `__`：`serverName` 的字符集里没有 `__`（`_` 有、连着两个没有
 * 意义），而工具名里可能有。认不出来的回 `undefined`（例如官方浏览器那组
 * `mcp__playwright-mcp__*` 会认出来，调用方自己按 server 名再分流）。
 */
export function parseMcpToolName(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return undefined
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const at = rest.indexOf('__')
  if (at <= 0) return undefined
  const tool = rest.slice(at + 2)
  if (tool === '') return undefined
  return { server: rest.slice(0, at), tool }
}
