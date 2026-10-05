/**
 * WP220：研究技能（`trend-research` 给公共关系、`social-research` 给社媒运营）**能从哪取数**——白名单。
 *
 * 两份上游（last30days-skill、social-media-research-skills，都是 MIT）的方法论我们留着，
 * 取数层整个换掉：上游直接抓 Reddit 公开 JSON / 页面、拿浏览器 cookie 调 X 的内部接口、
 * 调第三方抓取服务——这些一条都不进来。我们只认下面这张表里的口：
 *
 * | 路 | 是什么 | 谁付钱 |
 * |---|---|---|
 * | `web_search` / `web_fetch` | 官方网页工具（WP179，DeepSeek 原生搜索 + 抓公开网页） | 用户的 DeepSeek 账号 |
 * | `workshop` | 接口中台（WP192 能力目录） | 积分 |
 * | `browser_readonly` | 本机浏览器只读（只给 Reddit，Luoye 10-05） | 不扣积分 |
 * | `official_api` | 品牌自己连上的平台官方接口（连接页那张卡） | 平台配额 |
 *
 * `status: 'pending'` 的行是**要接而还没接**的能力：技能遇到就照实说「这一路还没接」，
 * 报告里列成「接口管理待接能力清单」交云端那一侧（不在本单接）。
 */
import type { ResearchFetchRoute } from '@agentsws/contracts'

/** 研究会碰到的平台（`web` = 新闻、博客、论坛等一般网页）。 */
export type ResearchPlatform =
  | 'web'
  | 'reddit'
  | 'x'
  | 'youtube'
  | 'tiktok'
  | 'instagram'
  | 'facebook'
  | 'linkedin'
  | 'threads'
  | 'hacker_news'
  | 'ad_library'
  /** WP220（Luoye 10-05）：「这周什么在起来」只做营销用的两样免费公开来源（不做选品）。 */
  | 'google_trends'
  | 'tiktok_creative_center'

export interface ResearchSource {
  platform: ResearchPlatform
  route: ResearchFetchRoute
  /** 能力名：接口中台那一路是目录里的 id；网页工具是 `web.search` / `web.fetch`；官方接口是连接卡的 kind。 */
  capability: string
  /** 能干什么（给人看的一句）。 */
  what: string
  /** `ready` = 现在就能用；`pending` = 要接，还没接（进待接清单）。 */
  status: 'ready' | 'pending'
  /** `pending` 的那几行：谁来接、接的时候要注意什么。 */
  note?: string
}

