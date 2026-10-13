/**
 * 飞书 / 钉钉 / 企业微信三条团队渠道的**真**连接（WP211）。
 *
 * `@agentsws/channels` 里的三个适配器都不碰网络库：长连接与 HTTP 都是注入的。
 * 这个文件就是注入的那一头——只在服务进程里、只在用户真配了那条渠道时才走到：
 *
 * - **飞书**：官方 SDK `@larksuiteoapi/node-sdk`（MIT）的 `WSClient`（长连接收事件）+
 *   `Client`（回复、查机器人自己的 open_id）。**懒加载**：没配飞书的机器上一次都不 `import`
 *   （这个包解开有 30 MB，类型声明 17 MB——静态 import 会把全仓的 tsc 拖慢，所以这里
 *   也不引它的类型，只按下面那几行最小形状用）。
 * - **钉钉 / 企业微信**：服务进程已有的 `ws` 包 + 全局 `fetch`。
 *
 * SDK 的日志一律丢掉（它在 debug 级会打事件原文）：失败原因经 `onError` 回到适配器，
 * 由适配器翻成人话；原始串只进诊断事件，不进 console。
 */

import {
  type DingtalkHttp,
  type DingtalkSocket,
  type DingtalkSocketFactory,
  FEISHU_MESSAGE_EVENT,
  type FeishuConnState,
  type FeishuDomain,
  type FeishuMessageEvent,
  type FeishuTransport,
  type FeishuTransportFactory,
  feishuReplyBody,
  type WecomSocket,
  type WecomSocketFactory,
} from '@agentsws/channels'
import { WebSocket } from 'ws'

/** 官方飞书 SDK 里我们用得上的那几样（按 1.74.0 的公开 API 抄的最小形状）。 */
interface LarkLogger {
  error(...msg: unknown[]): void
  warn(...msg: unknown[]): void
  info(...msg: unknown[]): void
  debug(...msg: unknown[]): void
  trace(...msg: unknown[]): void
}

interface LarkModule {
  Domain: { Feishu: unknown; Lark: unknown }
  LoggerLevel: { error: unknown }
  Client: new (
    p: Record<string, unknown>,
  ) => {
    im: {
      v1: {
        message: {
          reply(p: {
            path: { message_id: string }
            data: { msg_type: string; content: string }
          }): Promise<{ code?: number; msg?: string }>
        }
      }
    }
    request(p: { method: string; url: string }): Promise<unknown>
  }
  WSClient: new (
    p: Record<string, unknown>,
  ) => {
    start(p: { eventDispatcher: unknown }): Promise<void>
    close(p?: { force?: boolean }): void
    /** 1.74 起有（WP306 用它对账）；老版本没有就不对账。 */
    getConnectionStatus?(): { state?: string }
  }
  EventDispatcher: new (
    p: Record<string, unknown>,
  ) => { register(handles: Record<string, (data: unknown) => unknown>): unknown }
}

/** 包名放在变量里：TypeScript 就不会去解析那份 17 MB 的类型声明。 */
const LARK_SDK = '@larksuiteoapi/node-sdk'

let larkModule: Promise<LarkModule> | undefined

/** 懒加载官方 SDK（CJS 包：命名导出可能挂在 `default` 上，两种都认）。 */
export function loadLarkSdk(): Promise<LarkModule> {
  larkModule ??= import(LARK_SDK).then((m: unknown) => {
    const mod = m as LarkModule & { default?: LarkModule }
    return typeof mod.WSClient === 'function' ? mod : (mod.default as LarkModule)
  })
  return larkModule
}

const QUIET: LarkLogger = {
  error() {},
  warn() {},
  info() {},
  debug() {},
  trace() {},
}

/**
 * WP306：长连接**判死**的三个数。
 *
 * 官方 SDK 每隔 `PingInterval`（飞书服务端下发，常见 120 秒）发一次 ping，但**默认不判 pong 没回**
 * （`wsConfig.pingTimeout` 不给 = 不判，SDK 1.74 源码原文）：走代理（Clash 的 fake-ip 之类）时上游断了、
 * 本地那一头不 close，SDK 就一直以为连着——不重连、不报、卡上一直绿勾，之后的消息全丢。
 *
 * - `FEISHU_PING_TIMEOUT_S`：ping 之后这么多秒没收到任何一帧 → 判死、断掉重连（最坏 ≈ PingInterval + 30 秒发现）；
 * - `FEISHU_HANDSHAKE_TIMEOUT_MS`：握手卡住（DNS / 代理 / NAT）这么久就放弃这一次、按重连节奏再试；
 * - `FEISHU_STATUS_POLL_MS`：每隔这么久问一次 SDK 的连接状态，与我们报给卡片的对账（回调漏了也不会一直绿）。
 */
