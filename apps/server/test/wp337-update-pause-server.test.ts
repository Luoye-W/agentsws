/**
 * WP337：真运行时 + 真服务进程两层。
 *
 * | 组 | 用什么 | 钉什么 |
 * |---|---|---|
 * | (d) 运行停在安全点 | 真 `createRuntime` + 卡在半路的替身模型 | `pauseRun`：时间线记「因更新暂停」（不是「被停下了」）、运行 cancelled、登记里有谁起的 |
 * | (e) 路由 + 重启 | 真 `createServer` 两次用同一个目录 | `/v1/update/readiness` 数得出定时；`pause` 落盘；新进程开机读回、接着做、只一次；`resume` 放开 |
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, Clock, Completion, Matter, ModelRef } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { RoleStore } from '@agentsws/roles'
import type { Work } from '@agentsws/work'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { createRuntime, type RuntimeOptions } from '../src/runtime.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { UPDATE_PAUSE_FILE } from '../src/update-pause.js'

vi.setConfig({ testTimeout: 60_000 })

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const clock: Clock = { now: () => '2026-10-15T10:00:00.000Z' }
const MODEL: ModelRef = { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' }

const matter = {
  id: 'mat_1',
  schema_version: 1,
  workspace_id: 'ws_1',
  kind: 'task',
  title: '回复客户 Anna 的退货',
  status: 'open',
  context: { summary: '', pinned: [] },
  created_at: '2026-10-15T09:00:00.000Z',
  updated_at: '2026-10-15T09:00:00.000Z',
} as unknown as Matter

/** 第一次调用卡住、放行后回一个工具调用；之后答一句。 */
function stuckModels() {
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let calls = 0
  const done = (c: Partial<Completion>): Completion => ({
    text: '',
    usage: { input_tokens: 1, output_tokens: 1, cached_tokens: 0, cost_base: 0 },
    model: MODEL,
    static_prefix_hash: 'p',
    ...c,
  })
  const models = {
    async complete(_req: { messages: ChatMessage[] }) {
      calls += 1
      if (calls === 1) {
        await gate
        return done({
          text: '先查了一下政策',
          tool_calls: [{ id: 'c1', name: 'search_policies', input: {} }],
        })
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

describe('WP337 (d) 运行停在安全点', () => {
  it('pauseRun：时间线写「因更新暂停」、运行收尾；登记里有谁起的', async () => {
    const g = stuckModels()
    const timeline: { text: string; kind: string }[] = []
    const work = {
      appendEvent: (_id: string, e: { kind: string; text: string }) => {
        timeline.push({ text: e.text, kind: e.kind })
      },
      onRunCompleted: () => undefined,
      onCard: () => undefined,
    } as unknown as Work
    const runtime = createRuntime({
      workspace_id: 'ws_1',
      clock,
      random: () => 0.5,
      seed: 42,
      env: {},
      models: g.models,
      approvals: {
        create: async () => ({ id: 'apv_1' }),
      } as unknown as RuntimeOptions['approvals'],
      roles: {
        effectiveConfig: () => ({
          role_id: 'dtc.support',
          grounding: [],
          skills: [],
          browser_scope: [],
        }),
        assignments: { get: () => undefined },
      } as unknown as RoleStore,
      appendEvent: () => undefined,
      prefer: 'direct',
      modelRef: () => MODEL,
    })
    runtime.bind(work)
    const running = runtime.startRun({
      matter,
      brief: '客户问退货进度',
      actor: { person_id: 'per_1', assignment_id: 'asg_1' },
    } as Parameters<typeof runtime.startRun>[0])
    for (let i = 0; i < 500 && runtime.activeRuns().length === 0; i += 1)
      await new Promise((r) => setTimeout(r, 10))
    const [run] = runtime.activeRuns()
    expect(run).toMatchObject({ matter_id: 'mat_1', person_id: 'per_1', assignment_id: 'asg_1' })
    const pausing = runtime.pauseRun?.(run?.run_id ?? '')
    g.release()
    expect(await pausing).toBe(true)
    await running
    expect(runtime.activeRuns()).toEqual([])
    const texts = timeline.map((t) => t.text)
    expect(texts.some((t) => t.startsWith('因更新暂停'))).toBe(true)
    expect(texts.some((t) => t.startsWith('这次被停下了'))).toBe(false)
    expect(g.calls()).toBe(1)
    expect(await runtime.pauseRun?.(run?.run_id ?? '')).toBe(false)
  })
})

async function boot(dbDir: string) {
  const s = await createServer({
    dbDir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  servers.push(s)
  const { url } = await s.listen(0)
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${text}`)
    return (JSON.parse(text) as { data: T }).data
  }
  return { s, call }
}

interface Readiness {
  idle: boolean
  paused: boolean
  counts: { output: number; background: number; scheduled: number }
  items: { kind: string; title: string }[]
  last_resume?: { runs: number; failed: number; reran: number; caught_up: number }
}

describe('WP337 (e) 路由 + 重启', () => {
  it('看一眼数得出定时；暂停落盘；新进程开机接着做、只一次', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp337-server-'))
    dirs.push(dbDir)
    const a = await boot(dbDir)
    await a.call('POST', '/v1/schedules', {
      title: '每分钟看一眼退货单',
      trigger: { kind: 'interval', every_ms: 60_000 },
    })
    const before = await a.call<Readiness>('GET', '/v1/update/readiness')
    expect(before).toMatchObject({ idle: true, paused: false })
    expect(before.counts.scheduled).toBeGreaterThanOrEqual(1)
    expect(before.items.map((i) => i.title)).toContain('每分钟看一眼退货单')
    const paused = await a.call<{ paused: Readiness['counts'] }>('POST', '/v1/update/pause', {
      to: '9.9.9',
    })
    expect(paused.paused.scheduled).toBeGreaterThanOrEqual(1)
    expect((await a.call<Readiness>('GET', '/v1/update/readiness')).paused).toBe(true)
    expect(existsSync(join(dbDir, UPDATE_PAUSE_FILE))).toBe(true)
    await a.s.close()
    servers.splice(servers.indexOf(a.s), 1)

    const b = await boot(dbDir)
    const after = await b.call<Readiness>('GET', '/v1/update/readiness')
    expect(after.paused).toBe(false)
    expect(after.last_resume).toMatchObject({ runs: 0, failed: 0 })
    expect(existsSync(join(dbDir, UPDATE_PAUSE_FILE))).toBe(false)
    await b.s.close()
    servers.splice(servers.indexOf(b.s), 1)

    const c = await boot(dbDir)
    expect((await c.call<Readiness>('GET', '/v1/update/readiness')).last_resume).toBeUndefined()
  })

  it('没重启成：resume 放开、记录删掉', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp337-server-'))
    dirs.push(dbDir)
    const a = await boot(dbDir)
    await a.call('POST', '/v1/update/pause', {})
    expect(existsSync(join(dbDir, UPDATE_PAUSE_FILE))).toBe(true)
    const back = await a.call<{ runs: number }>('POST', '/v1/update/resume')
    expect(back.runs).toBe(0)
    expect((await a.call<Readiness>('GET', '/v1/update/readiness')).paused).toBe(false)
    expect(existsSync(join(dbDir, UPDATE_PAUSE_FILE))).toBe(false)
  })
})
