/**
 * WP476（决策 1590 / 1593）：产品使用数据——本机服务进程这一侧。
 *
 * 管四件事：
 *
 * 1. **开关与匿名设备号**（`telemetry.json`，一台机器一份）：「帮助改进工坊（匿名使用数据）」测试阶段默认开；
 *    第一次提示看过没有；`install_id` 是随机生成的匿名设备号，与任何账号、邮箱无关。
 * 2. **配置**：上报地址只认 `AGENTSWS_TELEMETRY_HOST`（桌面安装包的壳给；开发 / 测试 / 自建默认没有 → 整套不发）；
 *    项目 key 每 6 小时问一次那个地址的 `/config`（云上 Worker 读它的密钥库，没配 key 就回 `key: null` → 整套不发）。
 * 3. **服务端才知道的几件事**：一次 AI 运行收尾（成 / 败 / 停、花费档、缓存命中档、哪条**内置**职责 / 岗位、失败码），
 *    一张卡被人定了（通过 / 改了再过 / 驳回、卡的类型）。用户自己建的职责 / 岗位一律记成 `custom`——名字里可能有品牌或商品。
 * 4. **出门**：每条都过 `@agentsws/contracts` 的白名单（`sanitizeTelemetryProps`），攒一小批 POST 到 `<地址>/batch/`。
 *    发不出去就丢，不重试、不落盘、不报错——这件事绝不能影响干活。
 *
 * 工作台那一侧（posthog-js、页面访问、按钮、前端报错）读的也是这里的 `view()`：开关、key 都从这一处来。
 *
 * 5. **工作台的事件也从这里出门**（`ingest`）：posthog-js 的 `api_host` 是本机的 `/v1/telemetry`，同源——
 *    桌面壳的 CSP（`connect-src` 只许 self）不用放宽，局域网同事的浏览器也一样；浏览器一个外网请求都不发。
 *    收到的每一条在这里**再过一遍白名单**（不信前端那一遍），key 对不上的整批丢，再转给 `<地址>/batch/`。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  type EventEnvelope,
  sanitizeTelemetryProps,
  TELEMETRY_HOST_ENV,
  TELEMETRY_RELAY_PATH,
  type TelemetryEventName,
  type TelemetryIngest,
  type TelemetryIngestReply,
  type TelemetryPatch,
  type TelemetryView,
  telemetryCacheTier,
  telemetryCostTier,
} from '@agentsws/contracts'

export type { TelemetryIngest, TelemetryIngestReply, TelemetryPatch, TelemetryView }

export interface Telemetry {
  view(): Promise<TelemetryView>
  update(patch: TelemetryPatch): Promise<TelemetryView>
  /** 事件日志的每一条都过一下（只看 `run.*`）。不抛、不等。 */
  onEvent(e: Pick<EventEnvelope, 'type' | 'actor' | 'correlation' | 'payload'>): void
  /** 一张卡被定了。不抛、不等。 */
  onCardDecided(item: { kind: string; state: string }): void
  /** 工作台（posthog-js）经本机转发的那几条路：解开、再过白名单、转给上报地址。不抛。 */
  ingest(input: TelemetryIngest): Promise<TelemetryIngestReply>
  /** 把手上攒的那一批发出去（测试与退出时用）。 */
  flush(): Promise<void>
  close(): void
}

export type TelemetryFetch = (url: string, init?: RequestInit) => Promise<Response>

const OK_REPLY: TelemetryIngestReply = { status: 200, body: '{"status":1}' }
/** 一次最多收这么多条（SDK 一批通常十几条）；解压后最多这么大。 */
const INGEST_MAX_EVENTS = 100
const INGEST_MAX_BYTES = 8 * 1024 * 1024

export interface TelemetryOptions {
  env: Readonly<Record<string, string | undefined>>
  /** 数据目录；不给就只在内存里（测试 / 一次性进程）。 */
  dir?: string
  now: () => string
  /** 只有生产入口不给（用全局 fetch）；测试一律塞替身。 */
  fetch?: TelemetryFetch
  appVersion?: string
  /** 关联了云账号时的账号 id。 */
  accountId?: () => string | undefined
  /** 一条分配是哪条职责、在哪个岗位里（运行开始时问一次）。 */
  placeOf?: (assignment_id: string) => { role_id?: string; position_id?: string } | undefined
  /** 内置职责 / 岗位的 id（不在里面的记 `custom`）。 */
  bundledRoleIds?: () => ReadonlySet<string>
  bundledPositionIds?: () => ReadonlySet<string>
  /** 攒多久发一批（毫秒；0 = 不起定时器，只在攒满 / flush 时发）。 */
  flushIntervalMs?: number
}

