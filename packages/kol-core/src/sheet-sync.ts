/**
 * WP509（决策 1730 B、1811）：**把红人同步到用户自己的在线表**——纯逻辑（认列、阶段词对选项、认行、算这一批写什么）。
 *
 * 真正写表的那一跳在服务端（`apps/server/src/kol-sync/`，经 ego 在用户已登录的浏览器里原生粘贴）；
 * 这里没有 IO、没有时钟、没有模型，只回答四件事：
 *
 * 1. **哪一列放什么**（{@link proposeSyncColumns}）：表头按规则认（与 WP489 导入同一张别名表 `guessSheetField`），
 *    规则认不出的才用 AI 在工具入参里给的提议；规则认出来的 AI 改不了（1709 的认列做法）。
 * 2. **按哪一列认行**（{@link pickKeyColumn}）：主页链接 > 账号 > 邮箱 > 名字。
 * 3. **我们的阶段词 → 用户单选列里已有的选项**（{@link mapStagesToOptions}）：先一字不差，再按导入那张状态词表；
 *    对不上的留空（卡上让人选），**不擅自在飞书里新建选项**（除非用户在卡上勾了同意）。
 * 4. **这一批写什么**（{@link planSync}）：新的人追加一行；已在表里的只改变了的那几格；
 *    认不准那一行时退回「追加一行带时间的进展记录」。
 *
 * 纪律（docs/29「数字不经模型手」）：写进表的值全是从红人库里直接取的，AI 只决定「哪一列放哪个字段」。
 */
import type { CollaborationStage } from '@agentsws/contracts'
import {
  guessSheetField,
  guessStatusStage,
  type SheetField,
  sniffSheetField,
} from './sheet-import.js'
import { collaborationStageName, FUNNEL_ORDER } from './stages.js'
import { normalizeHandle, parseCreatorUrl } from './urls.js'

/** 能同步的字段（列对照的右边只能是这些，或留空）。`zh` 是卡上的名字。 */
export const SYNC_FIELDS = [
  { id: 'name', zh: '名字' },
  { id: 'channel', zh: '平台' },
  { id: 'handle', zh: '账号' },
  { id: 'url', zh: '主页链接' },
  { id: 'followers', zh: '粉丝数' },
  { id: 'engagement', zh: '互动率' },
  { id: 'email', zh: '邮箱' },
  { id: 'category', zh: '类目' },
  { id: 'region', zh: '地区' },
  { id: 'language', zh: '语言' },
  { id: 'stage', zh: '合作阶段' },
  { id: 'stage_date', zh: '阶段更新日期' },
  { id: 'last_activity', zh: '最近往来' },
  { id: 'amount', zh: '金额' },
  { id: 'currency', zh: '币种' },
  { id: 'sample_tracking', zh: '寄样单号' },
  { id: 'content_url', zh: '发布链接' },
  { id: 'tags', zh: '标签' },
  { id: 'progress', zh: '最新进展' },
  { id: 'synced_at', zh: '同步时间' },
] as const

export type SyncField = (typeof SYNC_FIELDS)[number]['id']

export const isSyncField = (v: unknown): v is SyncField =>
  typeof v === 'string' && SYNC_FIELDS.some((f) => f.id === v)

export const syncFieldName = (f: SyncField): string => SYNC_FIELDS.find((x) => x.id === f)?.zh ?? f

/** 同步什么（用户一句话定；卡上三个勾）。 */
export interface SyncWhat {
  /** 开了同步之后新进红人库的人：追加一行。 */
  new_creators: boolean
  /** 合作阶段变了：改「阶段」那几格（表里没有这个人就追加一行）。 */
  stages: boolean
  /** 合作记录（金额、寄样单号、发布链接、最近往来、最新进展）变了：改那几格。 */
  collab_records: boolean
}

export const DEFAULT_SYNC_WHAT: SyncWhat = {
  new_creators: true,
  stages: true,
  collab_records: true,
}

