/**
 * WP386（docs/103 v2）：信息监控的服务——每个品牌一份。
 *
 * - **多条监控源**（Google Alerts 的 RSS / 网站 RSS），存在这个品牌自己的库里；贴进来先拉一次，拉到了才算配好；
 * - **拉取**：定时一小时一拍、到点才拉（默认一天一次、本地 9 点后；关机错过的补一次；失败隔一小时再试；
 *   满 20 条全新的 Google Alerts feed 自动改成每 4 小时）。拉回来的交给提及库（去重 / 判类 / 出卡）；
 * - **Reddit 那一路**走 `read_reddit` 同一条取数路由（设置里配了搜索词才跑）；
 * - **配置卡**（`pr.watch`）：AI 按档案列出要建的提醒清单，人改、确认；每行旁边贴 RSS 链接，也能一次贴一批。
 *
 * 拉不到就照实说：失败的源标红、写一句人话，面板与简报写「没拉到」，**绝不显示 0 条**。
 */

import type {
  PrMentionInput,
  PrWatchLinkResult,
  PrWatchSourcePatch,
  PrWatchView,
} from '@agentsws/api'
import {
  type Iso8601,
  MONITOR_BOOST_EVERY_HOURS,
  MONITOR_GROUP_LABELS,
  type MonitorGroup,
  type MonitorPlanItem,
  type MonitorRun,
  type MonitorRunPart,
  type MonitorSettings,
  type MonitorSource,
  maskFeedUrl,
  type PrWatchStore,
  type SetupField,
  type WorkspaceId,
} from '@agentsws/contracts'
import { type AlertsTransport, probeFeedLink, termHit } from '@agentsws/pr-core'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import type { SetupBrandFacts, SetupResearchKit } from '../setup-research.js'
import { dueSources, nextMonitorRunAt, sourceDue } from './due.js'
import {
  feedAdapter,
  type IngressAdapter,
  type PipelineSource,
  pipelineSourceOf,
  type RedditReadItem,
  redditAdapter,
  runPipelineFor,
} from './pipeline.js'
import { draftPlan, type GeoWatchFacts, parseRowValue, researchPlan, rowValue } from './plan.js'
import { normalizeMonitorSettings } from './store.js'

export const PR_WATCH_TARGET = 'pr.watch'
/** Reddit 那一路在管道里的 id（提及上的 `source_id`）。 */
export const REDDIT_SOURCE_ID = 'reddit'

export interface PrWatchOptions {
  workspace_id: WorkspaceId
  store: PrWatchStore
  now(): Iso8601
  newId(prefix: string): string
  tzOffsetMinutes(): number
  /** 一跳 HTTP（拉 feed）。 */
  fetch: AlertsTransport['fetch']
  /** Reddit 取数路由（`social.reddit.search`）；不给 = 这一路没接。 */
  redditSearch?(
    query: string,
  ): Promise<{ ok: true; items: RedditReadItem[] } | { ok: false; message: string }>
  /** 入库（提及库去重、判类、出卡）。不给 / 回 `undefined` = 没人持有信息监控，拉回来没地方放。 */
  ingest?(rows: readonly PrMentionInput[]): Promise<{ created: number } | undefined>
  /** 品牌档案（配置卡列清单、普通 RSS 默认按什么词过滤）。 */
  facts?(): SetupBrandFacts
  /** GEO 关注设置里的竞品与别名。 */
  geo?(): Promise<GeoWatchFacts | undefined> | GeoWatchFacts | undefined
  /** 老的单条 Google Alerts 卡上那几格（启动时迁进来）。 */
  legacyFeeds?(): { feed_url?: string; brand_terms?: string }[]
  emit?(type: string, payload: Record<string, unknown>): void
}

