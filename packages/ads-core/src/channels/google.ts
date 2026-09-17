/**
 * Google Ads API 适配器（57 §2，**本 WP 真实现之二**）。
 *
 * 事实来源：Google Ads API 文档（2026-09-17 读）。
 * <https://developers.google.com/google-ads/api/docs/start>
 *
 * 形状上要留意的五件事，都在下面标了：
 *
 * 1. **三样东西缺一不可**：OAuth access token（`Authorization`）、
 *    **developer token**（`developer-token` 头，要单独申请并过审）、
 *    以及 `login-customer-id`（用 MCC 管别人账户时）。缺 developer token 时
 *    上游回 401 / 403，我们翻成 `needs_developer_token` 而不是"连接失败"——
 *    这两句话要做的事完全不同（57 §1）。
 * 2. **读走 GAQL**（`searchStream`，POST 一段 SQL 样子的查询）。没有 REST 风格的
 *    "列一下 campaign"这回事——这是 Google Ads API 与别家最不一样的地方。
 * 3. **钱是「微」**（micros，1 元 = 1_000_000）。传错六个零，一条日预算就从
 *    一百块变成一毛。所以进出各转一次（{@link toMicros} / {@link fromMicros}），
 *    **外面看到的一律是元**。
 * 4. **写走 `:mutate`**，而且要给 `updateMask`——不给的话那次更新什么都不会改，
 *    接口还回 200。这是这套 API 上最安静的一个坑。
 * 5. **customer id 不带横杠**（`1234567890`，不是 `123-456-7890`）。
 */

