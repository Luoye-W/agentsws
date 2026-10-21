/**
 * WP444：团队通道这项增值服务——本机这一侧（决策 1377–1381）。
 *
 * 本机能跑的不收费（个人、局域网同事互联、公司模式本机功能）；**跨网那条路**（经工坊云的团队通道）是增值服务：
 * 按组织每月扣积分（按人数档，档位与价钱以云上为准）、7 天免费试用一次、到期 / 积分不够宽限 30 天照常能用，
 * 宽限过了只关跨网那条路——局域网照常，数据一条不动。
 *
 * 这里只做四件事，钱和状态都在云上：
 * 1. 问云「现在怎样」、开通（含试用）、取消——原样转给云（`/v1/team/subscription`），顺手报人数；
 * 2. 人数变了报给云（下个月按新人数落档，月中加人不补差）；
 * 3. 开通 / 续费之后叫团队通道马上重新申请（不等退避）；
 * 4. 把「试用快结束 / 宽限中 / 已关」变成铃铛里的通知（类别「积分」），回到能用时自动算已读。
 */

import type { TeamSubscriptionLocalView } from '@agentsws/api'
import {
  TEAM_SUB_NOTICE_KEYS,
  type TeamSubscriptionView,
  teamChannelUsable,
} from '@agentsws/contracts'
import type { TunnelFetch } from './team-tunnel.js'

export interface TeamSubscriptionClientOptions {
  /** 工坊云的地址（没有 = 这台机器不走云）。 */
  cloudBase(): string | undefined
  /** 工作区令牌（没关联 = undefined）。 */
  token(): string | undefined
  /** 这里现在实际在用的人数（含发起人）。 */
  members(): Promise<number>
  fetch?: TunnelFetch
  /** 云上状态变了（开通 / 续费 / 取消 / 读到新状态）：团队通道重试、铃铛对一遍。 */
  onView?(view: TeamSubscriptionView): void
}

export interface TeamSubscriptionClient {
  view(): Promise<TeamSubscriptionLocalView>
  subscribe(): Promise<TeamSubscriptionLocalView>
  cancel(): Promise<TeamSubscriptionLocalView>
  /** 人数变了就报（没变不打云）。回报没报。 */
  reportMembers(): Promise<boolean>
  /** 最近一次读到的（没读过 undefined）。 */
  last(): TeamSubscriptionView | undefined
}

const NOT_LINKED = '登录工坊账号后，才能开通不在同一个网络的团队通道。'

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

