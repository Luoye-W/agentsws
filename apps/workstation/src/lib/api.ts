/**
 * `/v1` 客户端。
 *
 * 三条纪律：
 * - 工作台只经 `/v1`（28 §2 唯一入口），没有第二个后端。
 * - 每个请求带 `X-Assignment`（31 §3.1 一次请求一个 Assignment）；当前岗位就是它。
 * - 前端不引入任何模型 SDK：卡片按钮只打 decide（29 §5 动作不经模型）。
 */
import type {
  CalendarItem,
  DailyPlan,
  Goal,
  GoalProgress,
  Matter,
  MatterEvent,
  MatterView,
  Meeting,
  MeetingOutputs,
  MeetingRecord,
  MeetingRecordSourceKind,
  Review,
  Todo,
  BattleReport as WorkBattleReport,
} from '@agentsws/contracts'
import type {
  BattleReport,
  BlockData,
  DeckCard,
  DeckFilters,
  PositionTiles,
  RangeName,
  RecordRow,
  StatTile,
  TileSpec,
  ViewSection,
} from '@agentsws/deck'
import type { RequestBodyOf } from '@agentsws/sdk'

export type { RequestBodyOf } from '@agentsws/sdk'

export interface ApiEnvelope<T> {
  data: T
  trace_id: string
}

/** 撞车候选（40 §3.1）：`409` 的 `details.candidates` 里的一条。 */
export interface SimilarCandidate {
  kind: 'todo' | 'matter'
  id: string
  title: string
  owner: string
  /** 主人的展示名（服务端补；翻译不出来就是 `owner` 本身） */
  owner_label?: string
  status: string
  /** 靠哪几把钥匙命中的：object / semantic / position_day */
  keys: string[]
  /** 等他定的卡数 */
  cards: number
  started_at: string
  last_activity: string
  matter_id?: string
}

export interface ApiErrorBody {
  code: string
  message: string
  details?: {
    reason?: string
    /** `similar_in_progress`（撞车，SimilarCandidate[]）或 `similar_exists`（查重，目录命中）时带的候选；形状按 code 由消费方断言 */
    candidates?: unknown[]
    /** `already_claimed` 时带的主人 */
    owner?: string
    [key: string]: unknown
  }
  trace_id?: string
}

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly reason: string | undefined
  /** 整个 `details`：409 的候选与主人都在这里（选择题卡要用） */
  readonly details: ApiErrorBody['details']

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = body.code
    this.reason = body.details?.reason
    this.details = body.details
  }
}

/* ── 40 §2 工具箱与查重 ───────────────────────────────────────────────── */

export type CatalogKind = 'app' | 'skill' | 'workflow' | 'schedule' | 'custom_card' | 'rule'
export type CatalogLayer = 'personal' | 'dept' | 'company'

export interface CatalogEntryView {
  kind: CatalogKind
  id: string
  title: string
  summary: string
  owner: string
  layer: CatalogLayer
  used_by_positions: string[]
  last_run_at?: string
  runs_30d: number
  created_from?: { entry_id?: string; conversation_id?: string; message_ref?: string }
  reason_for_duplicate?: string
  superseded_by?: string
  trigger?: string
  target?: string
  created_at?: string
}

export interface CatalogSimilarHit {
  entry: CatalogEntryView
  similarity: number
  keys: string[]
  reasons: string[]
}

export interface CatalogDuplicateView {
  a: CatalogEntryView
  b: CatalogEntryView
  similarity: number
  both_in_use: boolean
  reasons: string[]
}

/**
 * `409 similar_exists` 的 details。界面照它渲染那张选择题卡
 * 「复用它 / 合并进它 / 我这个不一样，仍新建」。
 */
export interface SimilarExistsDetails {
  kind: CatalogKind
  candidates: CatalogSimilarHit[]
  options: { id: string; label: string; requires_reason?: boolean }[]
}

/** 这个错是不是"已经有人做过像的了"。 */
export function similarExists(err: unknown): SimilarExistsDetails | undefined {
  if (!(err instanceof ApiClientError) || err.code !== 'similar_exists') return undefined
  const details = err.details as SimilarExistsDetails | undefined
  return details === undefined || !Array.isArray(details.candidates) ? undefined : details
}

/** 选"仍新建"时要带的那一段（理由少于 8 个字服务端回 400）。 */
export interface DuplicateAck {
  decision: 'new'
  reason: string
  similar_to: string[]
}

export const MIN_DUPLICATE_REASON = 8

export const listCatalog = (
  filter: { kind?: CatalogKind[]; layer?: CatalogLayer[]; position?: string; q?: string } = {},
  assignment?: string,
): Promise<CatalogEntryView[]> => {
  const q = new URLSearchParams()
  if (filter.kind !== undefined && filter.kind.length > 0) q.set('kind', filter.kind.join(','))
  if (filter.layer !== undefined && filter.layer.length > 0) q.set('layer', filter.layer.join(','))
  if (filter.position !== undefined) q.set('position', filter.position)
  if (filter.q !== undefined && filter.q.trim() !== '') q.set('q', filter.q.trim())
  const query = q.toString()
  return api<CatalogEntryView[]>(
    `/v1/catalog${query === '' ? '' : `?${query}`}`,
    withAssignment(assignment),
  )
}

export const listCatalogDuplicates = (assignment?: string): Promise<CatalogDuplicateView[]> =>
  api<CatalogDuplicateView[]>('/v1/catalog/duplicates', withAssignment(assignment))

