/**
 * WP427：同事怎么连进来——两条路、一扇门，什么时候开、什么时候关。
 *
 * - **什么时候开**：用户打开了「和同事一起用」（让同事找到我），或者这里已经不止一个人
 *   （② 同事互联 / ③ 公司）。① 个人、没打开的时候**一下网络都不碰**——服务进程照旧只听 127.0.0.1，
 *   不起局域网那扇门、不拨云（WP422 的口径，Windows 不会弹「要联网」）。
 * - **局域网那条路**（同一个网络时的快路）：另一个端口上起「团队门」（`team-door.ts`），所有网卡上听；
 *   局域网发现广播的是这扇门的端口。Windows 上这一下会弹一次防火墙（用户刚点了「和同事一起用」，
 *   界面上有一句为什么要点允许）；WP427 起服务进程的 Node 住在不随版本变的路径上，允许一次一直有效。
 * - **云那条路**（不在同一个网络时）：拨一条长连接到工坊云（`team-tunnel.ts`），要这台电脑关联过工坊账号。
 *   不开端口、不要公网 IP、不装 Tailscale。
 *
 * 两条路过的是同一扇门：没登录只能递申请、问批了没有、用工坊账号进门；其余都要会话。
 */
import { networkInterfaces } from 'node:os'
import type { TeamLinkView } from '@agentsws/api'
import { createDoorHandler, type LanDoor, startLanDoor } from './team-door.js'
import {
  createTeamTunnel,
  type TeamTunnel,
  type TunnelFetch,
  type TunnelSocketFactory,
  type TunnelVault,
} from './team-tunnel.js'

export interface TeamLinkOptions {
  /** 现在该不该开（「和同事一起用」打开了，或者这里不止一个人）。 */
  wanted(): Promise<boolean>
  /** 本机服务进程的端口（还没 listen 时 undefined）。 */
  mainPort(): number | undefined
  authenticate(token: string): Promise<{ kind: string } | undefined>
  cookieName: string
  /** 局域网那扇门：关掉（`AGENTSWS_TEAM_LAN=off`）就只走云。 */
  lan?: { off?: boolean; host?: string; port?: number }
  /** 云那条路：不给 = 不走云（托管实例、测试）。 */
  cloud?: {
    base(): string
    token(): string | undefined
    vault: TunnelVault
    fetch?: TunnelFetch
    socketFactory?: TunnelSocketFactory
    /** WP444：这里现在几个人（申请通道时顺手报给云，按人数落档）。 */
    members?(): number | undefined
  }
  /** 还活着的邀请码（通道刚连上时把它们登记到云上）。 */
  liveInvites(): { code: string; expires_at: string }[]
  /** 局域网那扇门开 / 关了（发现那边要按新端口重新广播）。 */
  onLanChanged?(port: number | undefined): void
  onEvent?(event: { type: string; detail?: string }): void
}

export interface TeamLink {
  /** 按现在的情况开 / 关（幂等；启动、改开关、批进一个人之后调）。 */
  sync(): Promise<void>
  /** 局域网那扇门的端口（没开 undefined）。 */
  lanPort(): number | undefined
  status(): TeamLinkView
  /** 邀请链接用哪个地址开头（云通道 > 局域网地址；都没有 undefined——那就只给码）。 */
  inviteBase(): string | undefined
  /** 新发了一个码：通道在就登记到云上（不在就等连上时一起登记）。 */
  registerCode(code: string, expires_at: string): void
  /** 测试用：等云那条路连上。 */
  whenCloudOnline(timeoutMs?: number): Promise<boolean>
  /** WP444：刚开通 / 续费了团队通道：云那条路不等，马上重新申请。 */
  retryCloud(): void
  close(): Promise<void>
}

/** 这台电脑在局域网里的地址（第一个私有 IPv4；没有回 undefined）。 */
export function lanAddress(
  nets: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string | undefined {
  const privateV4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === 'IPv4' && !n.internal && privateV4.test(n.address)) return n.address
    }
  }
  return undefined
}

