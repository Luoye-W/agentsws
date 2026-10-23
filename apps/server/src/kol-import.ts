/**
 * WP489（决策 1683–1686）：红人表格 / 在线表导入，与「读过往邮件判合作阶段」——带副作用的那一半。
 * 纯逻辑（认列、状态对照、只补空白、邮件判阶段、在线表读法）全在 `@agentsws/kol-core` 的
 * `sheet-import.ts` / `mail-stage.ts` / `online-sheet.ts`；这里只把它们接到库、加密库、模型、
 * 浏览器、邮箱与卡片上。
 *
 * 两条路：
 *
 * 1. **导表**：文件（xlsx / xls / csv / tsv）或在线表格链接 → 预览（什么都不写）→ 人看完、可改列与状态
 *    对照 → 导入。已有红人只补空白；带状态的行建合作，结束了的挂「历史合作（导入）」那个归档活动。
 *    对话里拖进来的表 / 贴的链接，同一份预览出成一张卡，点「导入」就导。
 * 2. **邮件判阶段**：先估（几个人、几封、大概多少钱）→ 跑。只取与红人有关的往来（按红人邮箱、
 *    以及非公共邮箱的域名），一人一次调用；模型给的依据必须是信里真有的话，对不上退回规则。
 *    与表格写的不一样 → 出一张卡让人选；一样或表格没写 → 直接更新并留痕（依据记在合作上）。
 *
 * 导入 / 更新的红人走现有那条上云的路：本机库写进去，私有云库的同步按快照差异自己带上
 * （`kol-cloud-sync.ts`），这里不另开一条。
 */
import { Buffer } from 'node:buffer'
import type {
  ExtensionProfileRow,
  KolActor,
  KolImportCommitView,
  KolImportPreviewView,
  KolMailStageEstimateView,
  KolMailStageRunView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  Collaboration,
  CollaborationStage,
  Creator,
  EventEnvelope,
  KolChannel,
  KolExchange,
  KolStageEvidence,
  MessageRecord,
  PersonId,
  PlatformAccount,
  WorkspaceId,
} from '@agentsws/contracts'
import { suppressionKey } from '@agentsws/core'
import { readSpreadsheet } from '@agentsws/knowledge'
import {
  channelOfWord,
  collaborationStageName,
  columnMappingPrompt,
  columnSamples,
  distinctStatuses,
  estimateMailStage,
  fillBlanks,
  gridFromRead,
  guessSheetField,
  guessStatusStage,
  importNoteOf,
  isCollaborationStage,
  isHistoricalStage,
  isSheetField,
  judgeThreadByRules,
  LEGACY_IMPORT_CAMPAIGN_ID,
  LEGACY_IMPORT_CAMPAIGN_NAME,
  locateHeader,
  looksLikeCollab,
  type MailStage,
  type MailStageVerdict,
  type MatchCreator,
  type MatchMail,
  mailStagePrompt,
  matchPrompt,
  matchThread,
  normalizeHandle,
  normalizeSheetRow,
  type OnlinePageRead,
  onlineSheetBlock,
  onlineSheetMessage,
  onlineSheetPlan,
  parseColumnMapping,
  parseMailStage,
  parseMatch,
  parseStatusMapping,
  planSheetImport,
  reconcileStage,
  resolveColumnMap,
  resolveStatusMap,
  type SheetColumnMap,
  type SheetRow,
  type SheetTable,
  type StageMail,
  type StatusMappingEntry,
  sheetImportSummary,
  sheetRowKey,
  sniffSheetField,
  stageRank,
  statusMappingPrompt,
  trimThread,
} from '@agentsws/kol-core'
import type { KolStore } from './kol.js'
import { CONTACT_SECRET_FIELD, contactSecretId } from './kol-service.js'
import type { SecretStore } from './secret-store.js'

/** 预览存多久（人看完点导入；过了就让他再拖一次）。 */
export const IMPORT_JOB_TTL_MS = 2 * 60 * 60 * 1000
/** 默认回看几个月（决策 1686，卡上 / 面板上可改）。 */
export const DEFAULT_MAIL_MONTHS = 12
/** 一次最多判几个人（再多分几次跑；免得一次把预算花光）。 */
export const MAX_MAIL_CREATORS = 300
/** 「没对上 / 拿不准」那张卡上最多列几段往来、几个人。 */
export const MAX_CARD_ROWS = 20
/** 「对不上人的往来」那张卡（决策 1709）。 */
export const KOL_MAIL_MATCH_FORM = 'kol_mail_match'
export const KOL_MAIL_MATCH_PROPOSER = 'kol-mail-match'
/** 找「没对上任何人、但像合作往来」的那几个查询词（本机消息库全文查）。 */
const COLLAB_QUERY_WORDS = [
  'collab',
  'sponsor',
  'rate card',
  'media kit',
  '达人',
  '红人',
  '博主',
  '寄样',
]
/** 预览卡 / 冲突卡 / 邮件判阶段卡的提议人 id（卡被决定时据此认出来）。 */
export const KOL_IMPORT_PROPOSER = 'kol-import'
export const KOL_STAGE_PROPOSER = 'kol-stage'
export const KOL_MAIL_STAGE_PROPOSER = 'kol-mail-stage'

/** 公共邮箱：这些域名不能拿来「按域名对人」（一个 gmail 域名下是全世界）。 */
const FREE_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|icloud|me|mac|aol|proton|protonmail|pm|gmx|mail|yandex|zoho|qq|foxmail|163|126|sina|sohu|aliyun|naver|hanmail|daum|web|t-online|orange|free|comcast|hey)\./i

/** 模型那一跳（宿主注入；没接真模型回 `undefined`）。 */
export type KolModelCall = (input: {
  system: string
  user: string
  max_output_tokens: number
  run_id: string
}) => Promise<string>

/** 打开一个地址（宿主按用户的浏览器设置挑：插件里的浏览器 / 内置浏览器）。 */
export type KolPageReader = (url: string, as: 'page' | 'html') => Promise<OnlinePageRead>

export interface KolMailbox {
  store: {
    list(query: { q?: string; limit?: number }): Promise<MessageRecord[]> | MessageRecord[]
    /** 一段会话的全部信（有就用它把查到的几封补齐成整段）。 */
    thread?(thread_id: string): Promise<MessageRecord[]> | MessageRecord[]
  }
  /** 我们自己的邮箱地址。 */
  addresses(): string[]
  /** 这只邮箱本机存到哪一天了。 */
  floor?(address: string): string
  /** 往前补拉 `days` 天（下一轮同步生效）。 */
  backfill?(address: string, days: number): string
}

