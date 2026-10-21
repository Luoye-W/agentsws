/**
 * WP447（docs/109 §6.2 / S7）：六个新平台的**体检骨架**——查什么、凭什么。数据，不是逻辑。
 *
 * 只写「查哪一项、证据在哪」，**不写带日期的官方事实**（门槛数字、某天起的新规矩）：正式清单带官方出处
 * 与核对日期，由 109H 放进内容仓的官方知识包、每周更新；这里是开源基础版冻结时的那份骨架。
 *
 * 两种证据：
 * - `export`：拿拖进来的导出报表就能判（`rule` 是 `audit.ts` 里的判法）；
 * - `backend`：要人去后台那一页看一眼（`where`）——我们没有那一页的证据，一律标「未知」，不猜。
 *
 * 后台页的名字照 10-21 读的官方帮助页（出处见 `columns.ts` 文件头与报告），英文界面名原样留着方便对照。
 */

import type { ExportPlatform } from './columns.js'

type Text = { zh: string; en: string }

/** 拿导出报表就能判的几种判法（`audit.ts` 实现）。 */
export type ExportAuditRule =
  /** 数新不新（最新一天离今天多久）。 */
  | 'fresh_data'
  /** 卡上写没写币种。 */
  | 'currency_stated'
  /** 卡上写没写时区。 */
  | 'timezone_stated'
  /** 花了钱有没有转化（没有多半是追踪没装好）。 */
  | 'conversions_tracked'
  /** 有转化有没有回传金额（没有就算不出 ROAS）。 */
  | 'conversion_value'
  /** 哪几条花了钱一单没有。 */
  | 'zero_conversion_spenders'

export interface AuditCheckSpec {
  id: string
  title: Text
  evidence: { kind: 'export'; rule: ExportAuditRule } | { kind: 'backend'; where: Text }
}

/** 六家都查的、拿报表就能判的那几项。 */
export const COMMON_EXPORT_CHECKS: readonly AuditCheckSpec[] = [
  {
    id: 'fresh_data',
    title: { zh: '数是不是新的', en: 'Data is recent' },
    evidence: { kind: 'export', rule: 'fresh_data' },
  },
  {
    id: 'currency_stated',
    title: { zh: '报表写了币种', en: 'Currency is stated' },
    evidence: { kind: 'export', rule: 'currency_stated' },
  },
  {
    id: 'timezone_stated',
    title: { zh: '报表写了时区', en: 'Time zone is stated' },
    evidence: { kind: 'export', rule: 'timezone_stated' },
  },
  {
    id: 'conversions_tracked',
    title: { zh: '花了钱有转化记录', en: 'Spend has conversions recorded' },
    evidence: { kind: 'export', rule: 'conversions_tracked' },
  },
  {
    id: 'conversion_value',
    title: { zh: '转化带了金额', en: 'Conversions carry a value' },
    evidence: { kind: 'export', rule: 'conversion_value' },
  },
  {
    id: 'zero_conversion_spenders',
    title: { zh: '花了钱一单没有的系列', en: 'Campaigns spending with no conversions' },
    evidence: { kind: 'export', rule: 'zero_conversion_spenders' },
  },
]

const b = (
  id: string,
  zh: string,
  en: string,
  whereZh: string,
  whereEn: string,
): AuditCheckSpec => ({
  id,
  title: { zh, en },
  evidence: { kind: 'backend', where: { zh: whereZh, en: whereEn } },
})

