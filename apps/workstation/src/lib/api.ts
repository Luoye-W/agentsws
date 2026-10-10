/**
 * `/v1` 客户端。
 *
 * 三条纪律：
 * - 工作台只经 `/v1`（28 §2 唯一入口），没有第二个后端。
 * - 每个请求带 `X-Assignment`（31 §3.1 一次请求一个 Assignment）；当前岗位就是它。
 * - 前端不引入任何模型 SDK：卡片按钮只打 decide（29 §5 动作不经模型）。
 */
import type {
  AllocationAuditList,
  AllocationLimitChanged,
  AllocationLimitRequest,
  ApprovalItem,
  BrandDesignDoc,
  BrandDesignRevision,
  BrandDesignRun,
  CalendarItem,
  CloudAllocationView,
  CloudMyAllocationView,
  DailyPlan,
  Goal,
  GoalProgress,
  MarketsSource,
  Matter,
  MatterEvent,
  MatterView,
  Meeting,
  MeetingOutputs,
  MeetingRecord,
  MeetingRecordSourceKind,
  MessageClaim,
  MessageDraft,
  MessageFolder,
  MessageFolderKind,
  MessageImagesReport,
  MessageKind,
  MessageLabel,
  MessageOverview,
  MessageRecord,
  MessageSendResult,
  MessageSuggest,
  MessageSyncReport,
  MessageThreadSummary,
  MessageWriteback,
  ReplySuggestion,
  Review,
  SenderRule,
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
import type { TailoredOntology } from '@agentsws/ontology/view'
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
): Promise<{ approval_item_id: string; applied?: boolean }> =>
  api<{ approval_item_id: string; applied?: boolean }>('/v1/catalog/merge', {
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
  /** WP96：看完即过的报表（日报 / 上线检查单）——它们不进队列，进面板的报表块 */
  reports: DeckCard[]
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
  today?: {
    timeline: CalendarItem[]
    /** WP248（决策 79）：`todos` 含已过期没做完的；`overdue_ids` 是其中已过期的那几条（老服务端没有） */
    due: { todos: Todo[]; cards_waiting: number; overdue_ids?: string[] }
  }
  report?: WorkBattleReport
  review?: Review
  plan?: DailyPlan
}

export interface PositionsData {
  positions: PositionSummary[]
  /**
   * WP69（54 §4）：按**岗位**聚合的那一份（首页岗位卡读它）。
   * 没装岗位面的服务进程没有这个字段——首页退回按职责列（老行为）。
   */
  instances?: PositionInstanceData[]
  tile_library: TileSpec[]
  max_tiles: number
}

export interface CardsData {
  position: PositionSummary
  cards: DeckCard[]
  filters: DeckFilters
  counts: DeckCounts
  pinned_p0: DeckCard[]
  /** WP141：看完即过的报表（日报 / 上线检查单）——不进牌堆，岗位页上单独一块 */
  reports?: DeckCard[]
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
 * 忘掉当前岗位（52 O2 切品牌时用）。
 *
 * 岗位就是一条 Assignment，而 Assignment 是**品牌级**的：换一个品牌之后那个 id
 * 一定不成立（网关会 403）。切换之后整站要重载，重载时左栏会按新品牌重新选一条。
 */
export function clearAssignment(): void {
  currentAssignment = null
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

export const getPositionCards = (
  id: string,
  filters?: DeckFilters,
  /** WP278（决策 284）：再收发给本人、挂在底座职责上的卡（只有一个岗位的人）。 */
  base = false,
): Promise<CardsData> =>
  api<CardsData>(
    `/v1/positions/${encodeURIComponent(id)}/cards?_=1${filterQuery(filters)}${base ? '&base=1' : ''}`,
    { assignment: id },
  )

export const getPositionView = (id: string, range: RangeName): Promise<ViewData> =>
  api<ViewData>(`/v1/positions/${encodeURIComponent(id)}/view?range=${range}`, { assignment: id })

export const getPositionRecords = (id: string): Promise<RecordsData> =>
  api<RecordsData>(`/v1/positions/${encodeURIComponent(id)}/records`, { assignment: id })

/* ── WP69（54）：岗位是任务主入口 ─────────────────────────────────────── */

/**
 * WP84：职责自带的一条快捷提示（首页岗位卡上那个按钮）。
 * 点一下 = 用这条职责在这个岗位下开一件事，**不是**往聊天框里塞一句话（36 §3）。
 */
export interface RoleQuickPromptData {
  id: string
  label: { zh: string; en: string }
  prompt: string
  kind: 'start_task' | 'ask' | 'review'
}

/** WP84：职责自带的一条示例任务（指导抽屉顶部）。 */
export interface RoleTaskExampleData {
  id: string
  title: { zh: string; en: string }
  description: string
  expected_output: string
}

/** 54 §1 岗位实体：谁在做、展开了哪几条职责、下面有多少事项与待审卡。 */
export interface PositionInstanceData {
  position_id: string
  workspace_id: string
  name: { zh: string; en: string }
  template_version: string
  holders: string[]
  roles: {
    role_id: string
    role_name: string
    default: boolean
    assignment_ids: string[]
    /** 本人在这条职责上的那一条分配；没有 = 他不做这条活儿（界面上的入口只能用它） */
    my_assignment_id?: string
    /** WP84：这条职责的快捷提示（首页岗位卡按职责折叠着显示）。 */
    quick_prompts?: RoleQuickPromptData[]
    /** WP84：这条职责的示例任务（指导抽屉顶部的选择题）。 */
    task_examples?: RoleTaskExampleData[]
    /** WP171：第二批的职责（`status: planned`），标「第二批」。 */
    planned?: true
  }[]
  open_matters: number
  pending_cards: number
  memory_summary: string
  /** WP213（docs/36 §8.3）：岗位图标（`role-icons/glyphs.ts` 的 id）；负责人 / 自建岗位没有。 */
  icon?: string
}

export interface RouteCandidateData {
  role_id: string
  role_name: string
  score: number
  why: string[]
}

/** WP291：当场回答（岗位页输入框下面那一块）。 */
export interface PositionAnswerData {
  outcome: 'answered' | 'failed' | 'stopped' | 'promoted'
  text: string
  /** 一句话；老服务端没有这一格（那时用 `text`） */
  lead?: string
  /** 组件（契约 `AnswerComponent`）；老服务端没有这一格 */
  components?: import('@agentsws/contracts').AnswerComponent[]
  /** 依据：这次读了哪些东西（人话） */
  sources: string[]
  failure?: string
}

export interface OpenAtPositionData {
  /**
   * WP287 / WP291：`quick` 当场答了（回答在 `answer`）；`ask` 一段会话、`task` 一件任务（都进线程）。
   * 老服务端没有这一格
   */
  mode?: 'quick' | 'ask' | 'task'
  entry?: { kind: 'quick' | 'chat' | 'task'; by: 'model' | 'rules' | 'caller' }
  answer?: PositionAnswerData
  matter: { id: string; title: string; entry?: string; role_id?: string; ask?: boolean }
  picked?: { role_id: string; role_name: string; assignment_id: string }
  candidates: RouteCandidateData[]
  ambiguous: boolean
  reason: string
  approval_item_id?: string
  run_id?: string
}

/** 岗位实体。`id` 是岗位模板 id，也收本人持有的一条分配 id（服务端换算）。 */
export const getPosition = (id: string): Promise<PositionInstanceData> =>
  api<PositionInstanceData>(`/v1/positions/${encodeURIComponent(id)}`, { assignment: id })

/**
 * WP241（docs/54 §7）：岗位页「工作」——本岗位的事项 + 本人的待办 + 定时 + 排期合成一份。
 * `id` 同 `getPosition`：岗位模板 id 或本人持有的一条分配 id。
 */
export type PositionWorkData = import('@agentsws/contracts').PositionWorkView
export type PositionWorkItemData = import('@agentsws/contracts').PositionWorkItem

export const getPositionWork = (id: string): Promise<PositionWorkData> =>
  api<PositionWorkData>(`/v1/positions/${encodeURIComponent(id)}/work`, { assignment: id })

/**
 * WP241：岗位页「加一个待办」——挂在本人这条职责的分配上（服务端从 `X-Assignment` 取）。
 * 与 `createTodo` 同一条路由，只是请求头换成那条分配。
 */
export const createTodoAt = (
  assignment: string,
  input: { title: string; due?: string },
): Promise<{ todo: Todo }> => api('/v1/todos', { method: 'POST', body: input, assignment })

/** WP241：看板上拖一张待办 = 改它的状态（`PUT /v1/todos/:id`，待办本来就由人改）。 */
export const setTodoStatus = (
  id: string,
  status: 'open' | 'doing' | 'blocked' | 'done',
): Promise<{ todo: Todo }> =>
  api(`/v1/todos/${encodeURIComponent(id)}`, { method: 'PUT', body: { status } })

/**
 * 54 §2 主入口：交给这个岗位一件事（一句话 → 事项）。
 *
 * WP84：从快捷提示点进来时带 `role_id`——那句话本来就写在那条职责的 yml 里，
 * 再让岗位内路由猜一遍只会猜错。入口还是岗位入口（事项照样 `entry: 'position'`）。
 */
export const openMatterAtPosition = (
  id: string,
  input: { title: string; summary?: string; role_id?: string; mode?: 'quick' | 'chat' | 'task' },
): Promise<OpenAtPositionData> =>
  api<OpenAtPositionData>(`/v1/positions/${encodeURIComponent(id)}/matters`, {
    method: 'POST',
    // WP287：不等运行跑完——拿到事项 id 立刻进会话线程，回答在线程里出现
    body: { ...input, detach: true },
    assignment: id,
  })

/**
 * 54 §2：换一条职责来做这件事（换后新的 Run 走新职责，旧 Run 不动）。
 * WP237：`run: true` = 换完立刻按原话起一次运行（「走 X」「换成 X」按钮）。
 */
export const rerouteMatter = (
  matter_id: string,
  role_id: string,
  options: { run?: boolean } = {},
): Promise<{ matter: { id: string; role_id?: string }; assignment_id: string; run_id?: string }> =>
  api(`/v1/matters/${encodeURIComponent(matter_id)}/reroute`, {
    method: 'POST',
    body: options.run === true ? { role_id, run: true } : { role_id },
  })

/**
 * WP237：按岗位模板 id 取岗位实体（还没定职责的事项只有模板 id，没有分配可以当请求头）。
 * 请求头用当前那条分配；服务端照样只回本人名下的那几条。
 */
export const getPositionByTemplate = (id: string): Promise<PositionInstanceData> =>
  api<PositionInstanceData>(`/v1/positions/${encodeURIComponent(id)}`)

/** 54 §3 / WP71：某一层的记忆（第三栏「记忆」面板读的就是它）。 */
export interface MemoryEntryData {
  /** WP71：改 / 删这一条用的地址（服务端给，前端不拼）。老服务进程不回它 → 只读。 */
  id?: string
  skill: string
  section_id: string
  heading?: string
  body: string
  origin: 'authored' | 'learned'
  learned_from?: { lessons: string[]; at: string }
  /** WP71：手动加的，还是从事项 / 复盘提升上来的。 */
  source?: 'manual' | 'promoted'
  added_by?: string
  added_at?: string
}

export interface LayerMemoryData {
  tier: string
  scope_id?: string
  summary: string
  entries: MemoryEntryData[]
  /** WP71：本人能不能手改这一层。**判据在服务端**，界面照它出按钮。 */
  can_edit?: boolean
}

export const getLayerMemory = (tier: string, scope_id?: string): Promise<LayerMemoryData> =>
  api<LayerMemoryData>(
    `/v1/memory?tier=${encodeURIComponent(tier)}${
      scope_id === undefined ? '' : `&scope_id=${encodeURIComponent(scope_id)}`
    }`,
  )

/** WP71（36 §10）：手动往本层加一条记忆（越层服务端 403）。 */
export const addMemoryEntry = (input: {
  tier: string
  scope_id?: string
  text: string
  heading?: string
}): Promise<MemoryEntryData> =>
  api<MemoryEntryData>('/v1/memory', {
    method: 'POST',
    body: {
      tier: input.tier,
      ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
      text: input.text,
      ...(input.heading === undefined ? {} : { heading: input.heading }),
    },
  })

/** WP71：改本层的一条。 */
export const updateMemoryEntry = (
  id: string,
  input: { text: string; heading?: string },
): Promise<MemoryEntryData> =>
  api<MemoryEntryData>(`/v1/memory/${encodeURIComponent(id)}`, { method: 'PATCH', body: input })

/** WP71：删本层的一条。 */
export const deleteMemoryEntry = (id: string): Promise<{ id: string; deleted: boolean }> =>
  api(`/v1/memory/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** 54 §3「提到这一层」：走提议 → 批准，不自动写。 */
export const promoteSkillTo = (input: {
  skill: string
  section_ids: string[]
  to_tier: 'company' | 'department' | 'position' | 'role'
  scope_id?: string
}): Promise<{
  accepted: boolean
  approval_item_id?: string
  reason?: string
  /** WP275：① ② 里自己提的当场生效了 */
  applied?: boolean
}> =>
  api(`/v1/skills/${encodeURIComponent(input.skill)}/promote`, {
    method: 'POST',
    body: {
      section_ids: input.section_ids,
      to_tier: input.to_tier,
      ...(input.scope_id === undefined ? {} : { scope_id: input.scope_id }),
    },
  })

/** 25 定时任务（列表只读 + 暂停 / 恢复）。 */
export interface ScheduledTaskRow {
  id: string
  title?: string
  handler?: string
  trigger: {
    kind: string
    expr?: string
    tz?: string
    at?: string
    every_ms?: number
    rule?: Record<string, unknown>
  }
  state: string
  fire_count: number
  next_fire_at?: string
  last_fire_at?: string
  last_result?: string
  /** WP181：谁建的（`agent` = 模型用官方「自动化任务」工具建的） */
  created_by?: 'user' | 'agent'
  /** WP181：从哪件事建的（事项 id） */
  origin?: { conversation_id?: string }
  /** WP208：挂在哪条分配 / 哪条职责上（服务端一直在回，界面现在才用：右栏徽标按它数） */
  assignment_id?: string
  role_id?: string
  /** WP181：官方记录（`official`）、等不等批（`awaiting_approval`） */
  params?: Record<string, unknown>
}

/** WP181：官方「自动化任务」建的那几条到点交给谁（与服务端 `AUTOMATION_HANDLER` 同名）。 */
export const AUTOMATION_HANDLER = 'automation.reminder'

/** WP181：本人全部的定时任务（右栏面板；跨岗位）。 */
export const getMySchedules = (): Promise<ScheduledTaskRow[]> =>
  api<ScheduledTaskRow[]>('/v1/schedules?scope=mine')

/** WP181：按官方的时间写法改时间（`daily` / `weekly` / `at` 恰好一个；校验在服务端官方那一层）。 */
export const patchScheduleRule = (
  id: string,
  rule: Record<string, unknown>,
): Promise<ScheduledTaskRow> =>
  api<ScheduledTaskRow>(`/v1/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { rule },
  })

/** WP181：暂停 / 恢复（不指定岗位：用当前那一条，服务端按「是不是本人的」判）。 */
export const toggleSchedule = (id: string, action: 'pause' | 'resume'): Promise<ScheduledTaskRow> =>
  api<ScheduledTaskRow>(`/v1/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: { action },
  })

/** WP181：删掉（不再触发；记录留着）。 */
export const deleteSchedule = (id: string): Promise<ScheduledTaskRow> =>
  api<ScheduledTaskRow>(`/v1/schedules/${encodeURIComponent(id)}`, { method: 'DELETE' })

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
  /** 回声：这一份是按哪几个图层给的（没传 `sources` 时没有这一格） */
  sources?: string[]
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

/**
 * WP69（54 §2）**职责入口**：指定用这条职责的规矩做，跳过岗位内路由。
 * `assignment` 就是那条职责的分配——权限、额度、动作面全是它的。
 *
 * WP259：`run: true` = 开完立刻用这条职责起首轮运行（任务文本 = 完整原文）；
 * 长文本先用 `handoffInput` 拆成标题 + 描述再交。
 */
export const createMatterWithRole = (
  assignment: string,
  input: { title: string; summary?: string; run?: boolean },
): Promise<{ matter: Matter; run_id?: string }> =>
  api(`/v1/matters`, {
    method: 'POST',
    body: { kind: 'adhoc', ...input },
    assignment,
  })

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

/** WP264（决策 177）：人在事项页上就地改标题（之后不再被 AI 起的短标题覆盖）。 */
export const retitleMatter = (id: string, title: string): Promise<{ matter: Matter }> =>
  api(`/v1/matters/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title } })

/** WP264：停下这件事上正在跑的运行（输入卡上的「停」）。 */
export const stopMatterRuns = (id: string): Promise<{ stopped: number }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/stop`, { method: 'POST' })

/** WP287：上一次没跑成 → 按原话再跑一次（「没跑成」下面的「重试」）。 */
export const retryMatterRun = (id: string): Promise<{ run_id?: string }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/retry`, { method: 'POST' })

