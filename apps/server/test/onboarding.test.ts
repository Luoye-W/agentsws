/**
 * 首次设置与同事发现端到端（WP51，46）：真装配线（路由 → OnboardingPort →
 * discovery / invites → roles / identity / 审批总线），只把两跳换成替身——
 * mDNS 换成内存总线、机器间的 HTTP 换成直接喂给对方的网关。
 *
 * 覆盖的验收点：
 * - 46 §2 I1 归一化表：一个人写全称、另一个人多打空格还加"有限公司" → 同一把钥匙
 * - 46 §1 首次判定：没设过公司名 + 除 owner 外没有分配 → 走向导；设完就不再弹
 * - 46 §3 I5 清单：勾岗位 = 职责全勾，连接 / 技能去重汇总，模型没接时排第一条
 * - 46 §3 I6 建分配：连上 Shopify 的店自动挂上，只勾职责 → 一个自定义岗位
 * - 46 §2 I2 局域网：TXT 只有哈希；钥匙不同的邻居看不见；开关关掉就没有同伴
 * - 46 §2 I2 邀请码：8 位、24h、5 次；过期 / 用完不认
 * - 46 §2 I3 申请加入：目标收一张 membership 卡 → 批了才建成员；两边互相申请以先批的为准
 */
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { Mdns, MdnsPeer } from '../src/discovery.js'
import { createServer, type Server } from '../src/index.js'
import { createInvites } from '../src/invites.js'
import { companyKey, normalizeCompanyName, normalizeDomain } from '../src/onboarding.js'

const T0 = '2026-09-07T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 5): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * 一条内存"网段"：publish 往上挂一条记录，browse 立刻收到已经在上面的所有记录，
 * 之后有新的也推过去。多播的语义就这么多——够测"同 key 互见、异 key 不见"。
 */
function createLanBus() {
  const records: MdnsPeer[] = []
  const listeners: ((peer: MdnsPeer) => void)[] = []
  return {
    records,
    mdnsFor(host: string): Mdns {
      const mine: MdnsPeer[] = []
      const subs: ((peer: MdnsPeer) => void)[] = []
      return {
        publish(advert) {
          const row: MdnsPeer = {
            name: advert.name,
            host,
            port: advert.port,
            txt: { ...advert.txt },
          }
          mine.push(row)
          records.push(row)
          for (const l of listeners) l(row)
        },
        browse(onPeer) {
          subs.push(onPeer)
          listeners.push(onPeer)
          for (const row of records) onPeer(row)
        },
        stop() {
          for (const row of mine.splice(0)) {
            const at = records.indexOf(row)
            if (at >= 0) records.splice(at, 1)
          }
          for (const sub of subs.splice(0)) {
            const at = listeners.indexOf(sub)
            if (at >= 0) listeners.splice(at, 1)
          }
        },
      }
    },
  }
}

const servers: Server[] = []

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

/** 起一台"机器"：自己的工作区、自己的 owner、挂在同一条内存网段上。 */
async function machine(input: {
  lan: ReturnType<typeof createLanBus>
  host: string
  ownerEmail: string
  seed?: number
  clock?: ReturnType<typeof makeClock>
}): Promise<{
  server: Server
  call: (
    method: string,
    path: string,
    options?: { body?: unknown; anonymous?: boolean },
  ) => Promise<Response>
}> {
  const server = await createServer({
    clock: input.clock ?? makeClock(),
    random: seeded(input.seed ?? 5),
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: input.ownerEmail },
    mdns: () => ({ mdns: input.lan.mdnsFor(input.host) }),
    // 机器之间的 HTTP：直接喂给对方的网关（同一条路由、同一套校验）
    discoveryPost: async (url, body) => {
      const target = servers.find((s) => url.includes(`//${hostOf(s)}:`))
      if (target === undefined) return { ok: false }
      const res = await target.gateway.fetch(
        new Request(url.replace(/^http:\/\/[^/]+/, 'http://127.0.0.1'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      )
      const parsed = (await res.json()) as { data?: unknown }
      return { ok: res.ok, ...(parsed.data === undefined ? {} : { data: parsed.data }) }
    },
    discoveryHello: async (url) => {
      const target = servers.find((s) => url.includes(`//${hostOf(s)}:`))
      if (target === undefined) return undefined
      const res = await target.gateway.fetch(new Request('http://127.0.0.1/v1/discovery/hello'))
      const parsed = (await res.json()) as { data?: { peer_id: string; workspace_label: string } }
      return parsed.data as never
    },
  })
  hosts.set(server, input.host)
  servers.push(server)
  return {
    server,
    call: (method, path, options = {}) => {
      const headers = new Headers()
      if (options.anonymous !== true) {
        headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
        headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
      }
      if (options.body !== undefined) headers.set('content-type', 'application/json')
      return server.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        }),
      )
    },
  }
}

