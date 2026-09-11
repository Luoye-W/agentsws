/**
 * 同事发现（WP51 交付 ④，46 §2 I2 第二条渠道：局域网）。
 *
 * 办公室里两个人各自装了这个工具、各自写了同一家公司的全称，他们应该能互相看见——
 * **不经任何服务器**。做法是 mDNS：在本机网段广播一条 `_agentsws._tcp` 服务，
 * 同时监听同一种服务，TXT 里只有两样东西：
 *
 * ```
 * k=<sha256(归一化公司名 | 域名)>   v=1
 * ```
 *
 * 三条不可让步的边界：
 *
 * 1. **只出哈希**（46 §2 I1）。TXT 里没有公司全称、没有工作区名、没有成员名单、
 *    没有邮箱。对方拿到的只是"这台机器算出来的钥匙和我一样"。
 * 2. **看见 ≠ 连上**。看见之后要显示点什么（"王岚的工作区 · 3 人"），那是**主动去问**
 *    对方的 `/v1/discovery/hello` 拿的——对方自己愿意报的一句话，而且那条路由
 *    回的就只有那么多。我们不从广播包里推断任何东西。
 * 3. **起不来不算错**（46 §5）。没网卡、容器里没 multicast、系统不给权限——
 *    一律降级成"局域网发现在这台机器上用不了"，服务进程照常跑完，向导照常走完。
 *
 * 测试用注入的假 mDNS（`MdnsFactory`），所以"两台机器互相看见"这件事在单元测试里
 * 走的是同一条代码路径，只是底下的多播换成了一个内存总线。
 */
import { createRequire } from 'node:module'
import type { DiscoveryHelloView, DiscoveryPeerView, DiscoveryStateView } from '@agentsws/api'
import type { Clock, EventEnvelope, PersonId, WorkspaceId } from '@agentsws/contracts'

/** 46 §2 I2：服务类型与 TXT 版本。改了这两个就是换协议，要同时改两端。 */
export const SERVICE_TYPE = 'agentsws'
export const TXT_VERSION = '1'

/** 广播出去的一条记录（我们只认这几样）。 */
export interface MdnsAdvert {
  name: string
  type: string
  port: number
  txt: Record<string, string>
}

/** 监听到的一条同伴记录。 */
export interface MdnsPeer {
  name: string
  host: string
  port: number
  txt: Record<string, string>
}

/**
 * mDNS 的最小面。真实现是 `bonjour-service`；测试注入一个内存总线。
 *
 * `publish` 返回一个停止函数；`browse` 同理。两者都**不许抛**——起不来要在
 * `create` 那一步就说清楚（返回 undefined + reason）。
 */
export interface Mdns {
  publish(advert: MdnsAdvert): void
  browse(onPeer: (peer: MdnsPeer) => void): void
  stop(): void
}

/** 造一个 mDNS；起不来就回 `{ reason }`，调用方降级。 */
export type MdnsFactory = () => { mdns?: Mdns; reason?: string }

export interface DiscoveryOptions {
  clock: Clock
  workspace_id: WorkspaceId
  appendEvent(e: Omit<EventEnvelope, 'id' | 'at'> & { at?: string }): void
  /** 本机的公司钥匙；没设过公司档案时是 undefined（那就什么都不广播）。 */
  companyKey(): string | undefined
  /** 开关（`Workspace.profile.discoverable`）。 */
  enabled(): boolean
  /** 服务进程监听的端口；还没 listen 时是 undefined。 */
  port?: () => number | undefined
  mdns?: MdnsFactory
  /** 去问同伴"你是谁"。默认 `fetch`。 */
  helloFetch?: (url: string) => Promise<DiscoveryHelloView | undefined>
}

export interface Discovery {
  /** 这台机器在局域网上的 id（随机、与工作区 id 无关——它不该泄漏内部 id）。 */
  peerId(): string
  status(): { available: boolean; reason?: string }
  /** 开关打开：开始广播与监听，记 `discovery.enabled`。 */
  enable(by: PersonId): void
  /** 开关关闭：停广播、停监听、清掉看见过的同伴，记 `discovery.disabled`。 */
  disable(by: PersonId): void
  /** 公司名改了 → 钥匙变了 → 用新钥匙重来一轮。 */
  refresh(): void
  peers(): Promise<DiscoveryStateView>
  /** 某位同伴的地址（申请加入时要往那边发一条请求）。 */
  peer(peer_id: string): { host: string; port: number } | undefined
  /** 现在看得见的全部同伴 id（贴码时挨个试）。 */
  peerIds(): string[]
  close(): void
}

