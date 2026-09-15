/**
 * Excel / CSV 导入（48 §5.2「Excel 导入」）：列映射 + 去重 + 渠道识别。
 *
 * 为什么这条路必须好用：五条渠道里有三条的官方 API 是申请制或付费的（48 §5.1），
 * 没批下来之前，用户手上那张表**就是**他的红人库。导入做得难用，这个岗位对他
 * 就是空的。
 *
 * 三条纪律：
 *
 * 1. **不解析文件**。这里收的是"已经读成二维数组的表"——xlsx 的解析、编码、
 *    多 sheet 是宿主的事。于是这个模块纯、可测，换一个解析库不影响它。
 * 2. **认不出来的列就说认不出来**（`unmapped`），不按位置猜。按第 3 列一定是粉丝数
 *    这种猜法，遇到一张列序不同的表就会把粉丝数写进"地区"。
 * 3. **去重只按链接**（解析出的 `channel + handle`）。名字重复太常见了，
 *    按名字去重会把两个真不同的人合成一个——而那正是"同一人合并"要人点头的理由。
 */
import type { KolChannel } from '@agentsws/contracts'
import { normalizeHandle, parseCreatorUrl } from './urls.js'

/** 导入后每一行变成的那个形状（还不是 `PlatformAccount`——id 与 `observed_at` 由宿主给）。 */
export interface ImportedAccount {
  channel: KolChannel
  handle: string
  url: string
  display_name?: string
  followers?: number
  engagement_rate?: number
  category?: string
  language?: string
  region?: string
  /** 邮箱**明文**：宿主拿到之后立刻写进加密库换成 `value_ref`，别落盘。 */
  email?: string
  /** 这一行在原表里的行号（从 1 数，含表头那一行）。报错时要指得回去。 */
  source_row: number
}

/** 我们认的那几种列。 */
export type ImportField =
  | 'url'
  | 'handle'
  | 'display_name'
  | 'followers'
  | 'engagement_rate'
  | 'category'
  | 'language'
  | 'region'
  | 'email'
  | 'channel'

/**
 * 表头 → 字段。中英都认，大小写与空格不敏感。
 *
 * **只可加行**：用户的表五花八门，加一个别名不会弄坏任何已经能导的表。
 */
export const HEADER_ALIASES: Readonly<Record<ImportField, readonly string[]>> = {
  url: ['url', 'link', '链接', '主页', '频道链接', 'profile', 'profile url', 'channel url'],
  handle: ['handle', 'username', '用户名', '账号', '昵称id', '@'],
  display_name: ['name', 'display name', '姓名', '名字', '红人', '达人', 'creator'],
  followers: ['followers', 'subscribers', '粉丝', '粉丝数', '订阅数', 'fans'],
  engagement_rate: ['engagement', 'engagement rate', 'er', '互动率', '互动'],
  category: ['category', 'niche', '类目', '领域', '赛道'],
  language: ['language', 'lang', '语言'],
  region: ['region', 'country', 'market', '地区', '国家', '市场'],
  email: ['email', 'mail', 'contact', '邮箱', '联系方式', 'e-mail'],
  channel: ['channel', 'platform', '渠道', '平台'],
}

const headerKey = (h: string): string =>
  h
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, ' ')

/** 一个表头认成哪个字段；认不出来回 `undefined`。 */
export function mapHeader(header: string): ImportField | undefined {
  const key = headerKey(header)
  for (const [field, aliases] of Object.entries(HEADER_ALIASES) as [
    ImportField,
    readonly string[],
  ][])
    if (aliases.some((a) => headerKey(a) === key)) return field
  return undefined
}

export interface ImportMapping {
  /** 列号（0 起）→ 字段。 */
  columns: Record<number, ImportField>
  /** 认不出来的那几列的表头原文。 */
  unmapped: string[]
}

/** 表头行 → 列映射。 */
export function mapHeaders(headers: readonly string[]): ImportMapping {
  const columns: Record<number, ImportField> = {}
  const unmapped: string[] = []
  for (const [i, h] of headers.entries()) {
    const field = mapHeader(h)
    if (field === undefined) {
      if (h.trim() !== '') unmapped.push(h.trim())
      continue
    }
    // 同一个字段被认了两次：用第一列，第二列当认不出来（"粉丝数"与"fans"同时在表里）
    if (Object.values(columns).includes(field)) {
      unmapped.push(h.trim())
      continue
    }
    columns[i] = field
  }
  return { columns, unmapped }
}

/** 一行导不进来的理由。 */
export interface ImportRejection {
  source_row: number
  /** 一句人话。 */
  reason: string
}

export interface ImportResult {
  accounts: ImportedAccount[]
  /** 因为与前面某一行是同一个账号而没进来的（**不是错误**，正常情况）。 */
  duplicates: { source_row: number; same_as_row: number; handle: string; channel: KolChannel }[]
  rejected: ImportRejection[]
  mapping: ImportMapping
}

