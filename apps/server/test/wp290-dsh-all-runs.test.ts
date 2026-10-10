/**
 * WP290（决策 332）：装包前冒烟要**每一次**有模型的运行都走 dsh（`runtime.dshAllRuns`）——
 * 客服这条职责没挂网页工具，平时走 direct；开了这个开关就走 dsh。不开 = 老行为一个字节不变。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

let server: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const fetchStub: FetchLike = async (url) => {
  const json = url.endsWith('/models')
    ? { object: 'list', data: [{ id: 'deepseek-flash' }] }
    : {
        choices: [{ message: { content: '收到。' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }
  return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
}

async function runtimeOfOneRun(dshAllRuns: boolean): Promise<string | undefined> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp290-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    modelFetch: fetchStub,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    ...(dshAllRuns ? { runtime: { dshAllRuns: true, dshMode: 'in-process' as const } } : {}),
  })
  const s = server
  const asg = s.roles.assignments.create({
    person_id: s.bootstrap.person.id,
    workspace_id: s.bootstrap.workspace.id,
    role_id: 'dtc.support',
    granted_by: s.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: s.bootstrap.workspace.id }],
  })
  const call = (method: string, path: string, body: unknown, assignment: string) =>
    s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': assignment,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    )
  const saved = await call(
    'PUT',
    '/v1/models/providers/deepseek',
    { kind: 'deepseek', model: 'deepseek-flash', api_key: 'sk-wp290-test-0001' },
    s.bootstrap.ownerAssignment.id,
  )
  expect(saved.status).toBe(200)
  const res = await call(
    'POST',
    '/v1/matters',
    { kind: 'adhoc', title: '客户问退款', role_id: 'dtc.support' },
    asg.id,
  )
  const matter = ((await res.json()) as { data: { matter: { id: string } } }).data.matter
  const msg = await call(
    'POST',
    `/v1/matters/${matter.id}/messages`,
    { text: '退款到哪了？' },
    asg.id,
  )
  const run_id = ((await msg.json()) as { data?: { run_id?: string } }).data?.run_id
  expect(run_id).toBeDefined()
  const ofRun = () =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.correlation?.run_id === run_id)
  for (let i = 0; i < 400; i++) {
    if (ofRun().some((e) => ['run.completed', 'run.failed'].includes(e.type))) break
    await new Promise((r) => setTimeout(r, 25))
  }
  expect(ofRun().map((e) => e.type)).toContain('run.completed')
  const started = ofRun().find((e) => e.type === 'run.started')
  return (started?.payload as { runtime?: string } | undefined)?.runtime
}

describe('WP290：装包前冒烟让每次运行都走 dsh', () => {
  it('不开：客服（没挂网页工具）照旧走 direct', async () => {
    expect(await runtimeOfOneRun(false)).toBe('direct-llm')
  })
  it('开了 dshAllRuns：同一件事走 dsh', async () => {
    expect(await runtimeOfOneRun(true)).toBe('dsh')
  })
})