export interface PrWatchAssembly {
  /** 定时那一拍（`pullMentions`）：到点的源拉一次，回要入库的行；没配源照实说。 */
  pull(): Promise<
    | { ok: true; rows: readonly PrMentionInput[]; finish?(out: { created: number }): void }
    | { ok: false; message: string }
  >
  /** 现在拉一轮（全部没暂停的源）。 */
  runNow(): Promise<{ run?: MonitorRun; message: string }>
  addLinks(input: {
    links: string
    plan_item_id?: string
    group?: MonitorGroup
    via?: MonitorSource['added_via']
  }): Promise<PrWatchLinkResult[]>
  view(): PrWatchView
  updateSource(id: string, patch: PrWatchSourcePatch): PrWatchView
  removeSource(id: string): PrWatchView
  updateSettings(patch: Partial<MonitorSettings>): PrWatchView
  /** 配好了没有（有一条源，或 Reddit 那一路配了词）。 */
  configured(): boolean
  /** 老的单条 feed 迁进来（启动时调一次；回迁了几条）。 */
  migrateLegacy(): number
  setupTarget(): SetupTarget
}

const linksIn = (raw: string): string[] =>
  [
    ...new Set(
      raw
        .split(/[\s,，;；]+/u)
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    ),
  ].slice(0, 50)

