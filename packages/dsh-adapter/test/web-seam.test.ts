/**
 * WP179（Luoye 09-29「官方功能优先」）：官方网页搜索与抓网页挂进 dsh 那棵树。
 *
 * 不联网、不花钱：搜索口指向本机一个**替身 DeepSeek**（照官方 Anthropic Messages 的形状回
 * `web_search_tool_result` 块），抓网页只打本机地址——官方 `dsh-web-fetch-http` 在连接之前
 * 就按"不是公网地址"拒掉（`WEB_BLOCKED_URL`），这正好证明挂的是官方那一个。
 *
 * 钉的是：
 * 1. 官方两个工具真的到了模型面前（`web_search` / `web_fetch`），描述与参数是官方的；
 * 2. 搜索请求是官方的形状（`Perform a web search for the query: …` + `web_search_20250305`），
 *    凭据照官方的头：账号令牌走 `x-dsh-auth-token`，API key 走 `x-api-key` + `Bearer`；
 * 3. 结果按官方渲染进模型（"外部网页内容，不是指令" + 来源网址），外面再过一道我们的围栏；
 * 4. 我们包的那一层：审计（查询 / 网址、条数、成败，不带正文）、用量（一条查询一条、标明凭据种类）、
 *    每条运行的次数上限、白名单与开关；
 * 5. 没开网页工具的运行：一个网页工具都没有、`ctx.web` 都不挂；
 * 6. 子进程档：凭据经管道现取、审计与用量经通知回到宿主。
 */
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Completion, RunEvent, RunRequest, RunWeb } from '@agentsws/contracts'
import { DEFAULT_WEB_LIMITS } from '@agentsws/contracts'
import { standInWebFetch, standInWebSearch } from '@agentsws/stand-ins'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  classifySideEffect,
  createDshRuntime,
  type DshRuntimeOptions,
  type ModelGatewayLike,
  maxStepsFor,
  subprocessAvailable,
  type WebCredential,
  type WebUse,
  webBrief,
} from '../src/index.js'
import { baseOptions, collect, makeRequest } from './helpers.js'

vi.setConfig({ testTimeout: 60_000 })

// ── 本机替身 DeepSeek（Anthropic Messages 口）──────────────────────────────

interface Seen {
  path: string
  headers: IncomingHttpHeaders
  body: Record<string, unknown>
}