interface PeerRow {
  peer_id: string
  host: string
  port: number
  first_seen_at: string
  last_seen_at: string
  workspace_label?: string
}

/** 默认工厂：`bonjour-service`（MIT、纯 JS）。装不上 / 起不来就降级。 */
export function bonjourFactory(): { mdns?: Mdns; reason?: string } {
  try {
    const require = createRequire(import.meta.url)
    // biome-ignore lint/suspicious/noExplicitAny: CommonJS 默认导出，类型在 dist/index.d.ts 里是 `export =`
    const Bonjour = require('bonjour-service') as any
    // 第二个参数是错误回调：多播口起不来时它会被调，而不是抛——所以这里吞掉，
    // 由 `status()` 那一格告诉用户"局域网发现用不了"
    let failed: string | undefined
    const instance = new Bonjour.Bonjour(undefined, (err: unknown) => {
      failed = err instanceof Error ? err.message : String(err)
    })
    const stops: (() => void)[] = []
    const mdns: Mdns = {
      publish(advert) {
        const service = instance.publish({
          name: advert.name,
          type: advert.type,
          port: advert.port,
          protocol: 'tcp',
          txt: advert.txt,
        })
        stops.push(() => {
          try {
            service.stop()
          } catch {
            // 停不下来就算了：进程要退出了，多播记录会自己过期
          }
        })
      },
      browse(onPeer) {
        const browser = instance.find(
          { type: advertType() },
          (service: Record<string, unknown>) => {
            const host = pickHost(service)
            const port = typeof service.port === 'number' ? service.port : 0
            const txt = (service.txt ?? {}) as Record<string, string>
            const name = typeof service.name === 'string' ? service.name : ''
            if (host === undefined || port === 0) return
            onPeer({ name, host, port, txt })
          },
        )
        stops.push(() => {
          try {
            browser.stop()
          } catch {
            // 同上
          }
        })
      },
      stop() {
        for (const stop of stops.splice(0)) stop()
        try {
          instance.destroy()
        } catch {
          // 同上
        }
      },
    }
    return failed === undefined ? { mdns } : { mdns, reason: failed }
  } catch (err) {
    return { reason: err instanceof Error ? err.message : String(err) }
  }
}

const advertType = (): string => SERVICE_TYPE

function pickHost(service: Record<string, unknown>): string | undefined {
  const addresses = service.addresses
  if (Array.isArray(addresses)) {
    // IPv4 优先：拿去拼 URL 时不用管方括号
    const v4 = addresses.find((a) => typeof a === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(a))
    if (typeof v4 === 'string') return v4
    const first = addresses.find((a) => typeof a === 'string')
    if (typeof first === 'string') return first
  }
  return typeof service.host === 'string' ? service.host : undefined
}

