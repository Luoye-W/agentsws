/**
 * 决策 291（WP281）：「数据不出境」整套删了。本机这一侧三件事：
 *
 * 1. **不再发驻留请求头**：走 Agents 工坊云的文字 / 生图请求里没有 `X-Agentsws-Region`；
 * 2. **老设置不报错**：`models.json` 里存着 `data_residency: cn` 的工作区照常起、照常用境外模型，
 *    读到的那一格丢掉，下次保存不再写回；老客户端 PUT 带它也照收；
 * 3. **界面上的话**：模型模板（步骤 / 介绍）与试跑失败的人话里没有「不出境 / 出境 / 数据驻留」。
 */
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelDefaultsView } from '@agentsws/api'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { CLOUD_TOKEN_SECRET_ID, humanizeModelError } from '../src/models.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const T0 = '2026-10-09T09:00:00.000Z'
const SECRETS_KEY = 'c'.repeat(64)
const CLOUD_TOKEN = 'wst_wp281_cloud'
const OPENAI_KEY = 'sk-wp281-openai'
const WORDS = /不出境|出境|数据驻留|residency/i

interface Call {
  url: string
  headers: Record<string, string>
}

function fakeUpstream(): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: { ...init.headers } })
    const ok = (body: unknown) => ({
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    })
    if (url.endsWith('/models')) return ok({ object: 'list', data: [{ id: 'm-1' }] })
    return ok({
      choices: [{ message: { content: '好' } }],
      usage: { prompt_tokens: 9, completion_tokens: 1 },
    })
  }
  return { fetch, calls }
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(dbDir = mkdtempSync(join(tmpdir(), 'agentsws-wp281-'))) {
  let t = Date.parse(T0)
  const upstream = fakeUpstream()
  const server = await createServer({
    dbDir,
    clock: { now: () => new Date(t).toISOString() },
    random: () => {
      t += 1
      return 0.5
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: {
      AGENTSWS_OWNER_EMAIL: 'owner@example.test',
      AGENTSWS_WORKSPACE_NAME: '测试品牌',
      [SECRETS_KEY_ENV]: SECRETS_KEY,
    },
    mdns: () => ({ reason: '测试里不开局域网' }),
    modelFetch: upstream.fetch,
    cloudFetch: async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    }),
  })
  servers.push(server)
  return { server, calls: upstream.calls, dbDir }
}

async function call<T>(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data?: T; text: string }> {
  const headers = new Headers({ 'content-type': 'application/json' })
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  const res = await server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
  const text = await res.text()
  const parsed = JSON.parse(text) as { data?: T }
  return { status: res.status, ...(parsed.data === undefined ? {} : { data: parsed.data }), text }
}

/** 数据目录里那份 `models.json`（品牌目录在哪层不管，找到为止）。 */
function modelsFile(dir: string): string | undefined {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      const found = modelsFile(path)
      if (found !== undefined) return found
    } else if (name === 'models.json') return path
  }
  return undefined
}

const hasRegionHeader = (c: Call): boolean =>
  Object.keys(c.headers).some((k) => k.toLowerCase() === 'x-agentsws-region')

describe('WP281 本机不再发驻留请求头', () => {
  it('官方接口那一条（积分）：试跑打出去的每一次请求都没有 X-Agentsws-Region', async () => {
    const { server, calls } = await boot()
    server.secrets.put(CLOUD_TOKEN_SECRET_ID, { token: CLOUD_TOKEN })
    const saved = await call(server, 'PUT', '/v1/models/providers/cloud', {
      kind: 'agentsws_cloud',
      model: 'deepseek-flash',
    })
    expect(saved.status).toBe(200)
    await call(server, 'POST', '/v1/models/providers/cloud/test')
    const cloudCalls = calls.filter((c) => c.url.startsWith('https://cloud.agentsws.com/v1/ai/'))
    expect(cloudCalls.some((c) => c.url.endsWith('/chat/completions'))).toBe(true)
    expect(cloudCalls.length).toBeGreaterThan(0)
    expect(cloudCalls.some(hasRegionHeader)).toBe(false)
  })
})

describe('WP281 老设置里的驻留读到就丢', () => {
  it('models.json 存着 data_residency: cn：照常起、境外模型照常试跑通、下次保存不再写回', async () => {
    const first = await boot()
    const openai = {
      kind: 'openai_compatible',
      base_url: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      region: 'global',
      api_key: OPENAI_KEY,
    }
    expect((await call(first.server, 'PUT', '/v1/models/providers/openai', openai)).status).toBe(
      200,
    )
    const file = modelsFile(first.dbDir)
    expect(file).toBeDefined()
    await first.server.close()
    servers.splice(servers.indexOf(first.server), 1)

    // 模拟升级前的老工作区：驻留设成「只用境内」
    const legacy = JSON.parse(readFileSync(file as string, 'utf8')) as {
      defaults: Record<string, unknown>
    }
    legacy.defaults.data_residency = 'cn'
    writeFileSync(file as string, JSON.stringify(legacy))

    const again = await boot(first.dbDir)
    const defaults = await call<ModelDefaultsView>(again.server, 'GET', '/v1/models/defaults')
    expect(defaults.status).toBe(200)
    expect(defaults.data).not.toHaveProperty('data_residency')
    // 境外那一条不被拦：试跑真的打出去了
    await call(again.server, 'POST', '/v1/models/providers/openai/test')
    expect(again.calls.some((c) => c.url.startsWith('https://api.openai.com/'))).toBe(true)

    // 老客户端 PUT 还带着它：照收（200），不生效、不落盘
    const put = await call<ModelDefaultsView>(again.server, 'PUT', '/v1/models/defaults', {
      data_residency: 'cn',
      budget: { workspace_daily_base: 3 },
    })
    expect(put.status).toBe(200)
    expect(put.data).not.toHaveProperty('data_residency')
    expect(readFileSync(file as string, 'utf8')).not.toContain('data_residency')
  })
})

describe('WP281 端给界面的话里没有驻留', () => {
  it('模型模板（介绍、步骤、预设）一个字都没有', async () => {
    const { server } = await boot()
    const res = await call(server, 'GET', '/v1/models/providers')
    expect(res.status).toBe(200)
    expect(res.text).not.toMatch(/不出境|出境|数据驻留/)
  })

  it('试跑失败的人话：forbidden / 老的 residency_blocked 都不再说驻留', () => {
    for (const code of ['forbidden', 'residency_blocked']) {
      expect(humanizeModelError(code, 'nope')).not.toMatch(WORDS)
    }
  })
})
