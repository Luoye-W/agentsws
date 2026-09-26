/**
 * WP150：DeepSeek 账号登录跟上官方 0.1.7-rc.2 的两条行为——**登录失效自动登出并提示**、
 * **登出前确认并停掉正在用账号跑的事**。
 *
 * 这份文件钉服务端里"不需要整个服务进程"的那几层（整条路 + 令牌守卫在 `deepseek-account.test.ts` 的 (b)）：
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (a) 那一次运行的失败原因 | 真 `createRuntime` + 真网关 + 账号 provider + 回 401 的替身 Messages 口 | 摘要 / `run.failed` 就是"登录过期了"那句人话；令牌报回了 `rejectToken` |
 * | (b) 运行登记与停下 | 真 `createRuntime` + 卡在半路的替身模型 | 开跑登记（绑的是哪条来源）、`stopRun` 先写原因再中断、等它收尾 |
 * | (c) 失效 | `createDeepSeekAccount` + demo 替身宿主 | 未登录 + `session_expired` + 停账号任务 + 摘来源；重启还在；重新登上清掉 |
 * | (d) 登出 | 同上 | 有在跑的：先停、再登出；没有：不停 |
 *
 * 全程替身，不联网。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ChatMessage,
  Clock,
  Completion,
  EventEnvelope,
  Matter,
  ModelRef,
  RunEvent,
} from '@agentsws/contracts'
import { createStandInDeepSeekAccountHost } from '@agentsws/dsh-adapter/deepseek-account-stand-in'
import {
  type AccountFetch,
  createModelGateway,
  DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE,
  DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
  deepseekAccountProvider,
  type ModelGatewayApi,
} from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDeepSeekAccount,
  DEEPSEEK_EXPIRED_STOPPED,
  DEEPSEEK_SESSION_EXPIRED,
  DEEPSEEK_SIGN_OUT_STOPPED,
} from '../src/deepseek-account.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'

vi.setConfig({ testTimeout: 30_000 })

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-dsa150-'))
  dirs.push(dir)
  return dir
}

async function until<T>(read: () => Promise<T> | T, ok: (v: T) => boolean, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const v = await read()
    if (ok(v)) return v
    if (Date.now() > deadline) throw new Error(`等不到：${JSON.stringify(v)}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const clock: Clock = { now: () => '2026-09-25T10:00:00.000Z' }
const ACCOUNT: ModelRef = { provider: 'deepseek-account', model: 'deepseek-flash', region: 'cn' }
const TOKEN = 'dsk_SECRET_wp150_runtime'

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '回复客户 Anna 的退货',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-09-25T09:00:00.000Z',
  updated_at: '2026-09-25T09:00:00.000Z',
} as unknown as Matter

const roles = {
  effectiveConfig: () => ({ role_id: 'dtc.support', grounding: [], skills: [], browser_scope: [] }),
  assignments: { get: () => undefined },
} as unknown as RoleStore

/** 一个只记东西的工作模型（运行时只用到这三样）。 */
function fakeWork() {
  const timeline: { matter_id: string; text: string; kind: string }[] = []
  const completed: { run_id: string; summary: string }[] = []
  const work = {
    appendEvent: (matter_id: string, e: { kind: string; text: string }) => {
      timeline.push({ matter_id, text: e.text, kind: e.kind })
    },
    onRunCompleted: (x: { run_id: string; summary: string }) => {
      completed.push({ run_id: x.run_id, summary: x.summary })
    },
    onCard: () => undefined,
  } as unknown as Work
  return { work, timeline, completed }
}

function runtimeWith(models: ModelGatewayApi, extra: Partial<RuntimeOptions> = {}) {
  const events: Omit<EventEnvelope, 'id' | 'at'>[] = []
  const runtime = createRuntime({
    workspace_id: 'ws_1',
    clock,
    random: () => 0.5,
    seed: 42,
    env: {},
    models,
    approvals: { create: async () => ({ id: 'apv_1' }) } as unknown as RuntimeOptions['approvals'],
    roles,
    appendEvent: (e) => events.push(e),
    prefer: 'direct',
    modelRef: () => ACCOUNT,
    ...extra,
  })
  const w = fakeWork()
  runtime.bind(w.work)
  const start = () =>
    runtime.startRun({
      matter,
      brief: '客户问退货进度',
      actor: { person_id: 'per_1', assignment_id: 'asg_1' },
    } as Parameters<typeof runtime.startRun>[0])
  const runEvents = (): RunEvent[] =>
    events
      .filter((e) => e.type.startsWith('run.'))
      .map((e) => ({ type: e.type, ...(e.payload as object) }) as RunEvent)
  return { runtime, events, runEvents, start, ...w }
}

