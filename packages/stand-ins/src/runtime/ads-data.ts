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
 *
 * WP447（docs/109 §6.2）：六个新平台（Microsoft / Pinterest / Reddit / LinkedIn / Snapchat / Apple）第一期只读，
 * 数从用户拖进来的报表来——它们只有下面两个**只读**工具，上面三个一个都不给（没有插件导出、没有止损）：
 *
 * | 工具 | 干什么 |
 * |---|---|
 * | `read_ads_export` | 看最近一份报表：账户概况（花费、转化、ROAS、币种、时区、日期范围）与广告系列表 |
 * | `run_ads_audit` | 按这家的体检骨架跑一遍：拿报表能判的照数判，后台那几项标「未知」并说去哪看 |
 *
 * WP452（docs/109 §5.2 #12–15）：体检十家都给（老四家读插件每天导的同一张表）；另加三个：
 *
 * | 工具 | 谁有 | 干什么 |
 * |---|---|---|
 * | `calc_break_even` | 十家 | 客单价、毛利 / 货本、运费、手续费、退货率 → 保本 ROAS / 保本 CPA（给了想留的利润再出目标）；缺的照实列 |
 * | `check_ad_landing` | 十家 | 广告里的价格 / 折扣 / 包邮 / 卖点对落地页（不开 JS 与渲染后两份）；对不上的开事项给网站运营或自己 |
 * | `design_ads_experiment` | 老四家 | 假设、拆分单位、样本量与时长（规则算）、护栏、什么算赢；记进实验记忆 |
 * | `read_ads_experiment` | 老四家 | 跑完读结果：出一张「保留 / 停 / 再测」卡（只记结论，不改广告） |
 */
import type { ToolDef } from '@agentsws/contracts'
import { ADS_READ_ONLY_PLATFORM_IDS, adsPlatformOfRole } from '@agentsws/contracts'

export const QUERY_ADS_DATA_TOOL = 'query_ads_data'
export const FETCH_ADS_DATA_TOOL = 'fetch_ads_data_now'
export const STAGE_ADS_STOP_LOSS_TOOL = 'stage_ads_stop_loss'
/** WP447：六个新平台的两个只读工具。 */
export const READ_ADS_EXPORT_TOOL = 'read_ads_export'
export const RUN_ADS_AUDIT_TOOL = 'run_ads_audit'
/** WP452：投放第二批技能的四个。 */
export const CALC_BREAK_EVEN_TOOL = 'calc_break_even'
export const CHECK_AD_LANDING_TOOL = 'check_ad_landing'
export const DESIGN_ADS_EXPERIMENT_TOOL = 'design_ads_experiment'
export const READ_ADS_EXPERIMENT_TOOL = 'read_ads_experiment'

/**
 * Google / Meta 那几条（插件导出、查数、止损）用的（排好序：`tools.allow` 要字节稳定）。
 * WP452：加体检、保本线、落地页一致性、实验设计与读结果。
 */
export const ADS_WIRED_DATA_TOOL_NAMES: readonly string[] = [
  CALC_BREAK_EVEN_TOOL,
  CHECK_AD_LANDING_TOOL,
  DESIGN_ADS_EXPERIMENT_TOOL,
  FETCH_ADS_DATA_TOOL,
  QUERY_ADS_DATA_TOOL,
  READ_ADS_EXPERIMENT_TOOL,
  RUN_ADS_AUDIT_TOOL,
  STAGE_ADS_STOP_LOSS_TOOL,
].sort()

/** WP447：六个新平台（只读）用的。WP452：加保本线与落地页一致性（都不碰账户）。 */
export const ADS_EXPORT_TOOL_NAMES: readonly string[] = [
  CALC_BREAK_EVEN_TOOL,
  CHECK_AD_LANDING_TOOL,
  READ_ADS_EXPORT_TOOL,
  RUN_ADS_AUDIT_TOOL,
].sort()

/** 这一族全部工具名（执行器分派、工具登记用；**哪条职责给哪几个看 `adsDataToolsFor`**）。 */
export const ADS_DATA_TOOL_NAMES: readonly string[] = [
  ...new Set([...ADS_WIRED_DATA_TOOL_NAMES, ...ADS_EXPORT_TOOL_NAMES]),
].sort()

