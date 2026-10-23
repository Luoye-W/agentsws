/**
 * WP496（决策 1738 / 1739 A / 1729）：ego 路采集红人与插件**同一套**。
 *
 * 不起真 ego、不联网：生成的只读脚本放进一个**进程内的假 ego 运行时**真跑一遍——假页面用 jsdom 渲染
 * （`creator-capture` 包里那批假页面），`page.evaluate(表达式)` 就在那个 jsdom 里求值。验：
 * ① `capture` 步：读到主页 / 内容页 / 列表页 / Linktree，顺手读 link-in-bio，读不到按插件节奏重试，空间收掉；
 * ② 只开映射里的地址（假页面测试路径上，真网站一个都不开）；
 * ③ 交给本机服务：过插件那几条路由同一道 schema、进同一个 `ExtensionService`——插件路与 ego 路送上云的一字不差，
 *    「不出门」清单照旧（WP487 那一套）；
 * ④ 工具 `capture_creator_pages`：ego 用不了 / 没给地址时的话术，读到的数字与算出来的体检 / 估值回给 AI；
 * ⑤ 1729：ego 输出「有新版本」时，连上探测、就绪缓存、需要插件那一份都带上提醒。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionObservation, ExtensionSession } from '@agentsws/api'
import type { Clock, PersonId, WorkspaceId } from '@agentsws/contracts'
import { ingestPlanOf } from '@agentsws/creator-capture'
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
import {
  createEgoCreatorCapture,
  createEgoPageReader,
  createEgoReadiness,
  egoCaptureCall,
  egoCapturePage,
  egoReadScript,
  ingestEgoPlan,
} from '../src/ego-read/index.js'
import type { EgoSpawn } from '../src/ego-write/runner.js'
import { egoUpdateNotice, probeEgoConnection } from '../src/ego-write/runner.js'
import { createExtensionContributor } from '../src/extension-contribute.js'
import { createExtensionService } from '../src/extension-service.js'
import { createKolStore } from '../src/kol.js'
import type { KolPublicFetch } from '../src/kol-public-client.js'
import { createKolToolExecutor } from '../src/kol-tools.js'
import { createSecretStore } from '../src/secret-store.js'

const WS = 'ws_1' as WorkspaceId
const NOW = '2026-10-23T10:00:00.000Z'
const clock: Clock = { now: () => NOW }
const CLOUD_TOKEN = 'wst_fixture_token_SECRET'

/* ── 假页面（creator-capture 包里那一批）──────────────────────────────── */

const FIXTURES = join(__dirname, '../../../packages/creator-capture/test/fixtures')
const PAGES: Record<string, string> = {
  'https://www.youtube.com/@deskfixture/videos': 'pages/youtube-channel.html',
  'https://www.youtube.com/@cablefixture': 'pages/youtube-channel-reveal.html',
  'https://www.tiktok.com/@lunchfixture': 'pages/tiktok-profile.html',
  'https://www.instagram.com/clayfixture/': 'pages/instagram-profile.html',
  'https://www.youtube.com/watch?v=dfVid000001': 'pages/youtube-video.html',
  'https://linktr.ee/deskfixture': 'pages/linktree.html',
  'https://www.tiktok.com/tag/mealprep': 'lists/tiktok-tag.html',
  'https://example.com/not-a-creator': '',
}
/** 假页面测试路径：真地址 → 本机假页面地址（只开映射里的）。 */
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

