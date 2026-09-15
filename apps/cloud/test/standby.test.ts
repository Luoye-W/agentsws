/**
 * 49 §6 WP60 的**集成**：真起一个 `apps/server` 子进程，真走一次公网反向代理。
 *
 * `packages/standby` 那边的测试用假 spawn 钉编排逻辑（状态机、退避、计费）——
 * 那是逻辑。这里钉的是另一件事：**那份 env 拼出来，真的能把 `apps/server` 拉起来**。
 * 两件事分开测，因为它们坏的方式不一样：逻辑坏了是判断错，这条坏了是拼串错。
 *
 * 跑不动就跳过（没 build 过 `apps/server/dist`）——一条要求先 build 的测试，
 * 在没 build 的机器上应该说"跳过"，不该说"你的代码错了"。
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CLOUD_SCOPES } from '@agentsws/contracts'
import { MemoryWalletStore } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { mountEntry } from '../src/entry.js'
import { type MountedStandby, mountStandby, resolveServerEntry } from '../src/standby.js'
import { type Harness, harness } from './helpers.js'

const SERVER_ENTRY = resolveServerEntry()
const BUILT = existsSync(SERVER_ENTRY)

let h: Harness | undefined
let standby: MountedStandby | undefined
let dataDir: string | undefined

afterEach(async () => {
  await standby?.close()
  standby = undefined
  await h?.close()
  h = undefined
  if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true })
  dataDir = undefined
})

function setup(): { h: Harness; token: string; standby: MountedStandby; dataDir: string } {
  h = harness()
  dataDir = mkdtempSync(join(tmpdir(), 'agentsws-cloud-standby-'))
  const entry = mountEntry(h.server, { clock: h.clock, walletStore: new MemoryWalletStore() })
  const { account, org } = h.server.store.ensureAccount('luoye@example.com')
  entry.wallet.topup({ org_id: org.id, credits: 10_000, kind: 'purchased' })
  const token = h.server.store.createLink({
    workspace_id: 'ws_standby',
    cloud_org_id: org.id,
    created_by: account.id,
    scopes: [...DEFAULT_CLOUD_SCOPES, 'standby'],
  }).token
  standby = mountStandby(h.server, {
    wallet: entry.wallet,
    pricing: entry.pricing,
    dataDir,
    serverEntry: SERVER_ENTRY,
    // 定时器由测试自己拨（`service.tick()`）：一条测试不该等真 15 秒
    tickMs: 0,
    onEvent: () => undefined,
  })
  return { h, token, standby, dataDir }
}

async function waitRunning(s: MountedStandby, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    await s.service.tick()
    const view = s.service.get('ws_standby')
    if (view?.status === 'running') return 'running'
    await new Promise((r) => setTimeout(r, 250))
  }
  return s.service.get('ws_standby')?.status ?? 'missing'
}

describe.skipIf(!BUILT)('真起一个子进程', () => {
  it('开通 → 子进程起来 → 健康 → 公网入口能代理到它 → 停', async () => {
    const s = setup()

    const opened = await s.h.call('/v1/standby/workspaces', {
      method: 'POST',
      body: { seats: 1 },
      token: s.token,
    })
    expect(opened.status).toBe(201)

    expect(await waitRunning(s.standby)).toBe('running')

    // 公网入口：**不带任何云侧凭据**，原样代理到子进程的 /v1/health
    const res = await s.h.server.fetch(new Request('http://cloud.test/w/ws_standby/v1/health'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data?: { status?: string } }
    expect(body.data?.status).toBeDefined()

    // 按租户独立的库与密钥：数据目录在自己那一格，密钥是自己那一把
    expect(existsSync(join(s.dataDir, 'standby', 'ws_standby', 'tenant.key'))).toBe(true)
    expect(existsSync(join(s.dataDir, 'standby', 'ws_standby', 'events.db'))).toBe(true)

    const stopped = await s.h.call('/v1/standby/workspaces/ws_standby/stop', {
      method: 'POST',
      token: s.token,
    })
    expect(stopped.status).toBe(200)
    expect(s.standby.service.get('ws_standby')?.status).toBe('stopped')
  }, 60_000)
})