/** 投放那几条职责（`ads.meta` / `ads.google` …）才有。 */
export function isAdsDataRole(role_id: string): boolean {
  return role_id.startsWith('ads.')
}

/** WP447：这条是不是只读的新平台职责（`ads.microsoft` …）。 */
export function isAdsExportRole(role_id: string): boolean {
  const p = adsPlatformOfRole(role_id)
  return p !== undefined && ADS_READ_ONLY_PLATFORM_IDS.includes(p.id)
}

/**
 * 这条职责给哪几个：只读的新平台只给两个只读工具（**不给止损**）；其余投放职责照旧三个；不是投放职责一个都不给。
 */
export function adsDataToolsFor(role_id: string): readonly string[] {
  if (!isAdsDataRole(role_id)) return []
  return isAdsExportRole(role_id) ? ADS_EXPORT_TOOL_NAMES : ADS_WIRED_DATA_TOOL_NAMES
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

/** WP447：六个新平台的两个只读工具（平台不用给：这条职责是哪一家就看哪一家）。 */
export const ADS_EXPORT_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: READ_ADS_EXPORT_TOOL,
    description:
      '看这家平台最近一份报表（用户从平台后台导出、拖进对话的那份）：账户概况（花费、展示、点击、转化、转化金额、ROAS）、' +
      '报表上写的币种 / 时区 / 日期范围，以及按花费排好的广告系列表。只读；数字照抄，没写的说没写，没数的格子是没数不是 0。' +
      '一份都没有时回怎么导出的提示——照着告诉用户，别编数。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '广告系列列几条（默认 20，最多 100）' },
      },
    },
  },
  {
    name: RUN_ADS_AUDIT_TOOL,
    description:
      '按这家平台的体检骨架跑一遍账户体检：拿报表能判的（数新不新、写没写币种时区、花了钱有没有转化、转化带没带金额、' +
      '哪几条花了钱一单没有）照数判；要去后台看的那几项（像素 / 转化 API、审核、预算受限…）一律「未知」并说去哪看——' +
      '没证据就是未知，不要替它下结论。Apple 搜索广告只推 App：品牌没 App 时整份就一句「这条只适合推 App」。只读。',
    input_schema: { type: 'object', properties: {} },
  },
]

