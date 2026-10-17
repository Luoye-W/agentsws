/**
 * WP387（docs/103 v2 §3.3、R3、T1，Luoye 10-17）：**你的浏览器替你建 / 导入 Google 提醒**——服务端那一半。
 *
 * | 一步 | 在哪 |
 * |---|---|
 * | 配置卡确认清单后点「让工坊替你建」→ 一张「改东西」卡（`google_alert_change`，一批一张、每行可勾掉） | {@link PrAlertsService.propose} |
 * | 卡同意 → 记一趟、开一件事、带着凭据（`browser_grants`）让你的浏览器去建；进了队就回 ok | {@link PrAlertsService.apply} |
 * | 那一次运行的门禁：只有这件事、这一趟还在跑时才有凭据 | {@link PrAlertsService.grantsFor} |
 * | 浏览器交回结果（`report_google_alerts`）→ 监控源（`added_via: 'browser'`）+ 先拉一次 + 没建成的退回手动 | {@link PrAlertsService.report} |
 * | 只读一遍已有的 → RSS 投递的列成一张勾选卡（配置卡，不是改东西卡）；邮箱投递的出「改成 RSS」卡 | {@link PrAlertsService.readExisting} / {@link PrAlertsService.importTarget} |
 *
 * 纪律：
 * - **一批一张卡、一次同意**（T1）；卡上只有「勾掉」能改（`approvedLines`），查询语句改不了；
 * - **只碰卡上那几条**：读回结果里卡外的行不认；
 * - **读回的必须是 RSS 链接**，不是就算没建成；没建成的明确列出来、退回手动贴链接，**不自动重试第二轮**；
 * - feed 地址本身就是钥匙：不进事件、不进模型看得到的工具回话（回话里只有条数和人话名）。
 */
import type {
  ApprovalItem,
  ExistingGoogleAlert,
  GoogleAlertLine,
  GoogleAlertOp,
  GoogleAlertsExistingView,
  GoogleAlertsJob,
  GoogleAlertsPanelView,
  GoogleAlertsReport,
  Iso8601,
  MonitorGroup,
  MonitorSource,
  PrWatchStore,
  RunBrowserGrant,
  StagedChange,
  WorkspaceId,
} from '@agentsws/contracts'
import { GOOGLE_ALERT_CHANGE_FORM, maskFeedUrl } from '@agentsws/contracts'
import {
  alertChangeOf,
  alertLinesFromPlan,
  alertsSummary,
  approvedLines,
  buildAlertsBrief,
  ingestAlertsReport,
  isGoogleAlertsFeedUrl,
  labelOfQuery,
  normalizeAlertQuery,
  readExistingBrief,
  splitExisting,
  toRssLines,
} from '@agentsws/pr-core'
import type { GoogleAlertsToolData } from '@agentsws/stand-ins'
import type { BackendResult, StageInput, StageOutcome } from '@agentsws/txn'
import type { SetupTarget } from '../setup-cards.js'

/** 谁在做（信息监控那条职责的持有人）。 */
export interface PrAlertsActor {
  person_id: string
  assignment_id: string
  role_id: string
}

/** 「运行中的浏览器」看得到的那件事。 */
export interface PrAlertsRunHost {
  /** 开一件事（标题即任务名），回事项 id。 */
  open(input: { actor: PrAlertsActor; title: string }): string
  /** 在那件事上跑一次（带浏览器；凭据由 `grantsFor` 现查）。跑完 resolve。 */
  start(input: { actor: PrAlertsActor; matter_id: string; brief: string }): Promise<void>
}

