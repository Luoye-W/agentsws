/**
 * 每一家去哪个官网取 favicon（`fetch-provider-favicons.mjs` 用；WP210）。
 *
 * - 键 = 连接目录的 `service`（`apps/server/src/catalog.ts`）或模型卡的 id；文件名就是它。
 * - `domains`：**官方域名白名单**。官网页面与图标 URL 的主机都得落在这里面（等于或是子域），
 *   包括官网自己在 `<link rel=icon>` 里声明的静态资源域（例如 YouTube 的 `ytimg.com`）。
 *   **不许出现任何第三方 favicon 服务的域名。**
 * - `sources`：按顺序试；`page` 解析那一页的 `<link>`，`asset` 直接给官方资源地址
 *   （产品页是登录墙、`<link>` 给的是账号图标而不是产品图标时用，Google 那几家）。
 * - `same_as`：跟另一张卡是同一个标志（Meta 三张、TikTok 三张…），不重复存图。
 *
 * **`imap_smtp` 故意不在这里**：「任意邮箱」是协议不是一家公司，没有官网可取，
 * 用 lucide 的 `Mail`（docs/36 §8）。`PLANNED_CONNECTORS` 里那几家（还没做的）也不取——
 * 灰的、点不动的卡戴人家的官方标志，反而像「已经支持了」。
 */

const GOOGLE = ['google.com', 'gstatic.com']

