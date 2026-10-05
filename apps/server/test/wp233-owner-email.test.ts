/**
 * WP233：本机负责人的登录邮箱跟云账号对齐。
 *
 * 前半段钉规则本身（`alignOwnerEmail`，内存身份服务）：只改占位、别人的邮箱不抢、可重复跑。
 * 后半段跑真装配线（路由 → 云账号端口 → 加密库 → 事件钩子 → 身份），只把云那一跳换成
 * 契约替身：关联上之后 owner 邮箱变了、会话 / 分配 / 按占位邮箱认人都不断；
 * 老工作区（早就关联、邮箱还是占位）启动时补一次，再启动不重复。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryIdentityService } from '@agentsws/api'
import { type EventEnvelope, PLACEHOLDER_OWNER_EMAIL } from '@agentsws/contracts'
import { CloudAccountsStandIn, cloudStandInFetch, type StandInMail } from '@agentsws/stand-ins'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { alignOwnerEmail } from '../src/owner-email.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-05T00:00:00.000Z'
const SECRETS_KEY = 'c'.repeat(64)
const CLOUD_EMAIL = 'boss@inmoxr.com'

function seeded(seed = 23): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('WP233 alignOwnerEmail：规则', () => {
  const setup = async (ownerEmail = PLACEHOLDER_OWNER_EMAIL) => {
    const identity = new MemoryIdentityService({
      clock: { now: () => T0 },
      random: seeded(),
    })
    const owner = await identity.createPerson({ email: ownerEmail, name: 'owner' })
    const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
    let cloud: string | undefined = CLOUD_EMAIL
    const opts = {
      identity,
      owner_id: owner.id,
      workspace_id: 'ws_1',
      cloudEmail: async () => cloud,
      appendEvent: (e: Omit<EventEnvelope, 'id' | 'at'>) => {
        events.push(e)
      },
    }
    return {
      identity,
      owner,
      events,
      opts,
      unlink: () => {
        cloud = undefined
      },
    }
  }

  it('占位邮箱 → 改成云账号邮箱，记一条只有域名的审计；再跑一次什么也不发生', async () => {
    const { identity, owner, events, opts } = await setup()
    expect(await alignOwnerEmail(opts, 'cloud_account_linked')).toBe('changed')
    expect((await identity.getPerson(owner.id))?.email).toBe(CLOUD_EMAIL)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('person.email_changed')
    expect(events[0]?.payload).toEqual({
      person_id: owner.id,
      from_domain: 'localhost',
      to_domain: 'inmoxr.com',
      reason: 'cloud_account_linked',
    })
    expect(JSON.stringify(events)).not.toContain('boss@')
    // 旧的占位地址仍认得这个人
    expect(identity.personByEmail(PLACEHOLDER_OWNER_EMAIL)?.id).toBe(owner.id)
    expect(await alignOwnerEmail(opts, 'cloud_account_backfill')).toBe('not_placeholder')
    expect(events).toHaveLength(1)
  })

  it('用户自己配过的邮箱不动', async () => {
    const { identity, owner, events, opts } = await setup('me@mine.cn')
    expect(await alignOwnerEmail(opts, 'cloud_account_linked')).toBe('not_placeholder')
    expect((await identity.getPerson(owner.id))?.email).toBe('me@mine.cn')
    expect(events).toHaveLength(0)
  })

  it('云账号邮箱已经是本机另一个人的：不改', async () => {
    const { identity, owner, events, opts } = await setup()
    await identity.createPerson({ email: CLOUD_EMAIL, name: 'colleague' })
    expect(await alignOwnerEmail(opts, 'cloud_account_linked')).toBe('taken')
    expect((await identity.getPerson(owner.id))?.email).toBe(PLACEHOLDER_OWNER_EMAIL)
    expect(events).toHaveLength(0)
  })

  it('没关联云账号：什么也不做', async () => {
    const { identity, owner, events, opts, unlink } = await setup()
    unlink()
    expect(await alignOwnerEmail(opts, 'cloud_account_backfill')).toBe('not_linked')
    expect((await identity.getPerson(owner.id))?.email).toBe(PLACEHOLDER_OWNER_EMAIL)
    expect(events).toHaveLength(0)
  })
})

// ── 真装配线 ──────────────────────────────────────────────────────────────

interface Ctx {
  server: Server
  url: string
  mails: StandInMail[]
}

const dirs: string[] = []
const live: Server[] = []

afterEach(async () => {
  for (const s of live.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot(dir: string, env: Record<string, string> = {}): Promise<Ctx> {
  let t = Date.parse(T0)
  const clock = {
    now: (): string => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
  const cloud = new CloudAccountsStandIn({ now: () => new Date(t).toISOString() })
  const wire = cloudStandInFetch({ accounts: cloud })
  const server = await createServer({
    dbDir: dir,
    clock,
    random: seeded(),
    quiet: true,
    env: {
      [SECRETS_KEY_ENV]: SECRETS_KEY,
      AGENTSWS_CLOUD_BASE_URL: 'http://cloud.test',
      ...env,
    },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch: wire.fetch as never,
  })
  live.push(server)
  const { url } = await server.listen(0)
  return { server, url, mails: cloud.mails }
}

const api = (ctx: Ctx, path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', ctx.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function link(ctx: Ctx, email = CLOUD_EMAIL): Promise<void> {
  const started = await api(ctx, '/v1/cloud/account/link', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  expect(started.status).toBe(200)
  const match = /https?:\/\/\S+/.exec(ctx.mails.at(-1)?.text ?? '')
  if (match === null) throw new Error('信里没有链接')
  const u = new URL(match[0])
  const cb = await fetch(
    `${ctx.url}/v1/cloud/account/callback?token=${encodeURIComponent(u.searchParams.get('token') ?? '')}&state=${encodeURIComponent(u.searchParams.get('state') ?? '')}`,
  )
  expect(cb.status).toBe(200)
}

async function ownerEvents(ctx: Ctx): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    if (e.type === 'person.email_changed') out.push(e)
  return out
}

const meEmail = async (ctx: Ctx): Promise<string> =>
  (await data<{ person: { email: string } }>(await api(ctx, '/v1/me'))).person.email

describe('WP233 真装配线：关联云账号之后', () => {
  it('owner 邮箱改成云账号邮箱；会话、分配、按占位邮箱登录都不断', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp233-'))
    dirs.push(dir)
    const ctx = await boot(dir)
    const ownerId = ctx.server.bootstrap.person.id
    expect(await meEmail(ctx)).toBe(PLACEHOLDER_OWNER_EMAIL)

    await link(ctx)
    await vi.waitFor(async () => {
      expect(await meEmail(ctx)).toBe(CLOUD_EMAIL)
    })
    // 原来那张内部凭据照用（会话按 person_id 绑，不按邮箱）；分配还在
    const me = await data<{ person: { id: string }; assignments: { id: string }[] }>(
      await api(ctx, '/v1/me'),
    )
    expect(me.person.id).toBe(ownerId)
    expect(me.assignments.map((a) => a.id)).toContain(ctx.server.bootstrap.ownerAssignment.id)
    // 按占位邮箱换会话（桌面壳那条路）仍认到同一个人
    const issued = await data<{ token: string }>(
      await fetch(`${ctx.url}/v1/auth/magic-link`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: PLACEHOLDER_OWNER_EMAIL }),
      }),
    )
    const verified = await data<{ person: { id: string; email: string } }>(
      await fetch(`${ctx.url}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: issued.token }),
      }),
    )
    expect(verified.person).toMatchObject({ id: ownerId, email: CLOUD_EMAIL })
    // 审计只记域名
    const events = await ownerEvents(ctx)
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      to_domain: 'inmoxr.com',
      reason: 'cloud_account_linked',
    })
    expect(JSON.stringify(events)).not.toContain('boss@')
  })

  it('配过 AGENTSWS_OWNER_EMAIL 的（不是占位）不动', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp233-'))
    dirs.push(dir)
    const ctx = await boot(dir, { AGENTSWS_OWNER_EMAIL: 'me@mine.cn' })
    await link(ctx)
    expect(await meEmail(ctx)).toBe('me@mine.cn')
    expect(await ownerEvents(ctx)).toHaveLength(0)
  })

  it('老工作区：早就关联、邮箱还是占位 → 启动时补一次；重启不重复，owner 还是同一个人', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp233-'))
    dirs.push(dir)
    const first = await boot(dir)
    const ownerId = first.server.bootstrap.person.id
    await link(first)
    await vi.waitFor(async () => {
      expect(await meEmail(first)).toBe(CLOUD_EMAIL)
    })
    // 造一个"这一版之前"的现场：关联还在，邮箱改回占位（这一版之前不会改它）
    await first.server.identity.changePersonEmail(ownerId, PLACEHOLDER_OWNER_EMAIL)
    expect(await meEmail(first)).toBe(PLACEHOLDER_OWNER_EMAIL)
    await first.server.close()
    live.splice(live.indexOf(first.server), 1)

    const second = await boot(dir)
    expect(second.server.bootstrap.person.id).toBe(ownerId)
    expect(await meEmail(second)).toBe(CLOUD_EMAIL)
    const backfilled = (await ownerEvents(second)).filter(
      (e) => (e.payload as { reason?: string }).reason === 'cloud_account_backfill',
    )
    expect(backfilled).toHaveLength(1)
    await second.server.close()
    live.splice(live.indexOf(second.server), 1)

    const third = await boot(dir)
    expect(third.server.bootstrap.person.id).toBe(ownerId)
    expect(await meEmail(third)).toBe(CLOUD_EMAIL)
    expect(await ownerEvents(third)).toHaveLength(backfilled.length + 1)
  })
})
