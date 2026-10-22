/**
 * WP476：匿名使用数据（服务进程这一侧）。**全程不联网**：出门的 fetch 一律是替身，测试进程里不塞替身就整套不发。
 *
 * | 钉的是什么 | 为什么 |
 * |---|---|
 * | 没有上报地址 → 一个请求都不发；测试进程里有地址但没塞替身 → 也不发 | 开发 / 测试期间一条都不许出门 |
 * | 云上没给 key（`key: null`）→ 不发 | 没配 key 整套不发 |
 * | 运行收尾只出档（成败、花费档、缓存档、内置职责 / 岗位、失败码）；自建职责记 `custom` | 业务内容出不了门 |
 * | 卡片定了只出类型与通过 / 改了 / 驳回；卡上的标题、正文一个字都不出 | 同上 |
 * | 关掉开关 → 手上的扔掉、之后不再发；开关与匿名设备号落盘 | 用户知情、可关 |
 * | `/v1/settings/telemetry` 看 / 改；有地址 + key 才给工作台 SDK 配置 | 工作台只认这一处 |
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { TELEMETRY_COMMON_PROPS, TELEMETRY_EVENTS, TELEMETRY_SDK_PROPS } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import {
  createTelemetry,
  decodeIngestBody,
  type TelemetryFetch,
  telemetryHost,
} from '../src/telemetry.js'

const HOST = 'https://t.example.test'
const KEY = 'phc_testkey0123456789abcdef'

/** 业务内容样本：任何一条都不许出现在发出去的请求体里。 */
const SECRETS = [
  '您好 Anna，订单 #10023 的退款已处理',
  'Acme Trading',
  'anna@example.com',
  'NordVolt 65W 充电器',
  'dtc.acme-glasses',
  'pos_custom_acme',
  '今天的复盘：你处理 0 张',
]

interface Sent {
  url: string
  method: string
  body: string | undefined
}

function fakeFetch(config: { key: string | null; replay?: boolean } | 'down' = { key: KEY }) {
  const sent: Sent[] = []
  const fn: TelemetryFetch = async (url, init) => {
    sent.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    if (url.endsWith('/config')) {
      if (config === 'down') throw new Error('offline')
      return new Response(JSON.stringify(config), { status: 200 })
    }
    return new Response('{"status":"Ok"}', { status: 200 })
  }
  return { fn, sent, batches: () => sent.filter((s) => s.url.endsWith('/batch/')) }
}

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp476-'))
  dirs.push(d)
  return d
}
let server: Server | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  vi.restoreAllMocks()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const now = () => '2026-10-22T08:00:00.000Z'
const BUILTIN_ROLES = new Set(['dtc.customer-care'])
const BUILTIN_POSITIONS = new Set(['dtc-support'])
const PLACES: Record<string, { role_id: string; position_id: string }> = {
  asg_builtin: { role_id: 'dtc.customer-care', position_id: 'dtc-support' },
  asg_custom: { role_id: 'dtc.acme-glasses', position_id: 'pos_custom_acme' },
}

function make(fetcher: TelemetryFetch | undefined, env: Record<string, string> = {}, dir?: string) {
  return createTelemetry({
    env: { AGENTSWS_TELEMETRY_HOST: HOST, ...env },
    now,
    ...(fetcher === undefined ? {} : { fetch: fetcher }),
    ...(dir === undefined ? {} : { dir }),
    appVersion: '0.2.1-beta.5',
    accountId: () => 'org_3f9a0c1d2e',
    placeOf: (id) => PLACES[id],
    bundledRoleIds: () => BUILTIN_ROLES,
    bundledPositionIds: () => BUILTIN_POSITIONS,
    flushIntervalMs: 0,
  })
}

const runEvents = (
  run_id: string,
  assignment: string,
  end: 'completed' | 'failed' | 'cancelled',
) => [
  {
    type: 'run.started',
    actor: { kind: 'agent' as const, id: assignment, run_id },
    correlation: { trace_id: 't', run_id },
    payload: { request_id: run_id, runtime: 'dsh', model: { provider: 'deepseek', id: 'x' } },
  },
  end === 'completed'
    ? {
        type: 'run.completed',
        actor: { kind: 'agent' as const, id: assignment, run_id },
        correlation: { trace_id: 't', run_id },
        payload: {
          usage: {
            input_tokens: 1000,
            output_tokens: 200,
            cached_tokens: 800,
            tool_calls: 2,
            seconds: 9,
            cost_base: 0.05,
          },
          outputs: [{ kind: 'answer', text: SECRETS[0] }],
          summary: `回了 ${SECRETS[1]} 的 ${SECRETS[2]}`,
        },
      }
    : end === 'failed'
      ? {
          type: 'run.failed',
          actor: { kind: 'agent' as const, id: assignment, run_id },
          correlation: { trace_id: 't', run_id },
          payload: {
            error: { code: 'MODEL_TIMEOUT', message: `${SECRETS[3]} 超时`, retryable: true },
          },
        }
      : {
          type: 'run.cancelled',
          actor: { kind: 'agent' as const, id: assignment, run_id },
          correlation: { trace_id: 't', run_id },
          payload: { reason: 'user' },
        },
]

