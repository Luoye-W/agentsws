/**
 * WP402（决策 1140 / 1146）：**Amazon 走用户自己的浏览器**（取数链第 3 条路）的那几条规矩，一个品牌一份：
 *
 * - 只在内置浏览器和工坊云端**都失败**时用（这一条由取数链本身保证：前两条有一条读到就轮不到它）；
 * - **第一次用前出一张卡问同意**（设置目标 {@link AMAZON_EXTENSION_CONSENT_TARGET}）；同意后不再问；点「先不用」也不再问；
 *   在设置里随时撤回（撤回 = 不用、不问）；
 * - **每家竞品每天至多一次**（按这个品牌的本地日子算；联想词那一批算一家）；
 * - 只读：打开商品页 / 联想词地址、读回原文，判验证页、解析都和内置浏览器那一路同一份；他浏览器里的配送地址不替他改，
 *   币种对不上就作废（在 `readAmazonAsins` 里判）。
 *
 * 读页本身是 `web-browser/own-browser.ts`（BrowserSkill 的四个读动作）。这台没装好 = 没有这条路。
 */
import {
  type AmazonOwnBrowserRoute,
  type AmazonPageOutcome,
  amazonAutocompleteUrl,
  amazonProductUrlOf,
  isAmazonChallenge,
  isAmazonMissingPage,
  parseAmazonProduct,
  parseAmazonSuggestions,
} from '@agentsws/brand-intake'
import {
  AMAZON_EXTENSION_CONSENT_TARGET,
  AMAZON_EXTENSION_CONSENT_TEXT,
  AMAZON_EXTENSION_DAILY_LIMIT,
  type AmazonOwnBrowserConsent,
  type Iso8601,
} from '@agentsws/contracts'
import type { AutocompleteRead } from '../amazon-keywords/reader.js'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import type { OwnBrowserReader } from '../web-browser/own-browser.js'

/** 存在竞品监控库杂项里的那一份。 */
export interface AmazonOwnBrowserState {
  consent: AmazonOwnBrowserConsent
  /** 键（竞品源 id / `keywords`）→ 哪一天用过几次（本地日子 `YYYY-MM-DD`）。 */
  used?: Record<string, { day: string; n: number }>
}

/** 联想词那一批用的键（算一家）。 */
export const OWN_BROWSER_KEYWORDS_KEY = 'keywords'

export interface AmazonOwnBrowserDeps {
  /** 插件那条路（没装好 = `undefined`）。 */
  reader(): OwnBrowserReader | undefined
  state(): AmazonOwnBrowserState | undefined
  saveState(next: AmazonOwnBrowserState): void
  now(): Iso8601
  /** 这个品牌的时区（本地日子用）。 */
  tzOffsetMinutes?(): number
  /** 出那张同意卡（没有人担这条职责 = 出不了，等下一次）。 */
  askConsent?(): Promise<void>
}

export interface AmazonOwnBrowser {
  consent(): AmazonOwnBrowserConsent
  /** 设置里改 / 卡上点了。 */
  setConsent(state: 'granted' | 'declined' | 'revoked'): AmazonOwnBrowserConsent
  /** 这台有没有这条路（装好了插件那一种）。 */
  available(): boolean
  /** 读一家竞品的商品页用的那条路（没有插件 = `undefined`）。`key` = 竞品源 id。 */
  route(key: string): AmazonOwnBrowserRoute | undefined
  /** 读联想词用的那条路（一批算一家）。 */
  keywords():
    | {
        gate: AmazonOwnBrowserRoute['gate']
        suggest(input: { marketplace: string; prefix: string }): Promise<AutocompleteRead>
        used(): void
      }
    | undefined
  /** 取数链说「要问一句」：第一次时出卡（问过了就不再出）。 */
  needConsent(): Promise<void>
  setupTarget(): SetupTarget
}

const DEFAULT_STATE: AmazonOwnBrowserState = { consent: { state: 'unasked' } }

/** 本地日子（`YYYY-MM-DD`）。 */
export function localDay(now: Iso8601, tzOffsetMinutes = 0): string {
  return new Date(Date.parse(now) + tzOffsetMinutes * 60_000).toISOString().slice(0, 10)
}

const CHALLENGE_MSG = '你自己的浏览器里 Amazon 要人机验证（AI 不碰验证码）'