export const FEISHU_PING_TIMEOUT_S = 30
export const FEISHU_HANDSHAKE_TIMEOUT_MS = 15_000
export const FEISHU_STATUS_POLL_MS = 15_000

/** SDK 的状态名 → 我们的。`idle`（没在连也没在重连）在已经起过的连接上只可能是断了。 */
function stateOfSdk(s: string | undefined): FeishuConnState | undefined {
  if (s === 'connected' || s === 'connecting' || s === 'reconnecting' || s === 'failed') return s
  if (s === 'idle') return 'reconnecting'
  return undefined
}

/** 一个飞书应用一条长连接（官方 SDK 自带重连，重连参数由飞书服务端下发）。 */
export function createFeishuSdkTransport(
  load: () => Promise<LarkModule> = loadLarkSdk,
  /** 测试调快用；生产不传。 */
  pace: { status_poll_ms?: number; ping_timeout_s?: number; extra?: Record<string, unknown> } = {},
): FeishuTransport {
  let ws: InstanceType<LarkModule['WSClient']> | undefined
  let client: InstanceType<LarkModule['Client']> | undefined
  let poll: ReturnType<typeof setInterval> | undefined

  return {
    async start(input) {
      const lark = await load()
      const domain = input.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
      const common = {
        appId: input.app_id,
        appSecret: input.app_secret,
        domain,
        logger: QUIET,
        loggerLevel: lark.LoggerLevel.error,
      }
      client = new lark.Client(common)
      let reported: FeishuConnState | undefined
      const state = (s: FeishuConnState, detail?: string): void => {
        reported = s
        input.onState(s, detail)
      }
      ws = new lark.WSClient({
        ...common,
        autoReconnect: true,
        // WP306：判死与握手超时（见上面三个常量的说明）
        handshakeTimeoutMs: FEISHU_HANDSHAKE_TIMEOUT_MS,
        wsConfig: { pingTimeout: pace.ping_timeout_s ?? FEISHU_PING_TIMEOUT_S },
        ...(pace.extra ?? {}),
        onReady: () => state('connected'),
        onReconnecting: () => state('reconnecting'),
        onReconnected: () => state('connected'),
        onError: (err: Error) => state('failed', err.message),
      })
      const dispatcher = new lark.EventDispatcher({
        logger: QUIET,
        loggerLevel: lark.LoggerLevel.error,
      })
      dispatcher.register({
        [FEISHU_MESSAGE_EVENT]: (data: unknown) => {
          // 立刻返回：SDK 等这个函数返回才回执，飞书 3 秒内收不到回执会重推
          input.onEvent(data as FeishuMessageEvent)
        },
      })
      state('connecting')
      await ws.start({ eventDispatcher: dispatcher })
      // WP306：对账。SDK 的回调只在「进 / 出重连循环」时触发；首连没成就掉进重连、
      // 或者回调被吞了，卡片上的状态就会和真的不一样——每隔一会儿问一次 SDK 自己。
      const live = ws
      if (poll !== undefined) clearInterval(poll)
      poll = setInterval(() => {
        const now = stateOfSdk(live.getConnectionStatus?.().state)
        if (now !== undefined && now !== reported && reported !== 'failed') state(now)
      }, pace.status_poll_ms ?? FEISHU_STATUS_POLL_MS)
      poll.unref?.()
    },

    async stop() {
      if (poll !== undefined) clearInterval(poll)
      poll = undefined
      ws?.close({ force: true })
      ws = undefined
      client = undefined
    },

    async reply({ message_id, text }) {
      if (client === undefined) throw new Error('飞书客户端没起来')
      const out = await client.im.v1.message.reply({
        path: { message_id },
        data: feishuReplyBody(text),
      })
      if ((out.code ?? 0) !== 0) throw new Error(`飞书回复失败：code=${String(out.code)}`)
    },

    async botOpenId() {
      if (client === undefined) return undefined
      const res = (await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as {
        bot?: { open_id?: string }
        data?: { bot?: { open_id?: string } }
      }
      return res.bot?.open_id ?? res.data?.bot?.open_id
    },
  }
}

export const feishuSdkTransportFactory: FeishuTransportFactory = () => createFeishuSdkTransport()

/**
 * `ws` 的 WebSocket 结构上就是 `DingtalkSocket` / `WecomSocket`（含 WP308 用到的 `ping` / `terminate` / `pong`）。
 * WP308：握手 15 秒不成就放弃这一次（与飞书同一个数；适配器自己也有一道握手超时）。
 */
export const WS_HANDSHAKE_TIMEOUT_MS = 15_000

export const wsSocketFactory: DingtalkSocketFactory & WecomSocketFactory = (url: string) =>
  new WebSocket(url, {
    handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
  }) as unknown as DingtalkSocket & WecomSocket

export const fetchHttp: DingtalkHttp = (url, init) => fetch(url, init)

export type { FeishuDomain }
