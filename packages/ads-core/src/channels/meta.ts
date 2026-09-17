/**
 * Meta Marketing API 适配器（57 §2，**本 WP 真实现之一**）。
 *
 * 事实来源：Meta Marketing API 文档（2026-09-17 读）。
 * <https://developers.facebook.com/docs/marketing-apis>
 *
 * 形状上要留意的四件事，都在下面标了：
 *
 * 1. **与社媒那把 token 是两张卡**（57 §1）。这条要的是 `ads_management` 权限，
 *    社媒那条要的是 `pages_manage_posts`。同一次 OAuth 可以一起授，但连接卡分开——
 *    不然"想发个帖子"要先授权"能动广告预算"。
 * 2. **钱全是「分」**（`daily_budget` / `budget` / `spend` 的单位是账户币种的最小单位）。
 *    这是 Meta 接口上最容易出事的一格：传 100 不是一百块，是一块。所以本文件里
 *    进出各转一次（{@link toMinor} / {@link fromMinor}），**外面看到的一律是元**。
 * 3. **`access_token` 放 header 不放 query**。Graph API 两种都接；放 query 上的
 *    token 会被代理与访问日志原样记下来。
 * 4. **暂停不是 delete，是 `status: PAUSED`**。删掉的 campaign 连历史数据都带走了，
 *    而止损要的是"先别花钱"——两件事。
 */

import type { AdDeliveryStatus, AdsPlatform, PixelHealth } from '@agentsws/contracts'
import {
  type AdsChangeRequest,
  type AdsChannelAdapter,
  type AdsResult,
  type AdsTransport,
  type ChannelAccount,
  type ChannelAdSet,
  type ChannelCampaign,
  type ChannelInsight,
  type ChannelPixel,
  callJson,
  guardConnected,
} from './types.js'

const PLATFORM: AdsPlatform = 'meta'
const LABEL = 'Meta Ads'

/** 版本钉死：Graph API 每个版本活两年，不钉的话哪天悄悄换了行为没人知道。 */
export const META_ADS_VERSION = 'v21.0'
export const META_ADS_BASE = `https://graph.facebook.com/${META_ADS_VERSION}`

const ACCOUNT_FIELDS = 'id,account_id,name,currency,account_status,amount_spent'
const CAMPAIGN_FIELDS = 'id,name,status,objective,daily_budget,lifetime_budget'
const ADSET_FIELDS = 'id,name,status,campaign_id,bid_amount,bid_strategy,daily_budget,targeting'
const INSIGHT_FIELDS =
  'campaign_id,campaign_name,spend,impressions,clicks,actions,action_values,purchase_roas'

/** 钱：元 → 分（文件头第 2 条）。 */
export const toMinor = (major: number): number => Math.round(major * 100)
/** 钱：分 → 元。拿不到就是拿不到，**不补 0**。 */
export const fromMinor = (minor: string | number | undefined): number | undefined => {
  const n = typeof minor === 'string' ? Number(minor) : minor
  return typeof n === 'number' && Number.isFinite(n) ? n / 100 : undefined
}

/** 钱那几格：转完是 `undefined` 就一格都不出（`exactOptionalPropertyTypes`）。 */
const budgetOf = <K extends string>(
  raw: string | undefined,
  key: K,
): Record<K, number> | Record<string, never> => {
  const v = fromMinor(raw)
  return v === undefined ? {} : ({ [key]: v } as Record<K, number>)
}

/** Meta 的 `account_status`：1 = 活着，2 = 停用，别的按 `unknown`。 */
const accountStatusOf = (raw: number | undefined): ChannelAccount['status'] =>
  raw === 1 ? 'active' : raw === 2 ? 'disabled' : raw === undefined ? 'unknown' : 'paused'

const deliveryOf = (raw: string | undefined): AdDeliveryStatus => {
  switch (raw) {
    case 'ACTIVE':
      return 'active'
    case 'PAUSED':
      return 'paused'
    case 'PENDING_REVIEW':
    case 'IN_PROCESS':
      return 'pending_review'
    case 'DISAPPROVED':
      return 'rejected'
    default:
      return 'ended'
  }
}