const FILE = 'telemetry.json'
const CONFIG_TTL_MS = 6 * 60 * 60 * 1000
const CONFIG_RETRY_MS = 10 * 60 * 1000
const BATCH_SIZE = 20
const QUEUE_MAX = 200
const RUNS_MAX = 500
/** PostHog 的项目 key 长这样（`phc_…`）；不像的一律当没配。 */
const KEY_SHAPE = /^phc_[A-Za-z0-9_-]{10,100}$/

interface Stored {
  enabled: boolean
  notice_seen: boolean
  install_id: string
}

interface RemoteConfig {
  key: string | null
  replay: boolean
}

/** `AGENTSWS_TELEMETRY_HOST` → 去掉末尾斜杠的 https 地址；没配、`off`、不是 http(s) 都当没有。 */
export function telemetryHost(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env[TELEMETRY_HOST_ENV]?.trim()
  if (raw === undefined || raw === '' || raw === 'off') return undefined
  try {
    const u = new URL(raw)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    return `${u.protocol}//${u.host}`
  } catch {
    return undefined
  }
}

function load(dir: string | undefined): Stored {
  const fresh: Stored = {
    enabled: true,
    notice_seen: false,
    install_id: `ins_${randomUUID().replaceAll('-', '')}`,
  }
  if (dir === undefined) return fresh
  const file = join(dir, FILE)
  let stored: Stored = fresh
  if (existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Stored>
      stored = {
        enabled: typeof raw.enabled === 'boolean' ? raw.enabled : fresh.enabled,
        notice_seen: typeof raw.notice_seen === 'boolean' ? raw.notice_seen : fresh.notice_seen,
        install_id:
          typeof raw.install_id === 'string' && /^ins_[a-f0-9]{32}$/.test(raw.install_id)
            ? raw.install_id
            : fresh.install_id,
      }
    } catch {
      // 读坏了回缺省（它只是偏好 + 一个随机号）
    }
  }
  if (stored === fresh || !existsSync(file)) save(dir, stored)
  return stored
}

