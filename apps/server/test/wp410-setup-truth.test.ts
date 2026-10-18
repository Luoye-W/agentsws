/**
 * WP410（真机 10-18 #5 #6 #9）：配置卡新旧交替与「AI 说的状态 = 真实状态」（替身审批总线、替身插件，不联网）。
 *
 * - #5 升级迁移：旧版留下的空表单卡（没有 `mode`）作废、换成方案卡（等着的事项带过去），跑一次就记下；
 *   Reddit 巡查旧版记下的「设置卡今天出过了」清掉；插件交回账号 → 不受一天一次限制、开着的卡按新知道的号重出；
 * - #6 要卡时开着的那张是旧版空表单 / 上次没查成 / AI 这次给的值不同 → 重查重出，不复用旧字段；
 *   没查成不装成方案：卡上、时间线上照实说原因、问要不要手填；
 * - #9 当前设置快照：连接以插件交回为准、设置读原值、最近一轮与开着的卡；只给登记了的职责。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type ApprovalBus,
  type ApprovalItem,
  type RedditWatchRun,
  type SetupField,
  type SetupRequestPayload,
  setupRequestDedupeKey,
} from '@agentsws/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createRedditWatch, PATROL_SETUP_MIGRATION_KEY } from '../src/reddit-watch/service.js'
import { createRedditWatchStore, type RedditWatchStore } from '../src/reddit-watch/store.js'
import { blockedLine } from '../src/run-blocked.js'
import {
  createSetupCards,
  LEGACY_SETUP_MIGRATION,
  researchFailure,
  SETUP_STATE_CONTEXT_ID,
  type SetupTarget,
} from '../src/setup-cards.js'

const NOW = '2026-10-18T11:00:00.000Z'
const WS = 'ws_ivra'
const ACTOR = { person_id: 'per_1', assignment_id: 'asg_1', role_id: 'social.reddit' } as never

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
    async withdraw(id: string) {
      const it = items.get(id) as ApprovalItem
      it.state = 'withdrawn'
      return it
    },
  } as never
}

/** 10-17 旧版（0.2.0-beta.11）出的那张 4 格空表单卡。 */
function legacyItem(id: string): ApprovalItem {
  const payload = {
    form: 'setup_request',
    target: 'reddit.watch',
    why: '告诉我自家版块和要盯的关键词，我每天巡查一次。',
    fields: [
      {
        key: 'own_subreddits',
        label: '自家版块',
        kind: 'text',
        suggested: 'ivraxr',
        required: false,
      },
      {
        key: 'keywords',
        label: '关键词',
        kind: 'text',
        placeholder: '品牌、型号、竞品，逗号分开',
        required: false,
      },
      { key: 'brand_username', label: '品牌号', kind: 'text', required: false },
      { key: 'every_hours', label: '多久一次', kind: 'select', suggested: '24', required: true },
    ],
  }
  return {
    id,
    state: 'pending',
    kind: 'setup_request',
    role_id: 'social.reddit',
    title: '先设好Reddit 巡查',
    payload,
    routing: { recipients: [{ person: 'per_1' }] },
    proposer: { kind: 'system', id: 'setup_cards', assignment_id: 'asg_1' },
  } as never
}

/** 那一天的巡查：插件连上了、登着 IVRA_Official；设置还空着（自家版只在连接里登记过）。 */
function ivraWatch(store: RedditWatchStore = createRedditWatchStore()) {
  store.setKv(WS as never, 'ext', { seen_at: NOW, reddit_connected: true, user: 'IVRA_Official' })
  let n = 0
  const complete = vi.fn(
    async () =>
      '{"own_subreddits":["ivraxr"],"watch_subreddits":[{"name":"SmartGlasses"}],"keywords":["IVRA","AI glasses"],"alert_words":["recall"],"tag_words":["Air3"],"why":{}}',
  )
  const watch = createRedditWatch({
    workspace_id: WS as never,
    store,
    now: () => NOW,
    newId: (p) => `${p}_${++n}`,
    tzOffsetMinutes: () => 480,
    brandName: () => 'IVRA',
    complete: () => complete,
    brandBrief: () => ({ name: 'IVRA' }),
    suggestions: () => ({ own_subreddits: ['ivraxr'] }),
    actor: () => ACTOR,
  })
  return { watch, store, complete }
}

