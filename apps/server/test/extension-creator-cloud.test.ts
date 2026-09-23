/**
 * WP130：本机转发的**红人观测**真的进了公共库（修 WP129 发现的 bug）+ 列表来源落本机。
 *
 * bug 是什么：`extension-contribute.ts` 的 `postOne` 只送 `followers` + `observed_at`，
 * 而云端要求 `posts_30d` / `engagement_rate` 必须是数——所以本机的红人观测转发
 * 至今一条都没进过公共库（每一条都是 400，回执里的「共享了几条」一直是 0）。
 * 修法：本机那一跳带 `via: 'extension'`，云端对插件来源放宽这两格为可选
 * （缺的行不进 k-匿名基准）；本机有值就送、没有就不送。
 *
 * 端到端：真的 `createExtensionContributor` → 真的公共库路由（内存档）。全部替身，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, VerifiedCloudToken, WorkspaceId } from '@agentsws/contracts'
import {
  createKolPublicApp,
  KolPublicService,
  MemoryKolStore,
  nodeKolSecrets,
} from '@agentsws/kol-public'
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-23T10:00:00.000Z'
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

const obs = (over: Partial<ExtensionObservation> = {}): ExtensionObservation => ({
  channel: 'tiktok',
  handle: 'gymchef',
  display_name: 'Gym Chef',
  followers: 48_200,
  followers_text: '48.2K',
  observed_at: NOW,
  page_url: 'https://www.tiktok.com/@gymchef',
  source: 'channel_page',
  ...over,
})

/** 真公共库（内存档）+ 真 contributor + 真本机服务，一条线接起来。 */
function assemble() {
  const cloudStore = new MemoryKolStore()
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const service = new KolPublicService({
    store: cloudStore,
    wallet: new Wallet({ store: new MemoryWalletStore(), now: () => NOW, newId }),
    pricing: buildPricing(),
    secrets: nodeKolSecrets({ env: {} }),
    now: () => NOW,
    newId,
  })
  const verified: VerifiedCloudToken = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['data'],
  }
  const app = createKolPublicApp({
    service,
    verifier: async (t) => (t === 'wst_fixture_token' ? verified : undefined),
  })
  const calls: { path: string; body: unknown; status: number }[] = []
  const fetch: KolPublicFetch = async (url, init) => {
    const res = await app.request(url, {
      method: init.method,
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    })
    calls.push({
      path: `${init.method} ${new URL(url).pathname}`,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
      status: res.status,
    })
    return res
  }

  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp130-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fixture_token' })
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
  })
  return { port, kol, cloudStore, calls }
}

describe('WP130 红人观测转发：端到端（真 contributor → 真公共库路由）', () => {
  it('只有粉丝数的一条也进了公共库：卡建起来、来源记 plugin、没有编出来的 0', async () => {
    const { port, cloudStore, calls } = assemble()
    const out = await port.ingest(session, { observations: [obs()] })
    expect(out.rows).toMatchObject([{ handle: 'gymchef', status: 'ok' }])
    expect(out.forwarded_to_public_library).toBe(1)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      path: 'POST /v1/data/kol/creators/tiktok/gymchef/observations',
      status: 201,
    })
    // 送上去的是窄行：via + 渠道 / handle / 粉丝数 / 时刻；没有名字、网址、页面原文
    expect(calls[0]?.body).toEqual({
      via: 'extension',
      observations: [{ channel: 'tiktok', handle: 'gymchef', followers: 48_200, observed_at: NOW }],
    })

    expect(cloudStore.creator('tiktok', 'gymchef')).toMatchObject({
      followers: 48_200,
      source: 'plugin',
    })
    const [row] = cloudStore.observationsOf('tiktok', 'gymchef')
    expect(row).toMatchObject({ source: 'plugin', followers: 48_200 })
    expect(row).not.toHaveProperty('posts_30d')
    expect(row).not.toHaveProperty('engagement_rate')
  })

  it('云端收不下的不送：只有频道 id（UC…）的、没有粉丝数的（列表页只有原文）', async () => {
    const { port, kol, calls } = assemble()
    const out = await port.ingest(session, {
      observations: [
        obs({ channel: 'youtube', handle: 'UCfixtureDeskCraft00001x', followers: 1_000 }),
        obs({ handle: 'prepwithpri', followers: undefined, source: 'search_results' }),
      ],
    })
    expect(out.rows.map((r) => r.status)).toEqual(['ok', 'ok'])
    expect(out.forwarded_to_public_library).toBe(0)
    expect(calls).toHaveLength(0)
    // 本机照收
    expect(kol.accounts()).toHaveLength(2)
  })
})

describe('WP130 列表来源：记在本机粉丝快照上，不出本机', () => {
  it('相关视频栏的一行：来源、列表种类、读自哪里、预筛分都落在 account_observation', async () => {
    const { port, kol, calls } = assemble()
    await port.ingest(session, {
      observations: [
        obs({
          channel: 'youtube',
          handle: '@deskcraft',
          external_id: 'UCfixtureDeskCraft00001',
          followers: undefined,
          followers_text: '312K subscribers',
          source: 'search_results',
          source_page: 'watch_related',
          source_query: 'https://www.youtube.com/watch?v=SeedVideo01',
          relevance_score: 71,
        }),
      ],
    })
    const [snap] = kol.accountObservations()
    expect(snap).toMatchObject({
      handle: '@deskcraft',
      followers_text: '312K subscribers',
      source: 'search_results',
      source_page: 'watch_related',
      source_query: 'https://www.youtube.com/watch?v=SeedVideo01',
      relevance_score: 71,
    })
    // 没粉丝数 → 不上云；上云那条窄行里本来也没有这几格
    expect(calls).toHaveLength(0)
  })
})
