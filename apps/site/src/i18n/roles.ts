/**
 * 十个出厂岗位（`packages/roles/positions/*.yml`，名字照那里的中英 name）：首页岗位墙与「岗位」页共用这一份。
 * WP344：负责人自 WP234 起是身份标记、不是工作岗位，岗位墙不再列；`dtc-ops` 已拆成网站运营与客服（SUPERSEDED），也不列。
 * 每个岗位一句话 + 会出的卡 + 要连什么，只写 10-15 已合进 main 的能力。
 */
import type { Lang } from './common.js'

export type RoleIcon =
  | 'headset'
  | 'star'
  | 'share'
  | 'globe'
  | 'mega'
  | 'store'
  | 'layout'
  | 'palette'
  | 'news'

export interface Role {
  /** 页内锚点（`/roles/#support`），沿用 WP197 的叫法，别改——外面可能有人链过来。 */
  id: string
  /** 对应的出厂岗位（`packages/roles/positions/<position>.yml`），测试拿它对名字。 */
  position: string
  icon: RoleIcon
  name: string
  line: string
  /** 它会出哪几种卡（等你点头的）。 */
  cards: string[]
  /** 要连什么。 */
  connects: string[]
  isNew?: boolean
}

const zh: Role[] = [
  {
    id: 'support',
    position: 'customer-care',
    icon: 'headset',
    name: '客服',
    line: '邮件、网站聊天、Amazon 消息，先起草再给你发',
    cards: ['回信', '退款 / 补发', '改地址', '催一下（对方没回）'],
    connects: ['客服邮箱', 'Shopify', '网站聊天窗', 'Amazon 买家消息'],
  },
  {
    id: 'kol',
    position: 'kol-marketing',
    icon: 'star',
    name: '红人营销',
    line: '找红人、打分、写建联信，跟到交付',
    cards: ['建联信', '报价与合作条款', '内容审核'],
    connects: ['YouTube', 'Instagram', 'TikTok', '浏览器插件'],
  },
  {
    id: 'social',
    position: 'social-media',
    icon: 'share',
    name: '社媒运营',
    line: '排内容、回评论；Reddit 收件箱和版块天天巡查',
    cards: ['发帖', '回评论', 'Reddit 回帖（插件里填好，你点发送）'],
    connects: ['TikTok', 'YouTube', 'Facebook', 'Instagram', 'Reddit（插件 + 你的登录）'],
    isNew: true,
  },
  {
    id: 'store',
    position: 'web-ops',
    icon: 'store',
    name: '网站运营',
    line: '商品、促销、邮件；SEO 与 GEO 每周体检，盯着 AI 怎么回答你的品类',
    cards: ['改价 / 促销', '邮件营销群发', '发货与履约', '技术体检要改的（交给建站）'],
    connects: ['Shopify', 'Search Console', 'GA4', 'Klaviyo'],
    isNew: true,
  },
  {
    id: 'amazon',
    position: 'amazon-ops',
    icon: 'store',
    name: 'Amazon 运营',
    line: '只在你卖 Amazon 时出现：Listing 体检、关键词差距、盯竞品对标款',
    cards: ['竞品监控方案', '向设计岗提图片需求'],
    connects: ['桌面版内置浏览器（读 Amazon 前台）'],
    isNew: true,
  },
  {
    id: 'ads',
    position: 'ads',
    icon: 'mega',
    name: '投放',
    line: 'Google / Meta 广告：盯花费、写新素材，改动先预览',
    cards: ['止损暂停', '新标题与描述', '上传表（预览后再提交）'],
    connects: [
      'Google Ads',
      'Meta 广告',
      '浏览器插件（你的登录）',
      'Microsoft、Pinterest、Reddit、LinkedIn、Snapchat、Apple 广告（拖进后台导出的报表）',
    ],
  },
  {
    id: 'site',
    position: 'site',
    icon: 'layout',
    name: '建站',
    line: '在 Shopify 上搭页面、换主题，改前给你看',
    cards: ['选主题', '页面改动', '上线检查'],
    connects: ['Shopify（浏览器里授权）'],
  },
  {
    id: 'b2b',
    position: 'b2b',
    icon: 'globe',
    name: 'B2B',
    line: '询盘分级，报价按授权走，跟到出货',
    cards: ['首封回信', '报价单（PDF）', '寄样通知', '业务员交接'],
    connects: ['业务邮箱', 'WhatsApp Business', '发信域名'],
  },
  {
    id: 'pr',
    position: 'pr',
    icon: 'news',
    name: '公共关系',
    line: '新闻稿、论坛露出、全网提及与负面预警',
    cards: ['媒体稿', '论坛回帖', '负面预警'],
    connects: ['业务邮箱', 'Reddit 与论坛的公开内容'],
  },
  {
    id: 'design',
    position: 'design',
    icon: 'palette',
    name: '设计',
    line: '照你的品牌规范出图：网站、Amazon、社媒、广告',
    cards: ['出图', '广告素材批量出图'],
    connects: ['你的官网与品牌档案'],
  },
]

