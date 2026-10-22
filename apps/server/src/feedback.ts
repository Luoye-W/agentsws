/**
 * WP475（决策 1591、1592）：左下角「反馈」在本机的那一半。
 *
 * 一句话职责：把工作台交上来的一条反馈**先存本机**，再发到工坊云（`POST /v1/feedback`，不要求登录：
 * 匿名 + 设备号）；云不通就留在队列里，联网后自动补发；发出去之后定时拿 ticket 去云上问进度，
 * 有了回复 / 修好了就进铃铛一条。
 *
 * ## 诊断信息：白名单 + 出门前洗一遍
 *
 * 只有这几样（{@link FeedbackDiagnostics}）：版本、系统、语言、当前页面路径、最近 50 条错误日志。
 * 错误日志来自 {@link ErrorRing}（前端报错 + 服务进程 stderr），每一条出门前过 {@link scrubDiagnosticLine}：
 *
 * 1. 密钥形态（`@agentsws/core` 的 `scrub` + 日志脱敏器，含注入的密钥字面量）；
 * 2. 卡号 / 验证码 / 口令（`maskSensitive`）；
 * 3. 网址去查询串、邮箱 / 长数字 / 长令牌换占位（与 `/v1/client-errors` 同一份 `scrubClientText`）；
 * 4. **引号里的字一律换掉**：我们自己的报错把业务内容（标题、客户名、邮件片段、草稿）都放在引号里
 *    （「…」、"…"、“…”），这一步把它们整段拿掉——报错的骨架留着，内容不出门；
 * 5. 一条一行、截到 {@link FEEDBACK_ERROR_LINE_MAX} 字。
 *
 * 云收到之后再洗一遍（私有云仓那一侧）。
 *
 * ## 队列
 *
 * 一台机器一份 `feedback/state.json`（设备号 + 每一条），截图在发出去之前放 `feedback/shots/`，
 * 发出去就删。没有数据目录（内存档 / 测试）就都在内存里。
 */
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { join } from 'node:path'
import type { FeedbackActor, FeedbackPageContext, FeedbackPort } from '@agentsws/api'
import { ApiError, scrubClientText } from '@agentsws/api'
import type {
  Clock,
  FeedbackDiagnostics,
  FeedbackKind,
  FeedbackReply,
  FeedbackScreenshotType,
  FeedbackStatus,
  FeedbackStatusList,
  FeedbackSubmitRequest,
  FeedbackSubmitted,
  LocalFeedbackItem,
  LocalFeedbackState,
  LocalFeedbackSubmit,
  NotificationInput,
} from '@agentsws/contracts'
import {
  FEEDBACK_ERROR_LINE_MAX,
  FEEDBACK_ERRORS_MAX,
  FEEDBACK_SCREENSHOT_MAX_BYTES,
  FEEDBACK_STATUS_MAX_TICKETS,
} from '@agentsws/contracts'
import { defaultLogRedactor, maskSensitive, type Redactor, scrub } from '@agentsws/core'

// ── 最近的错误日志 ─────────────────────────────────────────────────────────

/** 最近的错误日志（只在内存里，至多 {@link FEEDBACK_ERRORS_MAX} 条）。 */
export interface ErrorRing {
  push(line: string): void
  lines(): string[]
}

export function createErrorRing(limit: number = FEEDBACK_ERRORS_MAX): ErrorRing {
  const buf: string[] = []
  return {
    push: (line) => {
      for (const one of line.split(/\r?\n/)) {
        const text = one.trim()
        if (text === '') continue
        // 进来就先截一刀：一条几百 KB 的栈不该在内存里待着
        buf.push(text.length > 4000 ? text.slice(0, 4000) : text)
        if (buf.length > limit) buf.splice(0, buf.length - limit)
      }
    },
    lines: () => [...buf],
  }
}

/** 服务进程这一份（`index.ts` 把 stderr 接进来；`server.ts` 把前端报错接进来）。 */
export const processErrorRing: ErrorRing = createErrorRing()

