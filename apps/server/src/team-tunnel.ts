/**
 * WP427：发起人电脑 ↔ 工坊云的「团队通道」客户端。
 *
 * 发起人不开端口、不要公网 IP、不装任何东西：这条连接是**本机拨出去**的（与 WP124 聊天转发器同一个
 * 路数）。云给这条通道一个地址，不在同一个网络里的同事打开那个地址，请求被打成 `request` 帧送下来，
 * 这里交给「团队门」（`team-door.ts`，与局域网那条路同一个门），响应按块流回去。
 *
 * - 要工坊账号：申请通道用这台电脑关联账号时签的那把工作区令牌（没关联 = `needs_account`，界面上说
 *   「登录工坊账号后，不在同一个网络的同事也能连进来」）。
 * - 通道 id、地址、握手密钥存在本机加密库里；握手被拒（密钥换了 / 云上清过）就重新申请一次。
 * - 断线指数退避重连；15 秒没动静发 `ping`。
 * - 同事那边关了页面：云发 `cancel`，这里把那一次转发掐掉。
 *
 * 运行环境：Node 22 自带 WebSocket 客户端；测试注入替身或真连本机的云替身（`team-relay.ts`）。
 */
import {
  TEAM_TUNNEL_CHUNK_BYTES,
  TEAM_TUNNEL_HEARTBEAT_MS,
  TEAM_TUNNEL_PROTOCOL_VERSION,
  type TeamTunnelClientFrame,
  type TeamTunnelIssued,
  type TeamTunnelServerFrame,
} from '@agentsws/contracts'

/** 对外 WebSocket 客户端的最小面（Node 自带的 WebSocket 与测试替身都长这样）。 */
export interface TunnelSocket {
  send(text: string): void
  close(): void
  addEventListener(type: 'open', handler: () => void): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
  addEventListener(type: 'error', handler: () => void): void
}

export type TunnelSocketFactory = (url: string) => TunnelSocket

/** 出站 HTTP（与 `cloud-account.ts` 的 `CloudFetch` 同形）。 */
export type TunnelFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export type TeamTunnelState =
  | 'stopped'
  /** 这台电脑还没关联工坊账号。 */
  | 'needs_account'
  | 'registering'
  | 'connecting'
  | 'online'
  /** 断了 / 没申请下来：等一会儿再试。 */
  | 'backoff'

/** 本机加密库里存通道的那一格（字段：`tunnel_id` / `url` / `secret`）。 */
export const TEAM_TUNNEL_SECRET_ID = 'team.tunnel'

export interface TunnelVault {
  get(): TeamTunnelIssued | undefined
  set(value: TeamTunnelIssued | undefined): void
}

export interface TeamTunnelOptions {
  /** 云的地址（不带尾斜杠）。 */
  cloudBase(): string
  /** 工作区令牌（没关联 = undefined）。 */
  token(): string | undefined
  vault: TunnelVault
  /** 「团队门」那一下。 */
  handler(req: Request): Promise<Response>
  fetch?: TunnelFetch
  socketFactory?: TunnelSocketFactory
  onEvent?(event: { type: string; detail?: string }): void
  heartbeatMs?: number
  maxBackoffMs?: number
}

export interface TeamTunnel {
  /** 开（幂等）：没令牌就停在 `needs_account`，有了令牌下一次 `start` 再试。 */
  start(): void
  stop(): void
  state(): TeamTunnelState
  /** 同事打开的地址（申请下来过就有，哪怕这会儿断着）。 */
  url(): string | undefined
  /** 最近一次没成的原因（人话）。 */
  reason(): string | undefined
  /** 登记一个邀请码（通道还没申请下来就先申请）。回登记成了没有。 */
  registerCode(code: string, expires_at: string): Promise<boolean>
  /** 等到 online（测试与诊断用；超时回 false）。 */
  whenOnline(timeoutMs?: number): Promise<boolean>
}

const MAX_BACKOFF_MS = 60_000

