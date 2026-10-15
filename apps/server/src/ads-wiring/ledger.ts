/**
 * WP316（docs/101 §5.1② 第 8 步，决策 556）：**广告变更账本**——每品牌一本。
 *
 * 一条 = 一张批过的卡（上传表 / 开始投放 / 撤销 / 改预算 / 暂停）在插件那一侧走到哪了，
 * 以及留下的证据：上传表原样字节、改前 / 改后导出（账本自己存一份）、平台预览与提交前后截图的编号、
 * 审批编号、读回核对。存 180 天，到期按名字逐个删（只删自己存的，不扫目录）。
 *
 * 另记两样跟账户走的：
 * - 每个账户第一次由插件做成一件写操作的时间（决策 554 磨合期从这一天起算 14 天）；
 * - 每个账户最近一份导出（改前表）——Meta 改已有要它（决策 612）。
 *
 * 落盘：`<品牌目录>/ads-ledger/ledger.json` + `exports/<件 id>-<tag>.csv`。没有目录 = 纯内存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ActionAccount } from '@agentsws/browser-action'
import {
  ADS_BREAK_IN_DAYS,
  ADS_LEDGER_KEEP_DAYS,
  type AdsLedgerEvidence,
  type AdsLedgerJob,
  type AdsLedgerState,
  type AdsSheetCardAfter,
  type AdsSheetCardFile,
} from '@agentsws/contracts'

const DAY_MS = 24 * 60 * 60 * 1000

/** 谁提的（出「开始投放」这类后续卡时用同一个人、同一条分配）。 */
export interface LedgerActor {
  workspace_id: string
  person_id: string
  assignment_id: string
  role_id: string
}

export interface LedgerDownload {
  tag: string
  name: string
  job_id: string
  /** 账本自己存的那一份（相对 `exports/`）；没存下来就没有。 */
  kept?: string
}

export interface LedgerEntry {
  change_id: string
  approval_id?: string
  kind: string
  /** `google` / `meta`。 */
  platform: 'google' | 'meta'
  /** 广告库里的账户 id。 */
  account_id: string
  account: ActionAccount
  actor?: LedgerActor
  title: string
  sentence?: string
  state: AdsLedgerState
  stop_loss?: boolean
  /** 上传表（按顺序一张一张传）。 */
  files?: AdsSheetCardFile[]
  /** 走表单的那几下（按顺序）。 */
  form?: NonNullable<AdsSheetCardAfter['_form']>
  ops?: unknown[]
  /** 下一份要进队的是第几个（表或表单那一下）。 */
  next: number
  jobs: AdsLedgerJob[]
  evidence: AdsLedgerEvidence[]
  evidence_missing: string[]
  downloads: LedgerDownload[]
  preview_summary?: string
  platform_errors?: string
  readback?: { ok: boolean; sentence: string }
  /** 新建了东西、读回之后出的「开始投放」卡。 */
  activation_change_id?: string
  /** 这条撤的是哪一条。 */
  undo_of?: string
  undone_by?: string
  /** 「开始投放」要算进总闸的那一截（决策 614）。 */
  adding?: number
  created_at: string
  updated_at: string
}

interface LedgerFile {
  version: 1
  entries: LedgerEntry[]
  first_done: Record<string, string>
  latest_export: Record<string, { kept: string; at: string }>
}

export const accountKey = (a: ActionAccount): string => `${a.platform}:${a.id}`

export interface AdsLedger {
  get(change_id: string): LedgerEntry | undefined
  byJob(job_id: string): LedgerEntry | undefined
  list(): LedgerEntry[]
  put(entry: LedgerEntry): void
  /** 存一份导出（原样字节），回存下来的文件名。 */
  keepExport(job_id: string, tag: string, bytes: Uint8Array): string
  readExport(kept: string): Uint8Array | undefined
  noteFirstDone(account: ActionAccount, at: string): void
  /** 磨合期到哪天（还没做成过一件 = 还在磨合，没有截止日）。 */
  breakInUntil(account: ActionAccount): { active: boolean; until?: string }
  noteLatestExport(account: ActionAccount, kept: string, at: string): void
  latestExport(account: ActionAccount): { kept: string; at: string } | undefined
  /** 过了 180 天的条目与它存的导出，逐个点名删。回删了几条。 */
  prune(): number
  keptUntil(entry: LedgerEntry): string
}