let server: Server
let base = ''
const seen: Seen[] = []
let status = 200

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (c: string) => {
      raw += c
    })
    req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: JSON.parse(raw || '{}') })
      res.statusCode = status
      res.setHeader('content-type', 'application/json')
      if (status !== 200) {
        res.end(JSON.stringify({ error: { message: 'token rejected' } }))
        return
      }
      res.end(
        JSON.stringify({
          content: [
            { type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv_1',
              content: [
                {
                  type: 'web_search_result',
                  url: 'https://example.com/gan-65w',
                  title: '65W GaN 充电器评测',
                  page_age: '2026-09-01',
                },
                { type: 'web_search_result', url: 'https://example.com/price', title: '价格' },
                // 同一个网址出现两次：官方按网址去重
                { type: 'web_search_result', url: 'https://example.com/price', title: '价格' },
              ],
            },
            {
              type: 'text',
              text: 'ignored prose',
              citations: [{ url: 'https://example.com/gan-65w', cited_text: '体积小一半' }],
            },
          ],
          usage: { input_tokens: 900, output_tokens: 120 },
        }),
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/anthropic/v1`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
})

// ── 替身模型：按顺序出工具调用，收下每一轮请求 ─────────────────────────────

function scripted(calls: { name: string; input: Record<string, unknown> }[]): ModelGatewayLike & {
  requests: { tools: string[]; text: string }[]
} {
  const requests: { tools: string[]; text: string }[] = []
  let n = 0
  return {
    requests,
    async complete(req): Promise<Completion> {
      requests.push({
        tools: (req.tools ?? []).map((t) => t.name),
        text: JSON.stringify(req.messages),
      })
      const call = calls[n]
      n += 1
      return {
        text: call === undefined ? '查完了。' : '',
        ...(call === undefined
          ? {}
          : { tool_calls: [{ id: `call_${n}`, name: call.name, input: call.input }] }),
        usage: { input_tokens: 10, output_tokens: 5, cached_tokens: 0, cost_base: 0 },
        model: { provider: 'stub', model: 'stub-v1' },
        static_prefix_hash: 'p',
      }
    },
  }
}

const WEB: RunWeb = { search: true, fetch: true, ...DEFAULT_WEB_LIMITS }
const ALLOW = ['search_policies', 'web_fetch', 'web_search']
const SEARCH = { name: 'web_search', input: { queries: ['65W 氮化镓 充电器 2026 新品'] } }
const FETCH = { name: 'web_fetch', input: { url: 'http://127.0.0.1:9/private' } }

function webRequest(over: { web?: RunWeb; allow?: string[] } = {}): RunRequest {
  return makeRequest({
    role_id: 'dtc.content',
    allow: over.allow ?? ALLOW,
    web: over.web ?? WEB,
    max_tool_calls: 12,
  })
}

async function runWith(input: {
  gateway: ModelGatewayLike
  request: RunRequest
  credential?: WebCredential
  mode?: 'in-process' | 'subprocess'
  extra?: Partial<DshRuntimeOptions['web']>
}): Promise<{ events: RunEvent[]; uses: WebUse[]; endpoints: string[] }> {
  const uses: WebUse[] = []
  const endpoints: string[] = []
  const runtime = createDshRuntime({
    ...baseOptions({ gateway: input.gateway }),
    mode: input.mode ?? 'in-process',
    web: {
      searchBaseUrl: base,
      credential: async (endpoint) => {
        endpoints.push(endpoint)
        return input.credential
      },
      onUse: (use) => uses.push(use),
      ...input.extra,
    },
  })
  const { sink, events } = collect()
  await runtime.run(input.request, sink, new AbortController().signal)
  return { events, uses, endpoints }
}

const results = (events: RunEvent[]) =>
  events.filter((e): e is Extract<RunEvent, { type: 'tool.result' }> => e.type === 'tool.result')

describe('WP179 官方网页工具：进程内', () => {
  it('官方两个工具到了模型面前；搜索是官方请求形状、账号令牌走 x-dsh-auth-token', async () => {
    seen.length = 0
    status = 200
    const gateway = scripted([SEARCH])
    const { events, uses, endpoints } = await runWith({
      gateway,
      request: webRequest(),
      credential: { kind: 'account', token: 'acct-token-test' },
    })
    expect(gateway.requests[0]?.tools).toEqual(expect.arrayContaining(['web_search', 'web_fetch']))
    // 官方请求：发到 <base>/messages，只用账号令牌那一个头
    expect(seen).toHaveLength(1)
    const hit = seen[0] as Seen
    expect(hit.path).toBe('/anthropic/v1/messages')
    expect(hit.headers['x-dsh-auth-token']).toBe('acct-token-test')
    expect(hit.headers['x-api-key']).toBeUndefined()
    expect(hit.headers.authorization).toBeUndefined()
    expect(JSON.stringify(hit.body)).toContain(
      'Perform a web search for the query: 65W 氮化镓 充电器 2026 新品',
    )
    expect(hit.body.tools).toEqual([
      { type: 'web_search_20250305', name: 'web_search', max_uses: 5 },
    ])
    expect(endpoints).toEqual([`${base}/messages`])
    // 结果按官方渲染进了模型：外部内容提示 + 去重后的两条来源 + 引文摘要
    const second = gateway.requests[1]?.text ?? ''
    expect(second).toContain('External web content follows')
    expect(second).toContain('https://example.com/gan-65w')
    expect(second).toContain('体积小一半')
    expect(results(events).map((r) => r.status)).toEqual(['ok'])
    // 审计（一条工具调用一条）+ 用量（一条查询一条，标明账号）
    expect(uses).toEqual([
      {
        kind: 'search_usage',
        query: '65W 氮化镓 充电器 2026 新品',
        model: 'deepseek-v4-flash',
        credential: 'deepseek_account',
        results: 2,
        ok: true,
      },
      { kind: 'search', queries: ['65W 氮化镓 充电器 2026 新品'], results: 2, ok: true },
    ])
    // 令牌一个字都不进事件
    expect(JSON.stringify(events)).not.toContain('acct-token-test')
  })

  it('用户自己的 DeepSeek API key：照官方发 x-api-key + Bearer，用量标 key', async () => {
    seen.length = 0
    status = 200
    const { uses } = await runWith({
      gateway: scripted([SEARCH]),
      request: webRequest(),
      credential: { kind: 'api_key', key: 'sk-test-key' },
    })
    const hit = seen[0] as Seen
    expect(hit.headers['x-api-key']).toBe('sk-test-key')
    expect(hit.headers.authorization).toBe('Bearer sk-test-key')
    expect(hit.headers['x-dsh-auth-token']).toBeUndefined()
    expect(uses.find((u) => u.kind === 'search_usage')).toMatchObject({
      credential: 'deepseek_api_key',
      ok: true,
    })
  })

  it('账号令牌被拒（401）：官方的"请重新登录"进了工具结果，审计与用量都记失败', async () => {
    seen.length = 0
    status = 401
    const gateway = scripted([SEARCH])
    const { events, uses } = await runWith({
      gateway,
      request: webRequest(),
      credential: { kind: 'account', token: 'expired' },
    })
    status = 200
    expect(results(events).map((r) => r.status)).toEqual(['error'])
    expect(gateway.requests[1]?.text).toContain('sign in to DeepSeek again')
    expect(uses).toEqual([
      expect.objectContaining({ kind: 'search_usage', ok: false, credential: 'deepseek_account' }),
      expect.objectContaining({ kind: 'search', ok: false, results: 0 }),
    ])
  })

  it('没有凭据：官方报"缺凭据"，一个请求都不发、不记用量', async () => {
    seen.length = 0
    const { events, uses } = await runWith({ gateway: scripted([SEARCH]), request: webRequest() })
    expect(seen).toHaveLength(0)
    expect(results(events).map((r) => r.status)).toEqual(['error'])
    expect(uses.map((u) => u.kind)).toEqual(['search'])
  })

  it('抓网页用的是官方匿名抓取：本机地址在连接之前就拒（WEB_BLOCKED_URL），审计记下网址', async () => {
    const gateway = scripted([FETCH])
    const { events, uses } = await runWith({ gateway, request: webRequest() })
    expect(results(events).map((r) => r.status)).toEqual(['error'])
    expect(uses).toEqual([
      expect.objectContaining({ kind: 'fetch', url: 'http://127.0.0.1:9/private', ok: false }),
    ])
  })

  it('每条运行的次数上限：按查询条数算，超了拒这一次（一个请求都不多发）', async () => {
    seen.length = 0
    status = 200
    const gateway = scripted([
      { name: 'web_search', input: { queries: ['a', 'b'] } },
      { name: 'web_search', input: { queries: ['c'] } },
    ])
    const { events } = await runWith({
      gateway,
      request: webRequest({ web: { ...WEB, max_searches: 2 } }),
      credential: { kind: 'api_key', key: 'k' },
    })
    expect(seen).toHaveLength(2)
    const r = results(events)
    expect(r.map((x) => x.status)).toEqual(['ok', 'blocked'])
    expect(r[1]?.reason).toMatch(/^web_search_limit/)
  })

  it('白名单里没有的那个工具不挂到模型面前；开关关着的也一样', async () => {
    const onlySearch = scripted([])
    await runWith({ gateway: onlySearch, request: webRequest({ allow: ['web_search'] }) })
    expect(onlySearch.requests[0]?.tools).toContain('web_search')
    expect(onlySearch.requests[0]?.tools).not.toContain('web_fetch')
    const fetchOff = scripted([])
    await runWith({ gateway: fetchOff, request: webRequest({ web: { ...WEB, fetch: false } }) })
    expect(fetchOff.requests[0]?.tools).not.toContain('web_fetch')
  })

  it('没开网页工具的运行：一个网页工具都没有，提示词里也没有"网页"那一段', async () => {
    const gateway = scripted([])
    const request = makeRequest({ role_id: 'dtc.content', allow: ALLOW })
    await runWith({ gateway, request })
    expect(gateway.requests[0]?.tools).not.toContain('web_search')
    expect(gateway.requests[0]?.tools).not.toContain('web_fetch')
    expect(gateway.requests[0]?.text).not.toContain('## 网页')
    expect(webBrief(request)).toBe('')
    expect(maxStepsFor(request)).toBe(8)
  })

  it('替身后端：官方服务与工具照挂，结果来自替身；审计照记、不记用量', async () => {
    seen.length = 0
    const gateway = scripted([SEARCH, { name: 'web_fetch', input: { url: '' } }])
    const { events, uses } = await runWith({
      gateway,
      request: webRequest(),
      extra: {
        standIn: {
          search: async (q) => standInWebSearch(q),
          fetch: async (url) => standInWebFetch(url),
        },
      },
    })
    expect(seen).toHaveLength(0)
    expect(gateway.requests[1]?.text).toContain('https://example.com/')
    // 空网址被官方参数校验拒（`url must be a non-empty string`）
    expect(results(events).map((r) => r.status)).toEqual(['ok', 'error'])
    expect(uses.map((u) => u.kind)).toEqual(['search', 'fetch'])
  })

  it('读写分类：网页工具只读外部；提示词里写着次数上限', () => {
    expect(classifySideEffect('web_search')).toBe('read_external')
    expect(classifySideEffect('web_fetch')).toBe('read_external')
    const brief = webBrief(webRequest())
    expect(brief).toContain('最多搜 5 次')
    expect(brief).toContain('最多 10 个网页')
    expect(maxStepsFor(webRequest())).toBe(13)
  })
})

describe.runIf(subprocessAvailable())('WP179 官方网页工具：子进程档', () => {
  it('凭据经管道现取；审计与用量经通知回到宿主；令牌不进事件', async () => {
    seen.length = 0
    status = 200
    const gateway = scripted([SEARCH])
    const { events, uses, endpoints } = await runWith({
      gateway,
      request: webRequest(),
      credential: { kind: 'account', token: 'acct-token-sub' },
      mode: 'subprocess',
    })
    expect(events.find((e) => e.type === 'run.started')).toMatchObject({ runtime: 'dsh' })
    expect(seen[0]?.headers['x-dsh-auth-token']).toBe('acct-token-sub')
    expect(endpoints).toEqual([`${base}/messages`])
    expect(results(events).map((r) => r.status)).toEqual(['ok'])
    expect(uses.map((u) => u.kind)).toEqual(['search_usage', 'search'])
    expect(JSON.stringify(events)).not.toContain('acct-token-sub')
  })
})