// ── (a) 那一次运行的失败原因 ────────────────────────────────────────────

describe('WP150 (a) 推理 401：那一次运行给一句清楚的失败原因', () => {
  it('摘要与 run.failed 就是"登录过期了"那句人话；令牌报回 rejectToken；事件里没有令牌', async () => {
    const rejected: string[] = []
    const fetch: AccountFetch = async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => 'unauthorized',
    })
    const provider = deepseekAccountProvider({
      resolveToken: async (url) =>
        new URL(url).origin === 'https://api.deepseek.com' ? TOKEN : undefined,
      rejectToken: async (t) => {
        rejected.push(t)
      },
      fetch,
      provider: ACCOUNT.provider,
    })
    const gateway = createModelGateway({
      providers: [provider],
      policy: {
        default: ACCOUNT,
        data_residency: 'cn',
        prices: { 'deepseek-account/deepseek-flash': { in: 0, out: 0, cached: 0 } },
      },
      clock,
      env: {},
      eventSink: () => {},
    })
    const r = runtimeWith(gateway as unknown as ModelGatewayApi)
    const { run_id } = await r.start()
    expect(r.completed).toEqual([{ run_id, summary: DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE }])
    const failed = r.runEvents().find((e) => e.type === 'run.failed')
    expect(failed).toMatchObject({
      type: 'run.failed',
      error: { code: 'unauthenticated', message: DEEPSEEK_ACCOUNT_EXPIRED_MESSAGE },
    })
    expect(rejected).toEqual([TOKEN])
    expect(JSON.stringify(r.events)).not.toContain(TOKEN)
    // 跑完就不在"正在跑"里了
    expect(r.runtime.activeRuns()).toEqual([])
  })
})

// ── (b) 运行登记与停下 ────────────────────────────────────────────────

/** 第一次调用卡住，直到外面放行；放行后回一个工具调用（这样循环还会往下走、看得见中断）。 */
function stuckGateway() {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const done = (c: Partial<Completion>): Completion => ({
    text: '',
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
    model: ACCOUNT,
    static_prefix_hash: 'p',
    ...c,
  })
  const models = {
    async complete(_req: { messages: ChatMessage[] }) {
      calls += 1
      if (calls === 1) {
        await gate
        return done({ tool_calls: [{ id: 'c1', name: 'search_policies', input: {} }] })
      }
      return done({ text: '好了' })
    },
    async embed() {
      return []
    },
    usage() {
      return {}
    },
    budget() {
      return {}
    },
  } as unknown as ModelGatewayApi
  return { models, release: () => release(), calls: () => calls }
}

describe('WP150 (b) 运行登记：开跑登记绑的来源，stopRun 先写原因再中断', () => {
  it('在跑时列得出来（事项名 + 绑的来源）；停下：时间线写原因、运行 cancelled、等它收尾', async () => {
    const g = stuckGateway()
    const other: ModelRef = { provider: 'qwen', model: 'qwen-vl', region: 'cn' }
    // runModelRef 优先于默认：按 purpose 覆盖过就认覆盖的那条
    const r = runtimeWith(g.models, { modelRef: () => other, runModelRef: () => ACCOUNT })
    const running = r.start()
    const listed = await until(
      () => r.runtime.activeRuns(),
      (v) => v.length === 1,
    )
    expect(listed[0]).toMatchObject({
      matter_id: 'mat_1',
      title: '回复客户 Anna 的退货',
      model: ACCOUNT,
    })
    const run_id = listed[0]?.run_id ?? ''
    const stopping = r.runtime.stopRun(run_id, DEEPSEEK_SIGN_OUT_STOPPED)
    // 原因先写进时间线（中断之前）
    expect(r.timeline.map((t) => t.text)).toContain(DEEPSEEK_SIGN_OUT_STOPPED)
    g.release()
    expect(await stopping).toBe(true)
    await running
    expect(r.runtime.activeRuns()).toEqual([])
    expect(r.runEvents().map((e) => e.type)).toContain('run.cancelled')
    expect(g.calls()).toBe(1) // 停下之后一次模型都没再问
    // 已经跑完的再停：找不到，回 false
    expect(await r.runtime.stopRun(run_id, 'x')).toBe(false)
  })

  it('没接模型（stub）的运行不算"在用某条来源跑"：不去问它绑的是哪条', async () => {
    const g = stuckGateway()
    const runModelRef = vi.fn(() => ACCOUNT)
    const r = runtimeWith(g.models, { prefer: 'stub', runModelRef })
    await r.start()
    expect(runModelRef).not.toHaveBeenCalled()
    expect(r.runtime.activeRuns()).toEqual([])
  })
})