describe('WP496 ego 只读脚本：capture 步', () => {
  it('脚本里 capture 只求值、只打开链接页；生成的脚本里没有点击 / 打字', () => {
    const call = egoCaptureCall('https://www.youtube.com/@deskfixture/videos', { rewrite: REWRITE })
    const script = egoReadScript({
      space: 's',
      url: call.url,
      out: '/tmp/x.json',
      steps: call.steps as never,
      capture_template: call.capture?.template ?? '',
      capture_placeholder: call.capture?.placeholder ?? '',
    })
    const body = script.slice(script.indexOf('\n'))
    for (const banned of ['.fill(', '.type(', 'insertText', 'setInputFiles', 'selectOption'])
      expect(body).not.toContain(banned)
    // 打开的是映射过的本机假页面
    expect(call.url).toBe(REWRITE['https://www.youtube.com/@deskfixture/videos'])
  })

  it('读主页 + 顺手读 link-in-bio（只开映射里的），空间收掉', async () => {
    const { spawn, log } = fakeEgo()
    const got = await egoCapturePage(
      readerOf(spawn),
      'https://www.youtube.com/@deskfixture/videos',
      { lang: 'en', rewrite: REWRITE },
    )
    expect(got.ok).toBe(true)
    if (!got.ok) return
    expect(got.capture.creator).toMatchObject({
      platform: 'youtube',
      externalId: 'UCdeskFIXTURE0000000001',
      handle: '@deskfixture',
      followers: 123_000,
      videoCount: 231,
      avgViews: 32_500,
      totalViews: 1_234_567,
      country: 'Germany',
      joinedDate: 'Mar 3, 2021',
      businessEmail: 'biz@deskfixture.example',
    })
    expect(got.bio_links.map((b) => b.slug)).toEqual(['deskfixture'])
    expect(log.gotos).toEqual([
      REWRITE['https://www.youtube.com/@deskfixture/videos'],
      REWRITE['https://linktr.ee/deskfixture'],
    ])
    expect(log.finished).toEqual([{ keep: [] }])
  })

  it('link-in-bio 不在映射里：一个都不开', async () => {
    const { spawn, log } = fakeEgo()
    const only = {
      'https://www.youtube.com/@deskfixture/videos': REWRITE[
        'https://www.youtube.com/@deskfixture/videos'
      ] as string,
    }
    const got = await egoCapturePage(
      readerOf(spawn),
      'https://www.youtube.com/@deskfixture/videos',
      { rewrite: only },
    )
    expect(got.ok).toBe(true)
    expect(log.gotos).toHaveLength(1)
  })

  it('没渲染完就按插件的节奏再读；一直读不到 / 不是红人页如实说', async () => {
    const slow = fakeEgo({ slow: 3 })
    const ok = await egoCapturePage(readerOf(slow.spawn), 'https://www.tiktok.com/@lunchfixture', {
      rewrite: REWRITE,
    })
    expect(ok.ok).toBe(true)
    expect(slow.log.evaluates).toBe(4)

    const other = fakeEgo()
    const no = await egoCapturePage(readerOf(other.spawn), 'https://example.com/not-a-creator', {
      rewrite: REWRITE,
    })
    expect(no).toMatchObject({ ok: false })
    if (!no.ok) expect(no.why).toContain('不是认得出的')
    expect(other.log.finished).toEqual([{ keep: [] }])
  })
})

describe('WP496 交给本机服务：与插件同一个入口', () => {
  it('插件路与 ego 路送进本机 + 上云的一字不差（主页那一条，含 public_contacts）', async () => {
    const { spawn } = fakeEgo()
    const got = await egoCapturePage(readerOf(spawn), 'https://www.tiktok.com/@lunchfixture', {
      lang: 'en',
      rewrite: REWRITE,
    })
    if (!got.ok) throw new Error('没读到')
    const plan = ingestPlanOf(got.capture, { now: NOW })
    const obs = plan.observation_batches[0]?.[0] as ExtensionObservation
    expect(obs).toMatchObject({
      channel: 'tiktok',
      handle: 'lunchfixture',
      followers: 256_000,
      video_count: 412,
      public_contacts: [
        { kind: 'email', value: 'lunch@fixture.example' },
        { kind: 'website', value: 'https://lunch.example/recipes' },
      ],
    })

    // 插件路：同一条观测由插件令牌送进来
    const plugin = assemble()
    await plugin.port.ingest(pluginSession, { observations: [obs] })
    // ego 路：过同一道 schema、同一个 ExtensionService
    const ego = assemble()
    const out = await ingestEgoPlan(ego.port, actor, plan)
    expect(out).toMatchObject({ saved: 1, forwarded: 1, rejected: [] })
    expect(ego.calls.map((c) => c.body)).toEqual(plugin.calls.map((c) => c.body))
    expect(JSON.stringify(ego.calls)).not.toContain('SECRET')
    // 本机：公开邮箱收进本机加密库（WP487 那一条规矩）
    expect(JSON.stringify(ego.kol.accounts())).toContain('lunchfixture')
    expect(ego.kol.contacts().map((c) => c.source)).toContain('public_profile')
  })

  it('列表页：一批观测 + 红人带着的内容观测；内容页 / 链接页各一条', async () => {
    const svc = assemble()
    const capture = createEgoCreatorCapture({
      reader: readerOf(fakeEgo().spawn),
      port: () => svc.port,
      now: () => NOW,
    })
    const pages = await capture.capture(
      actor,
      [
        'https://www.tiktok.com/tag/mealprep',
        'https://www.youtube.com/watch?v=dfVid000001',
        'https://linktr.ee/deskfixture',
      ],
      { lang: 'en', rewrite: REWRITE },
    )
    expect(pages.map((p) => p.kind)).toEqual([['list'], ['content'], ['bio_link']])
    expect(pages[0]?.recorded).toMatchObject({ saved: 3, contents_recorded: 4, rejected: [] })
    expect(pages[1]?.content).toMatchObject({
      views: 39_421,
      likes: 2345,
      paid_promotion: true,
      duration_seconds: 725,
    })
    expect(pages[1]?.recorded?.contents_recorded).toBe(1)
    expect(pages[2]?.recorded).toMatchObject({ bio_links_recorded: 1, rejected: [] })
  })

  it('回给 AI 的：采集器读的数 + 面板那几块算出来的（体检、真实性、估值、更新规律）', async () => {
    const svc = assemble()
    const capture = createEgoCreatorCapture({
      reader: readerOf(fakeEgo().spawn),
      port: () => svc.port,
      now: () => NOW,
    })
    const [page] = await capture.capture(actor, ['https://www.youtube.com/@deskfixture/videos'], {
      lang: 'en',
      rewrite: REWRITE,
    })
    expect(page?.creator).toMatchObject({
      followers: 123_000,
      recent_items_total: 8,
      metrics: {
        health: { verdict: 'excellent', boughtAudienceSuspected: false },
        valuation: { kind: 'estimated', currency: 'USD' },
        regularity: { status: 'regular' },
      },
    })
    expect((page?.creator?.metrics.authenticity_signals ?? []).length).toBeGreaterThan(0)
    // link-in-bio 展开后的外链也进了公开联系方式
    expect(JSON.stringify(page?.creator?.public_contacts)).toContain('gear.example')
  })
})

