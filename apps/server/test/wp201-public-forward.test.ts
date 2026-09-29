/**
 * WP201：插件 → 本机 → 公共红人库这一跳**不能卡住插件**，没送成的**要补**。
 *
 * 真跑一遍撞出来的（Luoye 的本机服务 + 线上公共库）：本机把观测转发去公共库时
 * **一行一个请求、一个接一个、等全部回来才回插件**，线上一次往返 3–6.5 秒。
 * 插件打本机只等 8 秒（`LOCAL_TIMEOUT_MS`），而列表页一块就是 20 行——
 * 20 × 3 秒 ≈ 1 分钟，插件早就当「应用没开」把整块排进自己的队列、5 分钟后再重发，
 * 于是用户看见「已排队 20 条（应用没开）」而应用明明开着，批次 id 也丢了。
 * 另一半：云那一跳失败（断网、5xx）以前**直接丢**，回执报 0 之后再没人补。
 *
 * 修法钉在这里：
 * 1. 本机等公共库最多 `forwardWaitMs`，到点就先回插件（回执照实说确认了几条、还有几条在路上）；
 * 2. 没送完的在后台接着送（并发几个，不是一个接一个）；
 * 3. 断网 / 超时 / 408 / 429 / 5xx 退避重试；400 之类云端明确不收的**不重试**，记一行日志；
 * 4. 每一轮转发记一行日志（几条 2xx、几条待重试、几条云端不收），查问题有据可查。
 *
 * 全部替身：公共库 HTTP 面的契约替身 + 可以变慢 / 变坏的 fetch 包装。不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import {
  cloudStandInFetch,
  KolPublicStandIn,
  type StandInKolPrincipal,
  StandInWallet,
} from '@agentsws/stand-ins'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-29T10:00:00.000Z'
const clock: Clock = { now: () => NOW }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const session: ExtensionSession = {
  token_id: 'ext_0001',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe', 'kol.capture', 'kol.read'],
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 列表页的一块：20 个人，都换算出了粉丝数（都够格上公共库）。 */
const listChunk = (n = 20): ExtensionObservation[] =>
  Array.from({ length: n }, (_, i) => ({
    channel: 'youtube' as const,
    handle: `@fixturegadget${String(i).padStart(2, '0')}`,
    followers: 10_000 + i,
    followers_text: `${String(10 + i)}K subscribers`,
    observed_at: NOW,
    source: 'search_results' as const,
  }))

interface Wire {
  /** 每个请求在云那头要多久（毫秒）。 */
  latencyMs: number
  /** 给某个 handle 定一串回应：先回这几个状态（0 = 断网），用完之后照常。 */
  script: Map<string, number[]>
}

function assemble(opts: { forwardWaitMs?: number; retryDelaysMs?: number[] } = {}) {
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const cloudStore = new KolPublicStandIn({
    wallet: new StandInWallet({ now: () => NOW, newId }),
    now: () => NOW,
    newId,
  })
  const verified: StandInKolPrincipal = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['data'],
    region: 'global',
  }
  const real = cloudStandInFetch({
    kolPublic: cloudStore,
    kolPrincipalOf: (t) => (t === 'wst_fixture_token' ? verified : undefined),
  })
  const wire: Wire = { latencyMs: 0, script: new Map() }
  const calls: { handle: string; status: number }[] = []
  const fetch: KolPublicFetch = async (url, init) => {
    const handle = decodeURIComponent(new URL(url).pathname.split('/')[6] ?? '').replace(/^@+/, '')
    await sleep(wire.latencyMs)
    const planned = wire.script.get(handle)?.shift()
    if (planned === 0) {
      calls.push({ handle, status: 0 })
      throw new Error('socket hang up')
    }
    if (planned !== undefined) {
      calls.push({ handle, status: planned })
      return { ok: false, status: planned, text: async () => '{"code":"upstream_error"}' }
    }
    const res = await real.fetch(url, init)
    calls.push({ handle, status: res.status })
    return res
  }

  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp201-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fixture_token' })
  const logs: string[] = []
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    publicLibrary: createExtensionContributor({ secrets, env: {}, fetch }),
    serverVersion: '0.1.0',
    ...(opts.forwardWaitMs === undefined ? {} : { forwardWaitMs: opts.forwardWaitMs }),
    forwardRetryDelaysMs: opts.retryDelaysMs ?? [5, 5, 5],
    log: (line: string) => {
      logs.push(line)
    },
  })
  return { port, kol, cloudStore, wire, calls, logs }
}

