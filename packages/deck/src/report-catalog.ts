/**
 * WP438（WP434 设计 §3.6，决策 1334）：**每个岗位默认固定的几份报表**，以及「跟 AI 说想看什么」时
 * 能拼出来的几种小报表（{@link REPORT_RECIPES}）。
 *
 * 默认报表写在这里（岗位模板之外的一张表），因为它们只引用指标表与数据集——加一份、改一块都不碰岗位 yml。
 * 职责层只出和那条职责有关的那一两份（`duties`）。
 */
import type { ReportAction, ReportBlockSpec, ReportRange, ReportSpec } from './reports.js'

const daily = (
  spec: Omit<ReportSpec, 'origin' | 'refresh' | 'default_range'> & { default_range?: ReportRange },
): ReportSpec => ({
  origin: 'default',
  refresh: 'daily',
  default_range: '30d',
  ...spec,
})

const ASK_CHECKOUT: ReportAction = {
  label: '查结账掉单原因',
  prompt: '查一下最近进了结账却没下单的人为什么走了，按设备和步骤拆开看',
}

/** 网站运营 4 份 + 客服 2 份 + Reddit 运营报表 + 社媒 / 红人 / 投放 / B2B 各 1 份。 */
export const DEFAULT_REPORTS: readonly ReportSpec[] = [
  // ── 网站运营 ──────────────────────────────────────────────
  daily({
    id: 'web-ops.business',
    title: '网站经营数据报表',
    position: 'web-ops',
    duties: ['dtc.store'],
    compute_roles: ['dtc.store', 'common.owner', 'dtc.seo', 'dtc.content', 'dtc.fulfillment'],
    headline: 'sales',
    watch: ['sales', 'orders', 'aov', 'conversion', 'new_share'],
    actions: {
      conversion: ASK_CHECKOUT,
      orders: { label: '查订单为什么少了', prompt: '查一下这段时间订单为什么变少了' },
      sales: { label: '查销售额为什么掉', prompt: '查一下这段时间销售额为什么掉了' },
      aov: { label: '看看怎么提客单价', prompt: '看看最近客单价为什么低了，给几个提客单价的办法' },
    },
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['sales', 'orders', 'aov', 'conversion', 'visitors', 'new_share'],
      },
      {
        id: 'trend',
        kind: 'trend',
        title: '每天销售额',
        subtitle: '虚线是上一段同一天；蓝点是这段时间里工坊替你做过的事',
        metric: 'sales',
        events: true,
        wide: true,
      },
      {
        id: 'order-sources',
        kind: 'rank',
        title: '订单从哪来',
        subtitle: '订单数 · 这一路来的销售额',
        dataset: 'shop.order_sources',
      },
      {
        id: 'funnel',
        kind: 'funnel',
        title: '从进店到下单',
        subtitle: '每一步留下来的比例',
        dataset: 'ga4.funnel',
      },
      {
        id: 'products',
        kind: 'table',
        title: '卖得最好的商品',
        subtitle: '这一段',
        dataset: 'shop.top_products',
      },
      {
        id: 'queries',
        kind: 'table',
        title: '搜索带来的',
        subtitle: '点击最多的搜索词',
        dataset: 'gsc.queries',
      },
      {
        id: 'new-returning',
        kind: 'stacked',
        title: '新客和老客',
        subtitle: '每周订单数',
        dataset: 'shop.new_vs_returning',
      },
      {
        id: 'ads',
        kind: 'table',
        title: '广告花费与回报',
        subtitle: '花费 · 广告回报（ROAS）· 新客成本',
        dataset: 'ads.overview',
      },
    ],
  }),
  daily({
    id: 'web-ops.traffic',
    title: '流量报表',
    position: 'web-ops',
    duties: ['dtc.store', 'dtc.seo'],
    compute_roles: ['dtc.store', 'dtc.seo', 'common.owner'],
    headline: 'visitors',
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['visitors', 'sessions', 'conversion', 'orders', 'ai_orders'],
      },
      {
        id: 'trend',
        kind: 'trend',
        title: '每天订单',
        subtitle: '虚线是上一段同一天；蓝点是这段时间里工坊替你做过的事',
        metric: 'orders',
        events: true,
        wide: true,
      },
      {
        id: 'order-sources',
        kind: 'rank',
        title: '订单从哪来',
        subtitle: '订单数 · 这一路来的销售额',
        dataset: 'shop.order_sources',
      },
      {
        id: 'pages',
        kind: 'rank',
        title: '搜索点进来最多的页面',
        subtitle: '自然搜索点击',
        dataset: 'gsc.pages',
      },
      {
        id: 'funnel',
        kind: 'funnel',
        title: '从进店到下单',
        subtitle: '每一步留下来的比例',
        dataset: 'ga4.funnel',
        wide: true,
      },
    ],
  }),
  daily({
    id: 'web-ops.seo',
    title: 'SEO 与 AI 搜索',
    position: 'web-ops',
    duties: ['dtc.seo'],
    compute_roles: ['dtc.seo', 'dtc.store', 'common.owner'],
    headline: 'gsc_clicks',
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['gsc_clicks', 'gsc_impressions', 'gsc_ctr', 'gsc_position', 'ai_orders'],
      },
      {
        id: 'search-ai',
        kind: 'bars',
        title: '搜索和 AI 回答带来的订单',
        subtitle: '柱是自然搜索，线是从 AI 回答里点进来的',
        dataset: 'shop.ai_orders_daily',
        wide: true,
      },
      {
        id: 'queries',
        kind: 'table',
        title: '搜索词',
        subtitle: '点击最多的几个',
        dataset: 'gsc.queries',
      },
      {
        id: 'pages',
        kind: 'rank',
        title: '落地页',
        subtitle: '自然搜索点击',
        dataset: 'gsc.pages',
      },
      {
        id: 'geo',
        kind: 'table',
        title: 'AI 回答里有没有我们',
        subtitle: '买家会问的问题 · 提到或引用我们',
        dataset: 'seo.geo_visibility',
        wide: true,
      },
      // WP448（docs/109 §4.4、§5.1）：技术体检、改版回归、抢词——只列有问题的
      {
        id: 'tech',
        kind: 'table',
        title: '技术体检',
        subtitle: '只列有问题的 · 要改的交给建站',
        dataset: 'site.tech_audit',
        wide: true,
      },
      {
        id: 'drift',
        kind: 'table',
        title: '改版回归',
        subtitle: '主题发布、装卸 App 之后和上一次比',
        dataset: 'site.drift',
        wide: true,
      },
      {
        id: 'cannibalization',
        kind: 'table',
        title: '两页抢同一组词',
        subtitle: '每周一次 · 严重的进今天值得动的 5 件事',
        dataset: 'seo.cannibalization',
        wide: true,
      },
    ],
  }),
  daily({
    id: 'web-ops.email',
    title: '邮件营销报表',
    position: 'web-ops',
    duties: ['dtc.email-marketing'],
    compute_roles: ['dtc.email-marketing', 'dtc.store', 'common.owner'],
    headline: 'email_sales',
    headline_label: '邮件带来',
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['email_sales', 'email_orders', 'returning_orders', 'returning_sales'],
      },
      {
        id: 'email-weekly',
        kind: 'bars',
        title: '邮件每周带来的销售额',
        subtitle: '按进店来源认（店铺后台）',
        dataset: 'shop.email_weekly',
        wide: true,
      },
      {
        id: 'campaigns',
        kind: 'table',
        title: '最近的活动',
        subtitle: '打开率 · 点击率 · 带来的收入',
        dataset: 'email.campaigns',
      },
      {
        id: 'flows',
        kind: 'table',
        title: '自动流程',
        subtitle: '欢迎信、弃购提醒这些',
        dataset: 'email.flows',
      },
    ],
  }),
  // ── 客服 ──────────────────────────────────────────────────
  daily({
    id: 'customer-care.service',
    title: '服务体验报表',
    position: 'customer-care',
    duties: ['dtc.support', 'dtc.live-chat'],
    compute_roles: ['dtc.support', 'dtc.live-chat', 'amz.support'],
    headline: 'reply_rate_24h',
    headline_label: '24 小时内回复',
    watch: ['reply_rate_24h', 'pending_replies', 'refund_requests'],
    actions: {
      reply_rate_24h: {
        label: '看看哪几封回慢了',
        prompt: '把最近超过 24 小时才回的那几封信列出来',
      },
      pending_replies: { label: '先回压着的', prompt: '把现在还压着没回的信按急的排一下' },
    },
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['reply_rate_24h', 'pending_replies', 'drafts', 'refund_requests', 'csat'],
      },
      {
        id: 'daily',
        kind: 'bars',
        title: '每天进来多少、回出去多少',
        subtitle: '同一个单位（封），一根轴',
        dataset: 'support.daily',
        wide: true,
      },
      {
        id: 'kinds',
        kind: 'rank',
        title: '都是些什么事',
        subtitle: '按种类',
        dataset: 'support.kinds',
      },
      {
        id: 'handling',
        kind: 'share',
        title: '谁处理的',
        subtitle: 'AI 自己处理 / 你点了通过 / 你改过再发',
        dataset: 'support.handling',
      },
    ],
  }),
  daily({
    id: 'customer-care.ai',
    title: 'AI 处理情况',
    position: 'customer-care',
    duties: ['dtc.support', 'dtc.live-chat'],
    compute_roles: ['dtc.support', 'dtc.live-chat'],
    headline: 'auto_share',
    blocks: [
      { id: 'kpis', kind: 'kpis', metrics: ['auto_share', 'drafts', 'reply_rate_24h'] },
      {
        id: 'handling',
        kind: 'share',
        title: '谁处理的',
        subtitle: 'AI 自己处理 / 你点了通过 / 你改过再发',
        dataset: 'support.handling',
        wide: true,
      },
    ],
  }),
  // ── Reddit 运营 / 公共关系 ─────────────────────────────────
  daily({
    id: 'pr.reddit',
    title: 'Reddit 运营报表',
    position: 'pr',
    duties: ['pr.reddit', 'pr.monitoring', 'social.reddit'],
    compute_roles: ['pr.reddit', 'pr.monitoring', 'pr.forums', 'social.reddit'],
    headline: 'mentions',
    headline_label: '近 30 天品牌被提到',
    watch: ['mentions', 'our_replies', 'positive_share', 'negative_mentions'],
    actions: {
      negative_mentions: {
        label: '去回负面的',
        prompt: '把这段时间说我们不好的帖子列出来，挑要回的起草回复',
      },
      our_replies: { label: '挑几条去回', prompt: '挑几条提到我们、值得回的帖子起草回复' },
    },
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['mentions', 'our_replies', 'reply_votes', 'positive_share', 'negative_mentions'],
      },
      {
        id: 'daily',
        kind: 'bars',
        title: '每天被提到几次，我们回了几次',
        subtitle: '同一个单位（帖数），一根轴',
        dataset: 'pr.daily',
        wide: true,
      },
      {
        id: 'venues',
        kind: 'rank',
        title: '在哪些版块被聊到',
        subtitle: '提及次数 · 我们回了几帖',
        dataset: 'pr.venues',
      },
      {
        id: 'sentiment',
        kind: 'share',
        title: '大家怎么说',
        subtitle: '这一段提及的情绪',
        dataset: 'pr.sentiment',
      },
      {
        id: 'top-posts',
        kind: 'table',
        title: '我们回得最好的帖子',
        subtitle: '按赞数',
        dataset: 'pr.top_posts',
      },
      {
        id: 'offsite',
        kind: 'table',
        title: '站外提到我们',
        subtitle: '新闻、博客、论坛（Reddit 以外）',
        dataset: 'pr.offsite',
      },
    ],
  }),
  // ── 社媒 ─────────────────────────────────────────────────
  daily({
    id: 'social-media.overview',
    title: '账号总览',
    position: 'social-media',
    duties: [],
    compute_roles: [
      'social.instagram',
      'social.facebook',
      'social.tiktok',
      'social.youtube',
      'social.x',
      'social.discord',
      'social.reddit',
    ],
    headline: 'social_engagement',
    blocks: [
      {
        id: 'kpis',
        kind: 'kpis',
        metrics: ['social_engagement', 'social_posts', 'social_pending_comments'],
      },
      {
        id: 'trend',
        kind: 'trend',
        title: '每天发出去的帖子',
        metric: 'social_posts',
        events: false,
        wide: true,
      },
      { id: 'calendar', kind: 'table', title: '内容日历', dataset: 'social.calendar' },
      { id: 'comments', kind: 'table', title: '待回评论', dataset: 'social.comments' },
    ],
  }),
  // ── 红人 ─────────────────────────────────────────────────
  daily({
    id: 'kol-marketing.funnel',
    title: '合作推进漏斗',
    position: 'kol-marketing',
    duties: [],
    compute_roles: ['kol.youtube', 'kol.instagram', 'kol.tiktok', 'kol.facebook', 'kol.x'],
    headline: 'kol_active',
    headline_label: '在合作的红人',
    blocks: [
      { id: 'kpis', kind: 'kpis', metrics: ['kol_active', 'kol_awaiting', 'kol_revenue'] },
      {
        id: 'funnel',
        kind: 'funnel',
        title: '联系 → 合作 → 发帖',
        dataset: 'kol.funnel',
        wide: true,
      },
      { id: 'top', kind: 'table', title: '表现最好的红人', dataset: 'kol.top' },
      { id: 'collabs', kind: 'table', title: '在合作的', dataset: 'kol.collabs' },
    ],
  }),
  // ── 投放 ─────────────────────────────────────────────────
  daily({
    id: 'ads.overview',
    title: '投放总览',
    position: 'ads',
    duties: [],
    compute_roles: ['ads.meta', 'ads.google', 'ads.tiktok', 'ads.x'],
    headline: 'ads_roas',
    headline_label: '广告回报 ROAS',
    blocks: [
      { id: 'kpis', kind: 'kpis', metrics: ['ads_spend_today', 'ads_roas', 'ads_stop_loss'] },
      {
        id: 'campaigns',
        kind: 'table',
        title: '各个广告系列',
        dataset: 'ads.campaigns',
        wide: true,
      },
      { id: 'stop-loss', kind: 'table', title: '止损记录', dataset: 'ads.stop_loss' },
      // WP452（docs/109 §5.2 #12–16）：资料在右——体检、保本线、素材疲劳、广告与落地页
      { id: 'audit', kind: 'table', title: '账户体检', dataset: 'ads.audit', wide: true },
      { id: 'break-even', kind: 'table', title: '保本线', dataset: 'ads.break_even' },
      { id: 'fatigue', kind: 'table', title: '素材疲劳', dataset: 'ads.fatigue', wide: true },
      { id: 'landing', kind: 'table', title: '广告与落地页', dataset: 'ads.landing', wide: true },
    ],
  }),
  // ── B2B ──────────────────────────────────────────────────
  daily({
    id: 'b2b.pipeline',
    title: '询盘与成交漏斗',
    position: 'b2b',
    duties: [],
    compute_roles: ['b2b.sales', 'b2b.outbound', 'b2b.exhibition', 'b2b.marketplace'],
    headline: 'b2b_inquiries',
    blocks: [
      { id: 'kpis', kind: 'kpis', metrics: ['b2b_inquiries', 'b2b_quotes_pending'] },
      { id: 'trend', kind: 'trend', title: '每天进来的询盘', metric: 'b2b_inquiries', wide: true },
      { id: 'sequence', kind: 'funnel', title: '开发信推进', dataset: 'b2b.sequence' },
      { id: 'quotes', kind: 'table', title: '报价待审', dataset: 'b2b.quotes' },
    ],
  }),
]

