/**
 * WP398（docs/106 §13 A8）：Amazon 词库——联想词读取（录好的响应、不联网）、被拦就停、拆 Listing、差距、标记、三个工具。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AmazonListingText, RunRequest } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import {
  type AmazonAutocompleteReader,
  type AutocompleteRead,
  createAmazonKeywordBank,
  createAmazonKeywordToolExecutor,
  createBrowserAutocompleteReader,
  listingTextsFromFacts,
  listingTextsFromSnapshots,
} from '../src/amazon-keywords/index.js'
import { createSearchThrottle, type SearchBrowserChannel } from '../src/web-browser/index.js'

const FX = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'brand-intake',
  'test',
  'fixtures',
  'wp398',
)
const fx = (name: string): string => readFileSync(join(FX, name), 'utf8')

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wp398-'))
  dirs.push(d)
  return d
}

const at = '2026-10-18T08:00:00.000Z'
const OWN: AmazonListingText = {
  side: 'own',
  asin: 'B0OWN00001',
  marketplace: 'US',
  brand: 'Nordride',
  title: 'Nordride Electric Bike for Adults, 750W Motor, 28MPH Commuter E-Bike',
  bullets: ['LONG RANGE: up to 50 miles per charge.'],
  read_at: at,
}
const comp = (id: string, name: string, asin: string, title: string): AmazonListingText => ({
  side: 'competitor',
  competitor_id: id,
  competitor: name,
  asin,
  marketplace: 'US',
  title,
  read_at: at,
})
const COMPETITORS = [
  comp('c1', 'Voltway', 'B0VOLT0001', 'Voltway Fat Tire Electric Bike with Removable Battery'),
  comp('c2', 'Ridgeline', 'B0RIDG0001', 'Ridgeline Electric Mountain Bike, Removable Battery'),
  comp(
    'c3',
    'Pedalux',
    'B0PEDL0001',
    'Pedalux Step-Thru Electric Bike, Removable Battery, Fat Tire',
  ),
]

/** 录好的联想词：种子词本身、`… a` 两页有录音，其余回空表。 */
function recordedReader(opts: { blockAt?: number; quotaAt?: number } = {}) {
  const calls: string[] = []
  const reader: AmazonAutocompleteReader = {
    async suggest({ prefix }): Promise<AutocompleteRead> {
      calls.push(prefix)
      if (opts.blockAt !== undefined && calls.length === opts.blockAt)
        return { status: 'blocked', message: 'Amazon 要人机验证' }
      if (opts.quotaAt !== undefined && calls.length === opts.quotaAt)
        return { status: 'quota', message: '这一小时额度满了' }
      const text =
        prefix === 'electric bike'
          ? fx('suggest-electric-bike.json')
          : prefix === 'electric bike a'
            ? fx('suggest-electric-bike-a.json')
            : '{"suggestions":[]}'
      const parsed = JSON.parse(text) as { suggestions: { type: string; value: string }[] }
      return {
        status: 'ok',
        suggestions: parsed.suggestions
          .filter((s) => s.type === 'KEYWORD')
          .map((s) => s.value.toLowerCase()),
      }
    },
  }
  return { reader, calls }
}

