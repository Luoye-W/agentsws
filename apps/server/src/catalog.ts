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
import type { ProviderFieldSpec, ProviderSetupGuide } from '@agentsws/api'

/**
 * 连接目录里的 service → 职责模板里的连接器 kind（`connectors[].kind`）。
 * 职责模板不关心"邮箱是 Gmail 还是 IMAP"，只问"有没有邮箱"；这张表就是那一步归并。
 */
export const ROLE_CONNECTOR_KIND: Readonly<Record<string, string>> = {
  shopify_admin: 'shopify',
  imap_smtp: 'email',
  gmail: 'email',
  ga4: 'ga4',
  // WP83：职责模板写的是 `search_console`（`dtc/content.yml`），provider 叫 `gsc`。
  // 这里归并成职责那一侧的名字，否则连上 Search Console 之后 `missing_connectors`
  // 还会一直说缺——连接目录（契约 `connection-directory.ts`）把两个名字都认作同一条。
  gsc: 'search_console',
  meta_ads: 'meta',
  // WP64（51 §2.3 / §2.4）：职责模板问的是"有没有一家邮件营销 / 物流追踪"，
  // 不问是哪一家——`dtc.email-marketing` 写 `kind: email_marketing`，
  // `dtc.fulfillment` 写 `kind: tracking`。
  klaviyo: 'email_marketing',
  shopify_email: 'email_marketing',
  aftership: 'tracking',
  track17: 'tracking',
  // WP68（48 §5.1）：红人的五条渠道。service 名与 kind 同名（职责 yml 问的就是
  // "有没有 YouTube"，不存在"是哪一家 YouTube"这回事）。
  youtube_data: 'youtube_data',
  facebook_graph: 'facebook_graph',
  instagram_graph: 'instagram_graph',
  tiktok_research: 'tiktok_research',
  x_api: 'x_api',
  // WP72（56 §1）：社媒运营那八张卡。service 名与 kind 同名（职责 yml 问的就是
  // "有没有 Discord"，不存在"是哪一家 Discord"这回事）。
  //
  // `youtube_data` 与 `x_api` **就是上面那两行**——56 §1「YouTube 与红人岗位的是
  // 同一张卡」：一把 key 管两条职责，连接页上只有一张 YouTube。不为社媒再建一行。
  // Facebook 群组一行都没有：Groups API 已停，它走第三栏受控浏览器（职责 yml 的
  // `mode: browser`），目录里给它一张点不动的卡比不给更糟。
  meta_graph: 'meta_graph',
  tiktok_content: 'tiktok_content',
  reddit: 'reddit',
  discord_bot: 'discord_bot',
  telegram_bot: 'telegram_bot',
  whatsapp_business: 'whatsapp_business',
}

export type CatalogAuth = 'oauth2' | 'api_key' | 'custom_credential'

/**
 * 提交后走哪条装配路径（WP44 起每个 provider 只有一条）：
 * - `form`：字段原样转给 `store` 指的那个凭据库；
 * - `shopify_client_credentials`：字段是**应用凭据**，先经 `shopify-broker.ts`
 *   换成 Admin API 令牌，再把令牌 PUT 进 OpenConnector。
 */
export type CatalogFlow = 'form' | 'shopify_client_credentials'

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
  /** 原生表单要画的字段。 */
  fields: ProviderFieldSpec[]
  setup_guide: ProviderSetupGuide
  data_note?: string
  /** 试连时优先挑名字里带这些词的只读 Action。 */
  smoke_hints?: string[]
  /** 提交后走哪条装配路径；不写就是 `form`。 */
  flow?: CatalogFlow
  /**
   * WP64：**骨架卡**——目录里有它、表单画得出来，但真调用还没接上。
   *
   * 为什么要让它出现在目录里而不是等接完再加：51 §2.3 / §2.4 的两条职责现在就上线了，
   * 用户在连接页上找不到"邮件营销"这一类，只会以为是自己没找到。所以卡照出，
   * 状态照实说"还没接"，点不动——和 51 §1 N0 给非 Shopify 平台的待遇一样。
   *
   * 值是给人看的那一句（连接页上的灰字、面板上的 note）。有它 = `available: false`，
   * 并且 `begin` / `submit` 当场拒绝：宁可点不动，也不能让人填完密钥之后发现连不上。
   */
  planned?: string
}

