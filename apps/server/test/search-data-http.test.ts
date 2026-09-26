/**
 * WP155：`/v1/search-data*` 走真服务进程一遍（出站的云与服务商都是替身，不联网）。
 *
 * 钉的是 HTTP 那一层才看得见的：key 从 PUT 进来一次就再也不出现在任何响应里；
 * 没接时是一句人话 + `details.reason`，不是 500。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SearchFetch } from '@agentsws/cloud-entry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

vi.setConfig({ testTimeout: 20_000 })

const BYO_KEY = 'my-login:not-a-real-password-77f3'
let server: Server | undefined
let dir = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

async function boot(
  searchFetch: SearchFetch,
): Promise<
  (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; text: string }>
> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp155-http-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'd'.repeat(64), AGENTSWS_CLOUD_BASE_URL: 'http://cloud.test' },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch: async () => {
      throw new Error('这条用例不该打云')
    },
    searchFetch,
  })
  const { url } = await server.listen(0)
  const s = server
  return async (path, init = {}) => {
    const res = await fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
        'content-type': 'application/json',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return { status: res.status, text: await res.text() }
  }
}

/** 数据目录里所有文件的明文（加密库是密文，不会命中）。 */
function everyFileText(root: string): string {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const full = join(d, name)
      if (statSync(full).isDirectory()) walk(full)
      else out.push(readFileSync(full).toString('latin1'))
    }
  }
  walk(root)
  return out.join('\n')
}

describe('WP155 /v1/search-data*', () => {
  it('没接：设置页如实说；查询是 503 + reason，不是 500', async () => {
    const call = await boot(async () => new Response('{}', { status: 500 }))
    const view = await call('/v1/search-data')
    expect(view.status).toBe(200)
    expect(JSON.parse(view.text).data).toMatchObject({
      choice: 'auto',
      status: { configured: false, route: 'none' },
    })
    const q = await call('/v1/search-data/serp', {
      method: 'POST',
      body: { query: 'x', engine: 'google', country: 'us', language: 'en' },
    })
    expect(q.status).toBe(503)
    expect(JSON.parse(q.text)).toMatchObject({ details: { reason: 'not_configured' } })
  })

  it('填自带 key → 查一次：key 不在任何响应里、不在数据目录的明文文件里', async () => {
    const seen: string[] = []
    const call = await boot(async (url, init) => {
      seen.push(`${url} ${new Headers(init.headers).get('authorization') ?? ''}`)
      return Response.json({
        status_code: 20000,
        tasks: [
          {
            status_code: 20000,
            result: [{ items: [{ type: 'organic', url: 'https://www.example.com/', title: 'E' }] }],
          },
        ],
      })
    })
    const put = await call('/v1/search-data/byo', {
      method: 'PUT',
      body: { provider: 'dataforseo', api_key: BYO_KEY },
    })
    expect(put.status).toBe(200)
    expect(put.text).not.toContain(BYO_KEY)
    expect(JSON.parse(put.text).data).toMatchObject({ choice: 'byo', byo: { has_key: true } })
    const q = await call('/v1/search-data/serp', {
      method: 'POST',
      body: { query: 'x', engine: 'google', country: 'us', language: 'en' },
    })
    expect(q.status).toBe(200)
    expect(JSON.parse(q.text).data).toMatchObject({ source: 'byo:dataforseo', credits: 0 })
    expect(q.text).not.toContain(BYO_KEY)
    // 真的带着 key 打出去了（Basic），但只在出站那一跳
    expect(seen[0]).toContain(`Basic ${btoa(BYO_KEY)}`)
    expect(everyFileText(dir)).not.toContain(BYO_KEY)
    const view = await call('/v1/search-data')
    expect(view.text).not.toContain(BYO_KEY)
  })
})
