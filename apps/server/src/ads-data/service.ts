/**
 * WP315（docs/101 §5.1①，决策 560）：**看数据**——每品牌一份。
 *
 * 1. 第一次：插件在用户后台建好「工坊日报」保存报表（写，出一张 L3 告知卡，告知卡的编号就是这件活的审批编号）；
 * 2. 每天一次：本地 9 点后（电脑和 Chrome 开着才跑：活排进插件动作通道，24 小时没人领作废），插件打开那几份
 *    保存报表、点「下载 CSV」；桌面端读下载的文件 → 解析 → 入库（按天、按品牌）→「今天」那份同步进广告库；
 * 3. 备用：插件不在（没连 / 一天没来领活）时，读用户邮箱里平台发来的定时报表附件（docs/63 那条邮箱连接）；
 * 4. 日报不是固定功能：第一次有数之后，给投放岗种一条官方「自动化任务」（每天一次，提示词就是日报要求），
 *    用户在那件事里说一句就能改时间、改内容、停掉（WP331 那一套）。
 *
 * 缺插件 → 工具回 `needs_connection: 'extension'`；缺账户 → `needs_setup: 'ads.accounts'`（WP324 卡）。
 */
import { readFile, stat } from 'node:fs/promises'
import {
  type ActionAccount,
  type AdsPlatform as ActionAdsPlatform,
  type ActionJob,
  buildAdsJob,
  isFinal,
} from '@agentsws/browser-action'
import type { AdsStore } from '../ads.js'
import type { AdsActionEvent, AdsActionsService } from '../ads-actions/service.js'
import type { SetupTarget } from '../setup-cards.js'
import { type AdsAccounts, adsAccountsSetupTarget, showAccount } from './accounts.js'
import { localDayOf, parseAdsFile, syncToAdsStore } from './ingest.js'
import type { AdsDataImport, AdsDataPlatform, AdsDataSource, AdsDataStore } from './store.js'
import { ADS_DATA_KEEP_DAYS } from './store.js'

/** 默认几点以后导（品牌时区）。 */
export const ADS_EXPORT_HOUR = 9
/** 插件多久没来领活就算「不在」（改走邮箱备用）。 */
export const PLUGIN_AWAY_MS = 24 * 60 * 60 * 1000
/** 一次没导成，隔多久再试。 */
export const EXPORT_RETRY_MS = 55 * 60_000
/** 建报表没建成，隔多久再试（不连着撞）。 */
export const SETUP_RETRY_MS = 24 * 60 * 60 * 1000
/** 「现在导一次」默认等多久。 */
export const FETCH_WAIT_MS = 2 * 60_000

const ACTION_PLATFORM: Record<AdsDataPlatform, ActionAdsPlatform> = {
  google: 'google_ads',
  meta: 'meta_ads',
}
const PLATFORM_ZH: Record<AdsDataPlatform, string> = { google: 'Google 广告', meta: 'Meta 广告' }

/**
 * 一封信是不是平台发来的定时报表（按发件人的域认；地址没对真信核过，见报告）。
 * Google：`…@google.com`；Meta：`…@facebookmail.com` / `…@facebook.com` / `…@meta.com`。
 */
export function reportMailPlatform(m: Pick<AdsMail, 'from'>): AdsDataPlatform | undefined {
  const from = m.from.toLowerCase()
  if (/@(?:[\w-]+\.)*google\.com$/u.test(from)) return 'google'
  if (/@(?:[\w-]+\.)*(?:facebookmail|facebook|meta)\.com$/u.test(from)) return 'meta'
  return undefined
}

export interface SetupStatus {
  status: 'pending' | 'done' | 'failed'
  at: string
  job_id?: string
  notice_id?: string
  message?: string
}

export interface ExportStatus {
  last_try_at?: string
  last_ok_at?: string
  last_ok_day?: string
  job_id?: string
  message?: string
}

interface JobRecord {
  platform: AdsDataPlatform
  kind: 'setup' | 'export'
  imports: string[]
  messages: string[]
}