interface RawAccount {
  id?: string
  account_id?: string
  name?: string
  currency?: string
  account_status?: number
  amount_spent?: string
}
interface RawCampaign {
  id?: string
  name?: string
  status?: string
  objective?: string
  daily_budget?: string
  lifetime_budget?: string
}
interface RawAdSet extends RawCampaign {
  campaign_id?: string
  bid_amount?: string
  bid_strategy?: string
  targeting?: unknown
}
interface RawInsight {
  campaign_id?: string
  campaign_name?: string
  spend?: string
  impressions?: string
  clicks?: string
  actions?: { action_type?: string; value?: string }[]
  action_values?: { action_type?: string; value?: string }[]
  purchase_roas?: { value?: string }[]
}
interface RawPixel {
  id?: string
  name?: string
  last_fired_time?: string
}
interface Paged<T> {
  data?: T[]
}

const num = (raw: string | number | undefined): number | undefined => {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** 从 `actions` 里挑出购买那一条。挑不到就是 `undefined`——**不拿加购顶替**。 */
const purchaseOf = (rows: { action_type?: string; value?: string }[] | undefined) =>
  num(rows?.find((a) => a.action_type === 'purchase' || a.action_type === 'omni_purchase')?.value)

export function createMetaAdsAdapter(transport: AdsTransport): AdsChannelAdapter {
  const off = () => guardConnected(transport, PLATFORM, LABEL)
  /** 每次现取现用；**不缓存**（凭据不在对象里留着）。 */
  const auth = async (): Promise<Record<string, string>> => {
    const cred = await transport.credential(PLATFORM)
    return { Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}` }
  }
  const at = () => transport.now()

  return {
    platform: PLATFORM,
    implemented: true,

    async accounts(): Promise<AdsResult<ChannelAccount[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const cred = await transport.credential(PLATFORM)
      // `business_id` 有就按商务管理平台列，没有就列这把 token 自己的广告账户
      const url =
        cred.business_id === undefined || cred.business_id === ''
          ? `${META_ADS_BASE}/me/adaccounts?fields=${ACCOUNT_FIELDS}`
          : `${META_ADS_BASE}/${cred.business_id}/owned_ad_accounts?fields=${ACCOUNT_FIELDS}`
      const res = await callJson<Paged<RawAccount>>(transport, LABEL, url, {
        headers: await auth(),
      })
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: (res.data.data ?? []).map((raw) => ({
          platform: PLATFORM,
          external_id: raw.id ?? `act_${raw.account_id ?? ''}`,
          name: raw.name ?? '',
          currency: raw.currency ?? '',
          status: accountStatusOf(raw.account_status),
          // `amount_spent` 是**账户累计**不是今天：今天花了多少要走 insights，
          // 所以这里不填 `spend_today`——填了会让总闸按一个累计数去判
        })),
      }
    },

    async campaigns(account_external_id): Promise<AdsResult<ChannelCampaign[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await callJson<Paged<RawCampaign>>(
        transport,
        LABEL,
        `${META_ADS_BASE}/${account_external_id}/campaigns?fields=${CAMPAIGN_FIELDS}&limit=200`,
        { headers: await auth() },
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: (res.data.data ?? []).map((raw) => ({
          account_external_id,
          platform: PLATFORM,
          external_id: raw.id ?? '',
          name: raw.name ?? '',
          status: deliveryOf(raw.status),
          ...(raw.objective === undefined ? {} : { objective: raw.objective }),
          ...budgetOf(raw.daily_budget, 'daily_budget'),
          ...budgetOf(raw.lifetime_budget, 'lifetime_budget'),
        })) as ChannelCampaign[],
      }
    },

    async adSets(campaign_external_id): Promise<AdsResult<ChannelAdSet[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await callJson<Paged<RawAdSet>>(
        transport,
        LABEL,
        `${META_ADS_BASE}/${campaign_external_id}/adsets?fields=${ADSET_FIELDS}&limit=200`,
        { headers: await auth() },
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: (res.data.data ?? []).map((raw) => ({
          campaign_external_id,
          platform: PLATFORM,
          external_id: raw.id ?? '',
          name: raw.name ?? '',
          status: deliveryOf(raw.status),
          ...budgetOf(raw.bid_amount, 'bid_amount'),
          ...(raw.bid_strategy === undefined ? {} : { bid_strategy: raw.bid_strategy }),
          ...budgetOf(raw.daily_budget, 'daily_budget'),
          // 受众原样摘一句给卡面看（**不解析成结构**：那是平台的定向树，改它是另一件事）
          ...(raw.targeting === undefined
            ? {}
            : { audience_summary: JSON.stringify(raw.targeting).slice(0, 300) }),
        })) as ChannelAdSet[],
      }
    },

    async insights({ account_external_id, since, until }): Promise<AdsResult<ChannelInsight[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const range = encodeURIComponent(JSON.stringify({ since, until }))
      const res = await callJson<Paged<RawInsight>>(
        transport,
        LABEL,
        `${META_ADS_BASE}/${account_external_id}/insights?fields=${INSIGHT_FIELDS}&level=campaign&time_range=${range}&limit=500`,
        { headers: await auth() },
      )
      if (!res.ok) return res
      const observed_at = at()
      return {
        ok: true,
        observed_at,
        data: (res.data.data ?? []).map((raw) => {
          // insights 的 `spend` 是**元**（与 campaign 上那个"分"不一样，这是 Meta 自己的坑）
          const spend = num(raw.spend)
          const impressions = num(raw.impressions)
          const clicks = num(raw.clicks)
          const conversions = purchaseOf(raw.actions)
          const conversion_value = purchaseOf(raw.action_values)
          // ROAS 用平台自己算的那个数，**我们不除**：分子分母口径是它定的
          const roas = num(raw.purchase_roas?.[0]?.value)
          return {
            campaign_external_id: raw.campaign_id ?? '',
            campaign_name: raw.campaign_name ?? '',
            metrics: {
              ...(spend === undefined ? {} : { spend }),
              ...(impressions === undefined ? {} : { impressions }),
              ...(clicks === undefined ? {} : { clicks }),
              ...(conversions === undefined ? {} : { conversions }),
              ...(conversion_value === undefined ? {} : { conversion_value }),
              ...(roas === undefined ? {} : { roas }),
              observed_at,
            },
          }
        }),
      }
    },

    async pixels(account_external_id): Promise<AdsResult<ChannelPixel[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await callJson<Paged<RawPixel>>(
        transport,
        LABEL,
        `${META_ADS_BASE}/${account_external_id}/adspixels?fields=id,name,last_fired_time`,
        { headers: await auth() },
      )
      if (!res.ok) return res
      const observed_at = at()
      const nowMs = Date.parse(observed_at)
      return {
        ok: true,
        observed_at,
        data: (res.data.data ?? []).map((raw) => {
          const last =
            raw.last_fired_time === undefined ? Number.NaN : Date.parse(raw.last_fired_time)
          // 24 小时没响过 = `stale`；从来没响过 = `missing`。两句话要去找的人不一样
          const status: PixelHealth = Number.isNaN(last)
            ? 'missing'
            : nowMs - last > 86_400_000
              ? 'stale'
              : 'healthy'
          return {
            platform: PLATFORM,
            external_id: raw.id ?? '',
            event_name: raw.name ?? 'Pixel',
            ...(raw.last_fired_time === undefined ? {} : { last_fired_at: raw.last_fired_time }),
            status,
          }
        }),
      }
    },

    async applyChange(
      input: AdsChangeRequest,
    ): Promise<AdsResult<{ external_id: string; note?: string }>> {
      const gate = off()
      if (gate !== undefined) return gate
      const headers = { ...(await auth()), 'content-type': 'application/x-www-form-urlencoded' }
      const form = (rows: Record<string, string>) => new URLSearchParams(rows).toString()
      const observed_at = at()

      switch (input.kind) {
        case 'create_campaign': {
          const daily =
            typeof input.after.daily_budget === 'number' ? input.after.daily_budget : undefined
          const res = await callJson<{ id?: string }>(
            transport,
            LABEL,
            `${META_ADS_BASE}/${input.account_external_id}/campaigns`,
            {
              method: 'POST',
              headers,
              body: form({
                name: String(input.after.name ?? ''),
                objective: String(input.after.objective ?? 'OUTCOME_SALES'),
                // 新建一律**先停着**：批准的是"建一条"，不是"现在就开始花钱"。
                // 要它跑起来是另一条 `pause_ad` 的反面动作，另一张卡。
                status: 'PAUSED',
                special_ad_categories: '[]',
                ...(daily === undefined ? {} : { daily_budget: String(toMinor(daily)) }),
              }),
            },
          )
          if (!res.ok) return res
          return {
            ok: true,
            observed_at,
            data: {
              external_id: res.data.id ?? '',
              note: '建出来是停着的——批的是"建一条"，让它开始花钱是另一张卡。',
            },
          }
        }
        case 'budget_change': {
          const value = typeof input.after.value === 'number' ? input.after.value : undefined
          if (value === undefined)
            return {
              ok: false,
              reason: 'upstream_error',
              message: '改预算没给新的数（`after.value`）。',
            }
          const res = await callJson<{ success?: boolean }>(
            transport,
            LABEL,
            `${META_ADS_BASE}/${input.external_id}`,
            { method: 'POST', headers, body: form({ daily_budget: String(toMinor(value)) }) },
          )
          if (!res.ok) return res
          return { ok: true, observed_at, data: { external_id: input.external_id } }
        }
        case 'bid_change': {
          const value = typeof input.after.value === 'number' ? input.after.value : undefined
          if (value === undefined)
            return {
              ok: false,
              reason: 'upstream_error',
              message: '改出价没给新的数（`after.value`）。',
            }
          const res = await callJson<{ success?: boolean }>(
            transport,
            LABEL,
            `${META_ADS_BASE}/${input.external_id}`,
            { method: 'POST', headers, body: form({ bid_amount: String(toMinor(value)) }) },
          )
          if (!res.ok) return res
          return { ok: true, observed_at, data: { external_id: input.external_id } }
        }
        case 'pause_ad': {
          // 文件头第 4 条：暂停是 `status: PAUSED`，**不是 delete**
          const res = await callJson<{ success?: boolean }>(
            transport,
            LABEL,
            `${META_ADS_BASE}/${input.external_id}`,
            { method: 'POST', headers, body: form({ status: 'PAUSED' }) },
          )
          if (!res.ok) return res
          return {
            ok: true,
            observed_at,
            data: {
              external_id: input.external_id,
              note: '停了，没删——历史数据还在，随时能再开。',
            },
          }
        }
        case 'creative_swap': {
          const creative_id = input.after.creative_id
          if (typeof creative_id !== 'string' || creative_id === '')
            return {
              ok: false,
              reason: 'upstream_error',
              message:
                '换素材要先有一条 ad creative（`after.creative_id`）。Meta 这边素材是独立对象，不能在广告上就地改一段文案。',
            }
          const res = await callJson<{ success?: boolean }>(
            transport,
            LABEL,
            `${META_ADS_BASE}/${input.external_id}`,
            { method: 'POST', headers, body: form({ creative: JSON.stringify({ creative_id }) }) },
          )
          if (!res.ok) return res
          return { ok: true, observed_at, data: { external_id: input.external_id } }
        }
        default:
          return {
            ok: false,
            reason: 'not_implemented',
            message: `${LABEL} 不认识这种改动：${String(input.kind)}。`,
          }
      }
    },
  }
}
