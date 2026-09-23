/**
 * WP131（Luoye 09-23 对 WP130 的六条）：本机服务这一侧的三件事。
 *
 * 1. **内容观测的标题可选**：没标题（IG 网格 / TikTok hashtag 格子）照样落本机、照样转发，
 *    转发那一行里没有 `title` 这一格；存入自己的内容库也收。
 * 2. **采集批次**：列表采集第一块回一个 `bt_…`，后几块带回来落同一批；主页单条观测不算批次。
 * 3. **采集后自动评分**：每工作区一个开关、默认关；开着时收进即排队——本机打分（免费）+
 *    关联了云账号时的云端体检（`data.kol.audit`，真扣积分）；30 天内体检过不重复花钱；
 *    积分不够就停体检、不停打分。云那一半用**真的** `createKolPublicClient` 打**真的**
 *    公共库路由（内存档 + 真钱包），不联网。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import { EXTENSION_BATCH_ID } from '@agentsws/api'
import type {
  Clock,
  PersonId,
  PublicCreatorObservation,
  VerifiedCloudToken,
  WorkspaceId,
} from '@agentsws/contracts'
import {
  createKolPublicApp,
  KolPublicService,
  MemoryKolStore,
  nodeKolSecrets,
} from '@agentsws/kol-public'
import { buildPricing, entryFor, MemoryWalletStore, Wallet } from '@agentsws/metering'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import type { PublicContentRow, PublicLibraryContributor } from '../src/extension-service.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import { createKolPublicClient, type KolPublicFetch } from '../src/kol-public-client.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-09-23T10:00:00.000Z'
const DAY = 86_400_000

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

const listRow = (
  handle: string,
  over: Partial<ExtensionObservation> = {},
): ExtensionObservation => ({
  channel: 'tiktok',
  handle,
  followers: 48_200,
  followers_text: '48.2K followers',
  observed_at: NOW,
  source: 'search_results',
  source_page: 'search',
  source_query: 'meal prep',
  ...over,
})

const AUDIT_PRICE = entryFor(buildPricing(), 'data.kol.audit')?.credits_per_unit ?? 0

/** 云上同一个人的几条完整观测（够体检出完整结论——样本不够的体检不收钱）。 */
const seedObservations = (handle: string): PublicCreatorObservation[] =>
  Array.from({ length: 3 }, (_, i) => ({
    channel: 'tiktok',
    handle,
    followers: 48_000,
    posts_30d: 8,
    engagement_rate: 0.05,
    categories: ['food'],
    observed_at: new Date(Date.parse('2026-09-10T00:00:00.000Z') + i * 3_600_000).toISOString(),
  }))

/**
 * 真公共库（内存档 + 真钱包）+ 真 `createKolPublicClient`（体检那一跳）+ 真本机服务。
 * `linked: false` = 这台机器没关联云账号（加密库里没有工作区令牌）。
 */
function assemble(options: { credits?: number; linked?: boolean; now?: () => string } = {}) {
  const now = options.now ?? (() => NOW)
  const clock: Clock = { now }
  const cloudStore = new MemoryKolStore()
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const wallet = new Wallet({ store: new MemoryWalletStore(), now, newId })
  const service = new KolPublicService({
    store: cloudStore,
    wallet,
    pricing: buildPricing(),
    secrets: nodeKolSecrets({ env: {} }),
    now,
    newId,
  })
  const verified: VerifiedCloudToken = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['data'],
  }
  if ((options.credits ?? 0) > 0)
    wallet.topup({ org_id: 'org_1', credits: options.credits ?? 0, kind: 'purchased' })
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

  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp131-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  if (options.linked !== false) secrets.put(CLOUD_TOKEN_SECRET_ID, { token: 'wst_fixture_token' })
  const auditor = createKolPublicClient({
    workspace_id: WS,
    clock,
    secrets,
    env: {},
    fetch,
    newContactId: () => `ctc_${String(++seq)}`,
  })
  const forwarded: PublicContentRow[] = []
  const contributor: PublicLibraryContributor = {
    linked: () => options.linked !== false,
    contribute: async (rows) => ({ accepted: rows.length }),
    contributeContent: async (rows) => {
      forwarded.push(...rows)
      return { accepted: rows.length }
    },
  }
  const port = createExtensionService({
    workspace_id: WS,
    workspaceName: () => '我的品牌',
    store: {} as never,
    kol,
    secrets,
    clock,
    random: () => 0.5,
    publicLibrary: contributor,
    serverVersion: '0.1.0',
    auditor,
    auditPriceCredits: () => AUDIT_PRICE,
  })
  const seedCloud = (handle: string): void => {
    service.contributeAs({ ...verified, region: 'global' }, seedObservations(handle))
  }
  return { port, kol, wallet, calls, forwarded, seedCloud }
}