function cardsWith(bus: ReturnType<typeof fakeBus>, dir?: string, connected = true) {
  const notes: { matter_id: string; text: string }[] = []
  const onCard = vi.fn()
  const cards = createSetupCards({
    workspace_id: WS,
    clock: { now: () => NOW },
    approvals: () => bus,
    isConnected: async () => connected,
    resume: async () => undefined,
    note: (matter_id, text) => notes.push({ matter_id, text }),
    onCard,
    ...(dir === undefined ? {} : { dir }),
  })
  return { cards, notes, onCard }
}

const payloadOf = (item: ApprovalItem | undefined) => item?.payload as SetupRequestPayload
const field = (p: SetupRequestPayload, k: string): SetupField | undefined =>
  p.fields.find((f) => f.key === k)

describe('#5 升级迁移：旧版空表单卡作废、换方案卡（跑一次就记下）', () => {
  it('旧卡收起；新卡是「我打算这样设」，品牌号预填插件交回的 IVRA_Official、自家版预填 ivraxr；等着的事项带过去', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp410-'))
    const bus = fakeBus()
    bus.items.set('apr_old', legacyItem('apr_old'))
    writeFileSync(
      join(dir, 'setup-cards.json'),
      JSON.stringify({
        version: 1,
        cards: {
          apr_old: {
            kind: 'setup_request',
            dedupe_key: setupRequestDedupeKey(WS, 'reddit.watch'),
            waiting: [{ matter_id: 'mat_1', person_id: 'per_1', assignment_id: 'asg_1' }],
          },
        },
      }),
    )
    const { watch } = ivraWatch()
    const { cards, notes, onCard } = cardsWith(bus, dir)
    cards.registerTarget(watch.setupTarget())
    expect(await cards.migrateLegacy?.()).toEqual({ withdrawn: 1, reasked: 1 })

    expect(bus.items.get('apr_old')?.state).toBe('withdrawn')
    const fresh = [...bus.items.values()].find((i) => i.id !== 'apr_old')
    expect(fresh?.title).toBe('Reddit 巡查：我打算这样设')
    const p = payloadOf(fresh)
    expect(p.mode).toBe('plan')
    expect(p.research_failed).toBeUndefined()
    expect(field(p, 'brand_username')?.suggested).toBe('IVRA_Official')
    expect(field(p, 'own_subreddits')?.suggested).toBe('ivraxr')
    expect(field(p, 'keywords')?.suggested).toContain('IVRA')
    // WP340 那 7 格都在（不是旧的 4 格）
    expect(p.fields.map((f) => f.key)).toEqual([
      'own_subreddits',
      'watch_subreddits',
      'keywords',
      'alert_words',
      'tag_words',
      'brand_username',
      'every_hours',
    ])
    expect(fresh?.subject.matter_id).toBe('mat_1')
    expect(onCard).toHaveBeenCalledWith(fresh)
    expect(notes.some((x) => x.matter_id === 'mat_1' && x.text.includes('旧版'))).toBe(true)

    // 记下了：再跑（同一份 / 新装配读回落盘）都不再动
    expect(await cards.migrateLegacy?.()).toEqual({ withdrawn: 0, reasked: 0 })
    const saved = JSON.parse(readFileSync(join(dir, 'setup-cards.json'), 'utf8')) as {
      migrations?: string[]
    }
    expect(saved.migrations).toEqual([LEGACY_SETUP_MIGRATION])
    bus.items.set('apr_old2', legacyItem('apr_old2'))
    const again = cardsWith(bus, dir)
    again.cards.registerTarget(watch.setupTarget())
    expect(await again.cards.migrateLegacy?.()).toEqual({ withdrawn: 0, reasked: 0 })
  })

  it('目标已经设好了：旧卡只作废、不再出卡', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp410-'))
    const bus = fakeBus()
    bus.items.set('apr_old', legacyItem('apr_old'))
    writeFileSync(
      join(dir, 'setup-cards.json'),
      JSON.stringify({
        version: 1,
        cards: {
          apr_old: {
            kind: 'setup_request',
            dedupe_key: setupRequestDedupeKey(WS, 'reddit.watch'),
            waiting: [],
          },
        },
      }),
    )
    const { watch } = ivraWatch()
    watch.updateSettings({ keywords: ['IVRA'] })
    const { cards } = cardsWith(bus, dir)
    cards.registerTarget(watch.setupTarget())
    expect(await cards.migrateLegacy?.()).toEqual({ withdrawn: 1, reasked: 0 })
    expect(bus.items.size).toBe(1)
  })

  it('Reddit 巡查：旧版记下的「设置卡今天出过了」开机清掉（只清一次）', () => {
    const store = createRedditWatchStore()
    store.setKv(WS as never, 'asked:setup', '2026-10-17T16:11:41.000Z')
    ivraWatch(store)
    expect(store.kv(WS as never, 'asked:setup')).toBeNull()
    expect(store.kv(WS as never, PATROL_SETUP_MIGRATION_KEY)).toBe(NOW)
    // 新版自己记下的节流不再被清
    store.setKv(WS as never, 'asked:setup', NOW)
    ivraWatch(store)
    expect(store.kv(WS as never, 'asked:setup')).toBe(NOW)
  })
})