export const findSimilarCatalogEntries = (
  input: { kind: CatalogKind; title: string; summary?: string; trigger?: string; target?: string },
  assignment?: string,
): Promise<CatalogSimilarHit[]> =>
  api<CatalogSimilarHit[]>('/v1/catalog/similar', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/**
 * 建一条定时任务（25 §5）。
 *
 * 不带 `duplicate_ack` 时服务端会先查重：查到像的回 `409 similar_exists` + 候选，
 * 界面出选择题卡；选了"仍新建"再带着理由发一次。
 */
export const createSchedule = (
  input: {
    title: string
    trigger: { kind: 'cron'; expr: string; tz: string }
    handler?: string
    duplicate_ack?: DuplicateAck
  },
  assignment?: string,
): Promise<{ id: string; title?: string }> =>
  api<{ id: string; title?: string }>('/v1/schedules', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** 一键合并：出一张 policy_change 卡，批了才真的合。 */
export const mergeCatalogEntries = (
  input: { keep: string; drop: string },
  assignment?: string,
): Promise<{ approval_item_id: string }> =>
  api<{ approval_item_id: string }>('/v1/catalog/merge', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export interface Assignment {
  id: string
  role_id: string
  ranges: { kind: string; id: string }[]
  revoked_at?: string
}

export interface Me {
  person: { id: string; email: string; name: string }
  workspace: { id: string; name: string }
  assignments: Assignment[]
}

export interface PositionSummary {
  position_id: string
  role_id: string
  role_name: string
  ranges: { kind: string; id: string }[]
  ready: boolean
  missing_connectors: string[]
  tile_ids: string[]
  range: RangeName
  show_tiles: boolean
}

export interface DeckCounts {
  total: number
  customer_waiting: number
  nobody_waiting: number
  matched: number
}

export interface HomeData {
  queue: DeckCard[]
  alerts: DeckCard[]
  tiles: PositionTiles[]
  digest?: DeckCard
  estimated_minutes: number
  range: RangeName
  /** 37 §1 筛选：服务端回带生效的条件、按张数的计数、被筛掉的 P0、今日战报 */
  filters: DeckFilters
  counts: DeckCounts
  pinned_p0: DeckCard[]
  battle_report: BattleReport
  /** 37 §3 首页第三稿多出来的四段（服务进程没装工作模型时不出） */
  goals?: GoalProgress[]
  today?: { timeline: CalendarItem[]; due: { todos: Todo[]; cards_waiting: number } }
  report?: WorkBattleReport
  review?: Review
  plan?: DailyPlan
}

export interface PositionsData {
  positions: PositionSummary[]
  tile_library: TileSpec[]
  max_tiles: number
}

export interface CardsData {
  position: PositionSummary
  cards: DeckCard[]
  filters: DeckFilters
  counts: DeckCounts
  pinned_p0: DeckCard[]
}

export interface ViewData {
  position: PositionSummary
  range: RangeName
  sections: ViewSection[]
}

export interface RecordsData {
  position: PositionSummary
  status: 'ok' | 'not_connected'
  payload?: { rows: RecordRow[] }
}

export interface TilesData {
  position: PositionSummary
  tiles: StatTile[]
}

/**
 * 决定一张卡的入参。
 *
 * **类型从 `@agentsws/sdk` 引**（WP33 C）：它是由 `/v1` 的 OpenAPI 生成的，
 * 而 OpenAPI 又是由路由上的 zod 生成的——于是「服务端改了字段、前端没跟上」
 * 会红在 `tsc` 上，而不是等用户点下去才发现。手抄一份的老做法留在 git 历史里。
 */
export type DecideInput = NonNullable<RequestBodyOf<'/v1/approvals/{id}/decide', 'post'>>

/** 36 §2.1 五动作矩阵里工作台真会发的那四个（`redirect / defer / withdraw` 走别的入口）。 */
export type DeckDecideAction = 'approve' | 'reject' | 'instruct' | 'snooze'

const TOKEN_KEY = 'agentsws.session_token'

let sessionToken: string | null = null
let currentAssignment: string | null = null

export function setAssignment(id: string): void {
  currentAssignment = id
}

export function assignmentId(): string | null {
  return currentAssignment
}

/**
 * 存过的 bearer（普通浏览器里上次登录留下的）。
 *
 * 桌面壳里是 `null`——那条路走 HttpOnly 会话 cookie，前端看不到 token（13 §5）。
 * WP33 的事件流靠它决定握手时要不要带子协议 bearer：有就带，没有就靠 cookie。
 */
export function storedToken(): string | null {
  return readStoredToken()
}

function readStoredToken(): string | null {
  if (sessionToken !== null) return sessionToken
  try {
    sessionToken = globalThis.localStorage?.getItem(TOKEN_KEY) ?? null
  } catch {
    sessionToken = null
  }
  return sessionToken
}

function storeToken(token: string): void {
  sessionToken = token
  try {
    globalThis.localStorage?.setItem(TOKEN_KEY, token)
  } catch {
    // 无痕窗口 / 禁了站点存储：会话只活在这一次页面里，不影响功能
  }
}

export function clearToken(): void {
  sessionToken = null
  try {
    globalThis.localStorage?.removeItem(TOKEN_KEY)
  } catch {
    // 同上
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** 不带 Authorization（登录那两条） */
  anonymous?: boolean
  /** 覆盖 X-Assignment */
  assignment?: string
}

export async function api<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers()
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  if (options.anonymous !== true) {
    const token = readStoredToken()
    if (token !== null) headers.set('Authorization', `Bearer ${token}`)
    const assignment = options.assignment ?? currentAssignment
    if (assignment !== null) headers.set('X-Assignment', assignment)
  }
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  if (!res.ok) throw new ApiClientError(res.status, parsed as ApiErrorBody)
  return (parsed as ApiEnvelope<T>).data
}

// ── 登录：本地单机档的 magic-link 自动换会话（20 §3；demo 不要求填任何东西）──

interface BootstrapConfig {
  owner_email?: string
  demo?: boolean
}

async function bootstrapConfig(): Promise<BootstrapConfig> {
  try {
    const res = await fetch('/app/bootstrap.json')
    if (!res.ok) return {}
    return (await res.json()) as BootstrapConfig
  } catch {
    return {}
  }
}

/** 没有会话——不是错误，是"该去登录页了"（WP28 之后工作区可能不止一个人）。 */
export class NeedsLoginError extends Error {
  /** 登录页把它填进邮箱框，本机单人档一按就进。 */
  readonly hint: string | undefined
  constructor(hint?: string) {
    super('还没登录')
    this.name = 'NeedsLoginError'
    this.hint = hint
  }
}

export const bootstrapHint = async (): Promise<BootstrapConfig> => bootstrapConfig()

/**
 * 拿一个能用的会话，按这个顺序：
 *
 * 1. **HttpOnly 会话 cookie**（13 §5）——桌面壳用 `AGENTSWS_SESSION_KEY` 换好之后，
 *    同源请求自动带上它，前端**看不到也存不到** token，这是最安全的一条；
 * 2. 存过的 bearer（普通浏览器里上次登录留下的）；
 * 3. demo 档自动 magic-link 登录（`agentsws demo` 不该要求任何人填东西）；
 * 4. 其余情况抛 {@link NeedsLoginError} → 走登录页。
 *
 * 第 4 条是 WP28 加的：工作区从"只有所有者"变成"可以有同事"之后，
 * 再拿 owner 的邮箱自动登录就等于所有人都是老板。
 */
export async function ensureSession(): Promise<Me> {
  try {
    // 没有 bearer 时这一发就是「只带 cookie」；桌面壳里它会直接成功
    return await api<Me>('/v1/me')
  } catch (err) {
    if (!(err instanceof ApiClientError) || err.status !== 401) throw err
    clearToken()
  }
  const config = await bootstrapConfig()
  if (config.demo !== true) throw new NeedsLoginError(config.owner_email)
  const email = config.owner_email ?? 'owner@localhost'
  const issued = await api<{ token?: string }>('/v1/auth/magic-link', {
    method: 'POST',
    body: { email },
    anonymous: true,
  })
  if (issued.token === undefined) throw new NeedsLoginError(email)
  const verified = await api<{ session_token: string }>('/v1/auth/verify', {
    method: 'POST',
    body: { token: issued.token },
    anonymous: true,
  })
  storeToken(verified.session_token)
  return api<Me>('/v1/me')
}

// ── 36 §3 问 AI（单轮、只你可见、不发给客户）────────────────────────────

export interface AskAnswer {
  answer: string
  answer_hash: string
  grounded_on: string[]
}

export const askAi = (input: {
  scope: { matter_id?: string; card_id?: string }
  question: string
}): Promise<AskAnswer> => api<AskAnswer>('/v1/ask', { method: 'POST', body: input })

// ── 各个面 ─────────────────────────────────────────────────────────────

/** `DeckFilters` → query；空值不进 URL，免得服务端把空串当成一个筛选条件。 */
export function filterQuery(filters: DeckFilters | undefined): string {
  const params = new URLSearchParams()
  if (filters !== undefined)
    for (const [k, v] of Object.entries(filters)) if (v !== undefined && v !== '') params.set(k, v)
  const s = params.toString()
  return s === '' ? '' : `&${s}`
}

export const getHome = (range: RangeName, filters?: DeckFilters): Promise<HomeData> =>
  api<HomeData>(`/v1/home?range=${range}${filterQuery(filters)}`)

export const getPositions = (): Promise<PositionsData> => api<PositionsData>('/v1/positions')

export const getPositionCards = (id: string, filters?: DeckFilters): Promise<CardsData> =>
  api<CardsData>(`/v1/positions/${encodeURIComponent(id)}/cards?_=1${filterQuery(filters)}`, {
    assignment: id,
  })

export const getPositionView = (id: string, range: RangeName): Promise<ViewData> =>
  api<ViewData>(`/v1/positions/${encodeURIComponent(id)}/view?range=${range}`, { assignment: id })

export const getPositionRecords = (id: string): Promise<RecordsData> =>
  api<RecordsData>(`/v1/positions/${encodeURIComponent(id)}/records`, { assignment: id })

/** 25 定时任务（列表只读 + 暂停 / 恢复）。 */
export interface ScheduledTaskRow {
  id: string
  title?: string
  handler?: string
  trigger: { kind: string; expr?: string; tz?: string; at?: string; every_ms?: number }
  state: string
  fire_count: number
  next_fire_at?: string
  last_fire_at?: string
  last_result?: string
}

export const getSchedules = (assignment: string): Promise<ScheduledTaskRow[]> =>
  api<ScheduledTaskRow[]>('/v1/schedules', { assignment })

export const patchSchedule = (
  id: string,
  patch: { action: 'pause' | 'resume' },
  assignment: string,
): Promise<ScheduledTaskRow> =>
  api<ScheduledTaskRow>(`/v1/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    assignment,
  })

export const getBlockData = (
  id: string,
  range: RangeName,
  assignment: string,
): Promise<BlockData> =>
  api<BlockData>(`/v1/blocks/${encodeURIComponent(id)}/data?range=${range}`, { assignment })

export const decide = (id: string, input: DecideInput, assignment: string): Promise<unknown> =>
  api<unknown>(`/v1/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    body: input,
    assignment,
  })

export const setHomeTiles = (
  position_id: string,
  tile_ids: string[],
  range: RangeName | undefined,
): Promise<TilesData> =>
  api<TilesData>('/v1/me/home-tiles', {
    method: 'PUT',
    body: { position_id, tile_ids, ...(range === undefined ? {} : { range }) },
    assignment: position_id,
  })

// ── 37 工作模型：事项 / 目标 / 待办 / 日历 / 计划 / 复盘 ────────────────

export interface MattersData {
  matters: Matter[]
}
export interface TodosData {
  todos: Todo[]
}
export interface GoalsData {
  goals: Goal[]
  progress: GoalProgress[]
}
export interface CalendarData {
  items: CalendarItem[]
  from: string
  to: string
}
export interface TimelineData {
  events: MatterEvent[]
  has_more: boolean
}
export interface PlanData {
  plan: DailyPlan
}
export interface ReviewsData {
  reviews: Review[]
}

export const listMatters = (query = ''): Promise<MattersData> =>
  api<MattersData>(`/v1/matters${query}`)

/** 服务端在 `MatterView` 上多补的一份参与者展示名（前端不猜、也不查库）。 */
export interface MatterViewWithPeople extends MatterView {
  participant_labels: { person_id: string; label: string }[]
}

export const getMatter = (id: string): Promise<MatterViewWithPeople> =>
  api<MatterViewWithPeople>(`/v1/matters/${encodeURIComponent(id)}`)

export const getMatterTimeline = (id: string, limit: number): Promise<TimelineData> =>
  api<TimelineData>(`/v1/matters/${encodeURIComponent(id)}/timeline?limit=${limit}`)

export const postMatterMessage = (
  id: string,
  text: string,
): Promise<{ event: MatterEvent; run_id?: string }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/messages`, { method: 'POST', body: { text } })

export const closeMatter = (
  id: string,
  unfinished: 'close_all' | 'keep',
): Promise<{ matter: Matter; closed_todo_ids: string[]; kept_todo_ids: string[] }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/close`, { method: 'POST', body: { unfinished } })

export const listGoals = (): Promise<GoalsData> => api<GoalsData>('/v1/goals')

export const listTodos = (query = ''): Promise<TodosData> => api<TodosData>(`/v1/todos${query}`)

export const createTodo = (input: {
  title: string
  due?: string
  matter_id?: string
  /** 主题对象（订单 / 客户 / 会议 / 店铺）——撞车第一把钥匙 */
  refs?: { type: string; id: string }[]
  /** 撞上了怎么办；不给就是「先查」：撞了回 409 */
  collision?: 'join' | 'handoff' | 'force'
  collision_target?: string
  /** 选「我这个不一样」必须写一句区别 */
  distinct_reason?: string
}): Promise<{ todo: Todo }> => api('/v1/todos', { method: 'POST', body: input })

// ── WP38 认领与撞车（40 §3）────────────────────────────────────────────

/** 待认领池里的一条。 */
export interface ClaimPoolItem {
  todo_id: string
  title: string
  note?: string
  source: Todo['source']
  position_id?: string
  matter_id?: string
  due?: string
  pooled_at: string
  /** 回过几次池（上一个主人没动它） */
  recycled: number
  similar_to: string[]
  /** 这条是转交给我的，不是池里的公共项 */
  offered_by?: string
}

/** 「正在进行」的一条。 */
export interface InProgressItem {
  kind: 'todo' | 'matter'
  id: string
  title: string
  owner: string
  owner_label: string
  collaborators: string[]
  status: string
  position_id?: string
  started_at: string
  last_activity: string
  cards: number
  matter_id?: string
}

export const listClaimPool = (): Promise<{ pool: ClaimPoolItem[] }> =>
  api<{ pool: ClaimPoolItem[] }>('/v1/todos/pool')

export const claimTodo = (id: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/claim`, { method: 'POST', body: {} })

export const transferTodo = (id: string, to: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/transfer`, { method: 'POST', body: { to } })

export const addTodoCollaborator = (id: string, person_id: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/collaborators`, {
    method: 'POST',
    body: { person_id },
  })

export const listInProgress = (
  scope: 'position' | 'workspace' = 'position',
): Promise<{ items: InProgressItem[]; scope: string }> =>
  api<{ items: InProgressItem[]; scope: string }>(`/v1/work/in-progress?scope=${scope}`)

export const completeTodo = (id: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/done`, { method: 'POST' })

export const dropTodo = (id: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/drop`, { method: 'POST' })

export const updateTodo = (
  id: string,
  patch: { title?: string; due?: string | null; horizon?: 'backlog' | 'week' | 'today' },
): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}`, { method: 'PUT', body: patch })

export const scheduleTodo = (
  id: string,
  scheduled: { start: string; end: string } | null,
): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/schedule`, { method: 'POST', body: { scheduled } })

export const delegateTodo = (id: string, brief?: string): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}/delegate`, {
    method: 'POST',
    body: brief === undefined ? {} : { brief },
  })

