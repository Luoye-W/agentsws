/**
 * WP498（决策 1740 B / 1742 C）：ego 采集红人——
 * ① 读到的每个红人主页都「存入红人池」：插件按钮同一个入口（`saveCreator`、同一道 schema），国家 / 加入时间 / 总播放 /
 *   近期作品也记下；照 1661 / 1663 / 1693 / 1707b 上云（一次读页只送一条观测，带名字 / 主页链接 / 地区）；
 *   内容页 / 列表页照旧只报观测；回给 AI 一句「存了几个、新增几个」；
 * ② 列表页（视频页右栏）每行带插件那套预筛的相关度分：按分排、标出插件会筛掉的，一行不丢全记，分随观测记下；
 *   种子不在库里 / 搜索页不打分（同插件）。
 * 假 ego 与本机服务的装配照抄 `wp496-ego-capture.test.ts`（进程内 jsdom 假页面，不起真 ego、不联网）。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EXTENSION_CREATOR_SAVE_SCHEMA, type ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import type { EgoProcessResult } from '@agentsws/dsh-adapter'
import {
  cloudStandInFetch,
  KolPublicStandIn,
  type StandInKolPrincipal,
  StandInWallet,
} from '@agentsws/stand-ins'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it } from 'vitest'
import { CLOUD_TOKEN_SECRET_ID } from '../src/cloud-account.js'
import { createEgoCreatorCapture, createEgoPageReader } from '../src/ego-read/index.js'
import type { EgoSpawn } from '../src/ego-write/runner.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import { createKolService } from '../src/kol-service.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { createKolToolExecutor } from '../src/kol-tools.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T10:00:00.000Z'
const clock: Clock = { now: () => NOW }
const CLOUD_TOKEN = 'wst_fixture_token_SECRET'

const FIXTURES = join(__dirname, '../../../packages/creator-capture/test/fixtures')
const PAGES: Record<string, string> = {
  'https://www.youtube.com/@deskfixture/videos': 'pages/youtube-channel.html',
  'https://www.tiktok.com/@lunchfixture': 'pages/tiktok-profile.html',
  'https://www.youtube.com/watch?v=dfVid000001': 'pages/youtube-video.html',
  'https://www.tiktok.com/tag/mealprep': 'lists/tiktok-tag.html',
  'https://www.youtube.com/watch?v=SeedVideo01': 'lists/youtube-watch.html',
}
const REWRITE = Object.fromEntries(
  Object.keys(PAGES).map((real, i) => [real, `http://127.0.0.1:4985/p${i}`]),
)
const LOCAL_TO_REAL = Object.fromEntries(Object.entries(REWRITE).map(([r, l]) => [l, r]))

/* ── 进程内的假 ego 运行时：goto 换一页 jsdom，evaluate(字符串) 在那页里求值 ── */

interface Log {
  gotos: string[]
  evaluates: number
  finished: unknown[]
  /** 这一页前几次求值回「没渲染完」（模拟慢页面）。 */
  slow?: number
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<void>

function fakeEgo(opts: { slow?: number } = {}): { spawn: EgoSpawn; log: Log } {
  const log: Log = { gotos: [], evaluates: 0, finished: [], ...opts }
  const spawn: EgoSpawn = async ({ stdin }) => {
    const out: string[] = []
    let dom: JSDOM | undefined
    let url = 'about:blank'
    let slow = log.slow ?? 0
    const page = {
      label: 'p1',
      async goto(u: string) {
        log.gotos.push(u)
        url = u
        const real = LOCAL_TO_REAL[u]
        const file = real === undefined ? undefined : PAGES[real]
        const html =
          file === undefined || file === ''
            ? '<html><body><p>nothing here</p></body></html>'
            : readFileSync(join(FIXTURES, file), 'utf8')
        dom = new JSDOM(html, { url: u, runScripts: 'outside-only' })
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
          configurable: true,
          get() {
            return this.textContent
          },
        })
      },
      waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5))),
      url: () => url,
      async evaluate(expr: unknown) {
        log.evaluates += 1
        if (typeof expr !== 'string') throw new Error('capture 只用字符串表达式')
        if (slow > 0) {
          slow -= 1
          return { href: url, pending: true }
        }
        return (dom as JSDOM).window.eval(expr)
      },
    }
    const task = {
      spaceId: 7,
      page: () => page,
      async finish(o: unknown) {
        log.finished.push(o)
      },
    }
    const consoleLike = { log: (...a: unknown[]) => out.push(a.map(String).join(' ')) }
    // vitest 的沙箱里 `new Function` 不能动态 import：把脚本开头那一句换成直接给的 fs（同 WP493 的假运行时）
    const body = (stdin ?? '').replace('await import("node:fs/promises")', '__fs')
    const started = Date.now()
    await new AsyncFunction('taskSpace', 'console', '__fs', body)(
      async () => task,
      consoleLike,
      fsp,
    )
    return {
      exit_code: 0,
      timed_out: false,
      duration_ms: Date.now() - started,
      stdout: out.join('\n'),
      stderr: '',
    } satisfies EgoProcessResult
  }
  return { spawn, log }
}