/** WP452：投放第二批技能的四个工具（数全由规则算，模型只负责问齐、照抄）。 */
export const ADS_SKILL_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: CALC_BREAK_EVEN_TOOL,
    description:
      '算保本 ROAS / 保本 CPA（给了想留的利润再算目标 CPA / 目标 ROAS）。客单价、毛利率（或一单货本）必填；运费、支付手续费、' +
      '退货率没给的会列进 missing——照实问用户，**不要自己编一个行业平均**。毛利率没给时读毛利率事实卡（读到会说从哪来）。' +
      '结果会放进岗位右栏「保本线」那一块。算式原样给用户看。',
    input_schema: {
      type: 'object',
      properties: {
        aov: { type: 'number', description: '客单价（一单的售价）' },
        gross_margin_pct: { type: 'number', description: '毛利率 %（和 cogs 二选一）' },
        cogs: { type: 'number', description: '一单的货本（采购 + 头程等）' },
        shipping: { type: 'number', description: '一单你出的运费' },
        payment_fee_pct: { type: 'number', description: '支付手续费 %' },
        payment_fee_fixed: { type: 'number', description: '每单固定手续费' },
        return_rate_pct: { type: 'number', description: '退货率 %' },
        target_profit_pct: { type: 'number', description: '想留的利润（占客单价 %）' },
        currency: { type: 'string', description: '币种（ISO，如 USD）' },
      },
    },
  },
  {
    name: CHECK_AD_LANDING_TOOL,
    description:
      '核对广告和落地页说的是不是一回事：从广告文案里按规则抽价格、折扣、包邮，再加你从文案里挑出的卖点短句（selling_points），' +
      '去落地页上找（不开 JS 的原始页与开 JS 渲染后的各一份）。对不上的：页上写着另一个价 / 折扣 → 改广告（给你自己开一件事）；' +
      '页上没写或只靠 JS 才出来 → 改页面（给网站运营开一件事）。open_matters=false 只看不开事项。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '落地页网址（广告的最终到达网址）' },
        ad_label: { type: 'string', description: '这条广告叫什么（事项标题用）' },
        texts: {
          type: 'array',
          items: { type: 'string' },
          description: '广告文案（标题、描述、主文案，一段一条）',
        },
        selling_points: {
          type: 'array',
          items: { type: 'string' },
          description: '文案里的卖点短句（原话，几个词，最多 5 条）',
        },
        open_matters: { type: 'boolean', description: '对不上的要不要开事项（默认要）' },
      },
      required: ['url', 'texts'],
    },
  },
  {
    name: DESIGN_ADS_EXPERIMENT_TOOL,
    description:
      '设计一次广告实验：假设、改了哪一样（一次只变一样）、拆分单位、主指标、样本量与要跑几天（规则算）、护栏、什么结果算赢。' +
      '基准比例和每天的量不给就从已入库的近 30 天数里算（回的 baseline_from / daily_from 说从哪来）；最小提升（mde_rel_pct）和护栏的数' +
      '要用户定——你先给一个建议让他确认，别替他定。缺的回在 missing 里，照实问。记进实验记忆（回 experiment_id）。',
    input_schema: {
      type: 'object',
      properties: {
        hypothesis: { type: 'string', description: '假设：想验证什么' },
        change: { type: 'string', description: '改了哪一样（只换图 / 只换标题 / 只换主文案…）' },
        metric: {
          type: 'string',
          enum: ['ctr', 'cvr', 'conv_per_impression'],
          description: '主指标：点击率 / 点击后的转化率 / 按展示的转化率',
        },
        unit: {
          type: 'string',
          enum: ['impression', 'click', 'user', 'geo', 'campaign'],
          description: '按什么拆（平台的 A/B 工具一般按人）',
        },
        baseline_rate: { type: 'number', description: '基准比例（0–1；不给从近 30 天的数算）' },
        mde_rel_pct: { type: 'number', description: '想看出的最小相对提升 %（用户确认过的）' },
        daily_units: { type: 'number', description: '每天能进实验的量（不给从近 30 天的数算）' },
        arms: { type: 'number', description: '几版（含基准，默认 2）' },
        alpha: { type: 'number', description: '显著性（默认 0.05）' },
        power: { type: 'number', description: '把握（默认 0.8）' },
        min_days: { type: 'number', description: '至少跑几天（默认 7）' },
        guardrails: {
          type: 'array',
          description: '护栏：这几样变差不许超过多少（用户确认过的）',
          items: {
            type: 'object',
            properties: {
              metric: { type: 'string' },
              higher_is_better: { type: 'boolean' },
              max_worse_pct: { type: 'number' },
            },
            required: ['metric', 'higher_is_better', 'max_worse_pct'],
          },
        },
        campaign: { type: 'string', description: '算基准时只看这条广告系列（名字里含这几个字）' },
        record: { type: 'boolean', description: '记进实验记忆（默认记）' },
      },
      required: ['hypothesis', 'metric'],
    },
  },
  {
    name: READ_ADS_EXPERIMENT_TOOL,
    description:
      '实验跑完读结果：给每一版的单位数与成功数（第一版是基准；护栏那几样的值也给），按设计时的样本量、显著性、护栏判' +
      '「保留 / 停 / 再测」，出一张卡请用户选（卡上标建议）。选了只把结论写回实验记忆，不改任何广告——要停 / 换照旧走改广告那张卡。' +
      '没跑满会判「再测」：别劝用户提前收。',
    input_schema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string', description: 'design_ads_experiment 回的 experiment_id' },
        arms: {
          type: 'array',
          description: '每一版的结果（第一版是基准）',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              units: { type: 'number' },
              successes: { type: 'number' },
              guardrails: { type: 'object', description: '护栏那几样的值，按护栏名' },
            },
            required: ['id', 'units', 'successes'],
          },
        },
      },
      required: ['experiment_id', 'arms'],
    },
  },
]

export const ADS_DATA_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  [...ADS_DATA_TOOL_DEFS, ...ADS_EXPORT_TOOL_DEFS, ...ADS_SKILL_TOOL_DEFS].map((d) => [d.name, d]),
)
