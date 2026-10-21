/**
 * WP427：同事互联 / 公司模式在**两台电脑**上真能连上——本机起两个真服务进程模拟两台电脑
 * （不同端口、不同数据目录、各自的身份库），中间只有真 HTTP。
 *
 * - 「不在同一个网络」那条路：A 拨一条长连接到云端替身（`team-relay.ts`，照私有云同一份契约），
 *   B 贴码 → 问云这是谁的码 → 经云递申请 → A 同意 → B 拿票换一次性登录 → 经云进 A 的工作区干活。
 *   一路走完：个人 → 邀请同事 → 对方申请、这边同意 → 交给对方一件事 → 对方接下 → 开公司模式 →
 *   设主管 → 审批流转一次。
 * - 「同一个局域网」那条路：局域网发现换成内存总线（只有多播那一跳是替身），申请与登录真走
 *   A 那扇「团队门」的端口。
 * - 门的边界：本机档那几条「按邮箱直接给 token」的路由，从门外带着会话也进不去。
 *
 * 端口段 4591–4594（A 4591、B 4592、云端替身 4593、A 的局域网那扇门 4594）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import type { Mdns, MdnsAdvert, MdnsFactory, MdnsPeer } from '../src/discovery.js'
import { createServer, type Server } from '../src/index.js'
import { startTeamRelayStandIn, type TeamRelayStandIn } from '../src/team-relay.js'

const A_PORT = 4591
const B_PORT = 4592
const RELAY_PORT = 4593
const A_DOOR = 4594

/** 局域网多播的内存总线：两个服务进程在同一个「网段」上。 */
function lanBus(): MdnsFactory {
  const adverts: MdnsAdvert[] = []
  const browsers: ((peer: MdnsPeer) => void)[] = []
  const asPeer = (a: MdnsAdvert): MdnsPeer => ({
    name: a.name,
    host: '127.0.0.1',
    port: a.port,
    txt: a.txt,
  })
  return () => {
    const mine: MdnsAdvert[] = []
    const myBrowsers: ((peer: MdnsPeer) => void)[] = []
    const mdns: Mdns = {
      publish(advert) {
        mine.push(advert)
        adverts.push(advert)
        for (const b of browsers) b(asPeer(advert))
      },
      browse(onPeer) {
        myBrowsers.push(onPeer)
        browsers.push(onPeer)
        for (const a of adverts) onPeer(asPeer(a))
      },
      stop() {
        for (const a of mine.splice(0)) adverts.splice(adverts.indexOf(a), 1)
        for (const b of myBrowsers.splice(0)) browsers.splice(browsers.indexOf(b), 1)
      },
    }
    return { mdns }
  }
}

interface Machine {
  server: Server
  dir: string
  base: string
}

const machines: Machine[] = []
let relay: TeamRelayStandIn | undefined

afterEach(async () => {
  for (const m of machines.splice(0)) {
    await m.server.close()
    rmSync(m.dir, { recursive: true, force: true })
  }
  await relay?.close()
  relay = undefined
})

async function machine(
  label: string,
  port: number,
  team: NonNullable<Parameters<typeof createServer>[0]>['team'],
  mdns?: MdnsFactory,
): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `wp427-${label}-`))
  const server = await createServer({
    dbDir: dir,
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_WORKSPACE_NAME: `${label} 的品牌` },
    team,
    mdns: mdns ?? (() => ({ reason: '这一条不走局域网发现' })),
  })
  await server.listen(port)
  const m = { server, dir, base: `http://127.0.0.1:${String(port)}` }
  machines.push(m)
  return m
}

