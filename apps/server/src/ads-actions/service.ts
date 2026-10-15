/**
 * WP313（docs/101 §5.4）：**一个品牌一份**的插件动作通道（广告后台）。
 *
 * 装的东西：排队（24 小时作废：558）、节奏（同一账户一次一件、每天写 ≤ 20 读 ≤ 2：555）、
 * 「默认不碰」十个区域的开关（默认全关、逐项放开、放开后 L1：557）、连接时的同意记录（562）、
 * 上传表本体（按件存，插件按 id 来取）、截图（交给 {@link ActionEvidenceStore}：556）、下载到哪。
 *
 * 落盘：`<品牌目录>/ads-actions/state.json`（排队 + 节奏 + 开关 + 同意 + 下载记录）、
 * `sheets/<件 id>.bin`（上传表原样字节，做完就删）、`evidence/`（截图，180 天）。
 * 没有目录 = 纯内存（测试与一次性进程）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type ActionDownloadInput,
  type ActionEvidenceStore,
  type ActionJob,
  type ActionJobView,
  type ActionPlatform,
  ActionQueue,
  type ActionResult,
  ADS_CONSENT_TEXT_VERSION,
  type AdsActionSettings,
  type AdsConsentRecord,
  base64ToBytes,
  bytesToBase64,
  EVIDENCE_MAX_BYTES,
  type GuardedZoneId,
  type GuardedZoneSettings,
  isFinal,
  normalizeZoneSettings,
  Pace,
  type PaceState,
  type QueuedJob,
  type QueueState,
  sheetFingerprint,
  validateJob,
} from '@agentsws/browser-action'

/** 告知文案的版本（真源在公共模块；文案在 WP318，改了文案就升这个号，老的同意不再算数）。 */
export { ADS_CONSENT_TEXT_VERSION }

/** 完结的活在排队表里留多久（账本里另有记录）。 */
const KEEP_FINISHED_MS = 7 * 24 * 60 * 60 * 1000

/** 没活时让插件隔多久再来问。 */
const IDLE_RETRY_MS = 60_000

interface StateFile {
  version: 1
  queue: QueueState
  pace: PaceState
  zones: GuardedZoneSettings
  consent: Partial<Record<ActionPlatform, AdsConsentRecord>>
  downloads: Record<string, ActionDownloadInput[]>
  /** WP329：插件最近一次带着这家来领活是什么时候（毫秒）。判「插件连着 Reddit 没有」用。 */
  seen?: Partial<Record<ActionPlatform, number>>
}

/** 上层要知道的几件事（WP316 接：作废了重出卡、做完了记账本、截图挂到账本上）。 */
export type AdsActionEvent =
  | { type: 'expired'; job: ActionJob }
  /** `result` 是插件交回的原样结局（WP329：Reddit 写的读回编号 / 链接在 `result.reads` 里）。 */
  | { type: 'finished'; job: ActionJob; view: ActionJobView; result?: ActionResult }
  | { type: 'evidence'; job: ActionJob; evidence_id: string; tag: string }
  | { type: 'download'; job: ActionJob; file: ActionDownloadInput }

export interface AdsActionsServiceOptions {
  workspace_id: string
  /** `<品牌目录>/ads-actions`；不给 = 纯内存。 */
  dir?: string
  nowMs(): number
  evidence: ActionEvidenceStore
  onEvent?(event: AdsActionEvent): void
  /** 当前告知文案的版本（默认 {@link ADS_CONSENT_TEXT_VERSION}）。 */
  consentTextVersion?: string
  /** WP329：某类活记在另一本账上（Reddit 写记在 WP328 巡查那一本）。回 `undefined` 用这里自己那一本。 */
  paceFor?(job: ActionJob): Pace | undefined
  /** 测试用：长轮询的等待（默认真的等）。 */
  wait?(ms: number, wake: Promise<void>): Promise<void>
}