export const getCalendar = (from: string, to: string): Promise<CalendarData> =>
  api<CalendarData>(`/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)

export const getTodayPlan = (): Promise<PlanData> => api<PlanData>('/v1/plans/today')

export const decidePlan = (
  id: string,
  option: 'adopt' | 'adjust' | 'later',
  selected_ids?: string[],
): Promise<{ plan: DailyPlan; todos: Todo[] }> =>
  api(`/v1/plans/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    body: { option, ...(selected_ids === undefined ? {} : { selected_ids }) },
  })

export const listReviews = (): Promise<ReviewsData> => api<ReviewsData>('/v1/reviews?kind=day')
// ── 会议（37 §4）─────────────────────────────────────────────────────

export interface MeetingDetail {
  meeting: Meeting
  records: MeetingRecord[]
}

export interface MeetingSystemCard {
  id: string
  kind: 'system_alert'
  reason: string
  title: string
  body: string
  actions: { id: string; label: string }[]
}

export interface MeetingProcessResult {
  record: MeetingRecord
  outputs?: MeetingOutputs
  approvals?: {
    claims: { title: string; summary: string; dedupe_key: string; payload: unknown }[]
    knowledge: { title: string; summary: string; dedupe_key: string; payload: unknown }[]
    boundaries: { title: string; summary: string; dedupe_key: string; payload: unknown }[]
  }
  system_card?: MeetingSystemCard
}

export interface NewMeetingInput {
  title: string
  start: string
  end: string
  participants: { name?: string; email?: string; external?: boolean }[]
  agenda?: string
}

export interface AddRecordInput {
  source: MeetingRecordSourceKind
  text?: string
  /** 录音：字节按 base64 传（一次录完；分块的走 chunk_index / final）。 */
  audio_base64?: string
  mime?: string
  name?: string
  notice_given?: boolean
  final?: boolean
}

export const getMeetings = (): Promise<Meeting[]> => api<Meeting[]>('/v1/meetings')

export const getMeeting = (id: string): Promise<MeetingDetail> =>
  api<MeetingDetail>(`/v1/meetings/${encodeURIComponent(id)}`)

export const createMeeting = (input: NewMeetingInput): Promise<Meeting> =>
  api<Meeting>('/v1/meetings', { method: 'POST', body: input })

export const addMeetingRecord = (id: string, input: AddRecordInput): Promise<MeetingRecord[]> =>
  api<MeetingRecord[]>(`/v1/meetings/${encodeURIComponent(id)}/records`, {
    method: 'POST',
    body: input,
  })

export const processMeetingRecord = (id: string, rid: string): Promise<MeetingProcessResult> =>
  api<MeetingProcessResult>(
    `/v1/meetings/${encodeURIComponent(id)}/records/${encodeURIComponent(rid)}/process`,
    { method: 'POST' },
  )

export const getMeetingOutputs = (id: string): Promise<MeetingOutputs[]> =>
  api<MeetingOutputs[]>(`/v1/meetings/${encodeURIComponent(id)}/outputs`)

export interface SendCardInput {
  record_id: string
  kind: 'claim' | 'knowledge_update' | 'policy_change'
  item_id: string
}

export const sendMeetingCard = (
  id: string,
  input: SendCardInput,
): Promise<{ approval_id: string; title: string }> =>
  api(`/v1/meetings/${encodeURIComponent(id)}/outputs/send`, { method: 'POST', body: input })

export const exportMeeting = (
  id: string,
): Promise<{ format: string; filename: string; content: string }> =>
  api(`/v1/meetings/${encodeURIComponent(id)}/export`)

