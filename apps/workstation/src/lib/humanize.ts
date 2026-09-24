/**
 * WP141（docs/78 §2）：**屏幕上的内部值 → 人话**，全工作台只有这一处。
 *
 * 走查把同一类毛病在七八个地方各撞了一次：改动卡上 `late_return_grace_days: 0 → 7`、
 * 日报列头 `date / sales / orders / low_stock`、红人表里 `youtube` / `video`、
 * 交付期限 `2026-09-27T01:00:00.000Z`。每处各写一张小表，下一次新字段出现时
 * 就会有一处忘了——所以字段名、渠道、形态、时间都从这里过。
 *
 * 纪律（与 14 §2「数字不经模型手」同一条）：这里只**改写说法**，不算数、不编值。
 * 表里没有的字段名不硬猜意思：把下划线换成空格原样给（一句不好看的实话），
 * 至少不再是一个像代码的词。
 */
import type { Lang } from './i18n'

type Bi = { zh: string; en: string }

interface FieldDef {
  label: Bi
  /** 数值后面跟的单位（「7 天」）；没有就不加 */
  unit?: Bi
  /** 这个字段的取值也是枚举：值 → 人话 */
  values?: Record<string, Bi>
}

const DAYS: Bi = { zh: '天', en: 'days' }

/** 各阶段 / 状态的值（红人合作阶段与通用的草稿 / 排期 / 上架）。 */
const STAGE_VALUES: Record<string, Bi> = {
  sourced: { zh: '已找到', en: 'Sourced' },
  contacted: { zh: '已建联', en: 'Contacted' },
  replied: { zh: '有回音', en: 'Replied' },
  negotiating: { zh: '谈条件中', en: 'Negotiating' },
  agreed: { zh: '已谈成', en: 'Agreed' },
  delivering: { zh: '交付中', en: 'Delivering' },
  delivered: { zh: '已交付', en: 'Delivered' },
  closed: { zh: '已结案', en: 'Closed' },
  declined: { zh: '谢绝了', en: 'Declined' },
}

const STATUS_VALUES: Record<string, Bi> = {
  draft: { zh: '草稿', en: 'Draft' },
  scheduled: { zh: '已排期', en: 'Scheduled' },
  active: { zh: '在售', en: 'Active' },
  archived: { zh: '已归档', en: 'Archived' },
  published: { zh: '已发布', en: 'Published' },
  pending: { zh: '待处理', en: 'Pending' },
  paid: { zh: '已付款', en: 'Paid' },
  refunded: { zh: '已退款', en: 'Refunded' },
  fulfilled: { zh: '已发货', en: 'Fulfilled' },
  unfulfilled: { zh: '未发货', en: 'Unfulfilled' },
}

/** 字段名 → 人话。按「会出现在卡面 / 报表上」的频率收，不求全。 */
const FIELDS: Record<string, FieldDef> = {
  // 客服的业务边界（docs/78 §2 首页 / 客服第 38 步）
  late_return_grace_days: {
    label: { zh: '过了退货期还能宽限', en: 'Grace after the return window' },
    unit: DAYS,
  },
  return_window_days: { label: { zh: '退货期', en: 'Return window' }, unit: DAYS },
  refund_limit: { label: { zh: '退款上限', en: 'Refund limit' } },
  // 日报（WP63）那四个数
  date: { label: { zh: '日期', en: 'Date' } },
  sales: { label: { zh: '销售额', en: 'Sales' } },
  orders: { label: { zh: '订单', en: 'Orders' } },
  low_stock: { label: { zh: '库存告急', en: 'Low stock' } },
  pending: { label: { zh: '待审', en: 'Pending' } },
  // 商品与内容
  price: { label: { zh: '价格', en: 'Price' } },
  title: { label: { zh: '标题', en: 'Title' } },
  body: { label: { zh: '正文', en: 'Body' } },
  subject: { label: { zh: '邮件标题', en: 'Subject' } },
  published: { label: { zh: '上架', en: 'Published' } },
  enabled: { label: { zh: '启用', en: 'Enabled' } },
  installed: { label: { zh: '已安装', en: 'Installed' } },
  inventory: { label: { zh: '库存', en: 'Inventory' } },
  quantity: { label: { zh: '数量', en: 'Quantity' } },
  tags: { label: { zh: '标签', en: 'Tags' } },
  theme_id: { label: { zh: '主题编号', en: 'Theme' } },
  theme_name: { label: { zh: '主题', en: 'Theme' } },
  preview_url: { label: { zh: '预览', en: 'Preview' } },
  statement: { label: { zh: '说法', en: 'Statement' } },
  carrier: { label: { zh: '物流商', en: 'Carrier' } },
  tracking_number: { label: { zh: '运单号', en: 'Tracking number' } },
  name: { label: { zh: '名字', en: 'Name' } },
  email: { label: { zh: '邮箱', en: 'Email' } },
  added: { label: { zh: '加上', en: 'Added' } },
  removed: { label: { zh: '去掉', en: 'Removed' } },
  created_at: { label: { zh: '建于', en: 'Created' } },
  due_at: { label: { zh: '期限', en: 'Due' } },
  // 钱
  amount: { label: { zh: '金额', en: 'Amount' } },
  budget: { label: { zh: '预算', en: 'Budget' } },
  currency: { label: { zh: '币种', en: 'Currency' } },
  discount: { label: { zh: '折扣', en: 'Discount' } },
  code: { label: { zh: '折扣码', en: 'Code' } },
  // 状态类：值也要翻
  stage: { label: { zh: '阶段', en: 'Stage' }, values: STAGE_VALUES },
  status: { label: { zh: '状态', en: 'Status' }, values: STATUS_VALUES },
  state: { label: { zh: '状态', en: 'Status' }, values: STATUS_VALUES },
}