export interface KolImportOptions {
  workspace_id: WorkspaceId
  store: KolStore
  secrets: SecretStore
  clock: Clock
  approvals?: ApprovalBus
  random(): number
  appendEvent?(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 这个人现在能用的模型（只有 stub / 没接 → `undefined`，只按规则）。 */
  model?(actor: KolActor): KolModelCall | undefined
  /** 默认模型的价目（每百万 token；没填价 = 0）。 */
  price?(): { in: number; out: number; currency?: string } | undefined
  /** 模型网关这个月还剩多少（有上限才有）。 */
  budgetLeft?(actor: KolActor): Promise<number | undefined>
  readPage?: KolPageReader
  /**
   * 决策 1708：读在线表的几只浏览器，按优先级排（用户已登录的那几只：ego / 插件里的浏览器 / 内置浏览器）。
   * 每次现取（用户改了浏览器设置立刻生效）。和 `readPage` 都给时先试这几只。
   */
  readers?(): readonly { id: string; read: KolPageReader }[]
  mail?(): KolMailbox | undefined
  /**
   * 决策 1707：导入的红人把**公开资料**也送去公共红人库（与插件同一条转发路）。
   * 只收 {@link ExtensionProfileRow}：合作状态、金额、日期、备注、负责人在这个形状上没有位置。
   */
  contributePublic?(actor: KolActor, rows: ExtensionProfileRow[]): Promise<{ queued: number }>
}

interface ImportJob {
  id: string
  workspace_id: WorkspaceId
  person_id: PersonId
  source: string
  table: SheetTable
  map: SheetColumnMap
  statuses: StatusMappingEntry[]
  samples: string[][]
  currency: string
  created_ms: number
}

type MatchKindBy = 'address' | 'content' | 'model'

interface PendingThread {
  thread_id: string
  subject: string
  from: string
  at: string
  snippet: string
  mails: MessageRecord[]
  candidates: {
    creator_id: string
    name: string
    score: number
    signals: string[]
    handles: string[]
    note?: string
  }[]
}

interface Gathered {
  byCreator: {
    creator_id: string
    mails: StageMail[]
    records: Map<string, MessageRecord>
    by: MatchKindBy
  }[]
  /** 拿不准 / 没对上（但像合作往来）的几段。 */
  pending: PendingThread[]
  /** 表里来的红人，邮箱里一封都没对上的。 */
  missing: { creator_id: string; name: string; has_email: boolean }[]
  ours?: Set<string>
}

/**
 * 决策 1707：一个账号 → 送公共库的那一行。**只挑公开资料**——这个函数就是「送了什么」的唯一答案，
 * 有测试钉着：合作状态、金额、日期、备注、负责人一格都不许出现。
 */
export function publicProfileRow(
  display_name: string,
  a: PlatformAccount,
  email: string | undefined,
): ExtensionProfileRow {
  return {
    channel: a.channel,
    handle: a.handle,
    display_name,
    ...(a.url === '' ? {} : { url: a.url }),
    ...(a.followers === undefined ? {} : { followers: a.followers }),
    ...(a.engagement_rate === undefined ? {} : { engagement_rate: a.engagement_rate }),
    ...(a.category === undefined ? {} : { category: a.category }),
    ...(a.language === undefined ? {} : { language: a.language }),
    ...(a.region === undefined ? {} : { region: a.region }),
    ...(email === undefined ? {} : { email }),
    observed_at: a.observed_at,
  }
}

/** 一封消息库里的信 → 对人用的形状。 */
function matchMailOf(m: MessageRecord): MatchMail {
  return {
    id: m.id,
    thread_id: m.thread_id,
    from_email: suppressionKey(m.from.email),
    ...(m.from.name === undefined ? {} : { from_name: m.from.name }),
    to: [...m.to, ...m.cc].map((x) => suppressionKey(x.email)),
    at: m.date,
    subject: m.subject,
    text: m.text,
  }
}

/** 拿不准那段的候选人（给模型挑）。 */
function candidatesOf(p: PendingThread): { name: string; handles: string[]; note?: string }[] {
  return p.candidates.map((c) => ({
    name: c.name,
    handles: c.handles,
    ...(c.note === undefined ? {} : { note: c.note }),
  }))
}

/** 一堆信 → 判阶段用的形状（我们发的 = out）。 */
function stageMailsOf(records: Map<string, MessageRecord>, ours: ReadonlySet<string>): StageMail[] {
  return [...records.values()].map((m) => ({
    id: m.id,
    direction: ours.has(suppressionKey(m.from.email)) ? 'out' : 'in',
    at: m.date,
    subject: m.subject,
    text: m.text,
  }))
}

export interface KolImportAssembly {
  previewImport(
    actor: KolActor,
    input: {
      filename?: string | undefined
      content?: string | undefined
      content_base64?: string | undefined
      url?: string | undefined
    },
  ): Promise<KolImportPreviewView>
  commitImport(
    actor: KolActor,
    input: {
      job_id: string
      columns?: (string | null)[] | undefined
      statuses?: { source: string; stage: CollaborationStage | null }[] | undefined
      currency?: string | undefined
    },
  ): Promise<KolImportCommitView>
  estimateMailStages(
    actor: KolActor,
    input: { months?: number | undefined },
  ): Promise<KolMailStageEstimateView>
  runMailStages(
    actor: KolActor,
    input: { months?: number | undefined },
  ): Promise<KolMailStageRunView>
  /** 对话里拖进来的表：出一张预览卡（回那一句写在附件前面的话）。 */
  previewCard(
    actor: KolActor,
    input: { filename: string; content_base64?: string; url?: string },
  ): Promise<string>
  /** 对话里说「用邮件更新一下红人状态」：出一张预估卡。 */
  mailStageCard(actor: KolActor, input: { months?: number }): Promise<string>
  /** 这三种卡被决定了（不是这三种回 `false`）。 */
  onDecided(item: ApprovalItem): Promise<boolean>
}

const fileFormat = (name: string): 'xlsx' | 'xls' | 'csv' | 'tsv' | undefined => {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'xlsx' || ext === 'xlsm') return 'xlsx'
  if (ext === 'xls') return 'xls'
  if (ext === 'tsv') return 'tsv'
  if (ext === 'csv' || ext === 'txt') return 'csv'
  return undefined
}

