/**
 * WP242：第二个品牌用「Agents 工坊接口」（agentsws 云）调模型。
 *
 * 起因（Fable 10-06，Windows 真机 ci.9）：已有品牌 INMO 用云接口跑通过真模型；新建品牌 Rollout
 * 「跟随公司」，第 ③ 步「帮我推荐」三次都是 `model.provider_down … fetch failed`。
 *
 * 这一档**不替换出站 fetch**：起一个本机 HTTP 云替身（关联 / 补签 / 模型口都在它上面），
 * 服务进程用真的 `globalThis.fetch` 打它——与真机同一条路，只是地址换成回环口。钉住：
 * 1. 两个品牌都用云接口调模型成功（推荐走 AI，不退回按词）；
 * 2. 第二个品牌那一次带的是**能用**的工作区令牌，记账记在**第二个品牌**（`X-Agentsws-Member` 是本人）；
 * 3. 上游真不通时，`model.provider_down` 带上真实原因（`ECONNREFUSED` 之类），不只是 fetch failed。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MEMBER_HEADER } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { ROLLOUT_TEXT } from './wp242-fixtures.js'

vi.setConfig({ testTimeout: 30_000 })

interface Hit {
  path: string
  auth: string | undefined
  member: string | undefined
}

/** 本机 HTTP 云替身：除模型口外全转给 `cloudStandIn`；模型口先过它的令牌校验，再回一段固定答案。 */
async function localCloud(): Promise<{
  base: string
  standIn: CloudStandIn
  hits: Hit[]
  close(): Promise<void>
}> {
  const standIn = cloudStandIn({ autoLinkAfterMs: 0 })
  const hits: Hit[] = []
  const http: HttpServer = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
    const url = `${CLOUD_STAND_IN_BASE_URL}${req.url ?? '/'}`
    const path = new URL(url).pathname
    hits.push({ path, auth: headers.authorization, member: headers[MEMBER_HEADER.toLowerCase()] })
    const out = await standIn.fetch(url, {
      method: req.method ?? 'GET',
      headers,
      ...(body === '' ? {} : { body }),
    })
    if (path === '/v1/ai/chat/completions' && out.status === 404) {
      // 替身的模型口只校验令牌（过了它回 404「演示里没有」）；过了就回一段 OpenAI 形态的推荐
      const reply = {
        id: 'cmpl_wp242',
        choices: [
          {
            index: 0,
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content:
                '```json\n{"roles":[{"role_id":"site.shopify-build","reason":"独立站要改主题","quote":"Shopify 独立站"}]}\n```',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }
      if ((JSON.parse(body) as { stream?: boolean }).stream === true) {
        // 随便聊走流式：一段 SSE
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: '在的' } }] })}\n\n`,
        )
        res.write(
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: reply.usage })}\n\n`,
        )
        res.end('data: [DONE]\n\n')
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply))
      return
    }
    res.writeHead(out.status, { 'content-type': 'application/json' })
    res.end(await out.text())
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  const port = (http.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    standIn,
    hits,
    close: () =>
      new Promise<void>((r) => {
        http.closeAllConnections()
        http.close(() => r())
      }),
  }
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface Who {
  token: string
  assignment: string
}