/** 这个 provider 的接法。**每个 provider 只有一条**（WP44 删掉了 Shopify 的第二条）。 */
export function flowOf(entry: CatalogEntry): CatalogFlow {
  return entry.flow ?? 'form'
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
      '（read_returns / write_returns）、客户读取（read_customers）、商品读取（read_products）；' +
      // 09-11 真店实测：没做这一步，商品读得到、客户直接被拒、订单查出来是 0 条——而且不报错
      '同一页再申请"受保护客户数据"（Protected customer data access，勾姓名 / 邮箱 / 地址），' +
      '不申请的话订单和客户读出来是空的，还不报错',
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

/**
 * WP68（48 §5.1 / §5.4）：红人营销的五条渠道，从"待增加"改成**可连**。
 *
 * 每一条都是"凭据原生表单直填"（31 §3 / 07 P1 那条路）：各家一把令牌，
 * 用户自己去开发者后台拿，填进来只存在这台电脑的加密库里。字段名与
 * `kol-channels.ts` 的 `KOL_TOKEN_FIELD` **必须一致**——那边取、这边填，
 * 对不上的表现是"填完了还是说没连"，最难查。
 *
 * 三条渠道的准备步骤里都明说了**代价**：Facebook / Instagram 要过 Meta 审核、
 * TikTok 是申请制、X 要买付费档。说在前面，比让人填完之后撞一堵墙强。
 * 而且每一条都补一句"没有它这条职责照样能用"——那是真的（48 §5.1）。
 */
export const KOL_CONNECTORS: readonly CatalogEntry[] = [
  {
    service: 'youtube_data',
    upstream: 'local',
    label: 'YouTube Data API',
    auth: 'api_key',
    store: 'local_vault',
    // WP72（56 §1）：**这一张卡喂两条职责**——红人那条读别人的频道，社媒运营那条
    // 读写我们自己的。连一次就够，所以这里是两个数据源，不是两张卡。
    data_sources: ['kol_channel', 'social_youtube'],
    smoke_hints: ['search_channels', 'get_channel'],
    fields: [
      {
        name: 'api_key',
        label: 'API 密钥',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'Google Cloud 控制台里那把 API key。只存在这台电脑的加密库里，不上传、不进日志',
      },
    ],
    setup_guide: {
      summary:
        '按关键词搜频道、读频道的订阅数与主题。**配额是全站一天 10000 单位**（不是按工作区算的），搜一次 100 单位、读一个频道 1 单位——所以搜人不是可以随便点的按钮。',
      steps: [
        '打开 Google Cloud 控制台，新建（或选一个）项目',
        '在「API 和服务 → 库」里启用 YouTube Data API v3',
        '到「凭据」页点「创建凭据 → API 密钥」，复制那串密钥',
        '（建议）给这把密钥加限制：只允许 YouTube Data API v3',
        '把密钥填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Google Cloud 凭据页', url: 'https://console.cloud.google.com/apis/credentials' },
        {
          label: 'YouTube Data API 配额说明',
          url: 'https://developers.google.com/youtube/v3/determine_quota_cost',
        },
      ],
    },
    data_note:
      '没有它这条职责照样能用：找人靠导入你手上那张表与公共红人库，建联、合作、审核、归因一样不少。' +
      'WP72 起同一把 key 也供社媒运营的 YouTube 那条职责（读写我们自己的频道）——连一次，两处都亮。',
  },
  {
    service: 'instagram_graph',
    upstream: 'local',
    label: 'Instagram Graph API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['kol_channel'],
    smoke_hints: ['business_discovery'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'Meta 开发者后台里那个长期有效的 Page / IG 访问令牌',
      },
      {
        name: 'ig_user_id',
        label: '你自己的 IG 商业账号 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '17841400000000000',
        hint: 'business_discovery 是挂在**你自己**那个商业账号下去查别人的，所以这一格必填',
      },
    ],
    setup_guide: {
      summary:
        'Instagram **没有"按关键词搜人"这回事**：官方只让你按名字查明确指名的商业账号（business_discovery）。所以 IG 上找人的主力永远是导入与公共库，这条连接补的是"这个人现在多少粉、互动怎么样"。',
      steps: [
        '把你的 Instagram 账号切成「商业账号」，并关联一个 Facebook 主页',
        '在 Meta 开发者后台建一个应用，加上 Instagram Graph API',
        '申请权限 instagram_basic 与 instagram_manage_insights（**要过审核**）',
        '用图形 API 浏览器换一个长期令牌，并抄下你自己的 IG 商业账号 id',
        '把令牌和 id 填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Meta 开发者后台', url: 'https://developers.facebook.com/apps' },
        {
          label: 'business_discovery 文档',
          url: 'https://developers.facebook.com/docs/instagram-api/guides/business-discovery',
        },
      ],
    },
    data_note:
      '权限没批下来之前这条职责照样能用，只是"按名字查资料"那一块空着；找人靠导入与公共库。',
  },
  {
    service: 'facebook_graph',
    upstream: 'local',
    label: 'Facebook Graph API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['kol_channel'],
    smoke_hints: ['search_pages', 'get_page'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'Meta 开发者后台里那个应用 / 主页访问令牌',
      },
    ],
    setup_guide: {
      summary:
        '搜主页、读主页的关注数与类目。**搜主页要「主页公开内容访问」权限，那是审核制的**——没批下来时我们会照实说"要过审核"，不会给你一个空列表假装没搜到。建联走主页私信，不走邮箱：很多主页压根没留邮箱。',
      steps: [
        '在 Meta 开发者后台建一个应用（类型选「商务」）',
        '申请权限 Page Public Content Access（要写清楚用途，**审核制**）',
        '用图形 API 浏览器换一个长期访问令牌',
        '把令牌填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Meta 开发者后台', url: 'https://developers.facebook.com/apps' },
        {
          label: '主页搜索文档',
          url: 'https://developers.facebook.com/docs/graph-api/reference/page/',
        },
      ],
    },
    data_note: '没有它这条职责照样能用：找人靠导入与公共库，建联靠人工到主页发私信。',
  },
  {
    service: 'tiktok_research',
    upstream: 'local',
    label: 'TikTok Research API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['kol_channel'],
    smoke_hints: ['get_user'],
    fields: [
      {
        name: 'access_token',
        label: '客户端访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '用 client key / client secret 换来的那个 client access token',
      },
    ],
    setup_guide: {
      summary:
        '**申请制**：要向 TikTok 提交研究用途说明，批了才有数据。批下来之后能按账号名查粉丝数、获赞数与作品数（互动率是我们按人均获赞 ÷ 粉丝数估的，三个数缺一个就不给这一格）。TikTok 也没有"按关键词搜人"的接口。',
      steps: [
        '到 TikTok for Developers 注册开发者账号',
        '申请 Research API 访问权限，写清楚用途（审核要几天到几周）',
        '批下来之后在应用详情页拿到 client key 与 client secret',
        '用它们换一个 client access token（有效期两小时，过期再换一次）',
        '把令牌填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'TikTok for Developers', url: 'https://developers.tiktok.com' },
        {
          label: 'Research API 文档',
          url: 'https://developers.tiktok.com/doc/research-api-get-started',
        },
      ],
    },
    data_note:
      '没批下来这条职责照样能用，只是找人那一块空着；TikTok Shop 的带货归因走追踪链接与联盟码，不靠这条连接。',
  },
  {
    service: 'x_api',
    upstream: 'local',
    label: 'X API',
    auth: 'api_key',
    store: 'local_vault',
    // WP72：与 YouTube 同一条道理——红人那条读别人的号，社媒运营那条发我们自己的。
    // **发推要的是用户上下文的 OAuth，不是这把 App-only Bearer**，所以社媒那一侧
    // 的真调用还没接（WP73），这一格先把数据源挂上。
    data_sources: ['kol_channel', 'social_x'],
    smoke_hints: ['get_user', 'search_users'],
    fields: [
      {
        name: 'bearer_token',
        label: 'Bearer 令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'X 开发者后台里那个令牌。只读用 App-only Bearer 就够；要发推得换成用户上下文的那一把',
      },
      {
        // WP73：社媒运营那一侧要它——v2 没有"我的通知"，读提及只能搜
        // `to:<我> OR @<我>`，没有这一格就不知道该搜谁（红人那一侧用不上，所以选填）
        name: 'handle',
        label: '我们自己的账号名',
        secret: false,
        required: false,
        kind: 'text',
        placeholder: '@nordvolt',
        hint: '只有社媒运营那条职责用得上：读"谁提到了我们"要靠搜自己的 @，没有它就搜不了',
      },
    ],
    setup_guide: {
      summary:
        'X 的官方接口是**付费**的：免费档读不了用户资料。接上之后一跳能批量查最多 100 个账号名的粉丝数。**互动率这一格我们不给**——单个用户接口拿不到近期帖子的互动数，编一个不如空着。',
      steps: [
        '到 X 开发者后台注册开发者账号',
        '买一个能读 users 接口的档位（Basic 起；这一步花钱）',
        '在项目里建一个 App，复制它的 Bearer Token',
        '把令牌填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'X 开发者后台', url: 'https://developer.x.com/en/portal/dashboard' },
        {
          label: 'users 接口文档',
          url: 'https://docs.x.com/x-api/users/user-lookup-by-username',
        },
      ],
    },
    data_note:
      '没买档这条职责照样能用：找人靠导入与公共库，建联、合作、审核、归因一样不少。' +
      '社媒运营的 X 那条职责用同一张卡。WP73 起发推与回复都接上了（`POST /2/tweets`，' +
      '回复是同一个口子加一格 `reply`）——但**发推要的是用户上下文的 OAuth**，' +
      '填一把 App-only Bearer 只读得了、发不了，那时上游回 403，我们照实说"这个档买不到这个口子"。',
  },
]

