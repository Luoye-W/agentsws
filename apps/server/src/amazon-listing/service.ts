/**
 * WP396（docs/106 §13，A1 ②）：**自家 Listing 体检**——每个品牌一份。
 *
 * 1. 读自家 ASIN 清单（唯一一份：关注设置的 `BrandWatch.brand.amazon`，WP392）；没填 → 回 `needs_setup`，
 *    运行时出一张配置卡：AI 用品牌名在内置浏览器里搜一页给候选，人在卡上勾（照 docs/104 §3.4 方案卡的形状）；
 * 2. 用 WP394 的读页积木（{@link AmazonListingReader}）打开商品页——一次体检最多读清单那么多页，算进内置浏览器
 *    每小时额度；**被拦就停**（这一轮不再碰 Amazon、不重试、不绕），额度满了也停，照实说；
 * 3. 币种和站点对不上 / 页面写「不能配送到你选的地址」= 配送地址没设对，这次读数作废，不拿来判；
 * 4. `seo-core` 的规则表逐条判，结果存本机、按 ASIN 留历史，下次能说「上次 6 处，修了 4 处」。
 *
 * **只出建议，不写 Amazon**（一期没有写动作；改 Listing 二期按 docs/106 A14 出卡、改前先过合规预检）。
 */
import { classifyAmazonUrl, readAmazonListingFacts, storefrontCards } from '@agentsws/brand-intake'
import {
  AMAZON_OWN_ASINS_TARGET,
  type AmazonListingFacts,
  type BrandWatchAmazonItem,
  type Iso8601,
  LISTING_CHECKUP_FOOTER_EN,
  LISTING_CHECKUP_FOOTER_ZH,
  type ListingCheckupItem,
  type ListingCheckupRun,
  type ListingCheckupView,
  type ListingRule,
  type ListingRuleOverride,
  type SetupField,
} from '@agentsws/contracts'
import {
  type ClaimRuleCardLike,
  checkListing,
  compareListingIssues,
  resolveClaimRules,
  resolveListingRules,
  summarizeListingCheckup,
} from '@agentsws/seo-core'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import {
  type AmazonListingReader,
  amazonCurrencyOf,
  amazonHostOf,
  amazonProductUrl,
} from './reader.js'
import { createListingStore, type OwnAsinCandidate } from './store.js'

export interface AmazonListingBrand {
  /** 品牌名（搜自家商品、没设店铺名时判购物车用）。 */
  name: string
  /** 自家 ASIN（`BrandWatch.brand.amazon`）。 */
  own: BrandWatchAmazonItem[]
  /** 目标市场（搜候选时用第一个能对上 Amazon 站点的；都对不上用美国站）。 */
  markets: string[]
}

export interface AmazonListingCheckupOptions {
  workspace_id: string
  /** 品牌目录（`amazon-listing.json` 放这里）；不给只在内存里。 */
  dir?: string
  now(): Iso8601
  newId(prefix: string): string
  /** WP394 的读页积木；没有 = 这里读不了 Amazon 前台（没有桌面壳 / 还没接上）。 */
  reader(): AmazonListingReader | undefined
  brand(): Promise<AmazonListingBrand>
  /** 存自家 ASIN（写回关注设置那一格，整份替换）。 */
  saveOwn(items: BrandWatchAmazonItem[]): Promise<void>
  /** 知识库里的违规宣称规则卡（人改过 / 加过的）；不给只用自带的。 */
  claimCards?(): Promise<readonly ClaimRuleCardLike[]>
  emit?(type: string, payload: Record<string, unknown>): void
  /**
   * WP398 合并时接的线：这一轮读到的那几页（标题、五点）交给 Amazon 词库拆词（体检结果里不存五点，
   * 所以在读到页的这一刻交）。不给 = 不交。
   */
  onFacts?(facts: readonly AmazonListingFacts[]): void
}

export interface ListingRunResult {
  run?: ListingCheckupRun
  /** 自家 ASIN 还没填：运行时出配置卡（设置目标 {@link AMAZON_OWN_ASINS_TARGET}）。 */
  needs_setup?: string
  message?: string
}

export interface SetRuleInput {
  rule_id?: string
  params?: Record<string, unknown>
  enabled?: boolean
  checked_at?: string
  own_sellers?: string[]
}