// ── (c) 失效 / (d) 登出 ────────────────────────────────────────────────

const TASKS = [{ run_id: 'run_1', matter_id: 'mat_1', title: '回复客户 Anna 的退货' }]

function assembly(dir: string, opts: { tasks?: typeof TASKS } = {}) {
  const stand = createStandInDeepSeekAccountHost()
  const order: string[] = []
  const signOut = stand.signOut
  stand.signOut = async () => {
    order.push('signOut')
    return signOut()
  }
  const stop = vi.fn(async (reason: string) => {
    order.push(`stop:${reason}`)
  })
  const onExpired = vi.fn(async () => {
    order.push('onExpired')
  })
  const make = () =>
    createDeepSeekAccount({
      runtimeMode: () => 'local',
      dbDir: dir,
      callbackOrigin: () => 'http://127.0.0.1:4999',
      createHost: async () => stand,
      signOutGraceMs: 0,
      tasks: { list: () => opts.tasks ?? [], stop },
      onExpired,
      now: () => '2026-09-25T10:00:00.000Z',
    })
  const acct = make()
  const login = async (a = acct) => {
    const started = await a.login()
    const url = new URL(started.attempt?.authorize_url ?? '')
    stand.handle(
      { url: `${url.pathname}${url.search}` } as never,
      { writeHead: () => ({ end: () => undefined }) } as never,
    )
    return until(
      () => a.view(),
      (v) => v.signed_in,
    )
  }
  return { stand, acct, make, login, stop, onExpired, order }
}

describe('WP150 (c) 登录失效：未登录 + 一句人话 + 停账号任务 + 摘来源', () => {
  it('官方说失效了 → 卡片"登录过期了"、停掉在跑的账号任务、再摘来源；模块不摘', async () => {
    const dir = tempDir()
    const a = assembly(dir, { tasks: TASKS })
    const signed = await a.login()
    expect(signed.session_expired).toBeUndefined()
    expect(signed.running_tasks).toEqual(TASKS)

    a.stand.expire()
    const view = await until(
      () => a.acct.view(),
      (v) => v.session_expired !== undefined,
    )
    expect(view.signed_in).toBe(false)
    expect(view.enabled).toBe(true) // 用户多半马上要点"重新登录"
    expect(view.session_expired).toEqual({
      at: '2026-09-25T10:00:00.000Z',
      message: DEEPSEEK_SESSION_EXPIRED,
    })
    expect(view.running_tasks).toBeUndefined()
    expect(a.acct.signedIn()).toBe(false)
    await until(
      () => a.order,
      (o) => o.includes('onExpired'),
    )
    expect(a.order).toEqual([`stop:${DEEPSEEK_EXPIRED_STOPPED}`, 'onExpired'])
    expect(await a.acct.resolveToken('https://api.deepseek.com/anthropic')).toBeUndefined()
    // 落盘：重启之后那句话还在
    expect(JSON.parse(readFileSync(join(dir, 'deepseek-account.json'), 'utf8'))).toEqual({
      version: 1,
      enabled: true,
      expired_at: '2026-09-25T10:00:00.000Z',
    })
    const again = a.make()
    await again.resume()
    expect((await again.view()).session_expired?.message).toBe(DEEPSEEK_SESSION_EXPIRED)
    await again.close()

    // 点"重新登录"（起登录那一下不清）→ 真登上了才清
    const restarted = await a.acct.login()
    expect(restarted.session_expired?.message).toBe(DEEPSEEK_SESSION_EXPIRED)
    const url = new URL(restarted.attempt?.authorize_url ?? '')
    a.stand.handle(
      { url: `${url.pathname}${url.search}` } as never,
      { writeHead: () => ({ end: () => undefined }) } as never,
    )
    const back = await until(
      () => a.acct.view(),
      (v) => v.signed_in,
    )
    expect(back.session_expired).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'deepseek-account.json'), 'utf8'))).toEqual({
      version: 1,
      enabled: true,
    })
    await a.acct.close()
  })

  it('推理 401 经 rejectToken：对得上的令牌才失效；旧令牌不动新登录', async () => {
    const a = assembly(tempDir())
    await a.login()
    await a.acct.rejectToken('dsk_old_one')
    expect(a.acct.signedIn()).toBe(true)
    const token = (await a.acct.resolveToken('https://api.deepseek.com/anthropic')) ?? ''
    await a.acct.rejectToken(token)
    const view = await until(
      () => a.acct.view(),
      (v) => v.session_expired !== undefined,
    )
    expect(view.signed_in).toBe(false)
    await until(
      () => a.onExpired.mock.calls.length,
      (n) => n === 1,
    )
    await a.acct.close()
  })

  it('手动登出不是失效：没有"登录过期了"，也不调 onExpired', async () => {
    const a = assembly(tempDir())
    await a.login()
    await a.acct.signOut()
    const view = await a.acct.view()
    expect(view.session_expired).toBeUndefined()
    expect(a.onExpired).not.toHaveBeenCalled()
  })
})

