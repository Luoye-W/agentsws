/**
 * WP348（决策 887）：Reddit 巡查配置卡先查、先定方案（替身插件 × 替身 Reddit × 替身搜索，不联网）。
 *
 * - 品牌号来自插件登录态（替身插件交回的 `/api/me.json`），不来自模型、也不来自 AI 在对话里给的建议；
 * - 档案（WP346 那几格有就用）+ 搜到的版块 → 自家版块、重点版块（带频率）、关键词（含竞品）；频率默认每天；
 * - 插件没配对 / 没连 Reddit：品牌号标「需要你填」，说清是哪一种；
 * - 「只看登着哪个号」那一件不占读的次数，真巡查来了直接顶掉它；
 * - 广告账户只认插件在后台网址里看到的（`adsAccountHintOfUrl`），查不到要你填。
 */
import {
  adsAccountHintOfUrl,
  formatAdsAccountHints,
  parseAdsAccountHints,
  redditPaceKey,
  runRedditRead,
} from '@agentsws/browser-action'
import type { ApprovalBus, ApprovalItem, SetupRequestPayload } from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { adsAccountsSetupTarget } from '../src/ads-data/accounts.js'
import { researchPatrol, subsInHits } from '../src/reddit-watch/plan.js'
import { createRedditWatch } from '../src/reddit-watch/service.js'
import { createRedditWatchStore } from '../src/reddit-watch/store.js'
import { createSetupCards } from '../src/setup-cards.js'
import { brandFactsOf, createResearchKit, mergePlan } from '../src/setup-research.js'

const ACTOR = { person_id: 'p1', assignment_id: 'as1', role_id: 'social.reddit' } as never

const HITS = [
  { url: 'https://www.reddit.com/r/ivraxr/comments/a/b/', title: 'r/ivraxr - IVRA Air3 review' },
  {
    url: 'https://www.reddit.com/r/SmartGlasses/comments/c/',
    title: 'Best AR glasses? : r/SmartGlasses',
  },
  { url: 'https://www.reddit.com/r/SmartGlasses/', title: 'r/SmartGlasses' },
  {
    url: 'https://www.reddit.com/r/Xreal/comments/d/',
    title: 'Xreal vs IVRA',
    snippet: 'also on r/augmentedreality',
  },
]

const facts = () =>
  brandFactsOf(
    {
      category: 'AR glasses',
      keywords: { brand: ['IVRA Air3'], category: ['translation glasses'], scenario: [] },
      competitors: [{ name: 'Xreal', reason: '同品类' }],
    },
    { name: 'IVRA' },
  )

describe('researchPatrol', () => {
  it('品牌号来自插件；档案 + 搜到的版块 → 方案（没模型也有）；频率默认每天', async () => {
    const search = vi.fn(async () => HITS)
    const { kit, steps } = createResearchKit({ profile: facts, search })
    const plan = await researchPatrol(kit, {
      registered: () => undefined,
      plugin: () => ({ state: 'connected', user: 'IVRA_Official' }),
      suggest: async () => undefined,
    })
    expect(plan.brand_username).toMatchObject({
      value: 'IVRA_Official',
      sources: [{ kind: 'connected' }],
    })
    expect(plan.own_subreddits?.value).toBe('ivraxr')
    expect(plan.own_subreddits?.sources?.[0]?.url).toBe(HITS[0]?.url)
    // 搜到次数多的前两个每天、其余每周；自家版不进重点版块
    expect(plan.watch_subreddits?.value).toBe('SmartGlasses, Xreal, augmentedreality（每周）')
    expect(plan.keywords?.value).toBe('IVRA, IVRA Air3, translation glasses, Xreal')
    expect(plan.keywords?.sources?.map((s) => s.label)).toContain('品牌档案 · 竞品')
    expect(plan.every_hours).toMatchObject({ value: '24', why: '默认每天一次' })
    expect(plan.alert_words).toBeUndefined()
    expect(search).toHaveBeenCalledTimes(3)
    expect(steps().map((s) => s.text)).toEqual([
      '看了品牌档案：IVRA · AR glasses · 关键词 2 个 · 竞品 1 个',
      '插件里登着的 Reddit 号：u/IVRA_Official',
      '搜了 Reddit 上的相关版块：r/SmartGlasses、r/ivraxr、r/Xreal、r/augmentedreality',
    ])
  })

  it('插件没配对 / 没连：品牌号要你填并说清；连接里登记的号照样用；搜不了网照实说', async () => {
    const run = async (plugin: { state: 'unpaired' | 'not_connected' | 'connected' }, reg = {}) => {
      const { kit, steps } = createResearchKit({ profile: facts })
      const plan = await researchPatrol(kit, {
        registered: () => reg,
        plugin: () => plugin,
        suggest: async () => undefined,
      })
      return { plan, steps: steps().map((s) => s.text) }
    }
    expect((await run({ state: 'unpaired' })).plan.brand_username).toMatchObject({
      needs_you: true,
      why: '插件还没配对，看不到登着哪个号',
    })
    expect((await run({ state: 'not_connected' })).plan.brand_username?.why).toMatch(
      /还没连 Reddit/,
    )
    const reg = await run({ state: 'connected' }, { brand_username: 'ivra_brand' })
    expect(reg.plan.brand_username).toMatchObject({
      value: 'ivra_brand',
      sources: [{ kind: 'connected', label: '连接里登记的 Reddit 号' }],
    })
    expect(reg.steps).toContain('这次搜不了网（联网搜索没开）')
  })

  it('subsInHits：网址与标题里的 r/x 都认，同一条只算一次', () => {
    expect(subsInHits(HITS).map((x) => [x.name, x.count])).toEqual([
      ['SmartGlasses', 2],
      ['ivraxr', 1],
      ['Xreal', 1],
      ['augmentedreality', 1],
    ])
  })
})

