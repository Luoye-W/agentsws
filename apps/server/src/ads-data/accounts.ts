/**
 * WP315：看哪个广告账户（插件打开后台时网址里要带账户）。缺了出 WP324 的**配置卡**（`ads.accounts`），
 * 在卡上贴一下后台地址栏的网址（或直接填编号）就行——不是秘密，不进加密库。
 */
import type { SetupField } from '@agentsws/contracts'
import { SetupCardError, type SetupTarget } from '../setup-cards.js'
import type { SetupPlan } from '../setup-research.js'
import type { AdsDataPlatform } from './store.js'

export const ADS_ACCOUNTS_TARGET = 'ads.accounts'

export interface AdsAccountConfig {
  /** Google：10 位客户编号（不带横杠）；Meta：广告账户编号（不带 `act_`）。 */
  id: string
  /** Google 后台网址里的 `ocid`（有就带上，网址更稳）。 */
  ocid?: string
}

export type AdsAccounts = Partial<Record<AdsDataPlatform, AdsAccountConfig>>

/**
 * 认一格：后台网址（`…?ocid=…&__c=…`、`…?act=…`）或编号（`123-456-7890` / `act_123` / `123`）。
 * 认不出回 `undefined`。
 */
export function parseAdsAccountInput(
  platform: AdsDataPlatform,
  raw: string,
): AdsAccountConfig | undefined {
  const text = raw.trim()
  if (text === '') return undefined
  let url: URL | undefined
  try {
    url = /^https?:\/\//iu.test(text) ? new URL(text) : undefined
  } catch {
    url = undefined
  }
  if (platform === 'google') {
    const c = url?.searchParams.get('__c') ?? url?.searchParams.get('__u') ?? (url ? '' : text)
    const id = (c ?? '').replace(/[\s-]/gu, '')
    if (!/^\d{10}$/u.test(id)) return undefined
    const ocid = url?.searchParams.get('ocid') ?? undefined
    return { id, ...(ocid === undefined || !/^\d+$/u.test(ocid) ? {} : { ocid }) }
  }
  const a = url?.searchParams.get('act') ?? (url ? '' : text)
  const id = (a ?? '').replace(/^act_/iu, '').trim()
  return /^\d{5,20}$/u.test(id) ? { id } : undefined
}

/** Google 编号给人看的样子（`123-456-7890`）。 */
export function showAccount(platform: AdsDataPlatform, a: AdsAccountConfig): string {
  return platform === 'google' && a.id.length === 10
    ? `${a.id.slice(0, 3)}-${a.id.slice(3, 6)}-${a.id.slice(6)}`
    : platform === 'meta'
      ? `act_${a.id}`
      : a.id
}

const LABEL: Record<AdsDataPlatform, string> = { google: 'Google 广告账户', meta: 'Meta 广告账户' }
const PLACEHOLDER: Record<AdsDataPlatform, string> = {
  google: '后台网址，或客户 ID 123-456-7890',
  meta: 'Ads Manager 网址，或广告账户 ID',
}

/** 配置卡的设置目标（由宿主登记到 WP324）。`wanted` = 这个品牌担着哪几家的投放。 */
export function adsAccountsSetupTarget(options: {
  wanted(): AdsDataPlatform[]
  get(): AdsAccounts
  set(next: AdsAccounts): void
  /**
   * WP348：插件那一侧——每家后台连没连、插件在开着的后台网址里认出过哪些账户（新的在前）。
   * 没有插件通道回 `undefined`。
   */
  seen?():
    | {
        plugin: {
          platform: AdsDataPlatform
          state: 'ready' | 'away' | 'not_connected' | 'unavailable'
        }[]
        accounts: ({ platform: AdsDataPlatform } & AdsAccountConfig)[]
      }
    | undefined
}): SetupTarget {
  return {
    id: ADS_ACCOUNTS_TARGET,
    name: '广告账户',
    why: '插件每天去你的广告后台导出报表，要知道是哪个账户。',
    // 账户只认插件在后台里看到的（或你贴的），不让 AI 猜
    get noGuess(): readonly string[] {
      return options.wanted()
    },
    /*
     * WP348：查什么——插件在开着的广告后台网址里认出过的账户（已连的数据）。查不到：要你填，
     * 并说清是插件没连这家后台，还是连了但还没打开过后台。
     */
    async research(kit): Promise<SetupPlan> {
      const plan: SetupPlan = {}
      const seen = options.seen?.()
      for (const p of options.wanted()) {
        const hit = seen?.accounts.find((a) => a.platform === p)
        const label = `插件在${LABEL[p].replace('账户', '后台')}里看到的`
        if (hit !== undefined) {
          const shown = showAccount(p, hit)
          const more = (seen?.accounts ?? []).filter((a) => a.platform === p).length - 1
          plan[p] = {
            value: shown,
            why:
              more > 0
                ? `插件看到 ${more + 1} 个，先用最近打开的这个`
                : '插件在后台里看到的就是这个',
            sources: [{ kind: 'connected', label }],
          }
          kit.note(`${label}：${shown}`, { kind: 'connected', label })
          continue
        }
        const state = seen?.plugin.find((x) => x.platform === p)?.state
        const why =
          seen === undefined || state === 'unavailable'
            ? '插件还没配对，看不到账户，要你填'
            : state === 'not_connected'
              ? `插件还没连${LABEL[p].replace('账户', '后台')}，要你填`
              : '插件还没在后台里看到账户（打开一次后台就有），要你填'
        plan[p] = { needs_you: true, why }
        kit.note(why)
      }
      return plan
    },
    async fields(): Promise<SetupField[]> {
      const now = options.get()
      return options.wanted().map((p) => {
        const a = now[p]
        return {
          key: p,
          label: LABEL[p],
          kind: 'text',
          required: false,
          placeholder: PLACEHOLDER[p],
          ...(a === undefined ? {} : { suggested: showAccount(p, a) }),
        }
      })
    },
    async satisfied() {
      const now = options.get()
      return options.wanted().some((p) => now[p] !== undefined)
    },
    async apply(values) {
      const next: AdsAccounts = { ...options.get() }
      for (const p of options.wanted()) {
        const raw = values[p]
        if (raw === undefined || raw.trim() === '') continue
        const parsed = parseAdsAccountInput(p, raw)
        if (parsed === undefined)
          throw new SetupCardError(
            'invalid_input',
            `${LABEL[p]}认不出来：贴后台地址栏的网址，或填账户 ID。`,
          )
        next[p] = parsed
      }
      if (!options.wanted().some((p) => next[p] !== undefined))
        throw new SetupCardError('invalid_input', '至少填一个广告账户。')
      options.set(next)
    },
  }
}
