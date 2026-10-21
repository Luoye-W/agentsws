/**
 * WP349（Luoye 10-15 改决策 881）：品牌分析联网查——服务端这一侧。
 *
 * 钉住：
 * 1. 搜得了：复用 `webSearchOf`（审计 `web.searched{entry: brand_intake}`、用量 `model.usage{web_search}`），
 *    结果进同一次 AI 归纳；竞品带来源、没来源的丢；确认后来源跟着竞品进档案，设置页保存不丢；
 * 2. 7 天缓存与配置卡共用：同一句话再分析一次不再搜；
 * 3. 搜不了（没接搜索）：一次不搜，竞品空着，run 上照实写「没联网，查不了竞品」和原因。
 *
 * 抓取、搜索、模型都是替身（本地夹具、写死的回复），不联网、不花钱。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { PageFetch } from '@agentsws/brand-intake'
import type { BrandIntakeRun, WorkspaceProfile } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
)
const TRAIL = 'https://trailmark.example'
const PAGES: Record<string, string> = {
  [`${TRAIL}/robots.txt`]: 'robots.txt',
  [`${TRAIL}/`]: 'specs-home.html',
  [`${TRAIL}/products/ridge-28`]: 'specs-ridge.html',
}
const replay: PageFetch = async (url) => {
  const name = PAGES[url]
  if (name === undefined) return { ok: false, status: 404, text: async () => '' }
  return { ok: true, status: 200, text: async () => readFileSync(join(FIXTURES, name), 'utf8') }
}

/** 搜索替身：发现那句回「alternatives」页；核实回官网；品牌评测回一篇评测。 */
const HITS: [RegExp, { url: string; title?: string; snippet?: string }[]][] = [
  [
    /alternatives/,
    [
      {
        url: 'https://outdoorgear.example/trailmark-alternatives',
        title: 'Best Trailmark alternatives: Osprey, Deuter',
      },
    ],
  ],
  [/^Osprey/, [{ url: 'https://www.osprey.com/daypacks', title: 'Osprey daypacks' }]],
  [/review/, [{ url: 'https://gearlab.example/trailmark-review', title: 'Trailmark review' }]],
]

const REPLY = {
  positioning: '给带娃徒步的家长做的轻量背包。',
  audience: { buyers: '周末带孩子徒步的家长' },
  competitors: [
    { name: 'Osprey', reason: '同价位徒步背包', url: 'https://www.osprey.com' },
    { name: 'Deuter', reason: '亲子背负系列' },
    { name: 'Patagonia', reason: '只在模型记忆里' },
  ],
}

const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close()
})

async function boot(
  options: {
    web?: boolean
    channel?: import('../src/web-browser/index.js').SearchBrowserChannel
  } = {},
) {
  const asked: string[] = []
  const prompts: string[] = []
  let t = Date.parse('2026-10-15T09:00:00.000Z')
  const server = await createServer({
    clock: {
      now: () => {
        t += 1
        return new Date(t).toISOString()
      },
    },
    quiet: true,
    startRun: false,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    liveDataIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'luoye@example.com', AGENTSWS_WORKSPACE_NAME: 'Trailmark' },
    mdns: () => ({ reason: '测试里不开局域网' }),
    brandIntakeFetch: replay,
    brandIntakeModel: async ({ prompt }: { prompt: string }) => {
      prompts.push(prompt)
      return { text: JSON.stringify(REPLY) }
    },
    // WP353：真后端（内置浏览器替身通道，公开搜索服务关掉、不联网）
    ...(options.channel === undefined
      ? {}
      : { webSearch: { channel: options.channel, keyless: false, gapMs: [0, 0] as const } }),
    ...(options.web === false || options.channel !== undefined
      ? {}
      : {
          freeChatWebSearch: async (query: string) => {
            asked.push(query)
            return { sources: HITS.find(([re]) => re.test(query))?.[1] ?? [] }
          },
        }),
  })
  servers.push(server)
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await server.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': server.bootstrap.ownerAssignment.id,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const parsed = (await res.json()) as { data?: T; message?: string }
    return { status: res.status, data: parsed.data as T, message: parsed.message }
  }
  const analyze = async (): Promise<BrandIntakeRun> => {
    const started = await call<BrandIntakeRun>('POST', '/v1/brand-intake/runs', {
      urls: [`${TRAIL}/`],
    })
    expect(started.status, started.message).toBe(201)
    for (let i = 0; i < 400; i++) {
      const run = (await call<BrandIntakeRun>('GET', `/v1/brand-intake/runs/${started.data.id}`))
        .data
      if (run.status !== 'running') return run
      await new Promise((r) => setTimeout(r, 5))
    }
    throw new Error('分析没跑完')
  }
  const ws = server.bootstrap.workspace.id
  const events = () => server.kernel.eventLog.readSync({ workspace_id: ws })
  const archive = () => server.onboarding.brandProfile(ws) as Partial<WorkspaceProfile>
  return { server, call, analyze, asked, prompts, events, archive }
}