/**
 * WP72（56 §1）：**社媒运营的六张新卡**。
 *
 * 加上共用的 `youtube_data` 与 `x_api`（在 `KOL_CONNECTORS` 里，不重复一张），
 * 九条渠道职责里的八条各有一张卡；第九条 Facebook 群组没有卡——Groups API 已停，
 * 它走第三栏受控浏览器（职责 yml 的 `mode: browser`）。
 *
 * 与红人那五张同一条路：凭据原生表单直填，只存在这台电脑的加密库里（31 §3 / 07 P1），
 * 不走任何平台的审核跳转。每一张的准备说明里**先说代价**（56 §1 末行）：
 * Meta 发布要过 App Review、TikTok 申请制、Reddit 的 User-Agent 格式、
 * WhatsApp 要商业验证 + 模板 + opt-in + 24h 窗口。说在前面，比让人填完之后撞墙强。
 *
 * **WP73 起八张全可连**：TikTok / Reddit / WhatsApp 三张原来是"目录里有、点不动"，
 * 现在适配器在 `@agentsws/social-core` 里都有真调用了，所以表单补齐、状态改成可连。
 * 平台那一侧的门槛照实说在准备说明里，**不当成连接失败**：TikTok 没批下来是 403 →
 * "这个接口要先申请"；X 免费档是 403 → "这个档买不到这个口子"；WhatsApp 少模板名
 * 或没核过 opt-in → 当场 block，不给"点一下就发"的路径。
 */
