/**
 * 云上公共红人库的**契约替身**（WP165，docs/83 §2 第 5 条）。
 *
 * 真服务（`KolPublicService`）在云端那一侧，将来进私有仓。开源这一侧的合成世界要演的只是
 * 契约上的几条口径（docs/48 §5.3、docs/77，09-23 Luoye 定）：
 *
 * - **浏览按次收**（`data.kol.lookup`）；搜到 0 条不收；同一个查询 10 分钟内翻页不重复收；
 * - **取回联系方式另收**（`data.kol.reveal`）；库里没有这个人 / 没有联系方式不收；
 * - 余额不够**只拒这一次**，回一句人话（与云上同一句），一分不扣；
 * - 价钱查价目表（{@link SAMPLE_PRICING_CATALOG} 或调用方给的那份），不写死在这里。
 *
 * 纯内存。联系方式在替身里是明文放在内存里的（真服务存哈希 + 密文）——替身不落盘、
 * 不出进程；加密那一段的测试留在云端那一侧。
 */
import type {
  Iso8601,
  KolChannel,
  KolObservationSource,
  PublicCreatorCard,
  PublicCreatorObservation,
  RevealedContact,
} from '@agentsws/contracts'
import {
  catalogCreditsFor,
  DEFAULT_CREATOR_LIMIT,
  KOL_LOOKUP_CAPABILITY,
  KOL_REVEAL_CAPABILITY,
  KOL_UNIT,
  MAX_CREATOR_LIMIT,
  type Pricing,
} from '@agentsws/contracts'
import { SAMPLE_PRICING_CATALOG } from './pricing-sample.js'
import { type StandInWallet, StandInWalletError } from './wallet.js'

/** 云上那一侧认的主体（与 `kol-public` 的 `KolPrincipal` 同形）。 */
export interface StandInKolPrincipal {
  account_id: string
  org_id: string
  workspace_id: string
  scopes: string[]
  region: 'cn' | 'global'
}

/** 替身抛的错：码与云上那张表同名，`message` 是同一句人话。 */
export class StandInKolError extends Error {
  readonly code: 'not_found' | 'insufficient_credits' | 'invalid_input'
  constructor(code: 'not_found' | 'insufficient_credits' | 'invalid_input', message: string) {
    super(message)
    this.name = 'StandInKolError'
    this.code = code
  }
}

/** 同一个查询多久之内翻页不重复收（与云上同一条口径）。 */
export const STAND_IN_SEARCH_WINDOW_MS = 10 * 60 * 1000

const NOT_IN_LIBRARY =
  '公共库里还没有这个人。可以先用插件采集或者手动报一条观察，之后所有人都能看到。'
const NO_CONTACT = '库里还没有这个人的联系方式。没有取到就不收钱——这一次没有扣积分。'

const keyOf = (channel: KolChannel, handle: string): string =>
  `${channel}:${handle.replace(/^@/u, '').toLowerCase()}`

export class KolPublicStandIn {
  private readonly cards = new Map<string, PublicCreatorCard>()
  private readonly contacts = new Map<string, { email: string; source: KolObservationSource }>()
  private readonly searchCharges = new Map<string, Iso8601>()
  private readonly wallet: StandInWallet
  private readonly pricing: Pricing
  private readonly now: () => Iso8601
  private readonly newId: (prefix: string) => string

  constructor(options: {
    wallet: StandInWallet
    now: () => Iso8601
    newId: (prefix: string) => string
    pricing?: Pricing
  }) {
    this.wallet = options.wallet
    this.now = options.now
    this.newId = options.newId
    this.pricing = options.pricing ?? SAMPLE_PRICING_CATALOG.pricing
  }

  /** 工作区手填的观察（来源记 `manual`）。回进库了几条。 */
  contributeAs(
    _principal: StandInKolPrincipal,
    observations: readonly PublicCreatorObservation[],
  ): number {
    for (const o of observations) {
      const key = keyOf(o.channel, o.handle)
      const before = this.cards.get(key)
      this.cards.set(key, {
        channel: o.channel,
        handle: o.handle.replace(/^@/u, '').toLowerCase(),
        followers: o.followers,
        posts_30d: o.posts_30d ?? before?.posts_30d ?? 0,
        engagement_rate: o.engagement_rate ?? before?.engagement_rate ?? 0,
        categories: [...(o.categories ?? before?.categories ?? [])],
        observed_at: o.observed_at,
        source: 'manual',
        observations: (before?.observations ?? 0) + 1,
        confidence: before?.confidence ?? 0.5,
        has_contact: before?.has_contact ?? false,
        updated_at: this.now(),
        ...(o.language === undefined ? {} : { language: o.language }),
        ...(o.region === undefined ? {} : { region: o.region }),
      })
    }
    return observations.length
  }