export interface PrAlertsOptions {
  workspace_id: WorkspaceId
  /** 这个品牌的信息监控库（WP386）。没接 = 这一路不可用。 */
  store(): PrWatchStore | undefined
  clock: { now(): Iso8601 }
  newId(prefix: string): string
  ledger: { stage(input: StageInput): Promise<StageOutcome> }
  actionOf(
    assignment_id: string,
    action: string,
  ): { mandate: StageInput['mandate']; level: StageInput['level'] }
  /** 信息监控那条职责现在谁担着（没人担 = 这一路不可用）。 */
  holder(): PrAlertsActor | undefined
  /** 卡（人可能勾掉了几行：`approve_edited` 的载荷）。 */
  approval(item_id: string): Promise<ApprovalItem | undefined> | ApprovalItem | undefined
  /** 你的浏览器接上了没有（设置 → 浏览器选的是「我正在用的浏览器」且装好了）。 */
  browser(): { ready: true } | { ready: false; reason: string }
  runs: PrAlertsRunHost
  /**
   * 读回的链接交给信息监控存成源（WP386 的 `addLinks`，`added_via: 'browser'`）：先拉一次，拉到了才算配好、
   * 拉回来的直接进提及库、配置卡那一行挂上。不给 = 自己存成 `unchecked`，等定时那一轮拉。
   */
  attach?(input: {
    url: string
    plan_item_id?: string
    group: MonitorGroup
  }): Promise<{ ok: true; source_id: string } | { ok: false; message: string }>
  /** 要一张配置卡（导入勾选卡；WP324 `askSetup`）。 */
  askSetup?(input: { target: string; why: string; actor: PrAlertsActor }): Promise<unknown>
  /** 没建成的退回手动（WP386 的配置卡：贴 RSS 链接的格子 + 教程）。 */
  onFallback?(input: {
    lines: GoogleAlertLine[]
    why: string
    actor: PrAlertsActor
  }): Promise<void> | void
  /** 审计事件（只有 id / 数字 / 种类，没有链接）。 */
  emit?(type: string, payload: Record<string, unknown>): void
}

export interface PrAlertsService {
  /** 出一张「要在你的 Google 账号里建 N 条提醒」的卡（清单默认取配置卡上确认过、还没挂上源的）。 */
  propose(
    actor?: PrAlertsActor,
    input?: { op?: GoogleAlertOp; lines?: GoogleAlertLine[] },
  ): Promise<
    | { ok: true; approval_id: string; change_id: string; count: number }
    | { ok: false; reason: string }
  >
  /** 只读一遍已有的提醒（不出卡；开一件事让你的浏览器去读）。 */
  readExisting(
    actor?: PrAlertsActor,
  ): Promise<{ ok: true; matter_id: string } | { ok: false; reason: string }>
  /** 账本执行器：卡同意了。不是这种卡回 `undefined`。 */
  apply(change: StagedChange): Promise<BackendResult | undefined>
  /** 这件事这次运行有没有改提醒的凭据。 */
  grantsFor(matter_id: string): RunBrowserGrant[]
  /** 浏览器交回结果（`report_google_alerts`）。`grants` 是那次运行请求上带的。 */
  report(
    input: GoogleAlertsReport,
    ctx: { grants?: readonly RunBrowserGrant[] },
  ): Promise<GoogleAlertsToolData>
  /** 读到的已有提醒（能导入的 / 邮箱投递的）。 */
  existing(): GoogleAlertsExistingView
  /** 勾了的导入（只认读到过的 RSS 链接）。 */
  importFeeds(feed_urls: readonly string[]): Promise<{ imported: number; failed: number }>
  /** 最近几趟（新的在前）。 */
  jobs(): GoogleAlertsJob[]
  /** 导入勾选卡的设置目标（`pr.alerts_import`）。 */
  importTarget(): SetupTarget
  /** 面板 / 接口看的那一份（链接只出脱敏那一格）。 */
  panel(): GoogleAlertsPanelView
}

const JOBS_KEY = 'alerts_build_jobs'
const EXISTING_KEY = 'alerts_existing'
/** 一趟跑了这么久还没交代结果，就当没走完（凭据也跟着收回）。 */
const STALE_MS = 45 * 60_000
/** 留几趟记录。 */
const KEEP_JOBS = 20

export const ALERTS_IMPORT_TARGET = 'pr.alerts_import'

interface ExistingRecord {
  read_at: Iso8601
  alerts: ExistingGoogleAlert[]
}