describe('#5 插件交回账号：不受一天一次限制，开着的卡按新知道的号重出', () => {
  it('今天已经出过一张（品牌号空着）→ 插件交回 IVRA_Official → 那张收起、新卡预填 IVRA_Official', async () => {
    const store = createRedditWatchStore()
    let n = 0
    const bus = fakeBus()
    const { cards } = cardsWith(bus)
    const watch = createRedditWatch({
      workspace_id: WS as never,
      store,
      now: () => NOW,
      newId: (p) => `${p}_${++n}`,
      tzOffsetMinutes: () => 480,
      brandName: () => 'IVRA',
      brandBrief: () => ({ name: 'IVRA' }),
      setupCards: async () => cards,
      actor: () => ACTOR,
    })
    cards.registerTarget(watch.setupTarget())
    // 插件配上、还没连 Reddit：定时一拍出了一张（品牌号要你填）
    watch.next({ connected: false })
    await watch.tick()
    await vi.waitFor(() => expect(bus.items.size).toBe(1))
    const first = [...bus.items.values()][0] as ApprovalItem
    expect(field(payloadOf(first), 'brand_username')?.needs_you).toBe(true)
    // 一天一次：再一拍不出
    await watch.tick()
    expect(bus.items.size).toBe(1)

    // 插件连上 Reddit → 排「只看登着哪个号」→ 交回 IVRA_Official
    const job = watch.next({ connected: true }).job
    expect(job?.reads).toEqual([])
    await watch.result(
      job?.id as string,
      {
        outcome: 'ok',
        user: 'IVRA_Official',
        parts: [],
      } as never,
    )
    await vi.waitFor(() => expect(bus.items.size).toBe(2))
    expect(first.state).toBe('withdrawn')
    const second = [...bus.items.values()][1] as ApprovalItem
    expect(field(payloadOf(second), 'brand_username')).toMatchObject({
      suggested: 'IVRA_Official',
      sources: [{ kind: 'connected' }],
    })
  })
})