const num = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  // 用户表里的粉丝数常写成 "48,000" / "48K" / "1.2M"
  const text = raw.trim().replace(/,/g, '').replace(/\s/g, '')
  if (text === '') return undefined
  const m = /^(\d+(?:\.\d+)?)([kKmM万])?$/.exec(text)
  if (m === null) {
    const plain = Number(text.replace(/%$/, ''))
    return Number.isFinite(plain) ? plain : undefined
  }
  const base = Number(m[1])
  switch (m[2]) {
    case 'k':
    case 'K':
      return base * 1_000
    case 'm':
    case 'M':
      return base * 1_000_000
    case '万':
      return base * 10_000
    default:
      return base
  }
}

/** 互动率：`3.2%` → 0.032；`0.032` 原样；`3.2` 当成百分数（没人的互动率是 320%）。 */
const rate = (raw: string | undefined): number | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = raw.trim()
  const isPercent = text.endsWith('%')
  const v = num(text)
  if (v === undefined) return undefined
  if (isPercent) return v / 100
  return v > 1 ? v / 100 : v
}

/**
 * 导一张表。
 *
 * `rows` 第一行是表头。渠道按这个顺序认：链接解析出来的 > `channel` 列写的 >
 * 认不出来（这一行进 `rejected`）——**链接优先**，因为链接是事实，列里那个字
 * 是人打的。
 */
export function importAccounts(rows: readonly (readonly string[])[]): ImportResult {
  const header = rows[0]
  if (header === undefined)
    return {
      accounts: [],
      duplicates: [],
      rejected: [],
      mapping: { columns: {}, unmapped: [] },
    }
  const mapping = mapHeaders(header)
  const fieldAt = (row: readonly string[], field: ImportField): string | undefined => {
    for (const [i, f] of Object.entries(mapping.columns))
      if (f === field) {
        const v = row[Number(i)]
        return v === undefined || v.trim() === '' ? undefined : v.trim()
      }
    return undefined
  }

  const accounts: ImportedAccount[] = []
  const duplicates: ImportResult['duplicates'] = []
  const rejected: ImportRejection[] = []
  /** `channel|handle` → 第一次出现的行号。 */
  const seen = new Map<string, number>()

  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i]
    const source_row = i + 1
    if (row === undefined || row.every((c) => c.trim() === '')) continue

    const rawUrl = fieldAt(row, 'url')
    const parsed = rawUrl === undefined ? undefined : parseCreatorUrl(rawUrl)
    const rawHandle = fieldAt(row, 'handle')
    const rawChannel = fieldAt(row, 'channel')?.toLowerCase()

    let channel: KolChannel | undefined
    let handle: string | undefined
    let url: string | undefined

    if (parsed !== undefined && parsed.target === 'profile' && parsed.handle !== '') {
      channel = parsed.channel
      handle = parsed.handle
      url = parsed.url
    } else if (rawChannel !== undefined && rawHandle !== undefined) {
      const known = (['youtube', 'facebook', 'instagram', 'tiktok', 'x'] as const).find(
        (c) => c === rawChannel,
      )
      if (known !== undefined) {
        channel = known
        handle = normalizeHandle(rawHandle)
        url = rawUrl ?? ''
      }
    }

    if (channel === undefined || handle === undefined || handle === '') {
      rejected.push({
        source_row,
        reason:
          rawUrl === undefined && rawHandle === undefined
            ? '这一行既没有链接也没有账号名，认不出是谁。'
            : `认不出这是哪个渠道的账号（${rawUrl ?? rawHandle ?? ''}）——把主页链接贴全一点就能认。`,
      })
      continue
    }

    const key = `${channel}|${handle}`
    const first = seen.get(key)
    if (first !== undefined) {
      duplicates.push({ source_row, same_as_row: first, handle, channel })
      continue
    }
    seen.set(key, source_row)

    accounts.push({
      channel,
      handle,
      url: url ?? '',
      source_row,
      ...(fieldAt(row, 'display_name') === undefined
        ? {}
        : { display_name: fieldAt(row, 'display_name') as string }),
      ...(num(fieldAt(row, 'followers')) === undefined
        ? {}
        : { followers: Math.round(num(fieldAt(row, 'followers')) as number) }),
      ...(rate(fieldAt(row, 'engagement_rate')) === undefined
        ? {}
        : { engagement_rate: rate(fieldAt(row, 'engagement_rate')) as number }),
      ...(fieldAt(row, 'category') === undefined
        ? {}
        : { category: fieldAt(row, 'category') as string }),
      ...(fieldAt(row, 'language') === undefined
        ? {}
        : { language: fieldAt(row, 'language') as string }),
      ...(fieldAt(row, 'region') === undefined
        ? {}
        : { region: (fieldAt(row, 'region') as string).toUpperCase() }),
      ...(fieldAt(row, 'email') === undefined ? {} : { email: fieldAt(row, 'email') as string }),
    })
  }

  return { accounts, duplicates, rejected, mapping }
}

/** 导完之后给人看的那一句话（36 §1：说清楚发生了什么）。 */
export function importSummary(result: ImportResult): string {
  const parts = [`认出 ${result.accounts.length} 个账号`]
  if (result.duplicates.length > 0) parts.push(`重复 ${result.duplicates.length} 行已合并`)
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} 行认不出来`)
  if (result.mapping.unmapped.length > 0)
    parts.push(`没用上的列：${result.mapping.unmapped.join('、')}`)
  return `${parts.join('，')}。`
}
