/**
 * 自建部署的第一种形态：Node 宿主（Docker 一条命令，WP124 / docs/74）。
 *
 * 单进程内存态 + 一个 JSON 文件卷（配对哈希 / 计数 / 留言密文 / 挂件外观）。
 * 协议、限流、四道门全部来自同一份 `RelayCore` 与 `createRelayHttp`，
 * 与官方托管 / 自建 Worker 一字不差；这个文件只做三件事：
 * 把 `ws` 的 WebSocket 接进来、把 KV 落到卷上的 JSON、首启配对密钥**只打印一次**
 * （之后箱里只有哈希——重发等于把密钥再泄露一遍）。
 *
 * WP137：访客密钥从**服务端秘密**派生——首启随机生成 32 字节，存进同一个卷
 * （与配对密钥哈希同处），**不打印**；老部署升级时自动补生成。以前那把从工作区号
 * 推出来的访客密钥作废（工作区号是公开的）。留言密钥没签发就不收留言。
 */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http'
import { dirname, join } from 'node:path'
import { WebSocketServer } from 'ws'
import { RelayCore } from './core.js'
import { createRelayHttp } from './http.js'
import { ensurePairingToken, type PairingStore } from './node.js'
import { type OfflineBox, sweepExpired } from './offline-box.js'
import {
  type ClientFrame,
  parseClientFrame,
  type RelayFrame,
  type RelayWidgetConfig,
} from './protocol.js'
import type { CounterStore } from './quota.js'
import { sealedKeyOf, sealWithKey } from './sealed.js'
import { KvCounterStore, KvOfflineBox, KvPairingStore, MemoryKv, type RelayKv } from './stores.js'

/** JSON 文件 KV：进程启动时装进来，每次写都整份落盘（数据量小：哈希、计数、留言密文）。 */
export class FileKv implements RelayKv {
  private readonly map = new Map<string, string>()

  constructor(readonly path: string) {
    if (exists(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
        for (const [k, v] of Object.entries(parsed)) this.map.set(k, v)
      } catch {
        // 文件坏了从空开始：丢的是计数与没拉走的留言，不是对话
      }
    }
  }

  get(key: string): string | undefined {
    return this.map.get(key)
  }

  put(key: string, value: string): void {
    this.map.set(key, value)
    this.flush()
  }

  delete(key: string): void {
    if (this.map.delete(key)) this.flush()
  }

  list(prefix: string): { key: string; value: string }[] {
    return [...this.map]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, value]) => ({ key, value }))
  }

  private flush(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    // 0600：卷里有服务端秘密与配对哈希，只给跑转发器的那个用户读
    //（mode 只在新建时生效；老卷升级上来的文件再收一次权限）
    writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.map), null, 2), {
      encoding: 'utf8',
      mode: 0o600,
    })
    try {
      chmodSync(this.path, 0o600)
    } catch {
      // 某些挂载（如 Windows 卷）不支持 chmod：不影响功能
    }
  }
}

function exists(path: string): boolean {
  try {
    readFileSync(path)
    return true
  } catch {
    return false
  }
}

export interface NodeHostOptions {
  /** 监听端口（compose 里默认 8787）。 */
  port?: number
  /** 工作区号（单租户部署：一个宿主服务一个工作区）。 */
  workspace: string
  /** 数据目录（挂卷；不给 = 全内存，重启丢计数与留言）。 */
  dataDir?: string
  /** 留言封箱密钥；不给就在首启生成并随配对密钥一起打印。 */
  messageKey?: string
  /** 心跳之外多久扫一次超期留言（毫秒）。 */
  sweepIntervalMs?: number
}

export interface NodeHostHandle {
  /** 首启生成、只打印一次的配对密钥；已经配对过（卷里有哈希）就是 undefined。 */
  pairingToken?: string
  /** 随配对密钥一起打印一次的留言密钥（本机开箱要用）。 */
  messageKey?: string
  /** 实际监听的端口（port: 0 时由内核分配）。 */
  port(): number | undefined
  close(): Promise<void>
}