/** 一个岗位默认固定哪几份（按表里的顺序）。 */
export function defaultReportsFor(position: string): ReportSpec[] {
  return DEFAULT_REPORTS.filter((r) => r.position === position)
}

export function defaultReport(id: string): ReportSpec | undefined {
  return DEFAULT_REPORTS.find((r) => r.id === id)
}

/** 看板上最多固定几份（决策 1334）；超过才出「全部报表」。 */
export const PINNED_REPORT_LIMIT = 5

// ── 「跟 AI 说想看什么」：能拼出来的几种小报表 ────────────────────────────

/**
 * 一种小报表的配方：认哪些说法 → 3 个数 + 1 张图。AI 只**挑配方、起标题**，数照样在服务端由指标表算。
 * 认不出说的是什么时退回经营概览那一份（并照实说「先按经营概览出了一份」）。
 */
export interface ReportRecipe {
  id: string
  /** 认这些词（任一命中就算；按表里的顺序，第一个命中的赢）。 */
  words: readonly string[]
  title: string
  /** 读了哪些数（对话里那几行「读了…」）。 */
  reads: readonly ('orders' | 'campaigns' | 'gsc' | 'ga4' | 'mentions' | 'drafts')[]
  metrics: [string, string, string]
  chart: ReportBlockSpec
  /** 默认挂到哪个岗位 / 职责（AI 预选，用户点一下确认）。 */
  position: string
  duty?: string
  refresh: 'daily' | 'weekly' | 'on_open'
}