async function boot(cloudBase: string): Promise<{ server: Server; url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp242-'))
  const server = await createServer({
    dbDir: dir,
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      [SECRETS_KEY_ENV]: 'e'.repeat(64),
      AGENTSWS_CLOUD_BASE_URL: cloudBase,
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      AGENTSWS_WORKSPACE_NAME: 'INMO',
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
  })
  const { url } = await server.listen(0)
  cleanups.push(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { server, url, dir }
}

async function call<T>(
  url: string,
  who: Who,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; message?: string }> {
  const headers = new Headers({
    Authorization: `Bearer ${who.token}`,
    'X-Assignment': who.assignment,
  })
  if (body !== undefined) headers.set('content-type', 'application/json')
  const res = await fetch(`${url}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const parsed = (await res.json()) as { data?: T; message?: string }
  return {
    status: res.status,
    ...(parsed.data === undefined ? {} : { data: parsed.data }),
    ...(parsed.message === undefined ? {} : { message: parsed.message }),
  }
}

const inmoOf = (server: Server): Who => ({
  token: server.bootstrap.internalToken,
  assignment: server.bootstrap.ownerAssignment.id,
})

/** INMO：关联账号（替身自动点链接）→ 存「Agents 工坊（用积分）」那一条当默认。 */
async function linkInmo(server: Server, url: string, standIn: CloudStandIn): Promise<void> {
  const inmo = inmoOf(server)
  const linked = await call(url, inmo, 'POST', '/v1/cloud/account/link', {
    email: 'boss@example.com',
  })
  expect(linked.status, linked.message).toBeLessThan(300)
  await standIn.settled()
  // 等关联落地（替身点链接是异步的）
  for (let i = 0; i < 100; i++) {
    const acct = await call<{ linked: boolean }>(url, inmo, 'GET', '/v1/cloud/account')
    if (acct.data?.linked === true) break
    await new Promise((r) => setTimeout(r, 20))
  }
  const saved = await call(url, inmo, 'PUT', '/v1/models/providers/agentsws', {
    kind: 'agentsws_cloud',
    model: 'deepseek-flash',
    region: 'cn',
  })
  expect(saved.status, saved.message).toBe(200)
  // INMO 的首次设置走过（公司那一层有了）：后加的 Rollout 才算「加的品牌」
  const profile = await call(url, inmo, 'PUT', '/v1/workspace/profile', {
    legal_name: 'INMO',
    brand_name: 'INMO',
    storefront_platform: 'shopify',
  })
  expect(profile.status).toBe(200)
}

async function addRollout(server: Server, url: string): Promise<Who & { workspace_id: string }> {
  const inmo = inmoOf(server)
  const orgs = await call<{ id: string }[]>(url, inmo, 'GET', '/v1/orgs')
  const org = orgs.data?.[0]?.id ?? ''
  const created = await call<{ workspace_id: string }>(
    url,
    inmo,
    'POST',
    `/v1/orgs/${org}/brands`,
    {
      name: 'Rollout',
    },
  )
  expect(created.status).toBe(201)
  const workspace_id = created.data?.workspace_id ?? ''
  const switched = await call<{ session_token?: string }>(
    url,
    inmo,
    'POST',
    `/v1/orgs/${org}/brands/${workspace_id}/switch`,
  )
  const assignment = server.roles.assignments
    .listByPerson(server.bootstrap.person.id, { workspace_id })
    .find((a) => a.revoked_at === undefined)
  if (assignment === undefined) throw new Error('新品牌里应该自带一条 owner 分配')
  return { workspace_id, token: switched.data?.session_token ?? '', assignment: assignment.id }
}

interface Suggested {
  source: string
  roles: { role_id: string }[]
}

describe('WP242 第二个品牌用云接口调模型', () => {
  it('INMO 与 Rollout（跟随公司）都走 AI 推荐；Rollout 那一次的令牌能用', async () => {
    const cloud = await localCloud()
    cleanups.push(cloud.close)
    const { server, url } = await boot(cloud.base)
    await linkInmo(server, url, cloud.standIn)

    const inmo = await call<Suggested>(url, inmoOf(server), 'POST', '/v1/onboarding/suggest', {
      text: ROLLOUT_TEXT,
    })
    expect(inmo.status).toBe(200)
    expect(inmo.data?.source).toBe('ai')

    const rollout = await addRollout(server, url)
    const state = await call<{ model_configured?: boolean; added_brand?: boolean }>(
      url,
      rollout,
      'GET',
      '/v1/onboarding/state',
    )
    expect(state.data?.added_brand).toBe(true)
    expect(state.data?.model_configured).toBe(true)

    cloud.hits.length = 0
    const out = await call<Suggested>(url, rollout, 'POST', '/v1/onboarding/suggest', {
      text: ROLLOUT_TEXT,
    })
    expect(out.status).toBe(200)
    expect(out.data?.source).toBe('ai')
    const ai = cloud.hits.filter((h) => h.path === '/v1/ai/chat/completions')
    expect(ai).toHaveLength(1)
    expect(ai[0]?.auth).toMatch(/^Bearer \S+$/)
    // 记账：记在 Rollout、记在点推荐的这个人头上（以前记在启动品牌的负责人头上）
    expect(ai[0]?.member).toBe(server.bootstrap.person.id)
    const usage = (ws: string) =>
      server.kernel.eventLog
        .readSync({ workspace_id: ws as never })
        .filter((e) => e.type === 'model.usage')
    expect(usage(rollout.workspace_id)).toHaveLength(1)

    // 随便聊（流式那条路）在 Rollout 里也通
    const session = await call<{ id: string }>(url, rollout, 'POST', '/v1/free-chat/sessions', {})
    expect(session.status).toBe(201)
    const res = await fetch(`${url}/v1/free-chat/sessions/${session.data?.id}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${rollout.token}`,
        'X-Assignment': rollout.assignment,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ text: '在吗' }),
    })
    const sse = await res.text()
    expect(sse).toContain('"done"')
    expect(sse).toContain('在的')
  })

  it('云真打不通：provider_down 带真原因（ECONNREFUSED），推荐退回按词也对得上', async () => {
    const cloud = await localCloud()
    const { server, url } = await boot(cloud.base)
    await linkInmo(server, url, cloud.standIn)
    const rollout = await addRollout(server, url)
    // 云这一头关掉：之后的连接一律被拒
    await cloud.close()
    const out = await call<Suggested>(url, rollout, 'POST', '/v1/onboarding/suggest', {
      text: ROLLOUT_TEXT,
    })
    expect(out.data?.source).toBe('keyword')
    // 真目录上按词对（WP242 补的说法）：建站、社媒、红人、投放、客服都推上；没提 Amazon 不推 Amazon 客服
    const got = out.data?.roles.map((r) => r.role_id) ?? []
    expect(got).toEqual(
      expect.arrayContaining([
        'site.shopify-build',
        'social.instagram',
        'kol.youtube',
        'ads.meta',
        'dtc.support',
      ]),
    )
    expect(got).not.toContain('amz.support')
    const down = server.kernel.eventLog
      .readSync({ workspace_id: rollout.workspace_id as never })
      .filter((e) => e.type === 'model.provider_down')
    const message = JSON.stringify(down.at(-1)?.payload ?? {})
    expect(message).toContain('fetch failed')
    expect(message).toContain('ECONNREFUSED')
  })
})