export interface AdsActionsService {
  readonly workspace_id: string
  next(
    platforms: ActionPlatform[],
    wait_ms: number,
  ): Promise<{
    job?: ActionJob
    retry_after_ms: number
    needs_consent?: ActionPlatform[]
  }>
  sheet(id: string): { name: string; mime: string; base64: string; fingerprint: string } | undefined
  progress(
    id: string,
    input: { step: number; of: number; label: string; waiting_confirm?: boolean },
  ): { stop: boolean; confirmed: boolean } | undefined
  evidence(
    id: string,
    input: {
      tag: 'before' | 'preview' | 'after'
      png_base64: string
      url: string
      taken_at: string
    },
  ): Promise<{ id: string; kept_until: string } | undefined>
  download(id: string, input: ActionDownloadInput): { recorded: true } | undefined
  result(
    id: string,
    input: {
      outcome: 'done' | 'failed' | 'handover' | 'stopped' | 'rejected'
      message: string
      step: number
      reads: Record<string, string>
    },
  ): ActionJobView | undefined
  consent(platform: ActionPlatform, text_version: string): AdsActionSettings
  revokeConsent(platform: ActionPlatform): AdsActionSettings
  settings(): AdsActionSettings
  setZone(zone: GuardedZoneId, enabled: boolean): AdsActionSettings
  jobs(): ActionJobView[]
  stop(id: string): ActionJobView | undefined
  confirm(id: string): ActionJobView | undefined
  enqueue(
    job: ActionJob,
    sheet_bytes?: Uint8Array,
  ): Promise<{ ok: true; job: ActionJobView } | { ok: false; why: string }>
  /** 到点清理（作废、断了音讯的记失败、截图过期）。服务端定时调。 */
  sweep(): Promise<void>
  /** WP329：插件最近一次带着这家来领活的时间（毫秒；没来过 = undefined）。 */
  lastSeen(platform: ActionPlatform): number | undefined
  downloads(id: string): ActionDownloadInput[]
  /** WP316：读回一张截图（变更账本 / 再确认卡上看；过了 180 天就没了）。 */
  evidenceImage(id: string): Promise<Uint8Array | undefined>
  close(): void
}

function viewOf(row: QueuedJob, waiting?: string): ActionJobView {
  const j = row.job
  return {
    id: j.id,
    title: j.title,
    platform: j.plan.platform,
    account_id: j.account.id,
    kind: j.plan.kind,
    status: row.status,
    ...(j.approval_id === undefined ? {} : { approval_id: j.approval_id }),
    created_at: j.created_at,
    ...(row.progress === undefined ? {} : { progress: row.progress }),
    ...(row.result === undefined
      ? {}
      : {
          result: {
            outcome: row.result.outcome,
            message: row.result.message,
            step: row.result.step,
            finished_at: new Date(row.result.finished_at_ms).toISOString(),
          },
        }),
    ...(waiting === undefined ? {} : { waiting }),
  }
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47]