const ALLOWED = new Set([
  ...Object.values(TELEMETRY_EVENTS).flatMap((p) => Object.keys(p)),
  ...Object.keys(TELEMETRY_COMMON_PROPS),
  ...Object.keys(TELEMETRY_SDK_PROPS),
])

function assertClean(bodies: (string | undefined)[]): void {
  for (const body of bodies) {
    expect(body).toBeDefined()
    for (const s of SECRETS) expect(body).not.toContain(s)
    const parsed = JSON.parse(body as string) as {
      api_key: string
      batch: { event: string; properties: Record<string, unknown> }[]
    }
    for (const e of parsed.batch) {
      expect(Object.keys(TELEMETRY_EVENTS)).toContain(e.event)
      for (const key of Object.keys(e.properties)) expect(ALLOWED, key).toContain(key)
    }
  }
}

describe('WP476 没配置就一条都不发', () => {
  it('上报地址：没配 / off / 不是网址都当没有', () => {
    expect(telemetryHost({})).toBeUndefined()
    expect(telemetryHost({ AGENTSWS_TELEMETRY_HOST: 'off' })).toBeUndefined()
    expect(telemetryHost({ AGENTSWS_TELEMETRY_HOST: 'not a url' })).toBeUndefined()
    expect(telemetryHost({ AGENTSWS_TELEMETRY_HOST: 'https://t.agentsws.com/x/' })).toBe(
      'https://t.agentsws.com',
    )
  })

  it('没有地址：开关照常能开关，但一个请求都不发', async () => {
    const f = fakeFetch()
    const t = createTelemetry({ env: {}, now, fetch: f.fn, flushIntervalMs: 0 })
    for (const e of runEvents('run_1', 'asg_builtin', 'completed')) t.onEvent(e)
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved' })
    await t.flush()
    const v = await t.view()
    expect(v).toMatchObject({ enabled: true, configured: false, active: false })
    expect(v.client).toBeUndefined()
    expect(f.sent).toEqual([])
  })

  it('测试进程里有地址、没塞替身：不发（全局 fetch 一次都没被叫）', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    const t = createTelemetry({
      env: { AGENTSWS_TELEMETRY_HOST: HOST, VITEST: 'true' },
      now,
      flushIntervalMs: 0,
    })
    for (const e of runEvents('run_1', 'asg_builtin', 'completed')) t.onEvent(e)
    await t.flush()
    expect((await t.view()).configured).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })

  it('云上没给 key（或给的不像 key）：不加载、不发', async () => {
    for (const key of [null, 'not-a-key']) {
      const f = fakeFetch({ key })
      const t = make(f.fn)
      for (const e of runEvents('run_1', 'asg_builtin', 'completed')) t.onEvent(e)
      await t.flush()
      expect(await t.view()).toMatchObject({ configured: true, active: false })
      expect(f.batches()).toEqual([])
    }
  })

  it('云上那一跳不通：不发，过一阵再问', async () => {
    const f = fakeFetch('down')
    const t = make(f.fn)
    for (const e of runEvents('run_1', 'asg_builtin', 'completed')) t.onEvent(e)
    await t.flush()
    expect((await t.view()).active).toBe(false)
    expect(f.batches()).toEqual([])
    // 失败后 10 分钟内不再追着问
    expect(f.sent.filter((s) => s.url.endsWith('/config'))).toHaveLength(1)
  })
})