export function startNodeRelayHost(options: NodeHostOptions): NodeHostHandle {
  const workspace = options.workspace
  const kv: RelayKv =
    options.dataDir === undefined
      ? new MemoryKv()
      : new FileKv(join(options.dataDir, 'relay-kv.json'))
  const pairing: PairingStore = new KvPairingStore(kv)
  const counters: CounterStore = new KvCounterStore(kv)
  const offline: OfflineBox = new KvOfflineBox(kv)
  const now = (): string => new Date().toISOString()

  // WP137：服务端秘密（访客密钥从它派生）。首启 / 老部署升级时生成，存卷，不打印。
  const serverSecret = ensureServerSecret(kv)

  // 配对密钥：只打印一次
  const pairingToken = ensurePairingToken(pairing, workspace, (n) => randomBytes(n))
  let messageKey = options.messageKey
  if (messageKey === undefined && kv.get('msgkey') === undefined && pairingToken !== undefined) {
    messageKey = `mkk_${randomBytes(18).toString('base64url')}`
    kv.put('msgkey', messageKey)
  } else if (messageKey === undefined) {
    messageKey = kv.get('msgkey')
  }
  if (pairingToken !== undefined) {
    // 打到 stdout 一次；Docker 的日志就是交付渠道。之后箱里只有哈希。
    process.stdout.write(
      [
        '',
        '════════════════════════════════════════════════════════',
        '  这是你的配对密钥与留言密钥，只显示这一次：',
        `  配对密钥：${pairingToken}`,
        `  留言密钥：${messageKey ?? ''}`,
        '  把它们填进 Agents 工坊 → 聊天窗 → 转发方式。',
        '════════════════════════════════════════════════════════',
        '',
      ].join('\n'),
    )
  }

  const core = new RelayCore({
    clock: now,
    verifyPairing: (ws, token) => {
      const hash = pairing.hash(ws)
      return hash !== undefined && createHash('sha256').update(token).digest('hex') === hash
    },
    counters,
    offline,
    // 挂件外观落卷（重启后挂件照常能画出来）
    configStore: {
      get: (ws) => {
        const raw = kv.get(`widgetcfg:${ws}`)
        return raw === undefined ? undefined : (JSON.parse(raw) as RelayWidgetConfig)
      },
      put: (ws, config) => {
        kv.put(`widgetcfg:${ws}`, JSON.stringify(config))
      },
    },
    // 留言封箱：AES-256-GCM，密钥是配对时签发的那把留言密钥。
    // WP137：没签发（老卷里只有配对哈希、没有留言密钥）就不收留言，绝不拿常量封箱
    seal: (_ws, plaintext) => {
      if (messageKey === undefined) throw new Error('留言密钥没签发，不该走到封箱')
      return sealWithKey(sealedKeyOf(messageKey), plaintext)
    },
    sealReady: () => messageKey !== undefined,
    newId: () => randomBytes(9).toString('base64url'),
    onEvent: (event) => {
      // 只打计数与状态，不打正文（转发器看得到过路内容但不落盘，日志同理）
      process.stdout.write(`[relay] ${event.type} workspace=${event.workspace}\n`)
    },
  })
  void counters
  void offline

  const httpByWorkspace = new Map<string, ReturnType<typeof createRelayHttp>>()
  const httpFor = (ws: string): ReturnType<typeof createRelayHttp> => {
    let app = httpByWorkspace.get(ws)
    if (app === undefined) {
      app = createRelayHttp({
        core,
        workspace: ws,
        visitorSecret: () => visitorSecretOf(serverSecret, ws),
      })
      httpByWorkspace.set(ws, app)
    }
    return app
  }

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${options.port ?? 8787}`)
      const workspaceFromPath = /^\/relay\/([^/]+)/.exec(url.pathname)?.[1] ?? workspace
      if (url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
        return
      }
      const prefix = `/relay/${workspaceFromPath}`
      const stripped = new URL(
        `${url.origin}${url.pathname.slice(prefix.length) || '/'}${url.search}`,
      )
      const body = await readBody(req)
      const headers = new Headers()
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue
        headers.set(name, Array.isArray(value) ? value.join(',') : String(value))
      }
      const request = new Request(stripped, {
        method: req.method ?? 'GET',
        headers,
        ...(body === undefined ? {} : { body }),
      })
      const response = await httpFor(workspaceFromPath).fetch(request)
      const hdrs: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        hdrs[name] = value
      })
      res.writeHead(response.status, hdrs)
      if (response.body !== null) {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
      }
      res.end()
    })().catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'internal', message: String(err) } }))
    })
  })

  // WebSocket 升级：/relay/<ws>/connect
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (req: IncomingMessage, socket: import('node:net').Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://localhost:${options.port ?? 8787}`)
    const ws = /^\/relay\/([^/]+)\/connect$/.exec(url.pathname)?.[1]
    if (ws === undefined) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (client) => {
      const sendFrame = (frame: RelayFrame): void => {
        try {
          client.send(JSON.stringify(frame))
        } catch {
          // 已断开
        }
      }
      client.on('message', (data) => {
        const frame: ClientFrame | undefined = parseClientFrame(String(data))
        if (frame === undefined) {
          sendFrame({ type: 'error', code: 'bad_frame', message: '帧解析失败' })
          return
        }
        if (frame.type === 'hello') {
          if (frame.workspace !== ws) {
            sendFrame({ type: 'hello_err', reason: 'bad_pairing', supported_versions: [1] })
            client.close()
            return
          }
          const verdict = core.handshake({ send: sendFrame, close: () => client.close() }, frame)
          if (!verdict.ok) client.close()
          return
        }
        core.onClientFrame(ws, frame)
      })
      client.on('close', () => core.dropClient(ws))
    })
  })

  const port = options.port ?? 8787
  server.listen(port)

  // 定期扫超期留言（7 天）
  const sweepTimer: ReturnType<typeof setInterval> = setInterval(
    () => {
      sweepExpired({ box: offline, workspace, now: now() })
    },
    options.sweepIntervalMs ?? 60 * 60 * 1000,
  )
  sweepTimer.unref?.()

  return {
    ...(pairingToken === undefined ? {} : { pairingToken }),
    ...(messageKey === undefined ? {} : { messageKey }),
    port: () => {
      const addr = server.address()
      return typeof addr === 'object' && addr !== null ? addr.port : undefined
    },
    close: async () => {
      clearInterval(sweepTimer)
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === undefined || req.method === 'GET' || req.method === 'HEAD') {
    return Promise.resolve(undefined)
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(undefined))
  })
}

/** 卷里存服务端秘密的那一格（与配对哈希同一个文件）。 */
export const SERVER_SECRET_KEY = 'server-secret'

/**
 * 取服务端秘密；没有就随机生成 32 字节存进去（首启 / 老部署升级）。
 * **不打印、不回给调用方之外的任何地方**——它只用来派生访客密钥。
 */
export function ensureServerSecret(
  kv: RelayKv,
  random: (bytes: number) => Buffer = (n) => randomBytes(n),
): Buffer {
  const stored = kv.get(SERVER_SECRET_KEY)
  if (stored !== undefined) {
    const bytes = Buffer.from(stored, 'base64url')
    if (bytes.length >= 32) return bytes
  }
  const fresh = random(32)
  kv.put(SERVER_SECRET_KEY, fresh.toString('base64url'))
  return fresh
}

/** 访客密钥 = HMAC(服务端秘密, 工作区)：每个工作区一把，外人没有服务端秘密就推不出来。 */
export function visitorSecretOf(serverSecret: Buffer, workspace: string): Uint8Array {
  return createHmac('sha256', serverSecret).update(`chat-relay:visitor:${workspace}`).digest()
}
