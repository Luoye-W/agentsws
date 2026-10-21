/**
 * WP427：团队通道的**云端替身**（Node 版，一个字节都不出本机）。
 *
 * 真的那一份在私有云里（Durable Object，一条通道一个；见 `packages/contracts/src/team-link.ts`
 * 的契约与 `docs/briefs/WP427-report.md` 里「要云端做的」）。这一份照同一份契约做，用在三处：
 *
 * - 端到端测试：两个服务进程（模拟两台不在同一个网络的电脑）都只认识这个替身；
 * - 开发期在一台电脑上手动走一遍（`node apps/server/dist/team-relay-cli.js --port 4593`）；
 * - 私有云那边照着它写（帧怎么转、头怎么去、多大回 413、不在线回什么）。
 *
 * 地址按 Host 分流：`http://<通道 id>-team.localhost:<端口>/…` 整条转给那条通道（浏览器与 Node 都把
 * `*.localhost` 解析到本机；与真云的 `<通道 id>-team.agentsws.com` 同一个形状，WP435）。控制面那几条（申请通道、长连接、登记 / 查邀请码）走不带子域的 Host。
 * 令牌一律认（替身不验账号；真云按工作区令牌认组织）。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import {
  TEAM_TUNNEL_MAX_BODY_BYTES,
  TEAM_TUNNEL_PROTOCOL_VERSION,
  type TeamTunnelClientFrame,
  type TeamTunnelServerFrame,
} from '@agentsws/contracts'
import { type WebSocket, WebSocketServer } from 'ws'

/** 替身那一边的通道。 */
interface Tunnel {
  id: string
  secret: string
  /** 哪把令牌申请的（替身里「组织」= 令牌）。 */
  owner: string
  socket?: WebSocket | undefined
}

interface Pending {
  res: ServerResponse
  headed: boolean
}

export interface TeamRelayStandIn {
  /** 控制面地址（`http://127.0.0.1:<端口>`）——服务进程的 `AGENTSWS_TEAM_CLOUD_URL` 填它。 */
  base: string
  port: number
  /** 现在连着的通道数（测试看）。 */
  online(): number
  /** 测试用：把某条通道的长连接掐断（模拟发起人电脑掉线）。 */
  drop(tunnel_id: string): void
  close(): Promise<void>
}

const HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'te',
  'trailer',
  'host',
  'content-length',
])