function fakeBus(): ApprovalBus & { items: Map<string, ApprovalItem> } {
  const items = new Map<string, ApprovalItem>()
  let n = 0
  return {
    items,
    async create(raw: Partial<ApprovalItem>) {
      n += 1
      const item = { ...raw, id: `apr_${n}`, state: 'pending', revision: 1 } as ApprovalItem
      items.set(item.id, item)
      return item
    },
    async get(id: string) {
      return items.get(id)
    },
    async withdraw() {
      return undefined
    },
  } as never
}

describe('Reddit 巡查方案卡（替身插件）', () => {
  it('插件连上 → 先看登着哪个号（不占读的次数）→ 方案里品牌号就是它；模型和 AI 的建议都碰不到品牌号', async () => {
    let n = 0
    const complete = vi.fn(
      async () =>
        '{"own_subreddits":["ivraxr"],"watch_subreddits":[{"name":"SmartGlasses","per_week":7}],"keywords":["IVRA"],"alert_words":["recall"],"tag_words":["Air3"],"why":{}}',
    )
    const watch = createRedditWatch({
      workspace_id: 'ws_1' as never,
      store: createRedditWatchStore(),
      now: () => '2026-10-14T02:00:00.000Z',
      newId: (p) => `${p}_${++n}`,
      tzOffsetMinutes: () => 480,
      brandName: () => 'IVRA',
      complete: () => complete,
      brandBrief: () => ({ name: 'IVRA' }),
      actor: () => ACTOR,
    })
    const got = watch.next({ connected: true })
    expect(got.job?.reads).toEqual([])
    const res = await runRedditRead(got.job as never, {
      fetch: async (url) => ({
        status: 200,
        url,
        content_type: 'application/json',
        body: JSON.stringify({ kind: 't2', data: { name: 'IVRA_Official' } }),
      }),
      sleep: async () => {},
      stopped: () => false,
      gapMs: 0,
    })
    expect(await watch.result(got.job?.id as string, res)).toEqual({ accepted: true })
    expect(watch.pluginState()).toEqual({ state: 'connected', user: 'IVRA_Official' })
    // 没占读的次数；之后不再排
    const at = Date.parse('2026-10-14T02:00:00.000Z')
    expect(watch.pace.leftKey(redditPaceKey(undefined, 'ws_1'), at)).toEqual(
      watch.pace.leftKey('reddit:untouched', at),
    )
    expect(watch.next({ connected: true }).job).toBeUndefined()

    const bus = fakeBus()
    const cards = createSetupCards({
      workspace_id: 'ws_1',
      clock: { now: () => '2026-10-14T02:00:00.000Z' },
      approvals: () => bus,
      isConnected: async () => true,
      resume: async () => undefined,
    })
    cards.registerTarget(watch.setupTarget())
    const out = await cards.askSetup({
      target: 'reddit.watch',
      actor: ACTOR,
      suggestions: { brand_username: 'model_guess', keywords: 'IVRA, AR glasses' },
    })
    const p = out?.item.payload as SetupRequestPayload
    expect(out?.item.title).toBe('Reddit 巡查：我打算这样设')
    const by = (k: string) => p.fields.find((f) => f.key === k)
    expect(by('brand_username')).toMatchObject({
      suggested: 'IVRA_Official',
      sources: [{ kind: 'connected', label: '插件里登着的 Reddit 号' }],
    })
    expect(by('keywords')?.suggested).toBe('IVRA, AR glasses')
    expect(by('own_subreddits')?.suggested).toBe('ivraxr')
    expect(by('every_hours')).toMatchObject({ suggested: '24', suggested_why: '默认每天一次' })
    expect(p.steps?.map((s) => s.text)).toContain('插件里登着的 Reddit 号：u/IVRA_Official')
    expect(complete).toHaveBeenCalledTimes(1)

    // 真巡查来了：顶掉还没领的「只看登着哪个号」
    const fresh = createRedditWatch({
      workspace_id: 'ws_2' as never,
      store: createRedditWatchStore(),
      now: () => '2026-10-14T02:00:00.000Z',
      newId: (p) => `${p}_${++n}`,
      tzOffsetMinutes: () => 480,
      actor: () => ACTOR,
    })
    fresh.next({ connected: true })
    fresh.updateSettings({ own_subreddits: ['ivraxr'] })
    const run = await fresh.runNow()
    expect(run.parts.every((x) => x.status === 'waiting')).toBe(true)
    expect(fresh.next({ connected: true }).job?.reads.length).toBeGreaterThan(0)
  })
})