function readerOf(spawn: EgoSpawn) {
  return createEgoPageReader({ egoPath: () => '/fake/ego-browser', spawn })
}

/* ── 本机服务（和插件同一个 ExtensionService，公共库是契约替身）──────────── */

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function assemble() {
  let seq = 0
  const newId = (prefix: string): string => `${prefix}_${String(++seq)}`
  const cloud = new KolPublicStandIn({
    wallet: new StandInWallet({ now: () => NOW, newId }),
    now: () => NOW,
    newId,
  })
  const verified: StandInKolPrincipal = {
    account_id: 'acc_1',
    org_id: 'org_1',
    workspace_id: WS,
    scopes: ['data'],
  }
  const wire = cloudStandInFetch({
    kolPublic: cloud,
    kolPrincipalOf: (t) => (t === CLOUD_TOKEN ? verified : undefined),
  })
  const calls: { path: string; body: unknown }[] = []
  const fetch: KolPublicFetch = async (url, init) => {
    const res = await wire.fetch(url, init)
    calls.push({
      path: `${init.method} ${new URL(url).pathname}`,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    return res
  }
  const dir = mkdtempSync(join(tmpdir(), 'agentsws-wp496-'))
  dirs.push(dir)
  const kol = createKolStore({ workspace_id: WS, dbDir: dir })
  const secrets = createSecretStore({
    dbPath: ':memory:',
    clock,
    env: { AGENTSWS_SECRETS_KEY: 'a'.repeat(64) },
  })
  secrets.put(CLOUD_TOKEN_SECRET_ID, { token: CLOUD_TOKEN })
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
  return { port, kol, calls }
}

const actor = { workspace_id: WS, person_id: 'pr_1' }
const pluginSession: ExtensionSession = {
  token_id: 'ext_token_SECRET',
  workspace_id: WS,
  person_id: 'pr_1' as PersonId,
  extension_id: 'abcdefghijklmnop',
  scopes: ['kol.observe'],
}

function egoCapture(svc: ReturnType<typeof assemble>) {
  return createEgoCreatorCapture({
    reader: readerOf(fakeEgo().spawn),
    port: () => svc.port,
    now: () => NOW,
  })
}

/** 上云的红人观测（公共库那一跳的请求体里的每一行）。 */
function cloudObservations(svc: ReturnType<typeof assemble>): Record<string, unknown>[] {
  return svc.calls.flatMap((c) => {
    const body = c.body as { observations?: Record<string, unknown>[] } | undefined
    return c.path.startsWith('POST') && Array.isArray(body?.observations) ? body.observations : []
  })
}

describe('WP498 1740 B：ego 读到的红人主页一律存入红人池', () => {
  it('主页：插件按钮同一个入口存下，国家 / 加入时间 / 总播放 / 近期作品都在本机；上云一条、带资料字段', async () => {
    const svc = assemble()
    const cap = egoCapture(svc)
    const [page] = await cap.capture(actor, ['https://www.youtube.com/@deskfixture/videos'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    expect(page?.pool).toMatchObject({ saved: true, new: true })

    // 本机：红人池里有他；地区记的是页面上的国家；存入那一行快照带着主页资料
    const account = svc.kol.accounts().find((a) => a.handle === '@deskfixture')
    expect(account).toMatchObject({ region: 'Germany', followers: 123_000 })
    const saved = svc.kol
      .accountObservations({ account_id: account?.id as string })
      .filter((o) => o.source === 'manual_save')
    expect(saved).toHaveLength(1)
    expect(saved[0]?.profile).toMatchObject({
      country: 'Germany',
      joined_date: 'Mar 3, 2021',
      total_views: 1_234_567,
      avg_views: 32_500,
      video_count: 231,
      banner_url: 'https://yt3.example/banner-deskfixture.png',
    })
    expect(saved[0]?.profile?.recent_items?.[0]).toMatchObject({
      title: 'The ultimate desk setup guide',
      views: 39_000,
    })
    expect(saved[0]?.profile?.recent_items?.length).toBe(8)
    // 页面上的商务邮箱：同插件按钮，进本机加密库
    expect(svc.kol.contacts().map((c) => c.source)).toContain('channel_about')

    // 上云：一次读页只送一条观测（存入本身不再多送一条，免得公共库重复计数），带 1707b 的资料字段
    await svc.port.publicForwardIdle()
    const up = cloudObservations(svc)
    expect(up).toHaveLength(1)
    expect(up[0]).toMatchObject({
      channel: 'youtube',
      followers: 123_000,
      display_name: 'Desk Fixture',
      region: 'DE',
    })
    expect(String(up[0]?.profile_url)).toContain('youtube.com/@deskfixture')
    // 本机才有的那几格不出门
    for (const key of ['joined_date', 'recent_items', 'total_views', 'bio', 'banner_url'])
      expect(up[0]).not.toHaveProperty(key)
    expect(JSON.stringify(svc.calls)).not.toContain('SECRET')
  })

  it('插件路：没点「存入红人池」的主页观测照旧是窄行；点过之后那几次才带资料字段（同一条规矩）', async () => {
    const svc = assemble()
    const obs = {
      channel: 'youtube' as const,
      handle: '@pluginfixture',
      display_name: 'Plugin Fixture',
      followers: 5000,
      observed_at: NOW,
      source: 'channel_page' as const,
    }
    await svc.port.ingest(pluginSession, { observations: [obs] })
    svc.port.saveCreator(pluginSession, {
      channel: 'youtube',
      handle: '@pluginfixture',
      country: 'Germany',
      observed_at: NOW,
      source: 'manual_save',
    })
    await svc.port.ingest(pluginSession, { observations: [obs] })
    await svc.port.publicForwardIdle()
    const [before, after] = cloudObservations(svc)
    expect(before).not.toHaveProperty('display_name')
    expect(before).not.toHaveProperty('region')
    expect(after).toMatchObject({ display_name: 'Plugin Fixture', region: 'DE' })
  })

  it('再读一次：已在池里（不算新增），资料刷新、又记一行', async () => {
    const svc = assemble()
    const cap = egoCapture(svc)
    const url = 'https://www.tiktok.com/@lunchfixture'
    const [first] = await cap.capture(actor, [url], { lang: 'en', rewrite: REWRITE })
    const [again] = await cap.capture(actor, [url], { lang: 'en', rewrite: REWRITE })
    expect(first?.pool).toMatchObject({ saved: true, new: true })
    expect(again?.pool).toMatchObject({ saved: true, new: false })
    expect(svc.kol.accounts().filter((a) => a.channel === 'tiktok')).toHaveLength(1)
    expect(
      svc.kol.accountObservations().filter((o) => o.source === 'manual_save' && o.profile),
    ).toHaveLength(2)
  })

  it('内容页 / 列表页照旧只报观测，不存入红人池；record: false 一个都不存', async () => {
    const svc = assemble()
    const cap = egoCapture(svc)
    const pages = await cap.capture(
      actor,
      ['https://www.youtube.com/watch?v=dfVid000001', 'https://www.tiktok.com/tag/mealprep'],
      { lang: 'en', rewrite: REWRITE },
    )
    expect(pages.map((p) => p.pool)).toEqual([undefined, undefined])
    expect(svc.kol.accountObservations().some((o) => o.source === 'manual_save')).toBe(false)

    const quiet = assemble()
    const [page] = await egoCapture(quiet).capture(
      actor,
      ['https://www.youtube.com/@deskfixture/videos'],
      { lang: 'en', rewrite: REWRITE, record: false },
    )
    expect(page?.pool).toBeUndefined()
    expect(quiet.kol.accounts()).toHaveLength(0)
  })

  it('插件那条路由的 schema：老插件的请求体照收，加入时间 / 近期作品只加；多一个键整批拒', () => {
    const old = JSON.parse(
      readFileSync(join(FIXTURES, 'pages/golden/save/youtube-channel.json'), 'utf8'),
    ).save_creator[0]
    expect(EXTENSION_CREATOR_SAVE_SCHEMA.safeParse(old).success).toBe(true)
    expect(
      EXTENSION_CREATOR_SAVE_SCHEMA.safeParse({
        ...old,
        joined_date: 'Mar 3, 2021',
        recent_items: [{ title: 'x', views: 1 }],
      }).success,
    ).toBe(true)
    expect(
      EXTENSION_CREATOR_SAVE_SCHEMA.safeParse({ ...old, recent_items: [{ title: 'x', body: 'y' }] })
        .success,
    ).toBe(false)
    expect(EXTENSION_CREATOR_SAVE_SCHEMA.safeParse({ ...old, comments: [] }).success).toBe(false)
  })

  it('工具回一句：存了几个、新增几个', async () => {
    const svc = assemble()
    const cap = egoCapture(svc)
    // 先收下一个，再一起读两个主页
    await cap.capture(actor, ['https://www.tiktok.com/@lunchfixture'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    const tools = createKolToolExecutor({
      workspace_id: WS,
      port: () => ({}) as never,
      now: () => NOW,
      egoCapture: {
        available: () => true,
        capture: (a, urls, o) => cap.capture(a, urls, { ...o, lang: 'en', rewrite: REWRITE }),
      },
    })
    const res = await tools({
      name: 'capture_creator_pages',
      input: {
        urls: [
          'https://www.youtube.com/@deskfixture/videos',
          'https://www.tiktok.com/@lunchfixture',
          'https://www.tiktok.com/tag/mealprep',
        ],
      },
      request: {
        actor: { person_id: 'pr_1', assignment_id: 'asg_1', role_id: 'kol.youtube' },
      } as never,
    })
    expect(res.status).toBe('ok')
    expect(res.data).toMatchObject({ read: 3, pool_saved: 2, pool_new: 1 })
    expect((res.data as { summary: string }).summary).toContain('存入红人池 2 个（新增 1 个')
  })
})

describe('WP498 1742 C：列表页每行带插件预筛的相关度分', () => {
  const WATCH = 'https://www.youtube.com/watch?v=SeedVideo01'

  /** 种子频道（这条视频的频道）先在红人库里，并带主题词（插件那条 seed-signature 就是从这里取的）。 */
  function withSeed(svc: ReturnType<typeof assemble>) {
    svc.port.saveCreator(pluginSession as never, {
      channel: 'youtube',
      handle: '@seedchannel',
      display_name: 'Seed Channel',
      observed_at: NOW,
    })
    const acc = svc.kol.accounts().find((a) => a.handle === '@seedchannel')
    if (acc === undefined) throw new Error('种子没收进去')
    svc.kol.saveAccount({ ...acc, category: 'standing desk setup cable' })
  }

  it('种子在库里：按分排、标出插件会筛掉的；一行不丢，分随观测记下', async () => {
    const svc = assemble()
    withSeed(svc)
    const [page] = await egoCapture(svc).capture(actor, [WATCH], { lang: 'en', rewrite: REWRITE })
    const list = page?.list as {
      relevance: { scored: boolean; plugin_would_skip: number; topics: string[] }
      candidates_total: number
      candidates: { handle: string; relevance_score?: number; plugin_would_skip?: boolean }[]
    }
    expect(list.relevance.scored).toBe(true)
    expect(list.relevance.topics).toContain('desk')
    expect(list.candidates).toHaveLength(list.candidates_total)
    const scores = list.candidates.map((c) => c.relevance_score as number)
    expect(scores.every((s) => typeof s === 'number')).toBe(true)
    expect([...scores].sort((a, b) => b - a)).toEqual(scores)
    // 猫视频那一行：插件会筛掉（不勾、不送），这里照记、排在最后、标出来
    const last = list.candidates.at(-1)
    expect(last).toMatchObject({ handle: '@catvideos', plugin_would_skip: true })
    expect(list.relevance.plugin_would_skip).toBeGreaterThan(0)
    expect(page?.recorded).toMatchObject({ saved: list.candidates_total, rejected: [] })
    // 分进了本机那一行快照（同插件 relevance_score）
    const cat = svc.kol.accounts().find((a) => a.handle === '@catvideos')
    const rows = svc.kol.accountObservations({ account_id: cat?.id as string })
    expect(rows.at(-1)).toMatchObject({ source: 'search_results', source_page: 'watch_related' })
    expect(typeof rows.at(-1)?.relevance_score).toBe('number')
  })

  it('种子不在库里：不打分（插件这时也不预筛），照页面顺序，并告诉 AI 怎么才有分', async () => {
    const svc = assemble()
    const [page] = await egoCapture(svc).capture(actor, [WATCH], { lang: 'en', rewrite: REWRITE })
    const list = page?.list as {
      relevance: { scored: boolean; note: string }
      candidates: { relevance_score?: number; plugin_would_skip?: boolean }[]
    }
    expect(list.relevance.scored).toBe(false)
    expect(list.relevance.note).toContain('主页')
    expect(list.candidates.some((c) => c.relevance_score !== undefined)).toBe(false)
    expect(list.candidates.some((c) => c.plugin_would_skip)).toBe(false)
  })

  it('话题页：插件不打分，照页面顺序全记', async () => {
    const svc = assemble()
    withSeed(svc)
    const [page] = await egoCapture(svc).capture(actor, ['https://www.tiktok.com/tag/mealprep'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    const list = page?.list as { relevance: { scored: boolean }; candidates_total: number }
    expect(list.relevance.scored).toBe(false)
    expect(page?.recorded).toMatchObject({ saved: list.candidates_total })
  })
})

describe('WP498 1752 C：存下的主页资料回给红人详情与 get_creator', () => {
  function kolPortOf(svc: ReturnType<typeof assemble>) {
    return createKolService({
      workspace_id: WS,
      store: svc.kol,
      secrets: { available: true, get: () => undefined, put: () => ({}) as never } as never,
      clock,
      approvals: {} as never,
      ledger: { stage: undefined as never, list: async () => [] },
      effectiveConfig: () => ({ actions: [], automation: {} }) as never,
      appendEvent: () => {},
      random: () => 0.5,
      assignmentsOf: () => [],
      holdersOf: () => [],
      brandName: () => '测试品牌',
      personName: (id: string) => id,
    } as never).port
  }

  it('红人详情带 profiles（按账号）：国家、加入时间、总播放、平均播放、作品数、简介、头像、横幅、近期作品', async () => {
    const svc = assemble()
    await egoCapture(svc).capture(actor, ['https://www.youtube.com/@deskfixture/videos'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    const account = svc.kol.accounts().find((a) => a.handle === '@deskfixture')
    const port = kolPortOf(svc)
    const detail = await port.creator(actor as never, account?.creator_id as string)
    const profile = detail?.profiles?.[account?.id as string]
    expect(profile).toMatchObject({
      saved_at: NOW,
      country: 'Germany',
      joined_date: 'Mar 3, 2021',
      total_views: 1_234_567,
      avg_views: 32_500,
      video_count: 231,
      avatar_url: 'https://yt3.example/avatar-deskfixture.png',
      banner_url: 'https://yt3.example/banner-deskfixture.png',
    })
    expect(profile?.bio).toContain('Desk setups')
    expect(profile?.recent_items?.length).toBe(8)

    // get_creator 工具回的就是这一份
    const tools = createKolToolExecutor({ workspace_id: WS, port: () => port, now: () => NOW })
    const res = await tools({
      name: 'get_creator',
      input: { creator_id: account?.creator_id },
      request: { actor: { person_id: 'pr_1', assignment_id: 'asg_1', role_id: 'kol.youtube' } } as never,
    })
    expect(res.status).toBe('ok')
    expect(
      (res.data as { profiles?: Record<string, { joined_date?: string }> }).profiles?.[
        account?.id as string
      ]?.joined_date,
    ).toBe('Mar 3, 2021')
  })

  it('没存入过红人池（只有列表页观测）：详情里没有 profiles', async () => {
    const svc = assemble()
    await egoCapture(svc).capture(actor, ['https://www.tiktok.com/tag/mealprep'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    const [account] = svc.kol.accounts()
    const detail = await kolPortOf(svc).creator(actor as never, account?.creator_id as string)
    expect(detail).toBeDefined()
    expect(detail?.profiles).toBeUndefined()
  })
})