/**
 * `https://host` → `wss://host/v1/team/tunnel/connect`。
 *
 * WP435：给了通道号就带在地址上（`?tunnel_id=<id>`）——云那边直接把这条连接接到这条通道的对象上，
 * 入口不用先读 hello 再转一手。不带也连得上（云认第一帧 hello 里的通道号），只是多一跳。
 */
export function tunnelConnectUrl(cloudBase: string, tunnel_id?: string): string {
  const base = cloudBase.replace(/\/+$/, '')
  const ws = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base
  const hint =
    tunnel_id !== undefined && /^[a-z0-9]{1,64}$/.test(tunnel_id) ? `?tunnel_id=${tunnel_id}` : ''
  return `${ws}/v1/team/tunnel/connect${hint}`
}

/** 邀请码 → 登记用的哈希（大写、去空白后 sha256）。 */
export async function teamCodeHash(code: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(code.trim().toUpperCase()).digest('hex')
}

async function defaultFetch(
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string> }> {
  return fetch(input, {
    ...(init?.method === undefined ? {} : { method: init.method }),
    ...(init?.headers === undefined ? {} : { headers: init.headers }),
    ...(init?.body === undefined ? {} : { body: init.body }),
    signal: AbortSignal.timeout(15_000),
  })
}

function parseServerFrame(raw: unknown): TeamTunnelServerFrame | undefined {
  if (typeof raw !== 'string') return undefined
  try {
    const frame = JSON.parse(raw) as { type?: unknown }
    if (typeof frame !== 'object' || frame === null || typeof frame.type !== 'string')
      return undefined
    return frame as TeamTunnelServerFrame
  } catch {
    return undefined
  }
}

/**
 * 同事贴了一个本机、局域网里都找不到的码：问云这是哪条通道的。回通道地址；没有回 undefined。
 * 这一步不要令牌（贴码的人可能还没关联账号）。
 */