/** 一个通用的设置目标：查的结果由测试给。 */
function demoTarget(research: SetupTarget['research']): SetupTarget {
  return {
    id: 'demo.watch',
    name: '演示巡查',
    why: '我先查了一遍。',
    noGuess: ['account'],
    async fields() {
      return [
        { key: 'keywords', label: '关键词', kind: 'text', required: false },
        { key: 'account', label: '账号', kind: 'text', required: false },
        {
          key: 'every',
          label: '频率',
          kind: 'select',
          options: [{ value: '24', label: '每天' }],
          suggested: '24',
          required: true,
        },
      ]
    },
    async satisfied() {
      return false
    },
    async apply() {},
    ...(research === undefined ? {} : { research }),
  }
}

describe('#6 要卡时不复用旧字段；没查成照实说', () => {
  it('开着的是旧版空表单：AI 再要卡 → 重查重出（不是把旧卡原样还回来）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp410-'))
    const bus = fakeBus()
    bus.items.set('apr_old', legacyItem('apr_old'))
    writeFileSync(
      join(dir, 'setup-cards.json'),
      JSON.stringify({
        version: 1,
        // 迁移已经记过了（只看要卡这一条路）
        migrations: [LEGACY_SETUP_MIGRATION],
        cards: {
          apr_old: {
            kind: 'setup_request',
            dedupe_key: setupRequestDedupeKey(WS, 'reddit.watch'),
            waiting: [{ matter_id: 'mat_old', person_id: 'per_1', assignment_id: 'asg_1' }],
          },
        },
      }),
    )
    const { watch } = ivraWatch()
    const { cards, notes } = cardsWith(bus, dir)
    cards.registerTarget(watch.setupTarget())
    const out = await cards.askSetup({
      target: 'reddit.watch',
      actor: ACTOR,
      matter_id: 'mat_2',
      suggestions: { keywords: 'IVRA, IVRA Air3' },
    })
    expect(out?.item.id).not.toBe('apr_old')
    expect(bus.items.get('apr_old')?.state).toBe('withdrawn')
    const p = payloadOf(out?.item)
    expect(p.mode).toBe('plan')
    expect(field(p, 'keywords')?.suggested).toBe('IVRA, IVRA Air3')
    expect(field(p, 'brand_username')?.suggested).toBe('IVRA_Official')
    // 旧卡上等着的那件事说一声卡换了
    expect(notes.some((x) => x.matter_id === 'mat_old' && x.text.includes('换成新的'))).toBe(true)

    // 再要一次、AI 给的值一样 → 照旧挂上去（不来回换）
    const same = await cards.askSetup({
      target: 'reddit.watch',
      actor: ACTOR,
      matter_id: 'mat_3',
      suggestions: { keywords: 'IVRA, IVRA Air3' },
    })
    expect(same?.item.id).toBe(out?.item.id)
    // AI 这次给的值不一样 → 重出，正文和卡对得上
    const changed = await cards.askSetup({
      target: 'reddit.watch',
      actor: ACTOR,
      matter_id: 'mat_3',
      suggestions: { keywords: 'IVRA' },
    })
    expect(changed?.item.id).not.toBe(out?.item.id)
    expect(field(payloadOf(changed?.item), 'keywords')?.suggested).toBe('IVRA')
  })

  it('查完一格都没有：卡上写「没查成」与原因、时间线说一声；不装成方案', async () => {
    const bus = fakeBus()
    const { cards, notes } = cardsWith(bus)
    let filled = false
    cards.registerTarget(
      demoTarget(async (kit) => {
        await kit.profile()
        await kit.search('site:reddit.com x')
        await kit.ask('整理')
        return filled
          ? { keywords: { value: 'IVRA', why: '补好的档案' } }
          : { account: { needs_you: true } }
      }),
    )
    const out = await cards.askSetup({ target: 'demo.watch', actor: ACTOR, matter_id: 'mat_1' })
    const p = payloadOf(out?.item)
    expect(out?.item.title).toBe('演示巡查：没查成，要你来填吗')
    expect(p.research_failed).toBe('品牌档案还是空的；联网搜索没开；没接 AI 模型')
    expect(p.why).toContain('没查成：品牌档案还是空的；联网搜索没开；没接 AI 模型')
    expect(p.why).toContain('要不要你来填')
    expect(notes.at(-1)).toMatchObject({ matter_id: 'mat_1' })
    expect(notes.at(-1)?.text).toContain('没查成演示巡查的方案')

    // 补好档案后再要：上次没查成 → 重查，查成了换成方案卡（没查成那张收起）
    filled = true
    const again = await cards.askSetup({ target: 'demo.watch', actor: ACTOR, matter_id: 'mat_1' })
    expect(again?.item.id).not.toBe(out?.item.id)
    expect(out?.item.state).toBe('withdrawn')
    expect(again?.item.title).toBe('演示巡查：我打算这样设')
    expect(payloadOf(again?.item).research_failed).toBeUndefined()
  })

  it('查的时候出错：原因里带上那一句；查成了不算失败', async () => {
    const bus = fakeBus()
    const { cards } = cardsWith(bus)
    cards.registerTarget(
      demoTarget(async () => {
        throw new Error('quota exceeded')
      }),
    )
    const out = await cards.askSetup({ target: 'demo.watch', actor: ACTOR })
    expect(payloadOf(out?.item).research_failed).toContain('查的时候出错了：quota exceeded')

    const ok = fakeBus()
    const c2 = cardsWith(ok)
    c2.cards.registerTarget(
      demoTarget(async () => ({ keywords: { value: 'IVRA', why: '品牌名' } })),
    )
    const good = await c2.cards.askSetup({ target: 'demo.watch', actor: ACTOR })
    expect(payloadOf(good?.item).research_failed).toBeUndefined()
    expect(good?.item.title).toBe('演示巡查：我打算这样设')
  })

  it('researchFailure：只剩默认下拉 / 不让猜的格子才算没查成', () => {
    const f = (key: string, suggested?: string, kind: SetupField['kind'] = 'text'): SetupField => ({
      key,
      label: key,
      kind,
      required: false,
      ...(suggested === undefined ? {} : { suggested }),
    })
    const t = { noGuess: ['account'] }
    expect(
      researchFailure([f('kw'), f('account', 'A'), f('every', '24', 'select')], t, undefined, []),
    ).toBe('档案和搜索里都没找到能用的')
    expect(researchFailure([f('kw', 'IVRA')], t, undefined, ['联网搜索没开'])).toBeUndefined()
    expect(researchFailure([f('every', '24', 'select')], t, undefined, [])).toBeUndefined()
  })

  it('时间线那一句：没查成照实说原因，不说「定了个方案」', () => {
    const block = { reason: 'needs_setup', connections: [], tools: [], card_id: 'apr_1' } as never
    expect(blockedLine(block)).toContain('定了个方案')
    const line = blockedLine(block, { research_failed: '联网搜索没开' })
    expect(line).toContain('没查成（联网搜索没开）')
    expect(line).not.toContain('定了个方案')
  })
})

