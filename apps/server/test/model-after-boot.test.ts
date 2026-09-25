/**
 * 09-25（WP150 报告「需要 Luoye 定」第 3 条，Fable 复核）：服务启动时还没接模型、之后在设置 / 向导里接上，
 * **不重启**的下一次运行要真的打到模型上，而不是一直用替身。内测朋友的第一条路就是这样走的。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it } from 'vitest'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

let server: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

describe('启动后才接模型', () => {
  it('不重启，下一次运行就走真模型（上游收到了对话请求）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'agentsws-model-after-boot-'))
    const chats: string[] = []
    const fetch: FetchLike = async (url, init) => {
      const body = typeof init.body === 'string' ? init.body : ''
      if (url.endsWith('/chat/completions') && !body.includes('"max_tokens":1')) chats.push(body)
      const json = url.endsWith('/models')
        ? { object: 'list', data: [{ id: 'deepseek-flash' }] }
        : {
            choices: [{ message: { content: '收到，我先看一下。' } }],
            usage: { prompt_tokens: 9, completion_tokens: 3 },
          }
      return {
        ok: true,
        status: 200,
        json: async () => json,
        text: async () => JSON.stringify(json),
      }
    }
    server = await createServer({
      dbDir: dir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
      modelFetch: fetch,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
    })
    const s = server
    const care = s.roles.assignments.create({
      person_id: s.bootstrap.person.id,
      workspace_id: s.bootstrap.workspace.id,
      role_id: 'dtc.support',
      granted_by: s.bootstrap.person.id,
      ranges: [{ kind: 'brand', id: s.bootstrap.workspace.id }],
    })
    const call = (method: string, path: string, body?: unknown, assignment = care.id) => {
      const headers = new Headers()
      headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
      headers.set('X-Assignment', assignment)
      if (body !== undefined) headers.set('content-type', 'application/json')
      return s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    }
    // 启动之后才接模型（向导第 ① 步 / 设置页「模型」做的就是这一下）
    const saved = await call(
      'PUT',
      '/v1/models/providers/deepseek',
      { kind: 'deepseek', model: 'deepseek-flash', api_key: 'sk-after-boot-test-0001' },
      s.bootstrap.ownerAssignment.id,
    )
    expect(saved.status).toBe(200)
    const res = await call('POST', '/v1/matters', {
      kind: 'adhoc',
      title: '客户问退款到哪了',
      role_id: 'dtc.support',
    })
    const matter = ((await res.json()) as { data: { matter: { id: string } } }).data.matter
    const msg = await call('POST', `/v1/matters/${matter.id}/messages`, {
      text: '订单 #1001 的退款到哪一步了？',
    })
    const out = ((await msg.json()) as { data?: { run_id?: string } }).data
    expect(out?.run_id).toBeDefined()
    const started = s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.type === 'run.started' && e.correlation?.run_id === out?.run_id)
      .map((e) => (e.payload as { runtime?: string }).runtime)
    expect(started[0]).not.toBe('stub')
    expect(chats.length).toBeGreaterThan(0)
  })
})
