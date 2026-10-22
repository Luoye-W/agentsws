/**
 * WP323：「列 ← 填什么」的对照——取值、格式、按表头猜一版、校验 AI 给的那一版、按对照出一行。
 *
 * 全是确定性的函数：**值永远从记录里直接取，不经模型**（docs/29）。AI 能决定的只有
 * 「这一列对应哪个标准字段 / 固定值 / 留空」以及简单格式（日期写法、截断、值替换）。
 */
import {
  isOutboundField,
  OUTBOUND_FIELDS,
  OUTBOUND_OPT_IN_ACTIONS,
  type OutboundField,
  type OutboundRecord,
  type SinkColumn,
  type SinkColumnSource,
  type SinkColumnType,
  type SinkFilter,
  type SinkFormat,
} from '@agentsws/contracts'

/** 目标表的一列（适配器读表头读出来的）。 */
export interface TargetColumn {
  name: string
  type: SinkColumnType
  options?: string[]
}

/** 按对照出的一格：给人看的字 + 时间类字段带毫秒数（日期列要它）。 */
export interface RenderedCell {
  column: string
  type: SinkColumnType
  text: string
  /** 时间类字段的毫秒时间戳（多维表格的日期列写它）。 */
  ms?: number
  /** 数字类字段的数（数字列写它）。 */
  num?: number
}

const ACTION_ZH: Readonly<Record<string, string>> = {
  reply: '回复',
  comment: '评论',
  post: '发帖',
  email: '邮件',
  message: '消息',
  broadcast: '群发',
}
const STATUS_ZH: Readonly<Record<string, string>> = {
  sent: '已发',
  failed: '失败',
  deleted: '已删',
}
const CHANNEL_ZH: Readonly<Record<string, string>> = {
  reddit: 'Reddit',
  email: '邮件',
  chat: '在线聊天',
  x: 'X',
  discord: 'Discord',
  telegram: 'Telegram',
  facebook: 'Facebook',
  instagram: 'Instagram',
  linkedin: 'LinkedIn',
  tiktok: 'TikTok',
  youtube: 'YouTube',
  whatsapp: 'WhatsApp',
}

/** 一个标准字段的原始值（字符串 / 数；没有就空串）。 */
export function fieldValue(record: OutboundRecord, field: OutboundField): string | number {
  switch (field) {
    case 'sent_at':
    case 'sent_date':
      return record.sent_at
    case 'channel':
      return record.channel
    case 'action':
      return record.action
    case 'status':
      return record.status
    case 'tier':
      return record.reason?.tier ?? ''
    case 'faq':
      return (record.reason?.faq ?? []).join('；')
    case 'follow_up_count':
      return record.follow_ups.filter((f) => f.from === 'them').length
    case 'record_id':
      return record.id
    case 'approved_at':
      return record.approved_at ?? ''
    case 'counterpart_text':
      return record.counterpart_deleted === true ? '' : (record.counterpart_text ?? '')
    // WP432：票数是数（没读过留空）
    case 'score':
      return record.score ?? ''
    // WP441：消息规则记下的来信那一组
    case 'sender':
      return record.message?.sender ?? ''
    case 'received_at':
      return record.message?.received_at ?? ''
    case 'message_kind':
      return record.message?.kind ?? ''
    case 'summary':
      return record.message?.summary ?? ''
    case 'rule_names':
      return (record.message?.rule_names ?? []).join('；')
    case 'message_link':
      return record.message?.link ?? ''
    default:
      return (record[field] as string | undefined) ?? ''
  }
}

