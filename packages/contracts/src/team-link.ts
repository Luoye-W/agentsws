/**
 * WP427：同事互联 / 公司模式的「团队通道」——两台不在同一个网络的电脑怎么连上。
 *
 * 数据放在发起人那台电脑上（docs/95 §3.3、§8 第 5 条：不做两台之间的同步），同事是**连进来用**的。
 * 同一个局域网里走局域网直连（快路）；不在同一个网络时，发起人的电脑**主动拨出去**一条长连接到
 * 工坊云（不开端口、不要公网 IP、不装任何东西），云上给它一个地址，同事的请求从云上经这条连接
 * 送到发起人电脑上那扇「团队门」（只放申请加入 / 登录这几条，其余都要登录过的会话）。
 *
 * 这一份是开源侧与私有云之间的约定：
 * - 发起人电脑 ↔ 云的长连接帧：{@link TeamTunnelClientFrame} / {@link TeamTunnelServerFrame}；
 * - 申请一条通道（`POST /v1/team/tunnel`，带工作区令牌）：{@link TeamTunnelIssued}；
 * - 邀请码登记与查找（贴码的同事在别的网络里，靠云查到是哪条通道）：{@link TeamCodeRegister} /
 *   {@link TeamCodeResolveRequest} / {@link TeamCodeResolved}。
 *
 * 同事那一侧打开的是通道地址（`https://<tunnel_id>-team.agentsws.com/`（WP435：一层子域、后缀式），按 Host 分流），
 * 云把整条 HTTP 请求打成 `request` 帧下发，响应按 `response_head` / `response_chunk` / `response_end`
 * 流回去（流式回复照常是流式的）。WebSocket 不经通道转（工作台连不上实时推送会自己退回轮询）。
 */
import type { Iso8601 } from './common.js'

/**
 * 「团队门」转进本机服务进程时带的头（值 `lan` / `cloud`；外面带进来的同名头门先抹掉）。
 * 服务进程据此知道「这一条是从别的电脑来的」：只收申请，不替对方往外转申请。
 */
export const TEAM_DOOR_HEADER = 'x-agentsws-door'

/** 当前协议版本。改了帧的形状就 +1。 */
export const TEAM_TUNNEL_PROTOCOL_VERSION = 1

/** 心跳间隔（毫秒）：这么久没收到任何帧就发 `ping`。 */
export const TEAM_TUNNEL_HEARTBEAT_MS = 15_000

/** 一次请求体的上限（字节）。再大的（比如大文件上传）回 413——同事那边换成在发起人电脑上传。 */
export const TEAM_TUNNEL_MAX_BODY_BYTES = 8 * 1024 * 1024

/** 响应一块的上限（字节，解码前）。大响应拆成多块流回去。 */
export const TEAM_TUNNEL_CHUNK_BYTES = 64 * 1024

/** 握手被拒的原因：密钥错与通道不存在是同一句话（不让人探哪些通道在）。 */
export type TeamTunnelRejectReason = 'bad_secret' | 'version_mismatch'

/** 申请（或取回）一条通道。同一个组织一条；再调一次换一把新密钥，旧的作废。 */
export interface TeamTunnelIssued {
  /** 通道 id（小写字母数字，进 Host 的那一段）。 */
  tunnel_id: string
  /** 同事打开的地址（不带尾斜杠）。 */
  url: string
  /** 握手密钥（`tts_…`）：只回这一次，本机存进加密库。 */
  secret: string
}

/** 一个 HTTP 头（保持顺序、允许重复，比如多条 `set-cookie`）。 */
export type TeamTunnelHeader = [name: string, value: string]

/** 发起人电脑 → 云。 */
export type TeamTunnelClientFrame =
  | {
      type: 'hello'
      protocol_version: number
      tunnel_id: string
      secret: string
    }
  | {
      /** 一次请求的响应头（每个 `request` 恰好一条，或者一条 `response_error`）。 */
      type: 'response_head'
      id: string
      status: number
      headers: TeamTunnelHeader[]
    }
  | {
      /** 响应体的一块（base64）。 */
      type: 'response_chunk'
      id: string
      data: string
    }
  | { type: 'response_end'; id: string }
  | {
      /** 这一次没能回（本机服务没起来、超时……）：云给同事回 502 + 这句人话。 */
      type: 'response_error'
      id: string
      message: string
    }
  | { type: 'ping' }
  | { type: 'pong' }

/** 云 → 发起人电脑。 */
export type TeamTunnelServerFrame =
  | {
      type: 'welcome'
      protocol_version: number
      /** 同事打开的地址（与申请时回的一样）。 */
      url: string
    }
  | { type: 'rejected'; reason: TeamTunnelRejectReason; supported?: number[] }
  | {
      /** 同事那边来的一次请求。`path` 带查询串；`body` 是 base64（没有正文就不给）。 */
      type: 'request'
      id: string
      method: string
      path: string
      headers: TeamTunnelHeader[]
      body?: string
    }
  | {
      /** 同事那边断开了（关了页面 / 取消了流式回复）：别再往回送这一条。 */
      type: 'cancel'
      id: string
    }
  | { type: 'ping' }
  | { type: 'pong' }

/** 登记一个邀请码（只给哈希；云上按哈希查，原码不出本机之外的任何日志）。 */
export interface TeamCodeRegister {
  /** `sha256(邀请码大写)` 的十六进制。 */
  code_hash: string
  expires_at: Iso8601
}

export interface TeamCodeRegistered {
  code_hash: string
  expires_at: Iso8601
}

/** 同事贴了一个本机、局域网里都找不到的码：问云这是谁的。 */
export interface TeamCodeResolveRequest {
  code: string
}

export interface TeamCodeResolved {
  /** 那条通道的地址；同事那边的服务进程拿它去递申请。 */
  url: string
}

/** 「团队门」上公开的那几条之一：申请人拿着自己那张票来问「批了没有」，批了就换一张一次性登录。 */
export interface MembershipClaimInput {
  /** 申请时只把票的哈希给了对方；这时才出示票本身。 */
  ticket: string
}

export interface MembershipClaimView {
  status: 'pending' | 'approved' | 'rejected' | 'superseded' | 'left'
  /** 对方自报的展示名（「王岚的工作区 · 3 人」）。 */
  workspace_label?: string
  /** 批了：一次性登录 token（15 分钟、用一次就废）。 */
  login_token?: string
  expires_at?: Iso8601
}
