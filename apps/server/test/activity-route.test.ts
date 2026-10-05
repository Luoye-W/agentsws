/**
 * WP225（WP218 决定 ③）：`GET /v1/activity`——岗位 AI 正在干活没有。
 *
 * 真服务进程 + HTTP：刚起来什么都没跑 → 不忙；bootstrap 品牌里有一次运行在跑 → 忙、1 次。
 * 只回数量（不回事项名）：桌面壳「重启并更新」前问它，别的品牌的事不该从这里露出来。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function boot() {
  const dbDir = mkdtempSync(join(tmpdir(), 'wp225-activity-'))
  dirs.push(dbDir)
  server = await createServer({
    dbDir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
    tokenRefreshIntervalMs: 0,
  })
  const { url } = await server.listen(0)
  const s = server
  const get = async (path: string) =>
    fetch(`${url}${path}`, {
      headers: {
        Authorization: `Bearer ${s.bootstrap.internalToken}`,
        'X-Assignment': s.bootstrap.ownerAssignment.id,
      },
    })
  return { s, get, url }
}

describe('WP225 GET /v1/activity', () => {
  it('什么都没跑：不忙；有一次运行在跑：忙、1 次，且不带事项名', async () => {
    const { s, get } = await boot()
    const idle = await get('/v1/activity')
    expect(idle.status).toBe(200)
    expect(((await idle.json()) as { data: unknown }).data).toEqual({ busy: false, runs: 0 })

    const runtime = s.runtime
    if (runtime === undefined) throw new Error('bootstrap 品牌没有 runtime')
    vi.spyOn(runtime, 'activeRuns').mockReturnValue([
      {
        run_id: 'run_1',
        matter_id: 'mat_1',
        title: '回复客户 Anna 的退货',
        model: { provider: 'deepseek', model: 'deepseek-chat', region: 'cn' },
      },
    ])
    const busy = await get('/v1/activity')
    const text = await busy.text()
    expect((JSON.parse(text) as { data: unknown }).data).toEqual({ busy: true, runs: 1 })
    expect(text).not.toContain('Anna')
  })

  it('没带凭据：401（不是公开的）', async () => {
    const { url } = await boot()
    expect((await fetch(`${url}/v1/activity`)).status).toBe(401)
  })
})