describe('WP201 公共库转发不卡插件那一跳', () => {
  it('云那头慢（每个请求 60ms、一块 20 行）：本机到点先回插件，没送完的后台接着送完', async () => {
    const { port, kol, cloudStore, wire } = assemble({ forwardWaitMs: 150 })
    wire.latencyMs = 60
    const started = Date.now()
    const out = await port.ingest(session, { observations: listChunk() })
    const took = Date.now() - started
    // 以前：20 × 60ms 一个接一个 ≈ 1.2 秒才回。现在：到点（150ms）就回
    expect(took).toBeLessThan(600)
    expect(out.rows.every((r) => r.status === 'ok')).toBe(true)
    expect(kol.accounts()).toHaveLength(20) // 本机那一半一条不少
    // 回执照实说：确认了几条 + 还有几条在路上，两数加起来就是够格上云的那 20 行
    const pending = out.public_library_pending ?? 0
    expect(pending).toBeGreaterThan(0)
    expect(out.forwarded_to_public_library + pending).toBe(20)

    await port.publicForwardIdle()
    for (let i = 0; i < 20; i++)
      expect(
        cloudStore.creator('youtube', `fixturegadget${String(i).padStart(2, '0')}`),
      ).toBeDefined()
  })

  it('云那头快：一次就回全数，回执里没有「在路上」这一格（老插件看到的形状不变）', async () => {
    const { port } = assemble()
    const out = await port.ingest(session, { observations: listChunk(3) })
    expect(out.forwarded_to_public_library).toBe(3)
    expect(out).not.toHaveProperty('public_library_pending')
  })

  it('断网 / 503 退避重试直到送进去；每一轮记一行日志', async () => {
    const { port, cloudStore, wire, calls, logs } = assemble()
    wire.script.set('fixturegadget00', [0, 503]) // 先断网、再 503、第三次才成
    const out = await port.ingest(session, { observations: listChunk(2) })
    expect(out.forwarded_to_public_library).toBe(1)
    await port.publicForwardIdle()
    expect(cloudStore.creator('youtube', 'fixturegadget00')).toBeDefined()
    expect(calls.filter((c) => c.handle === 'fixturegadget00').map((c) => c.status)).toEqual([
      0, 503, 201,
    ])
    expect(logs.some((l) => l.includes('2xx 1') && l.includes('待重试 1'))).toBe(true)
    expect(logs.at(-1)).toContain('2xx 1')
  })

  it('云端明确不收（400）不重试，日志里写清 HTTP 几；重试有上限，不会无休止地打', async () => {
    const { port, wire, calls, logs } = assemble({ retryDelaysMs: [5, 5] })
    wire.script.set('fixturegadget00', [400])
    wire.script.set('fixturegadget01', [503, 503, 503, 503, 503])
    await port.ingest(session, { observations: listChunk(2) })
    await port.publicForwardIdle()
    expect(calls.filter((c) => c.handle === 'fixturegadget00')).toHaveLength(1)
    // 第一次 + 两次重试 = 3 次，之后放弃（本机那一半早就写好了，下次再采会再送）
    expect(calls.filter((c) => c.handle === 'fixturegadget01')).toHaveLength(3)
    expect(logs.some((l) => l.includes('云端不收 1') && l.includes('HTTP 400'))).toBe(true)
    expect(logs.some((l) => l.includes('放弃 1'))).toBe(true)
  })
})