const en: Role[] = [
  {
    id: 'support',
    position: 'customer-care',
    icon: 'headset',
    name: 'Customer Care',
    line: 'Email, site chat, Amazon messages — drafted for you to send',
    cards: ['Replies', 'Refunds / reships', 'Address changes', 'Follow-ups (no reply yet)'],
    connects: ['Support mailbox', 'Shopify', 'Website chat', 'Amazon buyer messages'],
  },
  {
    id: 'kol',
    position: 'kol-marketing',
    icon: 'star',
    name: 'Creator Marketing',
    line: 'Find and score creators, pitch, follow through',
    cards: ['Pitches', 'Quotes and terms', 'Content review'],
    connects: ['YouTube', 'Instagram', 'TikTok', 'Browser extension'],
  },
  {
    id: 'social',
    position: 'social-media',
    icon: 'share',
    name: 'Social Media',
    line: 'Plan posts, reply; checks your Reddit inbox and subreddits daily',
    cards: [
      'Posts',
      'Comment replies',
      'Reddit replies (filled in by the extension, you hit send)',
    ],
    connects: ['TikTok', 'YouTube', 'Facebook', 'Instagram', 'Reddit (extension + your login)'],
    isNew: true,
  },
  {
    id: 'store',
    position: 'web-ops',
    icon: 'store',
    name: 'Web Operations',
    line: 'Products, promos, email; a weekly SEO & GEO health check, and how AI answers about your category',
    cards: [
      'Price / promo changes',
      'Email campaigns',
      'Fulfilment',
      'Health-check fixes (to Site Building)',
    ],
    connects: ['Shopify', 'Search Console', 'GA4', 'Klaviyo'],
    isNew: true,
  },
  {
    id: 'amazon',
    position: 'amazon-ops',
    icon: 'store',
    name: 'Amazon Operations',
    line: 'Shows up only if you sell on Amazon: listing check-ups, keyword gaps, competitor ASIN watch',
    cards: ['Competitor watch plan', 'Image requests to Design'],
    connects: ['Built-in browser in the desktop app (reads Amazon storefront pages)'],
    isNew: true,
  },
  {
    id: 'ads',
    position: 'ads',
    icon: 'mega',
    name: 'Paid Ads',
    line: 'Google and Meta: watch spend, write new copy, preview every change',
    cards: ['Stop-loss pauses', 'New headlines and descriptions', 'Upload sheets (preview first)'],
    connects: [
      'Google Ads',
      'Meta Ads',
      'Browser extension (your login)',
      'Microsoft, Pinterest, Reddit, LinkedIn, Snapchat and Apple Ads (drop in the exported reports)',
    ],
  },
  {
    id: 'site',
    position: 'site',
    icon: 'layout',
    name: 'Site Building',
    line: 'Builds pages and switches themes on Shopify — shows you first',
    cards: ['Theme choice', 'Page edits', 'Launch checklist'],
    connects: ['Shopify (authorise in the browser)'],
  },
  {
    id: 'b2b',
    position: 'b2b',
    icon: 'globe',
    name: 'B2B',
    line: 'Grade inquiries, quote within your limits, follow orders through',
    cards: ['First replies', 'Quotes (PDF)', 'Sample notices', 'Rep handovers'],
    connects: ['Sales mailbox', 'WhatsApp Business', 'Sending domain'],
  },
  {
    id: 'pr',
    position: 'pr',
    icon: 'news',
    name: 'Public Relations',
    line: 'Press releases, forum presence, mentions and early warnings',
    cards: ['Press pitches', 'Forum replies', 'Negative-mention alerts'],
    connects: ['Sales mailbox', 'Public Reddit and forum posts'],
  },
  {
    id: 'design',
    position: 'design',
    icon: 'palette',
    name: 'Design',
    line: 'On-brand images for your site, Amazon, social and ads',
    cards: ['Images', 'Ad creative in batches'],
    connects: ['Your website and brand profile'],
  },
]

export const ROLES: Record<Lang, Role[]> = { zh, en }

/** 岗位页的文案。 */
const pageZh = {
  meta: {
    title: '岗位 · Agents 工坊',
    description:
      '客服、红人营销、社媒运营、网站运营、Amazon 运营、投放、建站、B2B、公共关系、设计：十个岗位各管一摊，要拍板的事先出卡给你批。',
  },
  eyebrow: '岗位',
  title: '十个岗位，各管一摊。',
  sub: '每个岗位有自己的职责、记忆和权限。要发出去、要花钱的，先出一张卡。',
  status: '都在内测中，一个个打磨；进度写在更新日志里。',
  cardsLabel: '会出的卡',
  connectsLabel: '要连什么',
  featured: '在工作台里长这样',
  custom: {
    title: '岗位不够用？自己建一个。',
    sub: '在公司页新建岗位，勾上它要管的职责；名字也能改成你们公司的叫法。',
  },
  cta: '免费下载',
  docs: '看连接教程',
}

export type RolesPageCopy = typeof pageZh

const pageEn: RolesPageCopy = {
  meta: {
    title: 'Roles · Agents Workshop',
    description:
      'Customer Care, Creator Marketing, Social Media, Web Operations, Amazon Operations, Paid Ads, Site Building, B2B, Public Relations, Design: ten roles, each owning its lane — anything that needs your call becomes a card first.',
  },
  eyebrow: 'Roles',
  title: 'Ten roles, each owning its lane.',
  sub: 'Every role has its own duties, memory and permissions. Anything that goes out or costs money becomes a card first.',
  status: 'All in beta and being polished one by one — progress is in the changelog.',
  cardsLabel: 'Cards it hands you',
  connectsLabel: 'What it connects to',
  featured: 'What it looks like in the app',
  custom: {
    title: 'Need something else? Create your own role.',
    sub: 'Add a role on the Company page and tick the duties it owns. Rename any role to match how your company talks.',
  },
  cta: 'Download free',
  docs: 'Connection guides',
}

export const ROLES_PAGE: Record<Lang, RolesPageCopy> = { zh: pageZh, en: pageEn }