export interface AmazonListingCheckup {
  view(): Promise<ListingCheckupView>
  /** WP420（自查 B15）：改自家 ASIN（整份替换；空 = 清掉）。 */
  setOwn(input: { value: string; marketplace?: string }): Promise<{
    ok: boolean
    message?: string
    own?: BrandWatchAmazonItem[]
  }>
  run(input: { trigger: 'manual' | 'tool'; asins?: string[] }): Promise<ListingRunResult>
  latest(): ListingCheckupRun | undefined
  rules(): ListingRule[]
  setRule(input: SetRuleInput): { ok: boolean; problems?: string[]; rule?: ListingRule }
  ownSellers(): Promise<string[]>
  setupTarget(): SetupTarget
}

const ASIN = /^[A-Z0-9]{10}$/

export function createAmazonListingCheckup(
  options: AmazonListingCheckupOptions,
): AmazonListingCheckup {
  const store = createListingStore(options.dir)
  const rules = (): ListingRule[] => resolveListingRules(store.state().rule_overrides)
  let running: Promise<ListingRunResult> | undefined

  const ownSellers = async (): Promise<string[]> => {
    const set = store.state().own_sellers
    if (set !== undefined && set.length > 0) return set
    const name = (await options.brand()).name.trim()
    return name === '' ? [] : [name]
  }

  const marketOf = (markets: readonly string[]): string =>
    markets.map((m) => m.toUpperCase()).find((m) => amazonHostOf(m) !== undefined) ?? 'US'

  /** 上一次体检里这个 ASIN 读到了的那一份。 */
  const previousOf = (
    asin: string,
    marketplace: string,
  ): { at: Iso8601; item: ListingCheckupItem } | undefined => {
    const runs = store.state().runs
    for (let i = runs.length - 1; i >= 0; i -= 1) {
      const run = runs[i]
      const item = run?.items.find(
        (x) => x.asin === asin && x.marketplace === marketplace && x.status === 'checked',
      )
      if (run !== undefined && item !== undefined) return { at: run.finished_at, item }
    }
    return undefined
  }

  const doRun = async (input: {
    trigger: 'manual' | 'tool'
    asins?: string[]
  }): Promise<ListingRunResult> => {
    const brand = await options.brand()
    const wanted = (input.asins ?? []).map((a) => a.trim().toUpperCase()).filter((a) => a !== '')
    const own = brand.own.filter(
      (o) => wanted.length === 0 || wanted.includes(o.asin.toUpperCase()),
    )
    if (brand.own.length === 0)
      return {
        needs_setup: AMAZON_OWN_ASINS_TARGET,
        message:
          '还不知道你在 Amazon 上卖哪几个 ASIN：出一张卡，勾一下或贴个商品链接，我接着体检。',
      }
    if (own.length === 0) return { message: `自家清单里没有这几个 ASIN：${wanted.join('、')}。` }
    const started_at = options.now()
    const reader = options.reader()
    const items: ListingCheckupItem[] = []
    const facts: AmazonListingFacts[] = []
    let stopped: ListingCheckupRun['stopped']
    let stopped_message: string | undefined
    for (const o of own) {
      const marketplace = o.marketplace.toUpperCase()
      const asin = o.asin.toUpperCase()
      const url = amazonProductUrl(marketplace, asin) ?? `https://www.amazon.com/dp/${asin}`
      const base = {
        asin,
        marketplace,
        ...(o.label === undefined ? {} : { label: o.label }),
        url,
        issues: [],
        human_checks: [],
      }
      if (stopped !== undefined || reader === undefined) {
        items.push({ ...base, status: 'skipped' })
        continue
      }
      if (amazonHostOf(marketplace) === undefined) {
        items.push({ ...base, status: 'failed', message: `认不出站点 ${marketplace}` })
        continue
      }
      // 一个 ASIN 只读一次；被拦就停，不重试（docs/106 §2.1）
      const got = await reader.readProduct({ marketplace, asin })
      if (got.status === 'blocked') {
        stopped = 'blocked'
        // WP420（自查 B1）：取数链说清停到几点、能不能用你自己的浏览器读（没说就用老那句）
        stopped_message =
          got.message ??
          'Amazon 出了验证页，这一轮停了：不过验证码、不重试、不换办法绕。读到的那几个照常出结果，剩下的过一阵再体检。'
        items.push({ ...base, status: 'blocked', message: '被 Amazon 拦了（验证页）' })
        continue
      }
      if (got.status === 'quota') {
        stopped = 'quota'
        stopped_message = got.message ?? '内置浏览器这一小时的额度用完了，剩下的过一会儿再体检。'
        items.push({ ...base, status: 'skipped', message: '这一小时额度用完了' })
        continue
      }
      if (got.status === 'failed') {
        items.push({ ...base, status: 'failed', message: got.message })
        continue
      }
      const f = readAmazonListingFacts(got.html, {
        asin,
        marketplace,
        url: got.url,
        read_at: options.now(),
      })
      if (f === undefined) {
        stopped = 'blocked'
        stopped_message =
          'Amazon 出了验证页，这一轮停了：不过验证码、不重试、不换办法绕。读到的那几个照常出结果，剩下的过一阵再体检。'
        items.push({ ...base, status: 'blocked', message: '被 Amazon 拦了（验证页）' })
        continue
      }
      const expected = amazonCurrencyOf(marketplace)
      if (
        f.undeliverable ||
        (expected !== undefined && f.currency !== undefined && f.currency !== expected)
      ) {
        items.push({
          ...base,
          status: 'failed',
          message: f.undeliverable
            ? '页面写着「不能配送到你选的地址」：配送地址没设对，这次读数作废'
            : `价格是 ${f.currency}，和 ${marketplace} 站对不上（配送地址没设对），这次读数作废`,
          ...(f.title === undefined ? {} : { title: f.title }),
        })
        continue
      }
      facts.push(f)
      items.push({
        ...base,
        url: f.url,
        status: 'checked',
        ...(f.title === undefined ? {} : { title: f.title }),
      })
    }
    if (reader === undefined) {
      stopped = 'unavailable'
      stopped_message =
        '这里读不了 Amazon 前台（没有桌面版的内置浏览器，或者读 Amazon 的那一块还没装上），这次没体检。'
    }
    if (facts.length > 0) options.onFacts?.(facts)
    const ruleList = rules()
    const sellers = await ownSellers()
    const cards = (await options.claimCards?.().catch(() => [])) ?? []
    for (const item of items) {
      if (item.status !== 'checked') continue
      const f = facts.find((x) => x.asin === item.asin && x.marketplace === item.marketplace)
      if (f === undefined) continue
      const r = checkListing({
        facts: f,
        rules: ruleList,
        claimRules: resolveClaimRules({ markets: [item.marketplace], cards }).rules,
        ownSellers: sellers,
        siblings: facts,
        now: options.now(),
      })
      item.issues = r.issues
      item.human_checks = r.human_checks
      item.facts = {
        availability: f.availability,
        ...(f.rating === undefined ? {} : { rating: f.rating }),
        ...(f.reviews_count === undefined ? {} : { reviews_count: f.reviews_count }),
        ...(f.price === undefined ? {} : { price: f.price }),
        ...(f.list_price === undefined ? {} : { list_price: f.list_price }),
        ...(f.currency === undefined ? {} : { currency: f.currency }),
        ...(f.coupon === undefined ? {} : { coupon: f.coupon }),
        ...(f.image_count === undefined ? {} : { image_count: f.image_count }),
        ...(f.buybox.seller === undefined ? {} : { buybox_seller: f.buybox.seller }),
      }
      const prev = previousOf(item.asin, item.marketplace)
      if (prev !== undefined)
        item.previous = { at: prev.at, ...compareListingIssues(prev.item.issues, r.issues) }
    }
    const run: ListingCheckupRun = {
      id: options.newId('lchk'),
      started_at,
      finished_at: options.now(),
      trigger: input.trigger,
      items,
      summary: summarizeListingCheckup(items),
      ...(stopped === undefined ? {} : { stopped }),
      ...(stopped_message === undefined ? {} : { stopped_message }),
    }
    // 一页都没读（这里读不了）：不存，免得面板上一份全是「没去读」的结果盖掉上一次
    if (stopped !== 'unavailable') store.saveRun(run)
    options.emit?.('amazon.listing_checked', {
      run_id: run.id,
      asins: run.summary.asins,
      checked: run.summary.checked,
      issues: run.summary.issues,
      ...(stopped === undefined ? {} : { stopped }),
    })
    return { run, ...(stopped_message === undefined ? {} : { message: stopped_message }) }
  }

  /** 按品牌名搜一页，留下候选（搜过就不再搜，免得每次出卡都多读一页）。 */
  const candidates = async (): Promise<OwnAsinCandidate[]> => {
    const cached = store.state().candidates
    if (cached !== undefined) return cached.items
    const brand = await options.brand()
    const reader = options.reader()
    const name = brand.name.trim()
    if (reader?.search === undefined || name === '') return []
    const marketplace = marketOf(brand.markets)
    const got = await reader.search({ marketplace, query: name }).catch(() => undefined)
    if (got?.status !== 'ok') return []
    const items = storefrontCards(got.html, got.url)
      .filter((p) => p.asin !== undefined)
      .map((p) => ({ marketplace, asin: (p.asin ?? '').toUpperCase(), title: p.title }))
      .slice(0, 10)
    store.setCandidates({ at: options.now(), query: name, items })
    return items
  }

  const key = (c: { marketplace: string; asin: string }): string =>
    `asin_${c.marketplace}_${c.asin}`

  return {
    async view() {
      const latest = store.state().runs.at(-1)
      const own = (await options.brand()).own
      return {
        ...(latest === undefined ? {} : { latest }),
        own_asins: own.length,
        own: own.map((o) => ({
          marketplace: o.marketplace,
          asin: o.asin,
          ...(o.label === undefined ? {} : { label: o.label }),
        })),
        rules: rules(),
        reader_ready: options.reader() !== undefined,
        footer: { zh: LISTING_CHECKUP_FOOTER_ZH, en: LISTING_CHECKUP_FOOTER_EN },
      }
    },
    run(input) {
      if (running !== undefined) return running
      running = doRun(input).finally(() => {
        running = undefined
      })
      return running
    },
    latest: () => store.state().runs.at(-1),
    rules,
    setRule(input) {
      const problems: string[] = []
      if (input.own_sellers !== undefined)
        store.setOwnSellers(
          input.own_sellers
            .map((s) => s.trim())
            .filter((s) => s !== '')
            .slice(0, 10),
        )
      if (input.rule_id === undefined)
        return input.own_sellers === undefined
          ? { ok: false, problems: ['要给 rule_id，或者 own_sellers。'] }
          : { ok: true }
      const base = resolveListingRules().find((r) => r.id === input.rule_id)
      if (base === undefined) return { ok: false, problems: [`没有这条规则：${input.rule_id}`] }
      const was: ListingRuleOverride = store.state().rule_overrides[base.id] ?? {}
      const next: ListingRuleOverride = { ...was }
      if (input.enabled !== undefined) next.enabled = input.enabled
      if (input.checked_at !== undefined) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(input.checked_at)) next.checked_at = input.checked_at
        else problems.push('checked_at 要写成 YYYY-MM-DD')
      }
      if (input.params !== undefined) {
        const params = { ...(was.params ?? {}) }
        for (const [k, v] of Object.entries(input.params)) {
          const old = base.params[k]
          if (old === undefined) {
            problems.push(
              `这条规则没有参数 ${k}（有：${Object.keys(base.params).join(' / ') || '无'}）`,
            )
            continue
          }
          const okType = Array.isArray(old)
            ? Array.isArray(v) && v.every((x) => typeof x === 'string')
            : typeof v === typeof old
          if (!okType) {
            problems.push(`${k} 的类型不对`)
            continue
          }
          params[k] = v as never
        }
        next.params = params
      }
      store.setOverride(base.id, next)
      const rule = rules().find((r) => r.id === base.id)
      return {
        ok: problems.length === 0,
        ...(problems.length === 0 ? {} : { problems }),
        ...(rule === undefined ? {} : { rule }),
      }
    },
    ownSellers,
    async setOwn(input) {
      const brand = await options.brand()
      const fallback = (input.marketplace ?? marketOf(brand.markets)).toUpperCase()
      const out: BrandWatchAmazonItem[] = []
      for (const raw of input.value.split(/[\s,，、;；]+/)) {
        const t = raw.trim()
        if (t === '') continue
        const entry = classifyAmazonUrl(t)
        if (entry?.kind === 'amazon_listing')
          out.push({ marketplace: entry.country ?? fallback, asin: entry.asin.toUpperCase() })
        else if (ASIN.test(t.toUpperCase()))
          out.push({ marketplace: fallback, asin: t.toUpperCase() })
        else return { ok: false, message: `认不出这是个 Amazon 商品：${t}` }
      }
      const seen = new Set<string>()
      const keep = out.filter((x) => {
        const k = `${x.marketplace}|${x.asin}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      // 原来有的保留标题（只改了清单，不丢名字）
      const merged = keep.map((x) => {
        const was = brand.own.find((o) => o.asin === x.asin && o.marketplace === x.marketplace)
        return was?.label === undefined ? x : { ...x, label: was.label }
      })
      await options.saveOwn(merged.slice(0, 100))
      return { ok: true, own: merged.slice(0, 100) }
    },
    setupTarget: () => ({
      id: AMAZON_OWN_ASINS_TARGET,
      name: '自家 Amazon 商品',
      why: '体检、和竞品比价都要知道你在 Amazon 上卖哪几个商品。勾上是你家的，或者贴一个商品链接。',
      async fields(): Promise<SetupField[]> {
        const brand = await options.brand()
        const found = await candidates()
        const lower = brand.name.trim().toLowerCase()
        const out: SetupField[] = found.map((c) => ({
          key: key(c),
          label: `${c.title.slice(0, 80)}（${c.asin}）`,
          kind: 'toggle',
          suggested: lower !== '' && c.title.toLowerCase().includes(lower) ? 'true' : 'false',
          suggested_why:
            lower !== '' && c.title.toLowerCase().includes(lower)
              ? `按品牌名「${brand.name}」在 Amazon 上搜到的，标题里有你的品牌名`
              : `按品牌名「${brand.name}」搜到的，标题里没有你的品牌名，不一定是你家的`,
          required: false,
        }))
        out.push({
          key: 'more',
          label:
            found.length === 0 ? '商品链接或 ASIN（几个用逗号隔开）' : '还有别的？贴链接或 ASIN',
          kind: 'text',
          placeholder: 'https://www.amazon.com/dp/B0…',
          required: found.length === 0,
        })
        if (found.length === 0)
          out.push({
            key: 'marketplace',
            label: '哪个站点',
            kind: 'select',
            options: ['US', 'CA', 'GB', 'DE', 'FR', 'IT', 'ES', 'JP', 'AU'].map((m) => ({
              value: m,
              label: amazonHostOf(m) ?? m,
            })),
            suggested: marketOf(brand.markets),
            suggested_why: '按品牌档案的目标市场',
            required: false,
          })
        return out
      },
      satisfied: async () => (await options.brand()).own.length > 0,
      async apply(values) {
        const brand = await options.brand()
        const found = store.state().candidates?.items ?? []
        const picked: BrandWatchAmazonItem[] = found
          .filter((c) => values[key(c)] === 'true')
          .map((c) => ({ marketplace: c.marketplace, asin: c.asin, label: c.title.slice(0, 120) }))
        const fallback = (values.marketplace ?? marketOf(brand.markets)).toUpperCase()
        for (const raw of (values.more ?? '').split(/[\s,，、]+/)) {
          const t = raw.trim()
          if (t === '') continue
          const entry = classifyAmazonUrl(t)
          if (entry?.kind === 'amazon_listing')
            picked.push({ marketplace: entry.country ?? fallback, asin: entry.asin })
          else if (ASIN.test(t.toUpperCase()))
            picked.push({ marketplace: fallback, asin: t.toUpperCase() })
          else throw new SetupCardError('invalid_input', `认不出这是个 Amazon 商品：${t}`)
        }
        if (picked.length === 0)
          throw new SetupCardError('invalid_input', '至少勾一个，或者贴一个商品链接 / ASIN。')
        const seen = new Set<string>()
        const merged = [...brand.own, ...picked].filter((x) => {
          const k = `${x.marketplace}|${x.asin}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        await options.saveOwn(merged.slice(0, 100))
      },
    }),
  }
}