export const SOCIAL_CONNECTORS: readonly CatalogEntry[] = [
  {
    service: 'meta_graph',
    upstream: 'local',
    label: 'Meta Graph API（FB 主页 + IG）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_meta'],
    smoke_hints: ['get_page', 'list_page_posts'],
    fields: [
      {
        name: 'access_token',
        label: '主页访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'Meta 开发者后台里那个长期有效的主页访问令牌。只存在这台电脑的加密库里',
      },
      {
        name: 'page_id',
        label: 'FB 主页 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '100000000000000',
      },
      {
        name: 'ig_user_id',
        label: 'IG 商业账号 id',
        secret: false,
        required: false,
        kind: 'text',
        placeholder: '17841400000000000',
        hint: '只发 FB 主页就留空。填了这一格，同一把令牌也管 IG',
      },
    ],
    setup_guide: {
      summary:
        '一把 token 管 FB 主页 + IG 商业号：读帖子与表现、发布与排期、回评论。**连上就能读，能发要过 App Review**——这是两件事，别把"还没批"当成"连接失败"。排期要两格一起写（`published: false` + 时间），只写时间那条会当场发出去。',
      steps: [
        '把 IG 切成商业账号并关联你的 FB 主页（只发 FB 可跳过）',
        '在 Meta 开发者后台建一个应用，加上 Facebook 登录与 Instagram Graph API',
        '申请 pages_manage_posts / pages_read_engagement / instagram_content_publish（**要过审核**）',
        '用图形 API 浏览器换一个长期主页令牌，并抄下主页 id 与 IG 账号 id',
        '把令牌与 id 填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Meta 开发者后台', url: 'https://developers.facebook.com/apps' },
        { label: '主页发布文档', url: 'https://developers.facebook.com/docs/pages-api' },
      ],
    },
    data_note:
      '没连也能排内容、写草稿、攒审批——真发出去那一跳才需要它。发布权限还在审核里的时候，到点了我们提醒你去后台手工发一下，不会假装已经发出去了。',
  },
  {
    service: 'tiktok_content',
    upstream: 'local',
    label: 'TikTok Content Posting API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_tiktok'],
    smoke_hints: ['creator_info', 'list_videos'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '用 client key / secret 换出来的那一把（scope 要有 video.publish 与 video.list）',
      },
      {
        name: 'client_key',
        label: 'Client key',
        secret: false,
        required: false,
        kind: 'text',
        hint: '选填，只是为了在连接页上认出这是哪一个应用',
      },
    ],
    setup_guide: {
      summary:
        '**申请制**，而且与红人那条用的 Research API **要分别申请**。发布是两跳：init 拿一个 publish_id，TikTok 自己去抓素材，再轮询状态——一跳发完这件事在 TikTok 上不存在，所以"发出去了"要等状态变成 `PUBLISH_COMPLETE`。另外它**没有开放的评论读写接口**，待回评论那一块在这条渠道上是空的。',
      steps: [
        '到 TikTok 开发者后台建一个应用，申请 Content Posting API（要写用途说明，审核制）',
        '把要发视频的那个域名加进应用的 URL 白名单（我们用 PULL_FROM_URL，TikTok 自己去抓）',
        '用 client key / secret 走 OAuth 换一把带 video.publish 的访问令牌',
        '把令牌填进下面的表单——只存在这台电脑上',
      ],
      links: [
        {
          label: 'Content Posting API 文档',
          url: 'https://developers.tiktok.com/doc/content-posting-api-get-started',
        },
      ],
    },
    data_note:
      '申请没批下来的时候上游回 403——我们说的是"这个接口要先申请"，不是"连接失败"，' +
      '免得你在这张卡上反复重填一把根本没问题的令牌。在此之前排期、草稿、审批照常，' +
      '到点提醒你去后台手工发。',
  },
  {
    service: 'reddit',
    upstream: 'local',
    label: 'Reddit API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_reddit'],
    smoke_hints: ['about_subreddit', 'list_new'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '用 client id / secret 换出来的那一把（scope 要有 submit、edit、modposts）',
      },
      {
        name: 'user_agent',
        label: 'User-Agent',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: 'macos:agentsws:1.0 (by /u/yourname)',
        hint: 'Reddit 只认这个格式：`平台:应用 id:版本 (by /u/你的用户名)`。写错一律 429——连不上最常见的原因是这一格，不是密钥',
      },
      {
        name: 'subreddit',
        label: '版块名',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: 'nordvolt',
        hint: '不用写 r/，写版块名本身就行',
      },
    ],
    setup_guide: {
      summary:
        '要先在 Reddit 注册一个 script / web 应用，拿 client id + secret 换令牌。**User-Agent 必须是 Reddit 认的格式**，写错一律 429。这条渠道上的"群发"= 发一条**置顶帖**：给每个订阅者发私信是明令禁止的（会被举报成垃圾信，封的是这个号）。一分钟最多 60 次调用，超了我们自己先排队，而不是等它 429。',
      steps: [
        '到 https://www.reddit.com/prefs/apps 建一个应用（选 script 或 web app）',
        '复制 client id 与 secret，走 OAuth 换一把访问令牌',
        '把 User-Agent 按 `平台:应用 id:版本 (by /u/你的用户名)` 写好',
        '把令牌、User-Agent 与版块名填进下面的表单——只存在这台电脑上',
      ],
      links: [{ label: 'Reddit API 文档', url: 'https://www.reddit.com/dev/api' }],
    },
    data_note:
      'subreddit **没有成员名册、也没有入群审批**（关注是单向的），所以「待审入群」那一块' +
      '在这条渠道上永远是空的——那不是没连，是这件事在 Reddit 上不存在。' +
      '读得到的是版务名单（谁说了算）。',
  },
  {
    service: 'discord_bot',
    upstream: 'local',
    label: 'Discord 机器人',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_discord'],
    smoke_hints: ['get_guild', 'list_channel_messages'],
    fields: [
      {
        name: 'bot_token',
        label: '机器人令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '开发者后台 Bot 页那串令牌。请求头写的是 `Bot <token>` 不是 `Bearer`——这一点我们替你处理了',
      },
      {
        name: 'guild_id',
        label: '服务器 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '900000000000000000',
        hint: '在 Discord 里打开开发者模式，右键服务器 →「复制服务器 ID」',
      },
    ],
    setup_guide: {
      summary:
        '读频道消息与成员、发公告、删消息、禁言。**禁言是设一个到期时刻**（到点自动解除，上限 28 天），不是一个开关；封禁永远要人点。发公告必须说清发到哪个频道——没有"全服务器广播"这个选项。',
      steps: [
        '到 Discord 开发者后台建一个应用，在 Bot 页添加一个 Bot 并复制令牌',
        '在 OAuth2 → URL Generator 里勾 bot 与要用的权限（读消息、发消息、管理消息、超时成员）',
        '用生成的链接把这个 Bot 邀请进你的服务器',
        '打开 Discord 的开发者模式，右键服务器复制它的 id',
        '把令牌与服务器 id 填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Discord 开发者后台', url: 'https://discord.com/developers/applications' },
        { label: 'Bot 文档', url: 'https://discord.com/developers/docs/intro' },
      ],
    },
    data_note:
      '没连也能整理规则、攒公告草稿、攒审批——真发出去那一跳才需要它。Bot 没有管理员权限时删消息与禁言会失败，我们会把平台原话端出来，不翻译成"出错了"。',
  },
  {
    service: 'telegram_bot',
    upstream: 'local',
    label: 'Telegram 机器人',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_telegram'],
    smoke_hints: ['get_me', 'get_chat'],
    fields: [
      {
        name: 'bot_token',
        label: '机器人令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '跟 @BotFather 说 /newbot 就给你。这串东西在请求 URL 的路径上，所以我们的日志会专门抹掉它',
      },
      {
        name: 'chat_id',
        label: '群 / 频道 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '-1001234567890',
        hint: '群 id 是负数；频道也可以写 @频道用户名',
      },
    ],
    setup_guide: {
      summary:
        '读群里的消息、发公告、删消息、禁言封禁。**业务错误在 200 里**（`{"ok": false, ...}`），所以"发出去了"看的是 `ok` 那一格不是状态码——这一点我们替你判了。机器人必须是群管理员，否则删与禁都做不了。',
      steps: [
        '在 Telegram 里找 @BotFather，发 /newbot，按提示起名字',
        '复制它给你的那串令牌',
        '把机器人拉进你的群，并设成管理员（要删消息与禁言就必须这一步）',
        '拿到群 id（把机器人加进群后发一条消息，或用 @userinfobot）',
        '把令牌与群 id 填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'BotFather', url: 'https://t.me/botfather' },
        { label: 'Bot API 文档', url: 'https://core.telegram.org/bots/api' },
      ],
    },
    data_note: '没连也能整理群规、攒公告草稿、攒审批——真发出去那一跳才需要它。',
  },
  {
    service: 'whatsapp_business',
    upstream: 'local',
    label: 'WhatsApp Business API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['social_whatsapp'],
    smoke_hints: ['get_business_profile'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'Meta 开发者后台里那个长期有效的系统用户令牌',
      },
      {
        name: 'phone_number_id',
        label: '号码 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '106540352242922',
        hint: '不是电话号码本身，是后台里那串数字 id',
      },
      {
        name: 'display_phone_number',
        label: '显示的号码',
        secret: false,
        required: false,
        kind: 'text',
        placeholder: '+86 138 0000 0000',
        hint: '只用来在界面上认出是哪个号',
      },
      {
        name: 'template_language',
        label: '模板语言',
        secret: false,
        required: false,
        kind: 'text',
        placeholder: 'zh_CN',
        hint: '留空就按 zh_CN。要与后台那个模板批下来时的语言**一字不差**，否则上游拒发',
      },
    ],
    setup_guide: {
      summary:
        '**三条规矩都是 Meta 的，不是我们的**：要过商业验证；主动发消息只能用审批过的模板（`template.name` 必填），且收件人必须先 opt-in；对方来过消息之后才有 24 小时窗口能自由回复。违反了封的是这个品牌的号——所以少模板名或没核过 opt-in 时我们**当场 block**，不是让你点一下就发；窗口过了的自由文本也发不出去，会让你改成选一个模板。',
      steps: [
        '在 Meta 商务管理平台过商业验证，并把号码接进 WhatsApp Business 平台',
        '在开发者后台建一个应用，加 WhatsApp 产品，拿号码 id',
        '建一个系统用户并生成长期访问令牌（权限要有 whatsapp_business_messaging）',
        '在后台建好要用的消息模板并等它审核通过——模板名与语言就是这里要对上的那两格',
        '把令牌与号码 id 填进下面的表单——只存在这台电脑上',
      ],
      links: [
        {
          label: 'WhatsApp Cloud API 文档',
          url: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
        },
      ],
    },
    data_note:
      '群发是**一个一个发**的（Cloud API 没有批量接口），所以卡面上那个"发给多少人"' +
      '就是要打多少跳；中途被限流或者掉线我们**停下来**，不接着发也不重试——' +
      '重试一条可能已经送达的模板消息，代价是对方收到两条一样的。',
  },
]