const hosts = new Map<Server, string>()
const hostOf = (s: Server): string => hosts.get(s) ?? '?'

const data = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: T; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data
}

/* ── 46 §2 I1：归一化（纯函数，表驱动）───────────────────────────────── */

describe('46 §2 I1 公司名归一化', () => {
  const SAME: [string, string, string][] = [
    ['多打的空格', '诺伏特科技', '诺 伏 特 科 技'],
    ['"有限公司"尾缀', '深圳诺伏特科技', '深圳诺伏特科技有限公司'],
    ['"股份有限公司"尾缀', '深圳诺伏特科技', '深圳诺伏特科技股份有限公司'],
    ['全角括号与字母', 'NordVolt', 'ＮｏｒｄＶｏｌｔ'],
    ['大小写', 'nordvolt gear', 'NordVolt Gear'],
    ['Co., Ltd.', 'NordVolt', 'NordVolt Co., Ltd.'],
    ['Inc.', 'NordVolt', 'NordVolt, Inc.'],
    ['LLC', 'NordVolt', 'NordVolt LLC'],
    ['Limited', 'NordVolt', 'NordVolt Limited'],
    ['Pte Ltd', 'NordVolt', 'NordVolt Pte. Ltd.'],
    ['连字符', 'NordVolt Gear', 'NordVolt-Gear'],
    ['表意空格', '诺伏特科技', '诺伏特　科技'],
    ['两种尾缀叠着', '诺伏特', '诺伏特集团有限公司'.replace('集团', '')],
  ]
  for (const [why, a, b] of SAME) {
    it(`${why}：归一化后是同一个`, () => {
      expect(normalizeCompanyName(a)).toBe(normalizeCompanyName(b))
    })
  }

  const DIFFERENT: [string, string, string][] = [
    ['不同公司', '诺伏特科技', '诺伏特食品'],
    ['行业词不剥', '诺伏特科技', '诺伏特'],
    ['短词不当尾缀剥', 'Visa', 'Vi'],
    ['名字就叫公司', '公司', '有限公司'],
  ]
  for (const [why, a, b] of DIFFERENT) {
    it(`${why}：归一化后仍然不同`, () => {
      expect(normalizeCompanyName(a)).not.toBe(normalizeCompanyName(b))
    })
  }

  it('域名归一化：协议 / @ / www. / 尾路径一律去掉', () => {
    for (const raw of [
      'nordvolt.cn',
      'NordVolt.CN',
      'https://nordvolt.cn/',
      'www.nordvolt.cn',
      'wang@nordvolt.cn',
      ' nordvolt.cn ',
    ])
      expect(normalizeDomain(raw)).toBe('nordvolt.cn')
    expect(normalizeDomain(undefined)).toBe('')
  })

  it('company_key = sha256(归一化名 | 域名)：名字写法不同、域名相同 → 同一把钥匙', () => {
    const a = companyKey('深圳诺伏特科技有限公司', 'nordvolt.cn')
    const b = companyKey('深圳诺伏特  科技', 'NordVolt.cn')
    expect(a).toBe(b)
    expect(a).toHaveLength(64)
    // 域名不同就不是同一把（强匹配要两样都对上）
    expect(companyKey('深圳诺伏特科技有限公司', 'other.cn')).not.toBe(a)
    // 钥匙里看不出公司名
    expect(a).not.toContain('诺伏特')
  })
})

/* ── 46 §1：首次判定与公司档案 ───────────────────────────────────────── */

