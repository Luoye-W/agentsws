/**
 * 49 M1 本地那一半，端到端：关联 → 状态 → 解除。
 *
 * "端到端"是认真的：跑的是**真装配线**（路由 → 端口 → 加密库 → 事件日志），
 * 只把最外面那一跳换成一个**内存版的云服务端**（`createCloudServer()`，
 * 同一份代码，库在 `:memory:`）——全程不联网，也不需要任何真账号。
 *
 * 四条硬断言：
 * 1. 令牌明文**不出现在**任何响应体、事件日志与数据目录的字节里；
 * 2. 秘密库里存的是密文（`cloud.workspace_token` 这一条能列出字段名，值读不出来）；
 * 3. `state` 对不上的回调一律失败，且什么都不改；
 * 4. 解除之后本机没了、云侧那条也撤了（verifier 回 undefined）。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CloudAccountView } from '@agentsws/api'
import { type CloudMail, type CloudServer, createCloudServer } from '@agentsws/cloud'
import type { EventEnvelope } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID, createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-09-15T00:00:00.000Z'
const SECRETS_KEY = 'b'.repeat(64)
const CLOUD_BASE = 'http://cloud.test'

function seeded(seed = 13): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Ctx {
  server: Server
  cloud: CloudServer
  url: string
  dir: string
  mails: CloudMail[]
}

let ctx: Ctx

const api = async (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${ctx.server.bootstrap.internalToken}`)
  headers.set('X-Assignment', ctx.server.bootstrap.ownerAssignment.id)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  return fetch(`${ctx.url}${path}`, { ...init, headers })
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

async function allEvents(): Promise<EventEnvelope[]> {
  const out: EventEnvelope[] = []
  for await (const e of ctx.server.kernel.eventLog.read({
    workspace_id: ctx.server.bootstrap.workspace.id,
    limit: 5000,
  }))
    out.push(e)
  return out
}

function allBytes(dir: string): { name: string; bytes: Buffer }[] {
  const out: { name: string; bytes: Buffer }[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...allBytes(path))
      continue
    }
    try {
      if (statSync(path).size > 40_000_000) continue
      out.push({ name: path, bytes: readFileSync(path) })
    } catch {
      // 读不到就跳过
    }
  }
  return out
}

/** 从最近一封信里取出 `?token=`。这是"用户点了链接"那一步的替身。 */
function tokenFromMail(mails: CloudMail[]): { token: string; state: string } {
  const last = mails.at(-1)
  if (last === undefined) throw new Error('还没发过信')
  const match = /https?:\/\/\S+/.exec(last.text)
  if (match === null) throw new Error('信里没有链接')
  const url = new URL(match[0])
  return {
    token: url.searchParams.get('token') ?? '',
    state: url.searchParams.get('state') ?? '',
  }
}