/**
 * WP75（57 §1）：**投放岗位那四张卡**。
 *
 * 与社媒那八张同一条路：凭据原生表单直填，只存在这台电脑的加密库里（31 §3 / 07 P1）。
 * 每一张的准备说明里**先说代价**：Meta 要 `ads_management`（与主页管理是两件事）、
 * Google 要单独申请一个 developer token、X 是申请制、TikTok 要 Business Center 授权。
 *
 * **Meta / Google 可连**（`@agentsws/ads-core` 里有真调用）；X / TikTok 照 WP64
 * 骨架卡的老规矩标着"还没接"、点不动——给一张能填的表单、填完撞一堵墙，
 * 比明说"还没接"糟得多。
 */
export const ADS_CONNECTORS: readonly CatalogEntry[] = [
  {
    service: 'meta_marketing',
    upstream: 'local',
    label: 'Meta Marketing API（投放）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['ads_meta'],
    smoke_hints: ['list_ad_accounts', 'list_campaigns'],
    fields: [
      {
        name: 'access_token',
        label: '访问令牌',
        secret: true,
        required: true,
        kind: 'password',
        hint: '要带 ads_management 权限的那一把。与社媒那张卡可以是同一次授权换出来的，但那条权限要另加',
      },
      {
        name: 'business_id',
        label: '商务管理平台 id',
        secret: false,
        required: false,
        kind: 'text',
        placeholder: '100000000000000',
        hint: '填了就按商务管理平台列账户；留空就列这把 token 自己能看到的广告账户',
      },
    ],
    setup_guide: {
      summary:
        '读账户与 campaign 表现、改预算与出价、暂停、换素材。**与社媒那张 Meta 卡是两张**：这条要 `ads_management`（能动预算），那条要 `pages_manage_posts`（能发帖）。同一次授权可以一起授下来，但别把两把钥匙做成一把。',
      steps: [
        '在 Meta 开发者后台建一个应用，加上 Marketing API',
        '申请 ads_management 与 ads_read 权限（**要过审核**）',
        '用图形 API 浏览器换一个长期令牌，并抄下商务管理平台 id（可选）',
        '把令牌填进下面的表单——只存在这台电脑上',
      ],
      links: [
        { label: 'Meta 开发者后台', url: 'https://developers.facebook.com/apps' },
        { label: 'Marketing API 文档', url: 'https://developers.facebook.com/docs/marketing-apis' },
      ],
    },
    data_note:
      '没连也能看提案、攒审批、排计划——真正动到账户那一跳才需要它。权限还在审核里的时候，我们照实说"还没批"，不会假装改过了。',
  },
  {
    service: 'google_ads',
    upstream: 'local',
    label: 'Google Ads API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['ads_google'],
    smoke_hints: ['search_customer', 'list_campaigns'],
    fields: [
      { name: 'access_token', label: '访问令牌', secret: true, required: true, kind: 'password' },
      {
        name: 'developer_token',
        label: 'Developer token',
        secret: true,
        required: true,
        kind: 'password',
        hint: '在 Google Ads 后台的 API Center 单独申请并过审。与 OAuth 授权是两件事——缺它的时候上游回 401，但"重新连一次"解决不了',
      },
      {
        name: 'customer_id',
        label: '客户 id',
        secret: false,
        required: true,
        kind: 'text',
        placeholder: '1234567890',
        hint: '后台右上角那串十位数字，不带横杠',
      },
      {
        name: 'login_customer_id',
        label: '经理账户 id',
        secret: false,
        required: false,
        kind: 'text',
        hint: '用 MCC 管别人的账户时填；自己管自己的留空',
      },
    ],
    setup_guide: {
      summary:
        '搜索 / 购物 / PMax / YouTube 广告：读表现、改预算与出价、暂停。**三样东西缺一不可**：OAuth 令牌、developer token、客户 id。读走 GAQL，写要带 updateMask——这些我们都处理好了，你只要把三格填对。',
      steps: [
        '在 Google Cloud 建一个项目，启用 Google Ads API 并做 OAuth 授权',
        '在 Google Ads 后台 → 工具 → API Center 申请 developer token（基础访问权限够用），**等审核**',
        '抄下右上角那串十位客户 id（去掉横杠）',
        '三格填进下面的表单——只存在这台电脑上',
      ],
      links: [
        {
          label: 'Google Ads API 快速开始',
          url: 'https://developers.google.com/google-ads/api/docs/start',
        },
        { label: 'API Center（申请 developer token）', url: 'https://ads.google.com' },
      ],
    },
    data_note:
      'Merchant Center 的商品 feed 也归投放这条职责（04 §5），但那一侧还没接——现在这张卡只管广告。',
  },
  {
    service: 'x_ads',
    upstream: 'local',
    label: 'X Ads API',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['ads_x'],
    fields: [],
    setup_guide: {
      summary: '申请制：要先有广告账户、提交 Ads API 申请、说明用途、等人工审核。',
      steps: ['暂时没有步骤——这家还没接'],
      links: [{ label: 'X Ads API', url: 'https://developer.x.com/en/docs/x-ads-api' }],
    },
    planned:
      '还没接：连接目录、职责、额度与面板骨架已经就位，真调用还没做。' +
      '社媒那条买的 X API **付费档管不到广告这一侧**——是两套授权。' +
      '在此之前投放面板上 X 那一块照实说"还没接"。',
  },
  {
    service: 'tiktok_ads',
    upstream: 'local',
    label: 'TikTok Ads（Business API）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['ads_tiktok'],
    fields: [],
    setup_guide: {
      summary:
        '要先在 Business Center 里把广告账户授权给一个过了审的开发者应用；与社媒那条的 Content Posting API 是两套申请。',
      steps: ['暂时没有步骤——这家还没接'],
      links: [{ label: 'TikTok Business API', url: 'https://business-api.tiktok.com/portal/docs' }],
    },
    planned:
      '还没接：连接目录、职责、额度与面板骨架已经就位，真调用还没做。' +
      'Spark Ads（投自己发过的视频）还要有机账号那一侧再给一次授权码，' +
      '所以它接上那天要与 `social.tiktok` 一起做。',
  },
]

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
    // WP44：老的「自定义应用访问令牌（shpat_…）」那条接法已经删掉。
    // Shopify 2025 之后新建的自定义应用只在 Dev Dashboard 里给客户端 ID + 密钥；
    // 保留两条路只会让非技术用户在两张表单之间猜，而且 shpat 那串不会过期、
    // 撤销全靠人记得去后台删——权限与轮换都不如客户端凭据。
    flow: 'shopify_client_credentials',
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
  // ── WP64（51 §2.3 / §2.4）：连接器骨架 ──────────────────────────────
  //
  // 四张卡，四条都是"还没接"。目录 + 只读动作映射 + **原生表单**先立起来：
  // 凭据只能由用户自己在这台机器的表单里填进加密库，永远不经过对话——
  // 所以字段在接上真服务之前就要写死在这里，而不是等那天临时想。
  {
    service: 'klaviyo',
    upstream: 'klaviyo',
    label: 'Klaviyo（邮件营销）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['email_marketing'],
    smoke_hints: ['validate_account', 'list_campaigns', 'list_profiles'],
    fields: [
      {
        name: 'private_api_key',
        label: '私有 API Key',
        secret: true,
        required: true,
        kind: 'password',
        placeholder: 'pk_…',
        hint: 'Klaviyo 后台 Settings → API keys → Create Private API Key，只勾读权限就够',
      },
      {
        name: 'public_api_key',
        label: '站点 ID（Public API Key）',
        secret: false,
        required: false,
        kind: 'text',
        hint: '同一页上那串 6 位的站点 ID；不填也能用，填了报表里的链接能直接跳回去',
      },
    ],
    setup_guide: {
      summary:
        '分群、模板、活动效果**只读**。发送不走这条连接——群发永远是一张要人点头的卡（51 §2.3）。',
      steps: [
        '登录 Klaviyo，进 Settings → API keys',
        '点 Create Private API Key，权限选"只读"（Read-only）',
        '把这串密钥填进下面的表单——只存在这台电脑的加密库里，不上传、不进日志',
      ],
      links: [
        { label: 'Klaviyo API keys', url: 'https://www.klaviyo.com/settings/account/api-keys' },
      ],
    },
    planned:
      '还没接：连接目录、只读动作与表单已经就位，真调用还没做。' +
      '在此之前邮件营销面板的自动流与效果两块照实说"还没连"，不出编出来的数字。',
  },
  {
    service: 'shopify_email',
    upstream: 'local',
    label: 'Shopify Email（邮件营销）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['email_marketing'],
    fields: [],
    setup_guide: {
      summary: '51 §2.3 排在 Klaviyo 后面：独立站做邮件营销的多数人用 Klaviyo，先接它。',
      steps: ['暂时没有步骤——这家还没接。要现在就用邮件营销，先连 Klaviyo（也还在做）'],
      links: [{ label: 'Shopify Email', url: 'https://www.shopify.com/email-marketing' }],
    },
    planned: '待增加：先做 Klaviyo（51 §2.3 首选），这家排在它后面。',
  },
  {
    service: 'aftership',
    upstream: 'aftership',
    label: 'AfterShip（物流追踪）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['tracking'],
    smoke_hints: ['detect_couriers', 'list_couriers', 'get_tracking'],
    fields: [
      {
        name: 'api_key',
        label: 'API Key',
        secret: true,
        required: true,
        kind: 'password',
        hint: 'AfterShip 后台 Settings → API keys 里新建一把，只勾读权限',
      },
    ],
    setup_guide: {
      summary:
        '只读物流轨迹：包裹到哪了、有没有异常。**不**回写单号——单号是标记发货那条变更的事（51 §2.4）。',
      steps: [
        '登录 AfterShip，进 Settings → API keys',
        '新建一把 key，权限选只读',
        '把它填进下面的表单——只存在这台电脑的加密库里',
      ],
      links: [
        { label: 'AfterShip API keys', url: 'https://admin.aftership.com/settings/api-keys' },
      ],
    },
    planned:
      '还没接：连接目录、只读动作与表单已经就位，真调用还没做。' +
      '在此之前订单履约面板的"物流异常"那一块照实说"还没连"。',
  },
  {
    service: 'track17',
    upstream: 'local',
    label: '17TRACK（物流追踪）',
    auth: 'api_key',
    store: 'local_vault',
    data_sources: ['tracking'],
    fields: [],
    setup_guide: {
      summary: '51 §2.4 里与 AfterShip 并列，先做 AfterShip。',
      steps: ['暂时没有步骤——这家还没接'],
      links: [{ label: '17TRACK API', url: 'https://api.17track.net' }],
    },
    planned: '待增加：物流追踪先做 AfterShip，这家排在它后面。',
  },
  ...KOL_CONNECTORS,
  ...SOCIAL_CONNECTORS,
  ...ADS_CONNECTORS,
]