export const SOURCES = {
  // ── 店铺 / 邮箱 / 分析 ─────────────────────────────────────────────────
  shopify_admin: {
    brand: 'Shopify',
    domains: ['shopify.com'],
    sources: [{ page: 'https://www.shopify.com', note: '官网首页的 apple-touch-icon' }],
  },
  shopify_email: { same_as: 'shopify_admin' },
  gmail: {
    brand: 'Gmail',
    domains: GOOGLE,
    sources: [
      // mail.google.com 会 302 到登录页，那里的 <link rel=icon> 是 Google 账号的，不是 Gmail 的
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/gmail_2020q4_64dp.png',
        page: 'https://mail.google.com',
        note: 'Google 自己的品牌资源目录（gstatic branding/product）；mail.google.com 是登录墙',
      },
    ],
  },
  ga4: {
    brand: 'Google Analytics',
    domains: GOOGLE,
    sources: [
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/google_analytics_64dp.png',
        page: 'https://analytics.google.com',
        note: 'Google 品牌资源目录；analytics.google.com 是登录墙',
      },
    ],
  },
  gsc: {
    brand: 'Google Search Console',
    domains: GOOGLE,
    sources: [
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/search_console_64dp.png',
        page: 'https://search.google.com/search-console',
        note: 'Google 品牌资源目录；与 search-console/about 页上那张是同一个标志',
      },
    ],
  },
  google_ads: {
    brand: 'Google Ads',
    domains: GOOGLE,
    sources: [
      // ads.google.com 的 <link rel=icon> 是 Google 通用的 G，不是 Google Ads 的标志
      {
        asset: 'https://www.gstatic.com/images/branding/product/2x/ads_64dp.png',
        page: 'https://ads.google.com',
        note: 'Google 品牌资源目录（gstatic branding/product）',
      },
      { page: 'https://ads.google.com/home/', note: 'Google Ads 官网介绍页 <link rel=icon>' },
    ],
  },
  google_alerts: {
    brand: 'Google 快讯',
    domains: GOOGLE,
    sources: [
      // Alerts 页面的 <link rel=icon> 只给 32px 的 G；同一个 G 的大图在 Google 自己的品牌资源目录里
      { page: 'https://www.google.com/alerts', note: 'Google Alerts 页面 <link rel=icon>' },
      {
        asset:
          'https://www.gstatic.com/images/branding/googleg/1x/googleg_standard_color_128dp.png',
        page: 'https://www.google.com/alerts',
        note: 'Alerts 页面 favicon 那个 G 的 128px 版（Google 品牌资源目录 gstatic branding/googleg）',
      },
    ],
  },
  // ── Meta 家 ───────────────────────────────────────────────────────────
  meta_ads: {
    brand: 'Meta',
    domains: ['meta.com', 'fbcdn.net', 'facebook.com'],
    sources: [
      { page: 'https://www.meta.com', note: '官网首页' },
      { page: 'https://about.meta.com', note: '公司介绍站' },
    ],
  },
  meta_graph: { same_as: 'meta_ads' },
  meta_marketing: { same_as: 'meta_ads' },
  facebook_graph: {
    brand: 'Facebook',
    domains: ['facebook.com', 'fbcdn.net'],
    sources: [{ page: 'https://www.facebook.com', note: '官网首页' }],
  },
  instagram_graph: {
    brand: 'Instagram',
    domains: ['instagram.com', 'cdninstagram.com', 'fbcdn.net'],
    sources: [{ page: 'https://www.instagram.com', note: '官网首页' }],
  },
  threads_api: {
    brand: 'Threads',
    domains: ['threads.com', 'threads.net', 'cdninstagram.com', 'fbcdn.net'],
    sources: [{ page: 'https://www.threads.com', note: '官网首页' }],
  },
  whatsapp_business: {
    brand: 'WhatsApp',
    // business.whatsapp.com 现在跳到 whatsappbusiness.com（Meta 自己的 WhatsApp Business 官网）
    domains: ['whatsapp.com', 'whatsapp.net', 'whatsappbusiness.com', 'fbcdn.net'],
    sources: [
      { page: 'https://business.whatsapp.com', note: 'WhatsApp Business 官网' },
      { page: 'https://www.whatsapp.com', note: '官网首页' },
    ],
  },
  // ── 其他社媒 / 红人渠道 ────────────────────────────────────────────────
  youtube_data: {
    brand: 'YouTube',
    domains: ['youtube.com', 'ytimg.com', 'gstatic.com'],
    sources: [{ page: 'https://www.youtube.com', note: '官网首页' }],
  },
  x_api: {
    brand: 'X',
    domains: ['x.com', 'twimg.com'],
    sources: [{ page: 'https://x.com', note: '官网首页' }],
  },
  x_ads: { same_as: 'x_api' },
  tiktok_research: {
    brand: 'TikTok',
    domains: ['tiktok.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'ttwstatic.com'],
    sources: [{ page: 'https://www.tiktok.com', note: '官网首页' }],
  },
  tiktok_content: { same_as: 'tiktok_research' },
  tiktok_ads: { same_as: 'tiktok_research' },
  linkedin_api: {
    brand: 'LinkedIn',
    domains: ['linkedin.com', 'licdn.com'],
    sources: [{ page: 'https://www.linkedin.com', note: '官网首页' }],
  },
  reddit: {
    brand: 'Reddit',
    domains: ['reddit.com', 'redditstatic.com', 'redditinc.com'],
    sources: [
      { page: 'https://www.reddit.com', note: '官网首页' },
      {
        // www.reddit.com 对无 cookie 的请求回 403，只剩一张 57px 的 apple-touch-icon；
        // 这张是 Reddit 自己静态资源域上的站点图标（新版站点 <link rel=icon> 用的就是它）
        asset: 'https://www.redditstatic.com/shreddit/assets/favicon/192x192.png',
        page: 'https://www.reddit.com',
        note: 'Reddit 官方静态资源域 redditstatic.com 上的站点图标（192px）',
      },
    ],
  },
  discord_bot: {
    brand: 'Discord',
    // 官网是 Webflow 搭的，<link rel=icon> 声明的图放在 Webflow 的静态资源域上
    domains: ['discord.com', 'website-files.com'],
    sources: [{ page: 'https://discord.com', note: '官网首页 <link rel=icon>' }],
  },
  telegram_bot: {
    brand: 'Telegram',
    domains: ['telegram.org'],
    sources: [{ page: 'https://telegram.org', note: '官网首页' }],
  },
  // ── 营销 / 物流 ───────────────────────────────────────────────────────
  klaviyo: {
    brand: 'Klaviyo',
    domains: ['klaviyo.com'],
    sources: [{ page: 'https://www.klaviyo.com', note: '官网首页' }],
  },
  aftership: {
    brand: 'AfterShip',
    // www.aftership.com 对脚本请求一律 403（Cloudflare 挑战页）；AfterShip 自己的后台登录页
    // 公开可读，<link rel=icon> 指向 AfterShip 的静态资源域 am-static.com
    domains: ['aftership.com', 'am-static.com'],
    sources: [
      { page: 'https://www.aftership.com', note: '官网首页' },
      {
        page: 'https://admin.aftership.com/',
        note: 'AfterShip 后台入口页（公开、不登录）的 <link rel=icon>',
      },
    ],
  },
  track17: {
    brand: '17TRACK',
    domains: ['17track.net', '17track.com'],
    sources: [{ page: 'https://www.17track.net/en', note: '官网首页' }],
  },
  // ── 模型卡（设置页）──────────────────────────────────────────────────
  bailian: {
    brand: '阿里云百炼',
    domains: ['aliyun.com', 'alicdn.com'],
    sources: [
      { page: 'https://bailian.console.aliyun.com/', note: '百炼控制台 <link rel=icon>' },
      { page: 'https://help.aliyun.com/zh/model-studio/', note: '百炼官方文档站' },
    ],
  },
  openai: {
    brand: 'OpenAI / ChatGPT',
    domains: ['openai.com'],
    sources: [{ page: 'https://openai.com', note: '官网首页 <link rel=icon>' }],
  },
  anthropic: {
    brand: 'Anthropic / Claude',
    // 官网是 Webflow 搭的，<link rel=icon> 声明的图放在 Webflow 的静态资源域上
    domains: ['anthropic.com', 'website-files.com'],
    sources: [{ page: 'https://www.anthropic.com', note: '官网首页 <link rel=icon>' }],
  },
  deepseek: {
    brand: 'DeepSeek',
    domains: ['deepseek.com'],
    sources: [
      // www.deepseek.com 只给 ICO；官方 API 文档站给的是同一只蓝鲸的 SVG
      { page: 'https://api-docs.deepseek.com/', note: 'DeepSeek 官方 API 文档站（矢量）' },
      { page: 'https://www.deepseek.com', note: '官网首页' },
    ],
  },
  // ── 消息渠道页（WP211）：id = 连接目录的 kind ────────────────────────
  feishu_bot: {
    brand: '飞书',
    // 官网首页是前端渲染、没有 <link rel=icon>；开放平台的图放在飞书自己的 CDN（feishucdn.com）
    domains: ['feishu.cn', 'feishucdn.com'],
    sources: [
      { page: 'https://www.feishu.cn', note: '飞书官网首页 <link rel=icon>' },
      {
        page: 'https://open.feishu.cn',
        note: '飞书开放平台 <link rel=icon>（官网首页是前端渲染，没有 <link>）',
      },
    ],
  },
  dingtalk_bot: {
    brand: '钉钉',
    // 钉钉官网的图放在阿里自己的 CDN（alicdn.com）
    domains: ['dingtalk.com', 'alicdn.com'],
    sources: [
      { page: 'https://www.dingtalk.com', note: '钉钉官网首页 <link rel=icon>' },
      { page: 'https://open.dingtalk.com', note: '兜底：钉钉开放平台 <link rel=icon>' },
    ],
  },
}