/** 邮箱备用那一头（服务端用消息库实现；测试给假的）。 */
export interface AdsMailSource {
  /** 最近的来信（只要头与附件元数据）。 */
  recent(since: string): Promise<AdsMail[]>
  attachment(message_id: string, attachment_id: string): Promise<Uint8Array | undefined>
}

export interface AdsMail {
  id: string
  from: string
  subject: string
  date: string
  attachments: { id: string; name: string; mime: string; size: number }[]
}

export interface AdsDataOptions {
  workspace_id: string
  store: AdsDataStore
  ads: AdsStore
  now(): string
  newId(prefix: string): string
  tzOffsetMinutes(): number
  /** 担着哪几家的投放（`ads.google` / `ads.meta` 有人担）。 */
  wanted(): AdsDataPlatform[]
  /** 插件动作通道（托管实例没有）。 */
  actions?(): AdsActionsService | undefined
  /** 出一张 L3 告知卡，回卡的编号（当这件活的审批编号）。 */
  notice?(input: {
    platform: AdsDataPlatform
    title: string
    summary: string
  }): Promise<string | undefined>
  /** 读下载的文件（默认读本机磁盘）。 */
  readFile?(path: string): Promise<Uint8Array>
  mail?(): AdsMailSource | undefined
  /** 第一次有数之后种一条日报定时（回任务 / 事项编号；没人担投放回 undefined，下次有数再种）。 */
  seedDailyReport?(): Promise<{ task_id?: string; matter_id?: string } | undefined>
  emit?(type: string, payload: Record<string, unknown>): void
  sleep?(ms: number): Promise<void>
  exportHour?: number
}

/** 一家的看数据状态（给工具 / 界面看的那一份）。 */
export interface AdsDataPlatformStatus {
  platform: AdsDataPlatform
  account?: string
  /** 插件连没连这家后台（勾过风险告知），最近一次来领活是什么时候。 */
  plugin: 'ready' | 'away' | 'not_connected' | 'unavailable'
  plugin_seen_at?: string
  setup?: SetupStatus['status']
  last_import?: { at: string; source: AdsDataSource; days: string[]; rows: number }
  newest_day?: string
  message?: string
}

export type FetchOutcome =
  | { ok: true; platform: AdsDataPlatform; status: 'imported'; import_id: string; days: string[] }
  | { ok: true; platform: AdsDataPlatform; status: 'queued' | 'setting_up'; message: string }
  | { ok: false; platform: AdsDataPlatform; needs: 'extension' | 'ads.accounts'; message: string }
  | { ok: false; platform: AdsDataPlatform; message: string }

export interface AdsDataService {
  accounts(): AdsAccounts
  setAccounts(next: AdsAccounts): void
  setupTarget(): SetupTarget
  status(): AdsDataPlatformStatus[]
  /** 定时一拍（每小时）：该建报表的建、到点该导的导、插件不在的读邮箱。 */
  tick(): Promise<{ queued: string[]; imported: number; skipped?: string }>
  /** 「现在导一次」（工具用）：排上导出，等一会儿看导没导进来。 */
  fetchNow(input?: { platforms?: AdsDataPlatform[]; wait_ms?: number }): Promise<FetchOutcome[]>
  /** 插件动作通道的事件（只认自己排的那几件）。 */
  onActionEvent(event: AdsActionEvent): Promise<void>
  /** 一份导出直接入库（邮箱附件 / 测试 / 以后手动上传）。 */
  ingest(input: {
    bytes: Uint8Array
    name: string
    platform?: AdsDataPlatform
    source: AdsDataSource
    job_id?: string
    message_id?: string
  }): { ok: true; import: AdsDataImport } | { ok: false; message: string }
  /** 读一遍邮箱里的定时报表（插件不在时 tick 会调）。回入库了几份。 */
  scanMail(platforms?: AdsDataPlatform[]): Promise<number>
  /** 本地「今天」。 */
  today(): string
  /** 库里的行（查数工具用）。 */
  rows: AdsDataStore['rows']
  /** 担着哪几家。 */
  wanted(): AdsDataPlatform[]
  /** 连接卡复查：插件里连上了担着的那几家后台没有（一家都不担 / 没有插件通道回 undefined）。 */
  backendReady(): boolean | undefined
}