function setup(over: { reader?: AmazonAutocompleteReader | undefined; seeds?: string[] } = {}) {
  let t = Date.parse('2026-10-18T09:00:00.000Z')
  const events: { type: string; payload: Record<string, unknown> }[] = []
  const dir = tmp()
  const reader = 'reader' in over ? over.reader : recordedReader().reader
  const bank = createAmazonKeywordBank({
    workspace_id: 'ws_1',
    dir,
    now: () => new Date(t).toISOString(),
    newId: (p) => `${p}_${events.length}`,
    reader: () => reader,
    brand: async () => ({
      name: 'Nordride',
      markets: ['US'],
      competitors: [
        { id: 'c1', name: 'Voltway' },
        { id: 'c2', name: 'Ridgeline' },
      ],
      seed_hints: over.seeds ?? ['电动自行车'],
    }),
    emit: (type, payload) => events.push({ type, payload }),
  })
  return {
    bank,
    events,
    dir,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('WP398 内置浏览器读联想词', () => {
  function fakeChannel(text: string, over: Partial<{ status: number; ok: boolean }> = {}) {
    const opened: { url: string; kind: string }[] = []
    const channel: SearchBrowserChannel = {
      async open(input) {
        opened.push({ url: input.url, kind: input.kind })
        if (over.ok === false) return { ok: false, reason: 'timeout', message: '8 秒内没打开' }
        return {
          ok: true,
          status: over.status ?? 200,
          final_url: input.url,
          page: {
            signals: {
              title: '',
              text: text.slice(0, 3000).toLowerCase(),
              captcha: false,
              passwordInputs: 0,
            },
            text,
            truncated: false,
          },
        }
      },
      reveal: async () => false,
      status: async () => undefined,
    }
    return { channel, opened }
  }
  const throttle = (maxPerHour = 60) => {
    let t = 0
    let randoms = 0
    const sleeps: number[] = []
    return {
      throttle: createSearchThrottle({
        now: () => t,
        random: () => {
          randoms += 1
          return 0.5
        },
        sleep: async (ms) => {
          sleeps.push(ms)
          t += ms
        },
        maxPerHour,
      }),
      sleeps,
      randoms: () => randoms,
    }
  }

  it('开的是联想词地址（只读正文那种页）；固定间隔、不加随机停顿', async () => {
    const { channel, opened } = fakeChannel(fx('suggest-electric-bike.json'))
    const th = throttle()
    const r = createBrowserAutocompleteReader({
      workspace_id: 'ws_1',
      channel,
      throttle: th.throttle,
    })
    const a = await r.suggest({ marketplace: 'US', prefix: 'electric bike' })
    await r.suggest({ marketplace: 'US', prefix: 'electric bike a' })
    expect(a.status).toBe('ok')
    if (a.status === 'ok') expect(a.suggestions).toContain('electric bike for adults')
    expect(opened[0]?.kind).toBe('page')
    expect(new URL(opened[0]?.url ?? '').hostname).toBe('completion.amazon.com')
    expect(th.randoms()).toBe(0)
    expect(th.sleeps).toEqual([2000])
  })

  it('验证页 / 403 → blocked；额度满 → quota；打不开 → failed', async () => {
    const th = throttle()
    const blocked = createBrowserAutocompleteReader({
      workspace_id: 'ws_1',
      channel: fakeChannel(fx('suggest-blocked.txt')).channel,
      throttle: th.throttle,
    })
    expect((await blocked.suggest({ marketplace: 'US', prefix: 'x' })).status).toBe('blocked')
    const forbidden = createBrowserAutocompleteReader({
      workspace_id: 'ws_1',
      channel: fakeChannel('{}', { status: 403 }).channel,
      throttle: th.throttle,
    })
    expect((await forbidden.suggest({ marketplace: 'US', prefix: 'x' })).status).toBe('blocked')
    const full = throttle(0)
    const quota = createBrowserAutocompleteReader({
      workspace_id: 'ws_1',
      channel: fakeChannel('{}').channel,
      throttle: full.throttle,
    })
    expect((await quota.suggest({ marketplace: 'US', prefix: 'x' })).status).toBe('quota')
    const down = createBrowserAutocompleteReader({
      workspace_id: 'ws_1',
      channel: fakeChannel('', { ok: false }).channel,
      throttle: th.throttle,
    })
    expect((await down.suggest({ marketplace: 'US', prefix: 'x' })).status).toBe('failed')
  })
})

describe('WP398 词库刷新', () => {
  it('一批 = 种子词（自家标题核心词）+ a–z；联想词、竞品、自家都进词库；差距按竞品数排', async () => {
    const rec = recordedReader()
    const s = setup({ reader: rec.reader })
    s.bank.ingestListings([OWN, ...COMPETITORS])
    const r = await s.bank.refresh({ trigger: 'manual' })
    expect(rec.calls).toHaveLength(27)
    expect(rec.calls[0]).toBe('electric bike')
    expect(r.refresh.autocomplete).toMatchObject({
      status: 'ok',
      seed: 'electric bike',
      planned: 27,
      read: 27,
    })
    expect(r.view.by_source.autocomplete).toBeGreaterThan(0)
    expect(r.view.by_source.competitor_listing).toBeGreaterThan(0)
    expect(r.view.by_source.own_listing).toBeGreaterThan(0)
    const gap = r.view.gaps[0]
    expect(gap?.asin).toBe('B0OWN00001')
    expect(gap?.terms[0]).toMatchObject({ norm: 'removable battery', competitors: 3 })
    expect(gap?.terms[1]).toMatchObject({ norm: 'fat tire', competitors: 2 })
    expect(r.view.sort_note.zh).toBe('没有搜索量，按竞品里出现的次数排')
    expect(s.events.map((e) => e.type)).toEqual(['amazon_keywords.refreshed'])
  })

  it('联想词里的他牌名标出来（不能填进后台关键词）；数字格一律不填', async () => {
    const s = setup()
    s.bank.ingestListings([OWN])
    await s.bank.refresh({ trigger: 'manual' })
    const page = s.bank.list({ other_brand: true })
    expect(page.items.map((k) => [k.term, k.other_brand])).toEqual([
      ['voltway electric bike', 'Voltway'],
    ])
    expect(s.bank.list({ limit: 500 }).items.every((k) => k.metrics === undefined)).toBe(true)
  })

  it('被拦（替身回验证页）：这一轮停下、不再读下一页；之后 24 小时不再去读，照实说', async () => {
    const rec = recordedReader({ blockAt: 3 })
    const s = setup({ reader: rec.reader })
    s.bank.ingestListings([OWN])
    const r = await s.bank.refresh({ trigger: 'tool' })
    expect(rec.calls).toHaveLength(3)
    expect(r.refresh.autocomplete.status).toBe('blocked')
    expect(r.refresh.autocomplete.read).toBe(2)
    expect(r.refresh.autocomplete.message).toMatch(/不绕、不重试/)
    s.advance(3_600_000)
    const again = await s.bank.refresh({ trigger: 'tool' })
    expect(rec.calls).toHaveLength(3)
    expect(again.refresh.autocomplete.status).toBe('blocked')
    expect(again.refresh.autocomplete.planned).toBe(0)
    s.advance(24 * 3_600_000)
    await s.bank.refresh({ trigger: 'tool' })
    expect(rec.calls.length).toBeGreaterThan(3)
  })

  it('额度满了停；没有内置浏览器 / 没有种子词照实说', async () => {
    const rec = recordedReader({ quotaAt: 5 })
    const s = setup({ reader: rec.reader })
    s.bank.ingestListings([OWN])
    const q = await s.bank.refresh({ trigger: 'manual' })
    expect(q.refresh.autocomplete.status).toBe('quota')
    expect(rec.calls).toHaveLength(5)

    const none = setup({ reader: undefined })
    none.bank.ingestListings([OWN, ...COMPETITORS])
    const u = await none.bank.refresh({ trigger: 'manual' })
    expect(u.refresh.autocomplete.status).toBe('unavailable')
    expect(u.view.reader_ready).toBe(false)
    expect(u.view.gap_terms).toBeGreaterThan(0)

    const noSeed = setup()
    const n = await noSeed.bank.refresh({ trigger: 'manual' })
    expect(n.refresh.autocomplete.status).toBe('no_seeds')
  })

  it('给了种子词：这次就读它，并记下来；品类是英文的也能当种子词', async () => {
    const rec = recordedReader()
    const s = setup({ reader: rec.reader, seeds: ['Portable Power Station'] })
    await s.bank.refresh({ trigger: 'tool', seeds: ['ebike'] })
    expect(rec.calls[0]).toBe('ebike')
    await s.bank.refresh({ trigger: 'tool' })
    expect(rec.calls[27]).toBe('ebike')
    await s.bank.refresh({ trigger: 'tool' })
    expect(rec.calls[54]).toBe('portable power station')
  })

  it('标记：核心 / 不要 / 已埋进 Listing；标了不要的不进总数、不算差距；自己加一个词', async () => {
    const s = setup({ reader: undefined })
    s.bank.ingestListings([OWN, ...COMPETITORS])
    const r = await s.bank.refresh({ trigger: 'manual' })
    const before = r.view.gap_terms
    const m = s.bank.mark({ id: 'US:removable battery', add: ['exclude'] })
    expect(m.ok).toBe(true)
    expect(s.bank.view().gap_terms).toBe(before - 1)
    expect(s.bank.list({ gap: true }).items.some((k) => k.id === 'US:removable battery')).toBe(
      false,
    )
    expect(s.bank.list({ mark: 'exclude' }).items.map((k) => k.id)).toEqual([
      'US:removable battery',
    ])
    const added = s.bank.mark({ term: 'Commuter Ebike', add: ['core'] })
    expect(added.ok && added.keyword.sources).toEqual(['own_listing', 'user'])
    const fresh = s.bank.mark({ term: 'Cargo Trailer' })
    expect(fresh.ok && fresh.keyword.sources).toEqual(['user'])
    expect(s.bank.list({ mark: 'core' }).items.map((k) => k.id)).toEqual(['US:commuter ebike'])
    expect(s.bank.mark({ id: 'US:nope' }).ok).toBe(false)
  })

  it('落盘：同一目录重建，词库、差距、暂停都在', async () => {
    const s = setup({ reader: recordedReader({ blockAt: 1 }).reader })
    s.bank.ingestListings([OWN, ...COMPETITORS])
    await s.bank.refresh({ trigger: 'manual' })
    const file = JSON.parse(readFileSync(join(s.dir, 'amazon-keywords.json'), 'utf8'))
    expect(file.version).toBe(1)
    expect(file.blocked_until).toBeDefined()
    expect(file.gaps[0].terms.length).toBeGreaterThan(0)
  })
})

describe('WP398 别的几单读到的页 → Listing 文本', () => {
  it('竞品快照：只认 Amazon 那种源；自家那组算自家；五点有就带上', () => {
    const texts = listingTextsFromSnapshots({
      sources: [
        {
          id: 's1',
          kind: 'amazon_asin',
          competitor_id: 'c1',
          marketplace: 'US',
          label: 'Voltway',
        } as never,
        {
          id: 's2',
          kind: 'amazon_asin',
          competitor_id: '_own',
          marketplace: 'US',
          label: 'Nordride',
        } as never,
        { id: 's3', kind: 'shop_catalog', competitor_id: 'c1', label: 'Voltway' } as never,
      ],
      snapshot: (id) =>
        ({
          source_id: id,
          workspace_id: 'ws_1',
          reads: 1,
          read_at: at,
          rows: [
            {
              source_id: id,
              competitor_id: 'x',
              product_key: id === 's2' ? 'B0OWN00001' : 'B0VOLT0001',
              title: 'Some Title',
              bullets: ['Removable battery'],
              read_at: at,
              first_seen_at: at,
              last_seen_at: at,
              missing: 0,
            },
          ],
        }) as never,
      names: new Map([['c1', 'Voltway']]),
    })
    expect(texts.map((t) => [t.side, t.asin, t.competitor ?? ''])).toEqual([
      ['competitor', 'B0VOLT0001', 'Voltway'],
      ['own', 'B0OWN00001', ''],
    ])
    expect(texts[0]?.bullets).toEqual(['Removable battery'])
  })

  it('体检读到的页：空五点去掉，没标题也没五点的不要', () => {
    const t = listingTextsFromFacts([
      { asin: 'B0OWN00001', marketplace: 'US', read_at: at, title: 'T', bullets: ['a', ''] },
      { asin: 'B0OWN00002', marketplace: 'US', read_at: at, bullets: [] },
    ])
    expect(t).toHaveLength(1)
    expect(t[0]?.bullets).toEqual(['a'])
  })
})

describe('WP398 三个工具', () => {
  const req = (role_id: string) =>
    ({ workspace_id: 'ws_1', actor: { role_id } }) as unknown as RunRequest
  it('只给亚马逊店铺运营；没刷新过先说没有；刷新后回差距与「没有搜索量」那句、第三栏地址', async () => {
    const s = setup()
    s.bank.ingestListings([OWN, ...COMPETITORS])
    const exec = createAmazonKeywordToolExecutor({ bank: async () => s.bank })
    const denied = await exec({ name: 'get_amazon_keywords', input: {}, request: req('dtc.store') })
    expect(denied.status).toBe('blocked')
    const empty = await exec({ name: 'get_amazon_keywords', input: {}, request: req('amz.store') })
    expect((empty.data as { ok: boolean }).ok).toBe(false)
    const read = await exec({ name: 'read_amazon_keywords', input: {}, request: req('amz.store') })
    const data = read.data as Record<string, unknown>
    expect(data.sort_note).toBe('没有搜索量，按竞品里出现的次数排')
    expect(data.open).toBe('agentsws://amazon-keywords/all')
    const got = await exec({
      name: 'get_amazon_keywords',
      input: { other_brand: true },
      request: req('amz.store'),
    })
    const rows = (got.data as { rows: { items: Record<string, unknown>[] } }).rows.items
    expect(rows[0]?.warning).toBe('含别家品牌名，不能填进后台关键词')
    const mark = await exec({
      name: 'mark_amazon_keyword',
      input: { id: 'US:fat tire', add: ['core'] },
      request: req('amz.store'),
    })
    expect((mark.data as { keyword: { marks: string[] } }).keyword.marks).toEqual(['core'])
  })
})