  /** 回填联系方式（库里得先有这个人）。 */
  saveContact(
    _subject: unknown,
    key: { channel: KolChannel; handle: string },
    body: { email: string; source?: KolObservationSource },
  ): void {
    const card = this.cardOrThrow(key.channel, key.handle)
    this.contacts.set(keyOf(card.channel, card.handle), {
      email: body.email.trim().toLowerCase(),
      source: body.source === 'plugin' ? 'plugin' : 'manual',
    })
    card.has_contact = true
  }

  /** 浏览 / 搜索：按 `data.kol.lookup` 收；0 条不收；同一查询 10 分钟内翻页不重复收。 */
  browse(
    principal: StandInKolPrincipal,
    query: { channel?: KolChannel; q?: string; limit?: number },
  ): { creators: PublicCreatorCard[]; credits: number } {
    const limit = Math.min(Math.max(1, query.limit ?? DEFAULT_CREATOR_LIMIT), MAX_CREATOR_LIMIT)
    const q = query.q?.trim().toLowerCase() ?? ''
    const creators = [...this.cards.values()]
      .filter((c) => query.channel === undefined || c.channel === query.channel)
      .filter((c) => q === '' || c.handle.includes(q))
      .sort((a, b) => b.followers - a.followers)
      .slice(0, limit)
      .map((c) => ({ ...c, categories: [...c.categories] }))
    if (creators.length === 0) return { creators, credits: 0 }
    const window = q === '' ? undefined : `${principal.workspace_id}|${query.channel ?? '*'}|${q}`
    const last = window === undefined ? undefined : this.searchCharges.get(window)
    if (last !== undefined && Date.parse(this.now()) - Date.parse(last) < STAND_IN_SEARCH_WINDOW_MS)
      return { creators, credits: 0 }
    const credits = this.charge(principal, KOL_LOOKUP_CAPABILITY)
    if (window !== undefined) this.searchCharges.set(window, this.now())
    return { creators, credits }
  }

  /** 取回一个联系方式：按 `data.kol.reveal` 收；没有就不收。 */
  reveal(
    principal: StandInKolPrincipal,
    key: { channel: KolChannel; handle: string },
  ): RevealedContact {
    const at = this.now()
    const card = this.cardOrThrow(key.channel, key.handle)
    const contact = this.contacts.get(keyOf(card.channel, card.handle))
    if (contact === undefined) throw new StandInKolError('not_found', NO_CONTACT)
    const credits = this.charge(principal, KOL_REVEAL_CAPABILITY)
    return {
      channel: card.channel,
      handle: card.handle,
      email: contact.email,
      source: contact.source,
      at,
      credits,
    }
  }

  private cardOrThrow(channel: KolChannel, handle: string): PublicCreatorCard {
    const card = this.cards.get(keyOf(channel, handle))
    if (card === undefined) throw new StandInKolError('not_found', NOT_IN_LIBRARY)
    return card
  }

  /** 预扣 → 结算（替身里「做」这一步不会失败）。余额不够回云上那一句。 */
  private charge(principal: StandInKolPrincipal, capability: string): number {
    const credits = catalogCreditsFor(this.pricing, capability, 1)
    if (credits === undefined)
      throw new StandInKolError('invalid_input', `价目表里没有 ${capability} 这一项`)
    try {
      const reservation = this.wallet.reserve({
        org_id: principal.org_id,
        workspace_id: principal.workspace_id,
        capability,
        unit: KOL_UNIT,
        quantity: 1,
        credits,
        request_id: this.newId('req'),
      })
      return this.wallet.settle(reservation, { quantity: 1, credits })
    } catch (err) {
      if (err instanceof StandInWalletError && err.code === 'insufficient_credits')
        throw new StandInKolError('insufficient_credits', err.message)
      throw err
    }
  }
}