describe('WP150 (d) 登出前停任务', () => {
  it('有在用这个账号跑的：先停（时间线写"登出了"那句）、再登出', async () => {
    const a = assembly(tempDir(), { tasks: TASKS })
    await a.login()
    await a.acct.signOut()
    expect(a.order).toEqual([`stop:${DEEPSEEK_SIGN_OUT_STOPPED}`, 'signOut'])
    expect(a.acct.signedIn()).toBe(false)
  })

  it('没有在跑的：不停，照常登出', async () => {
    const a = assembly(tempDir())
    await a.login()
    expect((await a.acct.view()).running_tasks).toBeUndefined()
    await a.acct.signOut()
    expect(a.stop).not.toHaveBeenCalled()
    expect(a.order).toEqual(['signOut'])
  })

  it('登出也清掉之前那一笔"登录过期了"', async () => {
    const dir = tempDir()
    const a = assembly(dir)
    await a.login()
    a.stand.expire()
    await until(
      () => a.acct.view(),
      (v) => v.session_expired !== undefined,
    )
    await a.acct.signOut()
    expect((await a.acct.view()).session_expired).toBeUndefined()
    expect(JSON.parse(readFileSync(join(dir, 'deepseek-account.json'), 'utf8'))).toEqual({
      version: 1,
      enabled: false,
    })
  })
})

// ── WP151：余额不足（那一次运行的失败原因；不是失效） ─────────────────────

describe('WP151 推理 402：那一次运行说"账号余额不足"，登录不动', () => {
  it('摘要与 run.failed 就是那句人话；不报 rejectToken；账号那一块记下"余额不足"、登录状态不变', async () => {
    const a = assembly(tempDir())
    await a.login()
    const rejected: string[] = []
    const fetch: AccountFetch = async () => ({
      ok: false,
      status: 402,
      json: async () => ({}),
      text: async () => JSON.stringify({ error: { message: 'Insufficient Balance' } }),
    })
    const provider = deepseekAccountProvider({
      resolveToken: (url) => a.acct.resolveToken(url),
      rejectToken: async (t) => {
        rejected.push(t)
      },
      onBalance: (b) => a.acct.reportBalance(b),
      fetch,
      provider: ACCOUNT.provider,
    })
    const gateway = createModelGateway({
      providers: [provider],
      policy: {
        default: ACCOUNT,
        data_residency: 'cn',
        prices: { 'deepseek-account/deepseek-flash': { in: 0, out: 0, cached: 0 } },
      },
      clock,
      env: {},
      eventSink: () => {},
    })
    const r = runtimeWith(gateway as unknown as ModelGatewayApi)
    const { run_id } = await r.start()
    expect(r.completed).toEqual([{ run_id, summary: DEEPSEEK_ACCOUNT_QUOTA_MESSAGE }])
    expect(r.runEvents().find((e) => e.type === 'run.failed')).toMatchObject({
      error: { code: 'provider_error', message: DEEPSEEK_ACCOUNT_QUOTA_MESSAGE },
    })
    expect(rejected).toEqual([])
    // 不是失效：还登录着，没有"登录过期了"，也没走失效收尾
    expect(a.acct.signedIn()).toBe(true)
    expect(a.onExpired).not.toHaveBeenCalled()
    expect(a.acct.quota()).toEqual({
      at: '2026-09-25T10:00:00.000Z',
      message: DEEPSEEK_ACCOUNT_QUOTA_MESSAGE,
      top_up_url: 'https://platform.deepseek.com/top_up',
    })
    // 替身钱包有钱（¥42.50）：余额一刷新，那一行就收了
    const v = await a.acct.view()
    expect(v.session_expired).toBeUndefined()
    expect(v.quota_exceeded).toBeUndefined()
    expect(a.acct.quota()).toBeUndefined()
    await a.acct.close()
  })

  it('钱包是 0：刷新余额也不收；登出清掉', async () => {
    const a = assembly(tempDir())
    await a.login()
    a.stand.setBalance('empty')
    a.acct.reportBalance(true)
    const v = await a.acct.view()
    expect(v.quota_exceeded?.message).toBe(DEEPSEEK_ACCOUNT_QUOTA_MESSAGE)
    await a.acct.signOut()
    expect(a.acct.quota()).toBeUndefined()
  })
})
