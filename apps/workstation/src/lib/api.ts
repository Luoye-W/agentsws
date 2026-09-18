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
  today?: { timeline: CalendarItem[]; due: { todos: Todo[]; cards_waiting: number } }
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

export const getPositionCards = (id: string, filters?: DeckFilters): Promise<CardsData> =>
  api<CardsData>(`/v1/positions/${encodeURIComponent(id)}/cards?_=1${filterQuery(filters)}`, {
    assignment: id,
  })

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
  }[]
  open_matters: number
  pending_cards: number
  memory_summary: string
}

export interface RouteCandidateData {
  role_id: string
  role_name: string
  score: number
  why: string[]
}

export interface OpenAtPositionData {
  matter: { id: string; title: string; entry?: string; role_id?: string }
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
 * 54 §2 主入口：交给这个岗位一件事（一句话 → 事项）。
 *
 * WP84：从快捷提示点进来时带 `role_id`——那句话本来就写在那条职责的 yml 里，
 * 再让岗位内路由猜一遍只会猜错。入口还是岗位入口（事项照样 `entry: 'position'`）。
 */
export const openMatterAtPosition = (
  id: string,
  input: { title: string; summary?: string; role_id?: string },
): Promise<OpenAtPositionData> =>
  api<OpenAtPositionData>(`/v1/positions/${encodeURIComponent(id)}/matters`, {
    method: 'POST',
    body: input,
    assignment: id,
  })

/** 54 §2：换一条职责来做这件事（换后新的 Run 走新职责，旧 Run 不动）。 */
export const rerouteMatter = (
  matter_id: string,
  role_id: string,
): Promise<{ matter: { id: string; role_id?: string }; assignment_id: string }> =>
  api(`/v1/matters/${encodeURIComponent(matter_id)}/reroute`, {
    method: 'POST',
    body: { role_id },
  })

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
}): Promise<{ accepted: boolean; approval_item_id?: string; reason?: string }> =>
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
 */
export const createMatterWithRole = (
  assignment: string,
  input: { title: string; summary?: string },
): Promise<{ matter: Matter }> =>
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
}

export const listDeadLetters = (assignment?: string): Promise<{ dead_letters: DeadLetterView[] }> =>
  api<{ dead_letters: DeadLetterView[] }>('/v1/channels/dead-letters', withAssignment(assignment))

/** WP55：重投一条死信。会让这条消息重新起一次 Run，所以是人按的按钮。 */
export const requeueDeadLetter = (
  id: string,
  assignment?: string,
): Promise<{ requeued: boolean }> =>
  api<{ requeued: boolean }>(`/v1/channels/dead-letters/${encodeURIComponent(id)}/requeue`, {
    method: 'POST',
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
}

export interface PricingModelEntry {
  model: string
  in: number
  out: number
  cached?: number
  cn?: boolean
}

export interface PricingEntry {
  capability: string
  unit: string
  credits_per_unit: number
  label_zh: string
  label_en: string
  models?: PricingModelEntry[]
}

export interface PricingView {
  version: number
  as_of: string
  credit_cny: number
  ai_multiplier: number
  fx: Record<string, number>
  entries: PricingEntry[]
}

export interface CapabilitySourceSettings {
  workspace_id: string
  capability_sources: Record<string, CapabilitySource>
  updated_at?: string
}

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

export const getCapabilitySources = (assignment?: string): Promise<CapabilitySourceSettings> =>
  api('/v1/settings/capability-sources', withAssignment(assignment))

/** 整张表一次给全——两个标签页各改一项就不会互相覆盖。 */
export const setCapabilitySources = (
  capability_sources: Record<string, CapabilitySource>,
  assignment?: string,
): Promise<CapabilitySourceSettings> =>
  api('/v1/settings/capability-sources', {
    method: 'PUT',
    body: { capability_sources },
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
  auth?: 'api_key' | 'subscription'
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
  data_residency: 'cn' | 'any'
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
}

/** 向导第 ③ 步的候选：一个岗位与它包含的职责（每条带一句"它会干什么"）。 */
export interface OnboardingPositionView {
  id: string
  name: string
  roles: { id: string; name: string; default: boolean; what_it_does: string }[]
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
  superseded_reason?: string
  approval_item_id?: string
}

export interface OnboardingPlanInput {
  position_ids: string[]
  role_ids: string[]
  custom_position_name?: string
}

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

export const openChatSession = (): Promise<ChatSessionView> =>
  api<ChatSessionView>('/v1/chat/sessions', { method: 'POST' })

export const getChatMessages = (
  id: string,
): Promise<{ session: ChatSessionView; messages: ChatMessageView[] }> =>
  api(`/v1/chat/sessions/${encodeURIComponent(id)}/messages`)

export const sendChatMessage = (id: string, text: string): Promise<ChatTurnView> =>
  api<ChatTurnView>(`/v1/chat/sessions/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    body: { text },
  })

/**
 * 静默窗口到了：让服务端把这一轮判完。
 *
 * 沙盒页自己点这一下，不等服务进程里那个真定时器——不然每发一句都要干等 2 秒
 * 才看得到判定，商家试不下去。真访客那一路仍然由定时器驱动。
 */
export const advanceChatTurn = (id: string): Promise<ChatTurnView> =>
  api<ChatTurnView>(`/v1/chat/sessions/${encodeURIComponent(id)}/advance`, { method: 'POST' })

export const setChatTakeover = (id: string, on: boolean): Promise<ChatSessionView> =>
  api<ChatSessionView>(`/v1/chat/sessions/${encodeURIComponent(id)}/takeover`, {
    method: 'PUT',
    body: { on },
  })

export const teachChatSession = (
  id: string,
  input: { instruction: string; scope: 'single_reply' | 'similar_cases' | 'global_rule' },
): Promise<{ outcome: string; reply?: string; sediment: string }> =>
  api(`/v1/chat/sessions/${encodeURIComponent(id)}/teach`, { method: 'POST', body: input })

/* ── 49 M1 云账号（WP58）──────────────────────────────────────────────── */

export type CloudScopeName = 'ai' | 'wallet:read' | 'standby'

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

export const unlinkCloudAccount = (assignment?: string): Promise<CloudUnlinkResult> =>
  api<CloudUnlinkResult>('/v1/cloud/account/unlink', {
    method: 'POST',
    ...(assignment === undefined ? {} : { assignment }),
  })

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
  /** 一个人、一个品牌 = 个人用户：界面上一律不显示"组织"这两个字（52 O1）。 */
  solo: boolean
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
  filter: { channel?: KolChannelId; q?: string } = {},
  assignment?: string,
): Promise<{ rows: KolCreatorRowData[] }> => {
  const q = new URLSearchParams()
  if (filter.channel !== undefined) q.set('channel', filter.channel)
  if (filter.q !== undefined && filter.q !== '') q.set('q', filter.q)
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
  wecom: { configured: boolean; connected: boolean; bot_id?: string }
}

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

/* ── WP73（56 §6）：社媒库 `/v1/social/*` ───────────────────────────────── */

/** 九条渠道（真源是契约的 `SOCIAL_CHANNELS`；工作台不依赖服务端包，这里照抄一份）。 */
export type SocialChannelId =
  | 'meta'
  | 'tiktok'
  | 'x'
  | 'youtube'
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