/** 浏览器录音的字节 → base64（Electron 与浏览器都走这条，不用 Node 的 Buffer）。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

// ── WP20 连接面 ────────────────────────────────────────────────────────
//
// 纪律（13 §4.3）：**凭据只经 `submitConnection` 这一条路出去**，而且是原生 `<form>`
// 收集、直接打到本机服务进程。前端不缓存、不打日志、不放进 react-query 的缓存键，
// 提交完那个对象就没人再引用它。这里的类型与 `@agentsws/api` 的端口一一对应。

export type ConnectionOwnership = 'workspace' | 'person'
export type ProviderAuthKind = 'no_auth' | 'api_key' | 'oauth2' | 'custom_credential'

export interface ProviderFieldSpec {
  name: string
  label: string
  secret: boolean
  required: boolean
  kind?: 'text' | 'password' | 'email' | 'number' | 'url'
  placeholder?: string
  hint?: string
  default?: string
}

export interface ConnectTestResult {
  ok: boolean
  reason?: string
  detail?: string
  checked_at: string
}

export interface ConnectionView {
  id: string
  service: string
  service_label: string
  alias: string
  ownership: ConnectionOwnership
  status: 'active' | 'reauth_required' | 'disabled'
  identity?: { account_id?: string; display_name?: string }
  credential_store: 'openconnector' | 'local_vault'
  data_sources: string[]
  last_tested_at?: string
  last_test?: ConnectTestResult
  /** WP44：用已经下线的老办法接的（Shopify 的 shpat_ 直填令牌）。 */
  legacy?: { kind: 'shopify_access_token'; hint: string }
}

export interface ProviderView {
  service: string
  label: string
  auth: ProviderAuthKind
  fields: ProviderFieldSpec[]
  available: boolean
  unavailable_reason?: string
  data_sources: string[]
  setup_guide: { summary: string; steps: string[]; links: { label: string; url: string }[] }
  data_note?: string
  /** WP25：两种以上接法时给出来，第一条是推荐的那条。 */
  auth_options?: ProviderAuthOption[]
}

export interface RuntimeStatusView {
  state: 'absent' | 'unhardened' | 'ready' | 'stand_in'
  base_url?: string
  reasons: string[]
  checks: { name: string; ok: boolean; detail: string }[]
  checked_at: string
  secrets_vault: { available: boolean; reason?: string }
  /** WP44：出站解析环境（代理 fake-IP 会让连接器把外网域名当内网拦下）。 */
  egress?: { fake_ip_detected: boolean; trusted_hosts: string[]; detail?: string }
}

export interface BeginConnectResult {
  request_id: string
  authorization_url?: string
  secure_form?: { fields: ProviderFieldSpec[]; auth_option?: string }
}

/**
 * 连接是**工作区所有者**的事（05 `common.owner` 的 `authorize_connector`）。
 * 一个人可能同时持有客服岗位与所有者岗位，而网关是一次请求绑一个 Assignment（31 §3.1），
 * 所以这几条一律显式带上所有者那条，不跟着"当前岗位"走。
 */
export const listConnections = (assignment?: string): Promise<{ connections: ConnectionView[] }> =>
  api<{ connections: ConnectionView[] }>('/v1/connections', withAssignment(assignment))

export const listProviders = (assignment?: string): Promise<{ providers: ProviderView[] }> =>
  api<{ providers: ProviderView[] }>('/v1/connections/providers', withAssignment(assignment))

export const getConnectRuntime = (assignment?: string): Promise<RuntimeStatusView> =>
  api<RuntimeStatusView>('/v1/connections/runtime', withAssignment(assignment))