/**
 * 把 stderr 的每一行也记一份进 ring（原样照写，不改 stderr 本身的行为）。回解开的函数。
 * 只在生产入口（`index.ts`）调；测试里不碰全局 stderr。
 */
export function tapStderr(
  ring: ErrorRing,
  stream: NodeJS.WriteStream = process.stderr,
  skip: (line: string) => boolean = () => false,
): () => void {
  const original = stream.write.bind(stream)
  let pending = ''
  const tapped = ((chunk: unknown, ...rest: unknown[]): boolean => {
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : chunk instanceof Uint8Array
            ? Buffer.from(chunk).toString('utf8')
            : ''
      pending += text
      const parts = pending.split('\n')
      pending = parts.pop() ?? ''
      if (pending.length > 8000) pending = ''
      for (const p of parts) if (!skip(p)) ring.push(p)
    } catch {
      // 记 ring 这件事绝不能让写日志本身出错
    }
    return (original as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof stream.write
  stream.write = tapped
  return () => {
    if (stream.write === tapped) stream.write = original
  }
}

/** 前端报错（网关洗过的那一条）在 ring 里的一行：没有引号，栈与路径留着好排查。 */
export function clientErrorRingLine(entry: {
  kind: string
  name: string
  message: string
  route: string
  stack?: string
}): string {
  const stack = entry.stack === undefined || entry.stack === '' ? '' : ` | ${entry.stack}`
  return `[client] ${entry.kind} ${entry.route} ${entry.name}: ${entry.message}${stack}`
}

// ── 脱敏 ──────────────────────────────────────────────────────────────────

/** 引号（中英文、书名号）里的整段：业务内容（标题、客户名、邮件片段、草稿）都在这里面。 */
const QUOTED =
  /「[^」]*」|『[^』]*』|《[^》]*》|“[^”]*”|‘[^’]*’|"(?:[^"\\]|\\.)*"|`[^`]*`|'[^'\n]{1,200}'/g

const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

/**
 * 一条错误日志出门前的那一遍（见文件头的 1–5）。`redact` 给的是日志那边注册过密钥字面量的脱敏器。
 */
export function scrubDiagnosticLine(line: string, redact: Redactor = defaultLogRedactor): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 一条一行
  let out = line.replace(/[\u0000-\u001f\u007f]+/g, ' ')
  out = redact(out)
  out = scrub(out).text
  out = maskSensitive(out).text
  out = out.replace(QUOTED, '«…»')
  out = scrubClientText(out)
  return cut(out.replace(/\s+/g, ' ').trim(), FEEDBACK_ERROR_LINE_MAX)
}