/** **只可加行**。表里没有的取数方式就是不许用的。 */
export const RESEARCH_SOURCES: readonly ResearchSource[] = [
  // ── 一般网页（新闻、博客、论坛、评测）──
  {
    platform: 'web',
    route: 'web_search',
    capability: 'web.search',
    what: '搜公开网页与新闻',
    status: 'ready',
  },
  {
    platform: 'web',
    route: 'web_fetch',
    capability: 'web.fetch',
    what: '打开一篇公开网页细看',
    status: 'ready',
  },
  {
    platform: 'web',
    route: 'workshop',
    capability: 'serp.google',
    what: 'Google 搜索结果页（按时间、按国家）',
    status: 'ready',
  },
  // ── Reddit：两路（Luoye 10-05）──
  {
    platform: 'reddit',
    route: 'workshop',
    capability: 'social.reddit.search',
    what: '按关键词搜帖子（全站或指定版）',
    status: 'pending',
    note: '开源契约已加能力名与输入白名单；云端渠道待接（接上之前路由自动落到浏览器只读）',
  },
  {
    platform: 'reddit',
    route: 'workshop',
    capability: 'social.reddit.posts',
    what: '读一个版里最近的帖子',
    status: 'pending',
    note: '同上',
  },
  {
    platform: 'reddit',
    route: 'workshop',
    capability: 'social.reddit.comments',
    what: '读一条帖子下的评论',
    status: 'pending',
    note: '同上',
  },
  {
    platform: 'reddit',
    route: 'browser_readonly',
    capability: 'reddit.read',
    what: '本机浏览器只读打开 Reddit 页面（单独的只读会话、限速）',
    status: 'ready',
  },
  // ── 「这周什么在起来」（Luoye 10-05：只做营销用的；免费公开来源；选品类付费数据不做）──
  {
    platform: 'google_trends',
    route: 'web_fetch',
    capability: 'web.fetch',
    what: '打开 Google Trends 的公开页面看热度走势与上升的相关搜索（页面靠脚本渲染，常常抓不全）',
    status: 'ready',
  },
  {
    platform: 'tiktok_creative_center',
    route: 'web_fetch',
    capability: 'web.fetch',
    what: '打开 TikTok Creative Center 的公开榜单（热门话题、声音、标签）',
    status: 'ready',
  },
  {
    platform: 'google_trends',
    route: 'workshop',
    capability: 'trends.google',
    what: 'Google Trends 结构化数据（关键词热度、上升的相关搜索，按国家 / 时间）',
    status: 'pending',
    note: '网页抓取常抓不全，结构化的走接口中台更稳',
  },
  {
    platform: 'tiktok_creative_center',
    route: 'workshop',
    capability: 'trends.tiktok_creative_center',
    what: 'TikTok Creative Center 榜单结构化数据（话题 / 声音 / 标签，按国家、行业、时间）',
    status: 'pending',
  },
  // ── 已在能力目录里的社媒 ──
  {
    platform: 'instagram',
    route: 'workshop',
    capability: 'social.instagram.posts',
    what: '账号最近的公开帖子',
    status: 'ready',
  },
  {
    platform: 'instagram',
    route: 'workshop',
    capability: 'social.instagram.profile',
    what: '账号公开主页',
    status: 'ready',
  },
  {
    platform: 'tiktok',
    route: 'workshop',
    capability: 'social.tiktok.posts',
    what: '账号最近的公开视频',
    status: 'ready',
  },
  {
    platform: 'tiktok',
    route: 'workshop',
    capability: 'social.tiktok.profile',
    what: '账号公开主页',
    status: 'ready',
  },
  // ── 品牌自己连上的官方接口（有授权时）──
  {
    platform: 'youtube',
    route: 'official_api',
    capability: 'youtube_data',
    what: '搜视频、读频道视频与评论（YouTube Data API）',
    status: 'ready',
  },
  {
    platform: 'x',
    route: 'official_api',
    capability: 'x_api',
    what: '搜近 7 天的帖子、读账号帖子（X API，看品牌开通的档位）',
    status: 'ready',
  },
  {
    platform: 'tiktok',
    route: 'official_api',
    capability: 'tiktok_research',
    what: 'TikTok Research API（要平台批准）',
    status: 'ready',
  },
  {
    platform: 'instagram',
    route: 'official_api',
    capability: 'instagram_graph',
    what: '自家账号的帖子与评论',
    status: 'ready',
  },
  {
    platform: 'facebook',
    route: 'official_api',
    capability: 'facebook_graph',
    what: '自家主页的帖子与评论',
    status: 'ready',
  },
  // ── 要接而还没接的（进待接清单）──
  {
    platform: 'x',
    route: 'workshop',
    capability: 'social.x.search',
    what: '按关键词搜 X 帖子（带互动数），不要求品牌自己开 X API',
    status: 'pending',
    note: '上游用 cookie 调 X 内部接口或第三方，我们不走；云端走有授权的渠道',
  },
  {
    platform: 'youtube',
    route: 'workshop',
    capability: 'social.youtube.search',
    what: '按关键词搜视频、读评论与字幕（品牌没连 YouTube key 时）',
    status: 'pending',
  },
  {
    platform: 'tiktok',
    route: 'workshop',
    capability: 'social.tiktok.search',
    what: '按关键词 / 话题搜视频（现在只能按账号取）',
    status: 'pending',
  },
  {
    platform: 'instagram',
    route: 'workshop',
    capability: 'social.instagram.search',
    what: '按话题标签 / 关键词搜帖子（现在只能按账号取）',
    status: 'pending',
  },
  {
    platform: 'tiktok',
    route: 'workshop',
    capability: 'social.tiktok.comments',
    what: '读一条视频下的评论（评论挖掘用）',
    status: 'pending',
  },
  {
    platform: 'instagram',
    route: 'workshop',
    capability: 'social.instagram.comments',
    what: '读一条帖子下的评论（评论挖掘用）',
    status: 'pending',
  },
  {
    platform: 'linkedin',
    route: 'workshop',
    capability: 'social.linkedin.posts',
    what: '公司主页最近的公开帖子（竞品拆解用）',
    status: 'pending',
  },
  {
    platform: 'threads',
    route: 'workshop',
    capability: 'social.threads.posts',
    what: '账号最近的公开帖子',
    status: 'pending',
  },
  {
    platform: 'ad_library',
    route: 'workshop',
    capability: 'ads.meta_library',
    what: 'Meta 广告库：某个品牌在投的广告（文案、开始日期、素材）',
    status: 'pending',
    note: 'Meta 有官方 Ad Library API，可走官方',
  },
  {
    platform: 'ad_library',
    route: 'workshop',
    capability: 'ads.google_transparency',
    what: 'Google 广告透明度中心：某个品牌在投的广告',
    status: 'pending',
  },
  {
    platform: 'hacker_news',
    route: 'workshop',
    capability: 'web.hacker_news.search',
    what: 'Hacker News 讨论（有公开的官方搜索接口）',
    status: 'pending',
    note: '量小、主要给科技品牌；不急',
  },
]

/**
 * 这一路这项能力**许不许用**（在白名单里就许，不管接没接好——合规看这一格）。
 * 接好没有另看 {@link researchSourceReady}：没接好的照样可以试，云上会回「还没开通」，照实记。
 */
export function researchSourceAllowed(route: ResearchFetchRoute, capability: string): boolean {
  return RESEARCH_SOURCES.some((s) => s.route === route && s.capability === capability)
}

/** 这一路这项能力现在接好了没有。 */
export function researchSourceReady(route: ResearchFetchRoute, capability: string): boolean {
  return RESEARCH_SOURCES.some(
    (s) => s.route === route && s.capability === capability && s.status === 'ready',
  )
}

/** 某个平台现在能走哪几路（按表里的顺序）。 */
export function researchSourcesOf(platform: ResearchPlatform): ResearchSource[] {
  return RESEARCH_SOURCES.filter((s) => s.platform === platform)
}

/** 接口管理待接能力清单（交云端那一侧）。 */
export function pendingResearchCapabilities(): ResearchSource[] {
  return RESEARCH_SOURCES.filter((s) => s.status === 'pending')
}