const norm = (s: string): string =>
  s
    .toLowerCase()
    .replace(/["“”'\s]+/gu, ' ')
    .trim()

export function createPrWatch(options: PrWatchOptions): PrWatchAssembly {
  const { store } = options
  const transport: AlertsTransport = { fetch: options.fetch, now: options.now }
  // WP392：`shop_catalog` / `amazon_asin` 两种走竞品监控自己的快照对比管道（`competitor-watch/`），这里没有
  const adapters: Partial<Record<MonitorSource['kind'], IngressAdapter>> = {
    google_alerts: feedAdapter(transport, (id) => store.source(id)?.url),
    rss: feedAdapter(transport, (id) => store.source(id)?.url),
  }
  const reddit =
    options.redditSearch === undefined
      ? undefined
      : redditAdapter(options.now, () => store.settings().reddit_queries, options.redditSearch)

  const dueInput = () => ({
    now: options.now(),
    tz_offset_minutes: options.tzOffsetMinutes(),
    settings: store.settings(),
  })

  /** Reddit 那一路的钟（不是监控源，钟单独记）。 */
  const redditClock = (): MonitorSource => {
    const clock =
      store.kv<Pick<MonitorSource, 'last_ok_at' | 'last_try_at' | 'status'>>('reddit_clock')
    return {
      id: REDDIT_SOURCE_ID,
      workspace_id: options.workspace_id,
      kind: 'rss',
      url: '',
      group: 'own',
      label: 'Reddit',
      every_hours: store.settings().default_every_hours,
      status: clock?.status ?? 'unchecked',
      ...(clock?.last_ok_at === undefined ? {} : { last_ok_at: clock.last_ok_at }),
      ...(clock?.last_try_at === undefined ? {} : { last_try_at: clock.last_try_at }),
      added_via: 'suggest',
      created_at: options.now(),
    }
  }
  const redditOn = (): boolean => reddit !== undefined && store.settings().reddit_queries.length > 0

  /** 一轮：拉 → 管道 → 记每条源的状态；回要入库的行（入库后 `finish` 记这一轮）。 */
  const collect = async (
    force: boolean,
    trigger: MonitorRun['trigger'],
  ): Promise<{ run: MonitorRun; rows: PrMentionInput[] } | undefined> => {
    const input = dueInput()
    const sources = force
      ? store.sources().filter((s) => s.paused !== true)
      : dueSources({ ...input, sources: store.sources() })
    const doReddit = redditOn() && (force || sourceDue(redditClock(), input))
    if (sources.length === 0 && !doReddit) return undefined
    const now = options.now()
    const run: MonitorRun = {
      id: options.newId('mr'),
      workspace_id: options.workspace_id,
      trigger,
      started_at: now,
      parts: [],
      created: 0,
      notes: [],
    }
    const rows: PrMentionInput[] = []
    for (const s of sources) {
      const adapter = adapters[s.kind]
      if (adapter === undefined) continue
      const res = await runPipelineFor({
        source: pipelineSourceOf(s),
        adapter,
        store,
      })
      run.parts.push(res.part)
      rows.push(...res.rows)
      const cur = store.source(s.id) ?? s
      if (res.part.status === 'ok') {
        const { last_error: _e, ...rest } = cur
        store.putSource({
          ...rest,
          status: 'ok',
          last_ok_at: now,
          last_try_at: now,
          last_fetched: res.part.fetched,
          last_fresh: res.part.fresh,
          ...(res.boost ? { every_hours: MONITOR_BOOST_EVERY_HOURS, boosted_at: now } : {}),
        })
        if (res.boost)
          run.notes.push(
            `「${s.label}」这条一次来了 ${res.part.fetched} 条、全是新的，可能漏了，已改成每 4 小时拉一次。`,
          )
      } else {
        store.putSource({
          ...cur,
          status: 'failed',
          last_try_at: now,
          last_error: res.part.message ?? '没拉到。',
        })
        run.notes.push(`「${s.label}」没拉到：${res.part.message ?? ''}`)
      }
    }
    if (doReddit && reddit !== undefined) {
      const src: PipelineSource = { id: REDDIT_SOURCE_ID, label: 'Reddit', group: 'own' }
      const res = await runPipelineFor({ source: src, adapter: reddit, store })
      run.parts.push(res.part)
      rows.push(...res.rows)
      const ok = res.part.status === 'ok'
      const prev = store.kv<Record<string, unknown>>('reddit_clock') ?? {}
      store.setKv('reddit_clock', {
        ...prev,
        status: ok ? 'ok' : 'failed',
        last_try_at: now,
        ...(ok ? { last_ok_at: now } : {}),
      })
      if (!ok) run.notes.push(`Reddit 没取到：${res.part.message ?? ''}`)
    }
    store.putRun(run)
    return { run, rows }
  }

  const finishRun = (run: MonitorRun, created: number): void => {
    run.created = created
    run.finished_at = options.now()
    store.putRun(run)
    options.emit?.('pr.monitor_run', {
      run_id: run.id,
      trigger: run.trigger,
      sources: run.parts.length,
      failed: run.parts.filter((p) => p.status === 'failed').length,
      created,
    })
  }

  const configured = (): boolean => store.sources().length > 0 || redditOn()

  const rowOf = (s: MonitorSource): PrWatchView['sources'][number] => {
    const { url, ...rest } = s
    return { ...rest, url_masked: maskFeedUrl(url) }
  }

  const view = (): PrWatchView => {
    const sources = store.sources()
    const failed = sources.filter((s) => s.status === 'failed' && s.paused !== true).length
    const next = nextMonitorRunAt({
      ...dueInput(),
      sources: redditOn() ? [...sources, redditClock()] : sources,
    })
    const last = store.runs(1)[0]
    return {
      sources: sources.map(rowOf),
      plan: store.planItems(),
      settings: store.settings(),
      summary: summaryOf(sources.length, failed),
      failed,
      ...(next === undefined ? {} : { next_run_at: next }),
      ...(last === undefined ? {} : { last_run: last }),
    }
  }

  /** 贴进来的这条对上清单上的哪一行（feed 标题里盯的词 = 那一行的名字或查询语句）。 */
  const matchPlan = (label: string | undefined): MonitorPlanItem | undefined => {
    if (label === undefined) return undefined
    const l = norm(label)
    const open = store.planItems().filter((p) => p.status !== 'linked' && p.selected)
    return (
      open.find((p) => norm(p.query) === l) ??
      open.find((p) => norm(p.label) === l) ??
      open.find((p) => termHit(label, p.label))
    )
  }

  /** 没对上清单时，按名字认是不是某个竞品。 */
  const geoNow = async (): Promise<GeoWatchFacts | undefined> =>
    Promise.resolve(options.geo?.()).catch(() => undefined)

  const competitorIn = async (label: string): Promise<string | undefined> => {
    const names = [
      ...(options.facts?.().competitors ?? []).map((c) => c.name),
      ...((await geoNow())?.competitors ?? []).map((c) => c.name),
    ]
    return names.find((n) => termHit(label, n))
  }

  const addLinks: PrWatchAssembly['addLinks'] = async (input) => {
    const links = linksIn(input.links)
    if (links.length === 0)
      return [
        {
          input_masked: '',
          ok: false,
          message: '没看到链接。把 RSS 链接贴过来（可以一次贴一批）。',
        },
      ]
    const results: PrWatchLinkResult[] = []
    for (const [i, link] of links.entries()) {
      const masked = maskFeedUrl(link)
      const probed = await probeFeedLink(transport, link)
      if (!probed.ok) {
        results.push({ input_masked: masked, ok: false, message: probed.message })
        continue
      }
      const feed = probed.data
      const had = store.sources().find((s) => s.url === feed.url)
      if (had !== undefined) {
        results.push({
          input_masked: masked,
          ok: true,
          message: `这条已经在盯了（「${had.label}」）。`,
          source_id: had.id,
          label: had.label,
          kind: had.kind,
        })
        continue
      }
      const explicit =
        input.plan_item_id !== undefined && i === 0 ? store.planItem(input.plan_item_id) : undefined
      const item = explicit ?? matchPlan(feed.label)
      const label = item?.label ?? feed.label ?? new URL(feed.url).hostname
      const competitor =
        item?.competitor ?? (item === undefined ? await competitorIn(label) : undefined)
      const group: MonitorGroup =
        item?.group ??
        input.group ??
        (competitor !== undefined ? 'competitor' : feed.kind === 'rss' ? 'site' : 'own')
      const now = options.now()
      const facts = options.facts?.()
      const keywords =
        feed.kind === 'rss'
          ? [
              ...(facts?.name === undefined ? [] : [facts.name]),
              ...(facts?.competitors ?? []).map((c) => c.name).slice(0, 5),
            ]
          : []
      const source: MonitorSource = {
        id: options.newId('ms'),
        workspace_id: options.workspace_id,
        kind: feed.kind,
        url: feed.url,
        group,
        label,
        ...(item?.query === undefined ? {} : { query: item.query }),
        ...(keywords.length === 0 ? {} : { keywords }),
        ...(item?.language === undefined ? {} : { language: item.language }),
        ...(item?.region === undefined ? {} : { region: item.region }),
        ...(competitor === undefined ? {} : { competitor }),
        every_hours: store.settings().default_every_hours,
        status: 'ok',
        last_try_at: now,
        added_via: input.via ?? 'paste',
        ...(item === undefined ? {} : { plan_item_id: item.id }),
        created_at: now,
      }
      store.putSource(source)
      if (item !== undefined)
        store.putPlanItem({ ...item, status: 'linked', source_id: source.id, updated_at: now })
      // 存进来先拉一次（就是刚才那一次）：走同一条管道，记「见过的」，交给提及库
      const res = await runPipelineFor({
        source: pipelineSourceOf(source),
        adapter: { pull: async () => ({ ok: true, items: feed.rows }) },
        store,
      })
      store.putSource({
        ...source,
        last_ok_at: now,
        last_fetched: res.part.fetched,
        last_fresh: res.part.fresh,
      })
      const got = (await options.ingest?.(res.rows))?.created
      const run: MonitorRun = {
        id: options.newId('mr'),
        workspace_id: options.workspace_id,
        trigger: 'added',
        started_at: now,
        parts: [res.part],
        created: 0,
        notes: [],
      }
      finishRun(run, got ?? 0)
      const filtered = feed.kind === 'rss' ? `，按关键词留下 ${res.part.kept} 条` : ''
      results.push({
        input_masked: masked,
        ok: true,
        message: `已订上「${label}」：拉到 ${res.part.fetched} 条${filtered}${got === undefined ? '' : `，新入表 ${got} 条`}。`,
        source_id: source.id,
        ...(item === undefined ? {} : { plan_item_id: item.id }),
        label,
        kind: feed.kind,
      })
    }
    options.emit?.('pr.monitor_links_added', {
      tried: links.length,
      added: results.filter((r) => r.ok).length,
    })
    return results
  }

  const draftsNow = async () =>
    draftPlan({
      facts: options.facts?.() ?? {},
      geo: await geoNow(),
      saved: store.planItems().filter((p) => p.selected || p.status === 'linked'),
    })

  const setupTarget = (): SetupTarget => ({
    id: PR_WATCH_TARGET,
    name: '信息监控',
    why: '我按品牌档案和竞品列了一份要建的 Google 提醒，你改完确认；建好后把 RSS 链接贴回来。',
    async fields(): Promise<SetupField[]> {
      const saved = store.planItems().filter((p) => p.selected || p.status === 'linked')
      const drafts = await draftsNow()
      const fields: SetupField[] = []
      drafts.forEach((d, i) => {
        const n = i + 1
        const linked = saved[i]?.status === 'linked'
        fields.push({
          key: `alert_${n}`,
          label: `${MONITOR_GROUP_LABELS[d.group].zh} · ${d.label}`,
          kind: 'text',
          placeholder: rowValue(d),
          // 存过的清单回显（事实）；没存过的由 research 给方案
          ...(saved.length > 0 ? { suggested: rowValue(d), suggested_why: d.why } : {}),
          required: false,
        })
        fields.push({
          key: `rss_${n}`,
          label: linked ? `「${d.label}」已订上` : `「${d.label}」的 RSS 链接`,
          kind: 'url',
          placeholder: 'https://www.google.com/alerts/feeds/…',
          required: false,
        })
      })
      fields.push({
        key: 'rss_batch',
        label: '一次贴一批 RSS 链接',
        kind: 'text',
        placeholder: '每行一条，我按 feed 标题对上是哪一行',
        required: false,
      })
      return fields
    },
    // 「设好了」= 至少有一条监控源在拉（清单存了、链接还没贴回来，卡照样要出：贴链接就在这张卡上）
    async satisfied(): Promise<boolean> {
      return configured()
    },
    async research(kit: SetupResearchKit) {
      if (store.planItems().some((p) => p.selected)) return {}
      return researchPlan(kit, await draftsNow())
    },
    async apply(values): Promise<void> {
      const drafts = await draftsNow()
      const now = options.now()
      const before = store.planItems()
      const kept: MonitorPlanItem[] = []
      drafts.forEach((d, i) => {
        const parsed = parseRowValue(values[`alert_${i + 1}`] ?? '', d)
        const prev = before.find((p) => p.label === d.label && p.group === d.group)
        const item: MonitorPlanItem = {
          id: prev?.id ?? options.newId('mp'),
          workspace_id: options.workspace_id,
          group: d.group,
          label: d.label,
          query: parsed?.query ?? d.query,
          language: parsed?.language ?? d.language,
          region: parsed?.region ?? d.region,
          ...(d.competitor === undefined ? {} : { competitor: d.competitor }),
          why: d.why,
          selected: parsed !== undefined,
          status:
            prev?.status === 'linked' ? 'linked' : parsed === undefined ? 'skipped' : 'planned',
          ...(prev?.source_id === undefined ? {} : { source_id: prev.source_id }),
          created_at: prev?.created_at ?? now,
          updated_at: now,
        }
        kept.push(item)
      })
      for (const p of before)
        if (!kept.some((k) => k.id === p.id) && p.status !== 'linked') store.removePlanItem(p.id)
      for (const k of kept) store.putPlanItem(k)
      options.emit?.('pr.monitor_plan_saved', {
        rows: kept.length,
        selected: kept.filter((k) => k.selected).length,
      })
      // 贴回来的 RSS：每行一格 + 一次贴一批；错的当场说
      const errors: string[] = []
      for (const [i, k] of kept.entries()) {
        const link = values[`rss_${i + 1}`]?.trim()
        if (link === undefined || link === '') continue
        const [r] = await addLinks({ links: link, plan_item_id: k.id })
        if (r !== undefined && !r.ok) errors.push(`「${k.label}」：${r.message}`)
      }
      const batch = values.rss_batch?.trim()
      if (batch !== undefined && batch !== '')
        for (const r of await addLinks({ links: batch }))
          if (!r.ok) errors.push(`${r.input_masked}：${r.message}`)
      if (errors.length > 0)
        throw new SetupCardError(
          'invalid_input',
          `清单存好了；有 ${errors.length} 条链接没收：${errors.slice(0, 3).join('；')}`,
        )
    },
  })

  return {
    async pull() {
      if (!configured())
        return {
          ok: false,
          message:
            '这个品牌还没配监控源。**这不等于今天没人提我们**——跟我说「帮我盯一下」，我先列一份要建的 Google 提醒。',
        }
      const got = await collect(false, 'schedule')
      if (got === undefined) return { ok: true, rows: [] }
      return { ok: true, rows: got.rows, finish: ({ created }) => finishRun(got.run, created) }
    },
    async runNow() {
      if (!configured())
        return { message: '还没有监控源：先跟我说「帮我盯一下」，或者把 RSS 链接贴过来。' }
      const got = await collect(true, 'manual')
      if (got === undefined) return { message: '所有监控源都暂停了。' }
      const done = await options.ingest?.(got.rows)
      finishRun(got.run, done?.created ?? 0)
      const failed = got.run.parts.filter((p) => p.status === 'failed').length
      const head =
        done === undefined
          ? `拉了 ${got.run.parts.length} 条源，可还没人担信息监控这条职责，拉回来的没入表。`
          : `拉了 ${got.run.parts.length} 条源：新入表 ${done.created} 条。`
      return {
        run: got.run,
        message: failed === 0 ? head : `${head}${failed} 条没拉到（见红点）。`,
      }
    },
    addLinks,
    view,
    updateSource(id, patch) {
      const cur = store.source(id)
      if (cur === undefined) throw new SetupCardError('invalid_input', '没有这条监控源。')
      const { paused: _p, ...rest } = cur
      store.putSource({
        ...rest,
        ...(patch.paused === true
          ? { paused: true as const }
          : patch.paused === false
            ? {}
            : cur.paused === true
              ? { paused: true as const }
              : {}),
        ...(patch.every_hours === undefined ? {} : { every_hours: patch.every_hours }),
        ...(patch.group === undefined ? {} : { group: patch.group }),
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.competitor === undefined
          ? {}
          : patch.competitor === ''
            ? {}
            : { competitor: patch.competitor }),
        ...(patch.keywords === undefined ? {} : { keywords: patch.keywords }),
        ...(patch.exclude === undefined ? {} : { exclude: patch.exclude }),
      })
      return view()
    },
    removeSource(id) {
      const cur = store.source(id)
      store.removeSource(id)
      if (cur?.plan_item_id !== undefined) {
        const item = store.planItem(cur.plan_item_id)
        if (item !== undefined) {
          const { source_id: _s, ...rest } = item
          store.putPlanItem({ ...rest, status: 'planned', updated_at: options.now() })
        }
      }
      return view()
    },
    updateSettings(patch) {
      store.putSettings(normalizeMonitorSettings({ ...store.settings(), ...patch }))
      return view()
    },
    configured,
    migrateLegacy() {
      // 迁过的地址记着：人删掉那条源之后，老卡上那一格不会把它又带回来
      const done = new Set(store.kv<string[]>('legacy_urls') ?? [])
      let n = 0
      for (const f of options.legacyFeeds?.() ?? []) {
        const url = f.feed_url?.trim()
        if (url === undefined || url === '' || done.has(url)) continue
        done.add(url)
        if (store.sources().some((s) => s.url === url)) continue
        const now = options.now()
        const terms = (f.brand_terms ?? '')
          .split(/[,，、\n]/u)
          .map((t) => t.trim())
          .filter((t) => t !== '')
        store.putSource({
          id: options.newId('ms'),
          workspace_id: options.workspace_id,
          kind: url.startsWith('https://www.google.com/alerts/feeds/') ? 'google_alerts' : 'rss',
          url,
          group: 'own',
          label: terms[0] ?? options.facts?.().name ?? 'Google Alerts',
          every_hours: store.settings().default_every_hours,
          status: 'unchecked',
          added_via: 'paste',
          created_at: now,
        })
        n += 1
      }
      store.setKv('legacy_urls', [...done])
      return n
    },
    setupTarget,
  }
}

/** 连接卡 / 右栏上那一句（「17 条 · 1 条拉不到」）。 */
export function summaryOf(total: number, failed: number): string {
  if (total === 0) return '还没有监控源'
  return failed === 0 ? `${total} 条` : `${total} 条 · ${failed} 条拉不到`
}

/** 一轮里给简报的几句（没拉到的照实写）。 */
export function runNotes(run: MonitorRun | undefined): string[] {
  if (run === undefined) return []
  return run.notes
}

export type { MonitorRunPart }