/** 页面路径：只留路径，查询串 / `#…` 一律去掉，再洗一遍（路径里也可能夹着邮箱、长 id）。 */
export function scrubRoute(route: string): string {
  return cut(scrubClientText(route.replace(/[?#].*$/, '')), 200) || '/'
}

// ── 存储 ──────────────────────────────────────────────────────────────────

interface FeedbackRecord {
  client_id: string
  workspace_id: string
  person_id: string
  kind: FeedbackKind
  message: string
  contact?: string
  diagnostics?: FeedbackDiagnostics
  /** 还没发出去的截图（发出去就删）。 */
  shot?: { content_type: FeedbackScreenshotType; file: string }
  has_screenshot: boolean
  written_at: string
  updated_at: string
  state: LocalFeedbackState
  attempts: number
  next_try_at?: string
  id?: string
  ticket?: string
  status?: FeedbackStatus
  replies: FeedbackReply[]
  /** 本人在「我的反馈」里看过几条回复。 */
  seen_replies: number
  /** 铃铛已经说过几条回复。 */
  notified_replies: number
  /** 铃铛已经说过的状态（修好了 / 不修只说一次）。 */
  notified_status?: FeedbackStatus
}

interface FeedbackState {
  version: 1
  device_id: string
  items: FeedbackRecord[]
}

/** 本机最多记多少条（超了删最老的已发出的）。 */
export const FEEDBACK_LOCAL_MAX = 200
/** 补发间隔的上下限（毫秒）。 */
export const FEEDBACK_RETRY_MIN_MS = 30_000
export const FEEDBACK_RETRY_MAX_MS = 30 * 60_000
/** 多久去云上问一次进度。 */
export const FEEDBACK_POLL_MS = 30 * 60_000
/** 「我的反馈」点开时最多多久问一次。 */
export const FEEDBACK_REFRESH_MIN_MS = 20_000
/** 发一条最多等多久（截图大，比别的云调用宽一点）。 */
export const FEEDBACK_SEND_TIMEOUT_MS = 20_000

/** 回复进铃铛那一条的去处：任何一页上带 `?feedback=mine` 都会打开「我的反馈」。 */
export const FEEDBACK_MINE_HREF = '/?feedback=mine'

export type FeedbackFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface FeedbackServiceOptions {
  clock: Clock
  /** 数据目录（`feedback/` 建在它下面）；不给就只在内存里。 */
  dir?: string
  /** 工坊云地址（每次现取：设置里换了云地址也跟着换）。 */
  cloudBase: () => string
  fetch?: FeedbackFetch
  /** 服务版本（浏览器里打开、没有桌面壳版本时用它）。 */
  serverVersion: string
  /** 默认联系方式：关联了工坊账号就是那个邮箱。 */
  contactOf?: (actor: FeedbackActor) => Promise<string | undefined> | string | undefined
  /** 有回复 / 修好了 → 铃铛一条。 */
  notify?: (input: NotificationInput) => void
  errors?: ErrorRing
  redact?: Redactor
  /** 系统一行（测试注入）。 */
  os?: string
  /** 随机字节（测试注入，可重复）。 */
  randomHex?: (bytes: number) => string
}

export interface FeedbackService {
  port: FeedbackPort
  /** 补发到点的、到点了去问进度（定时器调；测试直接调）。 */
  tick(opts?: { forcePoll?: boolean }): Promise<void>
  start(intervalMs?: number): void
  stop(): void
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const EXT: Record<FeedbackScreenshotType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

/** base64 解码之后多少字节（不真解）。 */
export function base64Bytes(b64: string): number {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.floor((b64.length * 3) / 4) - pad
}

const defaultFetch: FeedbackFetch = async (url, init) => {
  const res = await fetch(url, init)
  return { ok: res.ok, status: res.status, text: () => res.text() }
}

export function createFeedbackService(options: FeedbackServiceOptions): FeedbackService {
  const doFetch = options.fetch ?? defaultFetch
  const ring = options.errors ?? processErrorRing
  const redact = options.redact ?? defaultLogRedactor
  const hex = options.randomHex ?? ((n: number): string => randomBytes(n).toString('hex'))
  const os = options.os ?? `${osPlatform()} ${osArch()} ${osRelease()}`
  const root = options.dir === undefined ? undefined : join(options.dir, 'feedback')
  const shotsDir = root === undefined ? undefined : join(root, 'shots')
  const statePath = root === undefined ? undefined : join(root, 'state.json')
  /** 内存档的截图。 */
  const memShots = new Map<string, string>()
  const now = (): string => options.clock.now()
  const nowMs = (): number => Date.parse(now())

  const load = (): FeedbackState => {
    if (statePath !== undefined && existsSync(statePath)) {
      try {
        const raw = JSON.parse(readFileSync(statePath, 'utf8')) as unknown
        if (isRecord(raw) && typeof raw.device_id === 'string' && Array.isArray(raw.items))
          return { version: 1, device_id: raw.device_id, items: raw.items as FeedbackRecord[] }
      } catch {
        // 坏了就从头来（设备号换一个——只是云上看起来像一台新电脑）
      }
    }
    return { version: 1, device_id: `dev_${hex(16)}`, items: [] }
  }
  const state = load()
  const save = (): void => {
    if (statePath === undefined || root === undefined) return
    mkdirSync(root, { recursive: true })
    const tmp = `${statePath}.tmp`
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
    renameSync(tmp, statePath)
  }
  if (statePath !== undefined && !existsSync(statePath)) save()

  const writeShot = (name: string, b64: string): void => {
    if (shotsDir === undefined) {
      memShots.set(name, b64)
      return
    }
    mkdirSync(shotsDir, { recursive: true })
    writeFileSync(join(shotsDir, name), Buffer.from(b64, 'base64'), { mode: 0o600 })
  }
  const readShot = (name: string): string | undefined => {
    if (shotsDir === undefined) return memShots.get(name)
    const p = join(shotsDir, name)
    return existsSync(p) ? readFileSync(p).toString('base64') : undefined
  }
  const dropShot = (r: FeedbackRecord): void => {
    if (r.shot === undefined) return
    if (shotsDir === undefined) memShots.delete(r.shot.file)
    else rmSync(join(shotsDir, r.shot.file), { force: true })
    delete r.shot
  }

  const diagnosticsOf = (page: FeedbackPageContext): FeedbackDiagnostics => ({
    app_version: scrubDiagnosticLine(page.app_version ?? options.serverVersion, redact).slice(
      0,
      80,
    ),
    os,
    locale: page.locale.replace(/[^\w-]/g, '').slice(0, 40),
    route: scrubRoute(page.route),
    ...(page.shell === undefined ? {} : { shell: page.shell }),
    errors: ring
      .lines()
      .slice(-FEEDBACK_ERRORS_MAX)
      .map((l) => scrubDiagnosticLine(l, redact))
      .filter((l) => l !== ''),
  })

  const view = (r: FeedbackRecord): LocalFeedbackItem => ({
    client_id: r.client_id,
    ...(r.id === undefined ? {} : { id: r.id }),
    kind: r.kind,
    message: r.message,
    state: r.state,
    ...(r.status === undefined ? {} : { status: r.status }),
    replies: r.replies,
    unread_replies: Math.max(0, r.replies.length - r.seen_replies),
    has_screenshot: r.has_screenshot,
    has_diagnostics: r.diagnostics !== undefined,
    created_at: r.written_at,
    updated_at: r.updated_at,
  })

  const mineOf = (actor: FeedbackActor): FeedbackRecord[] =>
    state.items
      .filter((r) => r.workspace_id === actor.workspace_id && r.person_id === actor.person_id)
      .sort((a, b) => b.written_at.localeCompare(a.written_at))

  const base = (): string => options.cloudBase().replace(/\/+$/, '')

  const post = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; data?: unknown } | undefined> => {
    try {
      const res = await doFetch(`${base()}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FEEDBACK_SEND_TIMEOUT_MS),
      })
      let data: unknown
      try {
        const parsed = JSON.parse(await res.text()) as unknown
        data = isRecord(parsed) ? parsed.data : undefined
      } catch {
        data = undefined
      }
      return { status: res.status, ...(data === undefined ? {} : { data }) }
    } catch {
      return undefined
    }
  }

  const backoff = (attempts: number): number =>
    Math.min(FEEDBACK_RETRY_MAX_MS, FEEDBACK_RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1))

  const sending = new Set<string>()

  /** 发一条；回发没发出去（云收了 = true）。 */
  const send = async (r: FeedbackRecord): Promise<boolean> => {
    if (r.state !== 'queued' || sending.has(r.client_id)) return r.state === 'sent'
    sending.add(r.client_id)
    try {
      const shot = r.shot === undefined ? undefined : readShot(r.shot.file)
      const request: FeedbackSubmitRequest = {
        client_id: r.client_id,
        device_id: state.device_id,
        kind: r.kind,
        message: r.message,
        ...(r.contact === undefined || r.contact === '' ? {} : { contact: r.contact }),
        ...(r.diagnostics === undefined ? {} : { diagnostics: r.diagnostics }),
        ...(r.shot === undefined || shot === undefined
          ? {}
          : { screenshot: { content_type: r.shot.content_type, data_base64: shot } }),
        written_at: r.written_at,
      }
      const res = await post('/v1/feedback', request)
      r.updated_at = now()
      if (res !== undefined && res.status === 200 && isRecord(res.data)) {
        const got = res.data as unknown as FeedbackSubmitted
        if (typeof got.id === 'string' && typeof got.ticket === 'string') {
          r.state = 'sent'
          r.id = got.id
          r.ticket = got.ticket
          r.status = got.status
          delete r.next_try_at
          dropShot(r)
          save()
          return true
        }
      }
      if (res !== undefined && res.status === 413 && r.shot !== undefined) {
        // 截图太大云不收：不带截图再来一次（一句话比截图要紧）
        dropShot(r)
        save()
        sending.delete(r.client_id)
        return await send(r)
      }
      if (res !== undefined && (res.status === 400 || res.status === 413)) {
        r.state = 'failed'
        delete r.next_try_at
        dropShot(r)
        save()
        return false
      }
      // 云不通 / 5xx / 限流：等一会儿再补发
      r.attempts += 1
      r.next_try_at = new Date(nowMs() + backoff(r.attempts)).toISOString()
      save()
      return false
    } finally {
      sending.delete(r.client_id)
    }
  }

  const notifyOf = (r: FeedbackRecord, text: string): void => {
    if (options.notify === undefined || r.id === undefined) return
    try {
      options.notify({
        workspace_id: r.workspace_id as never,
        person_id: r.person_id as never,
        category: 'feedback',
        text,
        href: FEEDBACK_MINE_HREF,
        key: `feedback:${r.id}`,
      })
    } catch {
      // 铃铛没进去不影响进度本身
    }
  }

  let lastPoll = 0
  /** 去云上问一遍进度；回问没问成（云不通 = false）。 */
  const poll = async (): Promise<boolean> => {
    const sent = state.items.filter((r) => r.state === 'sent' && r.ticket !== undefined)
    lastPoll = nowMs()
    if (sent.length === 0) return true
    let okAll = true
    for (let i = 0; i < sent.length; i += FEEDBACK_STATUS_MAX_TICKETS) {
      const batch = sent.slice(i, i + FEEDBACK_STATUS_MAX_TICKETS)
      const res = await post('/v1/feedback/status', { tickets: batch.map((r) => r.ticket) })
      if (res === undefined || res.status !== 200 || !isRecord(res.data)) {
        okAll = false
        continue
      }
      const list = res.data as unknown as FeedbackStatusList
      const byId = new Map((Array.isArray(list.items) ? list.items : []).map((v) => [v.id, v]))
      for (const r of batch) {
        const v = r.id === undefined ? undefined : byId.get(r.id)
        if (v === undefined) continue
        const replies = Array.isArray(v.replies) ? v.replies : []
        const changed = v.status !== r.status || replies.length !== r.replies.length
        r.status = v.status
        r.replies = replies.map((x) => ({ at: x.at, text: x.text }))
        if (changed) r.updated_at = now()
        if (r.replies.length > r.notified_replies) {
          notifyOf(r, '你的反馈有了回复')
          r.notified_replies = r.replies.length
          if (v.status === 'fixed' || v.status === 'wont_fix') r.notified_status = v.status
        } else if (
          (v.status === 'fixed' || v.status === 'wont_fix') &&
          r.notified_status !== v.status
        ) {
          notifyOf(r, v.status === 'fixed' ? '你反馈的问题修好了' : '你的反馈有了结果')
          r.notified_status = v.status
        }
      }
    }
    save()
    return okAll
  }

  const retryDue = async (): Promise<void> => {
    const t = nowMs()
    for (const r of state.items) {
      if (r.state !== 'queued') continue
      if (r.next_try_at !== undefined && Date.parse(r.next_try_at) > t) continue
      await send(r)
    }
  }

  const trim = (): void => {
    if (state.items.length <= FEEDBACK_LOCAL_MAX) return
    const oldest = [...state.items].sort((a, b) => a.written_at.localeCompare(b.written_at))
    const over = state.items.length - FEEDBACK_LOCAL_MAX
    const drop = new Set(
      [...oldest.filter((r) => r.state !== 'queued'), ...oldest.filter((r) => r.state === 'queued')]
        .slice(0, over)
        .map((r) => r.client_id),
    )
    for (const r of state.items) if (drop.has(r.client_id)) dropShot(r)
    state.items = state.items.filter((r) => !drop.has(r.client_id))
  }

  const port: FeedbackPort = {
    draft: async (actor, page) => {
      let contact: string | undefined
      try {
        contact = (await options.contactOf?.(actor)) ?? undefined
      } catch {
        contact = undefined
      }
      return {
        ...(contact === undefined || contact === '' ? {} : { contact }),
        diagnostics: diagnosticsOf(page),
      }
    },
    submit: async (actor, input: LocalFeedbackSubmit) => {
      const client_id = `fbc_${hex(12)}`
      const at = now()
      let shot: FeedbackRecord['shot']
      if (input.screenshot !== undefined) {
        if (base64Bytes(input.screenshot.data_base64) > FEEDBACK_SCREENSHOT_MAX_BYTES)
          throw new ApiError('invalid_input', '截图太大了，换一张小一点的')
        const file = `${client_id}.${EXT[input.screenshot.content_type]}`
        writeShot(file, input.screenshot.data_base64)
        shot = { content_type: input.screenshot.content_type, file }
      }
      const contact = input.contact?.trim()
      const record: FeedbackRecord = {
        client_id,
        workspace_id: actor.workspace_id,
        person_id: actor.person_id,
        kind: input.kind,
        message: input.message.trim(),
        ...(contact === undefined || contact === '' ? {} : { contact }),
        ...(input.include_diagnostics
          ? {
              diagnostics: diagnosticsOf({
                route: input.route,
                locale: input.locale,
                ...(input.app_version === undefined ? {} : { app_version: input.app_version }),
                ...(input.shell === undefined ? {} : { shell: input.shell }),
              }),
            }
          : {}),
        ...(shot === undefined ? {} : { shot }),
        has_screenshot: shot !== undefined,
        written_at: at,
        updated_at: at,
        state: 'queued',
        attempts: 0,
        replies: [],
        seen_replies: 0,
        notified_replies: 0,
      }
      state.items.push(record)
      trim()
      save()
      const delivered = await send(record)
      return { item: view(record), delivered }
    },
    mine: async (actor, opts) => {
      let stale = false
      if (opts.refresh && nowMs() - lastPoll >= FEEDBACK_REFRESH_MIN_MS) {
        await retryDue()
        stale = !(await poll())
      }
      return { items: mineOf(actor).map(view), ...(stale ? { stale: true } : {}) }
    },
    seen: (actor) => {
      let changed = false
      for (const r of mineOf(actor))
        if (r.seen_replies !== r.replies.length) {
          r.seen_replies = r.replies.length
          changed = true
        }
      if (changed) save()
      return { unread: 0 }
    },
  }

  let timer: ReturnType<typeof setInterval> | undefined
  let busy = false
  const tick = async (opts?: { forcePoll?: boolean }): Promise<void> => {
    if (busy) return
    busy = true
    try {
      await retryDue()
      if (opts?.forcePoll === true || nowMs() - lastPoll >= FEEDBACK_POLL_MS) await poll()
    } finally {
      busy = false
    }
  }

  return {
    port,
    tick,
    start: (intervalMs = 60_000) => {
      if (timer !== undefined) return
      timer = setInterval(() => {
        void tick().catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    },
    stop: () => {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}