describe('46 §1 首次设置', () => {
  it('第一次打开要走向导；填完公司档案就不再弹，且日志里只有哈希', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })

    const before = await data<{ needs_setup: boolean; person: { email: string } }>(
      await m.call('GET', '/v1/onboarding/state'),
    )
    expect(before.needs_setup).toBe(true)
    expect(before.person.email).toBe('wang@nordvolt.cn')

    const profile = await data<{ legal_name: string; domain?: string; discoverable: boolean }>(
      await m.call('PUT', '/v1/workspace/profile', {
        body: { legal_name: '深圳诺伏特科技有限公司', domain: 'nordvolt.cn' },
      }),
    )
    // 46 §1 表：开关默认开
    expect(profile.discoverable).toBe(true)
    expect(profile.domain).toBe('nordvolt.cn')

    const after = await data<{ needs_setup: boolean; profile?: { legal_name: string } }>(
      await m.call('GET', '/v1/onboarding/state'),
    )
    expect(after.needs_setup).toBe(false)
    expect(after.profile?.legal_name).toBe('深圳诺伏特科技有限公司')

    const events = await data<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      await m.call('GET', '/v1/events?types=workspace.profile_set'),
    )
    const set = events.events.find((e) => e.type === 'workspace.profile_set')
    expect(set?.payload.company_key).toBe(companyKey('深圳诺伏特科技有限公司', 'nordvolt.cn'))
    // 21 §5：全称不进日志
    expect(JSON.stringify(set?.payload)).not.toContain('诺伏特')
  })

  it('公司全称是空的 → 400，不落任何东西', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })
    const res = await m.call('PUT', '/v1/workspace/profile', { body: { legal_name: '   ' } })
    expect(res.status).toBe(400)
    const state = await data<{ needs_setup: boolean }>(await m.call('GET', '/v1/onboarding/state'))
    expect(state.needs_setup).toBe(true)
  })
})

/* ── 46 §3：勾选 → 清单 → 真建分配 ──────────────────────────────────── */

interface PlanView {
  connectors: { service: string; required: boolean; connected: boolean; needed_by: string[] }[]
  skills: { name: string; installed: boolean }[]
  positions: { position_id: string; name: string; role_ids: string[] }[]
  model_configured: boolean
  model_first: boolean
  role_ids: string[]
}

describe('46 §3 岗位与职责 → 清单', () => {
  it('勾岗位 = 该岗位职责全勾；连接与技能去重汇总；模型没接时排第一条', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })

    const positions = await data<{ id: string; roles: { id: string; what_it_does: string }[] }[]>(
      await m.call('GET', '/v1/onboarding/positions'),
    )
    const support = positions.find((p) => p.id === 'dtc-support')
    expect(support?.roles.map((r) => r.id)).toContain('dtc.aftersales')
    // 46 §1 表 ③：每条职责旁有一句"它会干什么"
    expect(support?.roles.find((r) => r.id === 'dtc.aftersales')?.what_it_does).toContain('退款')

    const plan = await data<PlanView>(
      await m.call('POST', '/v1/onboarding/plan', { body: { position_ids: ['dtc-support'] } }),
    )
    // 勾岗位 = 模板里的职责全进来（不只是默认包）
    expect(plan.role_ids).toEqual(expect.arrayContaining(['dtc.aftersales', 'common.member']))
    // dtc.aftersales 要邮箱与 Shopify，两条都 required
    const services = plan.connectors.map((c) => c.service)
    expect(services).toContain('shopify_admin')
    expect(services).toContain('imap_smtp')
    expect(plan.connectors.every((c) => !c.connected)).toBe(true)
    expect(plan.skills.map((s) => s.name)).toContain('customer-care')
    // 一个职责被两个岗位要 → 连接只出现一次
    expect(new Set(services).size).toBe(services.length)
    expect(plan.model_first).toBe(true)
    expect(plan.model_configured).toBe(false)
  })

  it('只勾职责 → 一个自定义岗位；名字不给就是"我的岗位"', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })
    const plan = await data<PlanView>(
      await m.call('POST', '/v1/onboarding/plan', { body: { role_ids: ['dtc.aftersales'] } }),
    )
    expect(plan.positions).toEqual([
      {
        position_id: 'custom',
        name: '我的岗位',
        role_ids: ['dtc.aftersales'],
        already_held: false,
      },
    ])

    const named = await data<PlanView>(
      await m.call('POST', '/v1/onboarding/plan', {
        body: { role_ids: ['dtc.aftersales'], custom_position_name: '一个人全干' },
      }),
    )
    expect(named.positions[0]?.name).toBe('一个人全干')
  })

  it('apply 真建分配：一条职责一条 Assignment；再来一次不重复建', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })
    const applied = await data<{
      created_assignments: { role_id: string }[]
      skipped: string[]
      ranges: { id: string }[]
    }>(await m.call('POST', '/v1/onboarding/apply', { body: { position_ids: ['dtc-support'] } }))
    expect(applied.created_assignments.map((a) => a.role_id)).toContain('dtc.aftersales')
    // 46 I6：一家 Shopify 都没连 → 范围挂空（面板照 05 §4 明说"查不到东西"）
    expect(applied.ranges).toEqual([])

    const again = await data<{ created_assignments: unknown[]; skipped: string[] }>(
      await m.call('POST', '/v1/onboarding/apply', { body: { position_ids: ['dtc-support'] } }),
    )
    expect(again.created_assignments).toEqual([])
    expect(again.skipped).toContain('dtc.aftersales')
  })

  it('没这个岗位 → 404；plan 不写任何东西', async () => {
    const lan = createLanBus()
    const m = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })
    expect(
      (await m.call('POST', '/v1/onboarding/plan', { body: { position_ids: ['nope'] } })).status,
    ).toBe(404)
  })
})