/** 阶段变了要改的几格。 */
export const STAGE_FIELDS: readonly SyncField[] = ['stage', 'stage_date']
/** 合作记录变了要改的几格。 */
export const COLLAB_FIELDS: readonly SyncField[] = [
  'last_activity',
  'amount',
  'currency',
  'sample_tracking',
  'content_url',
  'progress',
]

/** 认行用哪一列（越靠前越准）。 */
export const KEY_FIELDS: readonly SyncField[] = ['url', 'handle', 'email', 'name']

/** 目标表的一列（读表头读出来的）。`readonly` = 公式 / 自动编号 / 人员 / 附件这类粘不进去的。 */
export interface SyncTableColumn {
  name: string
  type: 'text' | 'number' | 'select' | 'multi_select' | 'date' | 'url' | 'checkbox' | 'readonly'
  /** 单选 / 多选列已有的选项（多维表格复制出来的那份表头里带）。 */
  options?: string[]
}

/** 列对照里的一列。`field: null` = 这一列不写。 */
export interface SyncColumn extends SyncTableColumn {
  field: SyncField | null
  /** 这一列是规则认的（AI 改不了）、AI 提的、还是人在卡上改的。 */
  by?: 'rule' | 'ai' | 'person'
}

/** WP489 导入的字段 → 同步的字段（导入里没有的几样另认）。 */
const FROM_SHEET: Partial<Record<SheetField, SyncField>> = {
  display_name: 'name',
  url: 'url',
  handle: 'handle',
  channel: 'channel',
  email: 'email',
  followers: 'followers',
  engagement_rate: 'engagement',
  category: 'category',
  language: 'language',
  region: 'region',
  status: 'stage',
  amount: 'amount',
  currency: 'currency',
  date: 'stage_date',
  notes: 'progress',
  content_url: 'content_url',
}

/** 导入那张表没有、同步要认的几样（子串；比导入那张先认）。 */
const EXTRA_HINTS: ReadonlyArray<{ field: SyncField; patterns: readonly string[] }> = [
  { field: 'sample_tracking', patterns: ['寄样单号', '快递单号', '运单', '物流单号', 'tracking'] },
  { field: 'tags', patterns: ['标签', 'tag'] },
  {
    field: 'last_activity',
    patterns: ['最近往来', '最近联系', '上次联系', '最后联系', 'last contact', 'last activity'],
  },
  { field: 'synced_at', patterns: ['同步时间', '同步于', 'synced', 'last sync'] },
  { field: 'progress', patterns: ['最新进展', '进展记录', '跟进记录', 'latest update'] },
]

/** 一个表头规则上认成哪个字段（认不出 = undefined）。 */
export function guessSyncField(
  header: string,
  samples: readonly string[] = [],
): SyncField | undefined {
  const lower = header.trim().toLowerCase()
  if (lower === '') return undefined
  let best: { field: SyncField; len: number } | undefined
  for (const h of EXTRA_HINTS)
    for (const p of h.patterns)
      if (lower.includes(p) && (best === undefined || p.length > best.len))
        best = { field: h.field, len: p.length }
  if (best !== undefined) return best.field
  const sheet = guessSheetField(header) ?? sniffSheetField(samples)
  return sheet === null ? undefined : FROM_SHEET[sheet]
}

/**
 * 表头 + 每列样本 + AI 的提议 → 列对照。每个字段最多用一次（先到先得）；`readonly` 列永远不写；
 * 规则认出来的不让 AI 改；AI 提的字段不认得就当没提。
 */
export function proposeSyncColumns(
  columns: readonly SyncTableColumn[],
  samples: readonly (readonly string[])[] = [],
  hints: readonly { column: string; field: unknown }[] = [],
): SyncColumn[] {
  const taken = new Set<SyncField>()
  const ruled = columns.map((c, i) => {
    if (c.type === 'readonly') return undefined
    const f = guessSyncField(
      c.name,
      samples.map((r) => r[i] ?? ''),
    )
    if (f === undefined || taken.has(f)) return undefined
    taken.add(f)
    return f
  })
  return columns.map((c, i): SyncColumn => {
    const rule = ruled[i]
    if (rule !== undefined) return { ...c, field: rule, by: 'rule' }
    if (c.type === 'readonly') return { ...c, field: null }
    const hint = hints.find((h) => h.column.trim() === c.name.trim())?.field
    if (isSyncField(hint) && !taken.has(hint)) {
      taken.add(hint)
      return { ...c, field: hint, by: 'ai' }
    }
    return { ...c, field: null }
  })
}