export function createTeamLink(options: TeamLinkOptions): TeamLink {
  let door: LanDoor | undefined
  let lanReason: string | undefined
  let open = false
  let syncing: Promise<void> | undefined
  let closed = false

  const tunnel: TeamTunnel | undefined =
    options.cloud === undefined
      ? undefined
      : createTeamTunnel({
          cloudBase: options.cloud.base,
          token: options.cloud.token,
          vault: options.cloud.vault,
          handler: createDoorHandler({
            upstream: () => {
              const p = options.mainPort()
              return p === undefined ? undefined : `http://127.0.0.1:${String(p)}`
            },
            authenticate: options.authenticate,
            cookieName: options.cookieName,
            via: 'cloud',
          }),
          ...(options.cloud.fetch === undefined ? {} : { fetch: options.cloud.fetch }),
          ...(options.cloud.socketFactory === undefined
            ? {}
            : { socketFactory: options.cloud.socketFactory }),
          ...(options.cloud.members === undefined ? {} : { members: options.cloud.members }),
          onEvent: (e) => {
            options.onEvent?.(e)
            // 刚连上：把还活着的码登记一遍（之前发的码那会儿还没地方登记）
            if (e.type === 'team.tunnel_online')
              for (const i of options.liveInvites()) void tunnel?.registerCode(i.code, i.expires_at)
          },
        })

  async function openLan(): Promise<void> {
    if (door !== undefined || options.lan?.off === true) return
    try {
      door = await startLanDoor({
        upstream: () => {
          const p = options.mainPort()
          return p === undefined ? undefined : `http://127.0.0.1:${String(p)}`
        },
        upstreamPort: options.mainPort,
        authenticate: options.authenticate,
        cookieName: options.cookieName,
        ...(options.lan?.host === undefined ? {} : { host: options.lan.host }),
        ...(options.lan?.port === undefined ? {} : { port: options.lan.port }),
      })
      lanReason = undefined
      options.onEvent?.({ type: 'team.lan_opened', detail: String(door.port) })
      options.onLanChanged?.(door.port)
    } catch (err) {
      door = undefined
      lanReason = `局域网这条路没开起来：${err instanceof Error ? err.message : String(err)}`
      options.onEvent?.({ type: 'team.lan_failed', detail: lanReason })
    }
  }

  async function closeLan(): Promise<void> {
    const d = door
    door = undefined
    if (d === undefined) return
    await d.close().catch(() => undefined)
    options.onEvent?.({ type: 'team.lan_closed' })
    options.onLanChanged?.(undefined)
  }

  async function doSync(): Promise<void> {
    if (closed) return
    let want = false
    try {
      want = await options.wanted()
    } catch {
      want = open
    }
    if (options.mainPort() === undefined) want = false
    open = want
    if (want) {
      await openLan()
      tunnel?.start()
    } else {
      tunnel?.stop()
      await closeLan()
    }
  }

  const inviteBase = (): string | undefined => {
    if (!open) return undefined
    const cloud = tunnel?.url()
    if (cloud !== undefined) return cloud
    if (door === undefined) return undefined
    const ip = lanAddress()
    return ip === undefined ? undefined : `http://${ip}:${String(door.port)}`
  }

  return {
    sync() {
      // 串行：两次 sync 叠在一起会起两扇门
      const run = (syncing ?? Promise.resolve()).then(doSync, doSync)
      syncing = run.finally(() => {
        if (syncing === run) syncing = undefined
      })
      return run
    },
    lanPort: () => door?.port,
    status(): TeamLinkView {
      const lanUrl = (() => {
        if (door === undefined) return undefined
        const ip = lanAddress()
        return ip === undefined ? undefined : `http://${ip}:${String(door.port)}`
      })()
      const cloudUrl = tunnel?.url()
      return {
        open,
        lan: {
          on: door !== undefined,
          ...(lanUrl === undefined ? {} : { url: lanUrl }),
          ...(lanReason === undefined || !open ? {} : { reason: lanReason }),
          ...(options.lan?.off === true ? { reason: '这台电脑关掉了局域网这条路' } : {}),
        },
        cloud: {
          state: tunnel === undefined ? 'unavailable' : open ? tunnel.state() : 'stopped',
          ...(cloudUrl === undefined || !open ? {} : { url: cloudUrl }),
          ...(() => {
            const reason = tunnel?.reason()
            return reason === undefined || !open ? {} : { reason }
          })(),
        },
        ...(() => {
          const base = inviteBase()
          return base === undefined ? {} : { invite_base: base }
        })(),
      }
    },
    inviteBase,
    registerCode(code, expires_at) {
      if (!open || tunnel === undefined) return
      void tunnel.registerCode(code, expires_at)
    },
    whenCloudOnline: (timeoutMs) => tunnel?.whenOnline(timeoutMs) ?? Promise.resolve(false),
    retryCloud() {
      tunnel?.retryNow()
    },
    async close() {
      closed = true
      tunnel?.stop()
      await closeLan()
    },
  }
}