describe('WP476 配好了：只出白名单里的档位与编号', () => {
  it('工作台拿到地址与 key；匿名设备号与账号 id，没有邮箱', async () => {
    const f = fakeFetch({ key: KEY, replay: false })
    const v = await make(f.fn).view()
    expect(v).toMatchObject({
      enabled: true,
      configured: true,
      active: true,
      // 工作台只跟本机说话：api_host 是本机的转发口，不是外网地址
      client: { api_host: '/v1/telemetry', key: KEY, replay: false },
      account_id: 'org_3f9a0c1d2e',
    })
    expect(v.install_id).toMatch(/^ins_[a-f0-9]{32}$/)
    expect(JSON.stringify(v)).not.toContain('@')
  })

  it('运行收尾：成败、花费档、缓存档、内置职责 / 岗位；自建的记 custom；正文、摘要、报错文字都不出门', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    for (const e of [
      ...runEvents('run_1', 'asg_builtin', 'completed'),
      ...runEvents('run_2', 'asg_custom', 'failed'),
      ...runEvents('run_3', 'asg_builtin', 'cancelled'),
    ])
      t.onEvent(e)
    await t.flush()
    const [batch] = f.batches()
    assertClean([batch?.body])
    const parsed = JSON.parse(batch?.body ?? '{}') as {
      api_key: string
      batch: { event: string; properties: Record<string, unknown>; timestamp: string }[]
    }
    expect(parsed.api_key).toBe(KEY)
    expect(batch?.url).toBe(`${HOST}/batch/`)
    const common = {
      shell: 'server',
      app_version: '0.2.1-beta.5',
      account_id: 'org_3f9a0c1d2e',
      $lib: 'agentsws-server',
      $process_person_profile: false,
    }
    expect(parsed.batch.map((e) => e.properties)).toEqual([
      expect.objectContaining({
        ...common,
        outcome: 'success',
        cost_tier: 'mid',
        cache_tier: 'high',
        role_id: 'dtc.customer-care',
        position_id: 'dtc-support',
        runtime: 'dsh',
      }),
      expect.objectContaining({
        ...common,
        outcome: 'failure',
        role_id: 'custom',
        position_id: 'custom',
        error_code: 'model_timeout',
      }),
      expect.objectContaining({ ...common, outcome: 'cancelled', role_id: 'dtc.customer-care' }),
    ])
    for (const e of parsed.batch) {
      expect(e.event).toBe('task_finished')
      expect(e.properties.distinct_id).toBe(e.properties.install_id)
    }
  })

  it('卡片定了：只有类型与通过 / 改了再过 / 驳回', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved' })
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved_edited' })
    t.onCardDecided({ kind: 'staged_change', state: 'rejected' })
    t.onCardDecided({ kind: 'review', state: 'deferred' })
    // 卡的类型若不是代码里的编号（不该发生），这一格整格丢掉
    t.onCardDecided({ kind: SECRETS[1] as string, state: 'approved' })
    await t.flush()
    const [batch] = f.batches()
    assertClean([batch?.body])
    const props = (
      JSON.parse(batch?.body ?? '{}') as { batch: { properties: Record<string, unknown> }[] }
    ).batch.map((e) => [e.properties.decision, e.properties.card_kind])
    expect(props).toEqual([
      ['approve', 'outbound_draft'],
      ['edit', 'outbound_draft'],
      ['reject', 'staged_change'],
      ['other', 'review'],
      ['approve', undefined],
    ])
  })

  it('关掉：手上的扔掉、之后不再发；开关与设备号落盘，重启还在', async () => {
    const dir = tmp()
    const f = fakeFetch()
    const t = make(f.fn, {}, dir)
    const first = await t.view()
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved' })
    const off = await t.update({ enabled: false })
    expect(off).toMatchObject({ enabled: false, active: false })
    expect(off.client).toBeUndefined()
    t.onCardDecided({ kind: 'outbound_draft', state: 'approved' })
    for (const e of runEvents('run_9', 'asg_builtin', 'completed')) t.onEvent(e)
    await t.flush()
    expect(f.batches()).toEqual([])

    await t.update({ notice_seen: true })
    const stored = JSON.parse(readFileSync(join(dir, 'telemetry.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(stored).toEqual({ enabled: false, notice_seen: true, install_id: first.install_id })
    const again = await make(f.fn, {}, dir).view()
    expect(again).toMatchObject({
      enabled: false,
      notice_seen: true,
      install_id: first.install_id,
    })
  })
})

/** 一条 posthog-js 生成的事件（属性里混着 SDK 自己加的与业务内容）。 */
const sdkEvent = (event: string, extra: Record<string, unknown> = {}, token = KEY) => ({
  uuid: '0192f3a4-5b6c-7d8e-9f01-23456789abcd',
  event,
  timestamp: '2026-10-22T08:00:00.000Z',
  properties: {
    token,
    distinct_id: 'ins_0123456789abcdef0123456789abcdef',
    $current_url: 'http://127.0.0.1:4317/positions/a_9f3/duties/dtc.support?draft=hello',
    $pathname: '/positions/:assignment/duties/:role_id',
    $referrer: 'https://mail.example.com/?to=anna@example.com',
    $raw_user_agent: 'Mozilla/5.0',
    $os: 'Mac OS X',
    route: '/positions/:assignment/duties/:role_id',
    note: SECRETS[0],
    ...extra,
  },
  $set_once: { $initial_current_url: 'http://127.0.0.1:4317/?customer=Acme%20Trading' },
})
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('WP476 工作台经本机转发', () => {
  it('三种编法都解得开：JSON、gzip、data=<base64>', () => {
    const payload = [{ event: 'app_opened', properties: { token: KEY } }]
    const json = JSON.stringify(payload)
    expect(decodeIngestBody(bytes(json), new URLSearchParams())).toEqual(payload)
    expect(decodeIngestBody(gzipSync(json), new URLSearchParams('compression=gzip-js'))).toEqual(
      payload,
    )
    const form = `data=${encodeURIComponent(Buffer.from(json).toString('base64'))}`
    expect(decodeIngestBody(bytes(form), new URLSearchParams('compression=base64'))).toEqual(
      payload,
    )
  })

  it('再过一遍白名单：只留清单里的事件与属性；key 对不上的整条丢；转给 <地址>/batch/', async () => {
    const f = fakeFetch()
    const t = make(f.fn)
    const body = JSON.stringify([
      sdkEvent('$pageview'),
      sdkEvent('ui_click', { button_id: 'assistant.send', customer: SECRETS[1] }),
      sdkEvent('$autocapture', { $el_text: SECRETS[3] }),
      sdkEvent('ui_click', { button_id: 'nav.settings' }, 'phc_someone_elses_key_000'),
    ])
    const reply = await t.ingest({ kind: 'e', query: '?ver=1.438.8', body: bytes(body) })
    expect(reply).toEqual({ status: 200, body: '{"status":1}' })
    const [batch] = f.batches()
    assertClean([batch?.body])
    const parsed = JSON.parse(batch?.body ?? '{}') as {
      api_key: string
      batch: { event: string; properties: Record<string, unknown>; uuid?: string }[]
    }
    expect(parsed.api_key).toBe(KEY)
    expect(parsed.batch.map((e) => [e.event, e.properties.button_id])).toEqual([
      ['$pageview', undefined],
      ['ui_click', 'assistant.send'],
    ])
    for (const e of parsed.batch) {
      expect(e.properties.$current_url).toBeUndefined()
      expect(e.properties.distinct_id).toBe('ins_0123456789abcdef0123456789abcdef')
      expect(e).not.toHaveProperty('$set_once')
    }
  })

  it('没配置 / 关了 / 云上没给 key：照答不收，一个请求都不转', async () => {
    const body = bytes(JSON.stringify([sdkEvent('$pageview')]))
    const none = fakeFetch()
    const t1 = createTelemetry({ env: {}, now, fetch: none.fn, flushIntervalMs: 0 })
    expect(await t1.ingest({ kind: 'e', query: '', body })).toEqual({
      status: 200,
      body: '{"status":1}',
    })
    expect(none.sent).toEqual([])
    const nokey = fakeFetch({ key: null })
    await make(nokey.fn).ingest({ kind: 'e', query: '', body })
    expect(nokey.batches()).toEqual([])
    const off = fakeFetch()
    const t3 = make(off.fn)
    await t3.update({ enabled: false })
    await t3.ingest({ kind: 'e', query: '', body })
    expect(off.batches()).toEqual([])
  })

  it('录屏没开：录屏事件、远程配置、功能开关一律不转', async () => {
    const f = fakeFetch({ key: KEY, replay: false })
    const t = make(f.fn)
    await t.ingest({
      kind: 's',
      query: '',
      body: bytes(JSON.stringify([sdkEvent('$snapshot', { $snapshot_data: [{ type: 2 }] })])),
    })
    expect((await t.ingest({ kind: 'config', query: '', body: bytes('') })).status).toBe(404)
    expect((await t.ingest({ kind: 'flags', query: '', body: bytes('{}') })).status).toBe(404)
    expect(f.sent.filter((s) => !s.url.endsWith('/config'))).toEqual([])
  })

  it('解不开的请求体：当没收到', async () => {
    const f = fakeFetch()
    const reply = await make(f.fn).ingest({ kind: 'e', query: '', body: bytes('not json {') })
    expect(reply.status).toBe(200)
    expect(f.batches()).toEqual([])
  })
})

describe('WP476 服务进程里装好了', () => {
  async function boot(env: Record<string, string>, fetcher: TelemetryFetch) {
    server = await createServer({
      dbDir: tmp(),
      quiet: true,
      env,
      telemetryFetch: fetcher,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
    })
    return server
  }
  const call = async (method: string, path: string, body?: unknown) => {
    const s = server as Server
    const headers = new Headers({
      Authorization: `Bearer ${s.bootstrap.internalToken}`,
      'X-Assignment': s.bootstrap.ownerAssignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    return (await res.json()) as { data?: Record<string, unknown>; code?: string }
  }

  it('没配地址（开发 / 测试 / 自建）：设置能看能改，一个请求都不发', async () => {
    const f = fakeFetch()
    await boot({}, f.fn)
    const got = await call('GET', '/v1/settings/telemetry')
    expect(got.data).toMatchObject({
      enabled: true,
      notice_seen: false,
      configured: false,
      active: false,
    })
    const put = await call('PUT', '/v1/settings/telemetry', { enabled: false, notice_seen: true })
    expect(put.data).toMatchObject({ enabled: false, notice_seen: true })
    await server?.telemetry.flush()
    expect(f.sent).toEqual([])
  })

  it('配了地址 + key：工作台拿得到配置；卡片定了经审批总线记一条，卡上的字不出门', async () => {
    const f = fakeFetch()
    const s = await boot({ AGENTSWS_TELEMETRY_HOST: HOST }, f.fn)
    const got = await call('GET', '/v1/settings/telemetry')
    expect(got.data).toMatchObject({
      active: true,
      client: { api_host: '/v1/telemetry', key: KEY },
    })

    const me = s.bootstrap.person.id
    const card = await s.approvals.create({
      workspace_id: s.bootstrap.workspace.id,
      schema_version: 1,
      kind: 'review',
      role_id: 'common.member',
      subject: { object: { type: 'review', id: 'rev_wp476' } },
      dedupe_key: 'wp476:review',
      title: SECRETS[6],
      summary: SECRETS[0],
      payload: {
        cards: { ai_handled: 0, you_handled: 0, auto_sent: 0, blocked: 0 },
        todos: { done: 0, total: 0, completion_pct: 100 },
        meetings: { count: 0, outputs: 0 },
      },
      evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
      proposer: { kind: 'system', id: 'work.reviewer' },
      automation: { level_at_creation: 'L1' },
      routing: {
        recipients: [{ person: me, via: 'role_holder' }],
        rule: 'role_holder',
        escalation: { after_hours: 24, business_hours: true, chain: ['owner'], escalated_at: [] },
        separation_of_duties: false,
      },
      priority: 'queue',
    } as never)
    const token = [...(card.deliveries ?? [])].reverse().find((d) => d.to === me)?.decision_token
    await s.approvals.decide(card.id, me, {
      action: 'reject',
      // 驳回理由是人写的字：也不许出门
      reason: SECRETS[3],
      decision_token: token as string,
      via: 'workstation',
    } as never)
    await s.telemetry.flush()
    const batches = f.batches()
    expect(batches).toHaveLength(1)
    assertClean(batches.map((b) => b.body))
    const events = (
      JSON.parse(batches[0]?.body ?? '{}') as {
        batch: { event: string; properties: Record<string, unknown> }[]
      }
    ).batch
    expect(events.map((e) => [e.event, e.properties.decision, e.properties.card_kind])).toEqual([
      ['card_decided', 'reject', 'review'],
    ])
  })
  it('posthog-js 打到本机 /v1/telemetry/e/（不带令牌）：收下、再查一遍、转出去', async () => {
    const f = fakeFetch()
    const s = await boot({ AGENTSWS_TELEMETRY_HOST: HOST }, f.fn)
    const res = await s.gateway.fetch(
      new Request('http://127.0.0.1/v1/telemetry/e/?ip=0&ver=1.438.8', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([sdkEvent('ui_click', { button_id: 'assistant.send' })]),
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 1 })
    const batches = f.batches()
    expect(batches).toHaveLength(1)
    assertClean(batches.map((b) => b.body))
  })
})