async function defaultHello(url: string): Promise<DiscoveryHelloView | undefined> {
  try {
    const res = await fetch(url)
    if (!res.ok) return undefined
    const body = (await res.json()) as { data?: DiscoveryHelloView }
    return body.data
  } catch {
    // 对方关机了 / 换网段了：这不是错误，只是这一轮问不到
    return undefined
  }
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const { clock, workspace_id, appendEvent } = options
  const hello = options.helloFetch ?? defaultHello
  const factory = options.mdns ?? bonjourFactory
  const peerId = `peer_${Math.random().toString(36).slice(2, 10)}`
  const seen = new Map<string, PeerRow>()

  let mdns: Mdns | undefined
  let reason: string | undefined
  let started = false
  let probed = false
  /** 上一次广播出去的端口；服务进程 listen 之后它会从 0 变成真端口，那时要重来一轮。 */
  let publishedPort = -1

  /** 真正去造 mDNS 的那一下；只造一次，造不出来就永远是"用不了"。 */
  const ensure = (): void => {
    if (probed) return
    probed = true
    const made = factory()
    mdns = made.mdns
    reason =
      made.reason ??
      (made.mdns === undefined ? '这台机器上起不来局域网发现（没网卡或没权限）' : undefined)
  }

  const emit = (
    type: string,
    actor: PersonId | 'system',
    payload: Record<string, unknown>,
  ): void => {
    appendEvent({
      schema_version: 1,
      workspace_id,
      type,
      actor:
        actor === 'system' ? { kind: 'system', id: 'discovery' } : { kind: 'person', id: actor },
      // 21 §2：每条事件都要有 trace。发现是**背景里发生的事**——多播包什么时候到
      // 由网络说了算，不在任何一次请求的 trace 里，所以自己起一条。
      correlation: { trace_id: `tr_discovery_${clock.now()}` },
      payload,
    })
  }

  const start = (): void => {
    ensure()
    if (started || mdns === undefined) return
    const key = options.companyKey()
    if (key === undefined) return
    // 还没 listen 的时候端口是未知的（内嵌用法、测试）。照旧广播，只是报 0——
    // 同伴问不到就问不到；等真端口出来了 `ensurePort` 会用新端口重来一轮。
    const port = options.port?.() ?? 0
    started = true
    publishedPort = port
    // 46 §2 I2：TXT 只有钥匙与版本。名字用的是随机 peer_id，不是工作区 id，
    // 也不是公司名——广播包被抓走也只是一串哈希。
    mdns.publish({ name: peerId, type: SERVICE_TYPE, port, txt: { k: key, v: TXT_VERSION } })
    // 这个回调是**网络喂进来的**：它里面出的任何岔子都不该顺着调用栈爬回
    // `publish` 的调用方（那一头是"用户点了保存公司档案"）。一律吞掉。
    mdns.browse((peer) => {
      try {
        onPeer(peer)
      } catch {
        // 一条广播包处理不了就丢掉它，下一条照收
      }
    })
  }

  /** 收一条广播记录（同 key、不是自己）就记下来，第一次看见记一条事件。 */
  function onPeer(peer: MdnsPeer): void {
    if (peer.txt.v !== TXT_VERSION) return
    // 钥匙对不上的一律不看：同一个网段上可能有别的公司在用同一个工具
    if (peer.txt.k !== options.companyKey()) return
    if (peer.name === peerId) return
    const now = clock.now()
    const existing = seen.get(peer.name)
    if (existing === undefined) {
      seen.set(peer.name, {
        peer_id: peer.name,
        host: peer.host,
        port: peer.port,
        first_seen_at: now,
        last_seen_at: now,
      })
      // 日志里只有对方的 peer_id 与地址：没有公司名、没有成员、没有钥匙
      emit('discovery.peer_seen', 'system', {
        peer_id: peer.name,
        host: peer.host,
        port: peer.port,
      })
    } else {
      existing.host = peer.host
      existing.port = peer.port
      existing.last_seen_at = now
    }
  }

  /** listen 之后端口变了 → 用新端口重新广播一次（旧记录会随实例销毁而消失）。 */
  const ensurePort = (): void => {
    if (!started) return
    const now = options.port?.() ?? 0
    if (now === publishedPort) return
    stop()
    start()
  }

  const stop = (): void => {
    if (!started) return
    started = false
    mdns?.stop()
    // 重新开时要能再 publish 一遍：`bonjour-service` 的实例 destroy 过就不能再用了
    mdns = undefined
    probed = false
    seen.clear()
  }

  return {
    peerId: () => peerId,
    status() {
      ensure()
      return mdns === undefined
        ? { available: false, reason: reason ?? '局域网发现不可用' }
        : { available: true }
    },
    enable(by) {
      start()
      emit('discovery.enabled', by, { available: mdns !== undefined })
    },
    disable(by) {
      stop()
      emit('discovery.disabled', by, {})
    },
    refresh() {
      if (!started) {
        start()
        return
      }
      stop()
      start()
    },
    async peers(): Promise<DiscoveryStateView> {
      ensure()
      const enabled = options.enabled()
      if (enabled) {
        start()
        ensurePort()
      }
      const available = mdns !== undefined
      if (!enabled) {
        // 开关关着 = 不广播、不查询、不登记（46 §2 末段）
        return {
          available,
          enabled: false,
          ...(available ? {} : { reason: reason ?? '局域网发现不可用' }),
          peers: [],
        }
      }
      // 看见了才去问"你是谁"——展示名是对方自己报的，不是我们从广播包里猜的
      const rows = [...seen.values()]
      await Promise.all(
        rows.map(async (row) => {
          if (row.workspace_label !== undefined) return
          const said = await hello(`http://${row.host}:${row.port}/v1/discovery/hello`)
          if (said !== undefined) row.workspace_label = said.workspace_label
        }),
      )
      const peers: DiscoveryPeerView[] = rows.map((row) => ({
        peer_id: row.peer_id,
        workspace_label: row.workspace_label ?? '还没自报家门的一台机器',
        host: row.host,
        port: row.port,
        first_seen_at: row.first_seen_at,
        last_seen_at: row.last_seen_at,
      }))
      return {
        available,
        enabled: true,
        ...(available ? {} : { reason: reason ?? '局域网发现不可用' }),
        peers,
      }
    },
    peer(peer_id) {
      const row = seen.get(peer_id)
      return row === undefined ? undefined : { host: row.host, port: row.port }
    },
    peerIds: () => [...seen.keys()],
    close() {
      stop()
    },
  }
}