describe('WP131 ② 内容观测的标题可选', () => {
  it('没标题的帖子照样落本机、照样转发；转发行里没有 title 这一格', async () => {
    const { port, kol, forwarded } = assemble()
    await port.ingest(session, {
      observations: [listRow('gymchef', { channel: 'instagram', source: 'channel_page' })],
    })
    const out = await port.contentObservation(session, {
      channel: 'instagram',
      content_external_id: 'Cabc123',
      content_type: 'post',
      stats: {},
      author: { external_id: 'gymchef', handle: 'gymchef' },
      captured_at: NOW,
    })
    expect(out.status).toBe('ok')
    expect(out.forwarded_to_public_library).toBe(1)
    const [row] = kol.contentObservations()
    expect(row?.content_external_id).toBe('Cabc123')
    expect(row).not.toHaveProperty('title')
    expect(forwarded[0]).not.toHaveProperty('title')

    // 空串 / 全空白也当没有；有标题的照旧去空白
    await port.contentObservation(session, {
      channel: 'tiktok',
      content_external_id: '7400000000000000001',
      content_type: 'video',
      title: '   ',
      stats: { views: 1_000 },
      author: { external_id: 'gymchef', handle: 'gymchef' },
      captured_at: NOW,
    })
    expect(forwarded[1]).not.toHaveProperty('title')
  })

  it('存入自己的内容库也收没标题的（空串 = 没有）', async () => {
    const { port, kol } = assemble()
    const out = await port.contentSave(session, {
      channel: 'instagram',
      content_external_id: 'Cxyz789',
      content_type: 'reel',
      stats: {},
      author: { external_id: 'gymchef', handle: 'gymchef' },
      captured_at: NOW,
    })
    expect(out.status).toBe('ok')
    expect(kol.contents()[0]?.title).toBe('')
  })
})

describe('WP131 ⑤ 采集批次', () => {
  it('第一块发一个 bt_…，后几块带回来落同一批；快照上记着批次', async () => {
    const { port, kol } = assemble()
    const first = await port.ingest(session, { observations: [listRow('a1'), listRow('a2')] })
    expect(first.batch_id).toMatch(EXTENSION_BATCH_ID)
    const second = await port.ingest(session, {
      observations: [listRow('a3')],
      batch_id: first.batch_id as string,
    })
    expect(second.batch_id).toBe(first.batch_id)
    const inBatch = kol.accountObservations({ batch_id: first.batch_id as string })
    expect(inBatch.map((o) => o.handle).sort()).toEqual(['a1', 'a2', 'a3'])

    // 下一次采集是另一批
    const other = await port.ingest(session, { observations: [listRow('b1')] })
    expect(other.batch_id).not.toBe(first.batch_id)
  })

  it('主页 / 内容页的单条观测不算批次（回执没有 batch_id）', async () => {
    const { port, kol } = assemble()
    const out = await port.ingest(session, {
      observations: [listRow('solo', { source: 'channel_page' })],
    })
    expect(out.batch_id).toBeUndefined()
    expect(kol.accountObservations()[0]).not.toHaveProperty('batch_id')
  })
})