export const beginConnect = (
  service: string,
  input: { alias?: string; ownership?: ConnectionOwnership; auth_option?: string } = {},
  assignment?: string,
): Promise<BeginConnectResult> =>
  api<BeginConnectResult>(`/v1/connections/${encodeURIComponent(service)}/begin`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const pollConnectRequest = (
  request_id: string,
  assignment?: string,
): Promise<{
  status: 'initiated' | 'connected' | 'failed' | 'expired'
  connection?: ConnectionView
}> => api(`/v1/connections/requests/${encodeURIComponent(request_id)}`, withAssignment(assignment))

function withAssignment(assignment: string | undefined): RequestOptions {
  return assignment === undefined ? {} : { assignment }
}

/**
 * **唯一一条会带凭据出门的请求。**
 *
 * 值从原生 `<form>` 的 FormData 里来，在这里组装一次、发出去，函数返回后就没人引用它了。
 * 不写 localStorage、不进 query 缓存、不打 console。
 */
export const submitConnection = (
  service: string,
  input: {
    alias?: string
    ownership?: ConnectionOwnership
    request_id?: string
    auth_option?: string
    fields: Record<string, string>
  },
  assignment?: string,
): Promise<{ connection: ConnectionView; test: ConnectTestResult }> =>
  api(`/v1/connections/${encodeURIComponent(service)}/submit`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const testConnection = (id: string, assignment?: string): Promise<ConnectTestResult> =>
  api<ConnectTestResult>(`/v1/connections/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const removeConnection = (id: string, assignment?: string): Promise<{ removed: boolean }> =>
  api<{ removed: boolean }>(`/v1/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

// ── WP25 交付 A/B：Shopify 两种接法 + 邮箱自动识别 ──────────────────────

/** 同一个服务的另一种接法（Shopify：Dev Dashboard 应用 / 老的访问令牌）。 */
export interface ProviderAuthOption {
  id: string
  label: string
  summary: string
  recommended?: boolean
  auth: ProviderAuthKind
  fields: ProviderFieldSpec[]
  setup_guide: { summary: string; steps: string[]; links: { label: string; url: string }[] }
}

export interface MailboxPresetView {
  id: string
  label: string
  imap_host: string
  imap_port: number
  smtp_host: string
  smtp_port: number
  auth: 'app_password' | 'password' | 'oauth_required'
  note: string
  help_url?: string
}

export interface MailboxDetectResult {
  domain: string
  mx_hosts: string[]
  preset: MailboxPresetView | null
}

/**
 * 按邮箱地址认出是哪家邮箱。
 *
 * 只发地址、只回主机端口——**没有口令这条路**（口令仍然只走 `submitConnection`）。
 * 认不出来就 `preset: null`，表单回退手填；这个调用失败也绝不打断填表。
 */
export const detectMailbox = (email: string, assignment?: string): Promise<MailboxDetectResult> =>
  api<MailboxDetectResult>(
    `/v1/connections/mail/detect?email=${encodeURIComponent(email)}`,
    withAssignment(assignment),
  )

// ── WP25 交付 C：模型 ───────────────────────────────────────────────────
//
// 同一条纪律：**API key 只经 `saveModelProvider` 这一条路出去**，原生 `<form>` 收集、
// 直接打到本机服务进程。`listModelProviders` 回来的只有 `has_key` 这个布尔值。

export type ModelProviderKind = 'deepseek' | 'openai_compatible'

export type ModelPurposeName =
  | 'run'
  | 'extraction'
  | 'reflection'
  | 'embedding'
  | 'judge'
  | 'transcription'

export interface ModelTestResult {
  ok: boolean
  reason?: string
  detail?: string
  model?: string
  duration_ms?: number
  checked_at: string
}

/** WP42：这家现在有哪些模型（从 `/models` 拉的）。拉不到时 `ok: false` + 一句人话。 */
export interface ModelListing {
  ok: boolean
  models: string[]
  reason?: string
  checked_at: string
}

export interface ModelProviderView {
  id: string
  kind: ModelProviderKind
  label: string
  base_url: string
  model: string
  embedding_model?: string
  transcription_model?: string
  region: 'cn' | 'global'
  has_key: boolean
  active: boolean
  inactive_reason?: string
  price_in?: number
  price_out?: number
  price_cached?: number
  /** WP42：这三个价从哪来。`manual` 的不会被每周那次官网刷新覆盖。 */
  price_source?: 'catalog' | 'manual'
  price_currency?: string
  price_source_url?: string
  price_as_of?: string
  /** WP42：上次拉回来的模型清单。 */
  models?: string[]
  last_listing?: ModelListing
  last_test?: ModelTestResult
  from_env?: boolean
}

export interface ModelProviderTemplate {
  kind: ModelProviderKind
  label: string
  summary: string
  default_base_url: string
  default_model: string
  region: 'cn' | 'global'
  steps: string[]
  links: { label: string; url: string }[]
  presets?: {
    id: string
    label: string
    base_url: string
    model: string
    region: 'cn' | 'global'
  }[]
}

export interface ModelDefaultsView {
  default: string
  by_purpose: Partial<Record<ModelPurposeName, string>>
  data_residency: 'cn' | 'any'
  budget: {
    workspace_daily_base?: number
    workspace_monthly_base?: number
    assignment_daily_base?: number
  }
  choices: { id: string; label: string }[]
}

export interface ModelUsageRow {
  purpose: ModelPurposeName
  calls: number
  input_tokens: number
  output_tokens: number
  cached_tokens: number
  cost_base: number
}

export interface ModelUsageView {
  since: string
  rows: ModelUsageRow[]
  total?: ModelUsageRow
  budget: { used_base: number; cap_base: number; frozen: boolean }
}

export const listModelProviders = (
  assignment?: string,
): Promise<{ providers: ModelProviderView[]; templates: ModelProviderTemplate[] }> =>
  api('/v1/models/providers', withAssignment(assignment))

/**
 * **唯一一条会带 API key 出门的请求。**
 *
 * 值从原生 `<form>` 的 FormData 里来，组装一次、发出去，函数返回后没人再引用它。
 * 不写 localStorage、不进 query 缓存、不打 console。
 */
export const saveModelProvider = (
  id: string,
  input: {
    kind: ModelProviderKind
    label?: string
    base_url?: string
    model: string
    embedding_model?: string
    region?: 'cn' | 'global'
    api_key?: string
    price_in?: number
    price_out?: number
  },
  assignment?: string,
): Promise<ModelProviderView> =>
  api(`/v1/models/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const removeModelProvider = (
  id: string,
  assignment?: string,
): Promise<{ removed: boolean }> =>
  api(`/v1/models/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

export const testModelProvider = (id: string, assignment?: string): Promise<ModelTestResult> =>
  api(`/v1/models/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

/**
 * WP42：去这家的 `/models` 拉一次模型清单。
 *
 * `api_key` 是第二条会带 key 出门的路——用户刚把地址与 key 填进表单、还没点保存就想
 * 看看有哪些模型可选时用它。和保存那条一样：组装一次、发出去，函数返回后没人再引用它。
 */
export const discoverModelProviderModels = (
  id: string,
  input: { base_url?: string; api_key?: string; region?: 'cn' | 'global' },
  assignment?: string,
): Promise<ModelListing> =>
  api(`/v1/models/providers/${encodeURIComponent(id)}/discover`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const getModelDefaults = (assignment?: string): Promise<ModelDefaultsView> =>
  api('/v1/models/defaults', withAssignment(assignment))

export const setModelDefaults = (
  input: {
    default?: string
    by_purpose?: Partial<Record<ModelPurposeName, string>>
    data_residency?: 'cn' | 'any'
    budget?: {
      workspace_daily_base?: number
      workspace_monthly_base?: number
      assignment_daily_base?: number
    }
  },
  assignment?: string,
): Promise<ModelDefaultsView> =>
  api('/v1/models/defaults', { method: 'PUT', body: input, ...withAssignment(assignment) })

export const getModelUsage = (assignment?: string): Promise<ModelUsageView> =>
  api('/v1/models/usage', withAssignment(assignment))

// ── WP42 价目表：内置价 + 官网刷新 ──────────────────────────────────────

export interface ModelPricingModel {
  model: string
  in: number
  out: number
  cached: number
  aliases?: string[]
}

export interface ModelPricingVendorView {
  id: string
  label: string
  currency: string
  hosts: string[]
  source_url: string
  as_of: string
  last_refresh?: { at: string; ok: boolean; models: number; reason?: string }
  models: ModelPricingModel[]
}

export interface ModelPricingView {
  vendors: ModelPricingVendorView[]
  refreshed_at?: string
}

export interface ModelPricingRefreshResult {
  at: string
  ok: boolean
  vendors: { id: string; label: string; ok: boolean; models: number; reason?: string }[]
  updated_providers: number
  reason?: string
}

export const getModelPricing = (assignment?: string): Promise<ModelPricingView> =>
  api('/v1/models/pricing', withAssignment(assignment))

export const refreshModelPricing = (assignment?: string): Promise<ModelPricingRefreshResult> =>
  api('/v1/models/pricing/refresh', { method: 'POST', ...withAssignment(assignment) })

/** `https://api.deepseek.com/v1` → `api.deepseek.com`。认不出来回空串。 */
function hostOf(baseUrl: string): string {
  const raw = baseUrl.trim()
  if (raw === '') return ''
  try {
    return new URL(raw.includes('://') ? raw : `https://${raw}`).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 按（接口地址, 模型名）在价目表里查一条价。
 *
 * 匹配顺序与服务端一致：完全一样 → 别名 → 去掉日期后缀。查不到就回 undefined
 * ——不猜。表单据此决定"自动填"还是"留空让人自己填"。
 */
export function findCatalogPrice(
  pricing: ModelPricingView | undefined,
  baseUrl: string,
  model: string,
):
  | { in: number; out: number; cached: number; currency: string; as_of: string; source_url: string }
  | undefined {
  if (pricing === undefined) return undefined
  const host = hostOf(baseUrl)
  if (host === '') return undefined
  const vendor = pricing.vendors.find((v) =>
    v.hosts.some((h) => host === h || host.endsWith(`.${h}`)),
  )
  if (vendor === undefined) return undefined
  const name = model.trim().toLowerCase()
  if (name === '') return undefined
  const undated = name.replace(/-\d{4}-\d{2}-\d{2}$/, '')
  const hit = vendor.models.find(
    (m) =>
      m.model.toLowerCase() === name ||
      m.model.toLowerCase() === undated ||
      (m.aliases ?? []).some((a) => a.toLowerCase() === name),
  )
  if (hit === undefined) return undefined
  return {
    in: hit.in,
    out: hit.out,
    cached: hit.cached,
    currency: vendor.currency,
    as_of: vendor.as_of,
    source_url: vendor.source_url,
  }
}

// ── WP28 制度面：职责 / 岗位 / 分配 / 成员与邀请 ─────────────────────────
//
// 同一条纪律：这几条一律显式带**所有者那条 Assignment**（05 §3 策略层只有 owner 可改），
// 不跟着左栏"当前岗位"走；网关是一次请求绑一个，带错了就是 403（31 §3.1）。

export interface RoleSummaryView {
  id: string
  name: string
  name_en: string
  description: string
  domain: string
  version: string
  source: 'bundled' | 'custom'
  editable: boolean
  holders: number
  home_blocks: { id: string; placement: string; component: string }[]
  actions: {
    id: string
    kind: string
    target: string
    route_to: string
    review_cannot_be_disabled: boolean
    caps: { key: string; value: string }[]
    window?: { max_count: number; per: string }
  }[]
  automation: { action_id: string; ceiling: string; initial: string; hard_ceiling: boolean }[]
  connectors: { kind: string; required: boolean }[]
}

export interface RoleDetailView extends RoleSummaryView {
  scopes: { domain: string; ops: string[]; range: string; max_sensitivity: string }[]
  skills: { name: string; tier: string; load: string }[]
}

export interface OrgPositionView {
  id: string
  name: string
  name_en: string
  version: string
  source: 'bundled' | 'custom'
  roles: { role_id: string; name: string; default: boolean; loaded: boolean }[]
  holders: { person_id: string; name: string; ranges: { kind: string; id: string }[] }[]
}

export interface OrgAssignmentView {
  assignment_id: string
  person_id: string
  person_name: string
  role_id: string
  role_name: string
  role_version: string
  ranges: { kind: string; id: string }[]
  /** 44 G1：这些范围是从哪几个品牌来的。 */
  range_groups?: string[]
  granted_at: string
  revoked_at?: string
  unassigned_range: boolean
}

export interface OrgMemberView {
  person_id: string
  name: string
  email: string
  role: 'owner' | 'manager' | 'member'
  joined_at: string
  left_at?: string
  positions: { id: string; name: string }[]
  assignments: OrgAssignmentView[]
}

export interface OrgInvitationView {
  id: string
  email: string
  name?: string
  role: 'owner' | 'manager' | 'member'
  position_id?: string
  ranges: { kind: string; id: string }[]
  created_at: string
  expires_at: string
  accepted_at?: string
  used: boolean
  url?: string
  delivered: 'link' | 'email'
}

export interface OrgChangeReceipt {
  status: 'pending_approval' | 'applied'
  approval_item_id?: string
  summary: string
}

export interface RangeOption {
  kind: 'store' | 'department' | 'account' | 'market' | 'product_line'
  id: string
  label: string
}

// ── 44 品牌（范围组）与产品线 ──────────────────────────────────────────

export type ProductLineRule =
  | {
      platform: 'shopify'
      collection_ids?: string[]
      tags?: string[]
      vendors?: string[]
      product_types?: string[]
    }
  | { platform: 'amazon'; asins?: string[]; sku_prefixes?: string[]; brand?: string }
  | { platform: 'manual'; product_ids: string[] }

/** 45 H2 / H3：一条组织对象是从谁那儿带进来的，以及它是不是别名。 */
export interface OrgObjectOrigin {
  workspace_id: string
  person_id: string
  object_id?: string
}

export interface RangeGroupView {
  id: string
  name: string
  members: { kind: string; id: string }[]
  created_at: string
  updated_at: string
  /** 有几个岗位挂着它（删之前看这个数）。 */
  holders: number
  /** 45 H3：被公司那份取代了（值是真源那条的 id）。 */
  superseded_by?: string
  /** 45 H3 / H5：这一条只能看——界面上给的按钮是"提议修改"，不是"改"。 */
  readonly?: boolean
  /** 45 H2：谁、从哪个工作区带进来的。 */
  origin?: OrgObjectOrigin
  /** 45 H3：你点开的是 `alias_of` 那一条，读到的是这一条。 */
  alias_of?: string
}

export interface ProductLineView {
  id: string
  name: string
  parent: { kind: string; id: string }
  rule: ProductLineRule
  created_at: string
  updated_at: string
  holders: number
  superseded_by?: string
  readonly?: boolean
  origin?: OrgObjectOrigin
  alias_of?: string
  /** 这条判据能不能交给上游先切一刀（19 §3 过滤下推）。 */
  pushdown: boolean
}

/** 45 H4：查重命中的一条——界面照它显示"已有：X（谁建的，几个岗位挂着）→ 直接用它"。 */
export interface OrgDuplicateHit {
  id: string
  kind: 'range_group' | 'product_line' | 'store_range'
  name: string
  verdict: 'same' | 'similar'
  similarity: number
  reasons: string[]
  created_by?: string
  created_by_name?: string
  holders: number
}

/**
 * 45 H4「建之前先查」：新建表单一边打字一边防抖来问。**只读**，问一百遍也不建东西。
 *
 * 命中之后界面给的是"直接用它"——点了就是引用已有那条，不会产生第二份。
 */
export const checkOrgDuplicate = (
  query: {
    kind: 'range_group' | 'product_line' | 'store_range'
    name: string
    members?: { kind: string; id: string }[]
    parent?: { kind: string; id: string }
    rule?: ProductLineRule
    platform?: 'shopify' | 'amazon' | 'other'
    external_id?: string
    exclude_id?: string
  },
  assignment?: string,
): Promise<OrgDuplicateHit[]> =>
  api<OrgDuplicateHit[]>('/v1/org/duplicate-check', {
    method: 'POST',
    body: query,
    ...withAssignment(assignment),
  })

export const listRangeGroups = (assignment?: string): Promise<RangeGroupView[]> =>
  api<RangeGroupView[]>('/v1/org/range-groups', withAssignment(assignment))

export const createRangeGroup = (
  input: { name: string; members: { kind: string; id: string }[] },
  assignment?: string,
): Promise<RangeGroupView> =>
  api<RangeGroupView>('/v1/org/range-groups', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const updateRangeGroup = (
  id: string,
  input: { name: string; members: { kind: string; id: string }[] },
  assignment?: string,
): Promise<RangeGroupView> =>
  api<RangeGroupView>(`/v1/org/range-groups/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const deleteRangeGroup = (id: string, assignment?: string): Promise<{ deleted: boolean }> =>
  api<{ deleted: boolean }>(`/v1/org/range-groups/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

/**
 * 45 H5：提议改一条品牌 / 产品线。**不直接改**——回的是一张 `policy_change` 卡的 id。
 *
 * 只读的那一份（并进公司之后的个人副本）走的也是这条：界面上那个按钮不叫"改"。
 */
export const proposeRangeChange = (
  target: 'range_group' | 'product_line',
  id: string,
  input: {
    reason: string
    name?: string
    members?: { kind: string; id: string }[]
    parent?: { kind: string; id: string }
    rule?: ProductLineRule
  },
  assignment?: string,
): Promise<{ status: string; approval_item_id?: string; summary: string }> =>
  api<{ status: string; approval_item_id?: string; summary: string }>(
    `/v1/org/${target === 'range_group' ? 'range-groups' : 'product-lines'}/${encodeURIComponent(id)}/propose`,
    { method: 'POST', body: input, ...withAssignment(assignment) },
  )

export const listProductLines = (assignment?: string): Promise<ProductLineView[]> =>
  api<ProductLineView[]>('/v1/org/product-lines', withAssignment(assignment))

export const createProductLine = (
  input: { name: string; parent: { kind: string; id: string }; rule: ProductLineRule },
  assignment?: string,
): Promise<ProductLineView> =>
  api<ProductLineView>('/v1/org/product-lines', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const updateProductLine = (
  id: string,
  input: { name: string; parent: { kind: string; id: string }; rule: ProductLineRule },
  assignment?: string,
): Promise<ProductLineView> =>
  api<ProductLineView>(`/v1/org/product-lines/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const deleteProductLine = (id: string, assignment?: string): Promise<{ deleted: boolean }> =>
  api<{ deleted: boolean }>(`/v1/org/product-lines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

// ── 45 Join 向导：个人工作区并进公司 ──────────────────────────────────

export type JoinResolution =
  | 'merge_union'
  | 'adopt_company'
  | 'keep_both'
  | 'create_in_company'
  | 'skip'

export interface JoinObjectSideView {
  id: string
  name: string
  summary: string
  holders?: number
}

export interface JoinObjectView {
  kind: 'range_group' | 'product_line' | 'store_range'
  unique_key: string
  verdict: 'same' | 'similar' | 'missing'
  mine: JoinObjectSideView
  theirs?: JoinObjectSideView
  similarity?: number
  reasons: string[]
  suggested: JoinResolution
  options: JoinResolution[]
}

export interface JoinConnectionView {
  connection_id: string
  service: string
  label: string
  transfer: boolean
  company_has_same_service?: boolean
}

export interface JoinMappingView {
  join_id: string
  source_workspace_id: string
  target_workspace_id: string
  person_id: string
  objects: JoinObjectView[]
  connections: JoinConnectionView[]
  counts: { same: number; similar: number; missing: number }
}

export interface JoinCompleteView {
  join_id: string
  merged: number
  created: number
  kept: number
  transferred_connections: number
  range_rewrites: number
}

export const listJoins = (assignment?: string): Promise<JoinMappingView[]> =>
  api<JoinMappingView[]>('/v1/join', withAssignment(assignment))

export const getJoinMapping = (id: string, assignment?: string): Promise<JoinMappingView> =>
  api<JoinMappingView>(`/v1/join/${encodeURIComponent(id)}`, withAssignment(assignment))

export const completeJoin = (
  id: string,
  input: {
    objects: { unique_key: string; chosen: JoinResolution; name_choice?: 'company' | 'personal' }[]
    connections: { connection_id: string; transfer: boolean }[]
  },
  assignment?: string,
): Promise<JoinCompleteView> =>
  api<JoinCompleteView>(`/v1/join/${encodeURIComponent(id)}/complete`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const listRoleDefinitions = (assignment?: string): Promise<RoleSummaryView[]> =>
  api<RoleSummaryView[]>('/v1/roles', withAssignment(assignment))

export const getRoleDefinition = (id: string, assignment?: string): Promise<RoleDetailView> =>
  api<RoleDetailView>(`/v1/roles/${encodeURIComponent(id)}`, withAssignment(assignment))

export const copyRoleDefinition = (
  from: string,
  name: string | undefined,
  assignment?: string,
): Promise<RoleDetailView> =>
  api<RoleDetailView>('/v1/roles', {
    method: 'POST',
    body: { from, ...(name === undefined ? {} : { name }) },
    ...withAssignment(assignment),
  })

/** 改职责模板：不直接生效，回一张卡的 id（14 `policy_change`）。 */
export const proposeRoleChange = (
  id: string,
  patch: {
    name?: string
    description?: string
    actions?: { id: string; caps?: Record<string, number>; window_max_count?: number }[]
  },
  assignment?: string,
): Promise<OrgChangeReceipt> =>
  api<OrgChangeReceipt>(`/v1/roles/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: patch,
    ...withAssignment(assignment),
  })

export const listOrgPositions = (assignment?: string): Promise<OrgPositionView[]> =>
  api<OrgPositionView[]>('/v1/org/positions', withAssignment(assignment))

export const createOrgPosition = (
  input: { name: string; roles: { role_id: string; default?: boolean }[] },
  assignment?: string,
): Promise<OrgPositionView> =>
  api<OrgPositionView>('/v1/org/positions', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const updateOrgPosition = (
  id: string,
  input: { name: string; roles: { role_id: string; default?: boolean }[] },
  assignment?: string,
): Promise<OrgPositionView> =>
  api<OrgPositionView>(`/v1/org/positions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const deleteOrgPosition = (id: string, assignment?: string): Promise<{ deleted: boolean }> =>
  api(`/v1/org/positions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

export const createAssignments = (
  input: {
    person_id: string
    position_id?: string
    role_id?: string
    include?: string[]
    ranges: { kind: string; id: string }[]
    /** 44 G1：挂的品牌（范围组）。 */
    range_groups?: string[]
  },
  assignment?: string,
): Promise<OrgAssignmentView[]> =>
  api<OrgAssignmentView[]>('/v1/assignments', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const revokeAssignment = (id: string, assignment?: string): Promise<OrgAssignmentView> =>
  api<OrgAssignmentView>(`/v1/assignments/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

export const listMembers = (workspace_id: string, assignment?: string): Promise<OrgMemberView[]> =>
  api<OrgMemberView[]>(
    `/v1/workspaces/${encodeURIComponent(workspace_id)}/members`,
    withAssignment(assignment),
  )

export const removeMember = (
  workspace_id: string,
  person_id: string,
  assignment?: string,
): Promise<{ revoked_assignments: number }> =>
  api(
    `/v1/workspaces/${encodeURIComponent(workspace_id)}/members/${encodeURIComponent(person_id)}`,
    { method: 'DELETE', ...withAssignment(assignment) },
  )

/** 40 §1.2 离职报告（**只有数字，没有个人数据正文**）。 */
export interface OffboardStepView {
  step: 'revoke' | 'handover' | 'skills' | 'memory' | 'lessons' | 'report'
  status: 'done' | 'skipped' | 'failed' | 'pending_approval'
  counts?: Record<string, number>
  approval_item_id?: string
  error?: string
}

export interface OffboardReportView {
  person_id: string
  person_name: string
  handover_to: string
  handover_to_name: string
  fallback_used: boolean
  personal_layer: 'archive' | 'erase'
  memory: 'migrate_work' | 'erase'
  status: 'done' | 'partial' | 'pending_approval'
  at: string
  steps: OffboardStepView[]
  summary: string
  manual: string[]
  matter_id?: string
}

export interface ArchivedSkillView {
  skill: string
  owner: string
  owner_name: string
  sections: number
  base_version: string
  archived_at: string
  reason?: string
}

/**
 * 离职：撤权限 → 在办事项 / 未完待办 / 定时任务真转接手人 → 个人层归档或销毁 →
 * 个人记忆迁移或擦除 → 出一份报告（40 §1.2）。可重跑。
 */
export const offboardMember = (
  workspace_id: string,
  person_id: string,
  input: {
    handover_to?: string
    personal_layer?: 'archive' | 'erase'
    memory?: 'migrate_work' | 'erase'
  },
  assignment?: string,
): Promise<OffboardReportView> =>
  api<OffboardReportView>(
    `/v1/workspaces/${encodeURIComponent(workspace_id)}/members/${encodeURIComponent(person_id)}/offboard`,
    { method: 'POST', body: input, ...withAssignment(assignment) },
  )

/** 前员工层：归档的技能改动（只有段数，没有正文）。 */
export const listArchivedSkills = (
  workspace_id: string,
  assignment?: string,
): Promise<ArchivedSkillView[]> =>
  api<ArchivedSkillView[]>(
    `/v1/workspaces/${encodeURIComponent(workspace_id)}/archived-skills`,
    withAssignment(assignment),
  )

/** 一键「采纳进部门层」：建一张 policy_change 卡，批了才落。 */
export const adoptArchivedSkill = (
  workspace_id: string,
  input: { skill: string; owner: string; to_tier: 'company' | 'department'; scope_id?: string },
  assignment?: string,
): Promise<{ status: string; approval_item_id: string; summary: string }> =>
  api(`/v1/workspaces/${encodeURIComponent(workspace_id)}/archived-skills/adopt`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const listInvitations = (
  workspace_id: string,
  assignment?: string,
): Promise<OrgInvitationView[]> =>
  api<OrgInvitationView[]>(
    `/v1/workspaces/${encodeURIComponent(workspace_id)}/invitations`,
    withAssignment(assignment),
  )

export const inviteMember = (
  workspace_id: string,
  input: {
    email: string
    name?: string
    position_id?: string
    ranges?: { kind: string; id: string }[]
  },
  assignment?: string,
): Promise<OrgInvitationView> =>
  api<OrgInvitationView>(`/v1/workspaces/${encodeURIComponent(workspace_id)}/invitations`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const listRangeOptions = (assignment?: string): Promise<RangeOption[]> =>
  api<RangeOption[]>('/v1/org/ranges', withAssignment(assignment))

// ── WP28 登录与邀请（真实模式：没有 demo 自动登录时走这条）────────────

export interface AcceptedInvitationView {
  workspace_id: string
  workspace_name: string
  email: string
  person_id: string
  assignments: OrgAssignmentView[]
}

/** 接受邀请：这会儿还没有任何凭据，所以是匿名请求。 */
export const acceptInvitation = (token: string, name?: string): Promise<AcceptedInvitationView> =>
  api<AcceptedInvitationView>(`/v1/invitations/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: { ...(name === undefined ? {} : { name }) },
    anonymous: true,
  })

/**
 * 按邮箱要一个登录链接。
 *
 * 本地档直接把一次性 token 回给调用方（`token` 有值），页面上给一个"直接进去"的按钮；
 * 托管档只回 `expires_at`，token 走邮件——那时页面只说"去收件箱点链接"。
 */
export const requestMagicLink = (
  email: string,
): Promise<{ token?: string; expires_at: string; delivered?: string }> =>
  api('/v1/auth/magic-link', { method: 'POST', body: { email }, anonymous: true })

/** 用一次性 token 换会话，并把它存下来（之后所有请求都带它）。 */
export async function signInWithToken(token: string): Promise<Me> {
  const verified = await api<{ session_token: string }>('/v1/auth/verify', {
    method: 'POST',
    body: { token },
    anonymous: true,
  })
  storeToken(verified.session_token)
  return api<Me>('/v1/me')
}

/** 已经登录了吗（有 cookie 或存过的 bearer 就算）。 */
export const currentSession = (): Promise<Me> => api<Me>('/v1/me')

// ── 24 技能与学习回路（WP29）─────────────────────────────────────────

export interface SkillOverlayOpView {
  op: 'replace' | 'append' | 'remove'
  section_id: string
  heading?: string
  origin: 'authored' | 'learned'
  body?: string
  learned_from?: { lessons: string[]; at: string }
}

export interface SkillOverlayView {
  tier: 'company' | 'department' | 'personal'
  owner: string
  version: number
  base_version: string
  ops: SkillOverlayOpView[]
}

export interface SkillSummary {
  name: string
  tier: string
  version: string
  excluded: boolean
  sections: { id: string; heading: string; origin: 'authored' | 'learned' }[]
  overlays: SkillOverlayView[]
  pending_proposals: number
}

export interface SkillProposalSummary {
  approval_item_id: string
  skill: string
  section_id: string
  heading: string
  title: string
  summary: string
  hits: number
  confidence: number
  options: { id: string; label: string }[]
  quotes: string[]
  diff: { before: string | null; after: string; summary: string }
}

export const getSkills = (): Promise<SkillSummary[]> => api<SkillSummary[]>('/v1/skills')

export const getSkillProposals = (): Promise<SkillProposalSummary[]> =>
  api<SkillProposalSummary[]>('/v1/skills/proposals')

/** 排除 / 取消排除（只影响本人，24 §2）。 */
export const setSkillExcluded = (
  name: string,
  excluded: boolean,
): Promise<{ name: string; excluded: boolean }> =>
  api(`/v1/skills/${encodeURIComponent(name)}/exclude`, { method: 'POST', body: { excluded } })

// ── WP40 数据后端（41 §2.4）────────────────────────────────────────────
//
// 纪律与连接面逐字相同：**凭据只经 `saveStorageBackend` / `testStorageBackend`
// 这两条路出门**，值从原生 `<form>` 的 FormData 里来，函数返回后就没人引用它了。
// 不写 localStorage、不进 query 缓存、不打 console。
// `getStorage` 回来的东西**永远不含凭据**，所以它可以进缓存。

export type StorageTier = 'local' | 'byo_cloud' | 'managed'

export interface StorageBackendView {
  kind: string
  display: string
  bytes?: number
  objects?: number
  encrypted?: boolean
}

export interface StorageView {
  tier: StorageTier
  database: StorageBackendView
  blobs: StorageBackendView
  last_backup_at?: string
  previous_backend_readonly_until?: string
  env: { name: string; value: string; secret: boolean }[]
  compose_url: string
}

export interface StorageTestResult {
  ok: boolean
  reason?: string
  detail?: string
}

export interface StorageMigrationView {
  id: string
  state: 'running' | 'done' | 'failed'
  step: 'export' | 'import' | 'switch' | 'retire' | 'finished'
  started_at: string
  finished_at?: string
  exported_records?: number
  exported_bytes?: number
  reason?: string
  previous_readonly_until?: string
}

/** 表单收上来的那一份；**只在一次调用里存在**。 */
export interface StorageBackendInput {
  database_url?: string
  blob_endpoint?: string
  blob_bucket?: string
  blob_region?: string
  blob_prefix?: string
  blob_access_key_id?: string
  blob_secret_access_key?: string
}

export const getStorage = (assignment?: string): Promise<StorageView> =>
  api<StorageView>('/v1/storage', withAssignment(assignment))

/** 测一下能不能用。**不落库、不切换。** */
export const testStorageBackend = (
  input: StorageBackendInput,
  assignment?: string,
): Promise<{ database?: StorageTestResult; blobs?: StorageTestResult }> =>
  api('/v1/storage/test', { method: 'POST', body: input, ...withAssignment(assignment) })

/** 唯一一条会带数据后端凭据出门的写请求。 */
export const saveStorageBackend = (
  input: StorageBackendInput,
  assignment?: string,
): Promise<{ saved_fields: string[] }> =>
  api('/v1/storage/backend', { method: 'POST', body: input, ...withAssignment(assignment) })

export const migrateStorage = (assignment?: string): Promise<StorageMigrationView> =>
  api('/v1/storage/migrate', {
    method: 'POST',
    body: { confirm: true },
    ...withAssignment(assignment),
  })

export const getStorageMigration = (
  id: string,
  assignment?: string,
): Promise<StorageMigrationView> =>
  api(`/v1/storage/migrations/${encodeURIComponent(id)}`, withAssignment(assignment))
// ── 41 §1 代理 Agent（profile 与公开级别 / 代答 / 日程与约时间 / 任务路由）────────

/** 41 §1.3 三档；`agenda_detail` 最高只到 `colleagues`。 */
export type DisclosureLevel = 'self' | 'colleagues' | 'workspace'

export type ProfileFieldName =
  | 'positions'
  | 'ranges'
  | 'in_progress'
  | 'availability'
  | 'agenda_detail'
  | 'skills'
  | 'contact'

/** 界面上按这个顺序排（与 41 §1.3 那张表同序）。 */
export const PROFILE_FIELDS: ProfileFieldName[] = [
  'positions',
  'ranges',
  'in_progress',
  'availability',
  'agenda_detail',
  'skills',
  'contact',
]

export interface ProfileSkill {
  name: string
  source: 'skill' | 'memory' | 'self'
  hidden?: boolean
}

export interface Availability {
  rules: { days: number[]; from: string; to: string }[]
  default_minutes: number
  max_meetings_per_day?: number
}

export interface ProfilePosition {
  position_id: string
  role_id: string
  role_name: string
  ranges: { kind: string; id: string }[]
}

export interface MyProfile {
  person_id: string
  name: string
  positions: ProfilePosition[]
  ranges: { kind: string; id: string }[]
  skills: ProfileSkill[]
  contact_policy: { prefer: 'secretary' | 'direct'; note?: string }
  availability: Availability
  disclosure: Record<ProfileFieldName, DisclosureLevel>
  updated_at: string
}

/** 别人那一份：藏起来的字段只留名字（界面照着它写「这个要问本人」）。 */
export interface VisibleProfile {
  person_id: string
  name: string
  relation: 'self' | 'colleague' | 'outsider'
  positions?: ProfilePosition[]
  ranges?: { kind: string; id: string }[]
  skills?: ProfileSkill[]
  availability?: Availability
  contact_policy?: { prefer: 'secretary' | 'direct'; note?: string }
  hidden_fields: ProfileFieldName[]
  disclosure?: Record<ProfileFieldName, DisclosureLevel>
}

export interface PersonCard {
  person_id: string
  name: string
  positions: { role_id: string; role_name: string }[]
  in_progress?: number
}

export interface SecretaryAnswer {
  answer: string
  kind: string
  fields: ProfileFieldName[]
  refused: boolean
  refer_to?: { role_id: string; role_name: string; person_id?: string }
  run_id: string
}

/** 「谁问过我」：正文只有本人看得到（41 §1.2）。 */
export interface AskedRecordView {
  id: string
  asked_by: string
  asked_by_label?: string
  at: string
  kind: string
  question: string
  answer: string
  fields: ProfileFieldName[]
  refused: boolean
}

export interface MeetSlot {
  start: string
  end: string
}

export interface MeetProposalView {
  id: string
  from: string
  from_label?: string
  to: string
  to_label?: string
  title: string
  duration_minutes: number
  candidates: MeetSlot[]
  state: 'proposed' | 'accepted' | 'declined' | 'expired'
  accepted?: MeetSlot
  alternatives: MeetSlot[]
  approval_item_id?: string
  meeting_id?: string
  decline_reason?: string
  created_at: string
  decided_at?: string
}

export interface AgendaCheckResult {
  ok: boolean
  conflicts: { id: string; title: string; start: string; end?: string }[]
  reasons: string[]
  alternatives: MeetSlot[]
}

export interface SecretaryRouteResult {
  kind: 'task' | 'question'
  role_id?: string
  role_name?: string
  position_id?: string
  owner?: string
  owner_label?: string
  confidence: number
  reason: string
  existing_tools: { id: string; title: string; kind: string; similarity: number }[]
  similar_in_progress: {
    id: string
    title: string
    owner: string
    owner_label?: string
    similarity: number
  }[]
  claim_item_id?: string
  todo_id?: string
  run_id: string
}

export interface MeetingBriefView {
  meeting_id: string
  title: string
  start: string
  end: string
  participants: string[]
  agenda: string[]
  matters: { id: string; title: string; summary: string; status: string }[]
  open_items: { title: string; owner: string; owner_label?: string }[]
}

export const getMyProfile = (): Promise<MyProfile> => api<MyProfile>('/v1/me/profile')

export const updateMyProfile = (patch: {
  skills?: ProfileSkill[]
  contact_policy?: { prefer?: 'secretary' | 'direct'; note?: string }
  availability?: Partial<Availability>
  disclosure?: Partial<Record<ProfileFieldName, DisclosureLevel>>
}): Promise<MyProfile> => api<MyProfile>('/v1/me/profile', { method: 'PUT', body: patch })

export const listPeople = (): Promise<PersonCard[]> => api<PersonCard[]>('/v1/people')

export const getPersonProfile = (id: string): Promise<VisibleProfile> =>
  api<VisibleProfile>(`/v1/people/${encodeURIComponent(id)}/profile`)

/** 问他的代理（只答公开级别内的四类问题）。 */
export const askSecretary = (id: string, question: string): Promise<SecretaryAnswer> =>
  api<SecretaryAnswer>(`/v1/people/${encodeURIComponent(id)}/ask`, {
    method: 'POST',
    body: { question },
  })

export const listAskedMe = (limit = 30): Promise<AskedRecordView[]> =>
  api<AskedRecordView[]>(`/v1/me/secretary/asked?limit=${limit}`)

export const getMyAgenda = (from: string, to: string): Promise<CalendarItem[]> =>
  api<CalendarItem[]>(`/v1/me/agenda?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)

export const checkMyAgenda = (slot: MeetSlot): Promise<AgendaCheckResult> =>
  api<AgendaCheckResult>('/v1/me/agenda/check', { method: 'POST', body: slot })

export const proposeMeet = (
  id: string,
  input: { title: string; candidates: MeetSlot[]; duration?: number },
): Promise<MeetProposalView> =>
  api<MeetProposalView>(`/v1/people/${encodeURIComponent(id)}/meet`, {
    method: 'POST',
    body: input,
  })

export const listMyMeets = (): Promise<MeetProposalView[]> =>
  api<MeetProposalView[]>('/v1/me/meets')

export const decideMeet = (
  id: string,
  input: { action: 'accept'; slot?: MeetSlot } | { action: 'decline'; reason?: string },
): Promise<MeetProposalView> =>
  api<MeetProposalView>(`/v1/me/meets/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    body: input,
  })

/** 把一件事丢给代理：它判断该谁做，出一张认领卡（专业问题只转岗位，不出卡）。 */
export const routeToDesk = (text: string): Promise<SecretaryRouteResult> =>
  api<SecretaryRouteResult>('/v1/me/secretary/route', { method: 'POST', body: { text } })

export const getMeetingBrief = (id: string): Promise<MeetingBriefView> =>
  api<MeetingBriefView>(`/v1/meetings/${encodeURIComponent(id)}/brief`)
