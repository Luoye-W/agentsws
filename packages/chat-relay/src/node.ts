/**
 * Node 薄适配（自建 Docker 部署的那一份）：把转发器核心接上
 * `ws` 的 WebSocket 服务端与 `node:crypto`。
 *
 * 单进程内存态——转发器本来就无状态（只有计数与留言密文），重启丢的只是
 * 「本分钟限流桶」与还没拉走的留言；留言箱可以挂一个落盘实现（compose 里
 * 挂一个卷即成，见 deploy/chat-relay）。协议与判定逻辑一行不重复。
 */
import { createHash, randomBytes } from 'node:crypto'
import { RelayCore, type RelayCoreOptions } from './core.js'
import type { OfflineBox } from './offline-box.js'
import { type ClientFrame, parseClientFrame, type RelayFrame } from './protocol.js'
import type { CounterStore } from './quota.js'

/** 配对密钥的存储口：明文只在生成那一刻存在，之后只有哈希。 */
export interface PairingStore {
  /** 工作区的配对密钥哈希（sha256）；没有 = 还没配对。 */
  hash(workspace: string): string | undefined
  putHash(workspace: string, hash: string): void
}

/** 内存档：测试用。生产用 deploy 包里的 JSON 文件（卷挂载）。 */
export class MemoryPairingStore implements PairingStore {
  private readonly hashes = new Map<string, string>()
  hash(workspace: string): string | undefined {
    return this.hashes.get(workspace)
  }
  putHash(workspace: string, hash: string): void {
    this.hashes.set(workspace, hash)
  }
}

export const pairingHash = (token: string): string =>
  createHash('sha256').update(token).digest('hex')

/**
 * 首次启动生成配对密钥：**只打印一次**，之后箱子里只剩哈希。
 * 返回 `undefined` = 已经配对过（绝不重发——重发等于把密钥再泄露一遍）。
 */
export function ensurePairingToken(
  store: PairingStore,
  workspace: string,
  random: (bytes: number) => Buffer = (n) => randomBytes(n),
): string | undefined {
  if (store.hash(workspace) !== undefined) return undefined
  const token = `prk_${random(24).toString('base64url')}`
  store.putHash(workspace, pairingHash(token))
  return token
}

/** WS 服务端那一侧要的最小接口（`ws` 的 WebSocket 与 workerd 的 WebSocket 都长这样）。 */
export interface RelaySocket {
  send(text: string): void
  close(code?: number): void
  /** 宿主在 message 事件里把它递回来。 */
  onMessage(handler: (text: string) => void): void
  onClose(handler: () => void): void
}

export interface NodeRelayOptions
  extends Omit<RelayCoreOptions, 'newId' | 'verifyPairing' | 'counters' | 'offline'> {
  pairing: PairingStore
  /** 留言箱落盘实现；不给用内存档（重启丢未拉走的留言）。 */
  offlineBox?: OfflineBox
  counters?: CounterStore
  /** 自定义配对校验；缺省用 pairing 库里的 sha256 哈希比对。 */
  verifyPairing?: RelayCoreOptions['verifyPairing']
}

export function createNodeRelay(options: NodeRelayOptions): {
  core: RelayCore
  /** 宿主在 connection 事件里调用：把一条 WS 接进转发器。 */
  acceptSocket(socket: RelaySocket): void
} {
  const core = new RelayCore({
    clock: options.clock,
    ...(options.conversationLimit === undefined
      ? {}
      : { conversationLimit: options.conversationLimit }),
    ...(options.isSubscribed === undefined ? {} : { isSubscribed: options.isSubscribed }),
    ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    ...(options.seal === undefined ? {} : { seal: options.seal }),
    ...(options.offlineBox === undefined ? {} : { offline: options.offlineBox }),
    ...(options.counters === undefined ? {} : { counters: options.counters }),
    verifyPairing:
      options.verifyPairing ??
      ((workspace: string, token: string): boolean => {
        const hash = options.pairing.hash(workspace)
        return hash !== undefined && pairingHash(token) === hash
      }),
    newId: () => randomBytes(9).toString('base64url'),
  })
  /** 已通过握手的 socket → 工作区。 */
  const bound = new Map<RelaySocket, string>()

  const acceptSocket = (socket: RelaySocket): void => {
    socket.onMessage((text) => {
      // 帧解析在协议层：带自由文本的打字帧、形状不对的帧都在那里被拒
      const frame: ClientFrame | undefined = parseClientFrame(text)
      if (frame === undefined) {
        socket.send(JSON.stringify({ type: 'error', code: 'bad_frame', message: '帧解析失败' }))
        return
      }
      if (frame.type === 'hello') {
        const verdict = core.handshake(
          { send: (f: RelayFrame) => socket.send(JSON.stringify(f)), close: () => socket.close() },
          frame,
        )
        if (verdict.ok) {
          bound.set(socket, frame.workspace)
          const prior = boundByWorkspace.get(frame.workspace)
          if (prior !== undefined && prior !== socket) prior.close()
          boundByWorkspace.set(frame.workspace, socket)
        } else {
          socket.close()
        }
        return
      }
      const workspace = bound.get(socket)
      if (workspace === undefined) {
        socket.send(
          JSON.stringify({ type: 'error', code: 'not_handshaken', message: '先握手再说话' }),
        )
        return
      }
      core.onClientFrame(workspace, frame)
    })
    socket.onClose(() => {
      const workspace = bound.get(socket)
      bound.delete(socket)
      if (workspace !== undefined && boundByWorkspace.get(workspace) === socket) {
        boundByWorkspace.delete(workspace)
        core.dropClient(workspace)
      }
    })
  }

  const boundByWorkspace = new Map<string, RelaySocket>()
  return { core, acceptSocket }
}
