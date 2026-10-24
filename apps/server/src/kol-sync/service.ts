/**
 * WP509（决策 1730 B、1811）：**一句话把红人同步到用户自己的飞书表**——经 ego 写，不要飞书开发者应用。
 *
 * 一条链：
 * 1. 红人营销岗位里说「把红人同步到我这张飞书表 <链接>」→ AI 调 `sync_creators_to_sheet` →
 *    {@link KolSync.propose}：在 ego 里**只读**地打开那张表（WP493 只读通道：读页 + 截住复制），读表头、单选项、已有的行 →
 *    按规则认「哪一列放什么」（AI 只补规则认不出的）、按哪一列认行、我们的阶段词对哪个选项 → 出一张**「同步设置」卡**
 *    （中栏，决策 1765「决策在中」）：列对应、同步什么、多久一次、对不上的阶段让人选。
 * 2. 人点「开始同步」→ {@link KolSync.onDecided} 生效（卡上改过的一并收下）→ 马上同步第一批。
 * 3. 之后定时看红人库（每分钟一拍）：算出这张表该写什么（`planSync`），按「多久一次」攒成一批 → 一趟 ego 写
 *    （`script.ts`：先探再写、写完重读核对、碰了别的格子就全撤）→ 按结果记下每个人在表里的样子。
 * 4. 每一次都**本机留痕**（写了谁、哪几格、结果、原因）；失败照实一句、退避再试；
 *    列没了 / 撤不干净这两种停下等人（第三栏「连接」或红人库 ⋯ 里看 / 改 / 停）。
 *
 * 只经 ego：ego 用不了时照实说、不换别的路写（插件 / 内置浏览器都没登录用户的飞书）。
 */
import type {
  ExtensionSyncStatusView,
  KolActor,
  KolSyncListView,
  KolSyncLogView,
  KolSyncView,
} from '@agentsws/api'
import type {
  ApprovalBus,
  ApprovalItem,
  Clock,
  Collaboration,
  EventEnvelope,
  WorkspaceId,
} from '@agentsws/contracts'
import { kolChannelSpec } from '@agentsws/contracts'
import {
  collaborationStageName,
  DEFAULT_SYNC_WHAT,
  FUNNEL_ORDER,
  isSyncField,
  mapStagesToOptions,
  pickKeyColumn,
  planSync,
  proposeSyncColumns,
  type StageOptionMap,
  SYNC_FIELDS,
  type SyncColumn,
  type SyncCreatorRow,
  type SyncPlan,
  type SyncWhat,
  syncFieldName,
} from '@agentsws/kol-core'
import type { EgoReadCall, EgoReadResult } from '../ego-read/runner.js'
import { sheetPageBlock } from '../ego-read/sheet.js'
import type { KolStore } from '../kol.js'
import { CONTACT_SECRET_FIELD } from '../kol-service.js'
import type { SecretStore } from '../secret-store.js'
import type { EgoSheetCall, EgoSheetResult } from './runner.js'
import type {
  KolSyncCadence,
  KolSyncDraft,
  KolSyncLog,
  KolSyncRowState,
  KolSyncSink,
  KolSyncStore,
} from './store.js'
import { isFeishuTableUrl, type SyncTable, syncKindOfUrl, syncTableOf } from './table.js'

/** 「同步设置」卡的记号与提议人。 */
export const KOL_SYNC_FORM = 'kol_sync'
export const KOL_SYNC_PROPOSER = 'kol-sync'
/** 在工坊里配同步的深链（`apps/workstation` 的 `/influencer/sync`：打开红人营销岗位、输入框预填那一句）。 */
export const KOL_SYNC_SETUP_PATH = '/influencer/sync'
/** 「实时」也攒一攒：第一处变化之后等这么久再写（同一张表合成一批）。 */
export const KOL_SYNC_DEBOUNCE_MS = 3 * 60_000
/** 失败退避：10 分、30 分、2 小时，之后每 6 小时。 */
export const KOL_SYNC_BACKOFF_MS = [600_000, 1_800_000, 7_200_000, 21_600_000]
/** 这几种停下等人（不自动再试）。 */
const STOP_CODES = new Set(['columns_changed', 'rollback_unsure', 'no_access'])

export interface KolSyncEgo {
  /** ego 这会儿能不能用（本机档 + 浏览器选了 / 默认 ego + 探得到）。 */
  available(): boolean
  /** 只读那一趟（读表头）——WP493 只读通道。 */
  read(call: EgoReadCall): Promise<EgoReadResult | { state: 'off'; why: string; steps: [] }>
  /** 写那一趟。 */
  write(call: EgoSheetCall): Promise<EgoSheetResult>
}

