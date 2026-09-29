/**
 * 十个岗位（docs/87 §3 第 2 屏、docs/50 岗位总表）：首页岗位墙与「岗位」页共用这一份。
 * 岗位名照 WP196：最高岗位叫「负责人」（Lead）。
 */
import type { Lang } from './common.js'

export type RoleIcon =
  | 'crown'
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
  id: string
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
    id: 'lead',
    icon: 'crown',
    name: '负责人',
    line: '每天一张日报，要拍板的都在这',
    cards: ['日报', '超授权的报价与花费', '岗位之间的交接'],
    connects: ['不用单独连，看全部岗位'],
  },
  {
    id: 'support',
    icon: 'headset',
    name: '客服',
    line: '邮件、聊天窗、Amazon 消息，先起草',
    cards: ['回信', '退款 / 补发', '改地址'],
    connects: ['客服邮箱', 'Shopify', '网站聊天窗', 'Amazon 买家消息'],
  },
  {
    id: 'kol',
    icon: 'star',
    name: '红人营销',
    line: '找人、体检、开发信，跟到交付',
    cards: ['开发信', '报价与合作条款', '内容审核'],
    connects: ['YouTube', 'Instagram', 'TikTok', 'X', 'Facebook', '浏览器插件'],
  },
  {
    id: 'social',
    icon: 'share',
    name: '社媒运营',
    line: '排内容、回评论、管社群',
    cards: ['发帖', '回评论', '社群公告'],
    connects: ['Facebook 主页', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn', 'Discord / Telegram'],
  },
  {
    id: 'b2b',
    icon: 'globe',
    name: 'B2B 外贸',
    line: '询盘分级，报价按授权走',
    cards: ['首封回信', '报价单（PDF）', '寄样通知', '业务员交接'],
    connects: ['业务邮箱', 'WhatsApp Business', '发信域名'],
    isNew: true,
  },
  {
    id: 'ads',
    icon: 'mega',
    name: '投放',
    line: '盯花费和 ROAS，越线先停',
    cards: ['调预算', '暂停广告组', '周报'],
    connects: ['Meta 广告', 'Google Ads', 'TikTok 广告', 'X 广告'],
  },
  {
    id: 'store',
    icon: 'store',
    name: '网站运营',
    line: '订单、库存、转化，异常先报',
    cards: ['改价 / 促销', '发货与履约', '邮件营销群发'],
    connects: ['Shopify', 'Search Console', 'GA4', 'Klaviyo'],
  },
  {
    id: 'site',
    icon: 'layout',
    name: '建站',
    line: '改页面、上新品，改前给你看',
    cards: ['页面改动', '上新品', '跳转与收录'],
    connects: ['Shopify'],
  },
  {
    id: 'design',
    icon: 'palette',
    name: '设计',
    line: '照你的品牌规范出图',
    cards: ['出图', '品牌规范（DESIGN.md）更新'],
    connects: ['用你的官网与品牌档案'],
  },
  {
    id: 'pr',
    icon: 'news',
    name: '公共关系',
    line: '媒体名单、稿件，口径一致',
    cards: ['媒体稿', '采访回复'],
    connects: ['业务邮箱'],
  },
]

const en: Role[] = [
  {
    id: 'lead',
    icon: 'crown',
    name: 'Lead',
    line: 'A daily brief; every decision in one place',
    cards: ['Daily brief', 'Over-limit quotes and spend', 'Handoffs between roles'],
    connects: ['Nothing to connect — sees every role'],
  },
  {
    id: 'support',
    icon: 'headset',
    name: 'Support',
    line: 'Email, chat, Amazon messages — drafted first',
    cards: ['Replies', 'Refunds / reships', 'Address changes'],
    connects: ['Support mailbox', 'Shopify', 'Website chat', 'Amazon buyer messages'],
  },
  {
    id: 'kol',
    icon: 'star',
    name: 'Influencers',
    line: 'Find, vet, pitch, follow through',
    cards: ['Pitches', 'Quotes and terms', 'Content review'],
    connects: ['YouTube', 'Instagram', 'TikTok', 'X', 'Facebook', 'Browser extension'],
  },
  {
    id: 'social',
    icon: 'share',
    name: 'Social',
    line: 'Plan posts, reply, run communities',
    cards: ['Posts', 'Comment replies', 'Community announcements'],
    connects: ['Facebook Page', 'Instagram', 'TikTok', 'YouTube', 'LinkedIn', 'Discord / Telegram'],
  },
  {
    id: 'b2b',
    icon: 'globe',
    name: 'B2B',
    line: 'Grade inquiries; quotes follow your limits',
    cards: ['First replies', 'Quotes (PDF)', 'Sample notices', 'Rep handovers'],
    connects: ['Sales mailbox', 'WhatsApp Business', 'Sending domain'],
    isNew: true,
  },
  {
    id: 'ads',
    icon: 'mega',
    name: 'Ads',
    line: 'Watch spend and ROAS; pause when it crosses the line',
    cards: ['Budget changes', 'Pause ad sets', 'Weekly report'],
    connects: ['Meta Ads', 'Google Ads', 'TikTok Ads', 'X Ads'],
  },
  {
    id: 'store',
    icon: 'store',
    name: 'Store ops',
    line: 'Orders, stock, conversion; flags anomalies',
    cards: ['Price / promo changes', 'Fulfilment', 'Email campaigns'],
    connects: ['Shopify', 'Search Console', 'GA4', 'Klaviyo'],
  },
  {
    id: 'site',
    icon: 'layout',
    name: 'Site builder',
    line: 'Edits pages, launches products — shows you first',
    cards: ['Page edits', 'Product launches', 'Redirects and indexing'],
    connects: ['Shopify'],
  },
  {
    id: 'design',
    icon: 'palette',
    name: 'Design',
    line: 'On-brand, from your brand spec',
    cards: ['Images', 'Brand spec (DESIGN.md) updates'],
    connects: ['Your website and brand profile'],
  },
  {
    id: 'pr',
    icon: 'news',
    name: 'PR',
    line: 'Media lists, pitches, one voice',
    cards: ['Press pitches', 'Interview replies'],
    connects: ['Sales mailbox'],
  },
]

export const ROLES: Record<Lang, Role[]> = { zh, en }

/** 岗位页的文案。 */
const pageZh = {
  meta: {
    title: '岗位 · Agents 工坊',
    description:
      '负责人、客服、红人营销、社媒、B2B 外贸、投放、网站运营、建站、设计、公共关系：十个岗位各管一摊，要紧的事先出卡给你批。',
  },
  eyebrow: '岗位',
  title: '十个岗位，各管一摊。',
  sub: '每个岗位有自己的职责、记忆和权限。要发出去、要花钱的，先出一张卡。',
  status: '客服、红人营销、B2B 外贸最完整；其余岗位在内测里一个个打磨，进度都写在更新日志里。',
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
      'Lead, Support, Influencers, Social, B2B, Ads, Store ops, Site builder, Design, PR: ten roles, each owning its lane — and anything that matters becomes a card for you first.',
  },
  eyebrow: 'Roles',
  title: 'Ten roles, each owning its lane.',
  sub: 'Every role has its own duties, memory and permissions. Anything that goes out or costs money becomes a card first.',
  status:
    'Support, Influencers and B2B are the most complete; the rest are being polished one by one during the beta — progress is in the changelog.',
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