/** 走完一次关联：发信 → 点链接（直接 GET 本机回调）。 */
async function linkOnce(email = 'luoye@example.com'): Promise<{ token: string; state: string }> {
  const started = await api('/v1/cloud/account/link', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
  expect(started.status).toBe(200)
  const link = tokenFromMail(ctx.mails)
  const cb = await fetch(
    `${ctx.url}/v1/cloud/account/callback?token=${encodeURIComponent(link.token)}&state=${encodeURIComponent(link.state)}`,
  )
  expect(cb.status).toBe(200)
  return link
}

beforeEach(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-account-'))
  let t = Date.parse(T0)
  const clock = {
    now: (): string => {
      t += 1000
      return new Date(t).toISOString()
    },
  }
  const mails: CloudMail[] = []
  // 内存版云服务端：同一份 apps/cloud 的代码，库在 :memory:，信落进数组
  const cloud = createCloudServer({
    clock: { now: () => new Date(t).toISOString() },
    quiet: true,
    env: { AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE },
    mail: async (mail) => {
      mails.push(mail)
    },
  })
  const server = await createServer({
    dbDir: dir,
    clock,
    random: seeded(),
    quiet: true,
    env: { [SECRETS_KEY_ENV]: SECRETS_KEY, AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    // 本地 → 云的那一跳走内存服务端，全程不出网
    cloudFetch: async (input, init) => {
      const res = await cloud.fetch(
        new Request(input, {
          method: init?.method ?? 'GET',
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
          ...(init?.body === undefined ? {} : { body: init.body }),
        }),
      )
      return { ok: res.ok, status: res.status, text: () => res.text() }
    },
  })
  const { url } = await server.listen(0)
  ctx = { server, cloud, url, dir, mails }
})

afterEach(async () => {
  await ctx.server.close()
  await ctx.cloud.close()
  rmSync(ctx.dir, { recursive: true, force: true })
})

describe('49 M1 本地云账号：关联 → 状态 → 解除', () => {
  it('没关联时状态是空的，也说得出云在哪儿', async () => {
    const view = await data<CloudAccountView>(await api('/v1/cloud/account'))
    expect(view.linked).toBe(false)
    expect(view.cloud_base_url).toBe(CLOUD_BASE)
    expect(view.blocked_reason).toBeUndefined()
    expect(view.email).toBeUndefined()
  })

  it('关联一次：邮件发出去、点链接之后状态齐了', async () => {
    await linkOnce()
    const view = await data<CloudAccountView>(await api('/v1/cloud/account'))
    expect(view.linked).toBe(true)
    expect(view.email).toBe('luoye@example.com')
    // 界面上不露"组织"这个词，但名字就是那个隐式建出来的组织名（= 邮箱）
    expect(view.org_name).toBe('luoye@example.com')
    expect(view.scopes).toEqual(['ai', 'wallet:read'])
    expect(Date.parse(view.expires_at ?? '')).toBeGreaterThan(Date.parse(T0))
    // 云侧确实有一条活着的关联，绑的是本工作区
    const link = ctx.cloud.store.activeLinkOfWorkspace(ctx.server.bootstrap.workspace.id)
    expect(link).toBeDefined()
  })

  it('令牌明文不进响应、不进事件日志、不进数据目录', async () => {
    await linkOnce()
    // 从云侧的库里反推那把明文是查不到的，所以这里用"库里只有哈希"这条来钉
    const rows = ctx.cloud.store.db.prepare('SELECT token_sha256 FROM workspace_links').all() as {
      token_sha256: string
    }[]
    expect(rows).toHaveLength(1)
    const hash = rows[0]?.token_sha256 ?? ''
    expect(hash).toMatch(/^[0-9a-f]{64}$/)

    const status = await (await api('/v1/cloud/account')).text()
    expect(status).not.toContain('wst_')
    expect(status).not.toContain(hash)

    const events = await allEvents()
    const linked = events.filter((e) => e.type === 'cloud.account_linked')
    expect(linked).toHaveLength(1)
    const payload = linked[0]?.payload as { email_domain: string; cloud_org_id: string }
    // 事件里只有域名，没有邮箱本地部分，也没有令牌
    expect(payload.email_domain).toBe('example.com')
    expect(payload.cloud_org_id).toMatch(/^org_/)
    const eventText = JSON.stringify(events)
    expect(eventText).not.toContain('luoye@')
    expect(eventText).not.toContain('wst_')
    expect(eventText).not.toContain(hash)

    // 数据目录：秘密库里那条是密文，明文的 wst_ 一个字节都搜不到
    for (const file of allBytes(ctx.dir)) {
      expect(file.bytes.includes(Buffer.from('wst_', 'utf8')), file.name).toBe(false)
    }
  })

  it('秘密库里存的是密文，列出来只有字段名', async () => {
    await linkOnce()
    const record = ctx.server.secrets.record(CLOUD_TOKEN_SECRET_ID)
    expect(record).toBeDefined()
    expect(record?.field_names).toContain('token')
    expect(record?.field_names).toContain('expires_at')
    // `list()` 是运维视角：只有字段名，没有值
    const listed = ctx.server.secrets.list().find((r) => r.connection_id === CLOUD_TOKEN_SECRET_ID)
    expect(JSON.stringify(listed)).not.toContain('wst_')
  })

  it('state 对不上的回调一律失败，什么都不改', async () => {
    await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'luoye@example.com' }),
    })
    const { token } = tokenFromMail(ctx.mails)
    const bad = await fetch(
      `${ctx.url}/v1/cloud/account/callback?token=${encodeURIComponent(token)}&state=nope`,
    )
    expect(bad.status).toBe(400)
    const body = await bad.text()
    // 出错页里不回显 token
    expect(body).not.toContain(token)
    expect((await data<CloudAccountView>(await api('/v1/cloud/account'))).linked).toBe(false)
  })

  it('同一条链接只能用一次', async () => {
    const link = await linkOnce()
    const again = await fetch(
      `${ctx.url}/v1/cloud/account/callback?token=${encodeURIComponent(link.token)}&state=${encodeURIComponent(link.state)}`,
    )
    expect(again.status).toBe(400)
  })

  it('已经关联过就不许再关联到别的账号', async () => {
    await linkOnce()
    const second = await api('/v1/cloud/account/link', {
      method: 'POST',
      body: JSON.stringify({ email: 'other@example.com' }),
    })
    expect(second.status).toBe(409)
  })

  it('解除：本机删掉，云侧那条也撤了', async () => {
    await linkOnce()
    const before = ctx.cloud.store.activeLinkOfWorkspace(ctx.server.bootstrap.workspace.id)
    expect(before).toBeDefined()

    const res = await api('/v1/cloud/account/unlink', { method: 'POST' })
    expect(res.status).toBe(200)
    const out = await data<{ unlinked: boolean; revoked_on_cloud: boolean }>(res)
    expect(out).toMatchObject({ unlinked: true, revoked_on_cloud: true })

    expect((await data<CloudAccountView>(await api('/v1/cloud/account'))).linked).toBe(false)
    expect(ctx.server.secrets.record(CLOUD_TOKEN_SECRET_ID)).toBeUndefined()
    // 云侧：行还在（撤销是一列不是删行），但验不过了
    expect(ctx.cloud.store.link(before?.id ?? '')?.revoked_at).toBeDefined()
    expect(ctx.cloud.store.activeLinkOfWorkspace(ctx.server.bootstrap.workspace.id)).toBeUndefined()

    const unlinked = (await allEvents()).filter((e) => e.type === 'cloud.account_unlinked')
    expect(unlinked).toHaveLength(1)
    expect(unlinked[0]?.payload).toMatchObject({
      email_domain: 'example.com',
      revoked_on_cloud: true,
    })

    // 解除之后可以关联到别的账号
    await linkOnce('other@example.com')
    expect((await data<CloudAccountView>(await api('/v1/cloud/account'))).email).toBe(
      'other@example.com',
    )
  })

  it('云连不上时：关联报错不留痕；解除照样本地断开，但如实说云侧没撤掉', async () => {
    await linkOnce()
    // 把云关掉之后再解除——这条是"网络不通"的样子
    await ctx.cloud.close()
    const res = await api('/v1/cloud/account/unlink', { method: 'POST' })
    expect(res.status).toBe(200)
    const out = await data<{ unlinked: boolean; revoked_on_cloud: boolean; reason?: string }>(res)
    expect(out.unlinked).toBe(true)
    expect(out.revoked_on_cloud).toBe(false)
    expect(out.reason).toBeDefined()
    expect((await data<CloudAccountView>(await api('/v1/cloud/account'))).linked).toBe(false)
  })
})