/** 一张工作簿里挑那张红人表：认得出最多列的那一张。 */
function pickGrid(grids: readonly { name: string; rows: string[][] }[]): string[][] {
  let best: string[][] = []
  let score = -1
  for (const g of grids) {
    const t = locateHeader(g.rows)
    const s = t.headers.filter((h) => guessSheetField(h) !== null).length * 1000 + t.rows.length
    if (s > score) {
      best = g.rows
      score = s
    }
  }
  return best
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

export function createKolImport(options: KolImportOptions): KolImportAssembly {
  const { store, secrets, clock, workspace_id } = options
  const jobs = new Map<string, ImportJob>()
  let seq = 0
  const nextId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }
  const nowMs = () => Date.parse(clock.now())

  const emit = (type: string, actor: PersonId | undefined, payload: Record<string, unknown>) => {
    try {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type,
        actor:
          actor === undefined
            ? { kind: 'system', id: KOL_IMPORT_PROPOSER }
            : { kind: 'person', id: actor },
        correlation: { trace_id: `tr_kol_import_${clock.now()}` },
        payload,
      })
    } catch {
      // 事件写不进不挡导入
    }
  }

  const reveal = (value_ref: string): string | undefined => {
    try {
      return secrets.get(value_ref)?.[CONTACT_SECRET_FIELD]
    } catch {
      return undefined
    }
  }

  /** 邮箱（归一）→ 红人。每次预览 / 导入现建（库会变）。 */
  const emailIndex = (): Map<string, string> => {
    const out = new Map<string, string>()
    if (!secrets.available) return out
    for (const c of store.contacts()) {
      if (c.kind !== 'email') continue
      const v = reveal(c.value_ref)
      if (v !== undefined) out.set(suppressionKey(v), c.creator_id)
    }
    return out
  }

  const lookupOf = (emails: Map<string, string>) => (row: SheetRow) => {
    for (const a of row.accounts) {
      const hit = store
        .accounts({ channel: a.channel })
        .find((x) => normalizeHandle(x.handle) === a.handle)
      const creator = hit === undefined ? undefined : store.creator(hit.creator_id)
      if (creator !== undefined)
        return { creator_id: creator.id, display_name: creator.display_name }
    }
    for (const e of row.emails) {
      const id = emails.get(suppressionKey(e))
      const creator = id === undefined ? undefined : store.creator(id)
      if (creator !== undefined)
        return { creator_id: creator.id, display_name: creator.display_name }
    }
    return undefined
  }

  const rowsOf = (job: ImportJob): SheetRow[] =>
    job.table.rows.map((row, i) =>
      normalizeSheetRow({
        row,
        source_row: job.table.first_row + i,
        headers: job.table.headers,
        map: job.map,
        statuses: job.statuses,
      }),
    )

  const sweepJobs = () => {
    const now = nowMs()
    for (const [id, j] of jobs) if (now - j.created_ms > IMPORT_JOB_TTL_MS) jobs.delete(id)
  }

  /* ── 读表 ──────────────────────────────────────────────────────────── */

  type Grid = { ok: true; rows: string[][]; source: string } | { ok: false; message: string }

  const readFile = (input: {
    filename?: string | undefined
    content?: string | undefined
    content_base64?: string | undefined
  }): Grid => {
    const name = input.filename ?? 'table.csv'
    const format = fileFormat(name) ?? (input.content_base64 !== undefined ? 'xlsx' : 'csv')
    try {
      if (format === 'xlsx' || format === 'xls') {
        if (input.content_base64 === undefined)
          return { ok: false, message: 'Excel 文件要按原件传（不要先转成文字）。' }
        const grids = readSpreadsheet(
          format,
          new Uint8Array(Buffer.from(input.content_base64, 'base64')),
        )
        return { ok: true, rows: pickGrid(grids), source: name }
      }
      const text =
        input.content ??
        (input.content_base64 === undefined
          ? ''
          : Buffer.from(input.content_base64, 'base64').toString('utf8'))
      // csv / tsv：分隔符按表头那一行猜（与 `import.ts` 那一份同一个读法）
      const first = text.split(/\r?\n/, 1)[0] ?? ''
      const tabs = (first.match(/\t/g) ?? []).length
      const commas = (first.match(/,/g) ?? []).length
      const semis = (first.match(/;/g) ?? []).length
      if (format === 'tsv' || (tabs > commas && tabs > semis)) {
        const rows = text
          .replace(/^﻿/, '')
          .split(/\r?\n/)
          .map((l) => l.split('\t'))
        return { ok: true, rows, source: name }
      }
      const csv = semis > commas ? text.replace(/;/g, ',') : text
      const grids = readSpreadsheet('csv', new Uint8Array(Buffer.from(csv, 'utf8')))
      return { ok: true, rows: grids[0]?.rows ?? [], source: name }
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '这个文件读不出来。' }
    }
  }

  /**
   * 决策 1684 / 1708：按顺序试几只浏览器（宿主按用户设置排：WP493 接上 ego 的读页口后它排第一），
   * 每只按计划里的地址顺序读；读到表就停。全读不了再说是没登录、没权限还是读不出。
   */
  const readOnline = async (url: string): Promise<Grid> => {
    const plan = onlineSheetPlan(url)
    if (plan === undefined) return { ok: false, message: '这不是一条网页链接。' }
    const readers = [
      ...(options.readers?.() ?? []),
      ...(options.readPage === undefined ? [] : [{ id: 'default', read: options.readPage }]),
    ]
    if (readers.length === 0)
      return { ok: false, message: onlineSheetMessage('no_browser', plan.kind) }
    let block: 'login' | 'no_access' | undefined
    let reached = false
    for (const reader of readers)
      for (const r of plan.reads) {
        let read: OnlinePageRead
        try {
          read = await reader.read(r.url, r.as)
        } catch {
          continue
        }
        if (!read.ok) continue
        reached = true
        const blocked = onlineSheetBlock(read)
        if (blocked !== undefined) {
          block = blocked
          continue
        }
        const grid = gridFromRead(read)
        if (grid !== undefined) return { ok: true, rows: grid, source: url }
      }
    if (!reached) return { ok: false, message: onlineSheetMessage('no_browser', plan.kind) }
    return { ok: false, message: onlineSheetMessage(block ?? 'unreadable', plan.kind) }
  }

  /* ── 预览 ──────────────────────────────────────────────────────────── */

  const askModel = async (
    actor: KolActor,
    prompt: { system: string; user: string },
    tag: string,
  ) => {
    const call = options.model?.(actor)
    if (call === undefined) return undefined
    try {
      return await call({
        ...prompt,
        max_output_tokens: 1200,
        run_id: `kol_import_${tag}_${nextId('r')}`,
      })
    } catch {
      // 模型不在 / 超了上限：只按规则认，这是降级不是失败
      return undefined
    }
  }

  const viewOf = (
    job: ImportJob,
    extra: { approval_item_id?: string } = {},
  ): KolImportPreviewView => {
    const rows = rowsOf(job)
    const { plans, counts } = planSheetImport(rows, lookupOf(emailIndex()))
    const unmapped = job.map.filter((f) => f === null).length
    return {
      ok: true,
      job_id: job.id,
      source: job.source,
      summary: sheetImportSummary(counts, unmapped),
      columns: job.table.headers.map((header, i) => ({
        header,
        field: job.map[i] ?? null,
        samples: (job.samples[i] ?? []).slice(0, 3),
      })),
      statuses: job.statuses.map((s) => ({
        source: s.source,
        stage: s.stage,
        count: s.count,
        by: s.by,
      })),
      counts,
      rows: plans.slice(0, 20).map((p) => ({
        source_row: p.row.source_row,
        name: p.row.display_name ?? p.row.emails[0] ?? `第 ${p.row.source_row} 行`,
        action: p.action,
        ...(p.creator_name === undefined ? {} : { merge_into: p.creator_name }),
        ...(p.row.stage === undefined ? {} : { stage: p.row.stage }),
        historical: p.historical,
        ...(p.skip === undefined ? {} : { skip: p.skip }),
      })),
      currency: job.currency,
      ...extra,
    }
  }

  const previewImport: KolImportAssembly['previewImport'] = async (actor, input) => {
    sweepJobs()
    const grid =
      input.url !== undefined && input.content === undefined && input.content_base64 === undefined
        ? await readOnline(input.url)
        : readFile(input)
    if (!grid.ok) return { ok: false, message: grid.message, currency: 'USD' }
    const table = locateHeader(grid.rows)
    if (table.rows.every((r) => r.every((c) => c === '')))
      return { ok: false, message: '表里没有数据行。', source: grid.source, currency: 'USD' }
    const samples = columnSamples(table)
    // 规则认不出的列才问模型（列名 + 几个样本；表里的字围起来当数据）
    const unknown = table.headers.some(
      (h, i) => guessSheetField(h) === null && sniffSheetField(samples[i] ?? []) === null,
    )
    const aiCols = unknown
      ? parseColumnMapping(
          (await askModel(actor, columnMappingPrompt(table.headers, samples), 'cols')) ?? '',
          table.headers.length,
        )
      : new Map()
    const map = resolveColumnMap(table.headers, samples, aiCols)
    const counts = distinctStatuses(table, map)
    const unknownStatuses = [...counts.keys()].filter((s) => guessStatusStage(s) === null)
    const aiStatuses =
      unknownStatuses.length === 0
        ? new Map()
        : parseStatusMapping(
            (await askModel(actor, statusMappingPrompt(unknownStatuses), 'status')) ?? '',
            unknownStatuses,
          )
    const job: ImportJob = {
      id: nextId('kij'),
      workspace_id,
      person_id: actor.person_id,
      source: grid.source,
      table,
      map,
      statuses: resolveStatusMap(counts, aiStatuses),
      samples,
      currency: 'USD',
      created_ms: nowMs(),
    }
    jobs.set(job.id, job)
    emit('kol.import_previewed', actor.person_id, {
      job_id: job.id,
      rows: table.rows.length,
      columns: table.headers.length,
      by_model: aiCols.size + aiStatuses.size,
    })
    return viewOf(job)
  }

  /* ── 导入 ──────────────────────────────────────────────────────────── */

  const saveEmail = (
    creator_id: string,
    email: string,
    known: Map<string, string>,
    source: 'import' | 'mail_match' = 'import',
  ): boolean => {
    if (!secrets.available) return false
    const key = suppressionKey(email)
    if (known.get(key) === creator_id) return false
    if (known.has(key)) return false
    const id = nextId('ctc')
    const value_ref = contactSecretId(id)
    secrets.put(value_ref, { [CONTACT_SECRET_FIELD]: email.trim() })
    store.saveContact({ id, creator_id, kind: 'email', value_ref, source })
    known.set(key, creator_id)
    return true
  }

  const commitImport: KolImportAssembly['commitImport'] = async (actor, input) => {
    sweepJobs()
    const job = jobs.get(input.job_id)
    if (job === undefined || job.workspace_id !== actor.workspace_id)
      throw Object.assign(new Error('这份预览过期了，再传一次表。'), { code: 'not_found' })
    if (input.columns !== undefined)
      job.map = job.table.headers.map((_, i) => {
        const f = input.columns?.[i]
        return f === undefined
          ? (job.map[i] ?? null)
          : f === null
            ? null
            : isSheetField(f)
              ? f
              : null
      })
    if (input.statuses !== undefined)
      for (const s of input.statuses) {
        const hit = job.statuses.find((x) => x.source === s.source)
        if (hit !== undefined && (s.stage === null || isCollaborationStage(s.stage))) {
          hit.stage = s.stage
          hit.by = 'user'
        }
      }
    if (input.currency !== undefined) job.currency = input.currency
    const emails = emailIndex()
    const rows = rowsOf(job)
    const { plans } = planSheetImport(rows, lookupOf(emails))
    const now = clock.now()
    const out: KolImportCommitView = {
      summary: '',
      created_creators: 0,
      merged_creators: 0,
      created_accounts: 0,
      created_contacts: 0,
      created_collaborations: 0,
      updated_collaborations: 0,
      historical: 0,
      skipped: 0,
      campaign_id: LEGACY_IMPORT_CAMPAIGN_ID,
      campaign_name: LEGACY_IMPORT_CAMPAIGN_NAME,
    }
    /** 决策 1707：这次导入碰到的人 → 表里给的公开邮箱。 */
    const publicOf = new Map<string, Set<string>>()
    const importKeys = new Set(
      store
        .collaborations()
        .map((c) => c.import_key)
        .filter((k) => k !== undefined),
    )
    for (const plan of plans) {
      if (plan.action === 'skip') {
        out.skipped += 1
        continue
      }
      const row = plan.row
      let creator: Creator | undefined =
        plan.creator_id === undefined ? undefined : store.creator(plan.creator_id)
      if (creator === undefined) {
        creator = {
          id: nextId('cre'),
          display_name:
            row.display_name ?? row.accounts[0]?.handle ?? row.emails[0]?.split('@')[0] ?? '未命名',
          merged_from: [],
        }
        store.saveCreator(creator)
        out.created_creators += 1
      } else {
        const patch = fillBlanks<Creator>(
          creator,
          row.display_name === undefined ? {} : { display_name: row.display_name },
        )
        if (Object.keys(patch).length > 0) store.saveCreator({ ...creator, ...patch })
        out.merged_creators += 1
      }
      const creator_id = creator.id
      const pub = publicOf.get(creator_id) ?? new Set<string>()
      for (const e of row.emails) pub.add(e)
      publicOf.set(creator_id, pub)
      // 账号：库里已有的只补空白；属于别人的那个账号不动（同一个人合并要人点头）
      row.accounts.forEach((a, i) => {
        const profile = {
          url: a.url,
          ...(i === 0 && row.followers !== undefined ? { followers: row.followers } : {}),
          ...(i === 0 && row.engagement_rate !== undefined
            ? { engagement_rate: row.engagement_rate }
            : {}),
          ...(row.category === undefined ? {} : { category: row.category }),
          ...(row.language === undefined ? {} : { language: row.language }),
          ...(row.region === undefined ? {} : { region: row.region }),
        }
        const existing = store
          .accounts({ channel: a.channel })
          .find((x) => normalizeHandle(x.handle) === a.handle)
        if (existing !== undefined) {
          if (existing.creator_id !== creator_id) return
          const patch = fillBlanks(existing, profile)
          if (Object.keys(patch).length > 0) store.saveAccount({ ...existing, ...patch })
          return
        }
        store.saveAccount({
          id: nextId('pa'),
          creator_id,
          channel: a.channel,
          handle: a.handle,
          ...profile,
          observed_at: now,
        })
        out.created_accounts += 1
      })
      for (const e of row.emails) out.created_contacts += saveEmail(creator_id, e, emails) ? 1 : 0
      // 合作：表里有认得出的状态才建
      if (row.stage === undefined) continue
      const key = sheetRowKey(row)
      if (importKeys.has(key)) continue
      importKeys.add(key)
      const channel: KolChannel =
        row.accounts[0]?.channel ??
        store.accounts({ creator_id })[0]?.channel ??
        channelOfWord(Object.values(row.extras).join(' ')) ??
        'youtube'
      const historical = isHistoricalStage(row.stage)
      const at = row.date === undefined ? now : `${row.date}T00:00:00.000Z`
      const note = importNoteOf(row)
      if (!historical) {
        const open = store
          .collaborations({ channel })
          .find(
            (c) => c.creator_id === creator_id && c.stage !== 'closed' && c.stage !== 'declined',
          )
        if (open !== undefined) {
          // 已经有一条在走的：表格只能把它往前推（「已建联」不能把「谈条件中」打回去），备注只补空白
          const ahead = stageRank(row.stage) > stageRank(open.stage)
          store.saveCollaboration({
            ...open,
            ...(ahead
              ? { stage: row.stage, stage_source: 'import' as const, stage_changed_at: at }
              : {}),
            ...(open.import_note === undefined ? { import_note: note } : {}),
            import_key: key,
          })
          out.updated_collaborations += 1
          continue
        }
      }
      const currency = row.amount?.currency ?? job.currency
      const collab: Collaboration = {
        id: nextId('col'),
        creator_id,
        channel,
        stage: row.stage,
        currency,
        ...(row.amount === undefined ? {} : { budget: row.amount.value }),
        ...(stageRank(row.stage) >= stageRank('agreed') && row.date !== undefined
          ? { agreed_at: at }
          : {}),
        ...(historical ? { campaign_id: LEGACY_IMPORT_CAMPAIGN_ID } : {}),
        last_activity_at: at,
        stage_changed_at: at,
        stage_source: 'import',
        import_note: note,
        import_key: key,
      }
      store.saveCollaboration(collab)
      out.created_collaborations += 1
      if (historical) out.historical += 1
    }
    jobs.delete(job.id)
    // 决策 1707：公开资料（渠道、账号、主页、名字、粉丝 / 互动率、类目 / 语言 / 地区、公开邮箱）去公共红人库。
    // 读的是本机库里现在的值（只补空白之后的那一份），不是表里的生意数据。
    if (options.contributePublic !== undefined && publicOf.size > 0) {
      const rows: ExtensionProfileRow[] = []
      for (const [creator_id, emails] of publicOf) {
        const creator = store.creator(creator_id)
        if (creator === undefined || creator.sandbox === true) continue
        const email = [...emails][0]
        for (const a of store.accounts({ creator_id }))
          rows.push(publicProfileRow(creator.display_name, a, email))
      }
      try {
        out.public_library_queued = (await options.contributePublic(actor, rows)).queued
      } catch {
        // 云那一跳不挡导入
        out.public_library_queued = 0
      }
    }
    const parts = [`新增 ${out.created_creators} 人`, `合并 ${out.merged_creators} 人`]
    if (out.created_collaborations + out.updated_collaborations > 0)
      parts.push(
        `合作 ${out.created_collaborations + out.updated_collaborations} 条${
          out.historical > 0 ? `（${out.historical} 条进「${LEGACY_IMPORT_CAMPAIGN_NAME}」）` : ''
        }`,
      )
    if (out.skipped > 0) parts.push(`跳过 ${out.skipped} 行`)
    out.summary = `${parts.join(' · ')}。`
    emit('kol.sheet_imported', actor.person_id, {
      job_id: job.id,
      source_kind: /^https?:/i.test(job.source) ? 'link' : 'file',
      created_creators: out.created_creators,
      merged_creators: out.merged_creators,
      created_accounts: out.created_accounts,
      created_contacts: out.created_contacts,
      created_collaborations: out.created_collaborations,
      updated_collaborations: out.updated_collaborations,
      historical: out.historical,
      skipped: out.skipped,
    })
    return out
  }

  /* ── 邮件判阶段 ──────────────────────────────────────────────────────── */

  const sinceOf = (months: number): string => {
    const d = new Date(nowMs())
    d.setUTCMonth(d.getUTCMonth() - months)
    return d.toISOString()
  }

  /**
   * 决策 1709：每段往来是谁的——**综合判断**（`@agentsws/kol-core` 的 `matchThread`）：
   * 邮件本身（地址 / 独有域名 / 署名里的名字 / 正文里的主页链接与 @账号）+ 用户表里的记录（名字、账号、
   * 邮箱、备注里写过的邮箱与域名、日期）。只取与红人有关的往来：按红人的邮箱、域名、账号、名字和几个
   * 合作用词去本机消息库里查，不是整箱扫。对上的按人归堆；拿不准 / 没对上但像合作往来的，留给一张卡。
   */
  const gatherMatches = async (months: number, only?: ReadonlySet<string>): Promise<Gathered> => {
    const empty: Gathered = { byCreator: [], pending: [], missing: [] }
    const box = options.mail?.()
    if (box === undefined) return empty
    const since = sinceOf(months)
    const ours = new Set(box.addresses().map((a) => suppressionKey(a)))
    const ourDomains = new Set([...ours].map((a) => a.split('@')[1] ?? ''))
    const emailsOf = new Map<string, Set<string>>()
    if (secrets.available)
      for (const c of store.contacts()) {
        if (c.kind !== 'email') continue
        const v = reveal(c.value_ref)
        if (v === undefined) continue
        const set = emailsOf.get(c.creator_id) ?? new Set<string>()
        set.add(suppressionKey(v))
        emailsOf.set(c.creator_id, set)
      }
    // 按域名对人只用「只有这一个红人用」的域名：同一家经纪公司 / MCN 的域名下是好几个人
    const domainOwners = new Map<string, Set<string>>()
    for (const [creator_id, addrs] of emailsOf)
      for (const a of addrs) {
        const d = a.split('@')[1] ?? ''
        if (d === '' || FREE_MAIL.test(d) || ourDomains.has(d)) continue
        const set = domainOwners.get(d) ?? new Set<string>()
        set.add(creator_id)
        domainOwners.set(d, set)
      }
    const collabs = store.collaborations()
    const imported = new Set(
      collabs.filter((c) => c.import_note !== undefined).map((c) => c.creator_id),
    )
    const creators: MatchCreator[] = []
    for (const c of store.creators()) {
      if (c.sandbox === true) continue
      const emails = [...(emailsOf.get(c.id) ?? [])]
      const notes = collabs.filter((x) => x.creator_id === c.id && x.import_note !== undefined)
      const note = notes.map((x) => x.import_note).join('；')
      const dates = notes.flatMap((x) => [
        ...(x.import_note?.match(/日期：(\d{4}-\d{2}-\d{2})/)?.slice(1) ?? []),
        ...(x.stage_source === 'import' && x.last_activity_at !== undefined
          ? [x.last_activity_at]
          : []),
      ])
      creators.push({
        id: c.id,
        name: c.display_name,
        handles: store
          .accounts({ creator_id: c.id })
          .map((a) => ({ channel: a.channel, handle: a.handle })),
        emails,
        domains: emails
          .map((a) => a.split('@')[1] ?? '')
          .filter((d) => domainOwners.get(d)?.size === 1),
        ...(note === '' ? {} : { note }),
        ...(dates.length === 0 ? {} : { dates }),
      })
    }
    // 查哪些词：邮箱、独有域名；没有邮箱或从表里来的人再加名字与账号；再加几个合作用词（找没对上的）
    const terms = new Set<string>()
    for (const c of creators) {
      if (only !== undefined && !only.has(c.id)) continue
      for (const e of c.emails) terms.add(e)
      for (const d of c.domains) terms.add(`@${d}`)
      // 用户表里备注写过的邮箱（经纪人、助理）
      for (const e of c.note?.match(/[^\s@；;，,:：]+@[^\s@；;，,]+\.[a-z]{2,}/gi) ?? [])
        terms.add(e.toLowerCase())
      if (c.emails.length === 0 || imported.has(c.id)) {
        if (c.name.trim().length >= 4) terms.add(c.name.trim())
        for (const h of c.handles)
          if (normalizeHandle(h.handle).length >= 3) terms.add(normalizeHandle(h.handle))
      }
    }
    if (only === undefined) for (const w of COLLAB_QUERY_WORDS) terms.add(w)
    const found = new Map<string, MessageRecord>()
    for (const q of terms) {
      for (const m of await box.store.list({ q, limit: 300 }))
        if (m.date >= since) found.set(m.id, m)
    }
    // 信所在的那只邮箱也是「我们」（连接页一时取不到地址时，靠它分清谁发的）
    for (const m of found.values()) ours.add(suppressionKey(m.account))
    // 按会话归堆；有 `thread` 就把整段取齐（查到的可能只是其中几封）
    const threads = new Map<string, MessageRecord[]>()
    for (const m of found.values()) {
      const list = threads.get(m.thread_id) ?? []
      list.push(m)
      threads.set(m.thread_id, list)
    }
    if (box.store.thread !== undefined)
      for (const [id, list] of threads) {
        const full = (await box.store.thread(id)).filter((m) => m.date >= since)
        if (full.length > list.length) threads.set(id, full)
      }
    const pool = only === undefined ? creators : creators.filter((c) => only.has(c.id))
    const buckets = new Map<string, { mails: Map<string, MessageRecord>; by: MatchKindBy }>()
    const pending: PendingThread[] = []
    for (const [thread_id, list] of threads) {
      const external = list.some(
        (m) =>
          !ours.has(suppressionKey(m.from.email)) ||
          m.to.some((x) => !ours.has(suppressionKey(x.email))),
      )
      if (!external) continue
      const bulk = list.every(
        (m) => m.headers['list-unsubscribe'] !== undefined || m.headers['list-id'] !== undefined,
      )
      if (bulk) continue
      const match = matchThread(list.map(matchMailOf), pool, ours)
      if (match.kind === 'matched' && match.creator_id !== undefined) {
        const b = buckets.get(match.creator_id) ?? { mails: new Map(), by: match.by ?? 'content' }
        for (const m of list) b.mails.set(m.id, m)
        if (match.by === 'content') b.by = 'content'
        buckets.set(match.creator_id, b)
        continue
      }
      if (only !== undefined) continue
      if (match.kind === 'unmatched' && !list.some((m) => looksLikeCollab(m))) continue
      const first = [...list].sort((a, b) => a.date.localeCompare(b.date))[0] as MessageRecord
      const theirs = list.find((m) => !ours.has(suppressionKey(m.from.email))) ?? first
      pending.push({
        thread_id,
        subject: first.subject.slice(0, 120),
        from:
          theirs.from.name === undefined
            ? theirs.from.email
            : `${theirs.from.name} <${theirs.from.email}>`,
        at: first.date,
        snippet: theirs.snippet.slice(0, 160),
        mails: list,
        candidates: match.candidates.map((c) => {
          const who = creators.find((x) => x.id === c.creator_id)
          return {
            creator_id: c.creator_id,
            name: who?.name ?? c.creator_id,
            score: c.score,
            signals: c.signals,
            handles: (who?.handles ?? []).map((h) => `${h.channel} @${normalizeHandle(h.handle)}`),
            ...(who?.note === undefined ? {} : { note: who.note }),
          }
        }),
      })
    }
    const byCreator: Gathered['byCreator'] = []
    for (const [creator_id, b] of buckets) {
      byCreator.push({ creator_id, records: b.mails, by: b.by, mails: stageMailsOf(b.mails, ours) })
      if (byCreator.length >= MAX_MAIL_CREATORS) break
    }
    const seen = new Set(byCreator.map((x) => x.creator_id))
    const missing =
      only !== undefined
        ? []
        : creators
            .filter((c) => imported.has(c.id) && !seen.has(c.id))
            .slice(0, MAX_CARD_ROWS)
            .map((c) => ({ creator_id: c.id, name: c.name, has_email: c.emails.length > 0 }))
    pending.sort((a, b) => b.at.localeCompare(a.at))
    return { byCreator, pending: pending.slice(0, MAX_CARD_ROWS), missing, ours }
  }

  const backfillIfShort = (months: number): string | undefined => {
    const box = options.mail?.()
    if (box?.floor === undefined || box.backfill === undefined) return undefined
    const since = sinceOf(months)
    let from: string | undefined
    for (const a of box.addresses()) {
      const floor = box.floor(a)
      if (floor <= since) continue
      const days = Math.ceil((Date.parse(floor) - Date.parse(since)) / 86_400_000)
      box.backfill(a, days)
      from = floor
    }
    return from
  }

  const estimateMailStages: KolImportAssembly['estimateMailStages'] = async (actor, input) => {
    const months = input.months ?? DEFAULT_MAIL_MONTHS
    const connected = (options.mail?.()?.addresses().length ?? 0) > 0
    const g: Gathered = connected
      ? await gatherMatches(months)
      : { byCreator: [], pending: [], missing: [] }
    const price = options.price?.()
    const model = options.model?.(actor) !== undefined
    const est = estimateMailStage(
      g.byCreator.map((t) => t.mails),
      model ? price : undefined,
    )
    // 拿不准的那几段：有候选人的，模型帮着挑一次（一段一次调用），也算进预估
    const asks = model ? g.pending.filter((p) => p.candidates.length > 0) : []
    const askChars = asks.reduce((n, p) => {
      const pr = matchPrompt(p.mails.map(matchMailOf), candidatesOf(p))
      return n + pr.system.length + pr.user.length
    }, 0)
    const input_tokens = est.input_tokens + Math.ceil(askChars / 4)
    const output_tokens = est.output_tokens + asks.length * 20
    const cost =
      est.cost === undefined || price === undefined
        ? undefined
        : (input_tokens * price.in + output_tokens * price.out) / 1_000_000
    const backfill_from = connected ? backfillIfShort(months) : undefined
    const budget_left = model ? await options.budgetLeft?.(actor).catch(() => undefined) : undefined
    const money =
      cost === undefined
        ? ''
        : `，约 ${cost < 0.01 ? '<0.01' : cost.toFixed(2)} ${price?.currency ?? ''}`.trimEnd()
    const open = g.pending.length + g.missing.length
    const summary = !connected
      ? '还没连邮箱。'
      : est.creators === 0 && open === 0
        ? `近 ${months} 个月的邮件里没有对得上的红人往来。`
        : `近 ${months} 个月：对上 ${est.creators} 人、${est.messages} 封${
            open === 0 ? '' : `；${open} 处没对上，判完出一张卡给你补`
          }${
            model
              ? `，约 ${Math.round((input_tokens + output_tokens) / 1000)}k token${money}`
              : '（没接模型，按规则判，不花钱）'
          }`
    return {
      months,
      creators: est.creators,
      messages: est.messages,
      input_tokens,
      output_tokens,
      ...(cost === undefined ? {} : { cost }),
      ...(price?.currency === undefined || cost === undefined ? {} : { currency: price.currency }),
      model,
      ...(budget_left === undefined ? {} : { budget_left }),
      ...(backfill_from === undefined ? {} : { backfill_from }),
      uncertain: g.pending.length,
      unmatched_creators: g.missing.length,
      mail_connected: connected,
      summary,
    }
  }

  /** 把这几封往来记成红人往来（同一封只记一次），回邮件 id → 往来 id。 */
  const recordExchanges = (
    creator_id: string,
    collab: Collaboration | undefined,
    mails: readonly StageMail[],
    records: Map<string, MessageRecord>,
  ): Map<string, string> => {
    const ids = new Map<string, string>()
    const seen = new Map(
      store
        .exchanges({ creator_id })
        .filter((x) => x.mail_message_id !== undefined)
        .map((x) => [(x.mail_message_id ?? '').toLowerCase(), x.id]),
    )
    for (const m of mails) {
      const r = records.get(m.id)
      const mid = (r?.message_id ?? m.id).toLowerCase()
      const existing = seen.get(mid)
      if (existing !== undefined) {
        ids.set(m.id, existing)
        continue
      }
      const ex: KolExchange = {
        id: `xch_hist_${mid.replace(/[^a-z0-9_.-]/g, '_').slice(0, 80)}`,
        creator_id,
        ...(collab === undefined ? {} : { collaboration_id: collab.id }),
        channel: collab?.channel ?? store.accounts({ creator_id })[0]?.channel ?? 'youtube',
        direction: m.direction,
        subject: m.subject,
        body: m.text.slice(0, 20_000),
        at: m.at,
        mail_message_id: r?.message_id ?? m.id,
        ...(r?.account === undefined ? {} : { mailbox: r.account }),
      }
      store.saveExchange(ex)
      seen.set(mid, ex.id)
      ids.set(m.id, ex.id)
    }
    return ids
  }

  const stageCard = async (
    actor: KolActor,
    collab: Collaboration,
    verdict: MailStageVerdict,
    evidence: KolStageEvidence[],
  ): Promise<void> => {
    if (options.approvals === undefined) return
    const creator = store.creator(collab.creator_id)
    const name = creator?.display_name ?? collab.creator_id
    const sheet = collaborationStageName(collab.stage)
    const mail = collaborationStageName(verdict.stage)
    const choices = [
      { id: 'mail', label: `按邮件：${mail}` },
      { id: 'sheet', label: `按表格：${sheet}` },
    ]
    const quote = evidence[0]
    await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'collaboration', id: collab.id } },
      dedupe_key: `${workspace_id}:kol_stage:${collab.id}:${verdict.stage}`,
      title: `${name}：表格写「${sheet}」，邮件看是「${mail}」`,
      summary:
        quote === undefined
          ? '选一个。'
          : `依据：${quote.at.slice(0, 10)}「${quote.subject.slice(0, 60)}」——“${quote.quote}”`,
      payload: {
        collaboration_id: collab.id,
        creator_id: collab.creator_id,
        sheet_stage: collab.stage,
        mail_stage: verdict.stage,
        evidence,
        options: choices,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [{ type: 'collaboration', id: collab.id }] },
        diff: {
          before: { stage: collab.stage },
          after: { stage: verdict.stage },
          summary: `${sheet} → ${mail}`,
        },
        precheck: {},
      },
      proposer: { kind: 'system', id: KOL_STAGE_PROPOSER },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: actor.person_id, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: {
          after_hours: 72,
          business_hours: true,
          chain: ['scope_manager'],
          escalated_at: [],
        },
        separation_of_duties: false,
      },
      priority: 'queue',
      options: choices,
    })
  }

  const runMailStages: KolImportAssembly['runMailStages'] = async (actor, input) =>
    runWith(actor, input.months ?? DEFAULT_MAIL_MONTHS)

  const runWith = async (
    actor: KolActor,
    months: number,
    only?: ReadonlySet<string>,
  ): Promise<KolMailStageRunView> => {
    const g = await gatherMatches(months, only)
    const out: KolMailStageRunView = {
      summary: '',
      judged: 0,
      updated: 0,
      same: 0,
      conflicts: 0,
      by_model: 0,
      by_rule: 0,
      fallback: 0,
      matched_by_content: g.byCreator.filter((t) => t.by === 'content').length,
      unresolved: 0,
    }
    let call = options.model?.(actor)
    // 拿不准的几段：模型在候选人里挑一个（或者都不是）；挑中的并进那个人的往来
    const ours = g.ours ?? new Set<string>()
    const left: PendingThread[] = []
    for (const p of g.pending) {
      if (call === undefined || p.candidates.length === 0) {
        left.push(p)
        continue
      }
      let pick: number | null | undefined
      try {
        pick = parseMatch(
          await call({
            ...matchPrompt(p.mails.map(matchMailOf), candidatesOf(p)),
            max_output_tokens: 40,
            run_id: `kol_mail_match_${nextId('r')}`,
          }),
          p.candidates.length,
        )
      } catch (e) {
        const code = rec(e).code
        if (code === 'budget_exhausted' || code === 'halted') call = undefined
      }
      const chosen = typeof pick === 'number' ? p.candidates[pick] : undefined
      if (chosen === undefined) {
        left.push(p)
        continue
      }
      let bucket = g.byCreator.find((t) => t.creator_id === chosen.creator_id)
      if (bucket === undefined) {
        bucket = { creator_id: chosen.creator_id, records: new Map(), mails: [], by: 'model' }
        g.byCreator.push(bucket)
      }
      for (const m of p.mails) bucket.records.set(m.id, m)
      bucket.mails = stageMailsOf(bucket.records, ours)
      out.matched_by_model = (out.matched_by_model ?? 0) + 1
    }
    const threads = g.byCreator
    for (const t of threads) {
      const trimmed = trimThread(t.mails)
      let verdict: MailStageVerdict | undefined
      if (call !== undefined) {
        try {
          const text = await call({
            ...mailStagePrompt(trimmed),
            max_output_tokens: 400,
            run_id: `kol_mail_stage_${nextId('r')}`,
          })
          verdict = parseMailStage(text, trimmed)
          if (verdict === undefined) out.fallback += 1
        } catch (e) {
          // 预算到顶 / 急停 / 模型出错：剩下的一律按规则判（不再调）
          const code = rec(e).code
          if (code === 'budget_exhausted' || code === 'halted') call = undefined
          out.fallback += 1
        }
      }
      verdict ??= judgeThreadByRules(trimmed)
      if (verdict === undefined) continue
      out.judged += 1
      if (verdict.by === 'model') out.by_model += 1
      else out.by_rule += 1
      const collabs = store
        .collaborations()
        .filter((c) => c.creator_id === t.creator_id && c.campaign_id !== LEGACY_IMPORT_CAMPAIGN_ID)
        .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))
      const collab =
        collabs.find((c) => c.stage !== 'closed' && c.stage !== 'declined') ?? collabs[0]
      const ids = recordExchanges(t.creator_id, collab, t.mails, t.records)
      const evidence: KolStageEvidence[] = verdict.evidence.map((e) => ({
        message_id: ids.get(e.message_id) ?? e.message_id,
        at: e.at,
        direction: e.direction,
        subject: e.subject,
        quote: e.quote,
      }))
      const last = [...t.mails].sort((a, b) => b.at.localeCompare(a.at))[0]?.at ?? clock.now()
      const decision = reconcileStage(
        collab?.stage,
        collab?.stage_source,
        verdict.stage as MailStage,
      )
      if (collab === undefined) {
        const channel = store.accounts({ creator_id: t.creator_id })[0]?.channel ?? 'youtube'
        store.saveCollaboration({
          id: nextId('col'),
          creator_id: t.creator_id,
          channel,
          stage: verdict.stage,
          currency: 'USD',
          last_activity_at: last,
          stage_changed_at: evidence[0]?.at ?? last,
          stage_source: 'mail',
          stage_evidence: evidence,
        })
        out.updated += 1
      } else if (decision === 'apply') {
        store.saveCollaboration({
          ...collab,
          stage: verdict.stage,
          stage_source: 'mail',
          stage_evidence: evidence,
          stage_changed_at: evidence[0]?.at ?? last,
          last_activity_at:
            (collab.last_activity_at ?? '') > last ? (collab.last_activity_at as string) : last,
        })
        out.updated += 1
      } else if (decision === 'conflict') {
        await stageCard(actor, collab, verdict, evidence)
        out.conflicts += 1
      } else {
        // 一样 / 邮件比库里靠后：依据照样留下（红人页上看得到为什么是这一步）
        store.saveCollaboration({ ...collab, stage_evidence: evidence })
        out.same += 1
      }
      emit('kol.stage_from_mail', actor.person_id, {
        creator_id: t.creator_id,
        ...(collab === undefined ? {} : { collaboration_id: collab.id }),
        stage: verdict.stage,
        by: verdict.by,
        decision: collab === undefined ? 'created' : decision,
        evidence: evidence.map((e) => e.message_id),
      })
    }
    // 还对不上的：一张卡，人在卡里选 / 补邮箱
    out.unresolved = left.length + g.missing.length
    if (only === undefined && out.unresolved > 0) await matchCard(actor, months, left, g.missing)
    const parts = [`判了 ${out.judged} 人`, `更新 ${out.updated}`]
    if (out.conflicts > 0) parts.push(`${out.conflicts} 个和表格不一样，出了卡`)
    if (out.unresolved > 0) parts.push(`${out.unresolved} 处没对上，出了一张卡`)
    if (out.fallback > 0) parts.push(`${out.fallback} 个改按规则判`)
    out.summary = `${parts.join(' · ')}。`
    return out
  }

  /** 决策 1709：对不上人的往来、没找到往来的红人——一张卡，卡里就地选 / 补邮箱。 */
  const matchCard = async (
    actor: KolActor,
    months: number,
    pending: readonly PendingThread[],
    missing: Gathered['missing'],
  ): Promise<void> => {
    if (options.approvals === undefined) return
    const pool = new Map<string, string>()
    for (const p of pending) for (const c of p.candidates) pool.set(c.creator_id, c.name)
    for (const c of missing) pool.set(c.creator_id, c.name)
    for (const c of store.creators()) {
      if (pool.size >= 200) break
      if (c.sandbox !== true && !pool.has(c.id)) pool.set(c.id, c.display_name)
    }
    const title =
      pending.length > 0 && missing.length > 0
        ? `${pending.length} 段往来没对上红人，${missing.length} 个红人没找到往来`
        : pending.length > 0
          ? `${pending.length} 段往来没对上红人`
          : `${missing.length} 个红人没找到往来`
    await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'creator', id: `mail_match_${months}` } },
      dedupe_key: `${workspace_id}:kol_mail_match:${clock.now().slice(0, 13)}`,
      title,
      summary: '选一下是谁，或补个邮箱；不确定的留空。',
      payload: {
        form: KOL_MAIL_MATCH_FORM,
        actor,
        months,
        threads: pending.map((p) => ({
          thread_id: p.thread_id,
          subject: p.subject,
          from: p.from,
          at: p.at,
          snippet: p.snippet,
          candidates: p.candidates.map((c) => ({
            creator_id: c.creator_id,
            name: c.name,
            signals: c.signals,
          })),
        })),
        creators: missing,
        pool: [...pool].map(([creator_id, name]) => ({ creator_id, name })),
      },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        diff: {
          before: {},
          after: { threads: pending.length, creators: missing.length },
          summary: title,
        },
        precheck: {},
      },
      proposer: { kind: 'system', id: KOL_MAIL_MATCH_PROPOSER, assignment_id: actor.assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: routing(actor),
      priority: 'queue',
    })
  }

  /* ── 对话里的卡 ──────────────────────────────────────────────────────── */

  const routing = (actor: KolActor) => ({
    recipients: [{ person: actor.person_id, via: 'role_holder' as const }],
    rule: 'role_holder' as const,
    escalation: {
      after_hours: 72,
      business_hours: true,
      chain: ['scope_manager' as const],
      escalated_at: [] as string[],
    },
    separation_of_duties: false,
  })

  const previewCard: KolImportAssembly['previewCard'] = async (actor, input) => {
    const view = await previewImport(actor, {
      filename: input.filename,
      ...(input.content_base64 === undefined ? {} : { content_base64: input.content_base64 }),
      ...(input.url === undefined ? {} : { url: input.url }),
    })
    if (!view.ok || view.job_id === undefined) return view.message ?? '这张表读不出来。'
    if (options.approvals === undefined) return `红人表预览：${view.summary}`
    const choices = [
      { id: 'import', label: '导入' },
      { id: 'cancel', label: '不导' },
    ]
    const item = await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'creator', id: view.job_id } },
      dedupe_key: `${workspace_id}:kol_import:${view.job_id}`,
      title: `导入红人表：${view.source ?? input.filename}`,
      summary: view.summary ?? '',
      payload: {
        job_id: view.job_id,
        actor,
        counts: view.counts,
        columns: view.columns?.map((c) => ({ header: c.header, field: c.field })),
        statuses: view.statuses,
        options: choices,
      },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        diff: { before: {}, after: view.counts ?? {}, summary: view.summary ?? '' },
        precheck: {},
      },
      proposer: { kind: 'system', id: KOL_IMPORT_PROPOSER, assignment_id: actor.assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: routing(actor),
      priority: 'queue',
      options: choices,
    })
    return `这是一张红人表（${view.summary}）——出了一张「导入红人表」卡，点「导入」就导；要改认列或状态对照，到红人面板的导入里改。${
      item.state === 'blocked' ? '' : ''
    }`
  }

  const mailStageCard: KolImportAssembly['mailStageCard'] = async (actor, input) => {
    const months = input.months ?? DEFAULT_MAIL_MONTHS
    const est = await estimateMailStages(actor, { months })
    if (!est.mail_connected) return '还没连邮箱，读不了过往邮件——先在连接里连上邮箱。'
    if (est.creators === 0) return est.summary
    if (options.approvals === undefined) return est.summary
    const choices = [
      { id: `run_${months}`, label: `按近 ${months} 个月判` },
      ...(months === 24 ? [] : [{ id: 'run_24', label: '按近 24 个月判' }]),
      { id: 'cancel', label: '先不' },
    ]
    await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'creator', id: `mail_stage_${months}` } },
      dedupe_key: `${workspace_id}:kol_mail_stage:${clock.now().slice(0, 13)}`,
      title: '用过往邮件更新红人合作阶段',
      summary: est.summary,
      payload: { actor, months, estimate: est, options: choices },
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        diff: { before: {}, after: { creators: est.creators }, summary: est.summary },
        precheck: {},
      },
      proposer: { kind: 'system', id: KOL_MAIL_STAGE_PROPOSER, assignment_id: actor.assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: routing(actor),
      priority: 'queue',
      options: choices,
    })
    return `${est.summary}——出了一张卡，点了才开始判。`
  }

  const choiceOf = (item: ApprovalItem): string | undefined => {
    if (item.state === 'rejected' || item.state === 'withdrawn' || item.state === 'expired')
      return 'cancel'
    if (item.state !== 'approved' && item.state !== 'approved_edited' && item.state !== 'applied')
      return undefined
    const edited = rec(item.decision?.edited_payload)
    return (
      item.decision?.selected_option_id ??
      (typeof edited.selected_option_id === 'string' ? edited.selected_option_id : undefined)
    )
  }

  const actorOfItem = (item: ApprovalItem): KolActor => {
    const saved = rec(rec(item.payload).actor)
    const by = item.decision?.by
    return {
      workspace_id: item.workspace_id,
      person_id: (typeof by === 'string' && by !== 'mandate'
        ? by
        : saved.person_id) as KolActor['person_id'],
      assignment_id: (item.proposer.assignment_id ??
        saved.assignment_id ??
        '') as KolActor['assignment_id'],
      role_id: item.role_id,
    }
  }

  /**
   * 「没对上」那张卡批了：卡里选了是谁的那几段 → 把对方的邮箱记到这个红人名下（来源 `mail_match`，人定的）；
   * 卡里补了邮箱的 → 记上。然后只对这几个人再判一次阶段（不再出这张卡）。
   */
  const onMatchDecided = async (item: ApprovalItem): Promise<void> => {
    if (item.state !== 'approved' && item.state !== 'approved_edited' && item.state !== 'applied')
      return
    const edited = rec(item.decision?.edited_payload)
    const payload = rec(item.payload)
    const actor = actorOfItem(item)
    const months = typeof payload.months === 'number' ? payload.months : DEFAULT_MAIL_MONTHS
    const box = options.mail?.()
    const ours = new Set((box?.addresses() ?? []).map((a) => suppressionKey(a)))
    const known = emailIndex()
    const touched = new Set<string>()
    const assign = Array.isArray(edited.assign) ? (edited.assign as unknown[]) : []
    for (const a of assign) {
      const thread_id = rec(a).thread_id
      const creator_id = rec(a).creator_id
      if (typeof thread_id !== 'string' || typeof creator_id !== 'string') continue
      if (store.creator(creator_id) === undefined) continue
      const mails = (await box?.store.thread?.(thread_id)) ?? []
      for (const m of mails) ours.add(suppressionKey(m.account))
      for (const m of mails) {
        const from = suppressionKey(m.from.email)
        if (ours.has(from) || known.has(from)) continue
        if (saveEmail(creator_id, m.from.email, known, 'mail_match')) touched.add(creator_id)
      }
      touched.add(creator_id)
    }
    const emails = Array.isArray(edited.emails) ? (edited.emails as unknown[]) : []
    for (const e of emails) {
      const creator_id = rec(e).creator_id
      const email = rec(e).email
      if (typeof creator_id !== 'string' || typeof email !== 'string') continue
      const v = email.trim().toLowerCase()
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v) || store.creator(creator_id) === undefined)
        continue
      saveEmail(creator_id, v, known, 'mail_match')
      touched.add(creator_id)
    }
    emit('kol.mail_match_resolved', actor.person_id, {
      threads: assign.length,
      emails: emails.length,
      creators: [...touched],
    })
    if (touched.size > 0) await runWith(actor, months, touched)
  }

  const onDecided: KolImportAssembly['onDecided'] = async (item) => {
    if (item.workspace_id !== workspace_id || item.kind !== 'policy_change') return false
    const who = item.proposer.id
    if (who === KOL_MAIL_MATCH_PROPOSER) {
      await onMatchDecided(item)
      return true
    }
    if (
      who !== KOL_IMPORT_PROPOSER &&
      who !== KOL_STAGE_PROPOSER &&
      who !== KOL_MAIL_STAGE_PROPOSER
    )
      return false
    const choice = choiceOf(item)
    if (choice === undefined) return true
    const payload = rec(item.payload)
    const actor = actorOfItem(item)
    if (who === KOL_IMPORT_PROPOSER) {
      const job_id = typeof payload.job_id === 'string' ? payload.job_id : undefined
      if (choice === 'cancel' || job_id === undefined) {
        if (job_id !== undefined) jobs.delete(job_id)
        return true
      }
      try {
        await commitImport(actor, { job_id })
      } catch {
        // 预览过期了：卡照样是决定了的
      }
      return true
    }
    if (who === KOL_MAIL_STAGE_PROPOSER) {
      const m = /^run_(\d+)$/.exec(choice ?? '')
      if (m !== null) await runMailStages(actor, { months: Number(m[1]) })
      return true
    }
    // 冲突卡：选「按邮件」→ 改成邮件看出的那一步并留依据；「按表格」/ 驳回 → 不动，依据照样留
    const collab =
      typeof payload.collaboration_id === 'string'
        ? store.collaboration(payload.collaboration_id)
        : undefined
    if (collab === undefined) return true
    const evidence = Array.isArray(payload.evidence) ? (payload.evidence as KolStageEvidence[]) : []
    const mailStage = payload.mail_stage
    if (choice === 'mail' && isCollaborationStage(mailStage)) {
      store.saveCollaboration({
        ...collab,
        stage: mailStage,
        stage_source: 'mail',
        stage_evidence: evidence,
        stage_changed_at: evidence[0]?.at ?? clock.now(),
      })
      emit('kol.stage_conflict_resolved', actor.person_id, {
        collaboration_id: collab.id,
        chose: 'mail',
        stage: mailStage,
      })
    } else {
      store.saveCollaboration({ ...collab, stage_evidence: evidence })
      emit('kol.stage_conflict_resolved', actor.person_id, {
        collaboration_id: collab.id,
        chose: 'sheet',
        stage: collab.stage,
      })
    }
    return true
  }

  return {
    previewImport,
    commitImport,
    estimateMailStages,
    runMailStages,
    previewCard,
    mailStageCard,
    onDecided,
  }
}