export interface KolSyncOptions {
  workspace_id: WorkspaceId
  store: KolSyncStore
  kol: KolStore
  secrets?: SecretStore
  clock: Clock
  approvals?: ApprovalBus
  random(): number
  ego: KolSyncEgo
  appendEvent?(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 本地时区（分钟；东八区 480）。日期 / 同步时间按它写。 */
  tzOffsetMinutes?(): number
}

export interface KolSyncProposeInput {
  url: string
  instruction?: string
  what?: Partial<SyncWhat>
  cadence?: KolSyncCadence
  hints?: { column: string; field: unknown }[]
}

export interface KolSync {
  propose(
    actor: KolActor,
    input: KolSyncProposeInput,
  ): Promise<{ ok: boolean; message: string; card_id?: string; sync_id?: string }>
  /** 「同步设置」卡被决定了（不是这种卡回 `false`）。 */
  onDecided(item: ApprovalItem): Promise<boolean>
  list(): KolSyncListView
  control(
    id: string,
    action: 'pause' | 'resume' | 'run' | 'remove',
  ): Promise<KolSyncView | { removed: true } | undefined>
  log(id: string): KolSyncLogView | undefined
  /** 插件「数据同步」那一格。 */
  status(): ExtensionSyncStatusView
  /** 一句话说现在同步得怎么样（AI 回话用）。 */
  describe(): string
  /** 定时那一拍：到点的同步各跑一趟。回跑了几趟。 */
  tick(): Promise<number>
  start(intervalMs?: number): void
  close(): void
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** ISO → 本地「YYYY-MM-DD」/「YYYY-MM-DD HH:mm」。 */
export function localTime(iso: string | undefined, tzMinutes: number, withTime = false): string {
  const ms = iso === undefined ? Number.NaN : Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms + tzMinutes * 60_000)
  const day = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  return withTime ? `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : day
}

const ACTIVE_FIRST = (c: Collaboration): number =>
  c.stage === 'closed' || c.stage === 'declined' ? 1 : 0
const recentOf = (c: Collaboration): string => c.stage_changed_at ?? c.last_activity_at ?? ''

/** 红人库 → 每个人在表里该是什么样（演练数据不算；还没人点头的合作不算）。 */
export function collectSyncRows(
  kol: KolStore,
  input: {
    tz: number
    email(value_ref: string): string | undefined
    baseline: ReadonlySet<string>
  },
): (SyncCreatorRow & { name: string })[] {
  const accounts = kol.accounts()
  const collabs = kol
    .collaborations()
    .filter((c) => c.sandbox !== true && c.awaiting_approval !== true)
  const tags = new Map(kol.creatorTags().map((t) => [t.creator_id, t.tags]))
  const contacts = kol.contacts().filter((c) => c.kind === 'email')
  return kol
    .creators()
    .filter((c) => c.sandbox !== true)
    .map((c) => {
      const mine = collabs
        .filter((x) => x.creator_id === c.id)
        .sort((a, b) => ACTIVE_FIRST(a) - ACTIVE_FIRST(b) || (recentOf(b) < recentOf(a) ? -1 : 1))
      const cur = mine[0]
      const accts = accounts
        .filter((a) => a.creator_id === c.id)
        .sort((a, b) => (b.followers ?? 0) - (a.followers ?? 0))
      const acct = accts.find((a) => a.channel === cur?.channel) ?? accts[0]
      const ref = contacts.find((x) => x.creator_id === c.id)?.value_ref
      const email = ref === undefined ? undefined : input.email(ref)
      const deliverable =
        cur === undefined
          ? undefined
          : kol
              .deliverables({ collaboration_id: cur.id })
              .filter((d) => (d.url ?? '') !== '')
              .at(-1)
      const values: SyncCreatorRow['values'] = {
        name: c.display_name,
        ...(acct === undefined
          ? {}
          : {
              channel: kolChannelSpec(acct.channel)?.zh ?? acct.channel,
              handle: acct.handle.startsWith('@') ? acct.handle : `@${acct.handle}`,
              url: acct.url,
              ...(acct.followers === undefined ? {} : { followers: String(acct.followers) }),
              ...(acct.engagement_rate === undefined
                ? {}
                : { engagement: `${(acct.engagement_rate * 100).toFixed(1)}%` }),
              ...(acct.category === undefined ? {} : { category: acct.category }),
              ...(acct.region === undefined ? {} : { region: acct.region }),
              ...(acct.language === undefined ? {} : { language: acct.language }),
            }),
        ...(email === undefined ? {} : { email }),
        ...((tags.get(c.id) ?? []).length === 0 ? {} : { tags: (tags.get(c.id) ?? []).join('、') }),
      }
      if (cur !== undefined) {
        const stageDate = localTime(cur.stage_changed_at ?? cur.last_activity_at, input.tz)
        if (stageDate !== '') values.stage_date = stageDate
        const last = localTime(cur.last_activity_at, input.tz)
        if (last !== '') values.last_activity = last
        if (cur.budget !== undefined) values.amount = String(cur.budget)
        values.currency = cur.currency
        if (cur.sample?.tracking_no !== undefined)
          values.sample_tracking = [cur.sample.carrier, cur.sample.tracking_no]
            .filter(Boolean)
            .join(' ')
        if (deliverable?.url !== undefined) values.content_url = deliverable.url
        values.progress = [
          collaborationStageName(cur.stage),
          cur.sample?.tracking_no === undefined ? undefined : `单号 ${cur.sample.tracking_no}`,
          deliverable?.url === undefined ? undefined : '已交稿',
        ]
          .filter(Boolean)
          .join(' · ')
      }
      return {
        creator_id: c.id,
        name: c.display_name,
        values,
        ...(cur === undefined ? {} : { stage: cur.stage }),
        in_pipeline: cur !== undefined,
        new_since_on: !input.baseline.has(c.id),
      }
    })
}

/** 一趟 ego 的结果 → 给人看的那一句。 */
export function syncWhy(state: string, why?: string): string {
  switch (state) {
    case 'login':
      return 'ego 里还没登录飞书——在 ego 里登录一下，工坊下一轮自动接着同步。'
    case 'no_access':
      return 'ego 里登录的飞书账号打不开这张表——换一个有编辑权限的账号登录，或请表格主人给你编辑权限。'
    case 'unreadable':
      return '这张表在 ego 里读不出来（可能还没加载完，或者不是表格页）。'
    case 'columns_changed':
      return `表里少了这几列：${(why ?? '').replace(/^missing: /u, '')}——列改过名或删了。说一句「重新设一下飞书同步」就好。`
    case 'cannot_locate':
      return '在表格里没认准位置，这一轮一格都没写，过一会儿再试。'
    case 'rolled_back':
      return '写完核对时发现别的格子也变了，已经把这一轮全部撤回（表格恢复原样），过一会儿再试。'
    case 'rollback_unsure':
      return '写完核对时发现别的格子也变了，撤回之后没能确认表格恢复原样——请打开表格看一眼最后几行；同步先停着。'
    case 'needs_human':
      return 'ego 里弹了要你处理的框，这一轮没写；点掉之后工坊接着同步。'
    case 'unavailable':
    case 'off':
      return `ego 这会儿用不了${why === undefined || why === '' ? '' : `（${why}）`}，同步先等着。`
    default:
      return `ego 这一轮没跑完${why === undefined || why === '' ? '' : `（${why}）`}，过一会儿再试。`
  }
}

/** 读回来的页面标题 → 表名（去掉「- 飞书云文档」这类尾巴）。 */
export function tableNameOf(title: string | undefined): string | undefined {
  const t = (title ?? '')
    .replace(
      /\s*[-|–—]\s*(飞书云文档|飞书文档|飞书多维表格|多维表格|飞书|Lark|Feishu|Docs).*$/iu,
      '',
    )
    .trim()
  return t === '' ? undefined : t.slice(0, 40)
}

/** 读表那一趟（WP493 只读通道：读页认登录 / 没权限，再截住复制）。 */
export async function inspectSyncTable(
  ego: KolSyncEgo,
  url: string,
): Promise<
  { ok: true; table: SyncTable; name?: string } | { ok: false; code: string; message: string }
> {
  if (!ego.available()) return { ok: false, code: 'off', message: syncWhy('off') }
  const res = await ego.read({
    url,
    settle_ms: 6000,
    steps: [
      { op: 'read', id: 'page' },
      { op: 'copy', id: 'copy' },
      // 表只有一两行时缺省那一点（220 / 90）落在表外：换一个靠上的点再截一次
      { op: 'copy', id: 'copy2', at: { x: 220, y: 60 }, unless: ['copy'] },
    ],
  })
  if (res.state !== 'ok')
    return { ok: false, code: res.state, message: syncWhy(res.state, res.why) }
  const page = res.steps.find((s) => s.id === 'page')?.page
  const block = page === undefined ? undefined : sheetPageBlock(page)
  if (block !== undefined) return { ok: false, code: block, message: syncWhy(block) }
  const copied =
    res.steps.find((s) => s.id === 'copy' && s.ok)?.copied ??
    res.steps.find((s) => s.id === 'copy2')?.copied ??
    []
  const table = syncTableOf(copied, syncKindOfUrl(url))
  if (table === undefined) return { ok: false, code: 'unreadable', message: syncWhy('unreadable') }
  const name = tableNameOf(page?.title)
  return { ok: true, table, ...(name === undefined ? {} : { name }) }
}

const rec = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

const CADENCE_ZH: Readonly<Record<KolSyncCadence, string>> = {
  realtime: '有变化几分钟内',
  hourly: '每小时',
  daily: '每天',
}

/** 卡上那一份（`payload`）。人在卡上改过的随 `edited_payload` 回来，形状一样。 */
export interface KolSyncCardPayload {
  form: typeof KOL_SYNC_FORM
  sync_id: string
  name: string
  url: string
  kind: 'bitable' | 'sheet'
  columns: (SyncColumn & { samples?: string[] })[]
  fields: { id: string; zh: string }[]
  key_column?: string
  what: SyncWhat
  cadence: KolSyncCadence
  stage_column?: string
  stage_options?: string[]
  stage_map: { stage: string; zh: string; option: string | null }[]
  allow_new_options: boolean
  counts: { table_rows: number; in_scope: number; matched: number; to_append: number }
  preview: [string, string][]
  actor: KolActor
}

export function createKolSync(options: KolSyncOptions): KolSync {
  const { store, kol, clock, workspace_id } = options
  const tz = (): number => options.tzOffsetMinutes?.() ?? 0
  const nowIso = (): string => clock.now()
  const nowMs = (): number => Date.parse(clock.now())
  let seq = 0
  const newId = (prefix: string): string => {
    seq += 1
    const rand = Math.floor(options.random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0')
    return `${prefix}_${rand}${seq.toString(36)}`
  }
  const emit = (type: string, payload: Record<string, unknown>): void => {
    try {
      options.appendEvent?.({
        schema_version: 1,
        workspace_id,
        type: type as EventEnvelope['type'],
        actor: { kind: 'system', id: KOL_SYNC_PROPOSER },
        correlation: { trace_id: `tr_kol_sync_${Date.parse(clock.now()).toString(36)}` },
        payload,
      })
    } catch {
      // 记事件失败不挡同步
    }
  }
  const email = (value_ref: string): string | undefined => {
    try {
      return options.secrets?.available === false
        ? undefined
        : options.secrets?.get(value_ref)?.[CONTACT_SECRET_FIELD]
    } catch {
      return undefined
    }
  }
  const rowsFor = (sink: KolSyncSink) => {
    const state = store.rows(sink.id)
    // 还没批的：批的那一刻库里已有的人都算「老人」，这会儿就照那样数
    const baseline =
      sink.state === 'pending_confirm'
        ? new Set(kol.creators().map((c) => c.id))
        : new Set([...state.entries()].filter(([, v]) => v.baseline === true).map(([k]) => k))
    return { state, rows: collectSyncRows(kol, { tz: tz(), email, baseline }) }
  }
  const planFor = (sink: KolSyncSink): SyncPlan & { names: Map<string, string> } => {
    const { state, rows } = rowsFor(sink)
    const plan = planSync({
      columns: sink.columns,
      key_column: sink.key_column,
      what: sink.what,
      stage_map: sink.stage_map,
      allow_new_options: sink.allow_new_options,
      rows,
      state,
      snapshot: sink.snapshot,
      now_text: localTime(nowIso(), tz(), true),
    })
    return { ...plan, names: new Map(rows.map((r) => [r.creator_id, r.name])) }
  }

  const view = (s: KolSyncSink): KolSyncView => ({
    id: s.id,
    name: s.name,
    url: s.url,
    kind: s.kind,
    state: s.state,
    cadence: s.cadence,
    what: s.what,
    columns: s.columns.map((c) => ({
      column: c.name,
      field: c.field,
      ...(c.field === null ? {} : { field_name: syncFieldName(c.field) }),
    })),
    ...(s.key_column === undefined ? {} : { key_column: s.key_column }),
    ...(s.last_run_at === undefined ? {} : { last_run_at: s.last_run_at }),
    ...(s.last_ok_at === undefined ? {} : { last_ok_at: s.last_ok_at }),
    ...(s.last_error === undefined ? {} : { problem: s.last_error.message }),
    pending: s.pending_since !== undefined,
    totals: s.totals,
    ...(s.card_id === undefined ? {} : { card_id: s.card_id }),
  })
  const live = (): KolSyncSink[] => store.sinks().filter((s) => s.workspace_id === workspace_id)

  /* 下面三段：出卡与生效（propose / onDecided）、写一趟（runOnce）、看 / 停 / 开 / 删（api）。 */
  const card = createCardSide({ options, store, kol, newId, nowIso, emit, rowsFor, planFor, tz })
  const runner = createRunSide({ options, store, nowIso, nowMs, emit, planFor })
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking: Promise<number> | undefined

  const tick = async (): Promise<number> => {
    if (ticking !== undefined) return ticking
    ticking = (async () => {
      let n = 0
      for (const s of live()) if (await runner.maybeRun(s)) n += 1
      return n
    })().finally(() => {
      ticking = undefined
    })
    return ticking
  }

  return {
    propose: card.propose,
    async onDecided(item) {
      const got = await card.onDecided(item)
      if (got.first !== undefined) void runner.run(got.first, 'first').catch(() => undefined)
      return got.mine
    },
    list: () => ({
      syncs: live()
        .filter((s) => s.state !== 'pending_confirm' || s.card_id !== undefined)
        .map(view),
      ego: options.ego.available(),
      setup_path: KOL_SYNC_SETUP_PATH,
    }),
    async control(id, action) {
      const s = store.sink(id)
      if (s === undefined || s.workspace_id !== workspace_id) return undefined
      if (action === 'remove') {
        store.removeSink(id)
        emit('kol.sync_removed', { sync_id: id })
        return { removed: true as const }
      }
      if (action === 'pause') {
        if (s.state === 'pending_confirm') return view(s)
        const next = { ...s, state: 'paused' as const, updated_at: nowIso() }
        store.putSink(next)
        return view(next)
      }
      if (action === 'resume') {
        if (s.state === 'pending_confirm') return view(s)
        const { retry_at: _r, last_error: _e, ...rest } = s
        const next = { ...rest, state: 'active' as const, failures: 0, updated_at: nowIso() }
        store.putSink(next)
        void tick().catch(() => undefined)
        return view(next)
      }
      if (s.state === 'pending_confirm') return view(s)
      await runner.run(s, 'manual')
      return view(store.sink(id) ?? s)
    },
    log(id) {
      const s = store.sink(id)
      if (s === undefined || s.workspace_id !== workspace_id) return undefined
      return { rows: store.logs(id, 20) }
    },
    status() {
      const syncs = live().filter((s) => s.state !== 'pending_confirm')
      const first = syncs[0]
      return {
        feishu: syncs.some((s) => s.state === 'active' || s.state === 'broken'),
        google_sheets: false,
        configured: syncs.length > 0,
        ...(first === undefined
          ? {}
          : {
              name: first.name,
              state: first.state,
              ...(first.last_ok_at === undefined ? {} : { last_sync_at: first.last_ok_at }),
              ...(first.last_error === undefined ? {} : { problem: first.last_error.message }),
            }),
        setup_path: KOL_SYNC_SETUP_PATH,
        syncs: syncs.map((s) => ({
          id: s.id,
          name: s.name,
          kind: s.kind,
          state: s.state,
          ...(s.last_ok_at === undefined ? {} : { last_sync_at: s.last_ok_at }),
          ...(s.last_error === undefined ? {} : { problem: s.last_error.message }),
        })),
      }
    },
    describe() {
      const syncs = live().filter((s) => s.state !== 'pending_confirm')
      if (syncs.length === 0)
        return '还没有设同步。说一句「把红人同步到我这张飞书表 <链接>」就能设。'
      return syncs
        .map((s) => {
          const st =
            s.state === 'paused'
              ? '停着'
              : s.state === 'broken'
                ? `写不进去：${s.last_error?.message ?? ''}`
                : `在同步（${CADENCE_ZH[s.cadence]}）`
          const last =
            s.last_ok_at === undefined
              ? '还没同步过'
              : `上次 ${localTime(s.last_ok_at, tz(), true)}`
          return `「${s.name}」${st}，${last}；一共加了 ${s.totals.appended} 行、改了 ${s.totals.updated} 处。`
        })
        .join('\n')
    },
    tick,
    start(intervalMs = 60_000) {
      if (timer !== undefined) return
      timer = setInterval(() => {
        void tick().catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

interface SideDeps {
  options: KolSyncOptions
  store: KolSyncStore
  nowIso(): string
  emit(type: string, payload: Record<string, unknown>): void
  planFor(sink: KolSyncSink): SyncPlan & { names: Map<string, string> }
}

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])
const CLOSED = new Set(['rejected', 'withdrawn', 'expired'])

/** 出卡与生效。 */
function createCardSide(
  deps: SideDeps & {
    kol: KolStore
    newId(prefix: string): string
    tz(): number
    rowsFor(sink: KolSyncSink): { rows: SyncCreatorRow[] }
  },
): {
  propose: KolSync['propose']
  onDecided(item: ApprovalItem): Promise<{ mine: boolean; first?: KolSyncSink }>
} {
  const { options, store, nowIso, emit, planFor, kol } = deps
  const { workspace_id } = options

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

  const propose: KolSync['propose'] = async (actor, input) => {
    const url = input.url.trim()
    if (!isFeishuTableUrl(url))
      return {
        ok: false,
        message: /docs\.google\.com\/spreadsheets/u.test(url)
          ? 'Google 表格这一版还同步不了，只能同步到飞书的多维表格或电子表格。'
          : '这一版只能同步到飞书的多维表格或电子表格——请贴表格本身的链接（打开表格后地址栏里那一条）。',
      }
    if (options.approvals === undefined)
      return { ok: false, message: '这个服务进程没接卡片流，出不了「同步设置」卡。' }
    const got = await inspectSyncTable(options.ego, url)
    if (!got.ok) return { ok: false, message: got.message }
    const { table } = got
    const name = got.name ?? '红人表'
    const columns = proposeSyncColumns(table.columns, table.rows.slice(0, 5), input.hints ?? [])
    if (!columns.some((c) => c.field !== null))
      return {
        ok: false,
        message: `「${name}」的列（${table.header.slice(0, 8).join('、')}）我一个都对不上。告诉我哪一列放什么（比如「A 列放名字、B 列放状态」），我再出一张同步设置卡。`,
      }
    const key = pickKeyColumn(columns)
    const stageCol = columns.find((c) => c.field === 'stage')
    const choosy = stageCol?.type === 'select' || stageCol?.type === 'multi_select'
    const stage_map: StageOptionMap = choosy ? mapStagesToOptions(stageCol?.options ?? []) : {}
    const what: SyncWhat = {
      new_creators: input.what?.new_creators ?? DEFAULT_SYNC_WHAT.new_creators,
      stages: input.what?.stages ?? DEFAULT_SYNC_WHAT.stages,
      collab_records: input.what?.collab_records ?? DEFAULT_SYNC_WHAT.collab_records,
    }
    const cadence: KolSyncCadence = input.cadence ?? 'realtime'
    const existing = store.sinks().find((s) => s.workspace_id === workspace_id && s.url === url)
    const draft = {
      name,
      kind: table.kind,
      columns,
      ...(key === undefined ? {} : { key_column: key.name }),
      what,
      cadence,
      stage_map,
      allow_new_options: false,
      snapshot: { header: table.header, rows: table.rows.slice(0, 3000) },
    }
    const now = nowIso()
    const created_by = {
      person_id: actor.person_id,
      assignment_id: actor.assignment_id,
      role_id: actor.role_id,
    }
    const revising = existing !== undefined && existing.state !== 'pending_confirm'
    const sink: KolSyncSink = revising
      ? { ...existing, draft, updated_at: now }
      : {
          id: existing?.id ?? deps.newId('ksync'),
          workspace_id,
          url,
          via: 'ego',
          instruction: (input.instruction ?? '').slice(0, 2000),
          ...draft,
          state: 'pending_confirm',
          created_at: existing?.created_at ?? now,
          updated_at: now,
          created_by,
          totals: { appended: 0, updated: 0, fallback: 0 },
        }
    // 卡上数一数：在走合作的几个人里几个已在表里、几个会加进去
    const probe: KolSyncSink = { ...sink, ...draft }
    const plan = planFor(probe)
    const { rows } = deps.rowsFor(probe)
    const inScope = rows.filter((r) => r.in_pipeline).length
    const appends = plan.ops.filter((o) => o.op === 'append')
    const sample = appends[0] ?? plan.ops[0]
    const preview: [string, string][] =
      sample === undefined
        ? []
        : columns
            .filter((c) => c.field !== null && sample.cells[c.name] !== undefined)
            .map((c) => [c.name, sample.cells[c.name] as string])
    const counts = {
      table_rows: table.rows.filter((r) => r.some((v) => v.trim() !== '')).length,
      in_scope: inScope,
      matched: plan.matched.length,
      to_append: appends.length + (plan.deferred > 0 ? plan.deferred : 0),
    }
    store.putSink(sink)
    const payload: KolSyncCardPayload = {
      form: KOL_SYNC_FORM,
      sync_id: sink.id,
      name,
      url,
      kind: table.kind,
      columns: columns.map((c, i) => ({
        ...c,
        samples: table.rows
          .map((r) => r[i] ?? '')
          .filter((v) => v.trim() !== '')
          .slice(0, 3),
      })),
      fields: SYNC_FIELDS.map((f) => ({ id: f.id, zh: f.zh })),
      ...(key === undefined ? {} : { key_column: key.name }),
      what,
      cadence,
      ...(stageCol === undefined ? {} : { stage_column: stageCol.name }),
      ...(stageCol?.options === undefined ? {} : { stage_options: stageCol.options }),
      stage_map: choosy
        ? FUNNEL_ORDER.map((s) => ({
            stage: s,
            zh: collaborationStageName(s),
            option: stage_map[s] ?? null,
          }))
        : [],
      allow_new_options: false,
      counts,
      preview,
      actor,
    }
    const summary = [
      `表里 ${counts.table_rows} 行`,
      key === undefined ? '没有能认人的列，只往下追加' : `按「${key.name}」认人`,
      counts.matched > 0 ? `${counts.matched} 人已在表里` : undefined,
      counts.to_append > 0 ? `${counts.to_append} 人会加进去` : undefined,
      CADENCE_ZH[cadence],
    ]
      .filter(Boolean)
      .join(' · ')
    const item = await options.approvals.create({
      workspace_id,
      schema_version: 1,
      kind: 'policy_change',
      role_id: actor.role_id,
      subject: { object: { type: 'creator', id: `kol_sync_${sink.id}` } },
      dedupe_key: `${workspace_id}:kol_sync:${sink.id}:${now}`,
      title: revising ? `改同步设置：${name}` : `把红人同步到「${name}」`,
      summary,
      payload,
      evidence: {
        source_events: [],
        provenance: { seen: [] },
        diff: { before: {}, after: counts, summary },
        precheck: {},
      },
      proposer: { kind: 'system', id: KOL_SYNC_PROPOSER, assignment_id: actor.assignment_id },
      automation: { level_at_creation: 'L1' },
      routing: routing(actor),
      priority: 'queue',
      // 不挂选项列表：挂了，工作台「批」那一跳会拿卡上原样那一份顶掉人改过的（选择题卡的规矩）；
      // 「开始同步」= 批（带着卡上改过的那一份）；不想要就「稍后」、放着过期（没批的同步一格不写）
    })
    const saved = store.sink(sink.id) ?? sink
    store.putSink(
      revising
        ? { ...saved, draft: { ...draft, card_id: item.id } }
        : { ...saved, card_id: item.id },
    )
    emit('kol.sync_proposed', { sync_id: sink.id, revision: revising, columns: columns.length })
    const unmapped = payload.stage_map.filter((m) => m.option === null).map((m) => m.zh)
    return {
      ok: true,
      sync_id: sink.id,
      card_id: item.id,
      message: [
        `读到「${name}」（${table.header.length} 列、${counts.table_rows} 行）。`,
        key === undefined
          ? '表里没有能认人的列（主页链接 / 账号 / 邮箱），只能往下追加。'
          : `按「${key.name}」认人。`,
        unmapped.length > 0 && stageCol !== undefined
          ? `「${stageCol.name}」里没有对应「${unmapped.slice(0, 4).join('、')}」的选项，卡上可以选一个。`
          : undefined,
        '出了一张「同步设置」卡，确认了就开始同步。',
      ]
        .filter(Boolean)
        .join(''),
    }
  }

  /** 卡上改过的那几格（只收认得的；改不了的照原样）。 */
  const applyEdits = (base: KolSyncDraft, edited: Record<string, unknown>): KolSyncDraft => {
    const out: KolSyncDraft = { ...base }
    if (Array.isArray(edited.columns)) {
      const want = new Map<string, unknown>()
      for (const raw of edited.columns) {
        const r = rec(raw)
        const name =
          typeof r.name === 'string' ? r.name : typeof r.column === 'string' ? r.column : undefined
        if (name !== undefined) want.set(name, r.field)
      }
      const used = new Set<string>()
      out.columns = base.columns.map((c) => {
        if (!want.has(c.name) || c.type === 'readonly') {
          if (c.field !== null) used.add(c.field)
          return c
        }
        const f = want.get(c.name)
        if (f === null || f === '' || f === undefined)
          return { ...c, field: null, by: 'person' as const }
        if (!isSyncField(f) || used.has(f)) return c
        used.add(f)
        return { ...c, field: f, by: 'person' as const }
      })
    }
    if (typeof edited.key_column === 'string') {
      const k = out.columns.find((c) => c.name === edited.key_column && c.field !== null)
      if (k !== undefined) out.key_column = k.name
    } else if (edited.key_column === null) delete out.key_column
    if (
      out.key_column !== undefined &&
      !out.columns.some((c) => c.name === out.key_column && c.field !== null)
    ) {
      const k = pickKeyColumn(out.columns)
      if (k === undefined) delete out.key_column
      else out.key_column = k.name
    }
    const w = rec(edited.what)
    out.what = {
      new_creators: typeof w.new_creators === 'boolean' ? w.new_creators : base.what.new_creators,
      stages: typeof w.stages === 'boolean' ? w.stages : base.what.stages,
      collab_records:
        typeof w.collab_records === 'boolean' ? w.collab_records : base.what.collab_records,
    }
    if (edited.cadence === 'realtime' || edited.cadence === 'hourly' || edited.cadence === 'daily')
      out.cadence = edited.cadence
    if (typeof edited.allow_new_options === 'boolean')
      out.allow_new_options = edited.allow_new_options
    if (Array.isArray(edited.stage_map)) {
      const options = base.columns.find((c) => c.field === 'stage')?.options ?? []
      const map: StageOptionMap = { ...base.stage_map }
      for (const raw of edited.stage_map) {
        const r = rec(raw)
        if (!FUNNEL_ORDER.includes(r.stage as never)) continue
        const stage = r.stage as keyof StageOptionMap
        if (r.option === null || r.option === '') map[stage] = null
        else if (
          typeof r.option === 'string' &&
          (options.includes(r.option) || out.allow_new_options)
        )
          map[stage] = r.option.slice(0, 100)
      }
      out.stage_map = map
    }
    return out
  }

  const onDecided = async (item: ApprovalItem): Promise<{ mine: boolean; first?: KolSyncSink }> => {
    if (
      item.workspace_id !== workspace_id ||
      item.kind !== 'policy_change' ||
      item.proposer.id !== KOL_SYNC_PROPOSER
    )
      return { mine: false }
    const p = rec(item.payload)
    const sink = typeof p.sync_id === 'string' ? store.sink(p.sync_id) : undefined
    if (sink === undefined || sink.workspace_id !== workspace_id) return { mine: true }
    const forDraft = sink.draft?.card_id === item.id
    if (!forDraft && sink.card_id !== item.id) return { mine: true }
    const edited = rec(item.decision?.edited_payload)
    const picked =
      item.decision?.selected_option_id ??
      (typeof edited.selected_option_id === 'string' ? edited.selected_option_id : undefined)
    const no = CLOSED.has(item.state) || (APPROVED.has(item.state) && picked === 'cancel')
    if (no) {
      if (forDraft) {
        const { draft: _d, ...rest } = sink
        store.putSink(rest)
      } else if (sink.state === 'pending_confirm') {
        store.removeSink(sink.id)
        emit('kol.sync_removed', { sync_id: sink.id })
      }
      return { mine: true }
    }
    if (!APPROVED.has(item.state)) return { mine: true }
    const base: KolSyncDraft = forDraft
      ? (sink.draft as KolSyncDraft)
      : {
          name: sink.name,
          kind: sink.kind,
          columns: sink.columns,
          ...(sink.key_column === undefined ? {} : { key_column: sink.key_column }),
          what: sink.what,
          cadence: sink.cadence,
          stage_map: sink.stage_map,
          allow_new_options: sink.allow_new_options,
          ...(sink.snapshot === undefined ? {} : { snapshot: sink.snapshot }),
        }
    const next = applyEdits(base, edited)
    const { draft: _d, card_id: _c, retry_at: _r, last_error: _e, key_column: _k, ...rest } = sink
    const { card_id: _dc, snapshot, ...settings } = next
    const now = nowIso()
    const active: KolSyncSink = {
      ...rest,
      ...settings,
      ...(snapshot === undefined ? {} : { snapshot }),
      state: sink.state === 'paused' ? 'paused' : 'active',
      confirmed_at: now,
      updated_at: now,
      failures: 0,
    }
    store.putSink(active)
    // 开同步那一刻库里已有的人记成「老人」（之后进库的才算「新进的人」）
    const state = store.rows(sink.id)
    for (const c of kol.creators())
      if (c.sandbox !== true && !state.has(c.id))
        store.putRow(sink.id, c.id, { cells: {}, baseline: true })
    emit('kol.sync_confirmed', { sync_id: sink.id, revision: forDraft })
    return { mine: true, ...(active.state === 'active' ? { first: active } : {}) }
  }

  return { propose, onDecided }
}

/** 写一趟（与什么时候该写）。 */
function createRunSide(deps: SideDeps & { nowMs(): number }): {
  maybeRun(sink: KolSyncSink): Promise<boolean>
  run(sink: KolSyncSink, trigger: KolSyncLog['trigger']): Promise<void>
} {
  const { options, store, nowIso, nowMs, emit, planFor } = deps
  const running = new Set<string>()
  let logSeq = 0

  const addLog = (sink: KolSyncSink, entry: Omit<KolSyncLog, 'id' | 'sink_id' | 'at'>): void => {
    logSeq += 1
    store.addLog({
      id: `kslog_${Date.parse(nowIso()).toString(36)}_${logSeq.toString(36)}`,
      sink_id: sink.id,
      at: nowIso(),
      ...entry,
      items: entry.items.slice(0, 60),
    })
  }

  /** 第一次对上表里已有的人：记下认行的原字与那一行（当基线）。 */
  const keepMatched = (sink: KolSyncSink, plan: SyncPlan): void => {
    const state = store.rows(sink.id)
    for (const m of plan.matched) {
      const st = state.get(m.creator_id)
      store.putRow(sink.id, m.creator_id, {
        ...(st?.baseline === true ? { baseline: true } : {}),
        key_text: m.key_text,
        cells: m.cells,
      })
    }
  }

  const PARTIAL_ZH: Readonly<Record<string, string>> = {
    no_new_row:
      '这张多维表格表尾没有空行、也没找到「添加记录」，新红人没写进去——在表尾手动加几行空行，下一轮自动补上。',
    too_big: '表太大，方向键走不到那一行，这几件改成了追加进展行。',
    verify_failed: '有几处写完核对对不上，下一轮再试。',
    partial: '有几处只写进去一半，下一轮再试。',
  }

  const run = async (sink: KolSyncSink, trigger: KolSyncLog['trigger']): Promise<void> => {
    if (running.has(sink.id)) return
    running.add(sink.id)
    try {
      const fresh = store.sink(sink.id) ?? sink
      const now = nowIso()
      if (!options.ego.available()) {
        const message = syncWhy('off')
        store.putSink({ ...fresh, last_run_at: now, last_error: { code: 'off', message, at: now } })
        if (trigger !== 'auto')
          addLog(fresh, {
            trigger,
            state: 'off',
            message,
            appended: 0,
            updated: 0,
            fallback: 0,
            failed: 0,
            items: [],
          })
        return
      }
      const plan = planFor(fresh)
      keepMatched(fresh, plan)
      if (plan.ops.length === 0) {
        const { pending_since: _p, last_error: _e, retry_at: _r, ...rest } = fresh
        store.putSink({
          ...rest,
          state: fresh.state === 'broken' ? 'active' : fresh.state,
          last_run_at: now,
          last_ok_at: now,
          failures: 0,
        })
        if (trigger !== 'auto')
          addLog(fresh, {
            trigger,
            state: 'nothing',
            message: '没有要写的：表里已经是最新的。',
            appended: 0,
            updated: 0,
            fallback: 0,
            failed: 0,
            items: [],
          })
        return
      }
      const res = await options.ego.write({
        url: fresh.url,
        kind: fresh.kind,
        ...(fresh.key_column === undefined ? {} : { key_column: fresh.key_column }),
        settle_ms: 6000,
        ops: plan.ops.map((o) =>
          o.op === 'append'
            ? { id: o.id, op: 'append' as const, cells: o.cells }
            : {
                id: o.id,
                op: 'update' as const,
                key_text: o.key_text,
                cells: o.cells,
                fallback: o.fallback,
              },
        ),
      })
      const after = store.sink(sink.id) ?? fresh
      const state = store.rows(sink.id)
      const byId = new Map(res.ops.map((o) => [o.id, o]))
      let appended = 0
      let updated = 0
      let fallback = 0
      let failed = 0
      const why = new Map<string, number>()
      const items: KolSyncLog['items'] = []
      for (const op of plan.ops) {
        const got = byId.get(op.id)
        const r = got?.result ?? (res.state === 'ok' ? 'skipped' : 'not_run')
        const st: KolSyncRowState = state.get(op.creator_id) ?? { cells: {} }
        const keep = st.baseline === true ? { baseline: true } : {}
        if (r === 'appended') {
          appended += 1
          const key = fresh.key_column === undefined ? undefined : op.cells[fresh.key_column]
          store.putRow(sink.id, op.creator_id, {
            ...keep,
            ...(key === undefined
              ? st.key_text === undefined
                ? {}
                : { key_text: st.key_text }
              : { key_text: key }),
            cells: { ...st.cells, ...op.cells },
            appended: true,
          })
        } else if (r === 'updated') {
          updated += 1
          store.putRow(sink.id, op.creator_id, { ...st, cells: { ...st.cells, ...op.cells } })
        } else if (r === 'fallback_appended') {
          fallback += 1
          const lost = got?.fallback_for === 'not_found'
          const desired = op.op === 'update' ? { ...op.fallback, ...op.cells } : op.cells
          const { key_text: _k, ...noKey } = st
          store.putRow(sink.id, op.creator_id, {
            ...(lost ? { ...noKey, appended: true } : st),
            cells: { ...st.cells, ...desired },
          })
        } else {
          failed += 1
          why.set(r, (why.get(r) ?? 0) + 1)
        }
        items.push({
          creator_id: op.creator_id,
          name: plan.names.get(op.creator_id) ?? op.creator_id,
          action:
            op.op === 'append'
              ? op.progress === true
                ? 'progress'
                : 'append'
              : r === 'fallback_appended'
                ? 'progress'
                : 'update',
          result: r,
          cells: op.op === 'update' && r === 'fallback_appended' ? op.fallback : op.cells,
          ...(got?.why === undefined
            ? got?.fallback_for === undefined
              ? {}
              : { why: got.fallback_for }
            : { why: got.why }),
        })
      }
      const snapshot =
        res.header !== undefined && (res.after_rows ?? res.before_rows) !== undefined
          ? { header: res.header, rows: (res.after_rows ?? res.before_rows ?? []).slice(0, 3000) }
          : after.snapshot
      const totals = {
        appended: after.totals.appended + appended,
        updated: after.totals.updated + updated,
        fallback: after.totals.fallback + fallback,
      }
      if (res.state === 'ok') {
        const worst = [...why.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        const problem =
          worst === undefined
            ? undefined
            : (PARTIAL_ZH[worst] ?? `${failed} 件没写进去，下一轮再试。`)
        const { retry_at: _r, last_error: _e, pending_since: _p, ...rest } = after
        store.putSink({
          ...rest,
          ...(snapshot === undefined ? {} : { snapshot }),
          state: after.state === 'broken' ? 'active' : after.state,
          last_run_at: now,
          last_ok_at: now,
          failures: 0,
          totals,
          ...(failed > 0 || plan.deferred > 0 ? { pending_since: now } : {}),
          ...(problem === undefined
            ? {}
            : { last_error: { code: 'partial', message: problem, at: now } }),
        })
        const message = `${[
          appended > 0 ? `加了 ${appended} 行` : undefined,
          updated > 0 ? `改了 ${updated} 处` : undefined,
          fallback > 0 ? `${fallback} 处认不准那一行，改成追加一行进展记录` : undefined,
          failed > 0 ? `${failed} 件没写进去` : undefined,
          plan.deferred > 0 ? `还有 ${plan.deferred} 件下一批写` : undefined,
        ]
          .filter(Boolean)
          .join('，')}。`
        addLog(fresh, {
          trigger,
          state: res.state,
          message: problem === undefined ? message : `${message}${problem}`,
          appended,
          updated,
          fallback,
          failed,
          items,
        })
        emit('kol.sync_run', {
          sync_id: sink.id,
          state: res.state,
          appended,
          updated,
          fallback,
          failed,
        })
        return
      }
      const failures = (after.failures ?? 0) + 1
      const stop = STOP_CODES.has(res.state)
      const message = syncWhy(res.state, res.why)
      const { retry_at: _r, ...rest } = after
      store.putSink({
        ...rest,
        ...(snapshot === undefined ? {} : { snapshot }),
        state: 'broken',
        last_run_at: now,
        failures,
        totals,
        pending_since: after.pending_since ?? now,
        last_error: { code: res.state, message, at: now },
        ...(stop
          ? {}
          : {
              retry_at: new Date(
                nowMs() +
                  (KOL_SYNC_BACKOFF_MS[
                    Math.min(failures - 1, KOL_SYNC_BACKOFF_MS.length - 1)
                  ] as number),
              ).toISOString(),
            }),
      })
      addLog(fresh, {
        trigger,
        state: res.state,
        message,
        appended,
        updated,
        fallback,
        failed: failed || plan.ops.length - appended - updated - fallback,
        items,
      })
      emit('kol.sync_run', {
        sync_id: sink.id,
        state: res.state,
        appended,
        updated,
        fallback,
        failed,
      })
      // 第一次坏才提醒（之后退避再试不再响铃）
      if (after.state !== 'broken')
        emit('kol.sync_failed', {
          sync_id: sink.id,
          name: fresh.name,
          message,
          person_id: fresh.created_by.person_id,
          assignment_id: fresh.created_by.assignment_id,
        })
    } finally {
      running.delete(sink.id)
    }
  }

  const maybeRun = async (sink: KolSyncSink): Promise<boolean> => {
    if (sink.state !== 'active' && sink.state !== 'broken') return false
    if (sink.state === 'broken' && sink.retry_at === undefined) return false
    const now = nowMs()
    if (sink.retry_at !== undefined && now < Date.parse(sink.retry_at)) return false
    if (!options.ego.available()) return false
    const plan = planFor(sink)
    if (plan.ops.length === 0) {
      if (plan.matched.length > 0) keepMatched(sink, plan)
      if (sink.pending_since !== undefined) {
        const { pending_since: _p, ...rest } = sink
        store.putSink(rest)
      }
      return false
    }
    const since = sink.pending_since ?? nowIso()
    if (sink.pending_since === undefined) store.putSink({ ...sink, pending_since: since })
    const last = sink.last_run_at === undefined ? undefined : Date.parse(sink.last_run_at)
    const due =
      sink.state === 'broken' ||
      last === undefined ||
      (sink.cadence === 'realtime' && now - Date.parse(since) >= KOL_SYNC_DEBOUNCE_MS) ||
      (sink.cadence === 'hourly' && now - last >= 3_600_000) ||
      (sink.cadence === 'daily' && now - last >= 86_400_000)
    if (!due) return false
    await run(store.sink(sink.id) ?? sink, 'auto')
    return true
  }

  return { maybeRun, run }
}