/** WP287：岗位里问的一句（会话）转成任务——进岗位「工作」。 */
export const promoteAskMatter = (
  id: string,
  options: { run?: boolean } = {},
): Promise<{ matter: { id: string; title: string }; run_id?: string }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/promote`, {
    method: 'POST',
    // WP291：「当成任务做」= 转完按原话当任务再跑一次
    ...(options.run === true ? { body: { run: true } } : {}),
  })

/** WP291：当场回答下面「接着聊」——这一问一答变成一段会话（进左栏会话历史）。 */
export const continueQuickAnswer = (id: string): Promise<{ matter: { id: string } }> =>
  api(`/v1/matters/${encodeURIComponent(id)}/continue`, { method: 'POST' })

/** WP291：本人在这个岗位上的当场问答（岗位「记录」里列）。 */
export interface PositionAnswerRecordData {
  matter_id: string
  at: string
  question: string
  lead: string
}

export const getPositionAnswers = (id: string): Promise<{ answers: PositionAnswerRecordData[] }> =>
  api(`/v1/positions/${encodeURIComponent(id)}/answers`, { assignment: id })

/** WP264：时间线上内嵌的那张卡（审批 / 选择）——按事项那条分配取，决定也用它。 */
export const getApproval = (id: string, assignment?: string): Promise<ApprovalItem> =>
  api<ApprovalItem>(
    `/v1/approvals/${encodeURIComponent(id)}`,
    assignment === undefined ? {} : { assignment },
  )

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
  /** WP276：交给我的那个人的名字（服务端补；不印 id） */
  offered_by_label?: string
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

/**
 * 日历（WP74：一个日历，多图层）。
 *
 * `sources` 是逗号分隔的图层名，**不传 = 全部**——日历那一页要全部，因为图层开关
 * 旁边那个数字得把关掉的层也数出来。
 */
export const getCalendar = (from: string, to: string, sources?: string): Promise<CalendarData> =>
  api<CalendarData>(
    `/v1/calendar?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` +
      (sources === undefined || sources === '' ? '' : `&sources=${encodeURIComponent(sources)}`),
  )

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
  /** WP278：② 里这条是不是你接的（只有接的人能标「个人 / 共用」）。 */
  mine?: boolean
  status: 'active' | 'reauth_required' | 'disabled'
  identity?: { account_id?: string; display_name?: string }
  credential_store: 'openconnector' | 'local_vault'
  data_sources: string[]
  last_tested_at?: string
  last_test?: ConnectTestResult
  /** WP44：用已经下线的老办法接的（Shopify 的 shpat_ 直填令牌）。 */
  legacy?: { kind: 'shopify_access_token'; hint: string }
  /**
   * WP252：以前和本机另一个品牌共用过同一个连接名。`reconnect` = 本品牌这一行只是提醒（要重新连接，
   * 「收起」不碰别的品牌那条）；`kept` = 留在本品牌的那条，点一次「测试」核对账号。
   */
  brand_conflict?: { kind: 'reconnect' | 'kept'; hint: string }
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
  /** WP63：还没做、只是登记在目录里的那几张（灰着、点不动）。WP157 起工作台读它。 */
  planned?: boolean
  /** WP25：两种以上接法时给出来，第一条是推荐的那条。 */
  auth_options?: ProviderAuthOption[]
  /** WP111：这张卡要本机连接器。 */
  requires_runtime?: boolean
  /** WP247：本机连接器还没下载 / 没起来，但能按需下载——点了先弹「要先下载连接器」。 */
  needs_download?: boolean
}

/** WP247：连接器下载那件事走到哪了。 */
export interface LocalConnectorJobView {
  phase: 'preparing' | 'downloading' | 'verifying' | 'done' | 'failed' | 'cancelled'
  version: string
  started_at: string
  finished_at?: string
  fetched: number
  total: number
  error?: {
    code: 'network' | 'timeout' | 'disk_full' | 'permission' | 'integrity' | 'busy' | 'failed'
    detail?: string
  }
  /** WP254：这次下载用的哪个源（不是国内源且网络失败 → 多一个「换国内源再试」）。 */
  registry?: 'official' | 'npmmirror' | 'custom'
}

/** WP247：本机连接器（按需下载、桌面壳起停）的样子。 */
export interface LocalConnectorView {
  status: 'not_installed' | 'downloading' | 'starting' | 'ready' | 'error' | 'stopped'
  version: string
  download_bytes: number
  installed?: string
  previous?: string
  update_available: boolean
  desired: 'run' | 'stop'
  job?: LocalConnectorJobView
  supervisor?: {
    state: 'stopped' | 'starting' | 'running' | 'backoff' | 'failed'
    version?: string
    port: number
    pid?: number
    attempts: number
    started_at?: string
    last_exit?: { code: number | null; signal: string | null; at: string }
    retry_in_ms?: number
    last_error?: string
    updated_at: string
  }
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
  /** WP247：本机连接器归工作台管时才有（桌面版）。 */
  local?: LocalConnectorView
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

/** WP247：本机连接器的五个动作（只给人点；每个都回最新状态）。 */
export type LocalConnectorAction = 'install' | 'cancel' | 'restart' | 'rollback' | 'remove'

export const localConnectorAction = (
  action: LocalConnectorAction,
  assignment?: string,
): Promise<RuntimeStatusView> =>
  api<RuntimeStatusView>(
    action === 'remove'
      ? '/v1/connections/runtime/local'
      : `/v1/connections/runtime/local/${action}`,
    { method: action === 'remove' ? 'DELETE' : 'POST', ...withAssignment(assignment) },
  )

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

// ── WP83（54（将改号 55）§4）：连接目录与岗位连接清单 ──────────────────
//
// 与上面那一组的分工：上面按 **provider** 问"这张卡怎么填"，这一组按职责模板的
// **kind** 问"有哪些东西可以接、这个岗位要接哪几个"。目录里只有字段**描述**，
// 没有任何值，也没有任何一条真实连接的账号 id。

export type ConnectionRuntimeState = 'connected' | 'not_connected' | 'error'

export interface ConnectionFieldSpec {
  name: string
  label: { zh: string; en: string }
  secret: boolean
  required: boolean
  kind?: 'text' | 'password' | 'email' | 'number' | 'url' | 'select' | 'headers'
  placeholder?: string
  options?: string[]
  hint?: { zh: string; en: string }
}

export interface ConnectionDirectoryItem {
  kind: string
  name: { zh: string; en: string }
  category: string
  auth: 'oauth' | 'api_key' | 'client_credentials' | 'qr' | 'password' | 'none'
  mode: 'openconnector_provider' | 'mcp_server' | 'channel_adapter' | 'browser' | 'builtin'
  fields: ConnectionFieldSpec[]
  side_effect: 'read_external' | 'write_external' | 'local'
  docs_url?: string
  status: 'available' | 'planned'
  service?: string
  aliases?: string[]
  resolved_by_profile?: boolean
  note?: { zh: string; en: string }
  state: ConnectionRuntimeState
  state_detail?: string
  connect_service?: string
}

export interface PositionConnectionItem {
  kind: string
  name: { zh: string; en: string }
  required: boolean
  /** WP154：推荐连（没连有一块看不到）。 */
  recommended?: boolean
  connected: boolean
  needed_by: string[]
  status: 'available' | 'planned'
  connect_service?: string
  note?: { zh: string; en: string }
}

export interface PositionConnectionsView {
  position_id: string
  position_name: string
  ready: boolean
  missing_required: string[]
  items: PositionConnectionItem[]
}

export interface McpServerRecord {
  name: string
  transport: 'stdio' | 'streamable-http'
  command?: string
  args?: string[]
  url?: string
  /** 只有请求头的**名字**；值在本机加密库里，永远不经这条路。 */
  header_names: string[]
  /** WP86：勾成"只是看、不动东西"的那几个工具（原始名，不带 `mcp__…__` 前缀）。 */
  read_tools?: string[]
  probe?: {
    ok: boolean
    at: string
    tools: { name: string; description?: string }[]
    reason?: string
    detail?: string
  }
  created_at: string
  updated_at: string
}

export const getConnectionDirectory = (
  assignment?: string,
): Promise<{ entries: ConnectionDirectoryItem[] }> =>
  api<{ entries: ConnectionDirectoryItem[] }>(
    '/v1/connection-directory',
    withAssignment(assignment),
  )

export const getPositionConnections = (
  id: string,
  assignment?: string,
): Promise<PositionConnectionsView> =>
  api<PositionConnectionsView>(
    `/v1/positions/${encodeURIComponent(id)}/connections`,
    withAssignment(assignment),
  )

export const listMcpServers = (assignment?: string): Promise<{ servers: McpServerRecord[] }> =>
  api<{ servers: McpServerRecord[] }>(
    '/v1/connection-directory/mcp-servers',
    withAssignment(assignment),
  )

/**
 * 登记一台自定义 MCP 服务器。
 *
 * `headers` 的值是凭据（多半是一枚 Bearer token）：与 `submitConnection` 同一条纪律——
 * 从原生 `<form>` 的 FormData 里来，在这里组装一次、发出去，函数返回后没人引用它。
 * 不写 localStorage、不进 query 缓存、不打 console。
 */
export const saveMcpServer = (
  input: {
    name: string
    transport: 'stdio' | 'streamable-http'
    command?: string
    args?: string[]
    url?: string
    headers?: Record<string, string>
    /**
     * WP86：这台服务器上哪几个工具是只读的（原始工具名）。
     *
     * **不传 ≠ 清空**：服务端按"没说就沿用上一次勾过的那份"处理，`headers` 同理
     * ——只改只读清单的那一次提交因此不必把 token 再发一遍。
     */
    read_tools?: string[]
  },
  assignment?: string,
): Promise<McpServerRecord> =>
  api<McpServerRecord>('/v1/connection-directory/mcp-servers', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const probeMcpServer = (name: string, assignment?: string): Promise<McpServerRecord> =>
  api<McpServerRecord>(`/v1/connection-directory/mcp-servers/${encodeURIComponent(name)}/probe`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const removeMcpServer = (name: string, assignment?: string): Promise<{ removed: boolean }> =>
  api<{ removed: boolean }>(`/v1/connection-directory/mcp-servers/${encodeURIComponent(name)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

/** WP55 / 18 §2.2：进了死信的入站消息。正文不在这里——只有"是谁 / 何时 / 为什么"。 */
export interface DeadLetterView {
  id: string
  channel: string
  from?: string
  subject?: string
  reason: string
  attempts: number
  last_error?: string
  at: string
  /** WP210：是不是客户来信（系统 / 营销通知不算）。老服务端不给。 */
  customer?: boolean
  /** WP210：系统自动重投到哪一步（`next_at` 下次再试；`gave_up` 不再自动投）。老服务端不给。 */
  auto_retry?: { rounds: number; gave_up: boolean; next_at?: string }
}

export const listDeadLetters = (assignment?: string): Promise<{ dead_letters: DeadLetterView[] }> =>
  api<{ dead_letters: DeadLetterView[] }>('/v1/channels/dead-letters', withAssignment(assignment))

/** WP55：重投一条死信（WP210 起平时系统自己按退避投，这个只在诊断页按）。 */
export const requeueDeadLetter = (
  id: string,
  assignment?: string,
): Promise<{ requeued: boolean }> =>
  api<{ requeued: boolean }>(`/v1/channels/dead-letters/${encodeURIComponent(id)}/requeue`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

/** WP167：邮箱卡上的开关（`takeover` 只读 = 客服岗位开着）。 */
export interface MailboxSwitchesView {
  connection_id: string
  shadow_mode: boolean
  move: boolean
  mark_read: boolean
  takeover: boolean
  /** WP172：这只邮箱收 B2B 信（缺省开）。 */
  b2b?: boolean
  /** WP172：B2B 岗位开着（只读；没开时卡上不画「收 B2B 信」）。 */
  b2b_position?: boolean
}

export type MailboxSwitchName = 'shadow_mode' | 'move' | 'mark_read' | 'b2b'

export const getMailboxSwitches = (id: string, assignment?: string): Promise<MailboxSwitchesView> =>
  api<MailboxSwitchesView>(
    `/v1/connections/${encodeURIComponent(id)}/mailbox-switches`,
    withAssignment(assignment),
  )

/** WP167：改一个开关——立刻生效，服务端写一条事件。 */
export const setMailboxSwitches = (
  id: string,
  input: Partial<Record<MailboxSwitchName, boolean>>,
  assignment?: string,
): Promise<MailboxSwitchesView> =>
  api<MailboxSwitchesView>(`/v1/connections/${encodeURIComponent(id)}/mailbox-switches`, {
    method: 'PUT',
    body: input,
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

// ── WP59（49 M2 / M5）：云上的余额与价目 + 每项能力"用我的 / 用 agentsws 的" ──
//
// 本地不记账：这几条全是云上那一份的透传（服务进程那边缓存 60 秒）。
// 工作台这一层更不该自己算——**一个数字都不算**，只画。

export type CapabilitySource = 'mine' | 'agentsws'

export interface WalletBalanceView {
  org_id: string
  purchased: number
  granted: number
  available: number
  reserved: number
  expiring: { credits: number; expires_at: string }[]
  low_balance_threshold: number
  low_balance: boolean
  at: string
}

export interface CloudCreditsView {
  linked: boolean
  reason?: string
  balance?: WalletBalanceView
  month_credits?: number
  fetched_at?: string
  /** 网页账号页（`${云地址}/account`，WP198b）；本机服务端按它的云地址填，没关联也有。 */
  account_url?: string
  /** WP289（决策 307）：充值按钮给不给；不给 = 能（老服务端）。 */
  can_topup?: boolean
  /** WP289：用量明细看不看得到；不给 = 能。 */
  can_view_usage?: boolean
}

export interface PricingModelEntry {
  model: string
  in: number
  out: number
  cached?: number
}

export interface PricingEntry {
  capability: string
  unit: string
  credits_per_unit: number
  label_zh: string
  label_en: string
  /** 付费三块（67 §1，WP118）。老的价目表没有这一格，界面按能力名前缀兜底。 */
  block?: 'data' | 'ai' | 'service'
  models?: PricingModelEntry[]
}

export interface PricingView {
  version: number
  as_of: string
  credit_cny: number
  ai_multiplier: number
  fx: Record<string, number>
  entries: PricingEntry[]
  /** WP165：这一份哪来的（云上 / 本机存的上一份 / 从没取到过）。 */
  source?: 'cloud' | 'cache' | 'unavailable'
  fetched_at?: string
  unavailable_reason?: string
}

export interface CapabilitySourceSettings {
  workspace_id: string
  capability_sources: Record<string, CapabilitySource>
  /** WP126：数据接口路由（键 kol.<渠道>，只含显式改过的渠道）。 */
  data_source_routing?: Record<string, DataSourceRoute>
  updated_at?: string
}

/* ── WP126：数据接口路由 + 自带数据接口 ─────────────────────────── */

export type DataSourceLevel =
  | 'official_key'
  | 'byo_source'
  | 'workshop'
  /** WP179：「用你的 DeepSeek 账号搜索」——只属于 `web.search` 这一项 */
  | 'deepseek_native'
  /** WP220：浏览器只读——只属于 Reddit 取数（`reddit.read`）那一项 */
  | 'browser_readonly'

export interface DataSourceRoute {
  order: DataSourceLevel[]
  disabled: DataSourceLevel[]
}

export interface KolByoSourceView {
  channel: string
  service_url: string
  format: 'byo/v1'
  has_key: boolean
  updated_at?: string
}

export const getKolByoSources = (assignment?: string): Promise<{ rows: KolByoSourceView[] }> =>
  api('/v1/kol/byo-sources', withAssignment(assignment))

export const setKolByoSource = (
  input: { channel: string; service_url: string; api_key?: string },
  assignment?: string,
): Promise<KolByoSourceView> =>
  api('/v1/kol/byo-sources', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const testKolByoSource = (
  input: { channel: string; service_url?: string; api_key?: string },
  assignment?: string,
): Promise<{ ok: boolean; message: string }> =>
  api('/v1/kol/byo-sources/test', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const clearKolByoSource = (
  channel: string,
  assignment?: string,
): Promise<{ cleared: boolean }> =>
  api(`/v1/kol/byo-sources/${channel}`, { method: 'DELETE', ...withAssignment(assignment) })

/* ── WP155（docs/81）：搜索数据接口（连接页「搜索数据」那一行）────────── */

export type SearchDataSettingsView = import('@agentsws/contracts').SearchDataSettingsView
export type SearchDataProvider = import('@agentsws/contracts').SearchDataProvider
export type SearchDataRouteChoice = import('@agentsws/contracts').SearchDataRouteChoice

export const getSearchDataSettings = (assignment?: string): Promise<SearchDataSettingsView> =>
  api('/v1/search-data', withAssignment(assignment))

export const setSearchDataChoice = (
  choice: SearchDataRouteChoice,
  assignment?: string,
): Promise<SearchDataSettingsView> =>
  api('/v1/search-data/choice', { method: 'PUT', body: { choice }, ...withAssignment(assignment) })

/** key 只在这一次调用里出现（原生表单的 FormData 取出来直接发），不进 state、不进缓存。 */
export const setSearchDataByo = (
  input: { provider: SearchDataProvider; api_key?: string },
  assignment?: string,
): Promise<SearchDataSettingsView> =>
  api('/v1/search-data/byo', { method: 'PUT', body: input, ...withAssignment(assignment) })

export const testSearchDataByo = (
  input: { provider?: SearchDataProvider; api_key?: string },
  assignment?: string,
): Promise<{ ok: boolean; message: string }> =>
  api('/v1/search-data/byo/test', { method: 'POST', body: input, ...withAssignment(assignment) })

export const clearSearchDataByo = (assignment?: string): Promise<{ cleared: boolean }> =>
  api('/v1/search-data/byo', { method: 'DELETE', ...withAssignment(assignment) })

export const getCloudCredits = (assignment?: string): Promise<CloudCreditsView> =>
  api('/v1/cloud/credits', withAssignment(assignment))

export const getCloudPricing = (assignment?: string): Promise<PricingView> =>
  api('/v1/cloud/pricing', withAssignment(assignment))

export interface UsageRowView {
  key: string
  credits: number
  quantity: number
  calls: number
}

export interface UsageReportView {
  group: 'capability' | 'workspace' | 'day'
  from: string
  to: string
  rows: UsageRowView[]
  total_credits: number
}

/** 没关联账号 / 云上连不通时回 `null`——界面据此显示一句话，不是一张空表。 */
export const getCloudUsage = (
  group: 'capability' | 'workspace' | 'day',
  assignment?: string,
): Promise<UsageReportView | null> =>
  api(`/v1/cloud/usage?group=${group}`, withAssignment(assignment))

/** 充值四档（67 §2）。 */
export interface TopupTierView {
  id: string
  usd: number
  credits: number
  label_zh: string
  label_en: string
  recommended?: boolean
}

export interface TopupTiersView {
  version: number
  as_of: string
  credits_per_usd: number
  tiers: TopupTierView[]
  /** WP165：同价目表（从没取到过时 `tiers` 是空的、带这一句）。 */
  source?: 'cloud' | 'cache' | 'unavailable'
  unavailable_reason?: string
}

export interface TopupOrderView {
  id: string
  credits: number
  amount_cny: number
  amount_usd?: number
  tier_id?: string
  checkout_url?: string
  status: string
}

export const getTopupTiers = (assignment?: string): Promise<TopupTiersView> =>
  api('/v1/cloud/topup/tiers', withAssignment(assignment))

/** 建一笔充值单，回一个去云上付款的链接。**本地不碰任何支付凭据**。 */
export const createTopup = (tier_id: string, assignment?: string): Promise<TopupOrderView> =>
  api('/v1/cloud/topup', {
    ...withAssignment(assignment),
    method: 'POST',
    body: { tier_id },
  })

/* ------------------------------------------------------------------ */
/* WP194：成员 / 岗位额度（公司共用余额上的每月上限）                     */
/* ------------------------------------------------------------------ */

/** 公司「积分」页：本月按人 / 按岗位 / 按能力（只有公司的 owner / admin 拿得到）。 */
export const getCloudAllocation = (
  assignment?: string,
  month?: string,
): Promise<CloudAllocationView> =>
  api(
    `/v1/cloud/allocation${month === undefined ? '' : `?month=${encodeURIComponent(month)}`}`,
    withAssignment(assignment),
  )

/** 设置 → 积分里的「我的本月额度」。 */
export const getMyCloudAllocation = (assignment?: string): Promise<CloudMyAllocationView> =>
  api('/v1/cloud/allocation/me', withAssignment(assignment))

/** 设 / 清一个成员或岗位的每月上限（`null` = 不限）。 */
export const setCloudAllocationLimit = (
  input: AllocationLimitRequest,
  assignment?: string,
): Promise<AllocationLimitChanged> =>
  api('/v1/cloud/allocation/limits', {
    ...withAssignment(assignment),
    method: 'POST',
    body: input,
  })

/** 最近的改额度记录（谁、从多少改到多少）。 */
export const getCloudAllocationAudit = (assignment?: string): Promise<AllocationAuditList> =>
  api('/v1/cloud/allocation/audit', withAssignment(assignment))

/* ------------------------------------------------------------------ */
/* 红人营销增值服务（67 §3，WP118）                                     */
/* ------------------------------------------------------------------ */

/** 订阅状态那五个态（`none` = 从来没开通过）。 */
export type KolServiceStatus = 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'

export interface KolServiceSubscriptionView {
  status: KolServiceStatus
  service_id: string
  current_cycle_end?: string
  grace_until?: string
  unpaid_since?: string
  granted_months: number
  cancel_at_period_end: boolean
  last_charge_at?: string
}

/** 一条同步冲突：两头都改过同一条，**双方版本都在**（输的那一份不删）。 */
export interface KolCloudConflictView {
  kind: string
  id: string
  at: string
  label: string
  source: 'cloud' | 'local'
  winner: { version: number; updated_at: string; writer: string; body?: Record<string, unknown> }
  loser: { version: number; updated_at: string; writer: string; body?: Record<string, unknown> }
}

export interface KolCloudStatusView {
  linked: boolean
  /** 没关联 / 云连不通时的那句人话。 */
  reason?: string
  cloud_reachable: boolean
  /** 本地攒着还没推上去的条数。 */
  pending: number
  object_count?: number
  by_kind?: { kind: string; count: number }[]
  cloud_conflicts?: number
  conflicts: KolCloudConflictView[]
  subscription?: KolServiceSubscriptionView
  last_sync_at?: string
  device_id: string
  at: string
}

export interface KolCloudSyncRunView {
  ok: boolean
  message?: string
  pushed: number
  pulled: number
  conflicts: number
  /** 云上有了、本地这一版还没有那张表的条数（报出来，不静默扔）。 */
  skipped: number
  pending: number
  last_sync_at?: string
  at: string
}

export interface KolCloudExportView {
  format: number
  org_id: string
  at: string
  objects: unknown[]
  conflicts: unknown[]
}

export interface KolCloudDeleteView {
  deleted: number
  subscription_kept: boolean
  at: string
}

export const getKolCloudStatus = (assignment?: string): Promise<KolCloudStatusView> =>
  api('/v1/cloud/kol/status', withAssignment(assignment))

/** 立即同步一趟。**失败也不是错**：回执里 `ok: false` + 一句人话。 */
export const syncKolCloud = (assignment?: string): Promise<KolCloudSyncRunView> =>
  api('/v1/cloud/kol/sync', { ...withAssignment(assignment), method: 'POST' })

export const subscribeKolCloud = (assignment?: string): Promise<KolServiceSubscriptionView> =>
  api('/v1/cloud/kol/subscription', { ...withAssignment(assignment), method: 'POST' })

export const cancelKolCloud = (assignment?: string): Promise<KolServiceSubscriptionView> =>
  api('/v1/cloud/kol/subscription', { ...withAssignment(assignment), method: 'DELETE' })

/** 一条冲突处理完了：`winner` 留当前值，`loser` 把被盖掉的那一份挑回来（两份都不删）。 */
export const resolveKolCloudConflict = (
  input: { kind: string; id: string; pick: 'winner' | 'loser' },
  assignment?: string,
): Promise<KolCloudSyncRunView> =>
  api('/v1/cloud/kol/conflicts/resolve', {
    ...withAssignment(assignment),
    method: 'POST',
    body: input,
  })

/** 导出云端这一份（**欠费也给导**——这时候拦着等于拿数据当人质）。 */
export const exportKolCloud = (assignment?: string): Promise<KolCloudExportView> =>
  api('/v1/cloud/kol/export', withAssignment(assignment))

/** 删掉云端这一份。**本地一条不动**、订阅也不动。 */
export const deleteKolCloud = (assignment?: string): Promise<KolCloudDeleteView> =>
  api('/v1/cloud/kol', { ...withAssignment(assignment), method: 'DELETE' })

export const getCapabilitySources = (assignment?: string): Promise<CapabilitySourceSettings> =>
  api('/v1/settings/capability-sources', withAssignment(assignment))

/** WP228：Reddit「浏览器只读」那一路（本机只读浏览器）现在能不能用。 */
export interface ReadonlyBrowserStatus {
  state: 'ready' | 'no_browser' | 'quota_used_up' | 'blocked'
  message?: string
  until?: string
  pages_last_day: number
  max_pages_per_day: number
  browser?: string
  /** WP228：托管实例——「浏览器只读」那一行整行不显示。 */
  hosted?: boolean
}

export const getRedditBrowserReadStatus = (assignment?: string): Promise<ReadonlyBrowserStatus> =>
  api('/v1/settings/reddit-browser-read/status', withAssignment(assignment))

/* ── WP246（决策 87 / 88）：取数路线「首选 → 备选 + 体检」、Reddit 读号 ── */

export type ReadLevel =
  | 'workshop'
  | 'browser_readonly'
  | 'page_captions'
  | 'local_extract'
  | 'third_party_reader'

export interface ReadLevelCheck {
  level: ReadLevel
  state: 'ok' | 'down' | 'off' | 'pending'
  reason: string
  fix?: string
  action?:
    | 'link_account'
    | 'login_read_account'
    | 'install_browser'
    | 'enable_level'
    | 'check_network'
    | 'wait'
  detail?: string
  last?: { ok: boolean; at: string; message?: string }
}

export interface ReadRouteHealth {
  platform: string
  route_key: string
  tool: string
  levels: ReadLevelCheck[]
  active?: ReadLevel
}

export interface RedditReadAccountStatus {
  state: 'none' | 'logging_in' | 'logged_in' | 'refused' | 'unknown'
  username?: string
  message?: string
  checked_at?: string
}

export interface ReadRoutesSettings {
  web_third_party_reader: boolean
  reddit_browser_window: 'minimized' | 'headless'
}

export interface ReadRoutesView {
  doctor: { routes: ReadRouteHealth[]; checked_at: string; deep: boolean }
  settings: ReadRoutesSettings
  reddit_account?: RedditReadAccountStatus
}

/** 快查（不连网）：每个平台现在走哪一级、哪级断了。 */
export const getReadRoutes = (assignment?: string): Promise<ReadRoutesView> =>
  api('/v1/settings/read-routes', withAssignment(assignment))

/** 重新体检（真去连一下）。 */
export const runReadRoutesDoctor = (assignment?: string): Promise<ReadRoutesView> =>
  api('/v1/settings/read-routes/doctor', { ...withAssignment(assignment), method: 'POST' })

export const setReadRoutesSettings = (
  patch: Partial<ReadRoutesSettings>,
  assignment?: string,
): Promise<ReadRoutesView> =>
  api('/v1/settings/read-routes', { ...withAssignment(assignment), method: 'PUT', body: patch })

/** 打开「登录读号」窗口（用户自己在网页上登录；关掉后服务端自动体检）。 */
export const openRedditReadAccountLogin = (assignment?: string): Promise<RedditReadAccountStatus> =>
  api('/v1/settings/reddit-read-account/login', { ...withAssignment(assignment), method: 'POST' })

/** 整张表一次给全——两个标签页各改一项就不会互相覆盖。路由表（WP126）一并对齐。 */
export const setCapabilitySources = (
  capability_sources: Record<string, CapabilitySource>,
  assignment?: string,
  data_source_routing?: Record<string, DataSourceRoute>,
): Promise<CapabilitySourceSettings> =>
  api('/v1/settings/capability-sources', {
    method: 'PUT',
    body: {
      capability_sources,
      ...(data_source_routing === undefined ? {} : { data_source_routing }),
    },
    ...withAssignment(assignment),
  })

// ── WP82：浏览器（55 §3 末段）────────────────────────────────────────────
//
// 这条路上**没有任何凭据**：CDP 地址不是密码，登录态在用户自己的 Chrome 里。
// 探测是 `GET` 且不带参数时自动试常见端口——界面上那个"自动找一下"按钮。

/** 这台机器上的浏览器怎么配（`GET`/`PUT /v1/settings/browser` 的形状）。 */
export interface BrowserSettings {
  /** WP92：`browserskill` = 用你正在用的那个浏览器（腾讯 BrowserSkill，55 §10）。 */
  mode: 'off' | 'attach' | 'launch' | 'browserskill'
  endpoint?: string
  executable_path?: string
  headless?: boolean
  /** WP92：`bsk` 的路径；不给就用我们自己装的那一份。 */
  bsk_path?: string
}

export interface BrowserSettingsView extends BrowserSettings {
  /** 只有个人档（服务跑在你自己电脑上）才允许接你的 Chrome。 */
  attach_allowed: boolean
  attach_blocked_reason?: string
  /** WP92：同一条理由——bsk 与浏览器扩展都在你那台电脑上。 */
  browserskill_allowed: boolean
  browserskill_blocked_reason?: string
}

export interface BrowserProbeResult {
  ok: boolean
  endpoint: string
  browser?: string
  detail?: string
}

export const getBrowserSettings = (assignment?: string): Promise<BrowserSettingsView> =>
  api('/v1/settings/browser', withAssignment(assignment))

export const setBrowserSettings = (
  input: BrowserSettings,
  assignment?: string,
): Promise<BrowserSettingsView> =>
  api('/v1/settings/browser', { method: 'PUT', body: input, ...withAssignment(assignment) })

/** 不给 endpoint = 自动探测 127.0.0.1 上的常见端口。 */
export const probeBrowser = (endpoint?: string, assignment?: string): Promise<BrowserProbeResult> =>
  api(
    endpoint === undefined || endpoint === ''
      ? '/v1/settings/browser/probe'
      : `/v1/settings/browser/probe?endpoint=${encodeURIComponent(endpoint)}`,
    withAssignment(assignment),
  )

// ── WP25 交付 C：模型 ───────────────────────────────────────────────────
//
// 同一条纪律：**API key 只经 `saveModelProvider` 这一条路出去**，原生 `<form>` 收集、
// 直接打到本机服务进程。`listModelProviders` 回来的只有 `has_key` 这个布尔值。

/** 49 M2 起有第三种：`agentsws_cloud`（走我们云上的服务入口，按积分扣，不填 key）。 */
export type ModelProviderKind =
  | 'deepseek'
  | 'openai_compatible'
  | 'agentsws_cloud'
  /** WP90：用 ChatGPT 的订阅登录（没有 key 可填，走登录流）。 */
  | 'openai-codex'
  /** WP90：用 Claude 的订阅登录。 */
  | 'anthropic'

export type ModelPurposeName =
  | 'run'
  | 'extraction'
  | 'reflection'
  | 'embedding'
  | 'judge'
  | 'transcription'
  /** WP291：岗位入口三分（当场答 / 会话 / 任务） */
  | 'classify'
  /** WP179：官方网页搜索（只出现在用量表里，不能选模型） */
  | 'web_search'
  /** WP188：随便聊（只出现在用量表里，不能选模型） */
  | 'free_chat'

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
  /**
   * WP90：同一家厂商 / 渠道的几个方案合成**一张卡**，这是那张卡的 id
   * （也是品牌图标按哪个名字找图的那个 id）。不填 = 自己独占一张卡。
   */
  vendor?: string
  vendor_label?: string
  vendor_summary?: string
  /** 卡里那一排单选按钮上的字。 */
  plan_label?: string
  /** 方案排序；小的在前，卡打开时默认选第一个。 */
  plan_order?: number
  /** 这个方案怎么认证：填 key（默认），还是用订阅登录（没有表单，只有一个登录按钮）。 */
  /** WP188：`cloud` = 「Agents 工坊（用积分）」——不填 key，卡里是关联账号 / 启用 / 看余额。 */
  auth?: 'api_key' | 'subscription' | 'account' | 'cloud'
  /** `auth: 'subscription'` 时走哪一家。 */
  subscription_provider?: SubscriptionProviderId
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
  budget: {
    workspace_daily_base?: number
    workspace_monthly_base?: number
    assignment_daily_base?: number
  }
  choices: { id: string; label: string }[]
  /** WP66（52 O3）：这个品牌的模型设置跟不跟随公司默认（单品牌永远是 false）。 */
  inherit_org?: boolean
  /** 这个品牌**就是**公司默认那一个（开关不出现）。 */
  org_default?: boolean
  /** 公司默认品牌的名字（界面上那句"跟随「XX」的设置"）。 */
  org_default_brand?: string
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
    budget?: {
      workspace_daily_base?: number
      workspace_monthly_base?: number
      assignment_daily_base?: number
    }
  },
  assignment?: string,
): Promise<ModelDefaultsView> =>
  api('/v1/models/defaults', { method: 'PUT', body: input, ...withAssignment(assignment) })

/**
 * WP66（52 O3）：改"跟随公司默认"。
 *
 * 开着的时候这个品牌读的是公司默认那一份，表单是只读的；关掉才有自己那一份。
 */
export const setModelInheritance = (
  inherit_org: boolean,
  assignment?: string,
): Promise<ModelDefaultsView> =>
  api('/v1/models/inheritance', {
    method: 'PUT',
    body: { inherit_org },
    ...withAssignment(assignment),
  })

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
  /** WP202：拆过的老职责（`social.meta`）才有——新建岗位 / 加减职责的勾选里不列它。 */
  superseded_by?: string[]
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
  /** WP235：`role_ids` = 他在这个岗位里手上的那几条职责（老服务端没有）。 */
  holders: {
    person_id: string
    name: string
    ranges: { kind: string; id: string }[]
    role_ids?: string[]
  }[]
  /** WP174：这个岗位的上级（超授权的审批先转他）；没设 = 转老板。 */
  supervisor?: { person_id: string; name: string }
  /** WP213：岗位图标（`role-icons/glyphs.ts` 的 id）；自建岗位没有。 */
  icon?: string
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
  /** WP234（docs/54 §6.1）：这条活儿归哪个岗位（安放了就是安放的那个；没安放、只挂在一个岗位里就是它；分不清就没有）。只管展示归堆，不带权限。 */
  position?: { id: string; name: string }
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
  /** WP196：`name_en` 给了就一起改英文名（不给 = 英文名不变）。 */
  input: { name: string; name_en?: string; roles: { role_id: string; default?: boolean }[] },
  assignment?: string,
): Promise<OrgPositionView> =>
  api<OrgPositionView>(`/v1/org/positions/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

/** WP234（docs/54 §6.4）：合并 / 移动职责 / 拆出的回执。 */
export interface PositionReshapeView {
  positions: OrgPositionView[]
  moved_assignments: number
  moved_matters: number
  memory?: { moved: number; kept_both: number }
  deleted?: string
  /** WP235：目标是模板时为了不改模板另建的自建岗位 id。 */
  created?: string
  /** 拆出时：岗位层记忆复制给新岗位几条（Luoye 10-06）。 */
  memory_copied?: number
}

/**
 * WP234：把岗位 `id` 合并到 `into`（职责、事项、岗位层记忆都跟过去）。
 * WP235：`name` = 合并后那个岗位叫什么（`into` 是模板时另建自建岗位，模板不变）。
 */
export const mergeOrgPosition = (
  id: string,
  into: string,
  assignment?: string,
  name?: string,
): Promise<PositionReshapeView> =>
  api<PositionReshapeView>(`/v1/org/positions/${encodeURIComponent(id)}/merge`, {
    method: 'POST',
    body: name === undefined ? { into } : { into, name },
    ...withAssignment(assignment),
  })

/** WP234：把岗位 `id` 里的一条职责移到岗位 `to`。 */
export const moveOrgPositionDuty = (
  id: string,
  input: { role_id: string; to: string },
  assignment?: string,
): Promise<PositionReshapeView> =>
  api<PositionReshapeView>(`/v1/org/positions/${encodeURIComponent(id)}/move-duty`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** WP234：从岗位 `id` 拆出几条职责成一个新岗位。 */
export const splitOrgPosition = (
  id: string,
  input: { name: string; role_ids: string[] },
  assignment?: string,
): Promise<PositionReshapeView> =>
  api<PositionReshapeView>(`/v1/org/positions/${encodeURIComponent(id)}/split`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** WP234（docs/54 §6.5）：把负责人身份交给另一位成员（自己那条不收回）。 */
export const transferOwner = (
  person_id: string,
  assignment?: string,
): Promise<{ person_id: string; person_name: string; assignment_id: string; already: boolean }> =>
  api('/v1/org/owner/transfer', {
    method: 'POST',
    body: { person_id },
    ...withAssignment(assignment),
  })

/** WP174：设 / 清岗位上级（`null` = 清掉，落回老板）。 */
export const setOrgPositionSupervisor = (
  id: string,
  person_id: string | null,
  assignment?: string,
): Promise<OrgPositionView> =>
  api<OrgPositionView>(`/v1/org/positions/${encodeURIComponent(id)}/supervisor`, {
    method: 'PUT',
    body: { person_id },
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
  /** WP209：`body` = 这一段现在的正文（搜索用）。 */
  sections: { id: string; heading: string; origin: 'authored' | 'learned'; body?: string }[]
  overlays: SkillOverlayView[]
  pending_proposals: number
  /* ── WP209：按岗位分组那几格（只加；老服务进程不回时退回英文 id、归「通用」）── */
  display_name?: { zh: string; en: string }
  summary?: { zh: string; en: string }
  description?: string
  positions?: SkillPositionRef[]
  roles?: SkillRoleRef[]
  in_use?: boolean
}

/** WP209：技能归属的一个岗位（`common` = 通用）。 */
export interface SkillPositionRef {
  id: string
  name: { zh: string; en: string }
  mine: boolean
}

/** WP209：在用这个技能的一条职责。 */
export interface SkillRoleRef {
  role_id: string
  name: { zh: string; en: string }
  position_ids: string[]
  mine: boolean
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
  /** WP234（docs/54 §6.1）：这条活儿归哪个岗位（安放了就是安放的那个；没安放、只挂在一个岗位里就是它；分不清就没有）。只管展示归堆，不带权限。 */
  position?: { id: string; name: string }
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
  positions: { role_id: string; role_name: string; position?: { id: string; name: string } }[]
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

// ── 46 首次设置与同事发现（WP51）──────────────────────────────────────
//
// 这几个类型与 `packages/api/src/routes/onboarding.ts` 的端口一一对应。工作台不依赖
// `@agentsws/api`（那是服务端的包），所以照老规矩在这里把出参的形状再写一遍。
//
// **发现这一摊没有一个字段是内部 id**：同伴报的是"王岚的工作区 · 3 人"，
// 清单里的岗位与职责说的是名字，公司档案里也没有归一化哈希——哈希只在局域网的
// TXT 记录里出现，界面上永远看不到（46 §2 I1）。

export interface WorkspaceProfileView {
  legal_name: string
  domain?: string
  discoverable: boolean
  /** WP65（52 O1）：这个工作区的品牌名（没设过就等于工作区名）。 */
  brand_name: string
  /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。缺省 = `goods`。 */
  vertical: 'goods' | 'digital'
  /** WP62（51 §1 N0）：网站是用什么搭的。缺省 = `shopify`。 */
  storefront_platform: StorefrontPlatform
  /** WP166：目标市场（ISO 国家码，大写）。没写过就没有。 */
  markets?: string[]
  /** WP166：这份市场是从哪看出来的（问号里那一句）。 */
  markets_source?: MarketsSource
  /** WP176：公司实体地址（开发信页脚、报价单、单证从这里取）。 */
  postal_address?: string
  /** WP248（决策 83）：品牌一句话介绍（没写过就没有）。 */
  one_liner?: string
  /** WP248（决策 83）：客服邮箱（没写过就没有）。 */
  support_email?: string
  /** WP248（决策 83）：币种（新服务端总会给，没写过 = USD）。 */
  currency?: string
  set_at: string
}

/** 「你卖的是」那一步的选项：中文名 + 一句人话（进 tooltip）。 */
export interface VerticalChoiceView {
  key: 'goods' | 'digital'
  label: string
  hint: string
}

/** WP62（51 §1 N0）：网站是用什么搭的——四个之一。 */
export type StorefrontPlatform = 'shopify' | 'woocommerce' | 'magento' | 'other' | 'none'

/**
 * 「网站是用什么搭的」那一步的一个选项。
 *
 * `supported: false` 的**照样渲染**，只是点不动并带一句"待增加"的 tooltip：
 * 用户得看得见下一个是谁，也才知道自己那套现在接不上（51 §1 N0）。
 */
export interface StorefrontPlatformChoiceView {
  key: StorefrontPlatform
  label: string
  supported: boolean
  hint?: string
}

export interface OnboardingStateView {
  needs_setup: boolean
  workspace_name: string
  /** WP65（52 O1）：当前这个品牌叫什么（顶栏切换器显示的那一个）。 */
  brand_name: string
  profile?: WorkspaceProfileView
  person: { name: string; email: string }
  other_assignments: number
  is_owner: boolean
  discovery: { available: boolean; enabled: boolean; reason?: string }
  /** 48 v2 L2：「你卖的是」的选项与各自的一句人话（真源是客服共享包的垂直包）。 */
  verticals: VerticalChoiceView[]
  /** WP62（51 §1 N0）：「网站是用什么搭的」四个选项（含灰显的那三个）。 */
  storefront_platforms: StorefrontPlatformChoiceView[]
  /** WP240：公司加的品牌（公司那一层已经设过）——公司级的不再问，从第 ② 步开始。 */
  added_brand?: true
  /** WP240：这个品牌现在有没有能用的 AI（跟随公司默认的算公司那一份）。 */
  model_configured?: boolean
  /** WP244：这个品牌的第 ② 步已经做过（档案有人确认 / 存过）——向导重开时从第 ③ 步接着走。 */
  business_done?: true
}

/** 向导第 ③ 步的候选：一个岗位与它包含的职责（每条带一句"它会干什么"）。 */
export interface OnboardingPositionView {
  id: string
  name: string
  /** WP234（Luoye 10-06）：公司改过这个类别的名字时，出厂名（界面小字附后）；没改过就没有。 */
  factory_name?: string
  /** WP213：岗位图标（`role-icons/glyphs.ts` 的 id）。 */
  icon?: string
  roles: {
    id: string
    name: string
    default: boolean
    what_it_does: string
    /** WP171：第二批的职责，标「第二批」（说明进问号），仍默认不勾。 */
    planned?: true
  }[]
}

export interface OnboardingConnectorItem {
  /** 连接页那张卡的 provider id——"去连"就是跳 `/connections?service=<它>`。 */
  service: string
  label: string
  required: boolean
  connected: boolean
  needed_by: string[]
}

export interface OnboardingSkillItem {
  name: string
  installed: boolean
  needed_by: string[]
}

export interface OnboardingPositionPlanItem {
  position_id: string
  name: string
  role_ids: string[]
  already_held: boolean
}

export interface OnboardingPlanView {
  connectors: OnboardingConnectorItem[]
  skills: OnboardingSkillItem[]
  positions: OnboardingPositionPlanItem[]
  model_configured: boolean
  /** 真时清单第一条固定是"接模型"：平台连得再全也没人替你干活。 */
  model_first: boolean
  role_ids: string[]
  /** WP216：品牌的平台有官方 CLI、勾的职责里有要用它的——向导最后问一句「要现在装吗？」。 */
  platform_cli?: { id: string; label: string; position_id: string; tutorial: string }
}

export interface OnboardingApplyView {
  created_assignments: { id: string; role_id: string; role_name: string }[]
  skipped: string[]
  ranges: { kind: string; id: string; label: string }[]
  plan: OnboardingPlanView
}

export interface DiscoveryPeerView {
  peer_id: string
  workspace_label: string
  host: string
  port: number
  first_seen_at: string
  last_seen_at: string
}

export interface DiscoveryStateView {
  available: boolean
  enabled: boolean
  reason?: string
  peers: DiscoveryPeerView[]
}

export interface InviteView {
  code: string
  expires_at: string
  uses_left: number
  created_at: string
}

export interface MembershipRequestView {
  id: string
  person: { name: string; email: string }
  via: 'invite' | 'lan' | 'directory'
  status: 'pending' | 'approved' | 'rejected' | 'superseded'
  created_at: string
  decided_at?: string
  /** WP276：谁同意 / 拒绝的（② 里任何一位同事都能定） */
  decided_by?: string
  superseded_reason?: string
  approval_item_id?: string
}

export interface OnboardingPlanInput {
  position_ids: string[]
  role_ids: string[]
  custom_position_name?: string
  /** WP234（docs/54 §6.2）：第 ③ 步的岗位清单（给了就按它建）。 */
  positions?: OnboardingPlannedPosition[]
}

/** WP234：第 ③ 步岗位清单里的一行。 */
export interface OnboardingPlannedPosition {
  name: string
  role_ids: string[]
  /** 从哪个类别（岗位模板）来的；职责全在那个模板里时服务端复用它。 */
  template_id?: string
}

/** WP234（docs/70 §5）：「说说你要做什么工作」的回执——只推荐，不选中。 */
export interface OnboardingSuggestView {
  /** `keyword` = 这次没用 AI、按原话对词（Luoye 10-06）；`unavailable` = 原话是空的。 */
  source: 'ai' | 'keyword' | 'stub' | 'unavailable'
  note?: string
  roles: { role_id: string; reason: string; quote?: string }[]
  positions: OnboardingPlannedPosition[]
}

export const suggestOnboarding = (
  text: string,
  assignment?: string,
): Promise<OnboardingSuggestView> =>
  api<OnboardingSuggestView>('/v1/onboarding/suggest', {
    method: 'POST',
    body: { text },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const getOnboardingState = (assignment?: string): Promise<OnboardingStateView> =>
  api<OnboardingStateView>('/v1/onboarding/state', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const setWorkspaceProfile = (
  input: {
    legal_name: string
    domain?: string
    discoverable?: boolean
    /** 48 v2 L2：你卖的是实物商品 / 虚拟产品与服务。 */
    vertical?: 'goods' | 'digital'
    /** WP62（51 §1 N0）：网站是用什么搭的。 */
    storefront_platform?: StorefrontPlatform
    /** WP65（52 O4）：第 ① 步下半块「这个品牌」的名字。 */
    brand_name?: string
    /** WP166：目标市场（不给 = 不改；空数组 = 清空）。 */
    markets?: string[]
    /** WP176：公司实体地址（不给 = 不改；空串 = 清空）。 */
    postal_address?: string
    /** WP248（决策 83）：品牌三格（不给 = 不改；空串 = 清空）。 */
    one_liner?: string
    support_email?: string
    currency?: string
  },
  assignment?: string,
): Promise<WorkspaceProfileView> =>
  api<WorkspaceProfileView>('/v1/workspace/profile', {
    method: 'PUT',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listOnboardingPositions = (assignment?: string): Promise<OnboardingPositionView[]> =>
  api<OnboardingPositionView[]>('/v1/onboarding/positions', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const planOnboarding = (
  input: OnboardingPlanInput,
  assignment?: string,
): Promise<OnboardingPlanView> =>
  api<OnboardingPlanView>('/v1/onboarding/plan', {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const applyOnboarding = (
  input: OnboardingPlanInput,
  assignment?: string,
): Promise<OnboardingApplyView> =>
  api<OnboardingApplyView>('/v1/onboarding/apply', {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listDiscoveryPeers = (assignment?: string): Promise<DiscoveryStateView> =>
  api<DiscoveryStateView>('/v1/discovery/peers', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listInvites = (assignment?: string): Promise<InviteView[]> =>
  api<InviteView[]>('/v1/invites', { ...(assignment === undefined ? {} : { assignment }) })

export const createInvite = (uses?: number, assignment?: string): Promise<InviteView> =>
  api<InviteView>('/v1/invites', {
    method: 'POST',
    body: uses === undefined ? {} : { uses },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listMembershipRequests = (assignment?: string): Promise<MembershipRequestView[]> =>
  api<MembershipRequestView[]>('/v1/memberships/requests', {
    ...(assignment === undefined ? {} : { assignment }),
  })

/**
 * 申请加入：贴一个邀请码，或挑一位局域网上的同伴。**公开路由**——这会儿我们在对方
 * 工作区里还什么都不是，所以不带 Assignment（带了也没用，那是我们自己这边的）。
 */
export const requestMembership = (input: {
  code?: string
  peer_id?: string
  name: string
  email: string
}): Promise<MembershipRequestView> =>
  api<MembershipRequestView>('/v1/memberships/requests', { method: 'POST', body: input })

export const decideMembershipRequest = (
  id: string,
  input: { approve: boolean; reason?: string },
  assignment?: string,
): Promise<MembershipRequestView> =>
  api<MembershipRequestView>(`/v1/memberships/requests/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

/**
 * WP52（47 J1）数据地图：这条岗位能查什么对象、能做什么动作。
 *
 * 出参就是 `@agentsws/ontology` 的 `TailoredOntology`——那是个纯类型包（只读登记表，
 * 没有实现），工作台直接用它，不必照老规矩再抄一份形状。
 */
export const getPositionOntology = (
  position: string,
  assignment?: string,
): Promise<TailoredOntology> =>
  api<TailoredOntology>(`/v1/positions/${encodeURIComponent(position)}/ontology`, {
    ...(assignment === undefined ? {} : { assignment }),
  })

// ── WP56（48 §4 #6 / #9）知识库：复核队列、缺口补、知识包导入 / 导出 ──────────

/** 19 §1.1 事实卡（工作台只用得着这几格）。 */
export interface KnowledgeCardRow {
  id: string
  layer: 'fact' | 'phrasing' | 'policy' | 'historical_case'
  subject: { type: string; key: string }
  statement: string
  status: 'proposed' | 'active' | 'retired'
  stage?: 'both' | 'presales' | 'postsales'
  verification_state?: 'fresh' | 'stale' | 'quarantined'
  last_verified_at?: string
  media?: string[]
  updated_at: string
  /* ── WP209：知识库按类型 / 品牌 / 状态 / 来源分组要的几格——服务端本来就回（整张 FactCard），
     这里只是把它们认下来（只加）。 */
  domain?: string
  /** 适用范围：空 = 整个品牌通用；`brand` / `store` / `product_line` / `market` 一格一条。 */
  scope?: { kind: string; id: string }[]
  provenance?: { source: string; ref: string; locator?: string }[]
  created_by?: { kind: 'agent' | 'person'; id: string }
  conflicts?: { with: string; note: string }[]
  valid?: { from?: string; until?: string }
  structured?: Record<string, unknown>
}

/** 48 §4 #6：源页 / 文档改了、受管辖数值也变了，等人答的那一张。 */
export interface KnowledgeRecheckRow {
  id: string
  card_id: string
  source_id: string
  status: 'open' | 'resolved' | 'superseded'
  before: string[]
  after: string[]
  categories: string[]
  proposed_statement?: string
  created_at: string
}

export interface KnowledgeGapRow {
  id: string
  question: string
  subject: { type: string; key: string }
  status: 'open' | 'answered' | 'dismissed'
  created_at: string
}

export const listKnowledgeCards = (assignment?: string): Promise<KnowledgeCardRow[]> =>
  api<KnowledgeCardRow[]>('/v1/knowledge/cards', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listKnowledgeRechecks = (assignment?: string): Promise<KnowledgeRecheckRow[]> =>
  api<KnowledgeRecheckRow[]>('/v1/knowledge/rechecks?status=open', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const resolveKnowledgeRecheck = (
  id: string,
  resolution: 'unchanged' | 'adopt_new' | 'ignore',
  assignment?: string,
): Promise<unknown> =>
  api<unknown>(`/v1/knowledge/rechecks/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: { resolution },
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listKnowledgeGaps = (assignment?: string): Promise<KnowledgeGapRow[]> =>
  api<KnowledgeGapRow[]>('/v1/knowledge/gaps?status=open', {
    ...(assignment === undefined ? {} : { assignment }),
  })

/**
 * 补一个缺口。两种补法（48 §4 #9）：贴一条外部链接，或者粘一段文字口径。
 * **没有上传、没有图床、没有富文本**——链接就是链接，文字就是文字。
 */
export const answerKnowledgeGap = (
  id: string,
  answer: string,
  assignment?: string,
): Promise<unknown> =>
  api<unknown>(`/v1/knowledge/gaps/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    body: { answer },
    ...(assignment === undefined ? {} : { assignment }),
  })

export interface KnowledgePackImportResult {
  imported: number
  activated: number
  proposed: number
  warnings: string[]
  manifest: { name: string; version: string }
}

/** 导入一个知识包（zip）。走 multipart——包是用户从磁盘拖进来的一个文件。 */
export async function importKnowledgePack(
  file: File,
  assignment?: string,
): Promise<KnowledgePackImportResult> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = assignment ?? currentAssignment
  if (asg !== null) headers.set('X-Assignment', asg)
  const form = new FormData()
  form.append('file', file)
  // content-type 交给浏览器填（它要带 boundary）
  const res = await fetch('/v1/knowledge/import', { method: 'POST', headers, body: form })
  const text = await res.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  if (!res.ok) throw new ApiClientError(res.status, parsed as ApiErrorBody)
  return (parsed as ApiEnvelope<KnowledgePackImportResult>).data
}

/** 导出整库成一个知识包（zip）。拿到 blob 之后由调用方去触发下载。 */
export async function exportKnowledgePack(assignment?: string): Promise<Blob> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = assignment ?? currentAssignment
  if (asg !== null) headers.set('X-Assignment', asg)
  const res = await fetch('/v1/knowledge/export', { headers })
  if (!res.ok) throw new ApiClientError(res.status, (await res.json()) as ApiErrorBody)
  return res.blob()
}

/** 36 §2.2 业务边界：15 条里哪几条答过。 */
export interface KnowledgeBoundaryRow {
  id: string
  label: string
  question: string
  answered: boolean
  options: { id: string; label: string }[]
}

export const listKnowledgeBoundaries = (assignment?: string): Promise<KnowledgeBoundaryRow[]> =>
  api<KnowledgeBoundaryRow[]>('/v1/knowledge/boundaries', {
    ...(assignment === undefined ? {} : { assignment }),
  })
/* ------------------------------------------------------------------ */
/* WP57（48 §4 L3 #11）：网站在线客服                                     */
/* ------------------------------------------------------------------ */

export interface ChatSessionView {
  id: string
  source: string
  external_session_id: string
  visitor_display?: string
  status: string
  takeover: boolean
  thread_external_id: string
  created_at: string
  updated_at: string
  assist_requested_at?: string
}

export interface ChatMessageView {
  id: string
  role: string
  text: string
  at: string
  plan_action?: string
}

export interface ChatPlanView {
  action: string
  intent: string
  risk: string
  can_auto_reply: boolean
  money_touch: boolean
  missing_info: string[]
  summary: string
  next_question: string
}

export interface ChatTurnView {
  session_id: string
  plan?: ChatPlanView
  reply?: string
  approval_item_id?: string
  used_model: boolean
  blocked?: string
}

// WP139：这一组都多一个可选的 `assignment`——试聊 / 聊天窗不属于任何岗位，
// 按「要什么职责」挑自己名下那条分配发请求（`lib/pick-assignment.ts`），不改全局当前岗位。
// 注意别把它们直接当 `queryFn` / `mutationFn` 传：TanStack 会把它的上下文塞进第一个参数。
export const openChatSession = (assignment?: string): Promise<ChatSessionView> =>
  api<ChatSessionView>('/v1/chat/sessions', { method: 'POST', ...withAssignment(assignment) })

export const getChatMessages = (
  id: string,
  assignment?: string,
): Promise<{ session: ChatSessionView; messages: ChatMessageView[] }> =>
  api(`/v1/chat/sessions/${encodeURIComponent(id)}/messages`, withAssignment(assignment))

export const sendChatMessage = (
  id: string,
  text: string,
  assignment?: string,
): Promise<ChatTurnView> =>
  api<ChatTurnView>(`/v1/chat/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { text },
    ...withAssignment(assignment),
  })

/**
 * 静默窗口到了：让服务端把这一轮判完。
 *
 * 沙盒页自己点这一下，不等服务进程里那个真定时器——不然每发一句都要干等 2 秒
 * 才看得到判定，商家试不下去。真访客那一路仍然由定时器驱动。
 */
export const advanceChatTurn = (id: string, assignment?: string): Promise<ChatTurnView> =>
  api<ChatTurnView>(`/v1/chat/sessions/${encodeURIComponent(id)}/advance`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const listChatSessions = (limit = 30, assignment?: string): Promise<ChatSessionView[]> =>
  api<ChatSessionView[]>(`/v1/chat/sessions?limit=${limit}`, withAssignment(assignment))

export interface ChatWidgetSettingsView {
  allowed_origins: string[]
  accent?: string
  greeting?: string
  assist_wait_seconds?: number
  updated_at?: string
}

export const getChatWidgetSettings = (assignment?: string): Promise<ChatWidgetSettingsView> =>
  api('/v1/chat/widget/settings', withAssignment(assignment))

export const setChatWidgetSettings = (
  input: {
    allowed_origins: string[]
    accent?: string
    greeting?: string
    assist_wait_seconds?: number
  },
  assignment?: string,
): Promise<ChatWidgetSettingsView> =>
  api('/v1/chat/widget/settings', { method: 'PUT', body: input, ...withAssignment(assignment) })

export interface ChatRelaySettingsView {
  endpoint?: string
  has_pairing_token: boolean
  has_message_key: boolean
  configured: boolean
}

export const getChatRelaySettings = (assignment?: string): Promise<ChatRelaySettingsView> =>
  api('/v1/chat/relay/settings', withAssignment(assignment))

export const setChatRelaySettings = (
  input: {
    endpoint?: string | null
    pairing_token?: string
    message_key?: string
  },
  assignment?: string,
): Promise<ChatRelaySettingsView> =>
  api('/v1/chat/relay/settings', { method: 'PUT', body: input, ...withAssignment(assignment) })

export interface ChatRelayTestView {
  ok: boolean
  detail: string
  client_state: string
}

export const testChatRelay = (assignment?: string): Promise<ChatRelayTestView> =>
  api('/v1/chat/relay/test', { method: 'POST', ...withAssignment(assignment) })

export type HostedInstanceState = 'running' | 'starting' | 'sleeping' | 'stopped'

export interface ChatRelayStatusView {
  state: string
  online: boolean
  endpoint?: string
  conversations_this_month?: number
  limit?: number
  unlimited?: boolean
  subscribed?: boolean
  offline_messages?: number
  /** WP128：托管实例在不在跑（订阅了客服增值服务才有）。 */
  hosted?: { state: HostedInstanceState; last_heartbeat_at?: string }
}

export const getChatRelayStatus = (assignment?: string): Promise<ChatRelayStatusView> =>
  api('/v1/chat/relay/status', withAssignment(assignment))

/* ── WP128 客服增值服务：云端替你值守（「转发方式」第三项） ─────────────── */

export type HostedSubscriptionStatus = 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'

export interface ChatRelayHostedView {
  /** 云端开没开这项服务。 */
  available: boolean
  /** 关联过云账号没有。 */
  linked: boolean
  subscription: {
    status: HostedSubscriptionStatus
    current_cycle_end?: string
    grace_until?: string
    cancel_at_period_end?: boolean
  }
  hosted?: {
    state: HostedInstanceState
    last_heartbeat_at?: string
    snapshot?: { at: string; bytes: number; source: 'hosted' | 'local' }
    snapshot_kept_until?: string
    last_error?: string
  }
  message?: string
}

export const getChatRelayHosted = (assignment?: string): Promise<ChatRelayHostedView> =>
  api('/v1/chat/relay/hosted', withAssignment(assignment))

export const subscribeChatRelayHosted = (assignment?: string): Promise<ChatRelayHostedView> =>
  api('/v1/chat/relay/hosted/subscribe', { method: 'POST', ...withAssignment(assignment) })

export const cancelChatRelayHosted = (assignment?: string): Promise<ChatRelayHostedView> =>
  api('/v1/chat/relay/hosted/subscribe', { method: 'DELETE', ...withAssignment(assignment) })

export const bringHomeChatRelayHosted = (
  assignment?: string,
): Promise<{
  saved_to?: string
  bytes?: number
  message: string
}> => api('/v1/chat/relay/hosted/bring-home', { method: 'POST', ...withAssignment(assignment) })

export const seedChatRelayHosted = (
  assignment?: string,
): Promise<{ bytes: number; message: string }> =>
  api('/v1/chat/relay/hosted/seed', { method: 'POST', ...withAssignment(assignment) })

export const teachChatSession = (
  id: string,
  input: { instruction: string; scope: 'single_reply' | 'similar_cases' | 'global_rule' },
  assignment?: string,
): Promise<{ outcome: string; reply?: string; sediment: string; rule_card_id?: string }> =>
  api(`/v1/chat/sessions/${encodeURIComponent(id)}/teach`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/* ── 49 M1 云账号（WP58）──────────────────────────────────────────────── */

export type CloudScopeName = 'ai' | 'wallet:read' | 'standby'
/** WP265：契约里的整套动作集（`missing_scopes` 用；老的 `CloudScopeName` 只是界面上显示的那几项）。 */
export type CloudScopeId =
  | 'ai'
  | 'wallet:read'
  | 'wallet:topup'
  | 'wallet:admin'
  | 'standby'
  | 'data'
  | 'kol'
  | 'store'

/** 关联状态。**这里没有、也不会有令牌字段**——它只在本机加密库里。 */
export interface CloudAccountView {
  linked: boolean
  email?: string
  org_name?: string
  expires_at?: string
  scopes?: CloudScopeName[]
  linked_at?: string
  cloud_base_url: string
  /** 现在还关联不了的原因（比如这台机器没有秘密库密钥）。 */
  blocked_reason?: string
  /** WP265：这把令牌比现在的默认动作集少了哪几项（老令牌没有 `store`）。 */
  missing_scopes?: CloudScopeId[]
}

export interface CloudUnlinkResult {
  unlinked: boolean
  revoked_on_cloud: boolean
  reason?: string
}

export const getCloudAccount = (assignment?: string): Promise<CloudAccountView> =>
  api<CloudAccountView>('/v1/cloud/account', {
    ...(assignment === undefined ? {} : { assignment }),
  })

/**
 * 起一次关联：服务端往这个邮箱发一封登录邮件。
 * 一次性 token **只进邮件**，前端从头到尾看不到它。
 */
export const linkCloudAccount = (
  email: string,
  assignment?: string,
): Promise<{ expires_at: string; delivered: 'email' }> =>
  api('/v1/cloud/account/link', {
    method: 'POST',
    body: { email },
    ...(assignment === undefined ? {} : { assignment }),
  })

/* ── WP231：注册与登录（密码 + 邮箱验证码）。密码只在这一次请求体里，发给本机服务、由它转到云 ── */

export interface CloudAuthConfigView {
  password_min: number
  otp_length: number
  otp_ttl_seconds: number
  terms_version: string
  turnstile_site_key?: string
}

export interface CloudCodeSent {
  expires_at: string
  delivered: 'email'
}

export interface CloudAuthDone extends CloudAccountView {
  registered?: boolean
  bonus_credits?: number
}

const cloudAuthPost = <T>(path: string, body: unknown, assignment?: string): Promise<T> =>
  api<T>(path, { method: 'POST', body, ...(assignment === undefined ? {} : { assignment }) })

export const getCloudAuthConfig = (assignment?: string): Promise<CloudAuthConfigView> =>
  api<CloudAuthConfigView>('/v1/cloud/account/auth-config', {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const cloudSignup = (
  input: { name: string; email: string; password: string; locale: 'zh' | 'en' },
  assignment?: string,
): Promise<CloudCodeSent> =>
  cloudAuthPost('/v1/cloud/account/signup', { ...input, accept_terms: true }, assignment)

export const cloudSignupVerify = (
  input: { email: string; code: string },
  assignment?: string,
): Promise<CloudAuthDone> => cloudAuthPost('/v1/cloud/account/signup/verify', input, assignment)

export const cloudLoginCode = (
  input: { email: string; locale: 'zh' | 'en'; refresh?: boolean },
  assignment?: string,
): Promise<CloudCodeSent> => cloudAuthPost('/v1/cloud/account/code', input, assignment)

export const cloudLoginCodeVerify = (
  input: { email: string; code: string; refresh?: boolean },
  assignment?: string,
): Promise<CloudAuthDone> => cloudAuthPost('/v1/cloud/account/code/verify', input, assignment)

export const cloudPasswordLogin = (
  input: { email: string; password: string; refresh?: boolean },
  assignment?: string,
): Promise<CloudAuthDone> => cloudAuthPost('/v1/cloud/account/password-login', input, assignment)

export const cloudPasswordForgot = (
  input: { email: string; locale: 'zh' | 'en' },
  assignment?: string,
): Promise<CloudCodeSent> => cloudAuthPost('/v1/cloud/account/password/forgot', input, assignment)

export const cloudPasswordReset = (
  input: { email: string; code: string; new_password: string },
  assignment?: string,
): Promise<CloudAuthDone> => cloudAuthPost('/v1/cloud/account/password/reset', input, assignment)

export const unlinkCloudAccount = (assignment?: string): Promise<CloudUnlinkResult> =>
  api<CloudUnlinkResult>('/v1/cloud/account/unlink', {
    method: 'POST',
    ...(assignment === undefined ? {} : { assignment }),
  })

/* ── WP265：连接页 Shopify 卡的一键授权（店铺令牌只在云上，这里一个令牌字段都没有）──────── */

export interface ShopifyConnectRow {
  shop: string
  name?: string
  app?: string
  status: 'connected' | 'reauth_required'
  reauth_reason?: string
  scopes: string[]
  missing_scopes: string[]
  expires_at?: string
}

export interface ShopifyConnectView {
  linked: boolean
  email?: string
  /** WP272：`offline` 时带根本原因的码（`ENOTFOUND` / `timeout` …，卡上放问号里）。 */
  blocked?: {
    reason: 'not_linked' | 'scope_missing' | 'offline'
    message: string
    cause_code?: string
  }
  connections: ShopifyConnectRow[]
  suggested_shop?: string
  candidates: { shop: string; source: 'profile' | 'site' | 'cli' | 'connection' }[]
}

export interface ShopifyConnectStarted {
  attempt_id: string
  authorize_url: string
  shop: string
  expires_at: string
}

export interface ShopifyConnectAttempt {
  status: 'pending' | 'connected' | 'failed' | 'expired'
  shop?: string
  message?: string
}

export interface ShopifyConnectTest {
  ok: boolean
  shop: string
  name?: string
  domain?: string
  message?: string
  checked_at: string
}

export const getShopifyConnect = (assignment?: string): Promise<ShopifyConnectView> =>
  api<ShopifyConnectView>('/v1/shopify-connect', withAssignment(assignment))

export const startShopifyConnect = (
  input: { shop?: string },
  assignment?: string,
): Promise<ShopifyConnectStarted> =>
  api('/v1/shopify-connect/start', { method: 'POST', body: input, ...withAssignment(assignment) })

export const getShopifyConnectAttempt = (
  id: string,
  assignment?: string,
): Promise<ShopifyConnectAttempt> =>
  api(`/v1/shopify-connect/attempts/${encodeURIComponent(id)}`, withAssignment(assignment))

export const testShopifyConnect = (
  shop: string,
  assignment?: string,
): Promise<ShopifyConnectTest> =>
  api('/v1/shopify-connect/test', { method: 'POST', body: { shop }, ...withAssignment(assignment) })

export const disconnectShopifyConnect = (
  shop: string,
  assignment?: string,
): Promise<{ disconnected: boolean }> =>
  api('/v1/shopify-connect/disconnect', {
    method: 'POST',
    body: { shop },
    ...withAssignment(assignment),
  })

/** WP267（决策 208）：账号授权一点补签（令牌不变；`added` 是这次补上的动作集）。 */
export interface ShopifyConnectUpgrade {
  upgraded: boolean
  added: string[]
  scopes: string[]
}

export const upgradeShopifyConnect = (assignment?: string): Promise<ShopifyConnectUpgrade> =>
  api('/v1/shopify-connect/upgrade', { method: 'POST', body: {}, ...withAssignment(assignment) })

// ── WP65（52 O1–O4）组织与品牌 ─────────────────────────────────────────
//
// 品牌 = 工作区，公司 = 组织。这一摊只有三件事：我在哪几家公司（`listOrganizations`）、
// 每家有哪几个品牌（`listBrands`）、切过去（`switchBrand`）。
//
// **没有跨品牌的合并视图**（52 O2「不混」）：这里没有一个函数会同时回两个品牌的卡片、
// 队列或知识——那些一律按当前 `workspace_id` 走各自已有的路由。

export interface OrganizationView {
  id: string
  legal_name: string
  domain?: string
  discoverable: boolean
  owner_id: string
  role: 'owner' | 'admin' | 'member'
  cloud_org_id?: string
  brands: number
  members: number
  /** 个人用户：界面上一律不显示"组织"这两个字（52 O1）。WP271 起只看模式，不看品牌数。 */
  solo: boolean
  /**
   * WP271（决策 222）：① 个人 / ② 同事互联 / ③ 公司集体。老服务进程不回它——
   * 读的时候一律过 `useMode()` / `modeOfOrg()`。
   */
  mode?: 'solo' | 'peers' | 'company'
  /** WP277：模式最后一次谁、什么时候改的（降回 ② 时同事那一行通知读它）。 */
  mode_changed_at?: string
  mode_changed_by?: string
  mode_changed_by_name?: string
  /** WP277：我点掉过那一行通知没有。 */
  mode_notice_seen?: boolean
  created_at: string
}

export interface BrandView {
  workspace_id: string
  name: string
  logo?: string
  /** 这一行是不是当前正开着的品牌。 */
  current: boolean
  vertical?: 'goods' | 'digital'
  storefront_platform?: StorefrontPlatform
  pending_approvals: number
  alerts: number
  /**
   * WP66 起**每个品牌都算得出来**（各有各的活数据源）。
   * 还没连店 / 今天还没有单时仍然没有这个字段——没有就明说没有，不画一个 0（36 §3）。
   */
  sales_today?: { amount: number; currency: string }
  /**
   * WP215：这个品牌的后台（定时巡检、收信、每日计划 / 复盘、自动化任务……）。
   * 后台按品牌常驻，与眼前切在哪个品牌无关；老服务进程没有这个字段——没有就不画那一格。
   */
  background?: BrandBackgroundView
}

/**
 * WP215：一个品牌的后台状态（品牌切换器与「品牌一览」那一格：图标 + 数字，细节进 tooltip）。
 * 契约：`packages/api/src/routes/background.ts`。
 */
export interface BrandBackgroundView {
  workspace_id: string
  /** running 照常在跑；halted 急停了（品牌的或全局的）；stopped 品牌停用了。 */
  state: 'running' | 'halted' | 'stopped'
  /** 在跑的定时任务条数。 */
  scheduled: number
  /** 最近一次有任务跑起来的时刻。 */
  last_run_at?: string
  /** 最近一条要跑的时刻。 */
  next_run_at?: string
  /** 上一次跑失败、还没跑好的条数（> 0 出红点）。 */
  errors: number
  last_error?: { task_id: string; title: string; message: string; at?: string }
  /** 这个品牌自己的急停开着没有。 */
  halted: boolean
  /** 全局急停开着没有。 */
  global_halted: boolean
}

/** WP215：设置页「后台」那一张。 */
export interface BackgroundSettingsView {
  /** 全进程同时最多跑几件（品牌之间并行，同一品牌永远一件接一件）。 */
  max_concurrent: number
  limits: { min: number; max: number }
  global_halted: boolean
  brands: (BrandBackgroundView & { name: string; current: boolean })[]
  /** 现在只有「这台电脑」：关机、睡眠、断网时所有品牌都停。 */
  runs_on: 'this_device'
}

export interface OrganizationMemberView {
  person_id: string
  name: string
  email: string
  role: 'owner' | 'admin' | 'member'
  joined_at: string
  left_at?: string
  brands: string[]
}

export interface BrandCopyView {
  from: string
  to: string
  copied_assignments: number
  dropped_ranges: number
  /** WP66 起恒为 false（模型设置按品牌各一份，不再是"本来就共用"）。 */
  models_shared: boolean
  /** WP66（52 O4）：复制过来的模型 provider 条数（**不含 API key**）。 */
  copied_model_providers?: number
  /** 复制过设置的品牌从此不跟随公司默认（52 O3）。 */
  inherit_org?: boolean
}

export interface BrandSwitchView {
  workspace_id: string
  name: string
  session_token?: string
  expires_at?: string
}

export const listOrganizations = (assignment?: string): Promise<OrganizationView[]> =>
  api<OrganizationView[]>('/v1/orgs', { ...(assignment === undefined ? {} : { assignment }) })

export const createOrganization = (
  input: { legal_name: string; domain?: string; discoverable?: boolean },
  assignment?: string,
): Promise<OrganizationView> =>
  api<OrganizationView>('/v1/orgs', {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const updateOrganization = (
  id: string,
  input: { legal_name?: string; domain?: string; discoverable?: boolean },
  assignment?: string,
): Promise<OrganizationView> =>
  api<OrganizationView>(`/v1/orgs/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listBrands = (org_id: string, assignment?: string): Promise<BrandView[]> =>
  api<BrandView[]>(`/v1/orgs/${encodeURIComponent(org_id)}/brands`, {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const createBrand = (
  org_id: string,
  input: {
    name: string
    vertical?: 'goods' | 'digital'
    storefront_platform?: StorefrontPlatform
    copy_from?: string
  },
  assignment?: string,
): Promise<BrandView> =>
  api<BrandView>(`/v1/orgs/${encodeURIComponent(org_id)}/brands`, {
    method: 'POST',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

export const listOrganizationMembers = (
  org_id: string,
  assignment?: string,
): Promise<OrganizationMemberView[]> =>
  api<OrganizationMemberView[]>(`/v1/orgs/${encodeURIComponent(org_id)}/members`, {
    ...(assignment === undefined ? {} : { assignment }),
  })

export const copyBrandSettings = (
  org_id: string,
  workspace_id: string,
  from: string,
  assignment?: string,
): Promise<BrandCopyView> =>
  api<BrandCopyView>(
    `/v1/orgs/${encodeURIComponent(org_id)}/brands/${encodeURIComponent(workspace_id)}/copy-from`,
    { method: 'POST', body: { from }, ...(assignment === undefined ? {} : { assignment }) },
  )

/**
 * 52 O2 切品牌：换一张绑目标工作区的会话 token，**整个工作台重载**。
 *
 * 重载不是偷懒——首页、岗位、连接、知识、设置全都要换成另一个品牌的，
 * 与其一页一页去失效缓存，不如让浏览器从头拉一遍：少一处漏掉就少一次串味。
 * 桌面壳走 HttpOnly cookie 那条路没有 `session_token`，`Set-Cookie` 已经换好了。
 */
export async function switchBrand(
  org_id: string,
  workspace_id: string,
  assignment?: string,
): Promise<BrandSwitchView> {
  const switched = await api<BrandSwitchView>(
    `/v1/orgs/${encodeURIComponent(org_id)}/brands/${encodeURIComponent(workspace_id)}/switch`,
    { method: 'POST', ...(assignment === undefined ? {} : { assignment }) },
  )
  if (switched.session_token !== undefined) storeToken(switched.session_token)
  // 当前岗位是上一个品牌的 assignment_id，换品牌之后它一定不成立——先忘掉它
  clearAssignment()
  return switched
}

/**
 * WP244（Fable 10-07 真机）：切完品牌**回这个品牌的首页**，不是原地重载。
 *
 * 原地重载会停在上一个品牌的地址上——在 INMO 的 `/positions/asg_…` 切到 Rollout，地址不变、
 * 岗位名空白、内容全空（那个 asg 是 INMO 的）。换品牌后旧地址里的 id 一律不成立，所以一律回 `/`：
 * 那个品牌还没设置完，首页那一跳自己会把人送进它的首次设置（`App` 按 `needs_setup` 判）。
 * 仍然是整站重新加载（52 O2：不一页一页失效缓存）。
 */
export function enterSwitchedBrand(): void {
  globalThis.location?.assign('/')
}

// ── WP215 每个品牌一套后台 ────────────────────────────────────────────

export const getBackgroundSettings = (assignment?: string): Promise<BackgroundSettingsView> =>
  api<BackgroundSettingsView>('/v1/settings/background', {
    ...(assignment === undefined ? {} : { assignment }),
  })

/** 改「同时最多跑几件」（全进程一个数，1–4）。 */
export const setBackgroundSettings = (
  input: { max_concurrent: number },
  assignment?: string,
): Promise<BackgroundSettingsView> =>
  api<BackgroundSettingsView>('/v1/settings/background', {
    method: 'PUT',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

/** 品牌急停：只停 / 放开这一个品牌的后台（全局急停照旧在 `/v1/halt`）。 */
export const setBrandBackgroundHalt = (
  workspace_id: string,
  input: { halted: boolean; reason?: string },
  assignment?: string,
): Promise<BrandBackgroundView> =>
  api<BrandBackgroundView>(`/v1/settings/background/brands/${encodeURIComponent(workspace_id)}`, {
    method: 'PUT',
    body: input,
    ...(assignment === undefined ? {} : { assignment }),
  })

/* ------------------------------------------------------------------ */
/* WP60（49 §6 / 48 L7 / 41 §2.4）在线值守                             */
/* ------------------------------------------------------------------ */

export interface StandbyWorkspaceView {
  workspace_id: string
  org_id: string
  status: 'starting' | 'running' | 'stopped' | 'expired'
  seats: number
  period_end: string
  last_health_at?: string
}

/** 连接页"在线值守"那一格要的全部东西。**每个数字都是云上那一份的透传。** */
export interface StandbyView {
  linked: boolean
  reason?: string
  remote: boolean
  remote_url?: string
  cloud?: StandbyWorkspaceView
  seat_price?: number
  embed_snippet?: string
}

export interface StandbySwitchResult {
  status: string
  remote_url: string
  bytes: number
  period_end: string
  embed_snippet: string
}

export interface StandbyBringHomeResult {
  out: string
  bytes: number
  stopped: boolean
  next: string
}

export const getStandby = (assignment?: string): Promise<StandbyView> =>
  api<StandbyView>('/v1/standby', withAssignment(assignment))

/** ④ 本地导出 → 上传到云 → 开通 → 云上起进程。一次调用走完，中间不落半步。 */
export const switchToStandby = (
  input: { seats: number; force?: boolean },
  assignment?: string,
): Promise<StandbySwitchResult> =>
  api('/v1/standby/switch', { method: 'POST', body: input, ...withAssignment(assignment) })

/** 反向：云上导出 → 落到本机备份目录 → 停云上那个进程。 */
export const bringStandbyHome = (assignment?: string): Promise<StandbyBringHomeResult> =>
  api('/v1/standby/bring-home', { method: 'POST', ...withAssignment(assignment) })

/* ── WP68（48 §5.4）：红人库 ─────────────────────────────────────────── */

export type KolChannelId = 'youtube' | 'facebook' | 'instagram' | 'tiktok' | 'x'

/** 找人清单上的一行。`blocked` 有值就是"这个数不可信"（与低分分得开）。 */
export interface KolCreatorRowData {
  creator_id: string
  display_name: string
  channel: KolChannelId
  handle: string
  url: string
  followers?: number
  engagement_rate?: number
  category?: string
  observed_at: string
  score: number
  blocked?: string
  has_contact: boolean
  /** WP131：「采集后自动评分」跑出的云端体检概括数（0–100）与时刻；没做过就没有。 */
  audit_health?: number
  audited_at?: string
}

/** 一条联系方式。**没有明文那一格**——脱敏形态够认出是哪一个，不够拿去发信。 */
export interface KolContactData {
  id: string
  creator_id: string
  kind: 'email' | 'dm' | 'form'
  source: string
  verified_at?: string
  masked: string
}

export interface KolCreatorDetailData {
  creator: { id: string; display_name: string; merged_from: string[] }
  accounts: {
    id: string
    channel: KolChannelId
    handle: string
    url: string
    followers?: number
    engagement_rate?: number
    category?: string
    language?: string
    region?: string
    observed_at: string
  }[]
  contacts: KolContactData[]
  collaborations: KolCollaborationData[]
  deliverables: KolDeliverableData[]
  tracked_links: { id: string; url: string; clicks: number; orders: number; revenue: number }[]
}

export interface KolCollaborationData {
  id: string
  creator_id: string
  channel: KolChannelId
  stage: string
  budget?: number
  currency: string
  campaign_id?: string
  agreed_at?: string
  /** WP117b（66 复测 #18）：最近一次往来。没有 = 这条合作还什么都没发生过。 */
  last_activity_at?: string
  /** 演练数据（列表行上带一个角标）。 */
  sandbox?: boolean
}

/** WP117b（66 复测 #19）：一条合作上的一次往来（我们发的 / 他回的）。 */
export interface KolExchangeData {
  id: string
  creator_id: string
  collaboration_id?: string
  channel: KolChannelId
  direction: 'out' | 'in'
  subject: string
  body: string
  at: string
  reply_class?: string
  opt_out?: boolean
  bounce_reason?: string
  sandbox?: boolean
  message_id?: string
  change_id?: string
  step?: 'first' | 'follow_up' | 'final'
}

export interface KolDeliverableData {
  id: string
  collaboration_id: string
  kind: string
  url?: string
  due_at: string
  review: string
  notes?: string
}

/** 去渠道 / 公共库找人的结果。**"拿不到"与"搜到 0 个"分得开**。 */
export interface KolSearchData {
  ok: boolean
  source: 'channel' | 'public_library'
  rows: {
    channel: KolChannelId
    handle: string
    url: string
    display_name: string
    followers?: number
    engagement_rate?: number
    category?: string
    has_contact?: boolean
    in_library?: boolean
  }[]
  message?: string
  reason?: string
  observed_at?: string
  reveal_price?: { capability: string; credits: number; unit: string; note: string }
  /** WP142：搜不了时的两个去处（关联官方账号 / 接自己的数据接口），界面画成两个按钮。 */
  entry_points?: { id: 'link_account' | 'byo'; label: string; note: string }[]
}

export interface KolStagedData {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  message?: string
  auto_approved?: boolean
}

export interface KolOutreachData extends KolStagedData {
  step: 'first' | 'follow_up' | 'final'
  subject: string
  body: string
  forbidden_hits: string[]
  missing_vars: string[]
  quota: { cap: number; sent_today: number; remaining: number; allowed: boolean }
}

export interface KolImportData {
  summary: string
  created_creators: number
  created_accounts: number
  updated_accounts: number
  created_contacts: number
  duplicates: { source_row: number; same_as_row: number; handle: string; channel: string }[]
  rejected: { source_row: number; reason: string }[]
  unmapped: string[]
  note?: string
}

export interface KolCampaignData {
  campaign_id: string
  ready: boolean
  gaps: string[]
  message: string
  budget_per_creator: number
  approval_item_id?: string
  by_channel: {
    channel: KolChannelId
    role_id: string
    allowed: boolean
    assignment_id?: string
    reason?: string
    picks: {
      creator_id: string
      display_name: string
      channel: KolChannelId
      handle: string
      followers?: number
      score: number
      why: string[]
      already: boolean
    }[]
  }[]
}

export interface KolCampaignAcceptData {
  campaign_id: string
  created: { channel: string; creator_id: string; collaboration_id: string }[]
  skipped: { channel: string; creator_id?: string; reason: string }[]
}

export interface KolMergeSuggestionData {
  id: string
  keep: { creator_id: string; display_name: string }
  merge: { creator_id: string; display_name: string }
  reasons: { id: string; text: string }[]
  confidence: number
  approval_item_id?: string
}

export const getKolCreators = (
  filter: { channel?: KolChannelId; q?: string; batch?: string } = {},
  assignment?: string,
): Promise<{ rows: KolCreatorRowData[] }> => {
  const q = new URLSearchParams()
  if (filter.channel !== undefined) q.set('channel', filter.channel)
  if (filter.q !== undefined && filter.q !== '') q.set('q', filter.q)
  // WP131：插件「回作战室看这批」——只看这一次列表采集收进来的人
  if (filter.batch !== undefined && filter.batch !== '') q.set('batch', filter.batch)
  const s = q.toString()
  return api(`/v1/kol/creators${s === '' ? '' : `?${s}`}`, withAssignment(assignment))
}

export const getKolCreator = (id: string, assignment?: string): Promise<KolCreatorDetailData> =>
  api(`/v1/kol/creators/${encodeURIComponent(id)}`, withAssignment(assignment))

export const searchKolCreators = (
  input: { channel: KolChannelId; q: string },
  assignment?: string,
): Promise<KolSearchData> =>
  api(
    `/v1/kol/search?channel=${encodeURIComponent(input.channel)}&q=${encodeURIComponent(input.q)}`,
    withAssignment(assignment),
  )

export const addKolCreator = (
  input: { display_name: string; channel: KolChannelId; handle?: string; url?: string },
  assignment?: string,
): Promise<KolCreatorDetailData> =>
  api('/v1/kol/creators', { method: 'POST', body: input, ...withAssignment(assignment) })

export const addKolContact = (
  creator_id: string,
  input: { kind: 'email' | 'dm' | 'form'; value: string; source?: string },
  assignment?: string,
): Promise<KolContactData> =>
  api(`/v1/kol/creators/${encodeURIComponent(creator_id)}/contacts`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** 付费从公共库取回一个邮箱（49 M4 `data.kol.lookup`）。 */
export const revealKolContact = (
  input: { channel: KolChannelId; handle: string; creator_id?: string },
  assignment?: string,
): Promise<{
  ok: boolean
  contact?: KolContactData
  creator_id?: string
  credits_spent?: number
  message?: string
}> => api('/v1/kol/public/reveal', { method: 'POST', body: input, ...withAssignment(assignment) })

export const draftKolOutreach = (
  input: {
    creator_id: string
    channel: KolChannelId
    product: string
    /** 一句话说我们是做什么的。**服务端不编一个**，缺了就不起草。 */
    brand_pitch?: string
    reason?: string
    step?: 'first' | 'follow_up' | 'final'
  },
  assignment?: string,
): Promise<KolOutreachData> =>
  api('/v1/kol/outreach', { method: 'POST', body: input, ...withAssignment(assignment) })

export const getKolCollaborations = (
  filter: { channel?: KolChannelId } = {},
  assignment?: string,
): Promise<{ rows: KolCollaborationData[] }> => {
  const q = filter.channel === undefined ? '' : `?channel=${encodeURIComponent(filter.channel)}`
  return api(`/v1/kol/collaborations${q}`, withAssignment(assignment))
}

export const advanceKolCollaboration = (
  id: string,
  stage: string,
  assignment?: string,
): Promise<KolCollaborationData> =>
  api(`/v1/kol/collaborations/${encodeURIComponent(id)}/stage`, {
    method: 'PATCH',
    body: { stage },
    ...withAssignment(assignment),
  })

export const importKolTable = (
  input: { filename?: string; content: string },
  assignment?: string,
): Promise<KolImportData> =>
  api('/v1/kol/import', { method: 'POST', body: input, ...withAssignment(assignment) })

export const planKolCampaign = (
  input: {
    goal: string
    budget: number
    channels: KolChannelId[]
    headcount: number
    criteria?: { category?: string }
  },
  assignment?: string,
): Promise<KolCampaignData> =>
  api('/v1/kol/campaigns', { method: 'POST', body: input, ...withAssignment(assignment) })

export const acceptKolCampaign = (
  approval_item_id: string,
  assignment?: string,
): Promise<KolCampaignAcceptData> =>
  api(`/v1/kol/campaigns/${encodeURIComponent(approval_item_id)}/accept`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const getKolMergeSuggestions = (
  assignment?: string,
): Promise<{ rows: KolMergeSuggestionData[] }> =>
  api('/v1/kol/merge-suggestions', withAssignment(assignment))

export const decideKolMerge = (
  id: string,
  decision: 'accept' | 'reject',
  assignment?: string,
): Promise<unknown> =>
  api(`/v1/kol/merge-suggestions/${encodeURIComponent(id)}/${decision}`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

/* ── WP117 交付 4：演练场 ─────────────────────────────────────────────── */

export interface KolSandboxData {
  on: boolean
  /** 演练世界现在几点（真时钟不动）。 */
  now: string
  creators: number
  collaborations: number
  sent: number
  replies: number
  pending: number
  /** 顶上那条状态带的字。**服务端给的那一句**，界面不自己拼。 */
  banner: string
}

export interface KolSandboxAdvanceData extends KolSandboxData {
  advanced_days: number
  received: {
    creator_id: string
    display_name: string
    collaboration_id?: string
    subject: string
    body: string
    at: string
    bounce_reason?: string
  }[]
}

export const getKolSandbox = (assignment?: string): Promise<KolSandboxData> =>
  api('/v1/kol/sandbox', withAssignment(assignment))

export const startKolSandbox = (
  channel: KolChannelId,
  assignment?: string,
): Promise<KolSandboxData> =>
  api('/v1/kol/sandbox', { method: 'POST', body: { channel }, ...withAssignment(assignment) })

export const advanceKolSandbox = (
  days: number,
  assignment?: string,
): Promise<KolSandboxAdvanceData> =>
  api('/v1/kol/sandbox/advance', {
    method: 'POST',
    body: { days },
    ...withAssignment(assignment),
  })

export const clearKolSandbox = (assignment?: string): Promise<KolSandboxData> =>
  api('/v1/kol/sandbox', { method: 'DELETE', ...withAssignment(assignment) })

/* ── WP117：交付物与追踪链接（路由早就有，之前界面上没有入口，66 断点 #11）── */

export const getKolDeliverables = (
  filter: { collaboration_id?: string; pending?: boolean } = {},
  assignment?: string,
): Promise<{ rows: KolDeliverableData[] }> => {
  const q = new URLSearchParams()
  if (filter.collaboration_id !== undefined) q.set('collaboration_id', filter.collaboration_id)
  if (filter.pending === true) q.set('pending', 'true')
  const tail = q.toString() === '' ? '' : `?${q.toString()}`
  return api(`/v1/kol/deliverables${tail}`, withAssignment(assignment))
}

export const reviewKolDeliverable = (
  id: string,
  input: { review: 'approved' | 'changes_requested' | 'rejected'; notes?: string },
  assignment?: string,
): Promise<KolStagedData> =>
  api(`/v1/kol/deliverables/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/**
 * WP117b（66 复测 #19）：**议价**——给一条已经在谈的合作报一个数。
 *
 * 回来的是一张 money 排版的卡（永远 L1）。**批了才作数**：预算与"进谈条件中"
 * 由施行那一跳写，这一下一个字都不落库。
 */
export const quoteKolCollaboration = (
  id: string,
  input: { budget: number; currency?: string; note?: string },
  assignment?: string,
): Promise<KolStagedData> =>
  api(`/v1/kol/collaborations/${encodeURIComponent(id)}/quote`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/**
 * WP117b（66 复测 #19）：登记一条交付物。
 *
 * 路由早就在那儿了（`POST /v1/kol/deliverables`），界面上一直没有入口——
 * 于是「交付物登记 → 验收」这半条链在界面上走不动（66 断点 #11 的剩余）。
 */
export const createKolDeliverable = (
  input: { collaboration_id: string; kind: string; due_at: string; url?: string },
  assignment?: string,
): Promise<KolDeliverableData> =>
  api('/v1/kol/deliverables', { method: 'POST', body: input, ...withAssignment(assignment) })

/** WP117b（66 复测 #19）：一条合作的往来信件，时间正序。 */
export const getKolExchanges = (
  filter: { collaboration_id?: string; creator_id?: string; limit?: number } = {},
  assignment?: string,
): Promise<{ rows: KolExchangeData[] }> => {
  const q = new URLSearchParams()
  if (filter.collaboration_id !== undefined) q.set('collaboration_id', filter.collaboration_id)
  if (filter.creator_id !== undefined) q.set('creator_id', filter.creator_id)
  if (filter.limit !== undefined) q.set('limit', String(filter.limit))
  const s = q.toString()
  return api(`/v1/kol/exchanges${s === '' ? '' : `?${s}`}`, withAssignment(assignment))
}

export const getKolTrackedLinks = (
  filter: { collaboration_id?: string } = {},
  assignment?: string,
): Promise<{ rows: KolTrackedLinkData[] }> => {
  const q =
    filter.collaboration_id === undefined
      ? ''
      : `?collaboration_id=${encodeURIComponent(filter.collaboration_id)}`
  return api(`/v1/kol/tracked-links${q}`, withAssignment(assignment))
}

export const createKolTrackedLink = (
  input: { collaboration_id: string; url: string; campaign?: string; affiliate_code?: string },
  assignment?: string,
): Promise<KolTrackedLinkData> =>
  api('/v1/kol/tracked-links', { method: 'POST', body: input, ...withAssignment(assignment) })

export interface KolTrackedLinkData {
  id: string
  collaboration_id: string
  url: string
  utm: { source: string; medium: string; campaign: string; term?: string; content?: string }
  affiliate_code?: string
  clicks: number
  orders: number
  revenue: number
}
/* ── WP85（54 §5）消息渠道：微信 ClawBot（个人）与企业微信机器人（团队）──── */

/**
 * 这五条不在 `packages/sdk` 生成的那一份里：它们还没进 `collectRoutes()`
 * 那份路由声明（见 WP85 报告的「契约改动」），所以这里直接用 `api()` 打。
 * 形状与服务端 `apps/server/src/im-channels.ts` 的那几个视图一一对应。
 */
export interface ImStatusView {
  wechat: {
    bound: boolean
    account_id?: string
    live: boolean
    paused_until?: string
    allowed: boolean
    reason?: string
  }
  wecom: { configured: boolean; connected: boolean; bot_id?: string; me_bound?: boolean }
  /** WP211：飞书 / 钉钉机器人（团队）。老服务端没有这两格。 */
  feishu?: ImTeamBotView & { app_id?: string; domain?: 'feishu' | 'lark' }
  dingtalk?: ImTeamBotView & { client_id?: string }
  /** WP211：能不能填 / 改 / 断开公司的应用凭据（负责人与公司管理员）。没有这一格按「不能」算。 */
  can_manage?: boolean
}

/** WP211：一条团队渠道的状态（不含任何凭据）。 */
export interface ImTeamBotView {
  configured: boolean
  connected: boolean
  state: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed'
  /** 连不上时的那句人话。 */
  error?: string
  /** 我自己在这条渠道上的账号绑上没有。 */
  me_bound: boolean
}

export type ImTeamChannel = 'wecom' | 'feishu' | 'dingtalk'

export interface ImLoginStart {
  login_id: string
  qrcode_url: string
  expires_at: string
}

export type ImLoginStatus =
  | 'waiting'
  | 'scanned'
  | 'need_verify_code'
  | 'verify_code_blocked'
  | 'confirmed'
  | 'already_connected'
  | 'expired'
  | 'failed'

export interface ImLoginPoll {
  login_id: string
  status: ImLoginStatus
  qrcode_url?: string
  account_id?: string
  user_id?: string
  message: string
}

export const getImStatus = (): Promise<ImStatusView> => api<ImStatusView>('/v1/im/status')

export const startWechatLogin = (): Promise<ImLoginStart> =>
  api<ImLoginStart>('/v1/im/wechat/login', { method: 'POST' })

export const pollWechatLogin = (id: string, verify_code?: string): Promise<ImLoginPoll> =>
  api<ImLoginPoll>(
    `/v1/im/wechat/login/${encodeURIComponent(id)}${
      verify_code === undefined ? '' : `?verify_code=${encodeURIComponent(verify_code)}`
    }`,
  )

/** 解绑 = 销毁本机那枚 token。 */
export const unbindWechat = (): Promise<{ unbound: boolean; account_id?: string }> =>
  api('/v1/im/wechat', { method: 'DELETE' })

/**
 * 企业微信的 BotID + Secret。
 *
 * **值只在这一次调用里存在**：调用方用原生 `<form>` 的 `FormData` 收，
 * 不进 React state、不进任何全局变量，提交完立刻 `form.reset()`（13 §4.3）。
 */
export const saveWecomBot = (values: {
  bot_id: string
  secret: string
}): Promise<{ configured: boolean; bot_id: string }> =>
  api('/v1/im/wecom', { method: 'PUT', body: values })

/* ── WP211：飞书 / 钉钉（公司的）与「绑定我的账号」 ─────────────────────── */

/** 飞书应用的 App ID + App Secret（同上：原生表单收，提交完 reset，不进 state）。 */
export const saveFeishuBot = (values: {
  app_id: string
  app_secret: string
  domain?: 'feishu' | 'lark'
}): Promise<{ configured: boolean; app_id: string }> =>
  api('/v1/im/feishu', { method: 'PUT', body: values })

/** 断开 = 销毁本机那份 App Secret。 */
export const removeFeishuBot = (): Promise<{ removed: boolean }> =>
  api('/v1/im/feishu', { method: 'DELETE' })

/** 钉钉应用的 Client ID + Client Secret。 */
export const saveDingtalkBot = (values: {
  client_id: string
  client_secret: string
}): Promise<{ configured: boolean; client_id: string }> =>
  api('/v1/im/dingtalk', { method: 'PUT', body: values })

export const removeDingtalkBot = (): Promise<{ removed: boolean }> =>
  api('/v1/im/dingtalk', { method: 'DELETE' })

/** 拿一个 6 位绑定码（10 分钟有效、只能用一次），私聊机器人发「绑定 123456」。 */
export const issueImBindCode = (): Promise<{ code: string; expires_at: string }> =>
  api('/v1/im/bind-code', { method: 'POST' })

/** 解绑我在这条渠道上的聊天账号。 */
export const unbindImAccount = (channel: ImTeamChannel): Promise<{ removed: number }> =>
  api(`/v1/im/bind/${channel}`, { method: 'DELETE' })

/* ── WP73（56 §6）：社媒库 `/v1/social/*` ───────────────────────────────── */

/** 各条渠道（真源是契约的 `SOCIAL_CHANNELS`；工作台不依赖服务端包，这里照抄一份）。 */
export type SocialChannelId =
  | 'meta'
  | 'tiktok'
  | 'x'
  | 'youtube'
  // WP191（docs/86 §5）：Meta 拆成 FB 主页 + IG，另加 Threads 与 LinkedIn（`meta` 留着认老数据）
  | 'facebook'
  | 'instagram'
  | 'threads'
  | 'linkedin'
  | 'facebook_group'
  | 'reddit'
  | 'discord'
  | 'telegram_group'
  | 'whatsapp'

/** 周视图上的一格。 */
export interface SocialCalendarCellData {
  post_id: string
  account_id: string
  account_name: string
  channel: SocialChannelId
  kind: string
  status: 'draft' | 'scheduled' | 'published' | 'failed'
  scheduled_at: string
  preview: string
  /** 撞车说明（空数组 = 没撞）。服务端当场算的，界面不自己判。 */
  conflicts: string[]
}

export interface SocialCalendarData {
  from: string
  to: string
  channels: SocialChannelId[]
  cells: SocialCalendarCellData[]
}

export interface SocialAccountData {
  id: string
  channel: SocialChannelId
  handle: string
  display_name: string
  url: string
  external_id: string
  followers?: number
  member_count?: number
}

export interface SocialStagedData {
  staged: boolean
  change_id?: string
  approval_item_id?: string
  message?: string
  level?: string
}

export interface SocialPostData {
  post: {
    id: string
    account_id: string
    channel: SocialChannelId
    kind: string
    status: string
    body: string
    scheduled_at?: string
  }
  conflicts: string[]
  next_free_slot?: string
  staged: SocialStagedData
}

export interface SocialBroadcastData {
  channel: SocialChannelId
  account_id: string
  audience_size: number
  suppressed: number
  too_soon: number
  /** 卡面上那一句（"342 人收，剔了 18 个"）。 */
  note: string
  /** 提交前的自查：不为空 = 别提交，先把这些解决掉。 */
  problems: string[]
  staged: SocialStagedData
}

export const getSocialCalendar = (
  range: { from?: string; to?: string } = {},
  assignment?: string,
): Promise<SocialCalendarData> => {
  const q = new URLSearchParams()
  if (range.from !== undefined) q.set('from', range.from)
  if (range.to !== undefined) q.set('to', range.to)
  const s = q.toString()
  return api(`/v1/social/calendar${s === '' ? '' : `?${s}`}`, withAssignment(assignment))
}

export const getSocialAccounts = (
  filter: { channel?: SocialChannelId } = {},
  assignment?: string,
): Promise<{ rows: SocialAccountData[] }> => {
  const q = new URLSearchParams()
  if (filter.channel !== undefined) q.set('channel', filter.channel)
  const s = q.toString()
  return api(`/v1/social/accounts${s === '' ? '' : `?${s}`}`, withAssignment(assignment))
}

export const createSocialPost = (
  input: { account_id: string; kind: string; body: string; scheduled_at?: string },
  assignment?: string,
): Promise<SocialPostData> =>
  api('/v1/social/posts', { method: 'POST', body: input, ...withAssignment(assignment) })

/** 周视图上拖一下 = 改排期。换个时间发也是一次发布，所以服务端会重新出一张卡。 */
export const rescheduleSocialPost = (
  id: string,
  scheduled_at: string,
  assignment?: string,
): Promise<SocialPostData> =>
  api(`/v1/social/posts/${encodeURIComponent(id)}/schedule`, {
    method: 'PATCH',
    body: { scheduled_at },
    ...withAssignment(assignment),
  })

/** 群发向导那一下：算受众 → 出群发卡（**永远 L1**）。 */
export const createSocialBroadcast = (
  input: {
    account_id: string
    body: string
    audience: 'all' | 'tagged' | 'active_30d'
    tag?: string
    template_id?: string
    opt_in_verified?: boolean
  },
  assignment?: string,
): Promise<SocialBroadcastData> =>
  api('/v1/social/broadcasts', { method: 'POST', body: input, ...withAssignment(assignment) })

// ── WP90（55 §9 Q8）：用 ChatGPT / Claude 的订阅登录 ─────────────────────

/** 能用订阅登录的两家。 */
export type SubscriptionProviderId = 'openai-codex' | 'anthropic'

/** 登录方式：设备码（在手机上输一串码）或浏览器（本机回调）。 */
export type SubscriptionMethod = 'device' | 'browser'

/**
 * 一家订阅登录现在的样子。
 *
 * **这里没有、也不会有 token 字段**——服务端只给四样：登没登录、账号**脱敏后**
 * 的样子、什么时候过期、现在进行到哪一步。
 */
export interface SubscriptionData {
  provider: SubscriptionProviderId
  label: string
  summary: string
  methods: SubscriptionMethod[]
  /** 固定的白话风险提示（卡上一定要显示，不在前端重写一遍）。 */
  risk_note: string
  available: boolean
  unavailable_reason?: string
  signed_in: boolean
  account?: string
  expires_at?: string
  in_flight: boolean
  notice?: { message: string; url?: string; code?: string }
  question?: { kind: 'text' | 'secret'; message: string; placeholder?: string }
  last_error?: string
  models: { id: string; name: string }[]
  selected_model?: string
}

export const listModelSubscriptions = (
  assignment?: string,
): Promise<{ providers: SubscriptionData[] }> =>
  api('/v1/settings/models/subscription', withAssignment(assignment))

export const getModelSubscription = (
  provider: SubscriptionProviderId,
  assignment?: string,
): Promise<SubscriptionData> =>
  api(
    `/v1/settings/models/subscription/${encodeURIComponent(provider)}`,
    withAssignment(assignment),
  )

export const startModelSubscriptionLogin = (
  input: { provider: SubscriptionProviderId; method: SubscriptionMethod },
  assignment?: string,
): Promise<SubscriptionData> =>
  api('/v1/settings/models/subscription/login', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** 把浏览器里的授权码贴回来。值只走这一次——不进 state、不进 query key。 */
export const answerModelSubscriptionLogin = (
  provider: SubscriptionProviderId,
  value: string,
  assignment?: string,
): Promise<SubscriptionData> =>
  api(`/v1/settings/models/subscription/${encodeURIComponent(provider)}/answer`, {
    method: 'POST',
    body: { value },
    ...withAssignment(assignment),
  })

export const selectModelSubscriptionModel = (
  provider: SubscriptionProviderId,
  model: string,
  assignment?: string,
): Promise<SubscriptionData> =>
  api(`/v1/settings/models/subscription/${encodeURIComponent(provider)}/model`, {
    method: 'PUT',
    body: { model },
    ...withAssignment(assignment),
  })

export const signOutModelSubscription = (
  provider: SubscriptionProviderId,
  assignment?: string,
): Promise<{ signed_out: true }> =>
  api(`/v1/settings/models/subscription/${encodeURIComponent(provider)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

// ── WP92：「我正在用的浏览器」（腾讯 BrowserSkill，55 §10）───────────────
//
// 两条路由，对着设置页那三步向导：
// ① 装扩展 —— 没有 API，商店链接写在界面上；
// ② 装 `bsk` —— `installBrowserSkill()`（版本与 sha256 钉死在 browserskill.lock.json）；
// ③ 检查 —— `getBrowserSkillStatus()` 跑一次 `bsk doctor --json`，把它那几条原样端出来。

/** `bsk doctor` 的一条检查（形状照抄上游 CLI 的 JSON）。 */
export interface BrowserSkillCheck {
  name: string
  ok: boolean
  status: 'ok' | 'fail' | 'warn' | 'na'
  detail: string
  hint?: string
}

export interface BrowserSkillStatus {
  installed: boolean
  bsk_path?: string
  version?: string
  pinned_version?: string
  checks: BrowserSkillCheck[]
  ok: boolean
  detail?: string
}

/** 跑一次 `bsk doctor`（daemon 起没起、扩展连没连）。 */
export const getBrowserSkillStatus = (assignment?: string): Promise<BrowserSkillStatus> =>
  api('/v1/settings/browser/browserskill', withAssignment(assignment))

/** 装 `bsk`（下载 → 校验 sha256 → 放进数据目录；校验不过什么都不装）。 */
export const installBrowserSkill = (assignment?: string): Promise<BrowserSkillStatus> =>
  api('/v1/settings/browser/browserskill/install', {
    method: 'POST',
    ...withAssignment(assignment),
  })

// ── WP95（36 §11）：第三栏两个新面板的取数口 ─────────────────────────
//
// 两条都是**只读投影**：
// ① 运行中的浏览器（`sidebar-compare` #12 / #15）——事件日志折出来的那五格；
// ② 变更审阅（#11）——主题工作副本目录的 `git diff`，逐文件。
//
// 面板不缓存它们（第三栏只存结构不存内容，40 §1.2）：刷新之后按作用域重新取。

export type {
  ChangeFileDiff,
  ChangeFilesView,
  RunBrowserView,
  StagedChange,
} from '@agentsws/contracts'

// 文件开头那一摞 import 不动（这个文件是多条 WP 共同的末尾追加区），
// 用 `import(...)` 型别引用把三个契约类型拿进来。
type RunBrowserViewType = import('@agentsws/contracts').RunBrowserView
type ChangeFilesViewType = import('@agentsws/contracts').ChangeFilesView
type StagedChangeType = import('@agentsws/contracts').StagedChange

/** 这次运行的浏览器在干什么（哪种执行器、当前域、最近一次导航 / 拒绝、等不等人接管）。 */
export const getRunBrowser = (run_id: string, assignment?: string): Promise<RunBrowserViewType> =>
  api(`/v1/runs/${encodeURIComponent(run_id)}/browser`, withAssignment(assignment))

/** 这条变更改了哪几个文件、每个文件改了哪几行。 */
export const getChangeFiles = (
  change_id: string,
  assignment?: string,
): Promise<ChangeFilesViewType> =>
  api(`/v1/changes/${encodeURIComponent(change_id)}/files`, withAssignment(assignment))

/** 变更账本查询（第三栏的变更审阅按事项 / 运行筛一遍）。 */
export const listChanges = (
  query: { run?: string; kind?: string; status?: string },
  assignment?: string,
): Promise<StagedChangeType[]> => {
  const params = new URLSearchParams()
  if (query.run !== undefined) params.set('run', query.run)
  if (query.kind !== undefined) params.set('kind', query.kind)
  if (query.status !== undefined) params.set('status', query.status)
  const qs = params.toString()
  return api(`/v1/changes${qs === '' ? '' : `?${qs}`}`, withAssignment(assignment))
}

// ── WP97（36 §11，`docs/upstream/sidebar-compare.md` #13）：第三栏 Office 预览 ──
//
// 两条：列知识库的导入源（点哪一份），与**按 source_id 取原件字节**。
// 字节这一条不走 `api()`——那个函数只解 JSON，而这里要的是 `Blob`。
// 与 `exportKnowledgePack` 同形（都得自己拼 `Authorization` / `X-Assignment`：
// 直接把 `<a href="/v1/...">` 摆上去那一发不带头，浏览器档会 401）。

type KnowledgeSourceRow = import('@agentsws/contracts').KnowledgeSource

export type { KnowledgeSource } from '@agentsws/contracts'

/** 19 §1.3 导入源清单（知识库页的"上传的文件"那一块列的就是它们）。 */
export const listKnowledgeSources = (assignment?: string): Promise<KnowledgeSourceRow[]> =>
  api('/v1/knowledge/sources', withAssignment(assignment))

/**
 * 一次取原件的结果。
 *
 * `too_large` 是**没取正文**的那一档：看完 `Content-Length` 就把响应体取消掉，
 * 20 MB 的表格一个字节都不进浏览器内存。这时 `blob` 是空的，界面只给"下载原件"。
 */
export interface SourceFileResult {
  filename: string
  size: number
  content_type: string
  too_large: boolean
  blob?: Blob
}

/**
 * 预览这一侧的大小闸（20 MB）。
 *
 * 服务端那道闸是 64 MB 的**内存闸**（`apps/server/src/knowledge-file.ts`），两道分开：
 * 太大的文件预览不了，但"下载原件"仍然要能点。
 */
export const PREVIEW_MAX_BYTES = 20 * 1024 * 1024

/** `attachment; filename="a.docx"; filename*=UTF-8''a.docx` → `a.docx`。 */
function filenameFromDisposition(header: string | null): string | undefined {
  if (header === null) return undefined
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (star?.[1] !== undefined) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      // 服务端写坏了就当没有这一格，往下用 ASCII 那一份
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1]
}

/**
 * 取一个导入源的原件。
 *
 * `limit` 给 0 表示"只要元数据不要正文"（下载按钮要显示大小时用）。
 */
export async function getKnowledgeSourceFile(
  source_id: string,
  options: { limit?: number; assignment?: string } = {},
): Promise<SourceFileResult> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = options.assignment ?? currentAssignment
  if (asg !== null) headers.set('X-Assignment', asg)
  const res = await fetch(`/v1/knowledge/sources/${encodeURIComponent(source_id)}/file`, {
    headers,
  })
  if (!res.ok) throw new ApiClientError(res.status, (await res.json()) as ApiErrorBody)
  const declared = Number(res.headers.get('content-length') ?? '0')
  const filename = filenameFromDisposition(res.headers.get('content-disposition')) ?? source_id
  const content_type = res.headers.get('content-type') ?? 'application/octet-stream'
  const limit = options.limit ?? PREVIEW_MAX_BYTES
  if (Number.isFinite(declared) && declared > limit) {
    // 取消而不是读完再丢：读完再丢等于内存已经付过一次了
    await res.body?.cancel()
    return { filename, size: declared, content_type, too_large: true }
  }
  const blob = await res.blob()
  return { filename, size: blob.size, content_type, too_large: false, blob }
}

// ── WP99（19 §1.3「上传」）：知识库的**写口** ─────────────────────────
//
// WP97 只有读（列清单 + 按 id 取原件字节），`kind: 'upload'` 的源只有 demo 在造。
// 这两条把写补上：传一份文件进来、删一份。
//
// 上传不走 `api()`（那个函数发 JSON），与 `importKnowledgePack` 同形：
// 自己拼 `Authorization` / `X-Assignment`，`content-type` 交给浏览器填
// （multipart 要带 boundary，手写一个准错）。

/**
 * 前端这一侧的单份上限（64 MB），与服务端两道闸**同一个数**
 * （`apps/server/src/knowledge-upload.ts` 的 `UPLOAD_MAX_BYTES`
 * 与 `knowledge-file.ts` 的 `SOURCE_FILE_MAX_BYTES`）。
 *
 * 前端先拦一道不是为了安全（谁都能绕过去），是为了**别让人等**：
 * 一份 300 MB 的文件传上去再被拒，人已经等了两分钟。
 */
export const UPLOAD_MAX_BYTES = 64 * 1024 * 1024

/** 服务端收哪几种（与 `UPLOAD_EXTENSIONS` 同一份表；`<input accept>` 与前端预检都用它）。 */
export const UPLOAD_EXTENSIONS = ['docx', 'xlsx', 'xls', 'csv', 'pptx', 'pdf', 'md', 'txt'] as const

/** `.docx,.xlsx,…`——直接喂给 `<input type="file" accept>`。 */
export const UPLOAD_ACCEPT = UPLOAD_EXTENSIONS.map((e) => `.${e}`).join(',')

/** 传一份文件进知识库；回登记好的那条源（列表立刻就能显示它）。 */
export async function uploadKnowledgeSource(
  file: File,
  assignment?: string,
): Promise<KnowledgeSourceRow> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = assignment ?? currentAssignment
  if (asg !== null) headers.set('X-Assignment', asg)
  const form = new FormData()
  form.append('file', file)
  const res = await fetch('/v1/knowledge/sources/upload', { method: 'POST', headers, body: form })
  const text = await res.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  if (!res.ok) throw new ApiClientError(res.status, parsed as ApiErrorBody)
  return (parsed as ApiEnvelope<KnowledgeSourceRow>).data
}

/** 删一份（21 的擦除语义：字节真删、行留墓碑）。 */
export const deleteKnowledgeSource = (
  source_id: string,
  assignment?: string,
): Promise<{ deleted: true; id: string }> =>
  api(`/v1/knowledge/sources/${encodeURIComponent(source_id)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

// ── 09-18：向导第 ② 步 / 本人改名 ──────────────────────────────────────────
/** 改本人的展示名（`PUT /v1/me`）。登录邮箱是身份，不在这里改。 */
export const renameMe = (name: string, assignment?: string): Promise<{ person: Me['person'] }> =>
  api('/v1/me', { method: 'PUT', body: { name }, ...withAssignment(assignment) })

/* ── WP113（63）：消息——统一收件处 ────────────────────────────────────── */

/** 一只邮箱在消息页上的样子（"全部邮箱"那一排）。 */
export interface MessageAccountView {
  address: string
  unread: number
  folders: MessageFolder[]
  backfill_floor: string
  /** WP163：最近一次没动成的邮箱动作（判成客服的信标已读 / 挪进客服文件夹）。 */
  last_mailbox_failure?: {
    at: string
    action: 'mark_read' | 'move'
    /** 原因码：`server_refused` / `error` / `unsupported` …（界面翻成人话）。 */
    reason: string
    folder: string
    to_folder?: string
  }
  /** WP172：这只邮箱收 B2B 信（B2B 岗位开着 + 邮箱卡上「收 B2B 信」开着）——左栏据此画「B2B 往来」。 */
  b2b?: boolean
  /** WP204：影子模式开着（只看不动）——归档 / 删除置灰，已读 / 星标只在本机标。 */
  shadow_mode?: boolean
}

/** 打开一条会话时一次拿全（正文 + 状态带）。 */
export interface MessageThreadView {
  thread_id: string
  subject: string
  messages: MessageRecord[]
  /**
   * 63 §9：`KefuAgents` / `KOLAgents` 里的信顶上那条状态带。
   * 不为空 = 这一页**不给"直接回复"**（避免人与 Agent 撞车）。
   */
  agent_status?: {
    route: 'support' | 'kol' | 'b2b'
    state: 'working' | 'waiting_for_you' | 'replied'
    href?: string
    takeover_matter_id?: string
  }
  /** WP212：这条会话归谁（没人接 / 只是通知 / 已交出去；服务端派生）。 */
  claim?: MessageClaim
  claim_message_id?: string
  /** WP212：交给了谁（岗位模板 id，或 `me` / `notice`）。 */
  handed_to?: string
  /** WP212：卡片流里还有几张卡等你批、跳过去的链接。 */
  open_card_count?: number
  card_link?: string
  suggest?: MessageSuggest
  kind?: MessageKind
}

/** 右栏 `mail-assistant` 那一格（一次取全，前端不发第二个请求）。 */
export interface MailAssistantView {
  message_id: string
  summary: string
  /**
   * 这封信要不要回。
   *
   * 与 `suggestions` 分开给：一台没接模型的机器上 `suggestions` 永远是空数组，
   * 只看它的话界面会对每封信都说"这封信看起来不用回"——那是假的。
   */
  needs_reply: boolean
  suggestions: ReplySuggestion[]
  sender: {
    address: string
    name?: string
    history_count: number
    linked: { type: string; id: string; label: string }[]
  }
  todos: { id: string; title: string; status: string }[]
  model_available: boolean
  /** WP212：兜底助手——岗位在办的（`handed`）不生成建议，只挂「X 在办 · 有 N 张卡等你 →」。 */
  claim?: MessageClaim
  handed_to?: string
  open_card_count?: number
  card_link?: string
}

/** 会话列表的查询串（筛选、搜索、多邮箱都走它）。 */
export function messageQuery(q: {
  folder?: string
  folder_kind?: string
  account?: string
  label?: string
  unread?: boolean
  starred?: boolean
  q?: string
  /** WP167：只看「待确认」。 */
  pending_route?: boolean
  /** WP212：只看「没人接的」/「只是通知」。 */
  claim?: 'unclaimed' | 'notice'
  limit?: number
}): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === '' || v === false) continue
    params.set(k, String(v))
  }
  const s = params.toString()
  return s === '' ? '' : `?${s}`
}

export const listMessageAccounts = (): Promise<{ accounts: MessageAccountView[] }> =>
  api('/v1/messages/accounts')

export const listMessageThreads = (query = ''): Promise<{ threads: MessageThreadSummary[] }> =>
  api(`/v1/messages${query}`)

export const getMessageThread = (thread_id: string): Promise<MessageThreadView> =>
  api(`/v1/messages/threads/${encodeURIComponent(thread_id)}`)

export const getMailAssistant = (id: string): Promise<MailAssistantView> =>
  api(`/v1/messages/${encodeURIComponent(id)}/assistant`)

export const setMessageFlags = (
  id: string,
  input: { read?: boolean; starred?: boolean; answered?: boolean },
): Promise<{ message: MessageRecord; writeback?: MessageWriteback }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/flags`, { method: 'POST', body: input })

/** 挪一封信。**删除 = `to: 'trash'`**，没有第二种去处（63 §7）。 */
export const moveMessage = (
  id: string,
  input: { to: MessageFolderKind; remember_sender?: boolean },
): Promise<{ message: MessageRecord; rule?: SenderRule; writeback?: MessageWriteback }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/move`, { method: 'POST', body: input })

/**
 * WP167：「待确认」里人点的那一下（人工分拣）。「这是客服」交给客服那一路（开事项、起 Run），
 * 「不是」只记人的判断。交不出去（客服岗位没开）时 `handed_off: false`，信原样不动。
 */
export const confirmMessageRoute = (
  id: string,
  route: 'support' | 'kol' | 'b2b' | 'inbox',
): Promise<{ message: MessageRecord; handed_off: boolean; matter_id?: string }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/confirm-route`, {
    method: 'POST',
    body: { route },
  })

/**
 * WP212：「交给 X」——推广到所有岗位（岗位模板 id）。客服 / 红人 / B2B 走 63 的老路，
 * 其余走 54 的「交给这个岗位一件事」。交不出去时 `handed_off: false` + 一句人话。
 */
export const handMessageToPosition = (
  id: string,
  position_id: string,
  remember_sender: boolean,
): Promise<{
  message: MessageRecord
  handed_off: boolean
  matter_id?: string
  position_id?: string
  refused?: string
  rule?: SenderRule
}> =>
  api(`/v1/messages/${encodeURIComponent(id)}/confirm-route`, {
    method: 'POST',
    body: { route: 'position', position_id, remember_sender },
  })

/** WP212：改判类型（✎）；`remember_sender` = 以后这个发件人都这样。 */
export const setMessageKind = (
  id: string,
  kind: MessageKind,
  remember_sender: boolean,
): Promise<{ message: MessageRecord; rule?: SenderRule }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/kind`, {
    method: 'POST',
    body: { kind, remember_sender },
  })

/** WP212：「只是通知」/「我自己处理」/ 撤销。 */
export const claimMessage = (
  id: string,
  as: 'notice' | 'me' | 'none',
): Promise<{ message: MessageRecord; writeback?: MessageWriteback }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/claim`, { method: 'POST', body: { as } })

/** WP212：「只是通知」整捆「知道了」。 */
export const ackMessageNotices = (input: {
  kind?: MessageKind
  suspicious?: boolean
  thread_ids?: string[]
}): Promise<{ acked: number; writeback?: MessageWriteback }> =>
  api('/v1/messages/notices/ack', { method: 'POST', body: input })

/** WP212：「没人接的」顶上那一行、只是通知几捆、你教过它。 */
export const getMessageOverview = (): Promise<MessageOverview> => api('/v1/messages/overview')

export const setMessageLabels = (
  id: string,
  labels: string[],
): Promise<{ message: MessageRecord }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/labels`, { method: 'POST', body: { labels } })

export const showMessageImages = (
  id: string,
  always: boolean,
): Promise<{ message: MessageRecord; images?: MessageImagesReport }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/images`, { method: 'POST', body: { always } })

/**
 * WP204：下载一个附件。字节这一条不走 `api()`（那个只解 JSON），与知识库原件同形：
 * 自己拼 `Authorization` / `X-Assignment`，拿到字节后让浏览器存成文件——不在页面里打开。
 */
export async function downloadMessageAttachment(
  id: string,
  attachment_id: string,
  name: string,
): Promise<void> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  if (currentAssignment !== null) headers.set('X-Assignment', currentAssignment)
  const res = await fetch(
    `/v1/messages/${encodeURIComponent(id)}/attachments/${encodeURIComponent(attachment_id)}`,
    { headers },
  )
  if (!res.ok) throw new ApiClientError(res.status, (await res.json()) as ApiErrorBody)
  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => {
    URL.revokeObjectURL(url)
  }, 1000)
}

export const listMessageLabels = (): Promise<{ labels: MessageLabel[] }> =>
  api('/v1/messages/labels')

export const saveMessageDraft = (input: {
  id?: string
  account?: string
  thread_id?: string
  in_reply_to?: string
  to?: { email: string; name?: string }[]
  cc?: { email: string; name?: string }[]
  bcc?: { email: string; name?: string }[]
  subject?: string
  text?: string
}): Promise<{ draft: MessageDraft }> => api('/v1/messages/drafts', { method: 'POST', body: input })

export const discardMessageDraft = (id: string): Promise<{ deleted: boolean }> =>
  api(`/v1/messages/drafts/${encodeURIComponent(id)}`, { method: 'DELETE' })

/** **人自己按的发送**。不出卡（36「只有要人拍板的才是卡」）。 */
export const sendMessage = (input: {
  draft_id?: string
  account?: string
  thread_id?: string
  in_reply_to?: string
  to?: { email: string; name?: string }[]
  cc?: { email: string; name?: string }[]
  bcc?: { email: string; name?: string }[]
  subject?: string
  text?: string
}): Promise<MessageSendResult> => api('/v1/messages/send', { method: 'POST', body: input })

export const messageToTodo = (id: string): Promise<{ todo: Todo }> =>
  api(`/v1/messages/${encodeURIComponent(id)}/todo`, { method: 'POST', body: {} })

export const syncMessages = (): Promise<MessageSyncReport> =>
  api('/v1/messages/sync', { method: 'POST', body: {} })

export const backfillMessages = (input: {
  account?: string
  days?: number
}): Promise<{ floor: string }> => api('/v1/messages/backfill', { method: 'POST', body: input })

/* ── WP122（71）：品牌设计规范 DESIGN.md ──────────────────────────────── */

/**
 * 这个品牌当前的那一份。**还没抓过就是 `null`**，不是一个空壳——
 * 界面按"在不在"决定画空状态还是画色板（36 §3：没有就明说没有，不画一个 0）。
 */
export const getBrandDesign = (): Promise<BrandDesignDoc | null> =>
  api<BrandDesignDoc | null>('/v1/brand-design')

/** 从官网抓一轮（不带 urls 时复用上一轮分析抓回来的页面，一个页面都不重抓）。 */
export const extractBrandDesign = (input: { urls?: string[] } = {}): Promise<BrandDesignRun> =>
  api<BrandDesignRun>('/v1/brand-design/extract', { method: 'POST', body: input })

/** 读一份已经传上来的品牌手册（`upload_id` 来自知识上传那条路）。 */
export const ingestBrandDesignFile = (upload_id: string): Promise<BrandDesignRun> =>
  api<BrandDesignRun>('/v1/brand-design/files', { method: 'POST', body: { upload_id } })

/** 改一格。`value` 给 `null` = 这一格我不要。 */
export const editBrandDesignToken = (path: string, value: unknown): Promise<BrandDesignDoc> =>
  api<BrandDesignDoc>(`/v1/brand-design/tokens/${encodeURIComponent(path)}`, {
    method: 'PATCH',
    body: { path, value },
  })

/** 整份粘贴替换。 */
export const replaceBrandDesign = (markdown: string): Promise<BrandDesignDoc> =>
  api<BrandDesignDoc>('/v1/brand-design', { method: 'PUT', body: { markdown } })

/** 版本历史。 */
export const listBrandDesignRevisions = (): Promise<BrandDesignRevision[]> =>
  api<BrandDesignRevision[]>('/v1/brand-design/revisions')
// ── WP121b（70 §3）：贴一个网址，自动填品牌档案 ────────────────────────
//
// 五条对着向导第 ② 步的五个动作：**发起 → 看进度 → 拿结果 → 确认 → 重新分析**。
// 契约形状在 `@agentsws/contracts`（`BrandIntakeRun`），这里一个字段都不重画——
// 界面认的就是服务端认的那一份。

type BrandIntakeRunView = import('@agentsws/contracts').BrandIntakeRun

export type {
  BrandIntakeConfidence,
  BrandIntakeEvidence,
  BrandIntakeFailureKind,
  BrandIntakeField,
  BrandIntakePage,
  BrandIntakePolicy,
  BrandIntakeProduct,
  BrandIntakeProfile,
  BrandIntakeRun,
  BrandIntakeRunStatus,
  BrandIntakeSocialLink,
} from '@agentsws/contracts'

/** 发起一次：贴 1–3 条链接（官网 / Amazon 商品 / Amazon 店铺）。 */
export const startBrandIntake = (
  /**
   * WP240：`storefront_password` 是用户在原生表单里填的 Shopify 店铺访问密码——只随这一次请求
   * 发给本机服务、只用于这一次抓取；界面不存、不进缓存、不进 URL。
   */
  input: { urls: string[]; cap_credits?: number; storefront_password?: string },
  assignment?: string,
): Promise<BrandIntakeRunView> =>
  api('/v1/brand-intake/runs', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** 这一次跑到哪儿了（向导按它轮询，呼吸标记表示"Agent 在干活"）。 */
export const getBrandIntake = (id: string, assignment?: string): Promise<BrandIntakeRunView> =>
  api(`/v1/brand-intake/runs/${encodeURIComponent(id)}`, withAssignment(assignment))

/**
 * 这个工作区最近的那一次。
 *
 * 向导第 ② 步回来时按它恢复现场——用户可以先去第 ③ 步选岗位，回来还看得见
 * 那一轮分析的结果。没有过就是 `null`（**不是错误**）。
 */
export const latestBrandIntake = (assignment?: string): Promise<BrandIntakeRunView | null> =>
  api('/v1/brand-intake/runs/latest', withAssignment(assignment))

/**
 * 「看着没问题」。
 *
 * `edits` **只带用户改过的那几格**：没带的按分析结果走，带了的在库里打上
 * `edited`，以后重新分析整格跳过（70 §3.4）。
 */
export const confirmBrandIntake = (
  id: string,
  edits: Record<string, unknown> | undefined,
  assignment?: string,
): Promise<BrandIntakeRunView> =>
  api(`/v1/brand-intake/runs/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
    body: edits === undefined ? {} : { edits },
    ...withAssignment(assignment),
  })

/** WP242：读不到网站时就地手填的那几格（与档案卡同名）。 */
export interface ManualBrandProfile {
  brand_name?: string
  one_liner?: string
  support_email?: string
  currency?: string
  markets?: string[]
}

/** WP242：就地手填品牌资料——与「看着没问题」同一条写法，回一条已确认的 run。 */
export const manualBrandIntake = (
  edits: ManualBrandProfile,
  assignment?: string,
): Promise<BrandIntakeRunView> =>
  api('/v1/brand-intake/manual', {
    method: 'POST',
    body: { edits },
    ...withAssignment(assignment),
  })

/** 重新分析（改了网址或换了新品时用）：**用户手改过的格子整格不动**。 */
export const reanalyzeBrandIntake = (
  id: string,
  urls: string[] | undefined,
  assignment?: string,
  /** WP240：店铺访问密码（同 `startBrandIntake`，只用于这一次抓取）。 */
  storefront_password?: string,
): Promise<BrandIntakeRunView> =>
  api(`/v1/brand-intake/runs/${encodeURIComponent(id)}/reanalyze`, {
    method: 'POST',
    body: {
      ...(urls === undefined ? {} : { urls }),
      ...(storefront_password === undefined ? {} : { storefront_password }),
    },
    ...withAssignment(assignment),
  })

/*
 * WP119（68）：浏览器插件（连接页「浏览器插件」那一节）。
 *
 * 三条都是**所有者**的事（与连接、数据后端同一把闸），所以一律显式带
 * 所有者那条 Assignment，不跟着左栏当前选中的岗位走（同 `listConnections`）。
 *
 * 配对码明文**只在生成那一次的响应里出现**：这里不写 localStorage、
 * 不进 query 缓存的持久层、不进 URL——它在屏幕上活 5 分钟，然后就没了。
 */
export interface ExtensionTokenView {
  id: string
  label: string
  /** 绑死的扩展 id（浏览器说的，不是插件自己说的）。 */
  extension_id: string
  scopes: string[]
  created_at: string
  expires_at: string
  last_used_at?: string
  revoked_at?: string
}

export interface ExtensionPairingView {
  /** 6 位数字。只在这一次响应里出现。 */
  code: string
  expires_at: string
}

export const listExtensionTokens = (
  assignment?: string,
): Promise<{ tokens: ExtensionTokenView[]; kol_role_held?: boolean }> =>
  // WP202：`kol_role_held`（只加）——这个品牌还没人持有红人职责时是 false
  api<{ tokens: ExtensionTokenView[]; kol_role_held?: boolean }>(
    '/v1/extension/tokens',
    withAssignment(assignment),
  )

export const createExtensionPairing = (
  assignment?: string,
  label?: string,
): Promise<ExtensionPairingView> =>
  api<ExtensionPairingView>('/v1/extension/pairings', {
    method: 'POST',
    body: label === undefined ? {} : { label },
    ...withAssignment(assignment),
  })

export const revokeExtensionToken = (
  id: string,
  assignment?: string,
): Promise<ExtensionTokenView> =>
  api<ExtensionTokenView>(`/v1/extension/tokens/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    body: {},
    ...withAssignment(assignment),
  })

/* ── WP120（69 §4）：角色定位 ─────────────────────────────────────────────── */

/** 一段 persona 的正文。中英各一份；老的纯字符串写法也认（契约只加不删）。 */
export type PersonaTextData = string | { zh: string; en: string }

/** 右栏「角色」面板要的那一份：现在生效的 + 包里的原文（「还原」拿它比）。 */
export interface PersonaViewData {
  subject: { kind: 'position' | 'role'; id: string }
  name: { zh: string; en: string }
  /** 现在真正进系统提示的那一份。 */
  effective: PersonaTextData
  /** 包里自带的原文。 */
  packaged: PersonaTextData
  /** 公司改写过吗。 */
  overridden: boolean
  /** WP226：现在生效的中文还没有对应的英文（英文界面显示中文 + 「未翻译」）。 */
  untranslated?: boolean
  updated_at?: string
  updated_by?: string
}

export const getPersona = (
  kind: 'position' | 'role',
  id: string,
  assignment?: string,
): Promise<PersonaViewData> =>
  api<PersonaViewData>(
    `/v1/personas?kind=${encodeURIComponent(kind)}&id=${encodeURIComponent(id)}`,
    withAssignment(assignment),
  )

/**
 * 公司层改写。WP226（69 §4.1）：**只改中文**——英文由中文翻译生成；改完还没翻的那段时间，
 * 视图上 `untranslated` 为真，英文界面显示中文原文 + 「未翻译」。`en` 留着是契约只加不删。
 */
export const setPersona = (
  input: { kind: 'position' | 'role'; id: string; zh?: string; en?: string },
  assignment?: string,
): Promise<PersonaViewData> =>
  api<PersonaViewData>('/v1/personas', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

/** 还原成包里的原文。 */
export const revertPersona = (
  input: { kind: 'position' | 'role'; id: string },
  assignment?: string,
): Promise<PersonaViewData> =>
  api<PersonaViewData>('/v1/personas/revert', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

// ── WP284（决策 275）：职责规矩里那几句「以后都这样」 ──────────────────────

/** 一句职责规矩（与服务端 `RoleRuleView` 同形）。 */
export interface RoleRuleData {
  id: string
  role_id: string
  text: string
  /** 定的人（点通过的那位）。 */
  by: string
  by_name?: string
  proposed_by?: string
  /** 来源：那张「以后都这样」策略卡。 */
  source_card_id?: string
  /** 指导写在哪张卡上（卡标题）。 */
  source_title?: string
  matter_id?: string
  created_at: string
  updated_at?: string
  updated_by?: string
  updated_by_name?: string
  /** 这个人改不改得了（③ 只有老板与管理员）。 */
  can_edit: boolean
}

export const listRoleRules = (role_id: string, assignment?: string): Promise<RoleRuleData[]> =>
  api<RoleRuleData[]>(`/v1/roles/${encodeURIComponent(role_id)}/rules`, withAssignment(assignment))

export const updateRoleRule = (
  role_id: string,
  rule_id: string,
  text: string,
  assignment?: string,
): Promise<RoleRuleData> =>
  api<RoleRuleData>(
    `/v1/roles/${encodeURIComponent(role_id)}/rules/${encodeURIComponent(rule_id)}`,
    { method: 'PUT', body: { text }, ...withAssignment(assignment) },
  )

export const deleteRoleRule = (
  role_id: string,
  rule_id: string,
  assignment?: string,
): Promise<{ removed: true }> =>
  api<{ removed: true }>(
    `/v1/roles/${encodeURIComponent(role_id)}/rules/${encodeURIComponent(rule_id)}`,
    { method: 'DELETE', ...withAssignment(assignment) },
  )

// ── WP127：文字模型必须能看图；生图单独一档 ────────────────────────────

/** 验证三步各自过没过（连通 → 文字 → 带图）。 */
export interface ModelCheckStepView {
  step: 'connect' | 'text' | 'vision'
  ok: boolean
  skipped?: boolean
}

/** WP127：验证结果多了三步与看图结论（接口合并，老字段不动）。 */
export interface ModelTestResult {
  steps?: ModelCheckStepView[]
  /** `false` = 看不了图（`reason: 'no_vision'`）。 */
  vision?: boolean
}

/** WP127：按上一次验证，这条能不能看图。老用户升级上来都是 `unchecked`。 */
export interface ModelProviderView {
  vision_status?: 'ok' | 'no' | 'unchecked'
}

/** WP127：生图那一档。 */
export interface ModelImageView {
  configured: boolean
  provider_id?: string
  model?: string
  official: boolean
  /** 官方接口一张图多少积分（常显）。 */
  credits_per_image?: number
  choices: { provider_id: string; label: string; official: boolean; default_model: string }[]
  unavailable_reason?: string
}

export const getModelImage = (assignment?: string): Promise<ModelImageView> =>
  api<ModelImageView>('/v1/models/image', withAssignment(assignment))

/** `provider_id` 给空串 = 不配。 */
export const setModelImage = (
  input: { provider_id: string; model?: string },
  assignment?: string,
): Promise<ModelImageView> =>
  api<ModelImageView>('/v1/models/image', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

// ── WP134：第三种模型来源「用我的 DeepSeek 账号登录」─────────────────────
//
// **只追加**（WP134 派工单：`lib/api.ts` 只追加）。上面的 `ModelProviderKind` 联合类型与
// `ModelProviderTemplate.auth` 没有改：新的 `deepseek_account` / `account` 两个串按字符串比
// （{@link isDeepSeekAccountKind} / {@link isAccountTemplate}），保存那一条走它自己的函数。
//
// 凭据纪律同订阅登录：**这里没有、也不会有令牌字段**。授权在系统浏览器里完成，令牌只进 dsh 的
// 本机凭据库；界面只拿得到「登录了没有 / 账号名 / 余额」。

/** 这一条 provider 在设置里的固定 id（与服务端 `DEEPSEEK_ACCOUNT_PROVIDER_ID` 同一个串）。 */
export const DEEPSEEK_ACCOUNT_PROVIDER_ID = 'deepseek-account'

/** 这条 provider 是不是「用我的 DeepSeek 账号登录」。 */
export const isDeepSeekAccountKind = (kind: string): boolean => kind === 'deepseek_account'

/** 这张模板是不是「用我的 DeepSeek 账号登录」那一张（`auth: 'account'`，没有表单）。 */
export const isAccountTemplate = (tpl: { auth?: string; kind: string }): boolean =>
  (tpl.auth as string | undefined) === 'account' || isDeepSeekAccountKind(tpl.kind)

/** 一次登录走到哪一步（官方八个值原样）。 */
export type DeepSeekAccountPhase =
  | 'initializing'
  | 'waiting-browser'
  | 'exchanging'
  | 'committing'
  | 'succeeded'
  | 'cancelled'
  | 'expired'
  | 'failed'

export interface DeepSeekWallet {
  currency: 'CNY' | 'USD'
  /** 平台给的十进制串，原样显示。 */
  balance: string
}

export interface DeepSeekAccountData {
  available: boolean
  unavailable_reason?: string
  enabled: boolean
  signed_in: boolean
  attempt?: {
    id: string
    phase: DeepSeekAccountPhase
    /** 只在 `waiting-browser` 时有：交给系统浏览器打开。 */
    authorize_url?: string
    expires_at?: string
    error_code?: 'network' | 'protocol' | 'expired' | 'storage'
    /** 人话（服务端翻好的）。 */
    error?: string
  }
  account?: string
  account_error?: string
  balance?:
    | { status: 'ready'; wallets: DeepSeekWallet[]; bonus: DeepSeekWallet[] }
    | { status: 'failed'; message: string }
  usage_url?: string
  top_up_url?: string
  default_model: string
  region: 'cn'
  /** WP150：上一次是登录失效把人登出的（卡片上说"登录过期了，点一下重新登录"）。 */
  session_expired?: { at: string; message: string }
  /** WP150：正在用这个账号跑的事（登出前确认框里列它们，确认后先停再登出）。 */
  running_tasks?: DeepSeekAccountTask[]
}

/** WP150：一件正在用 DeepSeek 账号跑的事。 */
export interface DeepSeekAccountTask {
  run_id: string
  matter_id: string
  title: string
  brand?: string
}

export const getDeepSeekAccount = (assignment?: string): Promise<DeepSeekAccountData> =>
  api<DeepSeekAccountData>('/v1/settings/models/deepseek-account', withAssignment(assignment))

/** 选中这条路并起一次登录；回来时（通常）已经带着授权页地址。 */
export const startDeepSeekAccountLogin = (assignment?: string): Promise<DeepSeekAccountData> =>
  api<DeepSeekAccountData>('/v1/settings/models/deepseek-account/login', {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const cancelDeepSeekAccountLogin = (
  attempt_id: string,
  assignment?: string,
): Promise<DeepSeekAccountData> =>
  api<DeepSeekAccountData>('/v1/settings/models/deepseek-account/cancel', {
    method: 'POST',
    body: { attempt_id },
    ...withAssignment(assignment),
  })

/** 登出：官方删本机凭据 + 后台调平台 logout；这条模型来源随之摘掉。 */
export const signOutDeepSeekAccount = (assignment?: string): Promise<{ signed_out: true }> =>
  api('/v1/settings/models/deepseek-account', { method: 'DELETE', ...withAssignment(assignment) })

/** 登上之后存这一条 provider（**不带 key**：凭据在 dsh 本机凭据库里）。 */
export const saveDeepSeekAccountProvider = (
  model: string,
  assignment?: string,
): Promise<ModelProviderView> =>
  api<ModelProviderView>(`/v1/models/providers/${DEEPSEEK_ACCOUNT_PROVIDER_ID}`, {
    method: 'PUT',
    body: { kind: 'deepseek_account', model },
    ...withAssignment(assignment),
  })

// ── WP136（docs/79）：dsh 场景切换 ──────────────────────────────────────────

/** 一个 dsh 场景（`GET /v1/dsh-scenes` 里的一行；形状同契约 `DshSceneView`）。 */
export interface DshSceneRow {
  name: string
  origin: 'agentsws' | 'official' | 'custom'
  surface: 'agentsws' | 'web' | 'cli'
  template?: string
  is_default: boolean
  deletable: boolean
  launchable: boolean
  initialized: boolean
  state: 'stopped' | 'starting' | 'running' | 'failed'
  port?: number
  started_at?: string
  error?: string
}

export interface DshScenesData {
  available: boolean
  unavailable_reason?: string
  dsh_version?: string
  dsh_home?: string
  workspace_root?: string
  scenes: DshSceneRow[]
  templates: { name: string; surface: 'web' | 'cli' }[]
  /** WP184：用户自己装的官方 DeepSeek Harness 桌面端（没装就没有）。形状同契约 `DshOfficialDesktopView`。 */
  official_desktop?: { name: string; app_path: string; via_protocol: boolean }
}

/** WP184：启动用户自己装的官方桌面端（`dsh://open` 或直接打开应用；它用自己的 `~/.dsh`）。 */
export const launchOfficialDesktop = (assignment?: string): Promise<{ launched: true }> =>
  api('/v1/dsh-scenes/official-desktop/launch', { method: 'POST', ...withAssignment(assignment) })

export const getDshScenes = (assignment?: string): Promise<DshScenesData> =>
  api<DshScenesData>('/v1/dsh-scenes', withAssignment(assignment))

export const createDshScene = (
  input: { name: string; template: string },
  assignment?: string,
): Promise<DshSceneRow> =>
  api<DshSceneRow>('/v1/dsh-scenes', { method: 'POST', body: input, ...withAssignment(assignment) })

/** 网页场景：没起就起，回带一次性 token 的网址（只交给打开它的那一方）。 */
export const openDshScene = (
  name: string,
  assignment?: string,
): Promise<{ scene: DshSceneRow; url: string }> =>
  api(`/v1/dsh-scenes/${encodeURIComponent(name)}/open`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const stopDshScene = (name: string, assignment?: string): Promise<DshSceneRow> =>
  api(`/v1/dsh-scenes/${encodeURIComponent(name)}/stop`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

export const restartDshScene = (
  name: string,
  assignment?: string,
): Promise<{ scene: DshSceneRow; url: string }> =>
  api(`/v1/dsh-scenes/${encodeURIComponent(name)}/restart`, {
    method: 'POST',
    ...withAssignment(assignment),
  })

/** 删一个自建场景。`confirm` 必须再写一遍场景名（服务端也查）。 */
export const deleteDshScene = (
  name: string,
  confirm: string,
  assignment?: string,
): Promise<{ deleted: true }> =>
  api(`/v1/dsh-scenes/${encodeURIComponent(name)}?confirm=${encodeURIComponent(confirm)}`, {
    method: 'DELETE',
    ...withAssignment(assignment),
  })

/**
 * WP138：改一条分配的范围（`PUT /v1/assignments/:id`，组织页用的同一条接口）。
 *
 * 岗位面板上「给我自己挂上这个品牌」走它：`assignment` 传店主那条分配——改分配要的是
 * 店主的权限，不是被改的那条职责自己的。
 */
export const updateAssignmentRanges = (
  id: string,
  ranges: { kind: string; id: string }[],
  assignment?: string,
): Promise<OrgAssignmentView> =>
  api<OrgAssignmentView>(`/v1/assignments/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { ranges },
    ...withAssignment(assignment),
  })

// ── WP144（docs/80）：电脑操控 ──────────────────────────────────────────
//
// 一台机器一份（同浏览器）。三层开关：设置页总开关（默认关）→ 哪几条职责可以（默认一条都不勾）
// → 每次运行第一次要动电脑时的授权卡（在牌堆里批）。这条路上**没有任何凭据**。
// 形状直接用契约里的（类型按需引入，不改上面那一大段 import）。

export type ComputerUseSettingsView = import('@agentsws/contracts').ComputerUseSettingsView
export type ComputerUseSelfCheck = import('@agentsws/contracts').ComputerUseSelfCheck
export type ComputerUseActive = import('@agentsws/contracts').ComputerUseActive

export const getComputerUseSettings = (assignment?: string): Promise<ComputerUseSettingsView> =>
  api('/v1/settings/computer-use', withAssignment(assignment))

export const setComputerUseSettings = (
  input: { enabled?: boolean; roles?: string[]; minutes?: number },
  assignment?: string,
): Promise<ComputerUseSettingsView> =>
  api('/v1/settings/computer-use', { method: 'PUT', body: input, ...withAssignment(assignment) })

/** 向导第 ① 步：按钉死的版本 + sha256 下载驱动（校验不过什么都不装）。 */
export const installComputerUseDriver = (assignment?: string): Promise<ComputerUseSettingsView> =>
  api('/v1/settings/computer-use/install', { method: 'POST', ...withAssignment(assignment) })

/** 向导第 ② 步：打开系统设置里那一页（只打开，不替人点）。 */
export const openComputerUseSystemSettings = (
  pane: 'accessibility' | 'screen_recording',
  assignment?: string,
): Promise<{ opened: boolean; url: string }> =>
  api('/v1/settings/computer-use/open-settings', {
    method: 'POST',
    body: { pane },
    ...withAssignment(assignment),
  })

/** 向导第 ③ 步：自检（驱动 `check_permissions`，`prompt: false`）。 */
export const checkComputerUse = (assignment?: string): Promise<ComputerUseSelfCheck> =>
  api('/v1/settings/computer-use/check', { method: 'POST', ...withAssignment(assignment) })

/** 第三栏那一行：现在有没有 AI 在操作这台电脑。 */
export const getComputerUseActive = (
  assignment?: string,
): Promise<{ active?: ComputerUseActive }> =>
  api('/v1/computer-use/active', withAssignment(assignment))

/** 停止：撤销授权 + 中断那次运行。 */
export const stopComputerUse = (assignment?: string): Promise<{ stopped: number }> =>
  api('/v1/computer-use/stop', { method: 'POST', ...withAssignment(assignment) })

// ── WP180：官方插件 ──────────────────────────────────────────────────────
//
// 一台机器一份。只列审过的清单；点装 / 升级 / 卸载 = 出一张卡（在牌堆里批），批了才做。

export type OfficialPluginsView = import('@agentsws/contracts').OfficialPluginsView
export type OfficialPluginView = import('@agentsws/contracts').OfficialPluginView
export type OfficialPluginAction = import('@agentsws/contracts').OfficialPluginAction

export const getOfficialPlugins = (assignment?: string): Promise<OfficialPluginsView> =>
  api('/v1/settings/official-plugins', withAssignment(assignment))

/** 点装 / 升级 / 卸载：只出一张卡（清单外 → 403，说不通 → 409）。 */
export const requestOfficialPluginChange = (
  input: { action: OfficialPluginAction; name: string },
  assignment?: string,
): Promise<OfficialPluginsView> =>
  api('/v1/settings/official-plugins/requests', {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

// ── WP151：DeepSeek 余额不足（只追加）─────────────────────────────────────
//
// 账号那一路引到账号的充值页（官方 `links.topUpUrl`），API key 那一路引到开放平台的充值页——
// 官方 rc.2 的分法：账号的充值操作不出现在 API key 的失败上，免得充错地方。

/** 余额不足那一行（人话 + 去哪充值；不带任何令牌）。 */
export interface DeepSeekQuota {
  at: string
  message: string
  top_up_url: string
}

export interface ModelProviderView {
  /** WP151：DeepSeek 说余额不足了（模型卡与顶栏出一行 +「去充值」）；成功一次或余额回来就没了。 */
  quota_exceeded?: DeepSeekQuota
}

export interface DeepSeekAccountData {
  /** WP151：这个账号余额不足（去充值用 `top_up_url`）；余额刷新回来有钱了就没了。登录状态不变。 */
  quota_exceeded?: { at: string; message: string }
}

// ── WP154「内容与搜索」：买家问题清单、每周 AI 探测的开关与花费、现在跑一轮 ──────────

export interface GeoQuestionData {
  id: string
  text: string
  origin: 'brand' | 'top_query' | 'human'
  enabled: boolean
}

export interface GeoQuestionsData {
  questions: GeoQuestionData[]
  /** WP166：`markets_off` = 面板上关掉探测的市场（只关探测，不改公司档案）。 */
  settings: { enabled: boolean; max_questions: number; markets_off?: string[] }
  /** 每周大概花多少（官方数据接口才有积分数；自带 key 是 0；没接不写）。 */
  estimate: {
    questions: number
    platforms: number
    route: 'official' | 'byo' | 'none'
    credits_per_week?: number
    /** WP166：探几个市场（花费 = 问题 × 平台 × 市场 × 单价）。 */
    markets?: number
    market_codes?: string[]
  }
  /** WP166：目标市场（公司档案里的；没写就是默认那一个）与这周探不探。 */
  markets?: {
    code: string
    probing: boolean
    /** WP169：这个市场用什么语言问（ISO 639-1）。 */
    language?: string
    /** WP169：要翻译却没配模型——这一周按原语言问。 */
    untranslated?: boolean
  }[]
  markets_from?: 'brand_profile' | 'default'
}

export const getGeoQuestions = (assignment?: string): Promise<GeoQuestionsData> =>
  api('/v1/seo/geo-questions', withAssignment(assignment))

export const setGeoQuestions = (
  input: {
    questions?: { id?: string; text: string; enabled: boolean }[]
    settings?: { enabled?: boolean; max_questions?: number; markets_off?: string[] }
  },
  assignment?: string,
): Promise<GeoQuestionsData> =>
  api('/v1/seo/geo-questions', { method: 'PUT', body: input, ...withAssignment(assignment) })

// ── WP158：Search Console 选哪个站点、GA4 选哪个媒体资源 ─────────────────────────

export interface GoogleSourceData {
  connected: boolean
  selected?: string
  selected_label?: string
  options: { id: string; label: string }[]
  /** 连上了、还没选：出那张「选一下」的小卡。 */
  needs_pick: boolean
  /** 上一次没读到的人话（服务端写好的）。 */
  note?: string
  stale?: boolean
  window?: { start: string; end: string }
}

export interface GoogleSourcesData {
  gsc: GoogleSourceData
  ga4: GoogleSourceData
}

export const getGoogleSources = (assignment?: string): Promise<GoogleSourcesData> =>
  api('/v1/seo/google-sources', withAssignment(assignment))

export const setGoogleSources = (
  input: { gsc_site?: string; ga4_property?: string },
  assignment?: string,
): Promise<GoogleSourcesData> =>
  api('/v1/seo/google-sources', { method: 'PUT', body: input, ...withAssignment(assignment) })

export const runSeo = (
  what: 'daily' | 'weekly',
  assignment?: string,
): Promise<{ what: string; approval_item_ids: string[]; skipped?: string; picks?: number }> =>
  api('/v1/seo/run', { method: 'POST', body: { what }, ...withAssignment(assignment) })

/* ── WP159：知识库里那张「违规宣称规则」表（按市场分组，带官方出处） ─────────────── */

export type ClaimMarketGroupId = 'global' | 'us' | 'eu_uk' | 'ca' | 'au'

export interface ClaimRuleRowData {
  id: string
  pattern: string
  regex?: boolean
  category: string
  /** 一句人话：为什么不能这么写。 */
  reason: string
  market: ClaimMarketGroupId
  source_title?: string
  source_url?: string
  /** 正则规则给人看的写法。 */
  label?: string
  enabled: boolean
  origin: 'builtin' | 'edited' | 'custom'
}

export interface ClaimRulesData {
  markets: string[]
  markets_from: 'brand_profile' | 'default'
  groups: {
    id: ClaimMarketGroupId
    label: string
    enabled: boolean
    why: 'always' | 'market' | 'manual'
  }[]
  rules: ClaimRuleRowData[]
}

export interface ClaimRulesPatchInput {
  group?: { id: ClaimMarketGroupId; enabled: boolean }
  rule?: { id: string; enabled?: boolean; pattern?: string; reason?: string }
  add?: { pattern: string; reason: string; market?: ClaimMarketGroupId }
}

export const getClaimRules = (assignment?: string): Promise<ClaimRulesData> =>
  api('/v1/knowledge/claim-rules', withAssignment(assignment))

export const setClaimRules = (
  input: ClaimRulesPatchInput,
  assignment?: string,
): Promise<ClaimRulesData> =>
  api('/v1/knowledge/claim-rules', { method: 'PATCH', body: input, ...withAssignment(assignment) })

// ── WP173（docs/84 §2）：B2B 开发信序列 ──────────────────────────────────

export type B2bAuthResultData = 'pass' | 'fail' | 'missing' | 'pending' | 'unknown'

export interface B2bOutboundData {
  settings: {
    company_name?: string
    postal_address?: string
    sender_name?: string
    de_at_confirmed: boolean
    sender_choice?: 'separate' | 'primary' | 'separate_pending'
    sender_address?: string
    choice_card_id?: string
    /** WP176：地址从哪来（`profile` = 公司档案，这里只读显示）。 */
    postal_address_from?: 'profile' | 'outbound_settings'
  }
  sender?: {
    address: string
    separate_domain: boolean
    auth: {
      spf: B2bAuthResultData
      dkim: B2bAuthResultData
      dmarc: B2bAuthResultData
      checked_at?: string
      notes: string[]
      /** WP176：`dns` = 测试信没收回来，按 DNS 记录判的（未经实信验证）。 */
      dkim_via?: 'test_mail' | 'dns'
      dkim_selector?: string
    }
    /** WP176：勾了「这只邮箱已经正常发信很久」（不预热）。 */
    established?: boolean
    quota: {
      cap: number
      sent_today: number
      reserved: number
      remaining: number
      warming: boolean
      warm_from?: string
    }
  }
  needs: ('quota' | 'sender_choice' | 'sender_auth' | 'company_address')[]
  funnel: { stage: string; label: string; count: number }[]
  queued: Partial<Record<'quota' | 'sender_choice' | 'sender_auth' | 'company_address', number>>
  eligible: number
  excluded: { reason: string; label: string; count: number }[]
  /** WP176：说过不感兴趣、还在冷却里的人（最先到期的在前）。 */
  cooling?: {
    contact_id?: string
    name?: string
    company?: string
    masked: string
    until: string
    count: number
  }[]
}

export interface B2bSequenceStartData {
  status: 'staged' | 'queued' | 'nothing_to_send' | 'blocked'
  message: string
  approval_item_id?: string
  picked: number
  queued_tomorrow: number
  excluded: { contact_id: string; name: string; company: string; reason: string; label: string }[]
}

export const getB2bOutbound = (assignment?: string): Promise<B2bOutboundData> =>
  api('/v1/b2b/outbound', withAssignment(assignment))

export const saveB2bOutboundSettings = (
  input: {
    company_name?: string
    postal_address?: string
    sender_name?: string
    de_at_confirm?: boolean
    /** WP176：「这只邮箱已经正常发信很久」（新域名别勾）。 */
    sender_established?: boolean
  },
  assignment?: string,
): Promise<B2bOutboundData> =>
  api('/v1/b2b/outbound/settings', { method: 'PUT', body: input, ...withAssignment(assignment) })

export const startB2bSequence = (
  input: { contact_ids?: string[]; product?: string },
  assignment?: string,
): Promise<B2bSequenceStartData> =>
  api('/v1/b2b/outbound/sequences', { method: 'POST', body: input, ...withAssignment(assignment) })

export const checkB2bSender = (assignment?: string): Promise<B2bOutboundData> =>
  api('/v1/b2b/outbound/sender/check', { method: 'POST', ...withAssignment(assignment) })

/* ── WP182（docs/84 §3）：B2B 业务——事实卡、报价单、样品、交接 ─────────────── */

export interface B2bFactCategoryData {
  category: string
  name: string
  description: string
  covers: string[]
  card?: { id: string; status: string; statement: string; reply_en?: string; prefilled?: boolean }
}

export interface B2bFactsData {
  industry?: string
  recommended_certifications: string[]
  categories: B2bFactCategoryData[]
  ready: number
}

export interface B2bSalesData {
  facts: B2bFactsData
  quotes: {
    id: string
    number: string
    account: string
    version: number
    amount_usd: number
    status: string
    pending?: { version: number; approver?: string; breaches: string[]; approval_item_id?: string }
  }[]
  samples: {
    id: string
    account: string
    items: string
    status: 'to_ship' | 'shipped' | 'delivered' | 'feedback'
    tracking_no?: string
    due?: string
    overdue_days?: number
    overdue?: 'ship_overdue' | 'feedback_overdue'
    pending?: boolean
  }[]
  handovers: { id: string; departing: string; items: number; unassigned: number; status: string }[]
}

export interface B2bStagedData {
  staged: boolean
  draft_id: string
  change_id?: string
  approval_item_id?: string
  message?: string
  level?: string
}

export const getB2bSales = (assignment?: string): Promise<B2bSalesData> =>
  api('/v1/b2b/sales', withAssignment(assignment))

export const setupB2bFacts = (assignment?: string): Promise<B2bFactsData & { proposed: number }> =>
  api('/v1/b2b/facts/setup', { method: 'POST', ...withAssignment(assignment) })

export const sendB2bQuote = (
  quote_id: string,
  input: { version?: number; note?: string },
  assignment?: string,
): Promise<B2bStagedData> =>
  api(`/v1/b2b/quotes/${encodeURIComponent(quote_id)}/send`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

export const advanceB2bSample = (
  sample_id: string,
  input: {
    status: 'shipped' | 'delivered' | 'feedback'
    tracking_no?: string
    carrier?: string
    feedback?: string
  },
  assignment?: string,
): Promise<B2bStagedData> =>
  api(`/v1/b2b/samples/${encodeURIComponent(sample_id)}/advance`, {
    method: 'POST',
    body: input,
    ...withAssignment(assignment),
  })

/** 报价单 PDF（带登录与分配头取回来，调用方开一个 blob 地址预览）。 */
export async function fetchB2bQuotePdf(
  quote_id: string,
  version?: number,
  assignment?: string,
): Promise<Blob> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  const asg = assignment ?? currentAssignment
  if (asg !== null) headers.set('X-Assignment', asg)
  const q = version === undefined ? '' : `?version=${version}`
  const res = await fetch(`/v1/b2b/quotes/${encodeURIComponent(quote_id)}/pdf${q}`, { headers })
  if (!res.ok) throw new ApiClientError(res.status, (await res.json()) as ApiErrorBody)
  return res.blob()
}

// ── WP216：平台专属那一套（官方技能 / 官方 MCP / 官方 CLI）────────────────────

/** WP245：工作台替用户跑的那件事（安装 / 登录）走到哪了。 */
export interface PlatformCliJob {
  action: 'install' | 'login'
  phase:
    | 'preparing'
    | 'downloading'
    | 'installing'
    | 'waiting_browser'
    | 'done'
    | 'failed'
    | 'cancelled'
  started_at: string
  finished_at?: string
  fetched?: number
  login_url?: string
  user_code?: string
  browser_opened?: boolean
  error?: {
    code:
      | 'network'
      | 'timeout'
      | 'disk_full'
      | 'permission'
      | 'denied'
      | 'expired'
      | 'not_installed'
      | 'failed'
    detail?: string
  }
  command: string
  log: string[]
  /** WP254：安装用的哪个下载源（不是国内源且网络失败 → 多一个「换国内源再试」）。 */
  registry?: 'official' | 'npmmirror' | 'custom'
}

/** CLI 卡的四档：没装 / Node 不够 / 没登录 / 好了。 */
export type PlatformCliState = 'missing' | 'node_old' | 'needs_login' | 'ready'

export interface PlatformCliView {
  spec: import('@agentsws/contracts').PlatformCliSpec
  probe?: {
    installed: boolean
    version?: string
    node_version?: string
    node_ok: boolean
    min_node_major: number
    checked_at: string
    /** WP245：`app` = 工作台装在自己数据目录里的那份；`system` = 系统里本来就有的。 */
    source?: 'app' | 'system'
  }
  /** WP245：这台机器上能不能一键安装 / 一键登录。 */
  can?: { install: boolean; login: boolean }
  /** WP245：替用户跑的那件事（跑着的或刚结束的）。 */
  job?: PlatformCliJob
  login_confirmed_at?: string
  state: PlatformCliState
  /** CLI 不在 / 没登录时退回 Admin API 那条路的职责。 */
  degraded_roles: string[]
}

export interface PlatformKitView {
  /** 品牌的平台；没设（也推断不出）= 没有这一格。 */
  platform?: string
  /** 平台没设、又是建站岗位页：出一行「先选一下你的建站平台」。 */
  choose_platform?: { choices: { key: string; label: string; supported: boolean }[] }
  /** 平台那一行没有专属的东西 = null（界面上什么都不出）。 */
  kit: null | {
    skills: { name: string; display_name?: { zh: string; en: string } }[]
    skill_source?: import('@agentsws/contracts').PlatformSkillSource
    mcp?: import('@agentsws/contracts').PlatformMcpSpec & {
      enabled: boolean
      /** 官方工具包下载并起来了没（首次使用才下载）。 */
      downloaded: boolean
      tools: string[]
    }
    cli?: PlatformCliView
  }
}

/** 在岗位页上选建站平台（负责人；用负责人那条分配）。 */
export const setPlatformKitPlatform = (
  input: { storefront_platform: string; position_id?: string },
  assignment?: string,
): Promise<PlatformKitView> =>
  api('/v1/platform-kit/platform', { method: 'PUT', body: input, ...withAssignment(assignment) })

/** 看这个品牌的平台套件；带 `position_id` 时 CLI 卡只在那一行写的岗位页上才检测。 */
export const getPlatformKit = (
  input: { position_id?: string } = {},
  assignment?: string,
): Promise<PlatformKitView> =>
  api(
    `/v1/platform-kit${input.position_id === undefined ? '' : `?position_id=${encodeURIComponent(input.position_id)}`}`,
    withAssignment(assignment),
  )

/** 「再查一次」：装好 CLI 之后点它（不走缓存）。 */
export const checkPlatformCli = (assignment?: string): Promise<PlatformKitView> =>
  api('/v1/platform-kit/cli/check', { method: 'POST', ...withAssignment(assignment) })

/** WP245：替用户跑登记过的命令（一键安装 / 一键登录 / 再查一次）。 */
export const runPlatformCli = (
  action: 'install' | 'login' | 'version',
  assignment?: string,
): Promise<PlatformKitView> =>
  api('/v1/platform-kit/cli/run', {
    method: 'POST',
    body: { action },
    ...withAssignment(assignment),
  })

/**
 * WP253：网页模板「AI 改主题」还差哪一步（服务端 `SiteThemeView` 同形）。
 * `next`：第一件还没做的事（装 CLI / Node / 登录 / 店铺地址）；都好了就没有。
 */
export interface SiteThemeView {
  applicable: boolean
  cli: 'missing' | 'node_old' | 'needs_login' | 'ready'
  cli_source?: 'app' | 'system'
  store?: string
  /** WP258：`cli` = 登录后从这个账号下的店里自动取的 / 人从下拉框里选的。 */
  store_source?: 'connection' | 'manual' | 'cli'
  /** WP258：登录后在这个 Shopify 账号下找到的店（`ok` 至少一家；`none` 一家都没有；`failed` 没找成）。 */
  store_lookup?: {
    status: 'ok' | 'none' | 'failed'
    stores: SiteThemeStoreChoice[]
    checked_at: string
    message?: string
  }
  /** WP258：官网里读到的那个 `xxx.myshopify.com`。 */
  site_store?: string
  workspace: {
    files: number
    base?: { repo: string; version: string; commit: string; license: string; at: string }
  }
  last_push?: {
    theme_id: string
    theme_name: string
    preview_url?: string
    at: string
    changed_files: string[]
  }
  next?: 'install_cli' | 'node' | 'login' | 'store'
}

/** WP253：网页模板还差哪一步（用网页模板那条分配；`fresh` = 现查 CLI）。 */
export const getSiteTheme = (assignment: string, fresh = false): Promise<SiteThemeView> =>
  api(`/v1/site/theme${fresh ? '?fresh=1' : ''}`, withAssignment(assignment))

/** WP258：登录账号下的一家店（下拉框里一行）。 */
export interface SiteThemeStoreChoice {
  store: string
  name?: string
  plan?: string
  organization?: string
}

/**
 * WP253：记下店铺地址（`xxx.myshopify.com` 或后台地址栏那一串）。
 * WP258：`source: 'list'` = 从登录账号下找到的店里选的（服务端核对它在清单里）。
 */
export const setSiteThemeStore = (
  store: string,
  assignment: string,
  source?: 'manual' | 'list',
): Promise<SiteThemeView> =>
  api('/v1/site/theme/store', {
    method: 'PUT',
    body: source === undefined ? { store } : { store, source },
    ...withAssignment(assignment),
  })

/**
 * WP261（决策 175 第 1 步）：「授权管理商品和页面」那一行（服务端 `ShopAdminView` 同形）。
 * `roles` = 这个岗位上的职责（权限按它们的并集算「还缺哪项」）。
 */
export interface ShopAdminView {
  applicable: boolean
  state?:
    | 'no_cli'
    | 'no_store'
    | 'unauthorized'
    | 'authorizing'
    | 'expired'
    | 'missing_scopes'
    | 'authorized'
  store?: string
  scopes_needed: string[]
  scopes_granted: string[]
  missing: string[]
  authorized_at?: string
  expires_at?: string
  refreshable?: boolean
  problem?: { code: 'expired' | 'revoked' | 'missing_scope'; missing?: string[]; at: string }
  job?: {
    action: 'install' | 'authorize'
    phase: 'running' | 'waiting_browser' | 'done' | 'failed' | 'cancelled'
    started_at: string
    finished_at?: string
    auth_url?: string
    browser_opened?: boolean
    error?: { code: string; missing?: string[]; detail?: string }
  }
  /** WP265：`cloud` = 连接页一键授权的云端应用（授权 / 重新授权去连接页做）。 */
  via?: 'cloud' | 'cli'
}

const rolesQuery = (roles: readonly string[]): string =>
  roles.length === 0 ? '' : `?roles=${encodeURIComponent(roles.join(','))}`

export const getShopAdmin = (
  assignment: string,
  roles: readonly string[],
): Promise<ShopAdminView> => api(`/v1/shop-admin${rolesQuery(roles)}`, withAssignment(assignment))

/** 一键安装 CLI / 起店铺授权（浏览器里点批准）。只给人点。 */
export const runShopAdmin = (
  action: 'install' | 'authorize',
  assignment: string,
  roles: readonly string[],
): Promise<ShopAdminView> =>
  api('/v1/shop-admin/run', {
    method: 'POST',
    body: { action, roles: [...roles] },
    ...withAssignment(assignment),
  })

export const cancelShopAdmin = (
  assignment: string,
  roles: readonly string[],
): Promise<ShopAdminView> =>
  api('/v1/shop-admin/cancel', {
    method: 'POST',
    body: { roles: [...roles] },
    ...withAssignment(assignment),
  })

export const setShopAdminStore = (
  store: string,
  assignment: string,
  roles: readonly string[],
): Promise<ShopAdminView> =>
  api('/v1/shop-admin/store', {
    method: 'PUT',
    body: { store, roles: [...roles] },
    ...withAssignment(assignment),
  })

/** WP245：停掉正在跑的那件（登录等浏览器时的「取消」）。 */
export const cancelPlatformCli = (assignment?: string): Promise<PlatformKitView> =>
  api('/v1/platform-kit/cli/cancel', { method: 'POST', ...withAssignment(assignment) })

/** 「我登好了」/ 撤回：只记一个时间，不碰任何凭据（WP245 后卡上不再用）。 */
export const confirmPlatformCliLogin = (
  confirmed: boolean,
  assignment?: string,
): Promise<PlatformKitView> =>
  api('/v1/platform-kit/cli/login', {
    method: 'PUT',
    body: { confirmed },
    ...withAssignment(assignment),
  })

/* ── WP224（docs/91 §2.2 #1 / #3）：毛利率事实卡、两条止损线对照、本周经营一页纸 ── */

import type {
  AdsLineCompareView,
  GrossMarginInput,
  GrossMarginsView,
  WeeklyReviewPayload,
} from '@agentsws/contracts'

export type { GrossMarginInput, GrossMarginsView, WeeklyReviewPayload }

/** 这个品牌的毛利率（品牌一格 + 按品类 / SKU 覆盖）。用负责人那条分配。 */
export const getGrossMargins = (assignment?: string): Promise<GrossMarginsView> =>
  api<GrossMarginsView>('/v1/economics/margins', withAssignment(assignment))

/** 填 / 改 / 清一格（`margin_pct: null` = 清）。 */
export const saveGrossMargin = (
  input: GrossMarginInput,
  assignment?: string,
): Promise<GrossMarginsView> =>
  api<GrossMarginsView>('/v1/economics/margins', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

export const getLineCompare = (assignment?: string): Promise<AdsLineCompareView> =>
  api<AdsLineCompareView>('/v1/economics/line-compare', withAssignment(assignment))

export const previewWeeklyReview = (assignment?: string): Promise<WeeklyReviewPayload | null> =>
  api<WeeklyReviewPayload | null>('/v1/economics/weekly-review', withAssignment(assignment))

export const runWeeklyReview = (
  assignment?: string,
): Promise<{ approval_item_id?: string; skipped?: string; week_of?: string }> =>
  api<{ approval_item_id?: string; skipped?: string; week_of?: string }>(
    '/v1/economics/weekly-review/run',
    { method: 'POST', body: {}, ...withAssignment(assignment) },
  )

import type { WeeklyReviewScheduleView } from '@agentsws/contracts'

export type { WeeklyReviewScheduleView }

/** WP224：一页纸每周几、几点推（设置 → 通用那一行）。 */
export const getWeeklyReviewSchedule = (assignment?: string): Promise<WeeklyReviewScheduleView> =>
  api<WeeklyReviewScheduleView>('/v1/economics/weekly-review/schedule', withAssignment(assignment))

export const setWeeklyReviewSchedule = (
  input: { weekday: number; time: string },
  assignment?: string,
): Promise<WeeklyReviewScheduleView> =>
  api<WeeklyReviewScheduleView>('/v1/economics/weekly-review/schedule', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

// ── WP268（决策 213）：品牌素材库（AI 出的图、拖进来的图、店里商品图）─────────────
//
// 取原图与上传都不走 `api()`（那个只收发 JSON）：自己拼 `Authorization` / `X-Assignment`。

/** 素材库里的一行（服务端 `brandAssetRow`）。 */
export interface BrandAssetRow {
  id: string
  status: 'variant' | 'picked' | 'published' | 'rejected'
  content_type?: string
  width?: number
  height?: number
  tags?: string[]
  file_url: string
  source_label: string
  provenance: {
    source: 'generated' | 'uploaded' | 'external'
    operation?: 'generate' | 'edit'
    model?: { provider: string; model: string }
    prompt?: string
    credits?: number
    matter_id?: string
    reference_asset_ids?: string[]
    picked_at?: string
    origin?: { kind: string; ref?: string; url?: string }
  }
  shop_file?: { filename: string; theme_ref: string; url?: string; store: string }
  placed?: { file: string; section?: string; block?: string; setting: string; preview_url?: string }
  created_at: string
}

/** 单张上限（与服务端同一个数）。 */
export const BRAND_ASSET_MAX_BYTES = 20 * 1024 * 1024
export const BRAND_ASSET_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export const listBrandAssets = (
  filter: {
    matter_id?: string
    /** 只看这个用途标（WP289：不给时服务端不含遮罩 `mask`）。 */
    tag?: string
    source?: 'generated' | 'uploaded' | 'external'
    picked_only?: boolean
    limit?: number
  } = {},
): Promise<{ rows: BrandAssetRow[] }> => {
  const q = new URLSearchParams()
  if (filter.matter_id !== undefined) q.set('matter_id', filter.matter_id)
  if (filter.tag !== undefined) q.set('tag', filter.tag)
  if (filter.source !== undefined) q.set('source', filter.source)
  if (filter.picked_only === true) q.set('picked_only', 'true')
  if (filter.limit !== undefined) q.set('limit', String(filter.limit))
  const qs = q.toString()
  return api(`/v1/brand-assets${qs === '' ? '' : `?${qs}`}`)
}

/** 取一张图的字节，回一个页面内可用的 `blob:` 地址（用完由调用方 `URL.revokeObjectURL`）。 */
export async function brandAssetObjectUrl(file_url: string): Promise<string> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  if (currentAssignment !== null) headers.set('X-Assignment', currentAssignment)
  const res = await fetch(file_url, { headers })
  if (!res.ok) throw new ApiClientError(res.status, (await res.json()) as ApiErrorBody)
  return URL.createObjectURL(await res.blob())
}

/** 传一张图进素材库（事项里拖进来的带 `matter_id`）。 */
export async function uploadBrandAsset(
  file: File,
  opts: { matter_id?: string; tags?: string[] } = {},
): Promise<{ asset: BrandAssetRow; edit_mask?: boolean }> {
  const headers = new Headers()
  const token = readStoredToken()
  if (token !== null) headers.set('Authorization', `Bearer ${token}`)
  if (currentAssignment !== null) headers.set('X-Assignment', currentAssignment)
  const form = new FormData()
  form.append('file', file)
  if (opts.matter_id !== undefined) form.append('matter_id', opts.matter_id)
  if (opts.tags !== undefined && opts.tags.length > 0) form.append('tags', opts.tags.join(','))
  const res = await fetch('/v1/brand-assets/upload', { method: 'POST', headers, body: form })
  const text = await res.text()
  const parsed: unknown = text === '' ? {} : JSON.parse(text)
  if (!res.ok) throw new ApiClientError(res.status, parsed as ApiErrorBody)
  // WP283：`edit_mask` = 现在的改图型号能不能「圈区域」
  return (parsed as ApiEnvelope<{ asset: BrandAssetRow; edit_mask?: boolean }>).data
}

// ── WP274（决策 255）：生图跟着用户自己的模型走 ──────────────────────────
//
// **只追加**：上面 WP127 那几个类型与函数不动，新字段用接口合并补上，新的写法另起函数。

/** 这一次出图实际用谁（按「单独指定 > 文字模型同厂商且带生图 > Agents 工坊积分」解析）。 */
export interface ModelImageUsing {
  source: 'override' | 'own_openai' | 'own_google' | 'cloud'
  provider_id: string
  /** 「你的 OpenAI 账号（GPT Image 2.5）」/「你的 Google 账号（Nano Banana 2.1）」/「Agents 工坊积分（…）」。 */
  label: string
  generate_model: string
  edit_model: string
  /** 走用户自己的 key：不扣积分。 */
  own_key: boolean
}

export interface ModelImageView {
  using?: ModelImageUsing
  auto?: ModelImageUsing
  override?: boolean
  edit_model?: string
}

/** `choices` 里那一项（WP274 多了三格：认出来的厂商、默认改图型号、只生图）。 */
export type ModelImageChoice = ModelImageView['choices'][number] & {
  vendor?: 'openai' | 'google'
  default_edit_model?: string
  image_only?: boolean
}

export interface ModelProviderView {
  /** WP274：只用来生图的那一条（不挂文字模型、不测）。 */
  image_only?: boolean
}

/** 改生图那一档（带改图型号）。`provider_id` 给空串 = 自动。 */
export const setModelImageRoute = (
  input: { provider_id: string; model?: string; edit_model?: string },
  assignment?: string,
): Promise<ModelImageView> =>
  api<ModelImageView>('/v1/models/image', {
    method: 'PUT',
    body: input,
    ...withAssignment(assignment),
  })

/**
 * 存一条**只用来生图**的自定义接口（OpenAI 兼容 images 形态）。同 {@link saveModelProvider}：
 * key 从原生表单的 FormData 来、只走这一次，进本机加密库。
 */
export const saveImageOnlyProvider = (
  id: string,
  input: {
    label?: string
    base_url: string
    model: string
    region: 'cn' | 'global'
    api_key?: string
  },
  assignment?: string,
): Promise<ModelProviderView> =>
  api(`/v1/models/providers/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: { kind: 'openai_compatible', ...input, image_only: true, price_source: 'manual' },
    ...withAssignment(assignment),
  })

// ── WP283（决策 300）：改图认不认遮罩 ──────────────────────────────────────

export interface ModelImageUsing {
  /** 改图认不认遮罩（按型号能力表判；经 Agents 工坊云的型号都不认）。 */
  edit_mask?: boolean
}
