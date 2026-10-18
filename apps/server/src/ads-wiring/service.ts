/**
 * WP316（docs/101 §5.1② ③，决策 552–558 / 600 / 612–615）：广告改动的**执行那一半**。
 *
 * 卡批了（变更账本的执行器调 {@link AdsWiring.apply}）→ 拼插件动作、进队（WP313 的通道）→
 * 插件在用户自己的后台里：上传 / 点 → 平台预览截图 → 人再确认（横条或工坊卡）→ 提交 → 截图 →
 * 再导出一份 → 这里拿改后导出和上传表逐行比（读回核对）→ 记进广告变更账本。
 *
 * 几条规矩：
 * - **进了队就回 ok**（照 WP329 Reddit 那条）：真正的结局在账本里，做不成另出一张通知卡说清楚。
 *   不回 `unknown`——那会让对账把整个出站停住。
 * - 多张表（Google 一层一张）**一张做完、读回前再进下一张**；中间有一张没做成，后面的不传。
 * - 平台报了阻断错误 / 人没确认 → 退回（`rejected`），不重试、不换个写法重交。
 * - 止损（L3 自动）截不到图也先停（决策 600 C），账本记「没截到」、用停前停后两份导出作证。
 * - 新建的东西做完、读回拿到编号 → 出一张「开始投放」卡（L1，决策 553）。
 * - 排队 24 小时没人领作废 → 原样重出一张卡（决策 558）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import {
  type AdSheetOp,
  activationOpsFor,
  attachIdsFromExport,
  decodeExportBytes,
  type ParsedAdsExport,
  parseAdsExport,
  readBackCheck,
  type SetStatusOp,
} from '@agentsws/ads-core'
import {
  type ActionAccount,
  type AdsAction,
  type AdsOrigins,
  base64ToBytes,
  buildAdsJob,
} from '@agentsws/browser-action'
import type {
  AdsLedgerEntryView,
  AdsLedgerState,
  AdsSheetCardAfter,
  ChangeKind,
  EventEnvelope,
  StagedChange,
} from '@agentsws/contracts'
import { NOT_WIRED_ERROR_PREFIX } from '@agentsws/contracts'
import type { BackendResult } from '@agentsws/txn'
import type { AdsStore } from '../ads.js'
import type { AdsActionEvent, AdsActionsService } from '../ads-actions/service.js'
import type { AdsLedger, LedgerActor, LedgerEntry } from './ledger.js'
import { checkCardFiles } from './sheet-card.js'

/** 这几种卡批了由插件执行。改出价 / 换素材第一期不点表单（决策 552），照旧走原来那条路。 */
export const WIRED_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  'ads_sheet',
  'ads_activate',
  'ads_undo',
  'create_campaign',
  'budget_change',
  'pause_ad',
])

/** 插件多久没来领活算「没连着」（它每分钟来问一次）。 */
export const EXTENSION_FRESH_MS = 10 * 60 * 1000

/** 插件报上来的下载文件最多读多大（导出表；超了不读，照实记）。 */
const MAX_EXPORT_BYTES = 20 * 1024 * 1024

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined

/** 平台（广告库口径）→ 插件动作通道口径。 */
export const actionPlatformOf = (p: 'google' | 'meta'): 'google_ads' | 'meta_ads' =>
  p === 'google' ? 'google_ads' : 'meta_ads'