describe('#9 当前设置快照：连接以插件交回为准、设置读原值', () => {
  it('官方版块 / 外部版块带上；别的职责没有；值是库里的原值，最近一轮、开着的卡都在', async () => {
    const { watch, store } = ivraWatch()
    watch.updateSettings({
      own_subreddits: ['ivraxr'],
      keywords: [
        'IVRA',
        'translation glasses',
        'teleprompter glasses',
        'captions glasses',
        'AI glasses',
      ],
      brand_username: 'IVRA_Official',
    })
    const run: RedditWatchRun = {
      id: 'rwr_5cf4160584a9',
      workspace_id: WS as never,
      started_at: '2026-10-18T11:49:00.000Z',
      finished_at: '2026-10-18T11:52:00.000Z',
      final: false,
      trigger: 'manual',
      pending: 20,
      parts: [
        { part: 'inbox', status: 'ok', fetched: 7, fresh: 7 },
        { part: 'own_sub', status: 'ok', fetched: 26, fresh: 26 },
        { part: 'external', status: 'ok', fetched: 29, fresh: 28 },
      ],
    }
    store.putRun(run)
    const bus = fakeBus()
    const { cards } = cardsWith(bus, undefined, false)
    cards.registerTarget(watch.setupTarget())
    // 还开着一张旧的「连 Reddit API」连接卡（照实列出来，不是 AI 记着的）
    await cards.askConnect({
      actor: ACTOR,
      needs: [{ kind: 'reddit', service: 'reddit', name: 'Reddit API', required: true }],
      why: 'x',
    })

    expect(await cards.stateFor?.('support.inbox')).toBeUndefined()
    const item = await cards.stateFor?.('social.reddit')
    expect(item).toMatchObject({ id: SETUP_STATE_CONTEXT_ID, kind: 'summary' })
    // 外部版块看到同一份巡查设置；连接卡是官方版块名下的，只在官方版块那一份里列
    const pr = JSON.parse(String((await cards.stateFor?.('pr.reddit'))?.content)) as {
      settings: unknown[]
      open_cards: unknown[]
    }
    expect(pr.settings).toEqual(JSON.parse(String(item?.content)).settings)
    expect(pr.open_cards).toEqual([])
    const c = JSON.parse(String(item?.content)) as {
      note: string
      settings: {
        configured: boolean
        values: Record<string, string>
        connections: Record<string, string>
        notes: string[]
      }[]
      open_cards: { kind: string; title: string }[]
    }
    const s = c.settings[0]
    expect(s?.configured).toBe(true)
    expect(s?.connections['Chrome 插件（巡查走这条）']).toBe(
      '已连好：插件里连了 Reddit，Chrome 里登着 u/IVRA_Official',
    )
    expect(s?.connections['Reddit 官方 API']).toContain('不需要它')
    expect(s?.values.关键词).toBe(
      'IVRA, translation glasses, teleprompter glasses, captions glasses, AI glasses',
    )
    expect(s?.values.自家版块).toBe('ivraxr')
    expect(s?.values.品牌号).toBe('u/IVRA_Official')
    expect(s?.values.重点版块).toBe('（空）')
    // WP411 新加的设置格也在快照里（没设 = 随软件带的默认，照实标出）
    expect(s?.values.第一次外部巡查往回补).toBe('7 天（默认）')
    expect(s?.notes[0]).toContain('最近一轮巡查 2026-10-18T11:49:00.000Z')
    expect(s?.notes[0]).toContain('外部关键词读成了 29 条（新 28）')
    expect(c.open_cards).toEqual([{ kind: '连接卡', title: '先连上Reddit API' }])
    expect(c.note).toContain('不要凭之前的对话')
    expect(item?.bytes).toBe(new TextEncoder().encode(String(item?.content)).byteLength)
  })

  it('插件没配对 / 没连 Reddit / 没登录：照插件交回的说', async () => {
    const store = createRedditWatchStore()
    const { watch } = ivraWatch(store)
    const say = async () => {
      const st = await watch.setupTarget().state?.()
      return st?.connections?.['Chrome 插件（巡查走这条）']
    }
    store.setKv(WS as never, 'ext', {})
    expect(await say()).toBe('插件还没配对')
    store.setKv(WS as never, 'ext', { seen_at: NOW, reddit_connected: false })
    expect(await say()).toBe('插件配上了，但插件里还没连 Reddit')
    store.setKv(WS as never, 'ext', {
      seen_at: NOW,
      reddit_connected: true,
      outcome: 'not_logged_in',
    })
    expect(await say()).toBe('插件连了 Reddit，但 Chrome 里没登录 Reddit')
  })
})
