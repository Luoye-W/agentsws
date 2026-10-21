/**
 * WP435：两个真服务进程经**真的工坊云**（不是 `team-relay.ts` 替身）走一遍团队通道——
 * 申请 → 同意 → 打开 → 交接。
 *
 * 平时跳过：要先起一个云（私有云仓本机 `wrangler dev`，或者测试环境），再给三个环境变量：
 *
 * - `AGENTSWS_TEAM_E2E_CLOUD_URL`：云的控制面地址（例如 `http://127.0.0.1:4632`）；
 * - `AGENTSWS_TEAM_E2E_TOKEN`：发起人那台用的工作区令牌（`wst_…`，那个云签的）；
 * - `AGENTSWS_TEAM_E2E_PORTS`：两台「电脑」的端口（默认 `4634,4635`）。
 *
 * 云回的通道地址（`http://<id>-team.localhost:<端口>` / `https://<id>-team.agentsws.com`）要这台机器打得通。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem } from '@agentsws/contracts'
import { afterAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const CLOUD = process.env.AGENTSWS_TEAM_E2E_CLOUD_URL?.replace(/\/+$/, '')
const TOKEN = process.env.AGENTSWS_TEAM_E2E_TOKEN
const [A_PORT, B_PORT] = (process.env.AGENTSWS_TEAM_E2E_PORTS ?? '4634,4635')
  .split(',')
  .map((p) => Number(p.trim()))

interface Machine {
  server: Server
  dir: string
  base: string
}
const machines: Machine[] = []

afterAll(async () => {
  for (const m of machines.splice(0)) {
    await m.server.close()
    rmSync(m.dir, { recursive: true, force: true })
  }
})

async function machine(
  label: string,
  port: number,
  team: NonNullable<Parameters<typeof createServer>[0]>['team'],
): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `wp435-${label}-`))
  const server = await createServer({
    dbDir: dir,
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_WORKSPACE_NAME: `${label} 的品牌` },
    team,
    mdns: () => ({ reason: '这一条不走局域网发现' }),
  })
  await server.listen(port)
  const m = { server, dir, base: `http://127.0.0.1:${String(port)}` }
  machines.push(m)
  return m
}

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
    ...(parsed.message ? { message: parsed.message } : {}),
  }
}

async function remote<T>(
  base: string,
  method: string,
  path: string,
  options: { token?: string; assignment?: string; body?: unknown } = {},
): Promise<{ status: number; data: T }> {
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
  const type = res.headers.get('content-type') ?? ''
  const parsed = (type.includes('json') && text !== '' ? JSON.parse(text) : {}) as { data: T }
  return { status: res.status, data: parsed.data }
}

async function until<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  ms = 20_000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const got = await probe()
    if (got !== undefined) return got
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((r) => setTimeout(r, 200))
  }
}

describe.skipIf(CLOUD === undefined || TOKEN === undefined)('WP435 经真的工坊云', () => {
  it('申请 → 同意 → 打开 → 交接；发起人掉线后同事那边是 503 人话', async () => {
    const cloudBase = CLOUD as string
    const A = await machine('发起人', A_PORT as number, {
      lanOff: true,
      cloudBase,
      cloudToken: () => TOKEN,
    })
    const B = await machine('同事', B_PORT as number, {
      lanOff: true,
      cloudBase,
      cloudToken: () => undefined,
    })
    const org = A.server.organizations.organizationOf(A.server.bootstrap.workspace.id)
    expect((await own(A, 'PATCH', `/v1/orgs/${org?.id}`, { discoverable: true })).status).toBe(200)
    const link = await until('发起人的通道连上云', async () => {
      const got = await own<{ cloud: { state: string; url?: string } }>(A, 'GET', '/v1/team/link')
      return got.data.cloud.state === 'online' ? got.data : undefined
    })
    expect(link.cloud.url).toMatch(/^https?:\/\/[a-z0-9]+-team\./)
    const tunnelUrl = link.cloud.url as string

    // 申请：B 贴码 → 问云 → 经云递到 A
    const invite = await own<{ code: string }>(A, 'POST', '/v1/invites', {})
    expect(invite.status).toBe(201)
    const sent = await own<{ status: string }>(B, 'POST', '/v1/memberships/requests', {
      code: invite.data.code,
      name: '同事乙',
      email: B.server.bootstrap.person.email,
    })
    expect(sent.status).toBe(201)
    const joins = await own<{ id: string; via: string }[]>(B, 'GET', '/v1/team/joins')
    expect(joins.data[0]).toMatchObject({ via: 'cloud' })
    const joinId = joins.data[0]?.id ?? ''

    // 同意
    const requests = await own<{ id: string; person: { name: string } }[]>(
      A,
      'GET',
      '/v1/memberships/requests',
    )
    const req = requests.data.find((r) => r.person.name === '同事乙')
    expect(
      (
        await own<{ status: string }>(A, 'POST', `/v1/memberships/requests/${req?.id}/decide`, {
          approve: true,
        })
      ).data.status,
    ).toBe('approved')

    // 打开：换带一次性登录的地址（就是浏览器要打开的那个），经云进 A 的工作区
    const entered = await own<{ url: string }>(B, 'POST', `/v1/team/joins/${joinId}/enter`)
    expect(entered.status).toBe(200)
    expect(entered.data.url.startsWith(`${tunnelUrl}/#agentsws-enter=`)).toBe(true)
    const token = new URLSearchParams(entered.data.url.split('/#')[1] ?? '').get('agentsws-enter')
    const verified = await remote<{ session_token: string }>(tunnelUrl, 'POST', '/v1/auth/verify', {
      body: { token },
    })
    expect(verified.status).toBe(200)
    const session = verified.data.session_token
    const members = await A.server.identity.members(A.server.bootstrap.workspace.id)
    const linId = members.find((m) => m.person_id !== A.server.bootstrap.person.id)?.person_id ?? ''
    const whoami = await remote<{ person: { id: string } }>(tunnelUrl, 'GET', '/v1/me', {
      token: session,
    })
    expect(whoami.data.person.id).toBe(linId)
    // 门外拿不到主人邮箱（经云来的也是门外）
    const boot = await fetch(`${tunnelUrl}/app/bootstrap.json`)
    expect(await boot.json()).toEqual({ login: 'shared', team: true })

    // 交接：A 开一件事交给同事，同事经云接下
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
    const theirs = await give(linId)
    const matter = await own<{ matter: { id: string } }>(
      A,
      'POST',
      '/v1/matters',
      { kind: 'project', title: '样品报价跟进' },
      mine,
    )
    const matterId = matter.data.matter.id
    expect(
      (
        await own<{ handoff: { handoff: { state: string } } }>(
          A,
          'POST',
          `/v1/handoffs/matter/${matterId}`,
          { to: linId, note: '这周你跟' },
          mine,
        )
      ).data.handoff.handoff.state,
    ).toBe('offered')
    const toMe = await remote<{ to_me: { id: string }[] }>(tunnelUrl, 'GET', '/v1/handoffs', {
      token: session,
      assignment: theirs,
    })
    expect(toMe.data.to_me.map((x) => x.id)).toEqual([matterId])
    const card = (
      (await A.server.txn.approvals.queue({
        workspace_id: A.server.bootstrap.workspace.id,
        person_id: linId,
        lane: 'mine',
      })) as ApprovalItem[]
    ).find((i) => (i.payload as { form?: string }).form === 'handoff')
    const took = await remote(tunnelUrl, 'POST', `/v1/approvals/${card?.id}/decide`, {
      token: session,
      assignment: theirs,
      body: { action: 'approve', selected_option_id: theirs },
    })
    expect(took.status).toBe(200)
    const after = await remote<{ matter: { position_id: string; handoff: { state: string } } }>(
      tunnelUrl,
      'GET',
      `/v1/matters/${matterId}`,
      { token: session, assignment: theirs },
    )
    expect(after.data.matter).toMatchObject({ position_id: theirs, handoff: { state: 'accepted' } })

    // 发起人关掉：同事那边 503 人话，不是挂着
    await A.server.close()
    machines.splice(machines.indexOf(A), 1)
    rmSync(A.dir, { recursive: true, force: true })
    const offline = await until(
      '同事那边看到不在线',
      async () => {
        const res = await fetch(`${tunnelUrl}/v1/me`, {
          headers: { authorization: `Bearer ${session}` },
        })
        const text = await res.text()
        return res.status === 503 ? text : undefined
      },
      60_000,
    )
    expect(offline).toContain('不在线')
  }, 180_000)
})