export const REPORT_RECIPES: readonly ReportRecipe[] = [
  {
    id: 'email_repeat',
    words: ['复购', '回购', '老客'],
    title: '邮件活动与复购',
    reads: ['orders', 'campaigns'],
    metrics: ['returning_orders', 'returning_sales', 'email_sales'],
    chart: {
      id: 'chart',
      kind: 'bars',
      title: '每周老客回购订单',
      dataset: 'shop.returning_by_campaign',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.email-marketing',
    refresh: 'weekly',
  },
  {
    id: 'email',
    words: ['邮件', 'email', '群发', 'newsletter'],
    title: '邮件带来的生意',
    reads: ['orders'],
    metrics: ['email_sales', 'email_orders', 'returning_orders'],
    chart: {
      id: 'chart',
      kind: 'bars',
      title: '邮件每周带来的销售额',
      dataset: 'shop.email_weekly',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.email-marketing',
    refresh: 'weekly',
  },
  {
    id: 'new_returning',
    words: ['新客', '新老客', '新顾客'],
    title: '新客和老客',
    reads: ['orders'],
    metrics: ['new_share', 'returning_orders', 'orders'],
    chart: {
      id: 'chart',
      kind: 'stacked',
      title: '每周订单：新客 / 老客',
      dataset: 'shop.new_vs_returning',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.store',
    refresh: 'daily',
  },
  {
    id: 'products',
    words: ['商品', '产品', '卖得', '爆款', 'sku'],
    title: '商品卖得怎么样',
    reads: ['orders'],
    metrics: ['sales', 'orders', 'aov'],
    chart: {
      id: 'chart',
      kind: 'table',
      title: '卖得最好的商品',
      dataset: 'shop.top_products',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.store',
    refresh: 'daily',
  },
  {
    id: 'sources',
    words: ['来源', '渠道', '从哪来', '流量'],
    title: '订单从哪来',
    reads: ['orders'],
    metrics: ['orders', 'search_orders', 'ai_orders'],
    chart: {
      id: 'chart',
      kind: 'rank',
      title: '订单从哪来',
      dataset: 'shop.order_sources',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.store',
    refresh: 'daily',
  },
  {
    id: 'ai_search',
    words: ['ai 搜索', 'ai搜索', 'chatgpt', 'perplexity', 'ai 回答', 'geo'],
    title: 'AI 回答带来的生意',
    reads: ['orders'],
    metrics: ['ai_orders', 'ai_sales', 'search_orders'],
    chart: {
      id: 'chart',
      kind: 'bars',
      title: '搜索和 AI 回答带来的订单',
      dataset: 'shop.ai_orders_daily',
      wide: true,
    },
    position: 'web-ops',
    duty: 'dtc.seo',
    refresh: 'daily',
  },
  {
    id: 'search',
    words: ['搜索', '关键词', 'seo', '排名'],
    title: '搜索词表现',
    reads: ['gsc'],
    metrics: ['gsc_clicks', 'gsc_impressions', 'gsc_position'],
    chart: { id: 'chart', kind: 'table', title: '搜索词', dataset: 'gsc.queries', wide: true },
    position: 'web-ops',
    duty: 'dtc.seo',
    refresh: 'daily',
  },
  {
    id: 'refunds',
    words: ['退款', '退货'],
    title: '退款情况',
    reads: ['orders', 'drafts'],
    metrics: ['refunds', 'refund_requests', 'orders'],
    chart: { id: 'chart', kind: 'trend', title: '每天退款', metric: 'refunds', wide: true },
    position: 'web-ops',
    duty: 'dtc.store',
    refresh: 'daily',
  },
  {
    id: 'reddit',
    words: ['reddit', '提及', '口碑', '情绪'],
    title: '品牌被聊得怎么样',
    reads: ['mentions'],
    metrics: ['mentions', 'our_replies', 'positive_share'],
    chart: {
      id: 'chart',
      kind: 'bars',
      title: '每天被提到几次，我们回了几次',
      dataset: 'pr.daily',
      wide: true,
    },
    position: 'pr',
    duty: 'pr.reddit',
    refresh: 'daily',
  },
  {
    id: 'service',
    words: ['客服', '回复', '回信', '工单'],
    title: '回信快不快',
    reads: ['drafts'],
    metrics: ['reply_rate_24h', 'pending_replies', 'drafts'],
    chart: {
      id: 'chart',
      kind: 'bars',
      title: '每天进来多少、回出去多少',
      dataset: 'support.daily',
      wide: true,
    },
    position: 'customer-care',
    duty: 'dtc.support',
    refresh: 'daily',
  },
]

/** 认不出时退回的那一份（经营概览）。 */
export const FALLBACK_RECIPE: ReportRecipe = {
  id: 'overview',
  words: [],
  title: '经营概览',
  reads: ['orders'],
  metrics: ['sales', 'orders', 'aov'],
  chart: {
    id: 'chart',
    kind: 'trend',
    title: '每天销售额',
    metric: 'sales',
    events: true,
    wide: true,
  },
  position: 'web-ops',
  duty: 'dtc.store',
  refresh: 'daily',
}

/** 「做一份报表：」下面那五个例子（AI 先给建议，用户不用从零想）。 */
export const REPORT_EXAMPLES: readonly string[] = [
  '近 8 周邮件活动对复购有没有用，按周看',
  '哪几个商品卖得最好，和上个月比',
  '订单都从哪来，AI 回答里点进来的有多少',
  '新客和老客各占多少，按周看',
  '这个月退款多不多',
]

/** 认一句话该用哪个配方（小写后按词找；都没有 = `undefined`）。 */
export function matchRecipe(prompt: string): ReportRecipe | undefined {
  const text = prompt.toLowerCase()
  return REPORT_RECIPES.find((r) => r.words.some((w) => text.includes(w)))
}

/** 配方 → 一份规格（AI 做的那种：`origin: 'ai'`）。 */
export function specFromRecipe(
  recipe: ReportRecipe,
  input: {
    id: string
    prompt: string
    at: string
    title?: string
    position?: string
    duty?: string
  },
): ReportSpec {
  const position = input.position ?? recipe.position
  const duty = input.duty ?? recipe.duty
  return {
    id: input.id,
    title: input.title ?? recipe.title,
    position,
    duties: duty === undefined ? [] : [duty],
    compute_roles: [
      ...(duty === undefined ? [] : [duty]),
      ...DEFAULT_REPORTS.filter((r) => r.position === position).flatMap((r) => r.compute_roles),
    ].filter((x, i, all) => all.indexOf(x) === i),
    headline: recipe.metrics[0],
    blocks: [{ id: 'kpis', kind: 'kpis', metrics: [...recipe.metrics] }, recipe.chart],
    origin: 'ai',
    refresh: recipe.refresh,
    default_range: '30d',
    created: { at: input.at, prompt: input.prompt },
  }
}