/** 表里没有的字段：`foo_bar_days` → `foo bar days`（不猜意思，只是别像代码）。 */
export function plainKey(key: string): string {
  return key.replace(/[_.]+/g, ' ').trim()
}

export function fieldLabel(key: string, lang: Lang): string {
  const def = FIELDS[key]
  return def === undefined ? plainKey(key) : def.label[lang]
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const LOCALE: Record<Lang, string> = { zh: 'zh-CN', en: 'en-US' }

/** ISO 时间 → 「9月27日 09:00」（本机时区）；不是时间就原样给回。 */
export function whenText(iso: string, lang: Lang): string {
  const ms = Date.parse(iso)
  if (!ISO_RE.test(iso) || Number.isNaN(ms)) return iso
  return new Intl.DateTimeFormat(LOCALE[lang], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms))
}

/**
 * 一个字段的值 → 一行人话：带单位（「7 天」）、枚举值翻出来（`delivering` → 交付中）、
 * 是非写成「是 / 否」、ISO 时间写成日期。对象与数组不硬编成句子，压成短短一行。
 */
export function fieldValue(key: string, value: unknown, lang: Lang): string {
  if (value === undefined || value === null || value === '') return '—'
  const def = FIELDS[key]
  if (typeof value === 'boolean')
    return lang === 'en' ? (value ? 'Yes' : 'No') : value ? '是' : '否'
  if (typeof value === 'number') {
    const n = new Intl.NumberFormat(LOCALE[lang]).format(value)
    return def?.unit === undefined
      ? n
      : lang === 'en'
        ? `${n} ${def.unit.en}`
        : `${n} ${def.unit.zh}`
  }
  if (typeof value === 'string') {
    const mapped = def?.values?.[value]
    if (mapped !== undefined) return mapped[lang]
    return whenText(value, lang)
  }
  if (Array.isArray(value)) return value.map((v) => fieldValue(key, v, lang)).join('、')
  return JSON.stringify(value)
}

// ── 渠道与内容形态（红人 / 社媒） ───────────────────────────────────────

const CHANNELS: Record<string, string> = {
  youtube: 'YouTube',
  instagram: 'Instagram',
  tiktok: 'TikTok',
  facebook: 'Facebook',
  x: 'X',
  twitter: 'X',
  reddit: 'Reddit',
  discord: 'Discord',
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  pinterest: 'Pinterest',
  linkedin: 'LinkedIn',
  threads: 'Threads',
  shopify: 'Shopify',
  amazon: 'Amazon',
}

const CHANNEL_WORDS: Record<string, Bi> = {
  email: { zh: '邮件', en: 'Email' },
  chat: { zh: '在线聊天', en: 'Live chat' },
  sms: { zh: '短信', en: 'SMS' },
  web: { zh: '网站', en: 'Website' },
}