export function createAdsActionsService(options: AdsActionsServiceOptions): AdsActionsService {
  const dir = options.dir
  const stateFile = dir === undefined ? undefined : join(dir, 'state.json')
  const consentVersion = options.consentTextVersion ?? ADS_CONSENT_TEXT_VERSION

  const loaded = ((): StateFile | undefined => {
    if (stateFile === undefined || !existsSync(stateFile)) return undefined
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8')) as StateFile
      return raw.version === 1 ? raw : undefined
    } catch {
      return undefined
    }
  })()

  const pace = new Pace({ state: loaded?.pace ?? {} })
  const queue = new ActionQueue({
    pace,
    state: loaded?.queue ?? [],
    ...(options.paceFor === undefined ? {} : { paceFor: (job) => options.paceFor?.(job) }),
  })
  let zones = normalizeZoneSettings(loaded?.zones)
  const consent: Partial<Record<ActionPlatform, AdsConsentRecord>> = { ...(loaded?.consent ?? {}) }
  const downloads: Record<string, ActionDownloadInput[]> = { ...(loaded?.downloads ?? {}) }
  const seen: Partial<Record<ActionPlatform, number>> = { ...(loaded?.seen ?? {}) }
  /** 没有目录时上传表放内存里。 */
  const sheetsInMemory = new Map<string, Uint8Array>()
  let waiters: (() => void)[] = []

  const save = (): void => {
    if (stateFile === undefined || dir === undefined) return
    const body: StateFile = {
      version: 1,
      queue: queue.snapshot(),
      pace: pace.snapshot(),
      zones,
      consent,
      downloads,
      seen,
    }
    mkdirSync(dir, { recursive: true })
    const tmp = `${stateFile}.tmp`
    writeFileSync(tmp, JSON.stringify(body))
    renameSync(tmp, stateFile)
  }

  const sheetPath = (id: string): string | undefined =>
    dir === undefined ? undefined : join(dir, 'sheets', `${id.replace(/[^\w.-]/gu, '_')}.bin`)
  const putSheet = (id: string, bytes: Uint8Array): void => {
    const p = sheetPath(id)
    if (p === undefined) {
      sheetsInMemory.set(id, bytes)
      return
    }
    mkdirSync(join(dir as string, 'sheets'), { recursive: true })
    writeFileSync(p, bytes)
  }
  const getSheet = (id: string): Uint8Array | undefined => {
    const p = sheetPath(id)
    if (p === undefined) return sheetsInMemory.get(id)
    return existsSync(p) ? new Uint8Array(readFileSync(p)) : undefined
  }
  const dropSheet = (id: string): void => {
    const p = sheetPath(id)
    if (p === undefined) sheetsInMemory.delete(id)
    else rmSync(p, { force: true })
  }

  const wake = (): void => {
    const list = waiters
    waiters = []
    for (const w of list) w()
  }

  const settings = (): AdsActionSettings => ({ zones: { ...zones }, consent: { ...consent } })

  /**
   * 广告后台要在插件里勾过风险告知（562）；Reddit 不要（WP329：插件只填草稿、人自己点发送，
   * 没有「替你点了一个改钱的按钮」那一类风险，连接时浏览器的权限弹窗就是那一下同意）。
   */
  const consented = (p: ActionPlatform): boolean =>
    p === 'reddit' || consent[p]?.text_version === consentVersion

  /** 这件活属于这个品牌、还没结束。 */
  const live = (id: string): QueuedJob | undefined => {
    const row = queue.get(id)
    return row === undefined || isFinal(row.status) ? undefined : row
  }

  const settle = (changed: readonly QueuedJob[]): void => {
    for (const row of changed) {
      dropSheet(row.job.id)
      if (row.status === 'expired') options.onEvent?.({ type: 'expired', job: row.job })
      else
        options.onEvent?.({
          type: 'finished',
          job: row.job,
          view: viewOf(row),
          ...(row.result === undefined ? {} : { result: row.result }),
        })
    }
  }

  const defaultWait = (ms: number, woke: Promise<void>): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms)
      void woke.then(() => {
        clearTimeout(t)
        resolve()
      })
    })

  const tryClaim = (platforms: ActionPlatform[]): ActionJob | undefined => {
    const now = options.nowMs()
    const expired = queue.sweep(now)
    settle(expired)
    const row = queue.claim(platforms.filter(consented), now)
    if (expired.length > 0 || row !== undefined) save()
    return row?.job
  }

  return {
    workspace_id: options.workspace_id,

    async next(platforms, wait_ms) {
      const now = options.nowMs()
      // 一分钟内只落一次盘（插件每分钟来一次）
      let touched = false
      for (const p of platforms)
        if ((seen[p] ?? 0) < now - 60_000) {
          seen[p] = now
          touched = true
        }
      if (touched) save()
      const needs = platforms.filter((p) => !consented(p))
      const extra = needs.length === 0 ? {} : { needs_consent: needs }
      let job = tryClaim(platforms)
      if (job === undefined && wait_ms > 0 && needs.length < platforms.length) {
        const woke = new Promise<void>((resolve) => waiters.push(resolve))
        await (options.wait ?? defaultWait)(wait_ms, woke)
        job = tryClaim(platforms)
      }
      return job === undefined
        ? { retry_after_ms: IDLE_RETRY_MS, ...extra }
        : { job, retry_after_ms: 0, ...extra }
    },

    sheet(id) {
      const row = live(id)
      if (row === undefined || row.job.sheet === undefined) return undefined
      const bytes = getSheet(id)
      if (bytes === undefined) return undefined
      return {
        name: row.job.sheet.name,
        mime: row.job.sheet.mime,
        base64: bytesToBase64(bytes),
        fingerprint: row.job.sheet.fingerprint,
      }
    },

    progress(id, input) {
      const out = queue.progress(id, input, options.nowMs())
      if (out !== undefined) save()
      return out
    },

    async evidence(id, input) {
      const row = live(id)
      if (row === undefined) return undefined
      let png: Uint8Array
      try {
        png = base64ToBytes(input.png_base64)
      } catch {
        return undefined
      }
      if (png.byteLength > EVIDENCE_MAX_BYTES || !PNG_MAGIC.every((b, i) => png[i] === b))
        return undefined
      const record = await options.evidence.put({
        workspace_id: options.workspace_id,
        job_id: id,
        ...(row.job.approval_id === undefined ? {} : { approval_id: row.job.approval_id }),
        tag: input.tag,
        url: input.url,
        taken_at: input.taken_at,
        png,
      })
      queue.touch(id, options.nowMs())
      save()
      options.onEvent?.({ type: 'evidence', job: row.job, evidence_id: record.id, tag: input.tag })
      return { id: record.id, kept_until: record.kept_until }
    },

    download(id, input) {
      const row = live(id)
      if (row === undefined) return undefined
      downloads[id] = [...(downloads[id] ?? []), input]
      queue.touch(id, options.nowMs())
      save()
      options.onEvent?.({ type: 'download', job: row.job, file: input })
      return { recorded: true }
    },

    result(id, input) {
      const row = queue.finish(id, input, options.nowMs())
      if (row === undefined) return undefined
      settle([row])
      queue.prune(options.nowMs(), KEEP_FINISHED_MS)
      save()
      wake()
      return viewOf(row)
    },

    consent(platform, text_version) {
      consent[platform] = {
        platform,
        accepted_at: new Date(options.nowMs()).toISOString(),
        text_version,
      }
      save()
      wake()
      return settings()
    },

    revokeConsent(platform) {
      delete consent[platform]
      save()
      return settings()
    },

    settings,

    setZone(zone, enabled) {
      zones = { ...zones, [zone]: enabled }
      save()
      return settings()
    },

    jobs() {
      const now = options.nowMs()
      const waiting = new Map(queue.waiting(now).map((w) => [w.id, w.why]))
      return [...queue.list()].reverse().map((row) => viewOf(row, waiting.get(row.job.id)))
    },

    stop(id) {
      const row = queue.requestStop(id, options.nowMs())
      if (row === undefined) return undefined
      if (isFinal(row.status)) dropSheet(id)
      save()
      return viewOf(row)
    },

    confirm(id) {
      if (!queue.confirm(id)) return undefined
      save()
      const row = queue.get(id)
      return row === undefined ? undefined : viewOf(row)
    },

    async enqueue(job, sheet_bytes) {
      if (job.workspace_id !== options.workspace_id)
        return { ok: false, why: '这件活不是这个品牌的。' }
      const checked = validateJob(job, { zones })
      if (!checked.ok) return checked
      if (job.sheet !== undefined) {
        if (sheet_bytes === undefined) return { ok: false, why: '要上传表，但没带表的内容。' }
        if ((await sheetFingerprint(sheet_bytes)) !== job.sheet.fingerprint)
          return { ok: false, why: '上传表和审批时绑的不是同一份（指纹对不上），不进队。' }
        putSheet(job.id, sheet_bytes)
      }
      const row = queue.enqueue(checked.job, options.nowMs())
      save()
      wake()
      return { ok: true, job: viewOf(row) }
    },

    async sweep() {
      const now = options.nowMs()
      const changed = queue.sweep(now)
      settle(changed)
      if (changed.length > 0) save()
      await options.evidence.prune(now)
    },

    downloads(id) {
      return [...(downloads[id] ?? [])]
    },

    lastSeen(platform) {
      return seen[platform]
    },

    evidenceImage: (id) => options.evidence.read(id),

    close() {
      wake()
    },
  }
}