export function createAdsLedger(options: { dir?: string; nowMs(): number }): AdsLedger {
  const dir = options.dir
  const file = dir === undefined ? undefined : join(dir, 'ledger.json')
  const exportsDir = dir === undefined ? undefined : join(dir, 'exports')
  const memExports = new Map<string, Uint8Array>()

  const loaded = ((): LedgerFile | undefined => {
    if (file === undefined || !existsSync(file)) return undefined
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as LedgerFile
      return raw.version === 1 ? raw : undefined
    } catch {
      return undefined
    }
  })()
  const state: LedgerFile = loaded ?? {
    version: 1,
    entries: [],
    first_done: {},
    latest_export: {},
  }

  const save = (): void => {
    if (file === undefined || dir === undefined) return
    mkdirSync(dir, { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  }

  const safe = (s: string): string => s.replace(/[^\w.-]/gu, '_')
  const keptUntilMs = (e: LedgerEntry): number =>
    Date.parse(e.created_at) + ADS_LEDGER_KEEP_DAYS * DAY_MS

  return {
    get: (id) => state.entries.find((e) => e.change_id === id),
    byJob: (job_id) => state.entries.find((e) => e.jobs.some((j) => j.job_id === job_id)),
    list: () => [...state.entries].reverse(),
    put(entry) {
      const i = state.entries.findIndex((e) => e.change_id === entry.change_id)
      if (i >= 0) state.entries[i] = entry
      else state.entries.push(entry)
      save()
    },
    keepExport(job_id, tag, bytes) {
      const name = `${safe(job_id)}-${safe(tag)}.csv`
      if (exportsDir === undefined) memExports.set(name, bytes)
      else {
        mkdirSync(exportsDir, { recursive: true })
        writeFileSync(join(exportsDir, name), bytes)
      }
      return name
    },
    readExport(kept) {
      if (exportsDir === undefined) return memExports.get(kept)
      const p = join(exportsDir, safe(kept))
      return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
    },
    noteFirstDone(account, at) {
      const k = accountKey(account)
      if (state.first_done[k] !== undefined) return
      state.first_done[k] = at
      save()
    },
    breakInUntil(account) {
      const first = state.first_done[accountKey(account)]
      if (first === undefined) return { active: true }
      const until = Date.parse(first) + ADS_BREAK_IN_DAYS * DAY_MS
      return { active: options.nowMs() < until, until: new Date(until).toISOString() }
    },
    noteLatestExport(account, kept, at) {
      state.latest_export[accountKey(account)] = { kept, at }
      save()
    },
    latestExport: (account) => state.latest_export[accountKey(account)],
    prune() {
      const now = options.nowMs()
      const gone = state.entries.filter((e) => keptUntilMs(e) <= now)
      if (gone.length === 0) return 0
      const goneKept = new Set(gone.flatMap((e) => e.downloads.flatMap((d) => d.kept ?? [])))
      for (const kept of goneKept) {
        // 这份还是某个账户「最近一份导出」就留着（Meta 改已有要它）
        if (Object.values(state.latest_export).some((x) => x.kept === kept)) continue
        if (exportsDir === undefined) memExports.delete(kept)
        else rmSync(join(exportsDir, safe(kept)), { force: true })
      }
      state.entries = state.entries.filter((e) => keptUntilMs(e) > now)
      save()
      return gone.length
    },
    keptUntil: (e) => new Date(keptUntilMs(e)).toISOString(),
  }
}
