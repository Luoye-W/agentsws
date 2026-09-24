/**
 * 自建部署的第三种形态：用户自己 Cloudflare 账号里的 Worker（WP124）。
 *
 * 与官方托管的差别只有两点：跑在**用户自己的账号**里（数据与配额都在他那侧），
 * 以及没有 DO——单租户、内存态（转发器本来就无状态；留言密文留在 isolate 内存里，
 * redeploy 会丢，README 里写清楚：要持久用 Docker 档）。配对密钥从 Worker secret
 * 读（`wrangler secret put PAIRING_TOKEN`），不落 kv、不打日志。
 *
 * 这里只做**装配**：协议、判定、限流、四道门全部来自同一份核心与 HTTP 层，
 * 与官方托管 / Docker 一字不差。
 *
 * WP137：`VISITOR_SECRET` **必填**（≥ 32 字节）。没配就整台拒绝服务（503，日志里说清楚
 * 怎么补），不再从工作区号推一把——工作区号写在商家网站的嵌入代码里，是公开的。
 * 留言要另配 `MESSAGE_KEY`（与本机设置里的「留言密钥」同一把）；没配就不收留言。
 */
import { RelayCore } from './core.js'
import { createRelayHttp } from './http.js'
import { type ClientFrame, parseClientFrame, type RelayFrame } from './protocol.js'
import { sealedKeyOf, sealWithKey } from './sealed.js'
import { MIN_RELAY_SECRET_BYTES, relaySecretReady, relayUnavailableResponse } from './secrets.js'

export interface StandaloneEnv {
  /** 工作区号（单租户部署：一个 Worker 服务一个工作区）。 */
  WORKSPACE?: string
  /** 配对密钥（`wrangler secret put PAIRING_TOKEN`；不进 wrangler.toml）。 */
  PAIRING_TOKEN?: string
  /**
   * 访客令牌的 HMAC 密钥（**必填**，≥ 32 字节；`wrangler secret put VISITOR_SECRET`）。
   * 没配 = 整台 503。
   */
  VISITOR_SECRET?: string
  /**
   * 留言封箱密钥（选填；`wrangler secret put MESSAGE_KEY`，同一把填进本机「留言密钥」）。
   * 没配 = 不收留言（访客面回人话），绝不拿常量封箱。
   */
  MESSAGE_KEY?: string
}

/** WebSocketPair 在 Workers 运行时里是全局的；类型面收窄成我们用到的那几点。 */
interface RelayWebSocket {
  send(text: string): void
  close(): void
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void
  addEventListener(type: 'close', handler: () => void): void
}

type Pair = { 0: RelayWebSocket; 1: RelayWebSocket }

export function createStandaloneWorker(): {
  fetch(request: Request, env: StandaloneEnv): Promise<Response>
} {
  const workspaceOfEnv = (env: StandaloneEnv): string | undefined =>
    env.WORKSPACE?.trim() || undefined
  const cores = new Map<string, RelayCore>()
  let warned = false

  const coreFor = (workspace: string, env: StandaloneEnv): RelayCore => {
    let core = cores.get(workspace)
    if (core === undefined) {
      core = new RelayCore({
        clock: () => new Date().toISOString(),
        verifyPairing: (_ws, token) => {
          const expected = env.PAIRING_TOKEN?.trim()
          if (expected === undefined || expected === '') return false
          return timingSafe(expected, token)
        },
        // 留言封箱：只认部署方给的 MESSAGE_KEY（与 Docker / 官方同一条派生）
        seal: (_ws, plaintext) => {
          const key = env.MESSAGE_KEY?.trim()
          if (key === undefined || key === '') throw new Error('MESSAGE_KEY 没配，不该走到封箱')
          return sealWithKey(sealedKeyOf(key), plaintext)
        },
        sealReady: () => (env.MESSAGE_KEY?.trim() ?? '') !== '',
        newId: () => crypto.randomUUID(),
      })
      cores.set(workspace, core)
    }
    return core
  }

  return {
    async fetch(request, env) {
      const url = new URL(request.url)
      const workspace = /^\/relay\/([^/]+)/.exec(url.pathname)?.[1] ?? workspaceOfEnv(env)
      if (workspace === undefined)
        return Response.json(
          { code: 'invalid_input', message: '路径里缺工作区号（/relay/<ws>/*）' },
          { status: 400 },
        )
      // WP137：没有真访客密钥就整台拒绝服务（访客面与本机连接都不接）
      const visitorSecret = env.VISITOR_SECRET?.trim()
      if (!relaySecretReady(visitorSecret)) {
        if (!warned) {
          warned = true
          console.error(
            `[relay] VISITOR_SECRET 没配或短于 ${String(MIN_RELAY_SECRET_BYTES)} 字节：转发器拒绝服务。` +
              '在 deploy/chat-relay/worker 里跑 `wrangler secret put VISITOR_SECRET`' +
              '（值用 `openssl rand -base64 32` 生成），不用重新部署。',
          )
        }
        return relayUnavailableResponse()
      }
      const core = coreFor(workspace, env)

      // 商家本机主动外连进来的长连接（单租户：一条就够）
      if (url.pathname === `/relay/${workspace}/connect`) {
        if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket')
          return Response.json(
            { code: 'bad_request', message: '这条路径是 WebSocket 专用' },
            { status: 426 },
          )
        const makePair = (globalThis as { WebSocketPair?: new () => Pair }).WebSocketPair
        if (makePair === undefined)
          return Response.json(
            { code: 'bad_request', message: 'WebSocketPair 只在 Workers 运行时里存在' },
            { status: 500 },
          )
        const pair = new makePair()
        const server = pair[1]
        const sendFrame = (frame: RelayFrame): void => {
          try {
            server.send(JSON.stringify(frame))
          } catch {
            // 已断开
          }
        }
        server.addEventListener('message', (event: { data: unknown }) => {
          const frame: ClientFrame | undefined = parseClientFrame(String(event.data))
          if (frame === undefined) {
            sendFrame({ type: 'error', code: 'bad_frame', message: '帧解析失败' })
            return
          }
          if (frame.type === 'hello') {
            if (frame.workspace !== workspace) {
              sendFrame({ type: 'hello_err', reason: 'bad_pairing', supported_versions: [1] })
              server.close()
              return
            }
            const verdict = core.handshake({ send: sendFrame, close: () => server.close() }, frame)
            if (!verdict.ok) server.close()
            return
          }
          core.onClientFrame(workspace, frame)
        })
        return new Response(null, { status: 101, webSocket: server } as unknown as ResponseInit)
      }

      // 访客面（widget.js / session / messages / stream / typing / offline-messages）
      const prefix = `/relay/${workspace}`
      const stripped = new URL(
        `${url.origin}${url.pathname.slice(prefix.length) || '/'}${url.search}`,
      )
      const app = createRelayHttp({
        core,
        workspace,
        visitorSecret: () => new TextEncoder().encode(visitorSecret),
      })
      return app.fetch(new Request(stripped, request))
    },
  }
}

/** 定长比较：不给计时旁路。 */
function timingSafe(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  if (x.length !== y.length) return false
  let diff = 0
  for (let i = 0; i < x.length; i += 1) diff |= (x[i] as number) ^ (y[i] as number)
  return diff === 0
}