export function createPrAlertsService(o: PrAlertsOptions): PrAlertsService {
  const ms = (iso: string): number => Date.parse(iso)

  const loadJobs = (store: PrWatchStore): GoogleAlertsJob[] =>
    store.kv<GoogleAlertsJob[]>(JOBS_KEY) ?? []
  const saveJob = (store: PrWatchStore, job: GoogleAlertsJob): void => {
    const rest = loadJobs(store).filter((j) => j.change_id !== job.change_id)
    store.setKv(JOBS_KEY, [job, ...rest].slice(0, KEEP_JOBS))
  }

  /** 跑了太久还没交代结果的那一趟：当没走完（凭据跟着收回），没建成的退回手动。 */
  const settleStale = (store: PrWatchStore): void => {
    const now = o.clock.now()
    for (const j of loadJobs(store)) {
      if (j.status !== 'running' && j.status !== 'queued') continue
      if (ms(now) - ms(j.updated_at) < STALE_MS) continue
      saveJob(store, {
        ...j,
        status: 'failed',
        stop: 'other',
        summary:
          '浏览器那一趟跑完了，但没交代结果：去 Google 提醒页看一眼，建好的把 RSS 链接贴回配置卡。',
        updated_at: now,
      })
    }
  }

  const ensure = (
    actor: PrAlertsActor | undefined,
  ): { store: PrWatchStore; actor: PrAlertsActor } | { reason: string } => {
    const store = o.store()
    if (store === undefined) return { reason: '信息监控还没准备好' }
    const who = actor ?? o.holder()
    if (who === undefined) return { reason: '还没有人担「信息监控」这条职责' }
    return { store, actor: who }
  }

  const stageCard = async (
    actor: PrAlertsActor,
    op: GoogleAlertOp,
    lines: GoogleAlertLine[],
  ): Promise<
    { ok: true; approval_id: string; change_id: string } | { ok: false; reason: string }
  > => {
    const run_id = `run_alerts_${o.newId('r')}`
    const target = { type: 'google_alerts', id: o.workspace_id }
    const card = alertChangeOf(op, lines)
    const { mandate, level } = o.actionOf(actor.assignment_id, 'stage_google_alert_change')
    const out = await o.ledger.stage({
      workspace_id: o.workspace_id,
      role_id: actor.role_id,
      assignment_id: actor.assignment_id,
      run_id: run_id as never,
      change_set_id: `cs_${run_id}`,
      kind: 'google_alert_change',
      target,
      // 两种卡（新建 / 改成 RSS）各自去重：同一种还有一张没处理，就不再出第二张
      field: op,
      before: null,
      after: { form: GOOGLE_ALERT_CHANGE_FORM, ...card.after },
      notes: [],
      created_by: { kind: 'agent', id: `agent_${actor.role_id}` },
      mandate,
      level,
      provenance: {
        run_id: run_id as never,
        seen: { google_alerts: [o.workspace_id] },
        read_full: [`google_alerts:${o.workspace_id}`],
        recorded_at: o.clock.now(),
      },
      approval: {
        title: card.title,
        summary: card.summary,
        recipients: [{ person: actor.person_id as never, via: 'role_holder' }],
        proposer: {
          kind: 'agent',
          id: `agent_${actor.role_id}`,
          assignment_id: actor.assignment_id as never,
        },
        rule: 'role_holder',
        separation_of_duties: false,
        source_events: [],
      },
    })
    if (!out.ok) return { ok: false, reason: out.message }
    o.emit?.('pr_alerts.card_staged', {
      change_id: out.change.id,
      op,
      lines: lines.length,
    })
    return { ok: true, approval_id: out.approval.id, change_id: out.change.id }
  }

  const service: PrAlertsService = {
    async propose(actor, input) {
      const got = ensure(actor)
      if ('reason' in got) return { ok: false, reason: got.reason }
      const op = input?.op ?? 'create'
      const lines = input?.lines ?? alertLinesFromPlan(got.store.planItems(), got.store.sources())
      if (lines.length === 0)
        return { ok: false, reason: '清单上没有要建的提醒（都已经挂上监控源了，或者都勾掉了）' }
      const staged = await stageCard(got.actor, op, lines)
      return staged.ok ? { ...staged, count: lines.length } : staged
    },

    async readExisting(actor) {
      const got = ensure(actor)
      if ('reason' in got) return { ok: false, reason: got.reason }
      const b = o.browser()
      if (!b.ready) return { ok: false, reason: b.reason }
      const matter_id = o.runs.open({ actor: got.actor, title: '读一遍你已有的 Google 提醒' })
      void o.runs
        .start({ actor: got.actor, matter_id, brief: readExistingBrief() })
        .catch(() => undefined)
      return { ok: true, matter_id }
    },

    async apply(change) {
      if (change.kind !== 'google_alert_change') return undefined
      const got = ensure(undefined)
      if ('reason' in got)
        return { status: 'failed', error: { message: `${got.reason}，没去建。`, retryable: false } }
      const { store } = got
      const item =
        change.approval?.item_id === undefined
          ? undefined
          : await o.approval(change.approval.item_id)
      const edited = item?.state === 'approved_edited' ? item.payload : undefined
      const after = change.after as { op?: GoogleAlertOp } | null
      const op: GoogleAlertOp = after?.op === 'to_rss' ? 'to_rss' : 'create'
      const lines = approvedLines(change.after, edited)
      const now = o.clock.now()
      if (lines.length === 0) {
        return { status: 'ok', outcome_ref: { type: 'google_alerts_job', id: change.id } }
      }
      const actor: PrAlertsActor = o.holder() ?? {
        person_id: change.created_by.id,
        assignment_id: change.assignment_id,
        role_id: change.role_id,
      }
      const b = o.browser()
      if (!b.ready) {
        const why = `${b.reason}，这几条没去建`
        saveJob(store, {
          change_id: change.id,
          op,
          lines,
          status: 'failed',
          stop: 'other',
          summary: `${why}：到配置卡上手动贴 RSS 链接（卡上有教程）。`,
          created_at: now,
          updated_at: now,
        })
        await o.onFallback?.({ lines, why, actor })
        return { status: 'failed', error: { message: `${why}。`, retryable: false } }
      }
      const matter_id = o.runs.open({
        actor,
        title:
          op === 'create'
            ? `在你的 Google 账号里建 ${lines.length} 条提醒`
            : `把 ${lines.length} 条提醒的投递改成 RSS`,
      })
      const job: GoogleAlertsJob = {
        change_id: change.id,
        op,
        lines,
        status: 'running',
        matter_id,
        created_at: now,
        updated_at: now,
      }
      saveJob(store, job)
      o.emit?.('pr_alerts.job_started', { change_id: change.id, op, lines: lines.length })
      void o.runs
        .start({ actor, matter_id, brief: buildAlertsBrief(job) })
        .then(async () => {
          // 跑完了还没交代结果（模型忘了调工具）：照实记下，没建成的退回手动
          const cur = loadJobs(store).find((j) => j.change_id === change.id)
          if (cur === undefined || cur.status !== 'running') return
          const summary =
            '浏览器那一趟跑完了，但没交代结果：去 Google 提醒页看一眼，建好的把 RSS 链接贴回配置卡。'
          saveJob(store, {
            ...cur,
            status: 'failed',
            stop: 'other',
            summary,
            updated_at: o.clock.now(),
          })
          await o.onFallback?.({ lines: cur.lines, why: '没交代结果', actor })
        })
        .catch(() => undefined)
      return { status: 'ok', outcome_ref: { type: 'google_alerts_job', id: change.id } }
    },

    grantsFor(matter_id) {
      const store = o.store()
      if (store === undefined) return []
      settleStale(store)
      return loadJobs(store)
        .filter((j) => j.status === 'running' && j.matter_id === matter_id)
        .map((j) => ({ change_kind: 'google_alert_change' as const, change_id: j.change_id }))
    },

    async report(input, ctx) {
      const got = ensure(undefined)
      if ('reason' in got) return { ok: false, message: `${got.reason}，结果没记下。` }
      const { store, actor } = got
      const now = o.clock.now()
      // 读到的已有提醒：先记下（只读那一趟、建的那一趟顺手读到的都算）
      const existingNote = await recordExisting(
        store,
        actor,
        input.existing,
        now,
        input.change_id === undefined,
      )
      if (input.change_id === undefined) {
        return { ok: true, ...existingNote.data, message: existingNote.message }
      }
      const job = loadJobs(store).find((j) => j.change_id === input.change_id)
      const granted = (ctx.grants ?? []).some((g) => g.change_id === input.change_id)
      if (job === undefined || !granted)
        return {
          ok: false,
          message:
            '这个改动号不是这一趟同意过的那张卡，结果没记下。照实告诉用户：去 Google 提醒页看一眼。',
        }
      if (job.status !== 'running')
        return { ok: false, message: '这一趟已经交代过结果了，不再记第二遍。' }
      const res = ingestAlertsReport({
        workspace_id: o.workspace_id,
        job,
        report: input,
        sources: store.sources(),
        now,
        newId: () => o.newId('src'),
        every_hours: store.settings().default_every_hours,
      })
      // 存源、先拉一次：接了信息监控的管道（WP386 的 `addLinks`）就交给它——拉到了才算配好、
      // 拉回来的直接进提及库；拉不到的这一行算没成（退回手动）。没接就自己存、标 unchecked。
      const done = [...res.done]
      const failed = [...res.failed]
      for (const d of res.done) {
        const src = res.sources.find((x) => x.id === d.source_id)
        if (src === undefined) {
          // 同一条链接本来就在监控源里：只把配置卡那一行挂上
          const p =
            d.line.plan_item_id === undefined ? undefined : store.planItem(d.line.plan_item_id)
          if (p !== undefined && p.source_id === undefined)
            store.putPlanItem({ ...p, status: 'linked', source_id: d.source_id, updated_at: now })
          continue
        }
        if (o.attach === undefined) {
          store.putSource(src)
          const p =
            d.line.plan_item_id === undefined ? undefined : store.planItem(d.line.plan_item_id)
          if (p !== undefined)
            store.putPlanItem({ ...p, status: 'linked', source_id: src.id, updated_at: now })
          continue
        }
        const att = await o
          .attach({
            url: src.url,
            group: src.group,
            ...(d.line.plan_item_id === undefined ? {} : { plan_item_id: d.line.plan_item_id }),
          })
          .catch((e: unknown) => ({
            ok: false as const,
            message: e instanceof Error ? e.message : String(e),
          }))
        if (!att.ok) {
          done.splice(done.indexOf(d), 1)
          failed.push({ line: d.line, reason: `读回了链接，但先拉一次没拉到（${att.message}）` })
        }
      }
      const results = res.results.map((r) => {
        const f = failed.find((x) => x.line.id === r.id)
        return f === undefined || r.outcome === 'failed' || r.outcome === 'not_attempted'
          ? r
          : { id: r.id, outcome: 'failed' as const, reason: f.reason }
      })
      const status =
        failed.length === 0
          ? 'done'
          : done.length === 0 && res.email.length === 0
            ? 'failed'
            : 'partial'
      const summary = alertsSummary(
        job.op,
        { done, email: res.email, failed },
        job.lines.length,
        input.stop,
      )
      saveJob(store, {
        ...job,
        status,
        results,
        stop: input.stop,
        summary,
        updated_at: now,
      })
      o.emit?.('pr_alerts.job_reported', {
        change_id: job.change_id,
        status,
        done: done.length,
        failed: failed.length,
        email: res.email.length,
        stop: input.stop,
      })
      // 账号里本来就有、还在发邮件的：另出一张「改成 RSS」的卡（改投递 = 又改了账号，同样一次同意）
      if (res.email.length > 0)
        await stageCard(
          actor,
          'to_rss',
          res.email.map((l, i) => ({ ...l, id: `ga_${i + 1}`, op: 'to_rss' as const })),
        )
      if (failed.length > 0)
        await o.onFallback?.({
          lines: failed.map((f) => f.line),
          why: failed[0]?.reason ?? '没建成',
          actor,
        })
      return {
        ok: true,
        done: done.length,
        failed: failed.length,
        email: res.email.length,
        message: [summary, existingNote.message].filter((s) => s !== '').join(' '),
      }
    },

    existing() {
      const store = o.store()
      if (store === undefined) return { importable: [], email: [], already: 0 }
      const rec = store.kv<ExistingRecord>(EXISTING_KEY)
      return splitExisting(rec?.alerts ?? [], store.sources(), rec?.read_at)
    },

    async importFeeds(feed_urls) {
      const store = o.store()
      if (store === undefined) return { imported: 0, failed: 0 }
      const view = service.existing()
      const want = new Set(feed_urls.map((u) => u.trim()))
      const now = o.clock.now()
      let imported = 0
      let failed = 0
      for (const e of view.importable) {
        if (e.feed_url === undefined || !want.has(e.feed_url) || !isGoogleAlertsFeedUrl(e.feed_url))
          continue
        const plan = store
          .planItems()
          .find((p) => normalizeAlertQuery(p.query) === normalizeAlertQuery(e.query))
        const row: MonitorSource = {
          id: `ms_${o.newId('src')}`,
          workspace_id: o.workspace_id,
          kind: 'google_alerts',
          url: e.feed_url,
          group: plan?.group ?? 'own',
          label: plan?.label ?? labelOfQuery(e.query),
          query: e.query,
          ...(e.language === undefined ? {} : { language: e.language }),
          ...(e.region === undefined ? {} : { region: e.region }),
          ...(plan?.competitor === undefined ? {} : { competitor: plan.competitor }),
          every_hours: store.settings().default_every_hours,
          status: 'unchecked',
          added_via: 'browser',
          ...(plan === undefined ? {} : { plan_item_id: plan.id }),
          created_at: now,
        }
        if (o.attach !== undefined) {
          const att = await o
            .attach({
              url: row.url,
              group: row.group,
              ...(plan === undefined ? {} : { plan_item_id: plan.id }),
            })
            .catch(() => ({ ok: false as const, message: '' }))
          if (att.ok) imported += 1
          else failed += 1
          continue
        }
        store.putSource(row)
        if (plan !== undefined)
          store.putPlanItem({ ...plan, status: 'linked', source_id: row.id, updated_at: now })
        imported += 1
      }
      o.emit?.('pr_alerts.imported', { imported, failed })
      return { imported, failed }
    },

    jobs() {
      const store = o.store()
      if (store === undefined) return []
      settleStale(store)
      return loadJobs(store)
    },

    panel() {
      const mask = (u: string | undefined) => (u === undefined ? {} : { feed_url: maskFeedUrl(u) })
      const ex = service.existing()
      return {
        browser_ready: o.browser().ready,
        jobs: service.jobs().map((j) => ({
          ...j,
          ...(j.results === undefined
            ? {}
            : {
                results: j.results.map(({ feed_url, ...r }) => ({ ...r, ...mask(feed_url) })),
              }),
        })),
        existing: {
          ...ex,
          importable: ex.importable.map(({ feed_url, ...e }) => ({ ...e, ...mask(feed_url) })),
        },
      }
    },

    importTarget() {
      return {
        id: ALERTS_IMPORT_TARGET,
        name: '导入已有的 Google 提醒',
        why: '这些提醒已经投递到 RSS，勾上的直接导入成监控源。',
        fields: async () =>
          service.existing().importable.map((e, i) => ({
            key: `alert_${i}`,
            label: e.query,
            kind: 'toggle' as const,
            suggested: 'true',
            required: false,
            ...(e.feed_url === undefined ? {} : { placeholder: maskFeedUrl(e.feed_url) }),
          })),
        satisfied: async () => service.existing().importable.length === 0,
        apply: async (values) => {
          const list = service.existing().importable
          const picked = list
            .filter((_e, i) => values[`alert_${i}`] === 'true')
            .map((e) => e.feed_url)
            .filter((u): u is string => u !== undefined)
          await service.importFeeds(picked)
        },
      }
    },
  }

  /** 记下读到的已有提醒；只读那一趟顺手出「导入」勾选卡与「改成 RSS」卡。 */
  async function recordExisting(
    store: PrWatchStore,
    actor: PrAlertsActor,
    alerts: readonly ExistingGoogleAlert[] | undefined,
    now: Iso8601,
    readRun: boolean,
  ): Promise<{ message: string; data: Partial<GoogleAlertsToolData> }> {
    if (alerts === undefined || alerts.length === 0)
      return readRun
        ? { message: '你的账号里没读到提醒。', data: { importable: 0, email: 0 } }
        : { message: '', data: {} }
    const clean = alerts
      .filter((a) => typeof a.query === 'string' && a.query.trim() !== '')
      .map((a) => ({
        query: a.query.trim(),
        delivery: a.delivery === 'rss' || a.delivery === 'email' ? a.delivery : 'unknown',
        ...(typeof a.feed_url === 'string' && isGoogleAlertsFeedUrl(a.feed_url)
          ? { feed_url: a.feed_url.trim() }
          : {}),
        ...(a.language === undefined ? {} : { language: a.language }),
        ...(a.region === undefined ? {} : { region: a.region }),
      })) as ExistingGoogleAlert[]
    store.setKv(EXISTING_KEY, { read_at: now, alerts: clean } satisfies ExistingRecord)
    const view = splitExisting(clean, store.sources(), now)
    if (!readRun) return { message: '', data: {} }
    if (view.importable.length > 0)
      await o.askSetup?.({
        target: ALERTS_IMPORT_TARGET,
        why: `你的账号里有 ${view.importable.length} 条提醒已经投递到 RSS，勾上的直接导入。`,
        actor,
      })
    if (view.email.length > 0)
      await stageCard(actor, 'to_rss', toRssLines(view.email, store.planItems()))
    o.emit?.('pr_alerts.existing_read', {
      importable: view.importable.length,
      email: view.email.length,
      already: view.already,
    })
    const parts = [
      `读到 ${clean.length} 条提醒`,
      view.importable.length > 0
        ? `${view.importable.length} 条已经是 RSS，下面那张卡上勾了就导入`
        : '',
      view.email.length > 0 ? `${view.email.length} 条还在发邮件，另出了一张「改成 RSS」的卡` : '',
      view.already > 0 ? `${view.already} 条已经在监控源里` : '',
    ].filter((s) => s !== '')
    return {
      message: `${parts.join('；')}。`,
      data: { importable: view.importable.length, email: view.email.length },
    }
  }

  return service
}