export function createAmazonOwnBrowser(deps: AmazonOwnBrowserDeps): AmazonOwnBrowser {
  const st = (): AmazonOwnBrowserState => deps.state() ?? DEFAULT_STATE
  const today = (): string => localDay(deps.now(), deps.tzOffsetMinutes?.() ?? 0)

  const gateOf = (key: string): AmazonOwnBrowserRoute['gate'] => {
    if (st().consent.state !== 'granted') return 'needs_consent'
    const u = st().used?.[key]
    return u !== undefined && u.day === today() && u.n >= AMAZON_EXTENSION_DAILY_LIMIT
      ? 'limited'
      : 'ok'
  }
  const markUsed = (key: string): void => {
    const s = st()
    const day = today()
    const prev = s.used?.[key]
    // 只留今天的（旧的日子一并清掉）
    const used: Record<string, { day: string; n: number }> = {}
    for (const [k, v] of Object.entries(s.used ?? {})) if (v.day === day) used[k] = v
    used[key] = { day, n: prev?.day === day ? prev.n + 1 : 1 }
    deps.saveState({ ...s, used })
  }

  const readFacts = async (
    reader: OwnBrowserReader,
    input: { marketplace: string; asin: string },
  ): Promise<AmazonPageOutcome> => {
    const mk = input.marketplace.trim().toUpperCase()
    const url = amazonProductUrlOf(mk, input.asin)
    if (url === undefined) return { status: 'failed', message: `认不出站点 ${input.marketplace}` }
    const r = await reader.read(url, 'html')
    if (!r.ok) return { status: 'failed', message: r.message }
    if (r.challenge === true || isAmazonChallenge(r.text))
      return { status: 'blocked', message: CHALLENGE_MSG }
    if (isAmazonMissingPage(r.text)) return { status: 'missing', message: '找不到这一页' }
    const facts = parseAmazonProduct(r.text, { asin: input.asin, url })
    return facts === undefined
      ? { status: 'failed', message: '读不出这一页' }
      : { status: 'ok', facts }
  }

  const self: AmazonOwnBrowser = {
    consent: () => st().consent,
    setConsent(state) {
      const next: AmazonOwnBrowserState = { ...st(), consent: { state, at: deps.now() } }
      deps.saveState(next)
      return next.consent
    },
    available: () => deps.reader() !== undefined,
    route(key) {
      const reader = deps.reader()
      if (reader === undefined) return undefined
      return {
        gate: gateOf(key),
        read: (input) => readFacts(reader, input),
        used: () => markUsed(key),
      }
    },
    keywords() {
      const reader = deps.reader()
      if (reader === undefined) return undefined
      return {
        gate: gateOf(OWN_BROWSER_KEYWORDS_KEY),
        used: () => markUsed(OWN_BROWSER_KEYWORDS_KEY),
        async suggest({ marketplace, prefix }) {
          const url = amazonAutocompleteUrl(marketplace, prefix)
          if (url === undefined)
            return { status: 'failed', message: `${marketplace} 站点的联想词还读不了` }
          const r = await reader.read(url, 'data')
          if (!r.ok) return { status: 'failed', message: r.message }
          if (r.challenge === true) return { status: 'blocked', message: CHALLENGE_MSG }
          const parsed = parseAmazonSuggestions(r.text)
          if (parsed.status === 'blocked') return { status: 'blocked', message: CHALLENGE_MSG }
          if (parsed.status === 'unreadable') return { status: 'failed', message: parsed.message }
          return { status: 'ok', suggestions: parsed.suggestions }
        },
      }
    },
    async needConsent() {
      if (st().consent.state !== 'unasked') return
      deps.saveState({ ...st(), consent: { state: 'asked', at: deps.now() } })
      await deps.askConsent?.().catch(() => undefined)
    },
    setupTarget: () => ({
      id: AMAZON_EXTENSION_CONSENT_TARGET,
      name: '用你自己的浏览器读 Amazon',
      why: `${AMAZON_EXTENSION_CONSENT_TEXT.title.zh} ${AMAZON_EXTENSION_CONSENT_TEXT.detail.zh}`,
      fields: async () => [
        {
          key: 'consent',
          label: '用你自己的浏览器读 Amazon 的公开商品页',
          kind: 'select',
          options: [
            { value: 'granted', label: '同意（只读，每家每天至多一次）' },
            { value: 'declined', label: '先不用' },
          ],
          suggested: 'granted',
          required: true,
        },
      ],
      satisfied: async () => st().consent.state !== 'unasked' && st().consent.state !== 'asked',
      apply: async (values) => {
        const v = values.consent
        if (v !== 'granted' && v !== 'declined')
          throw new SetupCardError('invalid_input', '选「同意」或「先不用」')
        self.setConsent(v)
      },
    }),
  }
  return self
}