/** 以这台电脑主人的身份打它自己的 API（本机回环口 + 内部令牌，就像桌面壳的窗口）。 */
async function own<T>(
  m: Machine,
  method: string,
  path: string,
  body?: unknown,
  assignment?: string,
): Promise<{ status: number; data: T; message?: string }> {
  const res = await fetch(`${m.base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${m.server.bootstrap.internalToken}`,
      'x-assignment': assignment ?? m.server.bootstrap.ownerAssignment.id,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data: T; message?: string }
  return {
    status: res.status,
    data: parsed.data,
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

/** 同事从他自己的电脑上打对方那扇门（经云或经局域网）。 */
async function remote<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; assignment?: string; body?: unknown } = {},
): Promise<{ status: number; data: T; message?: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...(options.assignment === undefined ? {} : { 'x-assignment': options.assignment }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await res.text()
  const parsed = (text === '' ? {} : JSON.parse(text)) as { data: T; message?: string }
  return {
    status: res.status,
    data: parsed.data,
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

const orgIdOf = (m: Machine): string => {
  const org = m.server.organizations.organizationOf(m.server.bootstrap.workspace.id)
  if (org === undefined) throw new Error('没有组织')
  return org.id
}

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got !== undefined) return got
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** 进门那一下：`<base>/#agentsws-enter=<token>` → 换会话（工作台落地时做的同一件事）。 */
async function enterWith(url: string): Promise<{ base: string; session: string }> {
  const [base, hash] = url.split('/#')
  const token = new URLSearchParams(hash ?? '').get('agentsws-enter')
  if (base === undefined || token === null) throw new Error(`进门地址不对：${url}`)
  const verified = await remote<{ session_token: string }>(base, 'POST', '/v1/auth/verify', {
    body: { token },
  })
  expect(verified.status).toBe(200)
  return { base, session: verified.data.session_token }
}

describe('WP427 不在同一个网络：经工坊云（替身）', () => {
  it('个人 → 邀请同事 → 同意 → 交给对方一件事 → 对方接下 → 开公司模式 → 设主管 → 审批流转一次', async () => {
    relay = await startTeamRelayStandIn({ port: RELAY_PORT })
    const relayBase = relay.base
    // A：发起人。没打开「和同事一起用」之前一扇门都不开、不拨云
    const A = await machine('王岚', A_PORT, {
      lanHost: '127.0.0.1',
      lanPort: A_DOOR,
      cloudBase: relayBase,
      cloudToken: () => 'wst_test_A',
    })
    // B：同事，另一台电脑，没开团队通道（他只是去申请）
    const B = await machine('林峰', B_PORT, {
      lanOff: true,
      cloudBase: relayBase,
      cloudToken: () => undefined,
    })
    expect(await A.server.organizations.modeOf(A.server.bootstrap.workspace.id)).toBe('solo')
    const closed = await own<{ open: boolean; lan: { on: boolean } }>(A, 'GET', '/v1/team/link')
    expect(closed.data).toMatchObject({ open: false, lan: { on: false } })
    expect(relay.online()).toBe(0)

    // ① → 「和同事一起用」：开门、拨云
    expect((await own(A, 'PATCH', `/v1/orgs/${orgIdOf(A)}`, { discoverable: true })).status).toBe(
      200,
    )
    const link = await until('A 的通道连上云', async () => {
      const got = await own<{ cloud: { state: string; url?: string }; invite_base?: string }>(
        A,
        'GET',
        '/v1/team/link',
      )
      return got.data.cloud.state === 'online' ? got.data : undefined
    })
    expect(link.cloud.url).toMatch(/^http:\/\/t[0-9a-f]+-team\.localhost:4593$/)
    expect(link.invite_base).toBe(link.cloud.url)

    // 发一个码：登记到云上
    const invite = await own<{ code: string }>(A, 'POST', '/v1/invites', {})
    expect(invite.status).toBe(201)
    const code = invite.data.code

    // B 贴码：本机没有、局域网里没有 → 问云 → 经云递到 A
    const me = B.server.bootstrap.person
    const sent = await own<{ status: string }>(B, 'POST', '/v1/memberships/requests', {
      code,
      name: '林峰',
      email: me.email,
    })
    expect(sent.status).toBe(201)
    expect(sent.data.status).toBe('pending')
    const waiting = await own<
      { id: string; status: string; via: string; workspace_label: string }[]
    >(B, 'GET', '/v1/team/joins')
    expect(waiting.data).toHaveLength(1)
    expect(waiting.data[0]).toMatchObject({ status: 'pending', via: 'cloud' })
    expect(waiting.data[0]?.workspace_label).toContain('1 人')
    const joinId = waiting.data[0]?.id ?? ''
    // 没同意之前进不去
    expect((await own(B, 'POST', `/v1/team/joins/${joinId}/enter`)).status).toBe(409)

    // A 同意
    const requests = await own<{ id: string; person: { name: string } }[]>(
      A,
      'GET',
      '/v1/memberships/requests',
    )
    const req = requests.data.find((r) => r.person.name === '林峰')
    expect(req).toBeDefined()
    const approved = await own<{ status: string }>(
      A,
      'POST',
      `/v1/memberships/requests/${req?.id}/decide`,
      { approve: true },
    )
    expect(approved.data.status).toBe('approved')
    expect(await A.server.organizations.modeOf(A.server.bootstrap.workspace.id)).toBe('peers')

    // 两台都是占位邮箱（都没关联工坊账号）：B 在 A 那边是另一个人，不是 A 的负责人
    const members = await A.server.identity.members(A.server.bootstrap.workspace.id)
    const lin = members.find((m) => m.person_id !== A.server.bootstrap.person.id)
    expect(lin).toBeDefined()
    const linId = lin?.person_id ?? ''
    expect((await A.server.identity.getPerson(linId))?.name).toBe('林峰')

    // B 看到「同意了」，点「打开」：换一个带一次性登录的地址，浏览器打开就进去了
    const ready = await own<{ status: string; can_enter: boolean }[]>(B, 'GET', '/v1/team/joins')
    expect(ready.data[0]).toMatchObject({ status: 'approved', can_enter: true })
    const entered = await own<{ url: string }>(B, 'POST', `/v1/team/joins/${joinId}/enter`)
    expect(entered.status).toBe(200)
    expect(entered.data.url.startsWith(`${link.cloud.url}/#agentsws-enter=`)).toBe(true)
    const { base, session } = await enterWith(entered.data.url)
    const whoami = await remote<{ person: { id: string; name: string } }>(base, 'GET', '/v1/me', {
      token: session,
    })
    expect(whoami.data.person).toMatchObject({ id: linId, name: '林峰' })
    // 门外拿不到主人邮箱；本机档那几条「直接给 token」的路由带着会话也进不去
    const boot = await remote<unknown>(base, 'GET', '/app/bootstrap.json')
    expect(boot.status).toBe(200)
    const bootRaw = await (await fetch(`${base}/app/bootstrap.json`)).json()
    expect(bootRaw).toEqual({ login: 'shared', team: true })
    for (const [method, path, body] of [
      ['POST', '/v1/auth/magic-link', { email: A.server.bootstrap.person.email }],
      ['POST', '/v1/auth/session', { key: 'x' }],
      ['POST', '/v1/auth/browser-link', { key: 'x' }],
    ] as const) {
      expect((await remote(base, method, path, { token: session, body })).status).toBe(403)
    }
    expect((await remote(base, 'GET', '/v1/me')).status).toBe(401)
    // 内部令牌从门外来也不认（只认会话）
    expect(
      (await remote(base, 'GET', '/v1/me', { token: A.server.bootstrap.internalToken })).status,
    ).toBe(401)

    // 门外来的申请只收不转：不替别的电脑去敲局域网里别人的门、去问云；经云来的只认码
    const asked = { name: '路人', email: 'x@example.com' }
    expect(
      (
        await remote(base, 'POST', '/v1/memberships/requests', {
          body: { ...asked, peer_id: 'peer_x' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await remote(base, 'POST', '/v1/memberships/requests', {
          body: { ...asked, code: 'ZZZZ2222' },
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await remote(base, 'POST', '/v1/memberships/requests', {
          body: { ...asked, company_key: 'k'.repeat(64), from_peer: 'peer_x' },
        })
      ).status,
    ).toBe(404)

    // A 给两人分 B2B，开一件事交给林峰
    const give = async (person_id: string): Promise<string> => {
      const granted = await own<{ assignment_id: string; role_id: string }[]>(
        A,
        'POST',
        '/v1/assignments',
        {
          person_id,
          position_id: 'b2b',
          ranges: [{ kind: 'brand', id: A.server.bootstrap.workspace.id }],
        },
      )
      const sales = granted.data.find((a) => a.role_id === 'b2b.sales')
      if (sales === undefined) throw new Error('没分到 b2b.sales')
      return sales.assignment_id
    }
    const mine = await give(A.server.bootstrap.person.id)
    const linB2b = await give(linId)
    const matter = await own<{ matter: { id: string } }>(
      A,
      'POST',
      '/v1/matters',
      { kind: 'project', title: 'Volthaus 的报价跟进' },
      mine,
    )
    const matterId = matter.data.matter.id
    const offered = await own<{ handoff: { handoff: { state: string } } }>(
      A,
      'POST',
      `/v1/handoffs/matter/${matterId}`,
      { to: linId, note: '这周你跟' },
      mine,
    )
    expect(offered.data.handoff.handoff.state).toBe('offered')

    // 林峰在他自己的电脑上（经云）看到「交给你」，点接下
    const toMe = await remote<{ to_me: { id: string }[] }>(base, 'GET', '/v1/handoffs', {
      token: session,
      assignment: linB2b,
    })
    expect(toMe.data.to_me.map((x) => x.id)).toEqual([matterId])
    const card = (
      (await A.server.txn.approvals.queue({
        workspace_id: A.server.bootstrap.workspace.id,
        person_id: linId,
        lane: 'mine',
      })) as ApprovalItem[]
    ).find((i) => (i.payload as { form?: string }).form === 'handoff')
    expect(card).toBeDefined()
    const took = await remote(base, 'POST', `/v1/approvals/${card?.id}/decide`, {
      token: session,
      assignment: linB2b,
      body: { action: 'approve', selected_option_id: linB2b },
    })
    expect(took.status).toBe(200)
    const after = await remote<{ matter: { position_id: string; handoff: { state: string } } }>(
      base,
      'GET',
      `/v1/matters/${matterId}`,
      { token: session, assignment: linB2b },
    )
    expect(after.data.matter).toMatchObject({
      position_id: linB2b,
      handoff: { state: 'accepted' },
    })

    // 开公司模式（只有发起人能开），设主管：B2B 的上级是王岚
    const opened = await own<{ mode: string }>(A, 'PUT', `/v1/orgs/${orgIdOf(A)}/mode`, {
      mode: 'company',
      legal_name: '深圳伏特豪斯科技有限公司',
    })
    expect(opened.data.mode).toBe('company')
    expect(
      (
        await own(A, 'PUT', '/v1/org/positions/b2b/supervisor', {
          person_id: A.server.bootstrap.person.id,
        })
      ).status,
    ).toBe(200)

    // 林峰（经云）出一张超授权的报价（1.84 万美元、毛利 18.5%）→ ③ 里要主管批 → 落到王岚那里 → 王岚批
    const draft = await remote<{ draft: { id: string } }>(base, 'POST', '/v1/b2b/quotes/drafts', {
      token: session,
      assignment: linB2b,
      body: {
        record: { account_id: 'acc_volthaus' },
        quote_version: {
          lines: [{ sku: 'GAN65', description: '65W GaN', qty: 1000, unit_price_usd: 18.4 }],
          margin_pct: 18.5,
          discount_pct: 0,
          payment_terms_days: 30,
          incoterm: 'FOB',
          valid_until: '2026-12-28',
        },
      },
    })
    expect(draft.message ?? draft.status).toBe(200)
    const staged = await remote<{ approval_item_id?: string }>(
      base,
      'POST',
      `/v1/b2b/quotes/drafts/${draft.data.draft.id}/submit`,
      { token: session, assignment: linB2b },
    )
    expect(staged.message ?? staged.status).toBe(200)
    const quoteCard = (await A.server.txn.approvals.get(
      staged.data.approval_item_id ?? '',
    )) as ApprovalItem
    expect(quoteCard.routing.recipients.map((r) => r.person)).toEqual([
      A.server.bootstrap.person.id,
    ])
    const decided = await own<{ state: string }>(
      A,
      'POST',
      `/v1/approvals/${quoteCard.id}/decide`,
      {
        action: 'approve',
      },
    )
    expect(decided.message ?? decided.status).toBe(200)
    const final = await remote<{ state: string }>(base, 'GET', `/v1/approvals/${quoteCard.id}`, {
      token: session,
      assignment: linB2b,
    })
    expect(final.status).toBe(200)
    expect(['approved', 'applied', 'applying']).toContain(final.data.state)

    // 发起人电脑掉线：同事那边说人话（503），不是挂着
    relay.drop(
      link.cloud.url
        ?.slice('http://'.length)
        .split('.')[0]
        ?.replace(/-team$/, '') ?? '',
    )
    const offline = await fetch(`${base}/v1/me`, {
      headers: { authorization: `Bearer ${session}` },
    })
    expect([502, 503]).toContain(offline.status)
  }, 120_000)
})

describe('WP427 同一个局域网：经团队门直连', () => {
  it('局域网里看见对方 → 申请 → 同意 → 经门登录；门只开在「和同事一起用」打开之后', async () => {
    const bus = lanBus()
    const A = await machine(
      '王岚',
      A_PORT,
      { lanHost: '127.0.0.1', lanPort: A_DOOR, lanOff: false },
      bus,
    )
    const B = await machine('林峰', B_PORT, { lanOff: true }, bus)
    // 没打开之前门那个端口上什么都没有
    await expect(fetch(`http://127.0.0.1:${String(A_DOOR)}/v1/health`)).rejects.toThrow()

    // 两边写同一家公司、都打开「让同事找到我」
    for (const m of [A, B]) {
      expect(
        (
          await own(m, 'PATCH', `/v1/orgs/${orgIdOf(m)}`, {
            legal_name: '深圳伏特豪斯科技有限公司',
            discoverable: true,
          })
        ).status,
      ).toBe(200)
    }
    const door = await until('A 的门开了', async () => {
      const got = await own<{ lan: { on: boolean } }>(A, 'GET', '/v1/team/link')
      return got.data.lan.on ? got.data : undefined
    })
    expect(door.lan.on).toBe(true)
    // 门上公开的只有那几条
    expect((await fetch(`http://127.0.0.1:${String(A_DOOR)}/v1/health`)).status).toBe(200)

    // B 在局域网里看见 A（广播报的是门的端口，问「你是谁」也走门）
    const seen = await until('B 看见 A', async () => {
      const got = await own<{
        peers: { peer_id: string; port: number; workspace_label: string }[]
      }>(B, 'GET', '/v1/discovery/peers')
      const a = got.data.peers.find((p) => p.port === A_DOOR)
      return a?.workspace_label.includes('人') === true ? a : undefined
    })
    const sent = await own<{ status: string }>(B, 'POST', '/v1/memberships/requests', {
      peer_id: seen.peer_id,
      name: '林峰',
      email: B.server.bootstrap.person.email,
    })
    expect(sent.status).toBe(201)
    const joins = await own<{ id: string; via: string }[]>(B, 'GET', '/v1/team/joins')
    expect(joins.data[0]?.via).toBe('lan')

    const req = (await own<{ id: string }[]>(A, 'GET', '/v1/memberships/requests')).data[0]
    await own(A, 'POST', `/v1/memberships/requests/${req?.id}/decide`, { approve: true })
    const entered = await own<{ url: string }>(
      B,
      'POST',
      `/v1/team/joins/${joins.data[0]?.id}/enter`,
    )
    expect(entered.data.url.startsWith(`http://127.0.0.1:${String(A_DOOR)}/#agentsws-enter=`)).toBe(
      true,
    )
    const { base, session } = await enterWith(entered.data.url)
    const whoami = await remote<{ person: { name: string } }>(base, 'GET', '/v1/me', {
      token: session,
    })
    expect(whoami.data.person.name).toBe('林峰')
    // 实时推送（WebSocket）也经门：带会话能连上，不带被拒
    const opened = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(A_DOOR)}/v1/ws`, [
        'agentsws.v1',
        `agentsws.bearer.${session}`,
      ])
      ws.addEventListener('open', () => {
        ws.close()
        resolve(true)
      })
      ws.addEventListener('error', () => resolve(false))
    })
    expect(opened).toBe(true)
    const refused = await new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(A_DOOR)}/v1/ws`, ['agentsws.v1'])
      ws.addEventListener('open', () => {
        ws.close()
        resolve(false)
      })
      ws.addEventListener('error', () => resolve(true))
    })
    expect(refused).toBe(true)
    // 票只能换给批过的那个人：拿错票问一律 404
    const wrong = await remote(base, 'POST', `/v1/memberships/requests/${req?.id}/claim`, {
      body: { ticket: 'x'.repeat(32), login: true },
    })
    expect(wrong.status).toBe(404)

    // 关掉开关：已经有同事了，门照旧开着（同事还要连进来）
    await own(A, 'PATCH', `/v1/orgs/${orgIdOf(A)}`, { discoverable: false })
    const still = await own<{ open: boolean; lan: { on: boolean } }>(A, 'GET', '/v1/team/link')
    expect(still.data).toMatchObject({ open: true, lan: { on: true } })
  }, 120_000)
})