const TIME_FIELDS = new Set<OutboundField>(['sent_at', 'sent_date', 'approved_at', 'received_at'])

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** ISO 时间按 `YYYY/MM/DD HH:mm` 这类写法排（`tzOffsetMinutes` = 本地时区，东八区 480）。 */
export function formatDate(iso: string, pattern: string, tzOffsetMinutes = 0): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  const d = new Date(ms + tzOffsetMinutes * 60_000)
  return pattern
    .replace(/YYYY/g, String(d.getUTCFullYear()))
    .replace(/MM/g, pad(d.getUTCMonth() + 1))
    .replace(/DD/g, pad(d.getUTCDate()))
    .replace(/HH/g, pad(d.getUTCHours()))
    .replace(/mm/g, pad(d.getUTCMinutes()))
    .replace(/ss/g, pad(d.getUTCSeconds()))
}

/** 默认的人话（没给替换表时）：动作 / 状态 / 渠道写中文。 */
function humanDefault(field: OutboundField, raw: string): string {
  if (field === 'action') return ACTION_ZH[raw] ?? raw
  if (field === 'status') return STATUS_ZH[raw] ?? raw
  if (field === 'channel') return CHANNEL_ZH[raw] ?? raw
  return raw
}

const truncate = (s: string, max: number | undefined): string =>
  max === undefined || s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1))}…`

/** 按一列的对照取一格。 */
export function renderCell(
  record: OutboundRecord,
  col: SinkColumn,
  tzOffsetMinutes = 0,
): RenderedCell {
  const type = col.type ?? 'text'
  const src = col.source
  if (src.from === 'empty') return { column: col.column, type, text: '' }
  if (src.from === 'const') return { column: col.column, type, text: src.value }
  const raw = fieldValue(record, src.field)
  const fmt = src.format ?? {}
  if (typeof raw === 'number') return { column: col.column, type, text: String(raw), num: raw }
  if (TIME_FIELDS.has(src.field) && raw !== '') {
    const pattern = fmt.date ?? (src.field === 'sent_date' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm')
    return {
      column: col.column,
      type,
      text: formatDate(raw, pattern, tzOffsetMinutes),
      ms: Date.parse(raw),
    }
  }
  const mapped = fmt.map?.[raw] ?? humanDefault(src.field, raw)
  return { column: col.column, type, text: truncate(mapped, fmt.max_chars) }
}

export function renderRow(
  record: OutboundRecord,
  columns: readonly SinkColumn[],
  tzOffsetMinutes = 0,
): RenderedCell[] {
  return columns.map((c) => renderCell(record, c, tzOffsetMinutes))
}

/** 这一行要不要记进这个去处（空条件 = 全记）。 */
export function matchesFilter(record: OutboundRecord, filter: SinkFilter): boolean {
  const hit = (list: string[] | undefined, v: string): boolean =>
    list === undefined || list.length === 0 || list.includes(v)
  // WP330 / WP331：「只有点名才记」的动作（发布的报告那一行）——筛选里没明确列它就不写；
  // 点名了就记，不再看渠道（报告不属于哪个渠道）
  if (OUTBOUND_OPT_IN_ACTIONS.includes(record.action))
    return filter.actions?.includes(record.action) === true
  return (
    hit(filter.channels, record.channel) &&
    hit(filter.actions, record.action) &&
    hit(filter.kinds, record.kind)
  )
}

/* ── 按表头猜一版（没有模型 / 模型给的不能用时的兜底） ─────────────────────── */

/** 每个字段的常见列名（中英；越具体的放越前）。 */
const SYNONYMS: ReadonlyArray<[OutboundField, readonly string[]]> = [
  ['thread_url', ['原帖链接', '帖子链接', 'post link', 'post url', 'thread url', '原贴链接']],
  [
    'link',
    ['回复链接', '评论链接', '我们的链接', 'reply link', 'comment link', '链接', 'link', 'url'],
  ],
  ['thread_title', ['原帖标题', '帖子标题', 'post title', 'thread title', '标题', 'title']],
  [
    'counterpart_text',
    ['对方原话', '用户原话', '用户问题', '原话', '问题', 'question', 'their comment'],
  ],
  [
    'content',
    [
      '我们回复的内容',
      '回复内容',
      '我们发的',
      '发出内容',
      '内容',
      '回复',
      '正文',
      'content',
      'reply',
      'body',
      'message',
    ],
  ],
  ['sent_date', ['日期', 'date', '发出日期', '回复日期', '发布日期']],
  ['sent_at', ['时间', 'time', '发出时间', '回复时间', 'timestamp']],
  ['destination', ['版块', '社区', 'subreddit', '发到', '收件人', '群', 'community', 'to']],
  ['counterpart', ['对方', '用户名', '用户', '作者', '客户', 'author', 'username', 'user']],
  ['channel', ['渠道', '平台', 'platform', 'channel']],
  ['action', ['动作', '类型', '操作', 'action', 'type']],
  ['status', ['状态', 'status']],
  ['approved_by', ['审批人', '批准人', '谁批的', '负责人', 'approver', 'approved by']],
  ['approved_at', ['批的时间', '审批时间', 'approved at']],
  ['subject', ['邮件主题', '主题', 'subject']],
  // WP432
  ['draft_content', ['AI 草稿', '草稿', '原草稿', 'draft']],
  ['score', ['票数', '点赞', '赞', 'score', 'upvotes', 'votes']],
  ['tier', ['档位', '分类', '优先级', 'tier', 'category']],
  ['faq', ['faq', '依据', '引用']],
  ['follow_up_count', ['对方回复数', '后续', '回复数', 'replies']],
  ['record_id', ['记录编号', '编号', 'record id', 'id']],
  // WP441：消息规则记下的来信那一组（放最后：老表头的猜法一个不变）
  ['sender', ['发件人', '来信人', 'sender']],
  ['received_at', ['收到时间', '收信时间', 'received at']],
  ['message_kind', ['邮件类型', '消息类型']],
  ['summary', ['摘要', 'summary']],
  ['rule_names', ['命中规则', '规则']],
  ['message_link', ['原件链接', '原邮件链接', '邮件链接']],
]

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[\s_\-/／|（）()【】[\]:：·.]+/g, '')
    .trim()

/** 按列名猜这一列对应哪个字段（猜不到 = undefined）。 */
export function guessField(
  column: TargetColumn,
  taken: ReadonlySet<OutboundField> = new Set(),
): OutboundField | undefined {
  const name = norm(column.name)
  if (name === '') return undefined
  // 1) 一字不差
  for (const [field, words] of SYNONYMS)
    if (!taken.has(field) && words.some((w) => norm(w) === name)) return field
  // 2) 列名里含着某个说法（长的说法优先）
  let best: { field: OutboundField; len: number } | undefined
  for (const [field, words] of SYNONYMS) {
    if (taken.has(field)) continue
    for (const w of words) {
      const n = norm(w)
      if (n.length >= 2 && name.includes(n) && (best === undefined || n.length > best.len))
        best = { field, len: n.length }
    }
  }
  if (best !== undefined) return best.field
  // 3) 日期类型的列：发出时间
  if (column.type === 'date' && !taken.has('sent_at')) return 'sent_at'
  return undefined
}

/** 整张表头猜一版对照（每个字段最多用一次；猜不到的列留空）。 */
export function guessColumns(columns: readonly TargetColumn[]): SinkColumn[] {
  const taken = new Set<OutboundField>()
  return columns.map((c) => {
    const field = guessField(c, taken)
    if (field !== undefined) taken.add(field)
    return {
      column: c.name,
      type: c.type,
      ...(c.options === undefined ? {} : { options: c.options }),
      source: field === undefined ? { from: 'empty' } : { from: 'field', field },
    }
  })
}

/* ── 校验 AI 给的那一版 ─────────────────────────────────────────────── */

const DATE_PATTERN = /^[YMDHms/\-.: 年月日时分秒T]{1,32}$/

function cleanFormat(raw: unknown): SinkFormat | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  const out: SinkFormat = {}
  if (typeof o.date === 'string' && DATE_PATTERN.test(o.date)) out.date = o.date
  if (typeof o.max_chars === 'number' && o.max_chars >= 1 && o.max_chars <= 5000)
    out.max_chars = Math.floor(o.max_chars)
  if (typeof o.map === 'object' && o.map !== null && !Array.isArray(o.map)) {
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.map as Record<string, unknown>).slice(0, 50))
      if (typeof v === 'string' && k.length <= 100 && v.length <= 100) map[k] = v
    if (Object.keys(map).length > 0) out.map = map
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/** AI 给的一列的来源 → 收得下的那一种（收不下 = undefined）。 */
export function cleanSource(raw: unknown): SinkColumnSource | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const o = raw as Record<string, unknown>
  if (typeof o.field === 'string' && isOutboundField(o.field)) {
    const format = cleanFormat(o.format)
    return { from: 'field', field: o.field, ...(format === undefined ? {} : { format }) }
  }
  if (typeof o.value === 'string' && o.value.length <= 200) return { from: 'const', value: o.value }
  if (o.from === 'empty' || o.empty === true) return { from: 'empty' }
  return undefined
}

export interface MappingResult {
  columns: SinkColumn[]
  /** AI 提到、表里没有的列。 */
  unknown: string[]
  /** 表里有、对照里留空的列。 */
  empty: string[]
}

/**
 * 表头 + AI 给的对照 → 最终对照。表头是真源：顺序照表头，AI 提到的不存在的列记进 `unknown`；
 * AI 没给的列按列名猜一版。表头为空（新表）时，AI 给的列就是要写的表头。
 */
export function buildMapping(
  header: readonly TargetColumn[],
  proposed: readonly { column: string; source: unknown }[] | undefined,
): MappingResult {
  const byName = new Map<string, SinkColumnSource>()
  const unknown: string[] = []
  const headerNames = new Set(header.map((c) => c.name.trim()))
  const freshTable = header.length === 0
  for (const p of proposed ?? []) {
    const name = typeof p.column === 'string' ? p.column.trim() : ''
    const src = cleanSource(p.source)
    if (name === '' || src === undefined) continue
    if (!freshTable && !headerNames.has(name)) {
      unknown.push(name)
      continue
    }
    byName.set(name, src)
  }
  const base: readonly TargetColumn[] = freshTable
    ? [...byName.keys()].map((name) => ({ name, type: 'text' as const }))
    : header
  const guessed = guessColumns(base.filter((c) => !byName.has(c.name.trim())))
  const taken = new Set([...byName.values()].flatMap((s) => (s.from === 'field' ? [s.field] : [])))
  const columns = base.map((c): SinkColumn => {
    const given = byName.get(c.name.trim())
    const guess = guessed.find((g) => g.column === c.name)
    const source: SinkColumnSource =
      given ??
      (guess?.source.from === 'field' && !taken.has(guess.source.field)
        ? guess.source
        : { from: 'empty' })
    return {
      column: c.name,
      type: c.type,
      ...(c.options === undefined ? {} : { options: c.options }),
      source,
    }
  })
  return {
    columns,
    unknown,
    empty: columns.filter((c) => c.source.from === 'empty').map((c) => c.column),
  }
}

/** 一列的来源说成人话（卡上、工具回话用）。 */
export function sourceLabel(src: SinkColumnSource): string {
  if (src.from === 'empty') return '留空'
  if (src.from === 'const') return `固定写「${src.value}」`
  const zh = OUTBOUND_FIELDS.find((f) => f.id === src.field)?.zh ?? src.field
  const bits: string[] = []
  if (src.format?.date !== undefined) bits.push(src.format.date)
  if (src.format?.max_chars !== undefined) bits.push(`最多 ${src.format.max_chars} 字`)
  if (src.format?.map !== undefined) bits.push('按替换表')
  return bits.length === 0 ? zh : `${zh}（${bits.join('，')}）`
}