/** 拖进来的附件里像不像一张红人表（扩展名先过一遍；内容由预览认）。 */
export const looksLikeSheetFile = (name: string): boolean =>
  fileFormat(name) !== undefined && !/\.txt$/i.test(name)

/**
 * WP489：岗位输入框里拖进来的红人表（红人岗位 / 红人职责下）→ 后台出一张「导入红人表」预览卡。
 * 同步回一句写在附件前面的话（AI 先读到它，不再自己去逐行念表）。
 */
export function createKolSheetIntake(o: {
  importer(): KolImportAssembly | undefined
  /** 这个人在红人岗位上的那条分配（没有 = 不认领）。 */
  actorOf(person_id: string): KolActor | undefined
  log?(e: unknown): void
}): (
  files: readonly { name: string; data: string }[],
  ctx: { role_id?: string; position_template_id?: string; person_id?: string },
) => (string | undefined)[] {
  return (files, ctx) => {
    const inKol =
      ctx.position_template_id === 'kol-marketing' || (ctx.role_id ?? '').startsWith('kol.')
    const importer = o.importer()
    const actor = ctx.person_id === undefined ? undefined : o.actorOf(ctx.person_id)
    return files.map((f) => {
      if (!inKol || importer === undefined || actor === undefined || !looksLikeSheetFile(f.name))
        return undefined
      void importer
        .previewCard(actor, { filename: f.name, content_base64: f.data })
        .catch((e) => o.log?.(e))
      return '这是一张红人表：已在后台认列、对状态，马上出一张「导入红人表」卡（点「导入」才写进红人库）。不用逐行读这张表。'
    })
  }
}