const STATE = {
  accounts: 'accounts',
  setup: 'setup',
  exports: 'exports',
  jobs: 'jobs',
  emailSeen: 'email_seen',
  dailyReport: 'daily_report',
} as const

export function createAdsDataService(options: AdsDataOptions): AdsDataService {
  const { store } = options
  const exportHour = options.exportHour ?? ADS_EXPORT_HOUR
  const get = <T>(key: string, fallback: T): T => store.getState<T>(key) ?? fallback
  const today = (): string => localDayOf(options.now(), options.tzOffsetMinutes())
  const localHour = (): number =>
    new Date(Date.parse(options.now()) + options.tzOffsetMinutes() * 60_000).getUTCHours()
  const accounts = (): AdsAccounts => get<AdsAccounts>(STATE.accounts, {})
  const setups = (): Partial<Record<AdsDataPlatform, SetupStatus>> => get(STATE.setup, {})
  const exportsOf = (): Partial<Record<AdsDataPlatform, ExportStatus>> => get(STATE.exports, {})
  const jobs = (): Record<string, JobRecord> => get(STATE.jobs, {})
  const patch = <T extends object>(key: string, p: AdsDataPlatform, value: T | undefined): void => {
    const all = get<Record<string, T>>(key, {})
    if (value === undefined) delete all[p]
    else all[p] = value
    store.setState(key, all)
  }
  const emit = (type: string, payload: Record<string, unknown>): void =>
    options.emit?.(type, { workspace_id: options.workspace_id, ...payload })

  const actionAccount = (p: AdsDataPlatform): ActionAccount | undefined => {
    const a = accounts()[p]
    if (a === undefined) return undefined
    return {
      platform: ACTION_PLATFORM[p],
      id: showAccount(p, a),
      ...(a.ocid === undefined ? {} : { ocid: a.ocid }),
    }
  }

  /** 插件在不在：勾过这家的风险告知（= 配对过、连过这家后台），一天内来领过活。 */
  const plugin = (p: AdsDataPlatform): AdsDataPlatformStatus['plugin'] => {
    const acts = options.actions?.()
    if (acts === undefined) return 'unavailable'
    if (acts.settings().consent[ACTION_PLATFORM[p]] === undefined) return 'not_connected'
    const seen = acts.lastSeen(ACTION_PLATFORM[p])
    return seen !== undefined && Date.parse(options.now()) - seen < PLUGIN_AWAY_MS
      ? 'ready'
      : 'away'
  }

  /** 这件活还在不在跑（队里找不到 = 早结束了、被清掉了）。 */
  const live = (job_id: string | undefined): boolean => {
    if (job_id === undefined) return false
    const view = options
      .actions?.()
      ?.jobs()
      .find((j) => j.id === job_id)
    return view !== undefined && !isFinal(view.status)
  }

  const enqueue = async (
    p: AdsDataPlatform,
    kind: 'setup' | 'export',
    approval_id?: string,
  ): Promise<{ ok: true; job: ActionJob; waiting?: string } | { ok: false; why: string }> => {
    const acts = options.actions?.()
    const account = actionAccount(p)
    if (acts === undefined || account === undefined)
      return { ok: false, why: '没有插件动作通道或没设账户。' }
    const job = buildAdsJob({
      id: options.newId(kind === 'setup' ? 'adsrep_setup' : 'adsrep_export'),
      workspace_id: options.workspace_id,
      account,
      action: { kind: kind === 'setup' ? 'setup_daily_report' : 'export_daily_report' },
      ...(approval_id === undefined ? {} : { approval_id, approval_level: 'L3' as const }),
      created_at: options.now(),
    })
    const out = await acts.enqueue(job)
    if (!out.ok) return out
    store.setState(STATE.jobs, {
      ...jobs(),
      [job.id]: { platform: p, kind, imports: [], messages: [] } satisfies JobRecord,
    })
    return { ok: true, job, ...(out.job.waiting === undefined ? {} : { waiting: out.job.waiting }) }
  }

  /** 建「工坊日报」：先出 L3 告知卡（它的编号就是审批编号），再排给插件。 */
  const startSetup = async (p: AdsDataPlatform): Promise<string | undefined> => {
    const reports = p === 'google' ? '5 份（广告系列 / 广告组 / 广告 / 关键词 / 搜索字词）' : '1 份'
    const notice_id =
      (await options
        .notice?.({
          platform: p,
          title: `在你的${PLATFORM_ZH[p]}后台建「工坊日报」`,
          summary: `插件会在你已登录的后台建 ${reports}保存报表，以后每天 ${exportHour} 点后点一次「下载 CSV」，不改广告。`,
        })
        .catch(() => undefined)) ?? `adsrep_notice_${options.newId('n')}`
    const out = await enqueue(p, 'setup', notice_id)
    if (!out.ok) {
      patch<SetupStatus>(STATE.setup, p, { status: 'failed', at: options.now(), message: out.why })
      return undefined
    }
    patch<SetupStatus>(STATE.setup, p, {
      status: 'pending',
      at: options.now(),
      job_id: out.job.id,
      notice_id,
    })
    emit('ads_data.setup_queued', { platform: p, job_id: out.job.id })
    return out.job.id
  }

  const startExport = async (p: AdsDataPlatform, why: 'daily' | 'manual') => {
    const out = await enqueue(p, 'export')
    const prev = exportsOf()[p] ?? {}
    if (!out.ok) {
      patch<ExportStatus>(STATE.exports, p, {
        ...prev,
        last_try_at: options.now(),
        message: out.why,
      })
      return out
    }
    const { message: _m, ...rest } = prev
    patch<ExportStatus>(STATE.exports, p, {
      ...rest,
      last_try_at: options.now(),
      job_id: out.job.id,
    })
    emit('ads_data.export_queued', { platform: p, job_id: out.job.id, why })
    return out
  }

  const ingest: AdsDataService['ingest'] = (input) => {
    const id = options.newId('adsimp')
    const at = options.now()
    const p = input.platform
    const parsed = parseAdsFile({
      id,
      bytes: input.bytes,
      name: input.name,
      ...(p === undefined ? {} : { platform: p }),
      ...(p === undefined || accounts()[p] === undefined
        ? {}
        : { account: (accounts()[p] as { id: string }).id }),
      source: input.source,
      at,
      tzOffsetMinutes: options.tzOffsetMinutes(),
      ...(input.job_id === undefined ? {} : { job_id: input.job_id }),
      ...(input.message_id === undefined ? {} : { message_id: input.message_id }),
    })
    if (!parsed.ok) {
      emit('ads_data.import_failed', { platform: p, source: input.source, message: parsed.message })
      return parsed
    }
    store.replace({ import: parsed.import, rows: parsed.rows })
    // 「今天」那一份同步进广告库：按这家最近几天的全部行算（Google 五份表各管一层，单看这一份不全）
    const day = today()
    const since = new Date(Date.parse(`${day}T00:00:00Z`) - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10)
    syncToAdsStore(
      options.ads,
      store.rows({ since, until: day, platform: parsed.import.platform }),
      {
        today: day,
        at,
      },
    )
    const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - ADS_DATA_KEEP_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10)
    store.prune(cutoff)
    emit('ads_data.imported', {
      platform: parsed.import.platform,
      source: input.source,
      import_id: id,
      rows: parsed.import.rows,
      days: parsed.import.days.length,
    })
    return { ok: true, import: parsed.import }
  }

  /**
   * 插件说下到了哪：认 CSV / 制表符文字（Excel、PDF、压缩包一律不读——看扩展名，也看文件头），
   * 大小有上限；读到就入库。扩展名不一定有（自动化浏览器里的下载是随机名），所以没扩展名的也看内容。
   */
  const readDownload = async (path: string): Promise<Uint8Array | string> => {
    const notText = '下载的不是 CSV / 文字文件（Excel / PDF / 压缩包），没读；导出时选 CSV。'
    if (/\.(xlsx?|pdf|zip|gz)$/iu.test(path)) return notText
    let bytes: Uint8Array
    try {
      if (options.readFile !== undefined) bytes = await options.readFile(path)
      else {
        const info = await stat(path)
        if (!info.isFile() || info.size > 20 * 1024 * 1024)
          return '下载的文件不对（太大或不是文件），没读。'
        bytes = new Uint8Array(await readFile(path))
      }
    } catch {
      return '读不到下载的文件（可能被挪走了）。'
    }
    const head = String.fromCharCode(...bytes.subarray(0, 4))
    if (head.startsWith('PK') || head === '%PDF' || (bytes[0] === 0x1f && bytes[1] === 0x8b))
      return notText
    return bytes
  }

  const seedOnce = async (): Promise<void> => {
    if (store.getState(STATE.dailyReport) !== undefined || options.seedDailyReport === undefined)
      return
    const seeded = await options.seedDailyReport().catch(() => undefined)
    if (seeded === undefined) return
    store.setState(STATE.dailyReport, { ...seeded, at: options.now() })
    emit('ads_data.daily_report_seeded', { ...seeded })
  }

  const onActionEvent = async (event: AdsActionEvent): Promise<void> => {
    const all = jobs()
    const rec = all[event.job.id]
    if (rec === undefined) return
    const p = rec.platform
    const save = (next: JobRecord | undefined): void => {
      const now = jobs()
      if (next === undefined) delete now[event.job.id]
      else now[event.job.id] = next
      store.setState(STATE.jobs, now)
    }
    if (event.type === 'download') {
      if (event.file.tag !== 'report') return
      const got = await readDownload(event.file.path)
      const out =
        typeof got === 'string'
          ? { ok: false as const, message: got }
          : ingest({
              bytes: got,
              name: event.file.name,
              platform: p,
              source: 'plugin',
              job_id: event.job.id,
            })
      const cur = jobs()[event.job.id] ?? rec
      save(
        out.ok
          ? { ...cur, imports: [...cur.imports, out.import.id] }
          : { ...cur, messages: [...cur.messages, `${event.file.name}：${out.message}`] },
      )
      return
    }
    const now = options.now()
    if (event.type === 'expired') {
      save(undefined)
      const msg = '排了一天没人领（电脑或 Chrome 没开），没做成。'
      if (rec.kind === 'setup')
        patch<SetupStatus>(STATE.setup, p, { status: 'failed', at: now, message: msg })
      else patch<ExportStatus>(STATE.exports, p, { ...(exportsOf()[p] ?? {}), message: msg })
      return
    }
    if (event.type !== 'finished') return
    const done = event.result?.outcome === 'done' || event.view.status === 'done'
    const said = event.result?.message ?? event.view.result?.message ?? ''
    save(undefined)
    if (rec.kind === 'setup') {
      patch<SetupStatus>(STATE.setup, p, {
        ...(setups()[p] ?? { at: now }),
        status: done ? 'done' : 'failed',
        at: now,
        ...(done ? {} : { message: said || '没建成。' }),
      })
      emit('ads_data.setup_finished', { platform: p, ok: done })
      // 建好了马上导第一次（不用等明天）
      if (done) await startExport(p, 'daily')
      return
    }
    const imported = rec.imports.length > 0
    const prev = exportsOf()[p] ?? {}
    const { job_id: _j, message: _m, ...rest } = prev
    patch<ExportStatus>(STATE.exports, p, {
      ...rest,
      ...(imported ? { last_ok_at: now, last_ok_day: today() } : {}),
      ...(imported && rec.messages.length === 0
        ? {}
        : { message: [said, ...rec.messages].filter((x) => x !== '').join('；') || '没导出来。' }),
    })
    emit('ads_data.export_finished', { platform: p, ok: done, files: rec.imports.length })
    if (imported) await seedOnce()
  }

  /** 邮箱备用：读平台发来的定时报表附件（只认 CSV / 制表符文字；读过的不再读）。 */
  const scanMail = async (platforms?: AdsDataPlatform[]): Promise<number> => {
    const src = options.mail?.()
    if (src === undefined) return 0
    const want = platforms ?? options.wanted()
    const since = new Date(Date.parse(options.now()) - 3 * 86_400_000).toISOString()
    const mails = await src.recent(since).catch(() => [] as AdsMail[])
    const seen = new Set(get<string[]>(STATE.emailSeen, []))
    let n = 0
    for (const m of mails) {
      const p = reportMailPlatform(m)
      if (p === undefined || !want.includes(p) || seen.has(m.id)) continue
      seen.add(m.id)
      const files = m.attachments.filter((a) => /\.(csv|tsv|txt)$/iu.test(a.name))
      if (files.length === 0) {
        if (!/report|报告|报表/iu.test(m.subject)) continue
        patch<ExportStatus>(STATE.exports, p, {
          ...(exportsOf()[p] ?? {}),
          message:
            '邮箱里的定时报表没有 CSV 附件（可能只给了链接），读不到；在平台把定时报表的格式选成 CSV。',
        })
        continue
      }
      for (const a of files) {
        const bytes = await src.attachment(m.id, a.id).catch(() => undefined)
        if (bytes === undefined) continue
        const out = ingest({ bytes, name: a.name, platform: p, source: 'email', message_id: m.id })
        if (out.ok) {
          n += 1
          const prev = exportsOf()[p] ?? {}
          const { message: _m, ...rest } = prev
          patch<ExportStatus>(STATE.exports, p, {
            ...rest,
            last_ok_at: options.now(),
            last_ok_day: today(),
          })
        }
      }
    }
    store.setState(STATE.emailSeen, [...seen].slice(-500))
    if (n > 0) await seedOnce()
    return n
  }

  const tick: AdsDataService['tick'] = async () => {
    const queued: string[] = []
    let imported = 0
    const want = options.wanted().filter((p) => accounts()[p] !== undefined)
    if (want.length === 0) return { queued, imported, skipped: 'no_account' }
    const nowMs = Date.parse(options.now())
    const mailFor: AdsDataPlatform[] = []
    for (const p of want) {
      const plug = plugin(p)
      if (plug !== 'ready') mailFor.push(p)
      if (plug === 'not_connected' || plug === 'unavailable') continue
      const setup = setups()[p]
      if (setup?.status !== 'done') {
        if (setup?.status === 'pending' && live(setup.job_id)) continue
        if (setup?.status === 'failed' && nowMs - Date.parse(setup.at) < SETUP_RETRY_MS) continue
        const id = await startSetup(p)
        if (id !== undefined) queued.push(id)
        continue
      }
      const ex = exportsOf()[p] ?? {}
      if (live(ex.job_id)) continue
      if (localHour() < exportHour || ex.last_ok_day === today()) continue
      if (ex.last_try_at !== undefined && nowMs - Date.parse(ex.last_try_at) < EXPORT_RETRY_MS)
        continue
      const out = await startExport(p, 'daily')
      if (out.ok) queued.push(out.job.id)
    }
    if (mailFor.length > 0) imported = await scanMail(mailFor)
    return { queued, imported }
  }

  const status = (): AdsDataPlatformStatus[] =>
    options.wanted().map((p) => {
      const a = accounts()[p]
      const plug = plugin(p)
      const seen = options.actions?.()?.lastSeen(ACTION_PLATFORM[p])
      const last = store.imports({ platform: p, limit: 1 })[0]
      const ex = exportsOf()[p]
      const setup = setups()[p]
      return {
        platform: p,
        ...(a === undefined ? {} : { account: showAccount(p, a) }),
        plugin: plug,
        ...(seen === undefined ? {} : { plugin_seen_at: new Date(seen).toISOString() }),
        ...(setup === undefined ? {} : { setup: setup.status }),
        ...(last === undefined
          ? {}
          : {
              last_import: { at: last.at, source: last.source, days: last.days, rows: last.rows },
              newest_day: last.days[last.days.length - 1] as string,
            }),
        ...((ex?.message ?? setup?.message) === undefined
          ? {}
          : { message: (ex?.message ?? setup?.message) as string }),
      }
    })

  const fetchNow: AdsDataService['fetchNow'] = async (input = {}) => {
    const want = (input.platforms ?? options.wanted()).filter((p) => options.wanted().includes(p))
    const out: FetchOutcome[] = []
    const waiting: { p: AdsDataPlatform; job: string }[] = []
    for (const p of want) {
      if (accounts()[p] === undefined) {
        out.push({
          ok: false,
          platform: p,
          needs: 'ads.accounts',
          message: '还没设是哪个广告账户。',
        })
        continue
      }
      const plug = plugin(p)
      if (plug === 'not_connected' || plug === 'unavailable') {
        out.push({
          ok: false,
          platform: p,
          needs: 'extension',
          message: `插件还没连上${PLATFORM_ZH[p]}后台（在插件设置里点「连接」）。`,
        })
        continue
      }
      const setup = setups()[p]
      if (setup?.status !== 'done') {
        const id =
          setup?.status === 'pending' && live(setup.job_id) ? setup.job_id : await startSetup(p)
        out.push(
          id === undefined
            ? { ok: false, platform: p, message: setups()[p]?.message ?? '没排上。' }
            : {
                ok: true,
                platform: p,
                status: 'setting_up',
                message: '先在后台建「工坊日报」，建好会自动导一次。',
              },
        )
        continue
      }
      const ex = exportsOf()[p] ?? {}
      const job = live(ex.job_id) ? ex.job_id : undefined
      const started = job === undefined ? await startExport(p, 'manual') : undefined
      if (started !== undefined && !started.ok) {
        out.push({ ok: false, platform: p, message: started.why })
        continue
      }
      waiting.push({ p, job: job ?? (started as { job: ActionJob }).job.id })
    }
    // 等插件做完（Chrome 开着的话一两分钟）；等不到就说排上了
    const wait = input.wait_ms ?? FETCH_WAIT_MS
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
    let pending = waiting
    for (let waited = 0; pending.length > 0 && waited < wait; waited += 5_000) {
      await sleep(5_000)
      pending = pending.filter((w) => live(w.job) || jobs()[w.job] !== undefined)
    }
    for (const w of waiting) {
      const done = !pending.includes(w)
      const last = store.imports({ platform: w.p, limit: 1 })[0]
      if (done && last?.job_id === w.job)
        out.push({
          ok: true,
          platform: w.p,
          status: 'imported',
          import_id: last.id,
          days: last.days,
        })
      else if (done)
        out.push({ ok: false, platform: w.p, message: exportsOf()[w.p]?.message ?? '没导出来。' })
      else
        out.push({
          ok: true,
          platform: w.p,
          status: 'queued',
          message:
            plugin(w.p) === 'ready'
              ? '排上了，插件做完会自动入库。'
              : '排上了，等 Chrome 开着时插件去导。',
        })
    }
    return out
  }

  return {
    accounts,
    setAccounts: (next) => store.setState(STATE.accounts, next),
    setupTarget: () =>
      adsAccountsSetupTarget({
        wanted: options.wanted,
        get: accounts,
        set: (next) => store.setState(STATE.accounts, next),
      }),
    status,
    tick,
    fetchNow,
    onActionEvent,
    ingest,
    scanMail,
    today,
    rows: (f) => store.rows(f),
    wanted: () => options.wanted(),
    backendReady: () => {
      const want = options.wanted()
      if (want.length === 0 || options.actions?.() === undefined) return undefined
      return want.every((p) => plugin(p) !== 'not_connected')
    },
  }
}
