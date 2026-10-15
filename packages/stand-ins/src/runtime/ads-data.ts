/**
 * WP315（docs/101 §5.1①）：投放岗**看数据**的三个工具——给模型看的名字、描述、参数。真正干活在服务端
 * （`apps/server/src/ads-data/tools.ts`）。只给投放那几条职责（`ads.*`）。
 *
 * 日报不是固定功能：到点那次运行（官方「自动化任务」，提示词就是用户的日报要求）里用这几个取数，
 * 用 WP331 的 `publish_report` 发布；哪条算差、怎么写、分几节，照用户的要求来。
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `query_ads_data` | 查已入库的广告数据：时间窗、平台、层级（广告系列 / 广告组 / 广告 / 关键词 / 搜索字词）、排序；合计、按天、今天离总闸还有多少、止损判据 |
 * | `fetch_ads_data_now` | 让插件现在去后台导一次（每个账户每天最多读 2 次）；等一会儿，导进来了就回 |
 * | `stage_ads_stop_loss` | 按止损规矩提一张「暂停」卡（判据成立才自动停，不成立转人审） |
 */
import type { ToolDef } from '@agentsws/contracts'

export const QUERY_ADS_DATA_TOOL = 'query_ads_data'
export const FETCH_ADS_DATA_TOOL = 'fetch_ads_data_now'
export const STAGE_ADS_STOP_LOSS_TOOL = 'stage_ads_stop_loss'

/** 三个工具（排好序：`tools.allow` 要字节稳定）。 */
export const ADS_DATA_TOOL_NAMES: readonly string[] = [
  FETCH_ADS_DATA_TOOL,
  QUERY_ADS_DATA_TOOL,
  STAGE_ADS_STOP_LOSS_TOOL,
].sort()

/** 投放那几条职责（`ads.meta` / `ads.google` …）才有。 */
export function isAdsDataRole(role_id: string): boolean {
  return role_id.startsWith('ads.')
}

const PLATFORM = {
  type: 'string',
  enum: ['google', 'meta'],
  description: '哪一家（不给 = 这个岗位担着的全部）',
}

export const ADS_DATA_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: QUERY_ADS_DATA_TOOL,
    description:
      '查已入库的广告数据（插件每天从后台导出的报表，或邮箱里平台发来的定时报表）。按时间窗、平台、层级筛，' +
      '回：每家合计（花费、展示、点击、转化、转化价值、ROAS）、按天合计、排好序的对象表、数据新到哪天、' +
      '今天花了多少 / 离日花费总闸还有多少（spend_gate）、正在跑的广告系列今天的止损判据（stop_loss：trigger 越线 / hold 没越线 / unknown 缺数）。' +
      '只读；数字是导出文件里的，写报告时照抄，不要估；没数的格子是没数，不是 0。币种各家各算，不跨家相加。',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'last_7_days', 'last_14_days', 'last_30_days', 'this_month'],
          description: '时间窗（不给 = 最近 7 天含今天；给了 since / until 以它们为准）',
        },
        since: { type: 'string', description: '起：本地日期 YYYY-MM-DD' },
        until: { type: 'string', description: '止：本地日期 YYYY-MM-DD（含那一天）' },
        platform: PLATFORM,
        level: {
          type: 'string',
          enum: ['campaign', 'ad_group', 'ad', 'keyword', 'search_term'],
          description: '列哪一层（默认广告系列；关键词 / 搜索字词只有 Google）',
        },
        sort: {
          type: 'string',
          enum: ['cost', 'roas', 'conversions', 'conversion_value', 'clicks', 'impressions'],
          description: '按什么排（默认花费）',
        },
        order: { type: 'string', enum: ['desc', 'asc'], description: '默认从大到小' },
        status: {
          type: 'string',
          enum: ['enabled', 'paused', 'any'],
          description: '只要在跑 / 暂停的',
        },
        search: { type: 'string', description: '名字里含这几个字' },
        limit: { type: 'number', description: '列几条（默认 20，最多 200）' },
      },
    },
  },
  {
    name: FETCH_ADS_DATA_TOOL,
    description:
      '让插件现在去广告后台把「工坊日报」导一次（只点导出按钮；电脑和 Chrome 开着才做得成），等一两分钟，导进来了就回。' +
      '每个账户每天最多读 2 次，早上那次已经导过就别再要。没连插件 / 没设账户会照实说，并出一张卡请人就地连好。',
    input_schema: { type: 'object', properties: { platform: PLATFORM } },
  },
  {
    name: STAGE_ADS_STOP_LOSS_TOOL,
    description:
      '按止损规矩提一张「暂停这条广告系列」的卡（campaign_id 用 query_ads_data 回的 stop_loss[].campaign_id）。' +
      '判据真的成立（ROAS 低于线、今天花费超过日预算的比例）才自动停、事后出「已止损」卡；不成立就转人审。不会直接改后台。',
    input_schema: {
      type: 'object',
      properties: {
        campaign_id: { type: 'string', description: 'query_ads_data 回的 stop_loss[].campaign_id' },
        note: { type: 'string', description: '一句为什么（上卡面）' },
      },
      required: ['campaign_id'],
    },
  },
]

export const ADS_DATA_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  ADS_DATA_TOOL_DEFS.map((d) => [d.name, d]),
)