describe('WP349 品牌分析联网查（服务端）', () => {
  it('搜得了：走共用的联网搜索（审计 + 用量），竞品带来源、没来源的丢；确认后来源进档案，设置页保存不丢', async () => {
    const b = await boot()
    const run = await b.analyze()
    expect(run.insights).toBe('done')
    expect(run.web?.status).toBe('done')
    expect(run.web?.searches).toBeGreaterThan(0)
    expect(run.web?.searches).toBeLessThanOrEqual(9)
    expect(run.web?.credits).toBe(0)
    expect(b.asked[0]).toBe('Trailmark alternatives')
    expect(b.prompts[0]).toContain('<<<WEB')

    const comp = run.profile.competitors?.value ?? []
    expect(comp.map((c) => c.name)).toEqual(['Osprey', 'Deuter'])
    expect(comp[0]?.url).toBe('https://www.osprey.com/')
    // 核实那一句搜到的优先，其次发现那一页
    expect(comp[0]?.sources?.map((x) => x.url)).toEqual([
      'https://www.osprey.com/daypacks',
      'https://outdoorgear.example/trailmark-alternatives',
    ])
    expect(comp[1]?.sources?.[0]?.url).toBe('https://outdoorgear.example/trailmark-alternatives')

    // 共用的那条搜索：每搜一次一条审计（入口 brand_intake）+ 一笔 web_search 用量
    const all = b.events()
    const searched = all.filter((e) => e.type === 'web.searched')
    expect(searched).toHaveLength(run.web?.searches ?? -1)
    expect(searched.every((e) => (e.payload as { entry: string }).entry === 'brand_intake')).toBe(
      true,
    )
    const usage = all
      .filter((e) => e.type === 'model.usage')
      .filter((e) => (e.payload as { purpose: string }).purpose === 'web_search')
    expect(usage).toHaveLength(searched.length)

    // 确认：来源跟着竞品进档案（AI 建议照旧挂着）
    const confirmed = await b.call('POST', `/v1/brand-intake/runs/${run.id}/confirm`, {})
    expect(confirmed.status, confirmed.message).toBe(200)
    const a = b.archive()
    expect(a.competitors?.[0]?.sources?.[0]?.url).toBe('https://www.osprey.com/daypacks')
    expect(a.ai_suggested).toContain('competitors')

    // 设置页保存整份竞品（改了 Deuter 的理由）：来源不丢
    const saved = await b.call('PUT', '/v1/workspace/profile', {
      legal_name: 'Trailmark',
      competitors: (a.competitors ?? []).map((c) =>
        c.name === 'Deuter' ? { ...c, reason: '人改的理由' } : c,
      ),
    })
    expect(saved.status, saved.message).toBe(200)
    const after = b.archive()
    expect(after.competitors?.[1]?.reason).toBe('人改的理由')
    expect(after.competitors?.[0]?.sources?.[0]?.url).toBe('https://www.osprey.com/daypacks')
    expect(after.competitors?.[1]?.sources?.[0]?.title).toBe(
      'Best Trailmark alternatives: Osprey, Deuter',
    )
  })

  it('同一句话 7 天内不再搜（与配置卡共用的那份缓存）', async () => {
    const b = await boot()
    await b.analyze()
    const first = b.asked.length
    expect(first).toBeGreaterThan(0)
    const again = await b.analyze()
    expect(again.web?.status).toBe('done')
    expect(b.asked.length).toBe(first)
    expect(again.profile.competitors?.value.map((c) => c.name)).toEqual(['Osprey', 'Deuter'])
  })

  it('搜不了：一次不搜，竞品空着，照实说没联网与原因（模型给了竞品也不收）', async () => {
    const b = await boot({ web: false })
    const run = await b.analyze()
    expect(run.insights).toBe('done')
    expect(run.web?.status).toBe('off')
    expect(run.web?.reason).toContain('没联网，查不了竞品')
    expect(run.web?.reason).toContain('内置浏览器')
    expect(run.profile.competitors).toBeUndefined()
    expect(run.profile.positioning?.value).toContain('家长')
    expect(b.prompts[0]).toContain('Do NOT output "competitors"')
    expect(b.events().filter((e) => e.type === 'web.searched')).toHaveLength(0)
  })
})

describe('WP353 品牌分析联网查走工坊内置浏览器（服务端装配）', () => {
  it('德国市场品牌：查法用德语、内置浏览器开 Google 带 gl=de&hl=de；审计照记、不记模型用量', async () => {
    const opened: string[] = []
    const channel = {
      open: async (i: { url: string }) => {
        opened.push(i.url)
        const q = new URL(i.url).searchParams.get('q') ?? ''
        return {
          ok: true as const,
          status: 200,
          final_url: i.url,
          serp: {
            signals: { title: q, text: '', captcha: false, passwordInputs: 0 },
            items:
              HITS.find(([re]) => re.test(q))?.[1].map((h) => ({ ...h, title: h.title ?? '' })) ??
              [],
          },
        }
      },
      reveal: async () => false,
      status: async () => ({ revealed: false }),
    }
    const b = await boot({ channel })
    const saved = await b.call('PUT', '/v1/workspace/profile', {
      legal_name: 'Trailmark',
      markets: ['DE'],
    })
    expect(saved.status, saved.message).toBe(200)
    const run = await b.analyze()
    expect(run.web?.status).not.toBe('off')
    // WP454：第一次搜 Google 前先开一次首页热身（壳没说有 cookie）；搜索页才带 gl / hl
    expect(opened.filter((u) => u === 'https://www.google.com/')).toHaveLength(1)
    const google = opened
      .map((u) => new URL(u))
      .filter((u) => u.hostname === 'www.google.com' && u.pathname === '/search')
    expect(google.length).toBeGreaterThan(0)
    expect(
      google.every((u) => u.searchParams.get('gl') === 'de' && u.searchParams.get('hl') === 'de'),
    ).toBe(true)
    expect(google.map((u) => u.searchParams.get('q'))).toContain('Trailmark Alternativen')
    const all = b.events()
    expect(all.filter((e) => e.type === 'web.searched').length).toBeGreaterThan(0)
    expect(
      all.filter(
        (e) =>
          e.type === 'model.usage' && (e.payload as { purpose: string }).purpose === 'web_search',
      ),
    ).toHaveLength(0)
  })
})
