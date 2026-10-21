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

/* ------------------------------------------------------------------ */
/* WP444：团队通道做成增值服务（决策 1377–1381，Luoye 10-21；1378 当天改成人数档）            */
/* ------------------------------------------------------------------ */

/**
 * 团队通道这项增值服务的 id（同时是价目表里那条能力的名字）。
 *
 * 只有**跨网**那条路（经工坊云）收费：本机能跑的（个人、局域网同事互联、公司模式本机功能）一律不收（决策 1377）。
 * 按组织订：只有发起开通道的那个组织付，加入进来的同事不付（决策 1378）。
 */
export const TEAM_SERVICE_ID = 'team.channel.monthly'

/** 每个组织一次的免费试用天数（决策 1379）。 */
export const TEAM_TRIAL_DAYS = 7

/**
 * 团队通道的通知类别 key（客户端铃铛里用；同一件事合并）：试用快结束 / 宽限中 / 已关。
 * 前缀 `team_sub:`，后面跟状态，回到能用时客户端把这几条收成已读。
 */
export const TEAM_SUB_NOTICE_KEYS = {
  trialEnding: 'team_sub:trial_ending',
  grace: 'team_sub:grace',
  off: 'team_sub:off',
} as const

/** 一个人数档：最多几人、每月多少积分。 */
export interface TeamTier {
  /** 这一档最多几人（含发起人自己）。 */
  members: number
  credits: number
}

/**
 * 人数档与价钱（**运营后台可改**，客户端从云上取当前这一份显示；不写死在代码里）。
 *
 * 决策 1378（10-21 改）：四档 3 / 5 / 8 / 10 人；超过最大档的，按最大档 + 每多 1 人加 `extra_per_member`。
 */
export interface TeamPricing {
  /** 从小到大。 */
  tiers: TeamTier[]
  /** 超过最大一档之后，每多 1 人加多少积分 / 月。 */
  extra_per_member: number
  updated_at?: Iso8601
}

/** 云上还没在后台改过时用的那一份（Luoye 10-21 定：3 人 45、5 人 68、8 人 98、10 人 120，超过 10 人每人 +12）。 */
export const DEFAULT_TEAM_PRICING: TeamPricing = {
  tiers: [
    { members: 3, credits: 45 },
    { members: 5, credits: 68 },
    { members: 8, credits: 98 },
    { members: 10, credits: 120 },
  ],
  extra_per_member: 12,
}

/** 按人数落档：回落到哪一档、这个月多少积分、超出最大档几人。 */
export interface TeamTierPick {
  /** 落到的那一档的人数上限（超过最大档时是最大档的人数）。 */
  members: number
  credits: number
  /** 超过最大档的人数（没超是 0）。 */
  extra_members: number
}

/** 人数 → 档位与价钱。人数小于 1 按 1 算；比最小档还少落最小档。 */
export function teamTierOf(pricing: TeamPricing, members: number): TeamTierPick {
  const n = Math.max(1, Math.floor(Number.isFinite(members) ? members : 1))
  const tiers = [...pricing.tiers].sort((a, b) => a.members - b.members)
  for (const t of tiers) if (n <= t.members) return { ...t, extra_members: 0 }
  const top = tiers[tiers.length - 1] ?? { members: 1, credits: 0 }
  const extra = n - top.members
  return {
    members: top.members,
    credits: top.credits + extra * pricing.extra_per_member,
    extra_members: extra,
  }
}

/** 一份人数档能不能用（后台保存前核一遍）：至少一档、人数严格递增、价钱不为负。回第一处不对的人话。 */
export function teamPricingProblem(p: TeamPricing): string | undefined {
  if (!Array.isArray(p.tiers) || p.tiers.length === 0) return '至少要有一档'
  if (p.tiers.length > 12) return '最多 12 档'
  let last = 0
  for (const t of p.tiers) {
    if (!Number.isInteger(t.members) || t.members < 1 || t.members > 10_000)
      return '每档人数要是 1 以上的整数'
    if (t.members <= last) return '档位人数要从小到大、不重复'
    if (!Number.isFinite(t.credits) || t.credits < 0 || t.credits > 100_000)
      return '每档积分要是 0 以上的数'
    last = t.members
  }
  if (!Number.isFinite(p.extra_per_member) || p.extra_per_member < 0 || p.extra_per_member > 10_000)
    return '超出部分每人加价要是 0 以上的数'
  return undefined
}