export function createTeamSubscriptionClient(
  options: TeamSubscriptionClientOptions,
): TeamSubscriptionClient {
  const doFetch = options.fetch ?? defaultFetch
  let last: TeamSubscriptionView | undefined
  let reported: number | undefined

  async function call(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<TeamSubscriptionLocalView> {
    const base = options.cloudBase()
    if (base === undefined)
      return { linked: false, reason: '这台机器没有连工坊云，跨网的团队通道用不了。' }
    const token = options.token()
    if (token === undefined) return { linked: false, reason: NOT_LINKED }
    try {
      const res = await doFetch(`${base.replace(/\/+$/, '')}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await res.text()
      let parsed: { data?: TeamSubscriptionView; message?: unknown } = {}
      try {
        parsed = text === '' ? {} : (JSON.parse(text) as typeof parsed)
      } catch {
        parsed = {}
      }
      if (res.status === 401)
        return { linked: false, reason: '工坊账号的登录过期了，重新登录一次。' }
      if (!res.ok || parsed.data === undefined)
        return {
          linked: true,
          reason:
            typeof parsed.message === 'string'
              ? parsed.message
              : res.status === 404 || res.status === 501
                ? '工坊云这边还没开团队通道的订阅。'
                : `工坊云没答应（${String(res.status)}）。`,
        }
      last = parsed.data
      reported = parsed.data.members
      options.onView?.(parsed.data)
      return { linked: true, subscription: parsed.data }
    } catch {
      return { linked: true, reason: '网络不通，这一下没连上工坊云。' }
    }
  }

  return {
    async view() {
      const got = await call('GET', '/v1/team/subscription')
      // 读到了顺手对一下人数（人数变了下个月按新档扣）
      if (got.subscription !== undefined) {
        const n = await options.members().catch(() => undefined)
        if (n !== undefined && n !== got.subscription.members)
          return call('POST', '/v1/team/subscription/members', { members: n })
      }
      return got
    },
    async subscribe() {
      const members = await options.members().catch(() => undefined)
      return call('POST', '/v1/team/subscription', members === undefined ? {} : { members })
    },
    cancel() {
      return call('DELETE', '/v1/team/subscription')
    },
    async reportMembers() {
      if (options.token() === undefined || options.cloudBase() === undefined) return false
      const n = await options.members().catch(() => undefined)
      if (n === undefined || n === reported) return false
      const got = await call('POST', '/v1/team/subscription/members', { members: n })
      return got.subscription !== undefined
    },
    last: () => last,
  }
}

/** 一条要进铃铛的（`key` 合并同一件事）。 */
export interface TeamSubNotice {
  key: string
  text: string
}

/** 剩几天（向上取整；过了是 0）。 */
export function daysLeft(until: string | undefined, nowMs: number): number | undefined {
  if (until === undefined) return undefined
  const ms = Date.parse(until) - nowMs
  if (!Number.isFinite(ms)) return undefined
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

/**
 * 云上的状态 → 现在该在铃铛里的那一条（没有就 undefined），以及该收成已读的那几条键。
 *
 * - 试用还剩 ≤ 2 天：「团队通道试用还剩 N 天，到期后每月 X 积分」；
 * - 宽限中：「团队通道的月费没扣上，宽限到 M-D，之后跨网的同事连不进来」；
 * - 已关（宽限过了，或者试用 / 当期结束没续）：「团队通道已关……同一个网络里照常能用」。
 * - 长期免费：什么都不发，三条都收掉。
 */
export function teamSubscriptionNotice(
  view: TeamSubscriptionView,
  nowMs: number,
): { notice?: TeamSubNotice; settle: string[] } {
  const all = Object.values(TEAM_SUB_NOTICE_KEYS)
  if (view.comped) return { settle: all }
  const date = (iso: string | undefined): string => {
    if (iso === undefined) return ''
    const d = new Date(Date.parse(iso) + 8 * 3_600_000)
    return `${String(d.getUTCMonth() + 1)}-${String(d.getUTCDate())}`
  }
  if (view.status === 'trial' && !view.cancel_at_period_end) {
    const left = daysLeft(view.trial_ends_at, nowMs)
    if (left !== undefined && left <= 2)
      return {
        notice: {
          key: TEAM_SUB_NOTICE_KEYS.trialEnding,
          text: `团队通道试用还剩 ${String(left)} 天，到期后每月 ${String(view.tier.credits)} 积分`,
        },
        settle: [TEAM_SUB_NOTICE_KEYS.grace, TEAM_SUB_NOTICE_KEYS.off],
      }
    return { settle: [TEAM_SUB_NOTICE_KEYS.grace, TEAM_SUB_NOTICE_KEYS.off] }
  }
  if (view.status === 'grace')
    return {
      notice: {
        key: TEAM_SUB_NOTICE_KEYS.grace,
        text: `团队通道的月费没扣上（积分不够），宽限到 ${date(view.grace_until)}，之后跨网的同事连不进来`,
      },
      settle: [TEAM_SUB_NOTICE_KEYS.trialEnding, TEAM_SUB_NOTICE_KEYS.off],
    }
  // 已关：宽限过了；或者用过（试用 / 订过）、现在不能用了。从来没开过的不打扰
  const usedBefore = !view.trial_available
  if (
    view.status === 'suspended' ||
    (usedBefore && !teamChannelUsable(view.status) && view.status === 'none')
  )
    return {
      notice: {
        key: TEAM_SUB_NOTICE_KEYS.off,
        text: '团队通道已关：不在同一个网络的同事暂时连不进来，同一个网络里照常能用',
      },
      settle: [TEAM_SUB_NOTICE_KEYS.trialEnding, TEAM_SUB_NOTICE_KEYS.grace],
    }
  return { settle: all }
}