/* ── 46 §2 I2：局域网发现 ────────────────────────────────────────────── */

interface PeersView {
  available: boolean
  enabled: boolean
  reason?: string
  peers: { peer_id: string; workspace_label: string; host: string; port: number }[]
}

describe('46 §2 I2 局域网发现', () => {
  it('同一把钥匙互相看见；TXT 里只有哈希与版本，没有公司名', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', seed: 3 })
    const b = await machine({ lan, host: '10.0.0.2', ownerEmail: 'li@nordvolt.cn', seed: 9 })
    // 两个人写法不同：一个写全称，一个多打了空格还加了"有限公司"
    await a.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '深圳诺伏特科技', domain: 'nordvolt.cn' },
    })
    await b.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '深圳诺伏特  科技 有限公司', domain: 'NordVolt.cn' },
    })

    const seen = await data<PeersView>(await a.call('GET', '/v1/discovery/peers'))
    expect(seen.available).toBe(true)
    expect(seen.enabled).toBe(true)
    expect(seen.peers).toHaveLength(1)
    // 展示名是对方 `/v1/discovery/hello` 自己报的（owner 名 + 人数）
    expect(seen.peers[0]?.workspace_label).toContain('1 人')

    // 广播包里只有 k / v 两个键
    for (const row of lan.records) expect(Object.keys(row.txt).sort()).toEqual(['k', 'v'])
    expect(JSON.stringify(lan.records)).not.toContain('诺伏特')
  })

  it('钥匙不同的邻居看不见（同一个网段上的另一家公司）', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', seed: 3 })
    const c = await machine({ lan, host: '10.0.0.3', ownerEmail: 'zhao@other.cn', seed: 11 })
    await a.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '深圳诺伏特科技', domain: 'nordvolt.cn' },
    })
    await c.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '另一家公司', domain: 'other.cn' },
    })
    const seen = await data<PeersView>(await a.call('GET', '/v1/discovery/peers'))
    expect(seen.peers).toEqual([])
  })

  it('开关关掉 = 不广播不监听，记一条 discovery.disabled', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', seed: 3 })
    const b = await machine({ lan, host: '10.0.0.2', ownerEmail: 'li@nordvolt.cn', seed: 9 })
    await a.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '诺伏特', domain: 'nordvolt.cn' },
    })
    await b.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '诺伏特', domain: 'nordvolt.cn' },
    })
    expect((await data<PeersView>(await a.call('GET', '/v1/discovery/peers'))).peers).toHaveLength(
      1,
    )

    await a.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '诺伏特', domain: 'nordvolt.cn', discoverable: false },
    })
    const off = await data<PeersView>(await a.call('GET', '/v1/discovery/peers'))
    expect(off.enabled).toBe(false)
    expect(off.peers).toEqual([])
    // 自己也不再挂在网段上
    expect(lan.records.some((r) => r.host === '10.0.0.1')).toBe(false)

    const events = await data<{ events: { type: string }[] }>(
      await a.call('GET', '/v1/events?types=discovery.enabled,discovery.disabled'),
    )
    expect(events.events.map((e) => e.type)).toEqual(['discovery.enabled', 'discovery.disabled'])
  })

  it('mDNS 起不来：降级成"局域网发现不可用"，不报错', async () => {
    const server = await createServer({
      clock: makeClock(),
      random: seeded(),
      quiet: true,
      startRun: false,
      tokenRefreshIntervalMs: 0,
      mdns: () => ({ reason: '这台机器没有可用网卡' }),
    })
    servers.push(server)
    const res = await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/discovery/peers', {
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': server.bootstrap.ownerAssignment.id,
        },
      }),
    )
    expect(res.status).toBe(200)
    const view = await data<PeersView>(res)
    expect(view.available).toBe(false)
    expect(view.reason).toBe('这台机器没有可用网卡')
  })
})