import type { AdDeliveryStatus, AdsPlatform, PixelHealth } from '@agentsws/contracts'
import {
  type AdsChangeRequest,
  type AdsChannelAdapter,
  type AdsError,
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

const PLATFORM: AdsPlatform = 'google'
const LABEL = 'Google Ads'

/** 版本钉死（Google Ads API 每年退役几个版本，不钉的话某天整包 404）。 */
export const GOOGLE_ADS_VERSION = 'v18'
export const GOOGLE_ADS_BASE = `https://googleads.googleapis.com/${GOOGLE_ADS_VERSION}`

/** 钱：元 → 微（文件头第 3 条）。 */
export const toMicros = (major: number): number => Math.round(major * 1_000_000)
/** 钱：微 → 元。拿不到就是拿不到，**不补 0**。 */
export const fromMicros = (micros: string | number | undefined): number | undefined => {
  const n = typeof micros === 'string' ? Number(micros) : micros
  return typeof n === 'number' && Number.isFinite(n) ? n / 1_000_000 : undefined
}

/** customer id 去掉横杠（文件头第 5 条）。 */
export const normalizeCustomerId = (raw: string): string => raw.replace(/-/g, '').trim()

const deliveryOf = (raw: string | undefined): AdDeliveryStatus => {
  switch (raw) {
    case 'ENABLED':
      return 'active'
    case 'PAUSED':
      return 'paused'
    case 'REMOVED':
      return 'ended'
    default:
      return 'pending_review'
  }
}

const num = (raw: string | number | undefined): number | undefined => {
  const n = typeof raw === 'string' ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

/** `searchStream` 回的是一串 chunk，每个 chunk 里一个 `results`。 */
interface StreamChunk {
  results?: Record<string, Record<string, unknown>>[]
}

const str = (row: Record<string, unknown> | undefined, key: string): string | undefined => {
  const v = row?.[key]
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}

export function createGoogleAdsAdapter(transport: AdsTransport): AdsChannelAdapter {
  const off = () => guardConnected(transport, PLATFORM, LABEL)
  const at = () => transport.now()

  /**
   * 三个头一起给（文件头第 1 条）。`developer_token` 一格没填就**一跳都不打**——
   * 打出去必然是 401，而那句"连接失败"会把人送去重连 OAuth（错的地方）。
   */
  const headers = async (): Promise<{ ok: true; head: Record<string, string> } | AdsError> => {
    const cred = await transport.credential(PLATFORM)
    const dev = cred.developer_token ?? ''
    if (dev === '')
      return {
        ok: false,
        reason: 'needs_developer_token',
        message:
          'Google Ads 还差一个 developer token。它要在 Google Ads API Center 单独申请并过审（基础访问权限够用），与 OAuth 授权是两件事——重连一次授权解决不了这个。',
      }
    const login = cred.login_customer_id ?? cred.manager_customer_id
    return {
      ok: true,
      head: {
        Authorization: `Bearer ${cred.access_token ?? cred.token ?? ''}`,
        'developer-token': dev,
        'content-type': 'application/json',
        ...(login === undefined || login === ''
          ? {}
          : { 'login-customer-id': normalizeCustomerId(login) }),
      },
    }
  }

  /** 跑一段 GAQL（文件头第 2 条）。 */
  const search = async (
    customer_id: string,
    query: string,
  ): Promise<{ ok: true; rows: Record<string, Record<string, unknown>>[] } | AdsError> => {
    const head = await headers()
    if (!head.ok) return head
    const res = await callJson<StreamChunk[] | StreamChunk>(
      transport,
      LABEL,
      `${GOOGLE_ADS_BASE}/customers/${normalizeCustomerId(customer_id)}/googleAds:searchStream`,
      { method: 'POST', headers: head.head, body: JSON.stringify({ query }) },
    )
    if (!res.ok) return res
    const chunks = Array.isArray(res.data) ? res.data : [res.data]
    return { ok: true, rows: chunks.flatMap((c) => c.results ?? []) }
  }

  return {
    platform: PLATFORM,
    implemented: true,

    async accounts(): Promise<AdsResult<ChannelAccount[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const cred = await transport.credential(PLATFORM)
      const customer_id = cred.customer_id ?? cred.login_customer_id ?? ''
      if (customer_id === '')
        return {
          ok: false,
          reason: 'not_connected',
          message:
            'Google Ads 的连接上没有客户 id（`customer_id`）。去连接页把那一格填上——就是后台右上角那串十位数字，不带横杠。',
        }
      const res = await search(
        customer_id,
        'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.status FROM customer',
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: res.rows.map((row) => {
          const c = row.customer
          return {
            platform: PLATFORM,
            external_id: str(c, 'id') ?? normalizeCustomerId(customer_id),
            name: str(c, 'descriptiveName') ?? '',
            currency: str(c, 'currencyCode') ?? '',
            status: str(c, 'status') === 'ENABLED' ? 'active' : 'unknown',
          }
        }),
      }
    },

    async campaigns(account_external_id): Promise<AdsResult<ChannelCampaign[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await search(
        account_external_id,
        'SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, ' +
          'campaign_budget.amount_micros FROM campaign WHERE campaign.status != "REMOVED"',
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: res.rows.map((row) => {
          const c = row.campaign
          const b = row.campaignBudget
          const daily = fromMicros(str(b, 'amountMicros'))
          return {
            account_external_id: normalizeCustomerId(account_external_id),
            platform: PLATFORM,
            external_id: str(c, 'id') ?? '',
            name: str(c, 'name') ?? '',
            status: deliveryOf(str(c, 'status')),
            ...(str(c, 'advertisingChannelType') === undefined
              ? {}
              : { objective: str(c, 'advertisingChannelType') }),
            ...(daily === undefined ? {} : { daily_budget: daily }),
          }
        }) as ChannelCampaign[],
      }
    },

    async adSets(campaign_external_id): Promise<AdsResult<ChannelAdSet[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const cred = await transport.credential(PLATFORM)
      const customer_id = cred.customer_id ?? cred.login_customer_id ?? ''
      const res = await search(
        customer_id,
        'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.cpc_bid_micros, campaign.id ' +
          `FROM ad_group WHERE campaign.id = ${JSON.stringify(campaign_external_id)}`,
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: res.rows.map((row) => {
          const g = row.adGroup
          const bid = fromMicros(str(g, 'cpcBidMicros'))
          return {
            campaign_external_id,
            platform: PLATFORM,
            external_id: str(g, 'id') ?? '',
            name: str(g, 'name') ?? '',
            status: deliveryOf(str(g, 'status')),
            ...(bid === undefined ? {} : { bid_amount: bid }),
          }
        }) as ChannelAdSet[],
      }
    },

    async insights({ account_external_id, since, until }): Promise<AdsResult<ChannelInsight[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await search(
        account_external_id,
        'SELECT campaign.id, campaign.name, metrics.cost_micros, metrics.impressions, metrics.clicks, ' +
          'metrics.conversions, metrics.conversions_value FROM campaign ' +
          `WHERE segments.date BETWEEN "${since}" AND "${until}"`,
      )
      if (!res.ok) return res
      const observed_at = at()
      return {
        ok: true,
        observed_at,
        data: res.rows.map((row) => {
          const c = row.campaign
          const m = row.metrics
          const spend = fromMicros(str(m, 'costMicros'))
          const value = num(str(m, 'conversionsValue'))
          const impressions = num(str(m, 'impressions'))
          const clicks = num(str(m, 'clicks'))
          const conversions = num(str(m, 'conversions'))
          return {
            campaign_external_id: str(c, 'id') ?? '',
            campaign_name: str(c, 'name') ?? '',
            metrics: {
              ...(spend === undefined ? {} : { spend }),
              ...(impressions === undefined ? {} : { impressions }),
              ...(clicks === undefined ? {} : { clicks }),
              ...(conversions === undefined ? {} : { conversions }),
              ...(value === undefined ? {} : { conversion_value: value }),
              /*
               * Google 不直接给 ROAS，给的是转化额与花费。这里**算**是可以的，
               * 与 Meta 那边"不替平台除"不矛盾：那边平台自己报了一个数（口径是它定的），
               * 这边平台没报——不算的话面板上这一列就永远空着。算出来的那个数
               * 用的是它自己那两格，没有掺别的。
               */
              ...(spend === undefined || spend <= 0 || value === undefined
                ? {}
                : { roas: Math.round((value / spend) * 100) / 100 }),
              observed_at,
            },
          }
        }),
      }
    },

    async pixels(account_external_id): Promise<AdsResult<ChannelPixel[]>> {
      const gate = off()
      if (gate !== undefined) return gate
      const res = await search(
        account_external_id,
        'SELECT conversion_action.id, conversion_action.name, conversion_action.status, ' +
          'conversion_action.tag_snippets FROM conversion_action',
      )
      if (!res.ok) return res
      return {
        ok: true,
        observed_at: at(),
        data: res.rows.map((row) => {
          const a = row.conversionAction
          const raw = str(a, 'status')
          // Google 这边没有"上次触发是什么时候"，只有一个状态。
          // `REMOVED` = 这个转化动作没了；`HIDDEN` = 配错了。照实分档，**不编一个时间**
          const status: PixelHealth =
            raw === 'ENABLED' ? 'healthy' : raw === 'REMOVED' ? 'missing' : 'misconfigured'
          return {
            platform: PLATFORM,
            external_id: str(a, 'id') ?? '',
            event_name: str(a, 'name') ?? '',
            status,
            ...(status === 'healthy'
              ? {}
              : {
                  note: `转化动作的状态是 ${raw ?? '未知'}——Google Ads 不给"上次触发时间"，所以这里只报状态，不猜它最后一次收到数据是什么时候。`,
                }),
          }
        }),
      }
    },

    async applyChange(
      input: AdsChangeRequest,
    ): Promise<AdsResult<{ external_id: string; note?: string }>> {
      const gate = off()
      if (gate !== undefined) return gate
      const head = await headers()
      if (!head.ok) return head
      const h = head.head
      const customer = normalizeCustomerId(input.account_external_id)
      const observed_at = at()
      /** 文件头第 4 条：`:mutate` + `updateMask`，少一个就是"改了个寂寞还回 200"。 */
      const mutate = async (
        resource: 'campaigns' | 'adGroups' | 'campaignBudgets' | 'ads',
        operations: unknown[],
      ) =>
        callJson<{ results?: { resourceName?: string }[] }>(
          transport,
          LABEL,
          `${GOOGLE_ADS_BASE}/customers/${customer}/${resource}:mutate`,
          { method: 'POST', headers: h, body: JSON.stringify({ operations }) },
        )

      switch (input.kind) {
        case 'create_campaign': {
          const res = await mutate('campaigns', [
            {
              create: {
                name: String(input.after.name ?? ''),
                // 与 Meta 那边同一条：建出来**先停着**，让它花钱是另一张卡
                status: 'PAUSED',
                advertisingChannelType: String(input.after.objective ?? 'SEARCH'),
                ...(typeof input.after.budget_resource_name === 'string'
                  ? { campaignBudget: input.after.budget_resource_name }
                  : {}),
              },
            },
          ])
          if (!res.ok) return res
          return {
            ok: true,
            observed_at,
            data: {
              external_id: res.data.results?.[0]?.resourceName ?? '',
              note: '建出来是停着的——批的是"建一条"，让它开始花钱是另一张卡。',
            },
          }
        }
        case 'budget_change': {
          const value = typeof input.after.value === 'number' ? input.after.value : undefined
          const budgetResource = input.after.budget_resource_name
          if (value === undefined || typeof budgetResource !== 'string')
            return {
              ok: false,
              reason: 'upstream_error',
              message:
                '改预算要给新的数（`after.value`）与预算资源名（`after.budget_resource_name`）。Google 这边预算是独立对象，改的不是 campaign 上的一格。',
            }
          const res = await mutate('campaignBudgets', [
            {
              update: { resourceName: budgetResource, amountMicros: String(toMicros(value)) },
              updateMask: 'amount_micros',
            },
          ])
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
          const res = await mutate('adGroups', [
            {
              update: {
                resourceName: `customers/${customer}/adGroups/${input.external_id}`,
                cpcBidMicros: String(toMicros(value)),
              },
              updateMask: 'cpc_bid_micros',
            },
          ])
          if (!res.ok) return res
          return { ok: true, observed_at, data: { external_id: input.external_id } }
        }
        case 'pause_ad': {
          const res = await mutate('campaigns', [
            {
              update: {
                resourceName: `customers/${customer}/campaigns/${input.external_id}`,
                status: 'PAUSED',
              },
              updateMask: 'status',
            },
          ])
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
          const headline = input.after.headline
          const description = input.after.primary_text ?? input.after.description
          if (typeof headline !== 'string' && typeof description !== 'string')
            return {
              ok: false,
              reason: 'upstream_error',
              message:
                '换文案至少要给一条标题或一段描述（`after.headline` / `after.primary_text`）。',
            }
          /*
           * 响应式搜索广告的标题与描述是**数组**，而且 Google 不许就地改一条已经在跑的
           * 广告的文案：改法是建一条新的、停掉旧的。这里先把这句话说清楚——
           * 真做那两跳要先有"建广告"的形状，不在 WP75 的范围里（57 §5 后置）。
           */
          return {
            ok: false,
            reason: 'not_implemented',
            message:
              'Google Ads 不许就地改一条在跑的广告的文案——正确做法是建一条新广告、再停掉旧的（两跳，两条账本记录）。这两跳还没做（57 §5 后置）；在那之前请在后台手工换，换完这里的数会自己对上。',
          }
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