export async function resolveTeamCode(
  cloudBase: string,
  code: string,
  doFetch: TunnelFetch = defaultFetch,
): Promise<string | undefined> {
  try {
    const res = await doFetch(`${cloudBase.replace(/\/+$/, '')}/v1/team/codes/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: code.trim().toUpperCase() }),
    })
    if (!res.ok) return undefined
    const body = JSON.parse(await res.text()) as { data?: { url?: unknown } }
    return typeof body.data?.url === 'string' ? body.data.url.replace(/\/+$/, '') : undefined
  } catch {
    return undefined
  }
}

export function createTeamTunnel(options: TeamTunnelOptions): TeamTunnel {
  const doFetch = options.fetch ?? defaultFetch
  const factory: TunnelSocketFactory =
    options.socketFactory ?? ((url) => new WebSocket(url) as unknown as TunnelSocket)
  const heartbeatMs = options.heartbeatMs ?? TEAM_TUNNEL_HEARTBEAT_MS
  const maxBackoff = options.maxBackoffMs ?? MAX_BACKOFF_MS

  let state: TeamTunnelState = 'stopped'
  let wanted = false
  let socket: TunnelSocket | undefined
  let attempt = 0
  let lastReason: string | undefined
  let retry: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let lastFrameAt = Date.now()
  /** 正在转的请求：id → 掐断用的控制器。 */
  const inflight = new Map<string, AbortController>()
  const waiters = new Set<() => void>()

  const emit = (type: string, detail?: string): void => {
    options.onEvent?.({ type, ...(detail === undefined ? {} : { detail }) })
  }
  const setState = (next: TeamTunnelState): void => {
    if (state === next) return
    state = next
    emit(`team.tunnel_${next}`)
    if (next === 'online') {
      for (const w of [...waiters]) w()
    }
  }

  const send = (frame: TeamTunnelClientFrame): void => {
    try {
      socket?.send(JSON.stringify(frame))
    } catch {
      // 断了：close 回调会接手重连
    }
  }

  /** 申请（或取回）一条通道。 */
  async function register(): Promise<TeamTunnelIssued | undefined> {
    const token = options.token()
    if (token === undefined) return undefined
    try {
      const res = await doFetch(`${options.cloudBase().replace(/\/+$/, '')}/v1/team/tunnel`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) {
        lastReason =
          res.status === 401
            ? '工坊账号的登录过期了，重新登录一次。'
            : res.status === 404
              ? '工坊云这边还没开团队通道。'
              : `工坊云没答应开通道（${String(res.status)}）。`
        return undefined
      }
      const body = JSON.parse(await res.text()) as { data?: Partial<TeamTunnelIssued> }
      const d = body.data
      if (
        typeof d?.tunnel_id !== 'string' ||
        typeof d.url !== 'string' ||
        typeof d.secret !== 'string'
      ) {
        lastReason = '工坊云回的通道信息不完整。'
        return undefined
      }
      const issued = { tunnel_id: d.tunnel_id, url: d.url.replace(/\/+$/, ''), secret: d.secret }
      options.vault.set(issued)
      return issued
    } catch {
      lastReason = '网络不通，这一下没连上工坊云。'
      return undefined
    }
  }

  const clearTimers = (): void => {
    if (retry !== undefined) clearTimeout(retry)
    retry = undefined
    if (heartbeat !== undefined) clearInterval(heartbeat)
    heartbeat = undefined
  }

  const scheduleRetry = (): void => {
    if (!wanted) return
    setState('backoff')
    attempt += 1
    const delay = Math.min(maxBackoff, 500 * 2 ** Math.min(attempt, 7))
    retry = setTimeout(() => {
      retry = undefined
      void connect()
    }, delay)
    retry.unref?.()
  }

  const abortAll = (): void => {
    for (const c of inflight.values()) c.abort()
    inflight.clear()
  }

  async function serve(frame: Extract<TeamTunnelServerFrame, { type: 'request' }>): Promise<void> {
    const controller = new AbortController()
    inflight.set(frame.id, controller)
    try {
      const headers = new Headers()
      for (const [name, value] of frame.headers) {
        try {
          headers.append(name, value)
        } catch {
          // 不合法的头名 / 值：丢掉这一个
        }
      }
      const hasBody = frame.body !== undefined && frame.method !== 'GET' && frame.method !== 'HEAD'
      const path = frame.path.startsWith('/') ? frame.path : `/${frame.path}`
      const req = new Request(`http://team.door${path}`, {
        method: frame.method,
        headers,
        ...(hasBody ? { body: Buffer.from(frame.body ?? '', 'base64') } : {}),
        signal: controller.signal,
      })
      const res = await options.handler(req)
      if (controller.signal.aborted) return
      const outHeaders: [string, string][] = []
      res.headers.forEach((value, name) => {
        outHeaders.push([name, value])
      })
      send({ type: 'response_head', id: frame.id, status: res.status, headers: outHeaders })
      if (res.body !== null) {
        const reader = res.body.getReader()
        for (;;) {
          if (controller.signal.aborted) {
            await reader.cancel().catch(() => undefined)
            return
          }
          const { done, value } = await reader.read()
          if (done) break
          for (let at = 0; at < value.byteLength; at += TEAM_TUNNEL_CHUNK_BYTES) {
            const piece = value.subarray(
              at,
              Math.min(value.byteLength, at + TEAM_TUNNEL_CHUNK_BYTES),
            )
            send({
              type: 'response_chunk',
              id: frame.id,
              data: Buffer.from(piece).toString('base64'),
            })
          }
        }
      }
      send({ type: 'response_end', id: frame.id })
    } catch (err) {
      if (!controller.signal.aborted)
        send({
          type: 'response_error',
          id: frame.id,
          message: err instanceof Error ? err.message.slice(0, 200) : '本机没能回这一次请求',
        })
    } finally {
      inflight.delete(frame.id)
    }
  }

  async function connect(): Promise<void> {
    if (!wanted) return
    if (options.token() === undefined) {
      setState('needs_account')
      lastReason = '这台电脑还没登录工坊账号。'
      return
    }
    let issued = options.vault.get()
    if (issued === undefined) {
      setState('registering')
      issued = await register()
      if (!wanted) return
      if (issued === undefined) {
        scheduleRetry()
        return
      }
    }
    setState('connecting')
    let s: TunnelSocket
    try {
      s = factory(tunnelConnectUrl(options.cloudBase(), issued.tunnel_id))
    } catch {
      lastReason = '连不上工坊云。'
      scheduleRetry()
      return
    }
    socket = s
    const mine = issued
    s.addEventListener('open', () => {
      lastFrameAt = Date.now()
      try {
        s.send(
          JSON.stringify({
            type: 'hello',
            protocol_version: TEAM_TUNNEL_PROTOCOL_VERSION,
            tunnel_id: mine.tunnel_id,
            secret: mine.secret,
          } satisfies TeamTunnelClientFrame),
        )
      } catch {
        // close 回调接手
      }
    })
    s.addEventListener('message', (event) => {
      if (socket !== s) return
      lastFrameAt = Date.now()
      const frame = parseServerFrame(event.data)
      if (frame === undefined) return
      switch (frame.type) {
        case 'welcome':
          attempt = 0
          lastReason = undefined
          if (frame.url !== mine.url) options.vault.set({ ...mine, url: frame.url })
          setState('online')
          return
        case 'rejected':
          lastReason =
            frame.reason === 'version_mismatch'
              ? '这一版的团队通道协议太旧了，更新一下工坊。'
              : '通道密钥对不上，重新申请一次。'
          // 密钥对不上：清掉，下一次重新申请（换一把新的）
          if (frame.reason === 'bad_secret') options.vault.set(undefined)
          s.close()
          return
        case 'request':
          void serve(frame)
          return
        case 'cancel':
          inflight.get(frame.id)?.abort()
          inflight.delete(frame.id)
          return
        case 'ping':
          send({ type: 'pong' })
          return
        case 'pong':
          return
      }
    })
    const onDown = (): void => {
      if (socket !== s) return
      socket = undefined
      abortAll()
      if (heartbeat !== undefined) clearInterval(heartbeat)
      heartbeat = undefined
      if (wanted) scheduleRetry()
      else setState('stopped')
    }
    s.addEventListener('close', onDown)
    s.addEventListener('error', () => {
      try {
        s.close()
      } catch {
        // 已经断了
      }
      onDown()
    })
    heartbeat = setInterval(() => {
      if (socket !== s) return
      if (Date.now() - lastFrameAt > heartbeatMs * 3) {
        // 三个心跳都没动静：当它断了
        try {
          s.close()
        } catch {
          // 同上
        }
        onDown()
        return
      }
      send({ type: 'ping' })
    }, heartbeatMs)
    heartbeat.unref?.()
  }

  return {
    start() {
      if (wanted && state !== 'needs_account') return
      wanted = true
      void connect()
    },
    stop() {
      wanted = false
      clearTimers()
      abortAll()
      const s = socket
      socket = undefined
      try {
        s?.close()
      } catch {
        // 已经断了
      }
      setState('stopped')
    },
    state: () => state,
    url: () => options.vault.get()?.url,
    reason: () => lastReason,
    async registerCode(code, expires_at) {
      const token = options.token()
      if (token === undefined) return false
      if (options.vault.get() === undefined && (await register()) === undefined) return false
      try {
        const res = await doFetch(`${options.cloudBase().replace(/\/+$/, '')}/v1/team/codes`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ code_hash: await teamCodeHash(code), expires_at }),
        })
        return res.ok
      } catch {
        return false
      }
    },
    whenOnline(timeoutMs = 10_000) {
      if (state === 'online') return Promise.resolve(true)
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer)
          waiters.delete(done)
          resolve(true)
        }
        const timer = setTimeout(() => {
          waiters.delete(done)
          resolve(false)
        }, timeoutMs)
        waiters.add(done)
      })
    },
  }
}
