/**
 * WP243：首次设置第 ③ 步「帮我推荐」经「Agents 工坊（用积分）」那一条调云模型。
 *
 * 起因（Fable 10-07，Windows 真机 ci.10）：10-06 那一次成功但等了 38 秒、出了 8859 个 token；
 * 10-07 同一句再点就 `fetch failed (UND_ERR_SOCKET other side closed)`——非流式请求几十秒不回字节，
 * 中间的代理把连接当空闲掐了。
 *
 * 这一档起一个**真 HTTP** 的本机云替身（关联 / 补签走 `cloudStandIn`），模型口前面挡一跳
 * 「空闲就掐线」（真机约 45 秒，这里缩成几百毫秒；回答要的时间比它长）。钉住：
 * 1. 推荐那一次走流式、带输出上限与关思考；回答比掐线时间长也不断；推荐里有建站 / 社媒 / 红人 / 客服；
 * 2. 第一次流到一半被掐：整体重发一次成功，`model.usage` 里看得见重发过；
 * 3. 新写法的输出比老写法短（按 DeepSeek 的估算口径），二十来条职责 < 1500 token。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOUD_STAND_IN_BASE_URL,
  type CloudStandIn,
  cloudStandIn,
  createServer,
  type Server,
} from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import {
  estimateDeepSeekTokens,
  ROLLOUT_COMPACT_ANSWER,
  ROLLOUT_OLD_ANSWER,
  ROLLOUT_TEXT,
} from './wp243-fixtures.js'

vi.setConfig({ testTimeout: 30_000 })

const IDLE_MS = 250
const ANSWER_MS = 900
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface LocalCloud {
  base: string
  standIn: CloudStandIn
  aiBodies: Record<string, unknown>[]
  killed: number
  close(): Promise<void>
}

/** 本机 HTTP 云替身；模型口前面挡一跳「`IDLE_MS` 没字节就掐」。`breakFirst`：第一次流到一半掐掉。 */
async function localCloud(breakFirst = false): Promise<LocalCloud> {
  const standIn = cloudStandIn({ autoLinkAfterMs: 0 })
  const state: LocalCloud = {
    base: '',
    standIn,
    aiBodies: [],
    killed: 0,
    close: async () => undefined,
  }
  const http: HttpServer = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks).toString('utf8')
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
    const url = `${CLOUD_STAND_IN_BASE_URL}${req.url ?? '/'}`
    const out = await standIn.fetch(url, {
      method: req.method ?? 'GET',
      headers,
      ...(body === '' ? {} : { body }),
    })
    if (new URL(url).pathname !== '/v1/ai/chat/completions' || out.status !== 404) {
      res.writeHead(out.status, { 'content-type': 'application/json' })
      res.end(await out.text())
      return
    }
    // 替身的模型口只校验令牌（过了它回 404「演示里没有」）；过了就当模型回答
    const parsed = JSON.parse(body) as Record<string, unknown>
    state.aiBodies.push(parsed)
    const nth = state.aiBodies.length
    const socket = req.socket
    let last = Date.now()
    let gone = false
    const watch = setInterval(() => {
      if (Date.now() - last > IDLE_MS) {
        clearInterval(watch)
        gone = true
        state.killed += 1
        socket.destroy()
      }
    }, 10)
    const write = (s: string): void => {
      if (gone) return
      last = Date.now()
      res.write(s)
    }
    const usage = {
      prompt_tokens: 3126,
      completion_tokens: estimateDeepSeekTokens(ROLLOUT_COMPACT_ANSWER),
    }
    try {
      if (parsed.stream !== true) {
        await sleep(ANSWER_MS)
        if (gone) return
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ choices: [{ message: { content: ROLLOUT_COMPACT_ANSWER } }], usage }),
        )
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const pieces = ROLLOUT_COMPACT_ANSWER.match(/[\s\S]{1,40}/g) ?? []
      const every = Math.ceil(ANSWER_MS / pieces.length)
      for (const [i, piece] of pieces.entries()) {
        await sleep(every)
        if (gone) return
        if (breakFirst && nth === 1 && i === Math.floor(pieces.length / 2)) {
          socket.destroy()
          return
        }
        write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`)
      }
      write(
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`,
      )
      if (!gone) res.end('data: [DONE]\n\n')
    } finally {
      clearInterval(watch)
    }
  })
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r))
  state.base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  state.close = () =>
    new Promise<void>((r) => {
      http.closeAllConnections()
      http.close(() => r())
    })
  return state
}

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c()
})

interface Who {
  token: string
  assignment: string
}