/* ── 46 §2 I2 / I3：邀请码与申请加入 ─────────────────────────────────── */

interface RequestView {
  id: string
  status: string
  via: string
  approval_item_id?: string
  superseded_reason?: string
}

const membershipCard = async (
  m: { call: (method: string, path: string, o?: { body?: unknown }) => Promise<Response> },
  id: string,
): Promise<ApprovalItem | undefined> => {
  const items = await data<ApprovalItem[]>(await m.call('GET', '/v1/approvals?lane=mine'))
  return items.find(
    (i) => i.kind === 'membership' && (i.payload as { request_id?: string }).request_id === id,
  )
}

describe('46 §2 邀请码与申请加入', () => {
  it('邀请码 8 位、24h、默认 5 次；贴码 → 目标收一张 membership 卡 → 批了才建成员', async () => {
    const lan = createLanBus()
    const clock = makeClock()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', clock })
    await a.call('PUT', '/v1/workspace/profile', {
      body: { legal_name: '诺伏特', domain: 'nordvolt.cn' },
    })
    const invite = await data<{ code: string; expires_at: string; uses_left: number }>(
      await a.call('POST', '/v1/invites'),
    )
    expect(invite.code).toHaveLength(8)
    expect(invite.uses_left).toBe(5)
    expect(Date.parse(invite.expires_at) - Date.parse(T0)).toBe(24 * 60 * 60 * 1000)
    // 码不含形近字
    expect(/^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{8}$/.test(invite.code)).toBe(true)

    const request = await data<RequestView>(
      await a.call('POST', '/v1/memberships/requests', {
        body: { code: invite.code, name: '李默', email: 'li@nordvolt.cn' },
      }),
    )
    expect(request.status).toBe('pending')
    expect(request.via).toBe('invite')

    // 14：owner 队列里真的有那张卡，而且只有名字与邮箱
    const card = await membershipCard(a, request.id)
    expect(card).toBeDefined()
    expect(card?.title).toContain('李默')
    const cardPerson = (card?.payload as { person: object } | undefined)?.person ?? {}
    expect(Object.keys(cardPerson).sort()).toEqual(['email', 'name'])

    // 还没批 → 还不是成员
    const before = await data<{ person_id: string }[]>(
      await a.call('GET', `/v1/workspaces/${a.server.bootstrap.workspace.id}/members`),
    )
    expect(before).toHaveLength(1)

    const decided = await data<RequestView>(
      await a.call('POST', `/v1/memberships/requests/${request.id}/decide`, {
        body: { approve: true },
      }),
    )
    expect(decided.status).toBe('approved')
    const after = await data<{ email: string }[]>(
      await a.call('GET', `/v1/workspaces/${a.server.bootstrap.workspace.id}/members`),
    )
    expect(after.map((m) => m.email)).toContain('li@nordvolt.cn')

    const events = await data<{ events: { type: string; payload: Record<string, unknown> }[] }>(
      await a.call(
        'GET',
        '/v1/events?types=invite.created,invite.redeemed,membership.requested,membership.approved',
      ),
    )
    expect(events.events.map((e) => e.type)).toEqual([
      'invite.created',
      'invite.redeemed',
      'membership.requested',
      'membership.approved',
    ])
    // 明文码不进日志，只有指纹
    expect(JSON.stringify(events.events)).not.toContain(invite.code)

    /*
     * 20 §4：人进来了，下一步交给 Join。**WP52 起这不再只是一句话**——
     * 批准那一刻就真调了 WP50 的 `join.import`，owner 的队列里当场多一张
     * `join_mapping` 卡，事件里带着它的 id。
     */
    const approved = events.events.at(-1)?.payload
    expect(approved?.next).toBe('join_import')
    expect(approved?.join_id).toMatch(/^join_/)
    const cardId = approved?.join_approval_item_id
    expect(typeof cardId).toBe('string')
    expect(approved?.join_error).toBeUndefined()

    const joinCard = await data<{ kind: string; state: string; role_id: string }>(
      await a.call('GET', `/v1/approvals/${String(cardId)}`),
    )
    expect([joinCard.kind, joinCard.state]).toEqual(['join_mapping', 'pending'])
    // 这张卡是给 owner 的（合并组织结构是 owner 的事，14）
    expect(joinCard.role_id).toBe('common.owner')

    // 包是空的：这会儿我们只知道"该并了"，还不知道他那边有什么（46 §4）
    const mapping = await data<{ objects: unknown[]; counts: Record<string, number> }>(
      await a.call('GET', `/v1/join/${String(approved?.join_id)}`),
    )
    expect(mapping.objects).toEqual([])
  })

  it('Join 没装配时退回老路：只记一条 next: join_import，批准照样成立', async () => {
    // 不经服务进程，直接装一份**没有 `join`** 的 invites——与"这个服务进程没装 Join"等价
    const events: { type: string; payload: Record<string, unknown> }[] = []
    const created: string[] = []
    const invites = createInvites({
      clock: makeClock(),
      random: seeded(3),
      workspace_id: 'ws_a',
      owner: 'per_owner',
      appendEvent: (e) => {
        events.push({ type: e.type, payload: e.payload as Record<string, unknown> })
      },
      roles: {
        roles: { get: () => undefined },
        assignments: { listByPerson: () => [], create: () => undefined },
      } as unknown as Parameters<typeof createInvites>[0]['roles'],
      approvals: {
        create: async (input: { kind: string }) => {
          created.push(input.kind)
          return { id: 'ap_1', state: 'pending' }
        },
      } as unknown as Parameters<typeof createInvites>[0]['approvals'],
      identity: {
        personByEmail: () => undefined,
        createPerson: async () => ({ id: 'per_new' }),
        addMember: async () => undefined,
      },
      members: async () => [],
      companyKey: () => 'key',
      peerId: () => 'a',
      peerAddress: () => undefined,
      peerIds: () => [],
    })
    try {
      const request = await invites.request({
        code: invites.create('per_owner').code,
        name: '李工',
        email: 'li@nordvolt.cn',
      })
      const decided = await invites.decide('per_owner', request.id, { approve: true })
      expect(decided.status).toBe('approved')

      const approved = events.find((e) => e.type === 'membership.approved')
      expect(approved?.payload.next).toBe('join_import')
      // 没装 Join：不编一个 join_id，也不报错
      expect(approved?.payload.join_id).toBeUndefined()
      expect(approved?.payload.join_error).toBeUndefined()
      // 只有那张 membership 卡，没有 join_mapping
      expect(created).toEqual(['membership'])
    } finally {
      invites.close()
    }
  })

  it('码过期 / 用完了一律 404（不区分，免得拿它探测）', async () => {
    const lan = createLanBus()
    const clock = makeClock()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', clock })
    await a.call('PUT', '/v1/workspace/profile', { body: { legal_name: '诺伏特' } })
    const invite = await data<{ code: string }>(
      await a.call('POST', '/v1/invites', { body: { uses: 1 } }),
    )
    await a.call('POST', '/v1/memberships/requests', {
      body: { code: invite.code, name: '李默', email: 'li@nordvolt.cn' },
    })
    // 用完了
    expect(
      (
        await a.call('POST', '/v1/memberships/requests', {
          body: { code: invite.code, name: '赵宁', email: 'zhao@nordvolt.cn' },
        })
      ).status,
    ).toBe(404)
    // 过期了
    const second = await data<{ code: string }>(await a.call('POST', '/v1/invites'))
    clock.advance(25 * 60 * 60 * 1000)
    expect(
      (
        await a.call('POST', '/v1/memberships/requests', {
          body: { code: second.code, name: '赵宁', email: 'zhao@nordvolt.cn' },
        })
      ).status,
    ).toBe(404)
  })

  it('拒绝：不建人、不建成员，记一条 membership.rejected', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn' })
    await a.call('PUT', '/v1/workspace/profile', { body: { legal_name: '诺伏特' } })
    const invite = await data<{ code: string }>(await a.call('POST', '/v1/invites'))
    const request = await data<RequestView>(
      await a.call('POST', '/v1/memberships/requests', {
        body: { code: invite.code, name: '陌生人', email: 'x@elsewhere.com' },
      }),
    )
    const decided = await data<RequestView>(
      await a.call('POST', `/v1/memberships/requests/${request.id}/decide`, {
        body: { approve: false, reason: '不认识这个人' },
      }),
    )
    expect(decided.status).toBe('rejected')
    const members = await data<{ email: string }[]>(
      await a.call('GET', `/v1/workspaces/${a.server.bootstrap.workspace.id}/members`),
    )
    expect(members.map((m) => m.email)).not.toContain('x@elsewhere.com')
    // 同一条不能定两次
    expect(
      (
        await a.call('POST', `/v1/memberships/requests/${request.id}/decide`, {
          body: { approve: true },
        })
      ).status,
    ).toBe(409)
  })

  it('局域网那条路：挑一位同伴申请 → 对方 owner 收卡 → 批了成为他那边的成员', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', seed: 3 })
    const b = await machine({ lan, host: '10.0.0.2', ownerEmail: 'li@nordvolt.cn', seed: 9 })
    for (const m of [a, b])
      await m.call('PUT', '/v1/workspace/profile', {
        body: { legal_name: '深圳诺伏特科技有限公司', domain: 'nordvolt.cn' },
      })
    const peers = await data<PeersView>(await b.call('GET', '/v1/discovery/peers'))
    const target = peers.peers[0]
    expect(target).toBeDefined()

    const request = await data<RequestView>(
      await b.call('POST', '/v1/memberships/requests', {
        body: { peer_id: target?.peer_id, name: '李默', email: 'li@nordvolt.cn' },
      }),
    )
    expect(request.via).toBe('lan')

    // 卡在 A 那边（目标工作区），不在 B 这边
    expect(await membershipCard(a, request.id)).toBeDefined()
    await a.call('POST', `/v1/memberships/requests/${request.id}/decide`, {
      body: { approve: true },
    })
    const members = await data<{ email: string }[]>(
      await a.call('GET', `/v1/workspaces/${a.server.bootstrap.workspace.id}/members`),
    )
    expect(members.map((m) => m.email)).toContain('li@nordvolt.cn')

    // WP52：局域网这条路同样接 Join——A 的 owner 队列里多一张 join_mapping 卡
    const joins = await data<{ join_id: string }[]>(await a.call('GET', '/v1/join'))
    expect(joins).toHaveLength(1)
  })

  it('46 I3 两边互相申请：先批的那一边为准，另一边自动失效并说清为什么', async () => {
    const lan = createLanBus()
    const a = await machine({ lan, host: '10.0.0.1', ownerEmail: 'wang@nordvolt.cn', seed: 3 })
    const b = await machine({ lan, host: '10.0.0.2', ownerEmail: 'li@nordvolt.cn', seed: 9 })
    for (const m of [a, b])
      await m.call('PUT', '/v1/workspace/profile', {
        body: { legal_name: '诺伏特', domain: 'nordvolt.cn' },
      })
    const aSees = await data<PeersView>(await a.call('GET', '/v1/discovery/peers'))
    const bSees = await data<PeersView>(await b.call('GET', '/v1/discovery/peers'))

    // 两边同时申请加入对方
    const fromA = await data<RequestView>(
      await a.call('POST', '/v1/memberships/requests', {
        body: { peer_id: aSees.peers[0]?.peer_id, name: '王岚', email: 'wang@nordvolt.cn' },
      }),
    )
    const fromB = await data<RequestView>(
      await b.call('POST', '/v1/memberships/requests', {
        body: { peer_id: bSees.peers[0]?.peer_id, name: '李默', email: 'li@nordvolt.cn' },
      }),
    )

    // A 先批了 B 的申请 → B 并进 A
    await a.call('POST', `/v1/memberships/requests/${fromB.id}/decide`, { body: { approve: true } })

    // B 那边收到的那条（A 申请加入 B）自动失效
    const onB = await data<RequestView[]>(await b.call('GET', '/v1/memberships/requests'))
    const stale = onB.find((r) => r.id === fromA.id)
    expect(stale?.status).toBe('superseded')
    expect(stale?.superseded_reason).toBeTruthy()
    // 失效的那条不能再批
    expect(
      (
        await b.call('POST', `/v1/memberships/requests/${fromA.id}/decide`, {
          body: { approve: true },
        })
      ).status,
    ).toBe(409)
  })
})