describe('广告账户：只认插件在后台里看到的', () => {
  it('网址认账户；方案用插件看到的；没看到要你填并说清', async () => {
    expect(
      adsAccountHintOfUrl('https://ads.google.com/aw/overview?ocid=123&__c=1234567890&__u=9'),
    ).toEqual({ platform: 'google_ads', id: '1234567890', ocid: '123' })
    expect(
      adsAccountHintOfUrl('https://adsmanager.facebook.com/adsmanager/manage?act=987654'),
    ).toEqual({ platform: 'meta_ads', id: '987654' })
    expect(adsAccountHintOfUrl('http://ads.google.com/?__c=1234567890')).toBeUndefined()
    const line = formatAdsAccountHints([
      { platform: 'google_ads', id: '1234567890', ocid: '123' },
      { platform: 'meta_ads', id: '987654' },
    ])
    expect(parseAdsAccountHints(`${line},evil:1,google_ads:12`)).toHaveLength(2)

    const target = (seen: Parameters<typeof adsAccountsSetupTarget>[0]['seen']) =>
      adsAccountsSetupTarget({
        wanted: () => ['google', 'meta'],
        get: () => ({}),
        set: () => undefined,
        ...(seen === undefined ? {} : { seen }),
      })
    const t = target(() => ({
      plugin: [
        { platform: 'google', state: 'ready' },
        { platform: 'meta', state: 'not_connected' },
      ],
      accounts: [{ platform: 'google', id: '1234567890', ocid: '123' }],
    }))
    const { kit } = createResearchKit({ profile: () => ({}) })
    const plan = await t.research?.(kit)
    const fields = mergePlan(await t.fields(), plan ?? {}, { noGuess: t.noGuess ?? [] })
    expect(fields.find((f) => f.key === 'google')).toMatchObject({
      suggested: '123-456-7890',
      sources: [{ kind: 'connected' }],
    })
    expect(fields.find((f) => f.key === 'meta')).toMatchObject({
      needs_you: true,
      suggested_why: '先在插件里连上Meta 广告后台：连好我自己认账户（也可以贴后台网址）',
    })
    // AI 在对话里给的账户不认
    const guessed = mergePlan(await t.fields(), plan ?? {}, {
      noGuess: t.noGuess ?? [],
      suggestions: { meta: 'act_111111' },
    })
    expect(guessed.find((f) => f.key === 'meta')?.suggested).toBeUndefined()
    const unpaired = target(undefined)
    const p2 = await unpaired.research?.(createResearchKit({ profile: () => ({}) }).kit)
    expect(p2?.google).toMatchObject({
      needs_you: true,
      why: '先配插件：配好了我自己在后台里认账户（急的话也可以贴后台网址）',
    })
  })
})