describe('WP131 ④ 采集后自动评分', () => {
  it('默认关：收进不排队、不打云；开关读出来是关', async () => {
    const { port, kol, calls } = assemble({ credits: 10 })
    const view = await port.autoScore?.(session)
    expect(view).toMatchObject({ enabled: false, cloud_linked: true, pending: 0 })
    const out = await port.ingest(session, { observations: [listRow('gymchef')] })
    expect(out.auto_score).toBeUndefined()
    await port.autoScoreIdle()
    expect(kol.autoScores()).toEqual([])
    expect(calls.filter((c) => c.endsWith('/audit'))).toEqual([])
  })

  it('开着 + 关联了云账号：本机打分 + 云端体检真扣积分；面板常显每位约 N 积分', async () => {
    const { port, kol, wallet, seedCloud } = assemble({ credits: 10 })
    seedCloud('gymchef')
    const view = await port.setAutoScore?.(session, { enabled: true })
    expect(view).toMatchObject({ enabled: true, credits_per_creator: AUDIT_PRICE })
    expect(view?.note).toContain(`每位约 ${String(AUDIT_PRICE)} 积分`)

    const out = await port.ingest(session, { observations: [listRow('gymchef')] })
    expect(out.auto_score).toEqual({
      queued: 1,
      audits: 1,
      credits_estimate: AUDIT_PRICE,
    })
    await port.autoScoreIdle()
    const [row] = kol.autoScores()
    expect(row?.batch_id).toBe(out.batch_id)
    expect(typeof row?.score).toBe('number')
    expect(row?.audit).toMatchObject({ status: 'done', credits_spent: AUDIT_PRICE })
    expect(typeof row?.audit?.health).toBe('number')
    expect(wallet.balance('org_1').available).toBe(10 - AUDIT_PRICE)
  })

  it('30 天内体检过的人再收进不重复花钱；打分照跑', async () => {
    let now = NOW
    const { port, kol, wallet, calls, seedCloud } = assemble({ credits: 10, now: () => now })
    seedCloud('gymchef')
    await port.setAutoScore?.(session, { enabled: true })
    await port.ingest(session, { observations: [listRow('gymchef')] })
    await port.autoScoreIdle()
    now = new Date(Date.parse(NOW) + 5 * DAY).toISOString()
    const again = await port.ingest(session, { observations: [listRow('gymchef')] })
    expect(again.auto_score).toMatchObject({ queued: 1, audits: 0, credits_estimate: 0 })
    await port.autoScoreIdle()
    expect(calls.filter((c) => c.endsWith('/audit'))).toHaveLength(1)
    expect(kol.autoScores()[0]?.audit?.status).toBe('recent')
    expect(wallet.balance('org_1').available).toBe(10 - AUDIT_PRICE)
  })

  it('积分不够：第一位撞 402 之后这一轮不再逐个去撞，打分照跑，一分不扣', async () => {
    const { port, kol, calls, seedCloud } = assemble({ credits: 0 })
    seedCloud('p1')
    seedCloud('p2')
    await port.setAutoScore?.(session, { enabled: true })
    await port.ingest(session, { observations: [listRow('p1'), listRow('p2')] })
    await port.autoScoreIdle()
    const rows = kol.autoScores()
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.audit?.status === 'insufficient_credits')).toBe(true)
    expect(rows.every((r) => typeof r.score === 'number')).toBe(true)
    expect(calls.filter((c) => c.endsWith('/audit'))).toHaveLength(1)
  })

  it('没关联云账号：只做本机打分（免费），每位 0 积分，一次云都不打', async () => {
    const { port, kol, calls } = assemble({ linked: false })
    const view = await port.setAutoScore?.(session, { enabled: true })
    expect(view).toMatchObject({ enabled: true, cloud_linked: false, credits_per_creator: 0 })
    const out = await port.ingest(session, { observations: [listRow('gymchef')] })
    expect(out.auto_score).toMatchObject({ queued: 1, audits: 0, credits_estimate: 0 })
    await port.autoScoreIdle()
    expect(kol.autoScores()[0]?.audit?.status).toBe('not_linked')
    expect(calls).toEqual([])
  })

  it('显式存入也是「收进」：开着就排队', async () => {
    const { port, kol } = assemble({ linked: false })
    await port.setAutoScore?.(session, { enabled: true })
    await port.saveCreator(session, {
      channel: 'youtube',
      handle: '@deskcraft',
      followers: 312_000,
      observed_at: NOW,
    })
    await port.autoScoreIdle()
    expect(kol.autoScores()).toHaveLength(1)
    expect(kol.autoScores()[0]).not.toHaveProperty('batch_id')
  })

  it('开关落库：同一个品牌库重开还记得', async () => {
    const { port, kol } = assemble()
    await port.setAutoScore?.(session, { enabled: true })
    expect(kol.setting<{ enabled: boolean }>('auto_score')).toEqual({ enabled: true })
    await port.setAutoScore?.(session, { enabled: false })
    expect((await port.autoScore?.(session))?.enabled).toBe(false)
  })
})