/** 金额 → 插件填进预算框的那串字（两位小数以内；整数不带小数点）。 */
export function amountText(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

export interface AdsWiringOptions {
  workspace_id: string
  nowMs(): number
  store: AdsStore
  ledger: AdsLedger
  /** 这个品牌的插件动作通道（托管实例没有 → 一律掉回原来那条路）。 */
  actions(): AdsActionsService | undefined
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 读插件报上来的导出文件（测试换替身）。默认读本机路径，只认 csv / tsv / txt，≤ 20MB。 */
  readDownload?(path: string): Uint8Array | undefined
  /** 测试指向本地假后台。 */
  origins?: AdsOrigins
  id(): string
  /**
   * WP315：看数据那边配过的账户若就是这一个，带上它的 Google `ocid`（后台网址更稳）。
   * 不给 / 对不上就不带（照旧只用客户编号拼网址）。
   */
  ocidFor?(platform: 'google' | 'meta', external_id: string): string | undefined
}

/** ads-service 那一侧晚绑定进来的两件事（出「开始投放」卡、作废了重出）。 */
export interface AdsWiringFollowUps {
  proposeActivation(entry: LedgerEntry, ops: SetStatusOp[]): Promise<string | undefined>
  reissue(change_id: string): Promise<void>
}

export interface AdsWiring {
  apply(change: StagedChange): Promise<BackendResult | undefined>
  onActionEvent(event: AdsActionEvent): void
  /** 等所有事件处理完（测试用）。 */
  settled(): Promise<void>
  /** 这台机器装了插件动作通道（托管实例没有：广告卡照旧走原来那条路，磨合期也不适用）。 */
  available(): boolean
  /** 插件连着这家没有（领过活、勾过告知）。 */
  extensionReady(platform: 'google' | 'meta'): boolean
  breakIn(account: ActionAccount): { active: boolean; until?: string }
  /** 这个账户最近一份导出（改前表），24 小时以内的才算。 */
  latestExport(account: ActionAccount): ParsedAdsExport | undefined
  /** 只导出一份改前表（读操作，不要审批）。 */
  requestSnapshot(account: ActionAccount): Promise<{ ok: boolean; message: string }>
  entry(change_id: string): LedgerEntry | undefined
  entries(): AdsLedgerEntryView[]
  /** 账本里的一张截图（只认账本里登记过的 id）。 */
  evidenceImage(id: string): Promise<Uint8Array | undefined>
  /** 平台预览看过了：确认提交 / 不提交（不提交 = 停下，不点应用）。 */
  confirm(change_id: string, submit: boolean): { ok: boolean; message: string }
  /** 等人再确认的那几件（工坊卡上「确认提交」用）。 */
  waitingConfirm(): { entry: AdsLedgerEntryView; job_id: string; preview_evidence?: string }[]
  setFollowUps(f: AdsWiringFollowUps): void
  sweep(): void
}

function defaultRead(path: string): Uint8Array | undefined {
  if (!/\.(csv|tsv|txt)$/iu.test(path) || !existsSync(path)) return undefined
  if (statSync(path).size > MAX_EXPORT_BYTES) return undefined
  return new Uint8Array(readFileSync(path))
}

export function createAdsWiring(options: AdsWiringOptions): AdsWiring {
  const { ledger, store } = options
  let follow: AdsWiringFollowUps | undefined
  let pending: Promise<void> = Promise.resolve()
  const nowIso = (): string => new Date(options.nowMs()).toISOString()

  const emit = (type: string, payload: Record<string, unknown>): void =>
    options.appendEvent({
      schema_version: 1,
      workspace_id: options.workspace_id as never,
      type,
      actor: { kind: 'system', id: 'ads-wiring' },
      correlation: { trace_id: `tr_ads_${options.nowMs()}` },
      payload,
    } as never)

  const accountOf = (
    change: StagedChange,
    after: Record<string, unknown>,
  ): { account_id: string; account: ActionAccount; platform: 'google' | 'meta' } | undefined => {
    let account_id = str(after.account_id)
    if (account_id === undefined && change.target.type === 'ad_account')
      account_id = change.target.id
    if (account_id === undefined && change.target.type === 'campaign')
      account_id = store.campaign(change.target.id)?.account_id
    const acc = account_id === undefined ? undefined : store.account(account_id)
    if (acc === undefined || (acc.platform !== 'google' && acc.platform !== 'meta'))
      return undefined
    return {
      account_id: acc.id,
      platform: acc.platform,
      account: (() => {
        const ocid = options.ocidFor?.(acc.platform, acc.external_id)
        return {
          platform: actionPlatformOf(acc.platform),
          id: acc.external_id,
          ...(ocid === undefined ? {} : { ocid }),
        }
      })(),
    }
  }

  /** 表单那几下：老的改预算 / 暂停卡按 campaign 拼出来。 */
  const formOf = (
    change: StagedChange,
    after: Record<string, unknown>,
  ): NonNullable<AdsSheetCardAfter['_form']> | undefined => {
    if (Array.isArray(after._form)) return after._form as NonNullable<AdsSheetCardAfter['_form']>
    if (change.target.type !== 'campaign') return undefined
    const c = store.campaign(change.target.id)
    if (c === undefined) return undefined
    if (change.kind === 'pause_ad')
      return [{ action: 'pause', level: 'campaign', entity_id: c.external_id, entity_name: c.name }]
    if (change.kind === 'budget_change' && typeof after.value === 'number')
      return [
        {
          action: 'set_budget',
          level: 'campaign',
          entity_id: c.external_id,
          entity_name: c.name,
          amount: amountText(after.value),
        },
      ]
    return undefined
  }

  const levelOf = (change: StagedChange): 'L1' | 'L2' | 'L3' =>
    change.approval?.by === 'mandate' ? (change.kind === 'pause_ad' ? 'L3' : 'L2') : 'L1'

  /** 第 i 件进队（表一张、或表单一下）。 */
  const enqueueUnit = async (
    entry: LedgerEntry,
    level: 'L1' | 'L2' | 'L3',
  ): Promise<{ ok: true } | { ok: false; why: string }> => {
    const svc = options.actions()
    if (svc === undefined) return { ok: false, why: '这台机器没装插件动作通道。' }
    const i = entry.next
    let action: AdsAction
    let bytes: Uint8Array | undefined
    let fileName: string | undefined
    const file = entry.files?.[i]
    const form = entry.form?.[i]
    if (file !== undefined) {
      const total = entry.files?.length ?? 1
      action = {
        kind: 'upload_sheet',
        sheet: {
          name: file.name,
          mime: file.mime,
          fingerprint: file.fingerprint,
          bytes: file.bytes,
        },
        // 改前表只在第一张之前导一次；读回导出放在最后一张之后
        snapshot: i === 0,
        readback: i === total - 1,
      }
      bytes = base64ToBytes(file.base64)
      fileName = file.name
    } else if (form !== undefined) {
      const entity = {
        level: form.level ?? 'campaign',
        id: form.entity_id ?? '',
        ...(form.entity_name === undefined ? {} : { name: form.entity_name }),
      }
      action =
        form.action === 'undo_upload'
          ? { kind: 'undo_upload', upload_name: form.upload_name ?? '' }
          : form.action === 'set_budget'
            ? { kind: 'set_budget', entity, amount: form.amount ?? '' }
            : form.action === 'pause'
              ? { kind: 'pause', entity, ...(entry.stop_loss === true ? { stop_loss: true } : {}) }
              : { kind: 'enable', entity }
    } else return { ok: false, why: '没有下一步了。' }
    let job: ReturnType<typeof buildAdsJob>
    try {
      job = buildAdsJob({
        id: `adsj_${options.id()}`,
        workspace_id: options.workspace_id,
        account: entry.account,
        action,
        ...(entry.approval_id === undefined ? {} : { approval_id: entry.approval_id }),
        approval_level: level,
        title: entry.title,
        created_at: nowIso(),
        ...(options.origins === undefined ? {} : { origins: options.origins }),
      })
    } catch (err) {
      return { ok: false, why: err instanceof Error ? err.message : String(err) }
    }
    const queued = await svc.enqueue(job, bytes)
    if (!queued.ok) return queued
    entry.jobs.push({
      job_id: job.id,
      ...(fileName === undefined ? {} : { file: fileName }),
      status: 'queued',
    })
    entry.state = 'queued'
    entry.updated_at = nowIso()
    ledger.put(entry)
    return { ok: true }
  }

  const units = (e: LedgerEntry): number => (e.files?.length ?? 0) + (e.form?.length ?? 0)

  const parseKept = (kept: string | undefined): ParsedAdsExport | undefined => {
    if (kept === undefined) return undefined
    const bytes = ledger.readExport(kept)
    if (bytes === undefined) return undefined
    const parsed = parseAdsExport(decodeExportBytes(bytes))
    return parsed.rows.length === 0 ? undefined : parsed
  }

  /** 最后一件做完：读回核对、止损记账、出「开始投放」卡。 */
  const finalize = async (entry: LedgerEntry): Promise<void> => {
    const ops = (entry.ops ?? []) as AdSheetOp[]
    const result = [...entry.downloads].reverse().find((d) => d.tag === 'result')
    const after = parseKept(result?.kept)
    if (ops.length > 0) {
      entry.readback =
        after === undefined
          ? { ok: false, sentence: '读回核对：没拿到改后导出，没法逐行对。' }
          : readBackCheck(ops, after)
    }
    entry.state = 'done'
    entry.updated_at = nowIso()
    ledger.put(entry)
    // 撤销做成了：被撤的那一条记一笔（Google 一次性撤销按钮用掉了，不能再撤）
    if (entry.undo_of !== undefined) {
      const target = ledger.get(entry.undo_of)
      if (target !== undefined) {
        target.undone_by = entry.change_id
        ledger.put(target)
      }
    }
    if (entry.readback !== undefined && !entry.readback.ok)
      emit('ads.readback_mismatch', {
        change_id: entry.change_id,
        sentence: entry.readback.sentence,
      })
    // 表单那几下做成了（插件已读回页面）：库里那条 campaign 跟着改，面板不用等下一次导出
    for (const f of entry.form ?? []) {
      if ((f.level ?? 'campaign') !== 'campaign' || f.entity_id === undefined) continue
      const c = store
        .campaigns({ account_id: entry.account_id })
        .find((x) => x.external_id === f.entity_id)
      if (c === undefined) continue
      if (f.action === 'pause') store.saveCampaign({ ...c, status: 'paused' })
      else if (f.action === 'enable') store.saveCampaign({ ...c, status: 'active' })
      else if (
        f.action === 'set_budget' &&
        f.amount !== undefined &&
        Number.isFinite(Number(f.amount))
      )
        store.saveCampaign({ ...c, daily_budget: Number(f.amount) })
    }
    if (entry.stop_loss === true) {
      const c = store.campaigns().find((x) => x.external_id === entry.form?.[0]?.entity_id)
      if (c !== undefined)
        store.recordStopLoss({
          campaign_id: c.id,
          platform: c.platform,
          name: c.name,
          at: nowIso(),
          ...(c.metrics?.roas === undefined ? {} : { roas: c.metrics.roas }),
          ...(c.metrics?.spend === undefined ? {} : { spend: c.metrics.spend }),
          ...(c.daily_budget === undefined ? {} : { daily_budget: c.daily_budget }),
          reason: entry.sentence ?? '止损',
        })
      emit('ads.stop_loss_applied', {
        change_id: entry.change_id,
        platform: entry.platform,
        evidence_missing: entry.evidence_missing,
      })
    }
    // 新建的做完了、读回拿到了编号 → 出「开始投放」卡（决策 553）
    const creates = ops.filter((o) => o.kind.startsWith('create_') || o.kind === 'add_keyword')
    if (
      creates.length > 0 &&
      after !== undefined &&
      (entry.kind === 'ads_sheet' || entry.kind === 'create_campaign') &&
      entry.activation_change_id === undefined &&
      follow !== undefined
    ) {
      const activation = activationOpsFor(entry.platform, ops)
      const id = await follow.proposeActivation(entry, attachIdsFromExport(activation, after))
      if (id !== undefined) {
        entry.activation_change_id = id
        ledger.put(entry)
      }
    }
  }

  const handle = async (event: AdsActionEvent): Promise<void> => {
    const entry = ledger.byJob(event.job.id)
    if (entry === undefined) return
    const job = entry.jobs.find((j) => j.job_id === event.job.id)
    if (job === undefined) return
    entry.updated_at = nowIso()
    switch (event.type) {
      case 'evidence':
        entry.evidence.push({ id: event.evidence_id, tag: event.tag, job_id: job.job_id })
        ledger.put(entry)
        return
      case 'download': {
        const bytes = (options.readDownload ?? defaultRead)(event.file.path)
        const kept =
          bytes === undefined ? undefined : ledger.keepExport(job.job_id, event.file.tag, bytes)
        entry.downloads.push({
          tag: event.file.tag,
          name: event.file.name,
          job_id: job.job_id,
          ...(kept === undefined ? {} : { kept }),
        })
        if (kept !== undefined && (event.file.tag === 'snapshot' || event.file.tag === 'result'))
          ledger.noteLatestExport(entry.account, kept, nowIso())
        ledger.put(entry)
        return
      }
      case 'expired':
        job.status = 'expired'
        entry.state = 'expired'
        ledger.put(entry)
        emit('ads.change_expired', { change_id: entry.change_id })
        // 决策 558：排队 24 小时没人领作废 → 原样重出一张卡
        await follow?.reissue(entry.change_id)
        return
      case 'finished': {
        const r = event.result
        job.status = event.view.status
        job.finished_at = nowIso()
        if (r?.message !== undefined) job.message = r.message
        const reads = r?.reads ?? {}
        if (reads.preview_summary !== undefined) entry.preview_summary = reads.preview_summary
        if (reads.platform_errors !== undefined) entry.platform_errors = reads.platform_errors
        for (const tag of (reads.evidence_missing ?? '').split(',').filter((t) => t !== ''))
          if (!entry.evidence_missing.includes(tag)) entry.evidence_missing.push(tag)
        if (event.view.status !== 'done') {
          entry.state = event.view.status
          ledger.put(entry)
          emit(event.view.status === 'rejected' ? 'ads.change_rejected' : 'ads.change_failed', {
            change_id: entry.change_id,
            status: event.view.status,
            message: r?.message ?? '',
            ...(entry.platform_errors === undefined
              ? {}
              : { platform_errors: entry.platform_errors }),
          })
          return
        }
        // 磨合期从第一件**写操作**做成那天起算（只读的导出不算）
        if (entry.kind !== 'export_snapshot') ledger.noteFirstDone(entry.account, nowIso())
        entry.next += 1
        if (entry.next < units(entry)) {
          const level = entry.kind === 'pause_ad' && entry.stop_loss === true ? 'L3' : 'L1'
          const queued = await enqueueUnit(entry, level)
          if (!queued.ok) {
            entry.state = 'failed'
            ledger.put(entry)
            emit('ads.change_failed', { change_id: entry.change_id, message: queued.why })
          }
          return
        }
        await finalize(entry)
        return
      }
    }
  }

  const view = (e: LedgerEntry, live?: Map<string, AdsLedgerState>): AdsLedgerEntryView => {
    const undo = undoAvailability(e)
    // 还在跑的：插件那一侧的实时状态（在跑 / 等你确认）比账本里记的新
    const last = e.jobs[e.jobs.length - 1]
    const now = last === undefined ? undefined : live?.get(last.job_id)
    const state =
      (e.state === 'queued' || e.state === 'running' || e.state === 'waiting_confirm') &&
      now !== undefined
        ? now
        : e.state
    return {
      change_id: e.change_id,
      ...(e.approval_id === undefined ? {} : { approval_id: e.approval_id }),
      kind: e.kind,
      platform: e.platform,
      account_id: e.account_id,
      title: e.title,
      ...(e.sentence === undefined ? {} : { sentence: e.sentence }),
      ...(e.line === undefined ? {} : { line: e.line }),
      state,
      ...(e.stop_loss === true ? { stop_loss: true } : {}),
      jobs: e.jobs,
      evidence: e.evidence,
      evidence_missing: e.evidence_missing,
      files: e.downloads.map((d) => ({
        tag: d.tag,
        name: d.name,
        job_id: d.job_id,
        kept: d.kept !== undefined,
      })),
      ...(e.preview_summary === undefined ? {} : { preview_summary: e.preview_summary }),
      ...(e.platform_errors === undefined ? {} : { platform_errors: e.platform_errors }),
      ...(e.readback === undefined ? {} : { readback: e.readback }),
      undo,
      ...(e.undone_by === undefined ? {} : { undone_by: e.undone_by }),
      created_at: e.created_at,
      updated_at: e.updated_at,
      kept_until: ledger.keptUntil(e),
    }
  }

  return {
    async apply(change) {
      /*
       * WP420（自查 A1 / A2 / A3）：投放职责的广告卡**都归这里**，不再掉回内存桩假装成功。
       * 没有真执行器的（改出价 / 换素材、托管实例、X / TikTok、账户不在库里）一律照实回「没做」。
       */
      if (!isAdsRoleChange(change)) return undefined
      if (!WIRED_KINDS.has(change.kind)) return notDone(NOT_WIRED_KIND)
      if (options.actions() === undefined) return notDone(NOT_WIRED_HOSTED)
      const after = isRecord(change.after) ? change.after : {}
      const where = accountOf(change, after)
      if (where === undefined) return notDone(NOT_WIRED_ACCOUNT)
      const approval_id = change.approval?.item_id
      if (approval_id === undefined)
        return {
          status: 'failed',
          error: { message: '没有批过的卡，不动后台。', retryable: false },
        }
      const sheetKind = change.kind === 'ads_sheet' || change.kind === 'create_campaign'
      let files: LedgerEntry['files']
      let form: LedgerEntry['form']
      if (Array.isArray(after._files)) {
        const checked = checkCardFiles(after as Partial<AdsSheetCardAfter>)
        if (!checked.ok)
          return { status: 'failed', error: { message: checked.why, retryable: false } }
        files = checked.files
      } else {
        form = formOf(change, after)
        if (form === undefined)
          return {
            status: 'failed',
            error: {
              message: sheetKind
                ? '这张卡上没有上传表，插件没法建。用「改广告」那条路重新出一张带表的卡。'
                : '这张卡上没写清插件要点哪一格，没动后台。',
              retryable: false,
            },
          }
      }
      const reason = str(after.reason)
      const actor: LedgerActor | undefined =
        change.created_by.kind === 'person'
          ? {
              workspace_id: change.workspace_id,
              person_id: change.created_by.id,
              assignment_id: change.assignment_id,
              role_id: change.role_id,
            }
          : undefined
      const entry: LedgerEntry = {
        change_id: change.id,
        approval_id,
        kind: change.kind,
        platform: where.platform,
        account_id: where.account_id,
        account: where.account,
        ...(actor === undefined ? {} : { actor }),
        title: str(after.title) ?? titleOf(change, after),
        ...sentenceOf(after),
        ...lineOf(change, after, form),
        state: 'queued',
        ...(change.kind === 'pause_ad' &&
        reason === 'stop_loss' &&
        change.approval?.by === 'mandate'
          ? { stop_loss: true }
          : {}),
        ...(files === undefined ? {} : { files }),
        ...(form === undefined ? {} : { form }),
        ...(Array.isArray(after._ops) ? { ops: after._ops } : {}),
        next: 0,
        jobs: [],
        evidence: [],
        evidence_missing: [],
        downloads: [],
        ...undoOf(after),
        created_at: nowIso(),
        updated_at: nowIso(),
      }
      const queued = await enqueueUnit(entry, levelOf(change))
      if (!queued.ok) return { status: 'failed', error: { message: queued.why, retryable: false } }
      emit('ads.change_queued', {
        change_id: change.id,
        kind: change.kind,
        platform: where.platform,
        units: units(entry),
      })
      return {
        status: 'ok',
        execution_id: `ads_ext_${entry.jobs[0]?.job_id ?? change.id}`,
        outcome_ref: { type: 'ads_change', id: change.id },
      }
    },

    onActionEvent(event) {
      pending = pending.then(() => handle(event)).catch(() => undefined)
    },

    settled: () => pending,

    available: () => options.actions() !== undefined,

    extensionReady(platform) {
      const svc = options.actions()
      if (svc === undefined) return false
      const p = actionPlatformOf(platform)
      const seen = svc.lastSeen(p)
      const consented = svc.settings().consent[p] !== undefined
      return consented && seen !== undefined && options.nowMs() - seen < EXTENSION_FRESH_MS
    },

    breakIn: (account) => ledger.breakInUntil(account),

    latestExport(account) {
      const latest = ledger.latestExport(account)
      if (latest === undefined || options.nowMs() - Date.parse(latest.at) > 24 * 60 * 60 * 1000)
        return undefined
      return parseKept(latest.kept)
    },

    async requestSnapshot(account) {
      const svc = options.actions()
      if (svc === undefined) return { ok: false, message: '这台机器没装插件动作通道。' }
      const job = buildAdsJob({
        id: `adsj_${options.id()}`,
        workspace_id: options.workspace_id,
        account,
        action: { kind: 'export_snapshot' },
        created_at: nowIso(),
        ...(options.origins === undefined ? {} : { origins: options.origins }),
      })
      const queued = await svc.enqueue(job)
      if (!queued.ok) return { ok: false, message: queued.why }
      // 记成一条只读的账本（导出下来就成了这个账户「最近一份导出」）
      ledger.put({
        change_id: `snapshot_${job.id}`,
        kind: 'export_snapshot',
        platform: account.platform === 'google_ads' ? 'google' : 'meta',
        account_id: account.id,
        account,
        title: '导出改前表',
        state: 'queued',
        next: 0,
        jobs: [{ job_id: job.id, status: 'queued' }],
        evidence: [],
        evidence_missing: [],
        downloads: [],
        created_at: nowIso(),
        updated_at: nowIso(),
      })
      return { ok: true, message: '已排队：插件下次来领活时导出一份。' }
    },

    entry: (id) => ledger.get(id),
    entries() {
      const live = new Map<string, AdsLedgerState>(
        (options.actions()?.jobs() ?? []).map((j) => [j.id, j.status as AdsLedgerState]),
      )
      return ledger.list().map((e) => view(e, live))
    },
    async evidenceImage(id) {
      if (!ledger.list().some((e) => e.evidence.some((x) => x.id === id))) return undefined
      return options.actions()?.evidenceImage(id)
    },
    confirm(change_id, submit) {
      const svc = options.actions()
      const e = ledger.get(change_id)
      if (svc === undefined || e === undefined) return { ok: false, message: '账本里没有这一条。' }
      const waiting = new Set(
        svc
          .jobs()
          .filter((j) => j.status === 'waiting_confirm')
          .map((j) => j.id),
      )
      const job = e.jobs.find((j) => waiting.has(j.job_id))
      if (job === undefined) return { ok: false, message: '这一条现在不在等确认。' }
      if (submit) {
        const v = svc.confirm(job.job_id)
        return v === undefined
          ? { ok: false, message: '没确认上（这件活已经结束了）。' }
          : { ok: true, message: '已确认，插件这就提交。' }
      }
      svc.stop(job.job_id)
      return { ok: true, message: '不提交了：插件停下，平台预览留在后台里没应用。' }
    },
    waitingConfirm() {
      const svc = options.actions()
      if (svc === undefined) return []
      const waiting = new Set(
        svc
          .jobs()
          .filter((j) => j.status === 'waiting_confirm')
          .map((j) => j.id),
      )
      const out: { entry: AdsLedgerEntryView; job_id: string; preview_evidence?: string }[] = []
      for (const e of ledger.list()) {
        const job = e.jobs.find((j) => waiting.has(j.job_id))
        if (job === undefined) continue
        const shot = [...e.evidence]
          .reverse()
          .find((x) => x.job_id === job.job_id && x.tag === 'preview')
        out.push({
          entry: view(e),
          job_id: job.job_id,
          ...(shot === undefined ? {} : { preview_evidence: shot.id }),
        })
      }
      return out
    },
    setFollowUps(f) {
      follow = f
    },
    sweep() {
      ledger.prune()
    },
  }
}

/** 投放职责的那几种广告卡（这几种不许掉回内存桩）。 */
const ADS_ROLE_KINDS: ReadonlySet<ChangeKind> = new Set<ChangeKind>([
  ...WIRED_KINDS,
  'bid_change',
  'creative_swap',
])

/** WP420：这张卡是不是投放职责的广告卡（别的职责同名的 kind 不归这里）。 */
export function isAdsRoleChange(change: Pick<StagedChange, 'kind' | 'role_id'>): boolean {
  return ADS_ROLE_KINDS.has(change.kind) && String(change.role_id ?? '').startsWith('ads.')
}

export const NOT_WIRED_KIND =
  `${NOT_WIRED_ERROR_PREFIX}还没接通：改出价 / 换素材工坊还不能替你去后台改，这一下没做。请你自己在广告后台改。`
export const NOT_WIRED_HOSTED =
  `${NOT_WIRED_ERROR_PREFIX}还没接通：这台没有浏览器插件，改不到你的广告后台，这一下没做。去装了插件的桌面版里再提一次。`
export const NOT_WIRED_ACCOUNT =
  `${NOT_WIRED_ERROR_PREFIX}还没接通：这个广告账户插件还不会点（只接了 Google / Meta），这一下没做。请你自己在后台改。`

// WP415 统一口径：带 `not_wired` 与前缀，卡、时间线、记录面板照「没做 · 还没接通」显示（前缀上屏前去掉）
const notDone = (message: string): BackendResult => ({
  status: 'failed',
  not_wired: true,
  error: { message, retryable: false },
})

/** WP420（自查 A17）：账本那一行人话。 */
function lineOf(
  change: StagedChange,
  after: Record<string, unknown>,
  form: LedgerEntry['form'],
): { line?: string } {
  const f = form?.[0]
  const name = f?.entity_name ?? str(after.name)
  const before = isRecord(change.before) ? change.before : {}
  if (change.kind === 'budget_change' && f?.amount !== undefined) {
    const was = typeof before.value === 'number' ? `${amountText(before.value)} → ` : '→ '
    return { line: `${name ?? ''} 日预算 ${was}${f.amount}`.trim() }
  }
  if (change.kind === 'pause_ad')
    return {
      line: `${str(after.reason) === 'stop_loss' ? '止损暂停' : '暂停'}${name === undefined ? '' : ` ${name}`}`,
    }
  return name === undefined ? {} : { line: `${titleOf(change, after)}（${name}）` }
}

function sentenceOf(after: Record<string, unknown>): { sentence?: string } {
  const s = str(after.sentence) ?? str(after.stop_loss_reason)
  return s === undefined ? {} : { sentence: s }
}

function undoOf(after: Record<string, unknown>): { undo_of?: string } {
  const s = str(after.undo_of)
  return s === undefined ? {} : { undo_of: s }
}

function titleOf(change: StagedChange, after: Record<string, unknown>): string {
  const name = str(after.name)
  switch (change.kind) {
    case 'pause_ad':
      return str(after.reason) === 'stop_loss' ? '止损暂停' : '暂停'
    case 'budget_change':
      return '改预算'
    case 'create_campaign':
      return `新建广告系列${name === undefined ? '' : `：${name}`}`
    case 'ads_activate':
      return '开始投放'
    case 'ads_undo':
      return '撤销改动'
    default:
      return '改广告'
  }
}

/** 能不能撤销（一句为什么不能）。 */
export function undoAvailability(e: LedgerEntry): { available: boolean; why?: string } {
  if (e.kind === 'ads_undo' || e.kind === 'export_snapshot')
    return { available: false, why: '这一条本身就是撤销 / 只读。' }
  if (e.undone_by !== undefined) return { available: false, why: '已经撤过了。' }
  if (e.jobs.every((j) => j.status !== 'done'))
    return { available: false, why: '还没做成，没东西可撤。' }
  if (e.form === undefined && (e.ops === undefined || e.ops.length === 0) && e.platform === 'meta')
    return { available: false, why: '这一条没留下改动清单，没法反着改。' }
  return { available: true }
}