/** `youtube` → YouTube；`email` → 邮件。认不得的首字母大写给回（不再是全小写的内部值）。 */
export function channelLabel(channel: string, lang: Lang): string {
  const key = channel.toLowerCase()
  const brand = CHANNELS[key]
  if (brand !== undefined) return brand
  const word = CHANNEL_WORDS[key]
  if (word !== undefined) return word[lang]
  return channel === '' ? '—' : channel.charAt(0).toUpperCase() + plainKey(channel.slice(1))
}

const FORMATS: Record<string, Bi> = {
  video: { zh: '视频', en: 'Video' },
  short: { zh: '短视频', en: 'Short' },
  shorts: { zh: '短视频', en: 'Shorts' },
  reel: { zh: 'Reels 短视频', en: 'Reel' },
  post: { zh: '图文帖', en: 'Post' },
  story: { zh: '快拍', en: 'Story' },
  live: { zh: '直播', en: 'Live' },
  carousel: { zh: '多图帖', en: 'Carousel' },
  tweet: { zh: '推文', en: 'Post' },
  thread: { zh: '长串帖', en: 'Thread' },
  review: { zh: '测评', en: 'Review' },
  unboxing: { zh: '开箱', en: 'Unboxing' },
  mention: { zh: '口播提及', en: 'Mention' },
}

/** 交付物 / 内容形态：`video` → 视频、`post` → 图文帖。 */
export function formatLabel(format: string, lang: Lang): string {
  return FORMATS[format.toLowerCase()]?.[lang] ?? plainKey(format)
}

/**
 * `t(key)` 查不到时它会把 key 原样还回来（`kol.contact.source.sandbox` 就是这么上屏的）。
 * 这里换成一个给定的说法——**键名永远不上屏**。
 */
export function tOr(
  t: (key: string, vars?: Record<string, string | number>) => string,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  const out = t(key, vars)
  return out === key ? fallback : out
}

/** 一个对象压成一行：「过了退货期还能宽限：7 天；标题：…」。不是对象就只翻值。 */
export function recordText(v: unknown, lang: Lang): string {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const sep = lang === 'en' ? '; ' : '；'
    const colon = lang === 'en' ? ': ' : '：'
    return Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${fieldLabel(k, lang)}${colon}${fieldValue(k, x, lang)}`)
      .join(sep)
  }
  return fieldValue('', v, lang)
}

/**
 * 面板表格里一格字（WP141，走查第 30 步）：渠道列 `youtube` → YouTube、形态列
 * `video` → 视频、期限列的 ISO 时间 → 日期。数字不走这里（它们有自己的格式）。
 */
export function cellText(key: string, value: string, lang: Lang): string {
  if (key === 'channel' || key === 'platform') return channelLabel(value, lang)
  if (key === 'kind' || key === 'format') return value === '' ? '' : formatLabel(value, lang)
  if (ISO_RE.test(value)) return whenText(value, lang)
  const def = FIELDS[key]
  return def?.values?.[value]?.[lang] ?? value
}

/** 审批项的状态（记录时间线上那一格）：`approved_edited` → 改后批了。 */
const APPROVAL_STATES: Record<string, Bi> = {
  proposed: { zh: '提议中', en: 'Proposed' },
  blocked: { zh: '被拦下', en: 'Blocked' },
  auto_approved: { zh: '自动批了', en: 'Auto-approved' },
  pending: { zh: '等你定', en: 'Waiting' },
  in_review: { zh: '审核中', en: 'In review' },
  approved: { zh: '批了', en: 'Approved' },
  approved_edited: { zh: '改后批了', en: 'Approved with edits' },
  rejected: { zh: '驳回了', en: 'Rejected' },
  redirected: { zh: '转给别人了', en: 'Redirected' },
  deferred: { zh: '稍后', en: 'Later' },
  withdrawn: { zh: '撤回了', en: 'Withdrawn' },
  expired: { zh: '过期了', en: 'Expired' },
  superseded: { zh: '被新版替掉', en: 'Superseded' },
  applying: { zh: '在执行', en: 'Applying' },
  applied: { zh: '办好了', en: 'Done' },
  apply_failed: { zh: '没办成', en: 'Failed' },
}

export function approvalStateLabel(state: string, lang: Lang): string {
  return APPROVAL_STATES[state]?.[lang] ?? plainKey(state)
}