/**
 * 团队通道订阅现在是什么状态（在通用订阅的五个状态上多一个 `trial`）。
 *
 * - `trial`：7 天免费试用中（`trial_ends_at` 那一刻起按月扣）；
 * - `grace`：到期 / 积分不够没扣上——**照常能用** 30 天，铃铛提醒（决策 1380；与红人 / 客服「宽限即暂停」不同）；
 * - `suspended`：宽限过了还没充上：跨网通道关掉，局域网照常，数据不动；
 * - `cancelling`：点了取消，当期（或试用）用完为止。
 */
export type TeamSubscriptionStatus =
  | 'none'
  | 'trial'
  | 'active'
  | 'grace'
  | 'suspended'
  | 'cancelling'

/** 这个状态下跨网通道能不能用（长期免费另算，见 {@link TeamSubscriptionView.comped}）。 */
export function teamChannelUsable(status: TeamSubscriptionStatus): boolean {
  return status === 'trial' || status === 'active' || status === 'cancelling' || status === 'grace'
}

/** 一次扣费的结果（只在开通 / 续费那一次回）。 */
export interface TeamSubscriptionCharge {
  cycle_start: Iso8601
  ok: boolean
  credits: number
}

/**
 * `GET / POST / DELETE /v1/team/subscription` 回的：这个组织的团队通道订阅现在怎样。
 *
 * 开通时钱不够**不回 402**：试用期内本来就不扣；试用过了要扣而扣不上，照开、进 `grace`（照常能用 30 天）。
 */
export interface TeamSubscriptionView {
  service_id: typeof TEAM_SERVICE_ID
  status: TeamSubscriptionStatus
  /** 现在跨网通道能不能用（`trial` / `active` / `cancelling` / `grace`，或者长期免费）。 */
  usable: boolean
  /** 运营给开了「长期免费」（不扣积分，状态照常显示）。 */
  comped: boolean
  /** 还能不能开 7 天试用（每个组织一次）。 */
  trial_available: boolean
  trial_ends_at?: Iso8601
  cancel_at_period_end: boolean
  /** 当期到哪天（取消后用到这天为止）。 */
  current_cycle_end?: Iso8601
  /** 宽限到哪天（过了就关跨网通道）。 */
  grace_until?: Iso8601
  /** 云上记的人数（发起人电脑报上来的，扣费按扣那一刻的人数落档）。 */
  members: number
  /** 按这个人数落到的档、每月多少积分。 */
  tier: TeamTierPick
  /** 当前的人数档与价钱（后台可改）。 */
  pricing: TeamPricing
  /** 只在开通 / 续费那一次回：这一次扣了哪几期。 */
  charged?: TeamSubscriptionCharge[]
}

/** 开通 / 续费（顺手报一下现在几个人）。 */
export interface TeamSubscribeInput {
  /** 这个组织现在实际在用的人数（含发起人）。不给 = 沿用云上记的。 */
  members?: number
}

/** 报人数（人数变了就报；下个月按新人数落档，月中加人不补差）。 */
export interface TeamMembersReport {
  members: number
}

/** 申请通道时顺手报人数（可选；老客户端不带正文）。 */
export interface TeamTunnelRequest {
  members?: number
}

/**
 * 通道地址上回 503 时带的头：`subscription` = 对方的团队通道没开通 / 已到期；`offline` = 对方电脑不在线；
 * `blocked` = 运营停了这条通道。同事那边的工坊据此说人话。
 */
export const TEAM_OFF_HEADER = 'x-agentsws-team-off'
export type TeamOffReason = 'subscription' | 'offline' | 'blocked'
