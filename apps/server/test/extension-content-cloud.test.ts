/**
 * WP129：插件的**内容观测**也进云端公共库（WP119c 留的尾巴）。
 *
 * 钉住四件事：
 * 1. 规则同红人观测：**登录了就送，没登录一个字节都不出这台电脑**，没有第二个开关；
 * 2. 先落本机、再转发；云挂了不回滚、不让请求失败，回执如实报 0；
 * 3. 送出去的是**窄行**：没有页面 / 封面地址、没有作者名与粉丝数、没有评论文本；
 *    认不出 handle（只有 `UC…`）不送；
 * 4. 端到端：真的 `createExtensionContributor` → 真的公共库路由（内存档），内容与
 *    带货 / 广告标识落进云端的库。
 *
 * 全部替身，不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContentObservation, ExtensionSession } from '@agentsws/api'
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
import type { PublicContentRow, PublicLibraryContributor } from '../src/extension-service.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-22T10:00:00.000Z'
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

const input = (over: Partial<ExtensionContentObservation> = {}): ExtensionContentObservation => ({
  channel: 'youtube',
  content_external_id: 'vid_1',
  content_type: 'video',
  title: '键盘开箱',
  url: 'https://www.youtube.com/watch?v=vid_1&si=share-token',
  thumbnail_url: 'https://i.ytimg.com/vi/vid_1/hq.jpg?sig=abc',
  published_at: '2026-09-20T00:00:00.000Z',
  stats: { views: 10_000, likes: 500, comments: 42 },
  author: { external_id: 'UCabcdefghijklmnopqrstuv', handle: '@Fixture', name: '夹具频道' },
  duration_seconds: 615,
  paid_promotion: true,
  shoppable: false,
  captured_at: NOW,
  source_url: 'https://www.youtube.com/watch?v=vid_1&t=30',
  ...over,
})

function assemble(
  options: {
    cloud?: PublicLibraryContributor
    /** 真 contributor 要用同一个加密库（云令牌放在里面），所以给一个拿到加密库再造云的口。 */
    cloudFor?: (secrets: ReturnType<typeof createSecretStore>) => PublicLibraryContributor
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp129-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  const cloud = options.cloudFor?.(secrets) ?? options.cloud
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    ...(cloud === undefined ? {} : { publicLibrary: cloud }),
    serverVersion: '0.1.0',
  })
  return { kol, secrets, port }
}

/** 云端公共库的替身：记下送来的每一行。 */
function spyCloud(linked = true, fail = false) {
  const sent: PublicContentRow[] = []
  const cloud: PublicLibraryContributor = {
    linked: () => linked,
    contribute: async () => ({ accepted: 0 }),
    contributeContent: async (rows) => {
      if (fail) throw new Error('network down')
      sent.push(...rows)
      return { accepted: rows.length }
    },
  }
  return { cloud, sent }
}