/** 认行那一列（没有能认行的列 = undefined：只能追加）。 */
export function pickKeyColumn(columns: readonly SyncColumn[]): SyncColumn | undefined {
  for (const f of KEY_FIELDS) {
    const hit = columns.find((c) => c.field === f)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** 我们的阶段 → 用户那一列里的选项（对不上 = null）。 */
export type StageOptionMap = Partial<Record<CollaborationStage, string | null>>

/**
 * 单选列已有的选项 → 我们十个阶段各落到哪一个：先一字不差（「已寄样」），再按导入那张状态词表（「寄样中」→ 已寄样）；
 * 一个选项只给一个阶段（先到先得，按漏斗顺序）。
 */
export function mapStagesToOptions(options: readonly string[]): StageOptionMap {
  const out: StageOptionMap = {}
  const used = new Set<string>()
  for (const stage of FUNNEL_ORDER) {
    const zh = collaborationStageName(stage)
    const exact = options.find((o) => o.trim() === zh || o.trim().toLowerCase() === stage)
    if (exact !== undefined && !used.has(exact)) {
      out[stage] = exact
      used.add(exact)
    }
  }
  for (const stage of FUNNEL_ORDER) {
    if (out[stage] !== undefined) continue
    const guess = options.find((o) => !used.has(o) && guessStatusStage(o) === stage)
    if (guess !== undefined) {
      out[stage] = guess
      used.add(guess)
    } else out[stage] = null
  }
  return out
}

/** 归一一格「认行」的值：主页链接按渠道 + 账号；账号去 @；邮箱小写；名字去空白小写。 */
export function syncKeyOf(field: SyncField, raw: string): string {
  const text = raw.trim()
  if (text === '') return ''
  if (field === 'url') {
    const p = parseCreatorUrl(text)
    if (p !== undefined && p.target === 'profile' && p.handle !== '')
      return `${p.channel}:${normalizeHandle(p.handle)}`
    return text
      .toLowerCase()
      .replace(/^https?:\/\//u, '')
      .replace(/^www\./u, '')
      .replace(/[?#].*$/u, '')
      .replace(/\/+$/u, '')
  }
  if (field === 'handle') return normalizeHandle(text)
  if (field === 'email') return text.toLowerCase()
  return text.toLowerCase().replace(/\s+/gu, ' ')
}

/* ── 这一批写什么 ─────────────────────────────────────────────────────── */

/** 一个红人在表里该是什么样（服务端从红人库里取好的值；没有的格子不给）。 */
export interface SyncCreatorRow {
  creator_id: string
  /** 字段 → 人看的字（阶段那一格另给 `stage`，下面按选项翻）。 */
  values: Partial<Record<SyncField, string>>
  stage?: CollaborationStage
  /** 开了同步之后才进红人库的人。 */
  new_since_on: boolean
  /** 有在走的合作（不算演练、不算还没人点头的）。 */
  in_pipeline: boolean
}

/** 一个人在这张表里上一次的样子（写进去的 / 第一次对上时看到的）。 */
export interface SyncRowState {
  /** 表里认行那一格的原字（下一次按它找那一行）；没有 = 只能追加（表里没有认行的列）。 */
  key_text?: string
  /** 各列上一次的字（列名 → 字）。 */
  cells: Record<string, string>
  /** 追加过一行（没有认行列时靠它不重复追加）。 */
  appended?: boolean
}

/** 读回来的整张表（表头 + 数据行，按视图里的顺序）。 */
export interface SyncTableSnapshot {
  header: string[]
  rows: string[][]
}

export type SyncOp =
  | { id: string; op: 'append'; creator_id: string; cells: Record<string, string>; progress?: true }
  | {
      id: string
      op: 'update'
      creator_id: string
      key_text: string
      cells: Record<string, string>
      /** 认不准那一行时退回：追加一行带时间的进展记录。 */
      fallback: Record<string, string>
    }

export interface SyncPlanInput {
  columns: readonly SyncColumn[]
  key_column?: string | undefined
  what: SyncWhat
  stage_map: StageOptionMap
  allow_new_options: boolean
  rows: readonly SyncCreatorRow[]
  state: ReadonlyMap<string, SyncRowState>
  /** 最近一次读回来的整张表（第一次对上表里已有的人用）。 */
  snapshot?: SyncTableSnapshot | undefined
  /** 「同步时间」那一格写什么（服务端按本地时区排好）。 */
  now_text: string
  /** 一批最多几件（其余下一批）。 */
  max_ops?: number
}

export interface SyncPlan {
  ops: SyncOp[]
  /** 第一次在表里对上的人（记下认行的原字与那一行，当基线）。 */
  matched: { creator_id: string; key_text: string; cells: Record<string, string> }[]
  /** 有人在这一阶段、但单选列里没有对应选项（这一格没写）。 */
  unmapped_stages: CollaborationStage[]
  /** 超过一批上限、留到下一批的件数。 */
  deferred: number
}

export const SYNC_MAX_OPS = 30

/** 一格能写的字：不带制表符 / 换行（粘贴时会被拆成别的格子），最多 1000 字。 */
export const syncCellText = (raw: string): string =>
  raw
    .replace(/[\t\r\n]+/gu, ' ')
    .trim()
    .slice(0, 1000)

/** 单选 / 多选列里认一个值（大小写不敏感，回选项原字；没有 = undefined）。 */
const optionOf = (options: readonly string[] | undefined, value: string): string | undefined => {
  const v = value.trim().toLowerCase()
  return options?.find((o) => o.trim().toLowerCase() === v)
}

/** 一个人的一列写什么（不写 = undefined）。 */
export function syncCellFor(
  column: SyncColumn,
  row: SyncCreatorRow,
  input: Pick<SyncPlanInput, 'stage_map' | 'allow_new_options' | 'now_text'>,
): { text?: string; unmapped_stage?: CollaborationStage } {
  const f = column.field
  if (f === null || column.type === 'readonly') return {}
  const choosy = column.type === 'select' || column.type === 'multi_select'
  if (f === 'stage') {
    if (row.stage === undefined) return {}
    const mapped = input.stage_map[row.stage]
    if (typeof mapped === 'string' && mapped.trim() !== '') return { text: syncCellText(mapped) }
    if (choosy && !input.allow_new_options) return { unmapped_stage: row.stage }
    return { text: collaborationStageName(row.stage) }
  }
  const raw = f === 'synced_at' ? input.now_text : row.values[f]
  if (raw === undefined || raw.trim() === '') return {}
  const text = syncCellText(raw)
  if (!choosy) return { text }
  const hit = optionOf(column.options, text)
  if (hit !== undefined) return { text: hit }
  return input.allow_new_options ? { text } : {}
}

/**
 * 算这一批：
 * - 表里有这个人（上次记下了认行的原字，或这次在读回的表里按认行列对上了）→ 只改**变了的、这次让改的**那几格
 *   （阶段变了改阶段那两格；合作记录变了改那几格；「同步时间」跟着改）；认不准那一行时由写的那一跳退回进展行；
 * - 表里没有、这次该写进去的（在走合作的人 / 开了同步之后新进库的人）→ 追加一行；
 * - 没有认行列、又追加过的人：变了就追加一行进展记录（不覆盖、不重复）。
 */
export function planSync(input: SyncPlanInput): SyncPlan {
  const max = input.max_ops ?? SYNC_MAX_OPS
  const writable = input.columns.filter((c) => c.field !== null && c.type !== 'readonly')
  const keyCol = writable.find((c) => c.name === input.key_column)
  const keyField = keyCol?.field ?? undefined
  const updatable = new Set<SyncField>([
    ...(input.what.stages ? STAGE_FIELDS : []),
    ...(input.what.collab_records ? COLLAB_FIELDS : []),
  ])
  const synced = writable.find((c) => c.field === 'synced_at')
  const progressCol = writable.find((c) => c.field === 'progress')
  const header = input.snapshot?.header ?? []
  const keyIdx = keyCol === undefined ? -1 : header.indexOf(keyCol.name)
  const snapshotIndex = new Map<string, string[]>()
  if (keyIdx >= 0 && keyField !== undefined)
    for (const r of input.snapshot?.rows ?? []) {
      const k = syncKeyOf(keyField, r[keyIdx] ?? '')
      if (k !== '' && !snapshotIndex.has(k)) snapshotIndex.set(k, r)
    }
  const ops: SyncOp[] = []
  const matched: SyncPlan['matched'] = []
  const unmapped = new Set<CollaborationStage>()
  let deferred = 0
  let seq = 0
  const push = (op: SyncOp): void => {
    if (ops.length >= max) deferred += 1
    else ops.push(op)
  }
  // 在走合作的人排前面（阶段是人最关心的那一格）
  const order = [...input.rows].sort((a, b) => Number(b.in_pipeline) - Number(a.in_pipeline))
  for (const row of order) {
    const inScope =
      (row.in_pipeline && (input.what.stages || input.what.collab_records)) ||
      (row.new_since_on && input.what.new_creators)
    if (!inScope) continue
    const desired: Record<string, string> = {}
    for (const c of writable) {
      const got = syncCellFor(c, row, input)
      if (got.unmapped_stage !== undefined) unmapped.add(got.unmapped_stage)
      if (got.text !== undefined && got.text !== '') desired[c.name] = got.text
    }
    if (Object.keys(desired).length === 0) continue
    const st = input.state.get(row.creator_id)
    let keyText = st?.key_text
    let baseline = st?.cells
    if (keyText === undefined && keyCol !== undefined && keyField !== undefined) {
      const mine = desired[keyCol.name]
      const hit = mine === undefined ? undefined : snapshotIndex.get(syncKeyOf(keyField, mine))
      if (hit !== undefined) {
        keyText = hit[keyIdx] ?? ''
        baseline = Object.fromEntries(header.map((h, i) => [h, hit[i] ?? '']))
        matched.push({ creator_id: row.creator_id, key_text: keyText, cells: baseline })
      }
    }
    const changedOf = (base: Record<string, string> | undefined): string[] =>
      writable
        .filter((c) => c.field !== null && updatable.has(c.field))
        .map((c) => c.name)
        .filter((name) => desired[name] !== undefined && desired[name] !== (base?.[name] ?? ''))
    const progressRow = (): Record<string, string> => ({
      ...desired,
      ...(progressCol === undefined
        ? {}
        : {
            [progressCol.name]: syncCellText(
              `${input.now_text} ${row.stage === undefined ? '' : collaborationStageName(row.stage)} ${desired[progressCol.name] ?? ''}`,
            ),
          }),
    })
    if (keyText !== undefined && keyText !== '') {
      const changed = changedOf(baseline)
      if (changed.length === 0) continue
      const cells: Record<string, string> = {}
      for (const name of changed) cells[name] = desired[name] as string
      if (synced !== undefined && desired[synced.name] !== undefined)
        cells[synced.name] = desired[synced.name] as string
      seq += 1
      push({
        id: `u${seq}`,
        op: 'update',
        creator_id: row.creator_id,
        key_text: keyText,
        cells,
        fallback: progressRow(),
      })
      continue
    }
    if (st?.appended === true) {
      // 没有认行列：变了就追加一行进展记录
      if (changedOf(st.cells).length === 0) continue
      seq += 1
      push({
        id: `p${seq}`,
        op: 'append',
        creator_id: row.creator_id,
        cells: progressRow(),
        progress: true,
      })
      continue
    }
    seq += 1
    push({ id: `a${seq}`, op: 'append', creator_id: row.creator_id, cells: desired })
  }
  return { ops, matched, unmapped_stages: [...unmapped], deferred }
}