/**
 * WP63（51 §2.1 / §3 N2）：**登记在目录里但还没做**的连接器。
 *
 * 51 N2 定的规矩是"缺的连接器按待增加排队，本期只把职责、动作、额度、面板骨架立
 * 起来"。可是"排队"这件事得有人看得见——否则用户在连接页上找不到评价应用，
 * 只能猜我们是不是不管评价。所以它出现在目录里，**明着标成还没做**：
 * 点不动、没有表单、不发任何请求，只有一句说明与一个"它接上之后哪一块会亮"。
 *
 * 与 `available: false`（能连但这台机器现在连不了）分得开：那一个是环境问题，
 * 用户修得好；这一个是我们还没写，用户修不好。
 */
export interface PlannedConnector {
  service: string
  label: string
  /** 职责模板里的连接器 kind（`connectors[].kind`）。 */
  kind: string
  /** 接上之后哪几块工作台数据源会亮。 */
  data_sources: string[]
  /** 一句人话：这是什么、为什么还没有。 */
  note: string
}

export const PLANNED_CONNECTORS: readonly PlannedConnector[] = [
  {
    service: 'judgeme',
    label: 'Judge.me 评价',
    kind: 'reviews',
    data_sources: ['reviews'],
    note: '独立站最常用的评价应用。接上之后店铺管理岗位的差评表与邀评就有数了——现在还没做，所以面板上那一块照实说"还没连"。',
  },
  {
    service: 'loox',
    label: 'Loox 评价',
    kind: 'reviews',
    data_sources: ['reviews'],
    note: '带图评价那一派，与 Judge.me 二选一。排在 Judge.me 后面。',
  },
]

export function plannedConnector(service: string): PlannedConnector | undefined {
  return PLANNED_CONNECTORS.find((e) => e.service === service)
}

export function catalogEntry(service: string): CatalogEntry | undefined {
  return CATALOG.find((e) => e.service === service)
}

/** 上游 service → 我们的 provider id（不认识的原样返回）。 */
export function serviceOfUpstream(upstream: string): string {
  return UPSTREAM_TO_SERVICE[upstream] ?? upstream
}
