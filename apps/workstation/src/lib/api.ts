/**
 * `/v1` 客户端。
 *
 * 三条纪律：
 * - 工作台只经 `/v1`（28 §2 唯一入口），没有第二个后端。
 * - 每个请求带 `X-Assignment`（31 §3.1 一次请求一个 Assignment）；当前岗位就是它。
 * - 前端不引入任何模型 SDK：卡片按钮只打 decide（29 §5 动作不经模型）。
 */
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
  method?: 'GET' | 'POST' | 'PUT'
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

/** 拿一个能用的会话；已经有就直接用，没有就走 magic-link。 */
export async function ensureSession(): Promise<Me> {
  if (readStoredToken() !== null) {
    try {
      return await api<Me>('/v1/me')
    } catch (err) {
      if (!(err instanceof ApiClientError) || err.status !== 401) throw err
      clearToken()
    }
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