describe('WP496 工具 capture_creator_pages', () => {
  const request = {
    actor: { person_id: 'pr_1', assignment_id: 'asg_1', role_id: 'kol.youtube' },
  } as never

  it('ego 用不了：叫 AI 改用 record_creator_observations', async () => {
    const tools = createKolToolExecutor({
      workspace_id: WS,
      port: () => ({}) as never,
      now: () => NOW,
      egoCapture: { available: () => false, capture: async () => [] },
    })
    const res = await tools({
      name: 'capture_creator_pages',
      input: { urls: ['https://www.youtube.com/@x'] },
      request,
    })
    expect(res.status).toBe('error')
    expect(res.reason).toContain('record_creator_observations')
  })

  it('只收 https:// 地址，最多 10 页，record 缺省记', async () => {
    const seen: { urls: readonly string[]; record: boolean }[] = []
    const tools = createKolToolExecutor({
      workspace_id: WS,
      port: () => ({}) as never,
      now: () => NOW,
      egoCapture: {
        available: () => true,
        capture: async (_a, urls, o) => {
          seen.push({ urls, record: o.record })
          return urls.map(() => ({ ok: true }))
        },
      },
    })
    const urls = Array.from({ length: 12 }, (_, i) => `https://www.youtube.com/@c${i}`)
    const res = await tools({
      name: 'capture_creator_pages',
      input: { urls: ['javascript:alert(1)', 'http://x', ...urls] },
      request,
    })
    expect(res.status).toBe('ok')
    expect(seen[0]?.urls).toHaveLength(10)
    expect(seen[0]?.record).toBe(true)
    expect(res.data).toMatchObject({ rows: 10, read: 10, note: '一次最多 10 页，后面的没读' })
    const none = await tools({ name: 'capture_creator_pages', input: { urls: [] }, request })
    expect(none.status).toBe('error')
  })
})

describe('WP496 决策 1729：ego 有新版本时提一句', () => {
  const NOTICE =
    '[ego-browser:notice] Ego Lite update is available (current 0.6.0.16). Finish the current browser task, then ask the user before running `ego-browser upgrade`.'

  it('认得出那一句（带 / 不带当前版本）', () => {
    expect(egoUpdateNotice(`hi\n${NOTICE}\n`)).toEqual({ current: '0.6.0.16' })
    expect(egoUpdateNotice('[ego-browser:notice] Ego Lite update is available.')).toEqual({})
    expect(egoUpdateNotice('@@OK 3')).toBeUndefined()
  })

  it('真连一次时带上「有新版本」；就绪缓存记着它；不替人升级', async () => {
    const calls: string[][] = []
    const spawn: EgoSpawn = async ({ args }) => {
      calls.push([...args])
      return {
        exit_code: 0,
        timed_out: false,
        duration_ms: 1,
        stdout: `@@OK 2\n${NOTICE}\n`,
        stderr: '',
      }
    }
    const probe = await probeEgoConnection('/e', spawn)
    expect(probe).toEqual({
      connected: true,
      update_available: true,
      update_current: '0.6.0.16',
    })
    const ready = createEgoReadiness({
      path: () => '/e',
      probe: (p) => probeEgoConnection(p, spawn),
    })
    await ready.refresh()
    expect(ready.ready()).toBe(true)
    expect(ready.update()).toEqual({ current: '0.6.0.16' })
    expect(calls.flat()).not.toContain('upgrade')
  })
})