function save(dir: string | undefined, stored: Stored): void {
  if (dir === undefined) return
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, FILE), `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
  } catch {
    // 存不下：这次进程里照常生效
  }
}

const decisionOf = (state: string): 'approve' | 'edit' | 'reject' | 'other' =>
  state === 'approved' || state === 'applied' || state === 'applying'
    ? 'approve'
    : state === 'approved_edited'
      ? 'edit'
      : state === 'rejected'
        ? 'reject'
        : 'other'

export function createTelemetry(options: TelemetryOptions): Telemetry {
  const host = telemetryHost(options.env)
  /*
   * 测试进程里没塞替身就一律不发——哪怕谁的终端里恰好留着 AGENTSWS_TELEMETRY_HOST。
   * 开发、测试期间一条都不许出门（WP476 派工纪律）。
   */
  const underTest =
    options.fetch === undefined &&
    (options.env.VITEST !== undefined || options.env.NODE_ENV === 'test')
  const configured = host !== undefined && !underTest
  const doFetch: TelemetryFetch = options.fetch ?? ((url, init) => fetch(url, init))
  let stored = load(options.dir)

  let remote: RemoteConfig | undefined
  let remoteAt = 0
  let remoteFailedAt = 0
  let inflight: Promise<RemoteConfig | undefined> | undefined

  const remoteConfig = async (): Promise<RemoteConfig | undefined> => {
    if (!configured || host === undefined) return undefined
    const now = Date.now()
    if (remote !== undefined && now - remoteAt < CONFIG_TTL_MS) return remote
    if (remote === undefined && remoteFailedAt > 0 && now - remoteFailedAt < CONFIG_RETRY_MS)
      return undefined
    inflight ??= (async () => {
      try {
        const res = await doFetch(`${host}/config`, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        })
        if (!res.ok) throw new Error(`config ${res.status}`)
        const body = (await res.json()) as { key?: unknown; replay?: unknown }
        const key = typeof body.key === 'string' && KEY_SHAPE.test(body.key) ? body.key : null
        remote = { key, replay: body.replay === true }
        remoteAt = Date.now()
        return remote
      } catch {
        remoteFailedAt = Date.now()
        return remote
      } finally {
        inflight = undefined
      }
    })()
    return inflight
  }

  const view = async (): Promise<TelemetryView> => {
    const cfg = stored.enabled ? await remoteConfig() : undefined
    const active = stored.enabled && configured && host !== undefined && cfg?.key != null
    const account = options.accountId?.()
    return {
      enabled: stored.enabled,
      notice_seen: stored.notice_seen,
      install_id: stored.install_id,
      configured,
      active,
      ...(active && host !== undefined && cfg?.key != null
        ? { client: { api_host: TELEMETRY_RELAY_PATH, key: cfg.key, replay: cfg.replay } }
        : {}),
      ...(account === undefined || account === '' ? {} : { account_id: account }),
    }
  }

  // ── 出门 ─────────────────────────────────────────────
  type Queued = {
    event: string
    properties: Record<string, unknown>
    timestamp: string
    uuid?: string
  }
  let queue: Queued[] = []

  const capture = (event: TelemetryEventName, props: Record<string, unknown>): void => {
    if (!configured || !stored.enabled) return
    const account = options.accountId?.()
    const clean = sanitizeTelemetryProps(event, {
      ...props,
      shell: 'server',
      install_id: stored.install_id,
      ...(options.appVersion === undefined ? {} : { app_version: options.appVersion }),
      ...(account === undefined ? {} : { account_id: account }),
    })
    if (clean === null) return
    queue.push({
      event,
      properties: {
        ...clean,
        distinct_id: stored.install_id,
        $lib: 'agentsws-server',
        // 服务端的事件不建「人」：日活 / 留存只按工作台那一侧算
        $process_person_profile: false,
      },
      timestamp: options.now(),
    })
    if (queue.length > QUEUE_MAX) queue = queue.slice(-QUEUE_MAX)
    if (queue.length >= BATCH_SIZE) void flush()
  }

  const flush = async (): Promise<void> => {
    if (queue.length === 0) return
    const batch = queue
    queue = []
    if (!configured || host === undefined || !stored.enabled) return
    const cfg = await remoteConfig()
    if (cfg?.key == null) return
    try {
      await doFetch(`${host}/batch/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: cfg.key, batch }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      // 发不出去就算了（不重试、不落盘）
    }
  }

  const timer =
    configured && (options.flushIntervalMs ?? 30_000) > 0
      ? setInterval(() => void flush(), options.flushIntervalMs ?? 30_000)
      : undefined
  timer?.unref?.()

  // ── 运行收尾 ─────────────────────────────────────────
  const runs = new Map<string, { role_id: string; position_id?: string; runtime?: string }>()
  const builtIn = (
    id: string | undefined,
    set: ReadonlySet<string> | undefined,
  ): string | undefined => (id === undefined ? undefined : set?.has(id) === true ? id : 'custom')

  const onEvent: Telemetry['onEvent'] = (e) => {
    if (!configured || !stored.enabled || !e.type.startsWith('run.')) return
    try {
      const run_id = e.correlation.run_id ?? e.actor.run_id
      if (run_id === undefined) return
      const payload = (e.payload ?? {}) as Record<string, unknown>
      if (e.type === 'run.started') {
        const place = e.actor.kind === 'agent' ? options.placeOf?.(e.actor.id) : undefined
        const role_id = builtIn(place?.role_id, options.bundledRoleIds?.()) ?? 'unknown'
        const position_id = builtIn(place?.position_id, options.bundledPositionIds?.())
        runs.set(run_id, {
          role_id,
          ...(position_id === undefined ? {} : { position_id }),
          ...(typeof payload.runtime === 'string' ? { runtime: payload.runtime } : {}),
        })
        if (runs.size > RUNS_MAX) runs.delete(runs.keys().next().value as string)
        return
      }
      const outcome =
        e.type === 'run.completed'
          ? 'success'
          : e.type === 'run.failed'
            ? 'failure'
            : e.type === 'run.cancelled'
              ? 'cancelled'
              : undefined
      if (outcome === undefined) return
      const started = runs.get(run_id)
      runs.delete(run_id)
      const usage = (payload.usage ?? {}) as Partial<Record<string, number>>
      const error = (payload.error ?? {}) as { code?: unknown }
      capture('task_finished', {
        outcome,
        ...(outcome === 'success'
          ? {
              cost_tier: telemetryCostTier(usage.cost_base ?? 0),
              cache_tier: telemetryCacheTier(usage.cached_tokens ?? 0, usage.input_tokens ?? 0),
            }
          : {}),
        ...(started === undefined ? {} : started),
        ...(typeof error.code === 'string' ? { error_code: error.code.toLowerCase() } : {}),
      })
    } catch {
      // 记数据这件事绝不能把事件日志那条路带坏
    }
  }

  const onCardDecided: Telemetry['onCardDecided'] = (item) => {
    try {
      capture('card_decided', { decision: decisionOf(item.state), card_kind: item.kind })
    } catch {
      // 同上
    }
  }

  // ── 工作台经本机转发 ─────────────────────────────────
  const post = async (url: string, body: unknown): Promise<Response | undefined> => {
    try {
      return await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      return undefined
    }
  }

  const ingest: Telemetry['ingest'] = async (input) => {
    try {
      if (!configured || host === undefined || !stored.enabled) return OK_REPLY
      const cfg = await remoteConfig()
      if (cfg?.key == null) return OK_REPLY
      const params = new URLSearchParams(input.query)

      // 录屏要的两条（远程配置 / 功能开关）：只在云上开了录屏时转；转的是重新拼的最小请求体
      if (input.kind === 'config' || input.kind === 'flags') {
        if (!cfg.replay) return { status: 404, body: '{}' }
        const res =
          input.kind === 'config'
            ? await doFetch(`${host}/array/${cfg.key}/config`, {
                method: 'GET',
                signal: AbortSignal.timeout(10_000),
              }).catch(() => undefined)
            : await post(`${host}/flags/?v=2&config=true`, {
                token: cfg.key,
                distinct_id: distinctOf(decodeIngestBody(input.body, params)),
              })
        if (res === undefined) return { status: 502, body: '{}' }
        return { status: res.status, body: await res.text() }
      }

      const items = eventsOf(decodeIngestBody(input.body, params)).slice(0, INGEST_MAX_EVENTS)
      const events: Queued[] = []
      const snapshots: { event: string; properties: Record<string, unknown> }[] = []
      for (const item of items) {
        const props = item.properties
        // key 对不上（不是我们工作台发的）整条丢
        if (props.token !== cfg.key) continue
        const clean = sanitizeTelemetryProps(item.event, props, { replay: cfg.replay })
        if (clean === null) continue
        if (item.event === '$snapshot') {
          snapshots.push({ event: item.event, properties: { ...clean, token: cfg.key } })
          continue
        }
        events.push({
          event: item.event,
          properties: clean,
          timestamp: item.timestamp ?? options.now(),
          ...(item.uuid === undefined ? {} : { uuid: item.uuid }),
        })
      }
      if (events.length > 0) await post(`${host}/batch/`, { api_key: cfg.key, batch: events })
      if (snapshots.length > 0) await post(`${host}/s/`, snapshots)
      return OK_REPLY
    } catch {
      // 解不开 / 不是 JSON：当没收到，SDK 也不必重试
      return OK_REPLY
    }
  }

  return {
    view,
    ingest,
    async update(patch) {
      stored = {
        ...stored,
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        ...(patch.notice_seen === undefined ? {} : { notice_seen: patch.notice_seen }),
      }
      save(options.dir, stored)
      // 关了：手上没发出去的也一起扔掉
      if (!stored.enabled) queue = []
      return view()
    },
    onEvent,
    onCardDecided,
    flush,
    close() {
      if (timer !== undefined) clearInterval(timer)
      void flush()
    },
  }
}