describe('WP129 内容观测转发：规则', () => {
  it('登录了就送；送的是窄行（没有地址 / 作者名 / 粉丝数 / 评论文本），handle 归一', async () => {
    const { cloud, sent } = spyCloud()
    const { port, kol } = assemble({ cloud })
    const out = await port.contentObservation(session, input())
    expect(out).toMatchObject({ status: 'ok', forwarded_to_public_library: 1 })
    expect(sent).toHaveLength(1)
    const row = sent[0] as unknown as Record<string, unknown>
    expect(row).toEqual({
      channel: 'youtube',
      handle: 'fixture',
      external_id: 'vid_1',
      content_type: 'video',
      title: '键盘开箱',
      published_at: '2026-09-20T00:00:00.000Z',
      duration_seconds: 615,
      views: 10_000,
      likes: 500,
      comments: 42,
      paid_promotion: true,
      shoppable: false,
      observed_at: NOW,
    })
    const wire = JSON.stringify(sent)
    for (const leak of ['share-token', 'sig=abc', 't=30', '夹具频道', 'UCabc'])
      expect(wire).not.toContain(leak)
    // 本机那一份也记下了时长 / 发布时间 / 两个标识
    expect(kol.contentObservations()[0]).toMatchObject({
      duration_seconds: 615,
      published_at: '2026-09-20T00:00:00.000Z',
      paid_promotion: true,
      shoppable: false,
    })
  })

  it('没登录：一条都不送，回执 0；本机照收', async () => {
    const { cloud, sent } = spyCloud(false)
    const { port, kol } = assemble({ cloud })
    const out = await port.contentObservation(session, input())
    expect(out).toMatchObject({ status: 'ok', forwarded_to_public_library: 0 })
    expect(sent).toHaveLength(0)
    expect(kol.contentObservations()).toHaveLength(1)
  })

  it('老装配（云没有内容这条路）：回执 0，不炸', async () => {
    const { port } = assemble({
      cloud: { linked: () => true, contribute: async () => ({ accepted: 0 }) },
    })
    expect((await port.contentObservation(session, input())).forwarded_to_public_library).toBe(0)
  })

  it('云挂了：本机那一半不回滚，请求不失败，回执如实 0', async () => {
    const { cloud } = spyCloud(true, true)
    const { port, kol } = assemble({ cloud })
    const out = await port.contentObservation(session, input())
    expect(out).toMatchObject({ status: 'ok', forwarded_to_public_library: 0 })
    expect(kol.contentObservations()).toHaveLength(1)
  })

  it('本机当天去重了照样转发（云那边按同一个键幂等；上次没送成的这次补上）', async () => {
    const { cloud, sent } = spyCloud()
    const { port } = assemble({ cloud })
    await port.contentObservation(session, input())
    const again = await port.contentObservation(session, input({ stats: { views: 12_000 } }))
    expect(again).toMatchObject({ status: 'deduped', forwarded_to_public_library: 1 })
    expect(sent.map((r) => r.views)).toEqual([10_000, 12_000])
  })

  it('认不出 handle（只有频道 id）不送；页面上「3 天前」这种发布时间不送那一格', async () => {
    const { cloud, sent } = spyCloud()
    const { port } = assemble({ cloud })
    const noHandle = await port.contentObservation(
      session,
      input({ author: { external_id: 'UCabcdefghijklmnopqrstuv' } }),
    )
    expect(noHandle.forwarded_to_public_library).toBe(0)
    await port.contentObservation(
      session,
      input({ content_external_id: 'vid_2', published_at: '3 天前' }),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0]?.published_at).toBeUndefined()
  })
})

describe('WP129 内容观测转发：端到端（真 contributor → 真公共库路由，内存档）', () => {
  it('登录态工作区令牌送进去，云端库里有这条内容与两个标识，贡献回执算一条', async () => {
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
    const calls: string[] = []
    const fetch: KolPublicFetch = async (url, init) => {
      calls.push(`${init.method} ${new URL(url).pathname}`)
      return app.request(url, {
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: init.body }),
      })
    }

    const { port } = assemble({
      cloudFor: (secrets) => {
        secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fixture_token' })
        return createExtensionContributor({ secrets, env: {}, fetch })
      },
    })

    const out = await port.contentObservation(session, input())
    expect(out.forwarded_to_public_library).toBe(1)
    expect(calls).toEqual(['POST /v1/data/kol/content-observations'])
    expect(cloudStore.content('youtube', 'vid_1')).toMatchObject({
      handle: 'fixture',
      views: 10_000,
      comments: 42,
      duration_seconds: 615,
      paid_promotion: true,
      shoppable: false,
      source: 'plugin',
    })
    expect(cloudStore.contentMetricOnDay('youtube', 'vid_1', NOW.slice(0, 10))).toBe(true)
    // 云端那一份里没有任何地址 / 作者名
    expect(JSON.stringify(cloudStore.content('youtube', 'vid_1'))).not.toContain('share-token')
    expect(JSON.stringify(cloudStore.content('youtube', 'vid_1'))).not.toContain('夹具频道')
  })
})