/** 每家要去后台看一眼的那几项。 */
export const BACKEND_CHECKS: Readonly<Record<ExportPlatform, readonly AuditCheckSpec[]>> = {
  microsoft: [
    b(
      'uet_tag',
      'UET 标记在跑',
      'UET tag is active',
      '后台「转化跟踪」页，看 UET 标记的状态',
      'Conversion tracking → UET tag status',
    ),
    b(
      'goal_tracking',
      '转化目标在记录转化',
      'Conversion goals are recording',
      '「转化目标」那一栏的跟踪状态',
      'Conversion goals → Tracking status',
    ),
    b(
      'msclkid',
      '自动标记（MSCLKID）开着',
      'Auto-tagging (MSCLKID) is on',
      '账户设置里的自动标记',
      'Account settings → Auto-tagging of MSCLKID',
    ),
    b(
      'budget_limited',
      '没有系列受预算限制',
      'No campaign is limited by budget',
      '广告系列表的「投放」列',
      'Campaigns → Delivery column',
    ),
    b(
      'disapproved',
      '没有广告 / 关键词被拒',
      'No ads or keywords disapproved',
      '广告、关键词表的「投放」列',
      'Ads / Keywords → Delivery column',
    ),
  ],
  pinterest: [
    b(
      'pinterest_tag',
      'Pinterest 标签装好了',
      'Pinterest Tag is installed',
      '商务后台「转化」页',
      'Business → Conversions',
    ),
    b(
      'conversions_api',
      '转化 API 接上了',
      'Conversions API is set up',
      '同一页的转化 API 设置',
      'Conversions → Conversions API',
    ),
    b(
      'catalog',
      '商品目录没有报错',
      'Catalog has no issues',
      '「目录与商品组」→「诊断」',
      'Catalogs → Diagnostics',
    ),
    b(
      'ad_review',
      '没有广告被拒或受限',
      'No ads disapproved or limited',
      '报表与违规记录页',
      'Reports and violations',
    ),
    b(
      'undelivered',
      '没有系列一直没投出去',
      'No campaign stuck undelivered',
      '广告管理关掉「隐藏未投放」',
      'Ads Manager → Hide undelivered toggle',
    ),
  ],
  reddit: [
    b(
      'pixel_capi',
      'Reddit 像素或转化 API 在收事件',
      'Reddit Pixel / Conversions API receiving events',
      '「事件管理器」',
      'Events Manager',
    ),
    b(
      'key_events',
      '购买 / 线索这些关键事件收到了',
      'Key events (Purchase / Lead) are received',
      '事件管理器的事件列表',
      'Events Manager → events',
    ),
    b(
      'dedup',
      '像素与 API 两边发的去重了',
      'Pixel and API events are deduplicated',
      '事件管理器（看转化 ID）',
      'Events Manager → conversion ID',
    ),
    b(
      'diagnostics',
      '事件诊断没有报错',
      'Event diagnostics are clean',
      '事件管理器「诊断」页',
      'Events Manager → Diagnostics',
    ),
    b('ad_review', '没有广告没通过审核', 'No ads rejected', '广告列表的状态', 'Ads tab → status'),
  ],
  linkedin: [
    b(
      'insight_tag',
      'Insight Tag 在跑',
      'Insight Tag is active',
      '「分析」→「转化跟踪」→「数据源」',
      'Analyze → Conversion tracking → Data sources',
    ),
    b(
      'conversions_api',
      '转化 API 数据源在跑',
      'Conversions API source is active',
      '同一页的数据源状态',
      'Data sources → status',
    ),
    b(
      'audience_size',
      '受众不太小',
      'Audiences are large enough',
      '受众页看规模',
      'Audiences → size',
    ),
    b(
      'utc_days',
      '按天对账时记得报表是 UTC',
      'Daily reconciliation accounts for UTC',
      '报表按 UTC 出，和店铺的日子差几个小时',
      'Reports run in UTC',
    ),
  ],
  snapchat: [
    b(
      'snap_pixel',
      'Snap Pixel 在响',
      'Snap Pixel is firing',
      '「事件管理器」的流量视图',
      'Events Manager → traffic',
    ),
    b(
      'conversions_api',
      '转化 API 接上了',
      'Conversions API is set up',
      '事件管理器里的转化 API',
      'Events Manager → Conversions API',
    ),
    b(
      'not_delivering',
      '没有广告组「不投放」',
      'No ad set is not delivering',
      '广告管理的「投放状态」',
      'Manage Ads → Delivery Status',
    ),
    b(
      'rejected',
      '没有广告被拒',
      'No ads rejected',
      '广告管理（悬停状态看原因）',
      'Manage Ads → status',
    ),
    b(
      'attribution_window',
      '几份导出的归因口径一致',
      'Exports use the same attribution setting',
      '导出时的归因窗口设置',
      'Attribution window in report settings',
    ),
  ],
  apple: [
    b(
      'adservices',
      'App 里接了 AdServices 归因',
      'AdServices attribution is integrated in the app',
      'App 开发那一侧（不在广告后台）',
      'In the app (AdServices framework)',
    ),
    b(
      'adattributionkit',
      'AdAttributionKit / SKAdNetwork 有回传',
      'AdAttributionKit / SKAdNetwork postbacks arrive',
      'App 开发那一侧',
      'In the app',
    ),
    b(
      'demographic_targeting',
      '定向年龄 / 性别的广告组知道拿不到归因',
      'Age / gender targeting is known to drop attribution',
      '广告组的受众设置',
      'Ad group → Audience',
    ),
    b(
      'on_hold',
      '没有系列「暂停中（On Hold）」',
      'No campaign On Hold',
      '广告系列表的状态列',
      'Campaigns → Status',
    ),
    b(
      'impression_share',
      '看过展示份额和排名',
      'Impression share and rank reviewed',
      '「洞察」→ 高级报表',
      'Insights → Advanced reports',
    ),
  ],
}

/** 一家的整份骨架（拿报表能判的在前，要去后台看的在后）。 */
export function auditSkeleton(platform: ExportPlatform): readonly AuditCheckSpec[] {
  return [...COMMON_EXPORT_CHECKS, ...BACKEND_CHECKS[platform]]
}
