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
  InstructionScope,
  PositionTiles,
  RangeName,
  RecordRow,
  StatTile,
  TileSpec,
  ViewSection,
} from '@agentsws/deck'

export interface ApiEnvelope<T> {
  data: T
  trace_id: string
}

export interface ApiErrorBody {
  code: string
  message: string
  details?: { reason?: string }
  trace_id?: string
}

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly reason: string | undefined

  constructor(status: number, body: ApiErrorBody) {
    super(body.message)
    this.name = 'ApiClientError'
    this.status = status
    this.code = body.code
    this.reason = body.details?.reason
  }
}

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

export interface DecideInput {
  action: 'approve' | 'reject' | 'instruct' | 'snooze'
  selected_option_id?: string
  instruction?: { scope: InstructionScope; text: string }
  reason?: string
  version?: number
}

const TOKEN_KEY = 'agentsws.session_token'

let sessionToken: string | null = null
let currentAssignment: string | null = null

export function setAssignment(id: string): void {
  currentAssignment = id
}

export function assignmentId(): string | null {
  return currentAssignment
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

/**
 * 拿一个能用的会话，按这个顺序：
 *
 * 1. **HttpOnly 会话 cookie**（13 §5）——桌面壳用 `AGENTSWS_SESSION_KEY` 换好之后，
 *    同源请求自动带上它，前端**看不到也存不到** token，这是最安全的一条；
 * 2. 存过的 bearer（普通浏览器里上次登录留下的）；
 * 3. 都没有 → 本地单机档的 magic-link 自动登录。
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
  const email = config.owner_email ?? 'owner@localhost'
  const issued = await api<{ token?: string }>('/v1/auth/magic-link', {
    method: 'POST',
    body: { email },
    anonymous: true,
  })
  if (issued.token === undefined) {
    throw new Error('这个服务进程不在本地单机档，一次性登录 token 只经邮件投递')
  }
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

export const getMatter = (id: string): Promise<MatterView> =>
  api<MatterView>(`/v1/matters/${encodeURIComponent(id)}`)

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
}): Promise<{ todo: Todo }> => api('/v1/todos', { method: 'POST', body: input })

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
