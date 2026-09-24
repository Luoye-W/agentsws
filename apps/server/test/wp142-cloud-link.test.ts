/**
 * WP142（docs/78 #6）：官方云那一跳**连不上时说人话**。
 *
 * 以前断网时向导上是「连不上 agentsws 云（https://cloud.agentsws.com）」——只有一个网址，
 * 不给下一步。现在：503 + 一句「网络不通……再试一次」，不带网址；云回了一页 HTML 报错页
 * 也一样当成连不上，而不是把 JSON 解析错误甩给用户。全程不联网（出站 fetch 是替身）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_OFFLINE_MESSAGE } from '../src/cloud-account.js'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

const CLOUD_BASE = 'http://cloud.test'

let server: Server | undefined
let dir = ''

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

async function boot(
  cloudFetch: (input: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
): Promise<string> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp142-cloud-'))
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_CLOUD_BASE_URL: CLOUD_BASE },
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    cloudFetch,
  })
  const { url } = await server.listen(0)
  return url
}

async function link(url: string): Promise<{ status: number; message: string }> {
  const s = server as Server
  const res = await fetch(`${url}/v1/cloud/account/link`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${s.bootstrap.internalToken}`,
      'X-Assignment': s.bootstrap.ownerAssignment.id,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ email: 'tester@example.com' }),
  })
  const body = (await res.json()) as { message?: string }
  return { status: res.status, message: body.message ?? '' }
}

describe('WP142 官方云那一跳：连不上时说人话', () => {
  it('网络不通：一句人话、给下一步，不报网址', async () => {
    const url = await boot(async () => {
      throw new Error('getaddrinfo ENOTFOUND cloud.test')
    })
    const out = await link(url)
    expect(out.status).toBe(503)
    expect(out.message).toBe(CLOUD_OFFLINE_MESSAGE)
    expect(out.message).toContain('再试一次')
    expect(out.message).not.toContain(CLOUD_BASE)
    expect(out.message).not.toContain('ENOTFOUND')
  })

  it('云那头回了一页 HTML 报错页（502）：当成连不上，不甩解析错误', async () => {
    const url = await boot(async () => ({
      ok: false,
      status: 502,
      text: async () => '<html><body>Bad gateway</body></html>',
    }))
    const out = await link(url)
    expect(out.status).toBe(503)
    expect(out.message).toBe(CLOUD_OFFLINE_MESSAGE)
  })
})