async function boot(cloudBase: string): Promise<{ server: Server; url: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp243-'))
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
      AGENTSWS_WORKSPACE_NAME: 'Rollout',
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
  })
  const { url } = await server.listen(0)
  cleanups.push(async () => {
    await server.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { server, url }
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

/** 关联账号（替身自动点链接）→ 存「Agents 工坊（用积分）」那一条当默认。 */
async function linkCloud(server: Server, url: string, standIn: CloudStandIn): Promise<Who> {
  const who = {
    token: server.bootstrap.internalToken,
    assignment: server.bootstrap.ownerAssignment.id,
  }
  const linked = await call(url, who, 'POST', '/v1/cloud/account/link', {
    email: 'boss@example.com',
  })
  expect(linked.status, linked.message).toBeLessThan(300)
  await standIn.settled()
  for (let i = 0; i < 100; i++) {
    const acct = await call<{ linked: boolean }>(url, who, 'GET', '/v1/cloud/account')
    if (acct.data?.linked === true) break
    await sleep(20)
  }
  const saved = await call(url, who, 'PUT', '/v1/models/providers/agentsws', {
    kind: 'agentsws_cloud',
    model: 'deepseek-flash',
    region: 'cn',
  })
  expect(saved.status, saved.message).toBe(200)
  return who
}

interface Suggested {
  source: string
  roles: { role_id: string; reason: string; quote?: string }[]
  positions: { name: string; role_ids: string[] }[]
}

const usageOf = (server: Server) =>
  server.kernel.eventLog
    .readSync({ workspace_id: server.bootstrap.workspace.id as never })
    .filter((e) => e.type === 'model.usage')
    .map((e) => e.payload as { purpose: string; output_tokens: number; net_retries?: unknown[] })

describe('WP243 推荐经云：快、短、不怕空闲掐线', () => {
  it('Rollout 那句：走流式 + 输出上限 + 关思考；回答比掐线时间长也不断；建站 / 社媒 / 红人 / 客服都在', async () => {
    const cloud = await localCloud()
    cleanups.push(cloud.close)
    const { server, url } = await boot(cloud.base)
    const who = await linkCloud(server, url, cloud.standIn)

    const out = await call<Suggested>(url, who, 'POST', '/v1/onboarding/suggest', {
      text: ROLLOUT_TEXT,
    })
    expect(out.status, out.message).toBe(200)
    expect(out.data?.source).toBe('ai')
    expect(cloud.killed).toBe(0)
    expect(cloud.aiBodies).toHaveLength(1)
    expect(cloud.aiBodies[0]).toMatchObject({
      stream: true,
      max_tokens: 2048,
      thinking: { type: 'disabled' },
    })
    const ids = out.data?.roles.map((r) => r.role_id) ?? []
    expect(ids).toHaveLength(21)
    expect(ids).toEqual(
      expect.arrayContaining([
        'site.shopify-build',
        'social.instagram',
        'kol.youtube',
        'ads.meta',
        'dtc.support',
      ]),
    )
    // 原话都对得上（新格式的第三格）；岗位按模型给的分（过了校验）
    expect(out.data?.roles.every((r) => r.quote !== undefined)).toBe(true)
    expect(out.data?.positions.map((p) => p.name)).toEqual([
      '建站',
      '网站运营',
      '社媒运营',
      '红人营销',
      '投放',
      '客服',
    ])
    const usage = usageOf(server).filter((u) => u.purpose === 'extraction')
    expect(usage).toHaveLength(1)
    expect(usage[0]?.output_tokens).toBeLessThan(1500)
    expect(usage[0]?.net_retries).toBeUndefined()
  })

  it('第一次流到一半被掐：整体重发一次成功，usage 里看得见重发过（UND_ERR_SOCKET）', async () => {
    const cloud = await localCloud(true)
    cleanups.push(cloud.close)
    const { server, url } = await boot(cloud.base)
    const who = await linkCloud(server, url, cloud.standIn)
    const out = await call<Suggested>(url, who, 'POST', '/v1/onboarding/suggest', {
      text: ROLLOUT_TEXT,
    })
    expect(out.data?.source).toBe('ai')
    expect(out.data?.roles).toHaveLength(21)
    expect(cloud.aiBodies).toHaveLength(2)
    const usage = usageOf(server).filter((u) => u.purpose === 'extraction')
    expect(usage[0]?.net_retries).toEqual([
      expect.objectContaining({ code: 'UND_ERR_SOCKET', duration_ms: expect.any(Number) }),
    ])
  })

  it('新写法比老写法短：二十一条职责 + 六个岗位 < 1500 token（DeepSeek 估算口径）', () => {
    const compact = estimateDeepSeekTokens(ROLLOUT_COMPACT_ANSWER)
    const old = estimateDeepSeekTokens(ROLLOUT_OLD_ANSWER)
    expect(compact).toBeLessThan(1500)
    expect(compact).toBeLessThan(old)
  })
})