const readBody = (req: IncomingMessage, limit: number): Promise<Buffer | 'too_large'> =>
  new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > limit) {
        over = true
        resolve('too_large')
        return
      }
      parts.push(chunk)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(parts))
    })
    req.on('error', reject)
  })

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export async function startTeamRelayStandIn(
  options: { port?: number; hosts?: string[] } = {},
): Promise<TeamRelayStandIn> {
  const tunnels = new Map<string, Tunnel>()
  const byOwner = new Map<string, string>()
  const codes = new Map<string, { tunnel_id: string; expires_at: string }>()
  const pending = new Map<string, Pending>()
  let port = options.port ?? 0
  let seq = 0

  const urlOf = (id: string): string => `http://${id}-team.localhost:${String(port)}`

  const bearer = (req: IncomingMessage): string | undefined => {
    const raw = req.headers.authorization
    if (raw === undefined || !raw.startsWith('Bearer ')) return undefined
    const t = raw.slice('Bearer '.length).trim()
    return t === '' ? undefined : t
  }

  async function control(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
    if (req.method === 'POST' && path === '/v1/team/tunnel') {
      const token = bearer(req)
      if (token === undefined)
        return sendJson(res, 401, { code: 'unauthenticated', message: '没令牌' })
      let id = byOwner.get(token)
      if (id === undefined) {
        id = `t${randomBytes(6).toString('hex')}`
        byOwner.set(token, id)
      }
      const secret = `tts_${randomBytes(18).toString('base64url')}`
      const before = tunnels.get(id)
      tunnels.set(id, {
        id,
        secret,
        owner: token,
        ...(before?.socket ? { socket: before.socket } : {}),
      })
      return sendJson(res, 200, { data: { tunnel_id: id, url: urlOf(id), secret } })
    }
    if (req.method === 'POST' && path === '/v1/team/codes') {
      const token = bearer(req)
      if (token === undefined)
        return sendJson(res, 401, { code: 'unauthenticated', message: '没令牌' })
      const id = byOwner.get(token)
      if (id === undefined) return sendJson(res, 409, { code: 'no_tunnel', message: '先申请通道' })
      const body = await readBody(req, 4096)
      if (body === 'too_large')
        return sendJson(res, 400, { code: 'invalid_input', message: '太大' })
      const input = JSON.parse(body.toString('utf8') || '{}') as {
        code_hash?: unknown
        expires_at?: unknown
      }
      if (typeof input.code_hash !== 'string' || typeof input.expires_at !== 'string')
        return sendJson(res, 400, { code: 'invalid_input', message: '缺 code_hash / expires_at' })
      codes.set(input.code_hash, { tunnel_id: id, expires_at: input.expires_at })
      return sendJson(res, 200, {
        data: { code_hash: input.code_hash, expires_at: input.expires_at },
      })
    }
    if (req.method === 'POST' && path === '/v1/team/codes/resolve') {
      const body = await readBody(req, 4096)
      if (body === 'too_large')
        return sendJson(res, 400, { code: 'invalid_input', message: '太大' })
      const input = JSON.parse(body.toString('utf8') || '{}') as { code?: unknown }
      if (typeof input.code !== 'string' || input.code.trim() === '')
        return sendJson(res, 400, { code: 'invalid_input', message: '缺 code' })
      const { createHash } = await import('node:crypto')
      const hash = createHash('sha256').update(input.code.trim().toUpperCase()).digest('hex')
      const row = codes.get(hash)
      if (row === undefined || Date.parse(row.expires_at) <= Date.now())
        return sendJson(res, 404, { code: 'not_found', message: '没有这个码' })
      return sendJson(res, 200, { data: { url: urlOf(row.tunnel_id) } })
    }
    return sendJson(res, 404, { code: 'not_found', message: '替身里没有这一条' })
  }

  /** 按 Host 分流来的同事请求：打成帧送给那条通道。 */
  async function forward(
    req: IncomingMessage,
    res: ServerResponse,
    tunnel: Tunnel | undefined,
  ): Promise<void> {
    const socket = tunnel?.socket
    if (tunnel === undefined || socket === undefined) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<p>对方的电脑现在不在线（工坊没开，或者睡着了）。等他打开工坊再试。</p>')
      return
    }
    if ((req.headers.upgrade ?? '').toLowerCase() === 'websocket') {
      res.writeHead(501).end()
      return
    }
    const body =
      req.method === 'GET' || req.method === 'HEAD'
        ? Buffer.alloc(0)
        : await readBody(req, TEAM_TUNNEL_MAX_BODY_BYTES)
    if (body === 'too_large') {
      sendJson(res, 413, { code: 'too_large', message: '这一次传的东西太大了，超过 8 MB。' })
      return
    }
    seq += 1
    const id = `r${String(seq)}`
    const headers: [string, string][] = []
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i] ?? ''
      if (HOP.has(name.toLowerCase())) continue
      headers.push([name, req.rawHeaders[i + 1] ?? ''])
    }
    pending.set(id, { res, headed: false })
    res.on('close', () => {
      if (pending.delete(id))
        socket.send(JSON.stringify({ type: 'cancel', id } satisfies TeamTunnelServerFrame))
    })
    const frame: TeamTunnelServerFrame = {
      type: 'request',
      id,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      headers,
      ...(body.length > 0 ? { body: body.toString('base64') } : {}),
    }
    socket.send(JSON.stringify(frame))
  }

  function onFrame(tunnel: Tunnel, frame: TeamTunnelClientFrame): void {
    switch (frame.type) {
      case 'ping':
        tunnel.socket?.send(JSON.stringify({ type: 'pong' } satisfies TeamTunnelServerFrame))
        return
      case 'pong':
      case 'hello':
        return
      case 'response_head': {
        const p = pending.get(frame.id)
        if (p === undefined || p.headed) return
        p.headed = true
        const out: [string, string][] = frame.headers.filter(([n]) => !HOP.has(n.toLowerCase()))
        p.res.writeHead(frame.status, out.flat())
        return
      }
      case 'response_chunk': {
        const p = pending.get(frame.id)
        if (p === undefined || !p.headed) return
        p.res.write(Buffer.from(frame.data, 'base64'))
        return
      }
      case 'response_end': {
        const p = pending.get(frame.id)
        if (p === undefined) return
        pending.delete(frame.id)
        p.res.end()
        return
      }
      case 'response_error': {
        const p = pending.get(frame.id)
        if (p === undefined) return
        pending.delete(frame.id)
        if (!p.headed) sendJson(p.res, 502, { code: 'unavailable', message: frame.message })
        else p.res.end()
        return
      }
    }
  }

  const tunnelOfHost = (host: string | undefined): Tunnel | undefined | 'control' => {
    const name = (host ?? '').split(':')[0]?.toLowerCase() ?? ''
    if (!name.endsWith('-team.localhost')) return 'control'
    return tunnels.get(name.slice(0, -'-team.localhost'.length))
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const target = tunnelOfHost(req.headers.host)
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    const run = target === 'control' ? control(req, res, path) : forward(req, res, target)
    run.catch(() => {
      if (!res.headersSent) sendJson(res, 500, { code: 'internal', message: '替身出错了' })
      else res.end()
    })
  }

  const wss = new WebSocketServer({ noServer: true })
  wss.on('connection', (ws: WebSocket) => {
    let tunnel: Tunnel | undefined
    ws.on('message', (raw) => {
      let frame: TeamTunnelClientFrame
      try {
        frame = JSON.parse(String(raw)) as TeamTunnelClientFrame
      } catch {
        return
      }
      if (tunnel === undefined) {
        if (frame.type !== 'hello') return ws.close()
        if (frame.protocol_version !== TEAM_TUNNEL_PROTOCOL_VERSION) {
          ws.send(
            JSON.stringify({
              type: 'rejected',
              reason: 'version_mismatch',
              supported: [TEAM_TUNNEL_PROTOCOL_VERSION],
            } satisfies TeamTunnelServerFrame),
          )
          return ws.close()
        }
        const t = tunnels.get(frame.tunnel_id)
        if (t === undefined || t.secret !== frame.secret) {
          ws.send(
            JSON.stringify({
              type: 'rejected',
              reason: 'bad_secret',
            } satisfies TeamTunnelServerFrame),
          )
          return ws.close()
        }
        // 同一条通道新连上来的那一条赢
        if (t.socket !== undefined && t.socket !== ws) t.socket.close()
        t.socket = ws
        tunnel = t
        ws.send(
          JSON.stringify({
            type: 'welcome',
            protocol_version: TEAM_TUNNEL_PROTOCOL_VERSION,
            url: urlOf(t.id),
          } satisfies TeamTunnelServerFrame),
        )
        return
      }
      onFrame(tunnel, frame)
    })
    ws.on('close', () => {
      if (tunnel !== undefined && tunnel.socket === ws) {
        tunnel.socket = undefined
        // 还在等回的那几条：回 502
        for (const [id, p] of pending) {
          pending.delete(id)
          if (!p.headed) sendJson(p.res, 502, { code: 'unavailable', message: '对方的电脑断开了' })
          else p.res.end()
        }
      }
    })
  })

  const servers: Server[] = []
  const hosts = options.hosts ?? ['127.0.0.1', '::1']
  for (const host of hosts) {
    const server = createServer(handler)
    server.on('upgrade', (req, socket, head) => {
      const path = (req.url ?? '/').split('?')[0]
      if (tunnelOfHost(req.headers.host) !== 'control' || path !== '/v1/team/tunnel/connect') {
        socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n')
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
      })
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve()
        })
      })
    } catch (err) {
      // 这台机器没有 IPv6 回环：只听 IPv4 那一个也行（第一个必须起来）
      if (servers.length === 0) throw err
      continue
    }
    const address = server.address()
    if (port === 0 && typeof address === 'object' && address !== null) port = address.port
    servers.push(server)
  }

  return {
    base: `http://127.0.0.1:${String(port)}`,
    port,
    online: () => [...tunnels.values()].filter((t) => t.socket !== undefined).length,
    drop(tunnel_id) {
      tunnels.get(tunnel_id)?.socket?.terminate()
    },
    async close() {
      for (const t of tunnels.values()) t.socket?.terminate()
      wss.close()
      for (const p of pending.values()) p.res.destroy()
      await Promise.all(
        servers.map(
          (s) =>
            new Promise<void>((resolve) => {
              s.closeAllConnections?.()
              s.close(() => resolve())
            }),
        ),
      )
    },
  }
}