/** 一次请求的请求体 → JSON（posthog-js 的三种编法：JSON、gzip、`data=<base64>` 表单）。 */
export function decodeIngestBody(body: Uint8Array, params: URLSearchParams): unknown {
  let bytes = Buffer.from(body)
  if (bytes.length === 0) return undefined
  const compression = params.get('compression')
  if (compression === 'gzip-js' || (bytes[0] === 0x1f && bytes[1] === 0x8b))
    bytes = gunzipSync(bytes, { maxOutputLength: INGEST_MAX_BYTES })
  let text = bytes.toString('utf8')
  if (text.startsWith('data=')) {
    text = decodeURIComponent(text.slice('data='.length).replace(/\+/g, ' '))
    if (!/^\s*[[{]/.test(text)) text = Buffer.from(text, 'base64').toString('utf8')
  }
  return JSON.parse(text) as unknown
}

interface IngestItem {
  event: string
  properties: Record<string, unknown>
  timestamp?: string
  uuid?: string
}

const ISO = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:?\d{2})$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 解开的请求体 → 一条条事件（数组、`{ batch: [...] }`、单条都认）；形状不对的丢。 */
function eventsOf(decoded: unknown): IngestItem[] {
  const list = Array.isArray(decoded)
    ? decoded
    : decoded !== null &&
        typeof decoded === 'object' &&
        Array.isArray((decoded as { batch?: unknown }).batch)
      ? (decoded as { batch: unknown[] }).batch
      : [decoded]
  const out: IngestItem[] = []
  for (const raw of list) {
    if (raw === null || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    if (typeof r.event !== 'string' || r.properties === null || typeof r.properties !== 'object')
      continue
    out.push({
      event: r.event,
      properties: r.properties as Record<string, unknown>,
      ...(typeof r.timestamp === 'string' && ISO.test(r.timestamp)
        ? { timestamp: r.timestamp }
        : {}),
      ...(typeof r.uuid === 'string' && UUID.test(r.uuid) ? { uuid: r.uuid } : {}),
    })
  }
  return out
}

/** 功能开关请求里那个匿名号（只认不透明编号的样子）。 */
function distinctOf(decoded: unknown): string | undefined {
  const id = (decoded as { distinct_id?: unknown } | undefined)?.distinct_id
  return typeof id === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : undefined
}
