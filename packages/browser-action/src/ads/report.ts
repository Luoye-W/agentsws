/**
 * WP315（docs/101 §5.1①，决策 560）：**看数据**的两个动作——
 *
 * - `setup_daily_report`：第一次在用户后台建好「工坊日报」保存报表（写：L3 告知卡）。Google 一层一份
 *   （广告系列 / 广告组 / 广告 / 关键词 / 搜索字词），Meta 一份（一行一条广告，带系列、广告组名字与编号）。
 *   时间范围「最近 7 天（含今天）」、按天拆：平台会回补转化，最近几天每天重导一次覆盖。
 * - `export_daily_report`：每天打开这几份保存报表、点「下载 CSV」（读：每账户每天 ≤ 2）。**不解析页面上的数**。
 *
 * 选择器全在 {@link GOOGLE_REPORT_SELECTORS} / {@link META_REPORT_SELECTORS} 两张表里，照官方帮助页对
 * 「报表编辑器 / 广告报告」的描述按英文界面写，**没有对真站核过**（本单不许打开真实广告后台）；
 * 真站首跑用测试账户逐条对一次，改版只改这两张表。
 *
 * 出处：Google 报表编辑器 https://support.google.com/google-ads/answer/6201327 、
 * 保存与下载 https://support.google.com/google-ads/answer/2404176 ；
 * Meta 广告报告 https://www.facebook.com/business/help/276601619787641 。
 */

import type { ActionAccount, ActionPlan, ActionStep, AdsPlatform } from '../types.js'
import { ADS_ORIGINS, accountQuery, hostsFor } from './actions.js'

/** 看数据的两个动作（与 {@link AdsAction} 并列，进同一条通道）。 */
export type AdsReportAction = { kind: 'setup_daily_report' } | { kind: 'export_daily_report' }

export type AdsReportActionKind = AdsReportAction['kind']

export const ADS_REPORT_ACTION_KINDS: readonly AdsReportActionKind[] = [
  'setup_daily_report',
  'export_daily_report',
]

export function isAdsReportAction(action: { kind: string }): action is AdsReportAction {
  return (ADS_REPORT_ACTION_KINDS as readonly string[]).includes(action.kind)
}

/** 保存报表的层级（Meta 一份就够：一行一条广告，上两层的名字与编号都在行里）。 */
export type ReportLevel = 'campaign' | 'ad_group' | 'ad' | 'keyword' | 'search_term'

export const REPORT_LEVELS: Record<AdsPlatform, readonly ReportLevel[]> = {
  google_ads: ['campaign', 'ad_group', 'ad', 'keyword', 'search_term'],
  meta_ads: ['ad'],
}

const LEVEL_ZH: Record<ReportLevel, string> = {
  campaign: '广告系列',
  ad_group: '广告组',
  ad: '广告',
  keyword: '关键词',
  search_term: '搜索字词',
}

/** 保存报表的名字前缀（用户后台里看得见的就是它）。 */
export const WORKSHOP_REPORT_PREFIX = '工坊日报'

/** 一份保存报表的名字：`工坊日报 · 广告系列`。Meta 那一份就叫 `工坊日报`。 */
export function workshopReportName(platform: AdsPlatform, level: ReportLevel): string {
  return platform === 'meta_ads'
    ? WORKSHOP_REPORT_PREFIX
    : `${WORKSHOP_REPORT_PREFIX} · ${LEVEL_ZH[level]}`
}

/** 报表的时间范围（选项文字）与「含今天」开关。 */
export const REPORT_RANGE_LABEL = 'Last 7 days'

/** Google 预设报表（报表编辑器「预定义报表」里的名字）。 */
const GOOGLE_PRESET: Record<ReportLevel, string> = {
  campaign: 'Campaign',
  ad_group: 'Ad group',
  ad: 'Ad',
  keyword: 'Search keyword',
  search_term: 'Search terms',
}

/** Google 每份报表要补上的列（预设里通常没有编号与转化价值）。 */
export const GOOGLE_REPORT_COLUMNS: Record<ReportLevel, readonly string[]> = {
  campaign: [
    'Campaign ID',
    'Campaign status',
    'Budget',
    'Currency code',
    'Conv. value',
    'Conv. value / cost',
  ],
  ad_group: ['Campaign ID', 'Ad group ID', 'Ad group status', 'Conv. value'],
  ad: ['Campaign ID', 'Ad group ID', 'Ad ID', 'Ad status', 'Conv. value'],
  keyword: [
    'Campaign ID',
    'Ad group ID',
    'Keyword ID',
    'Match type',
    'Keyword status',
    'Conv. value',
  ],
  search_term: ['Campaign ID', 'Ad group ID', 'Match type', 'Keyword', 'Conv. value'],
}

/** Meta 那一份的拆分维度与指标。 */
export const META_REPORT_BREAKDOWNS: readonly string[] = [
  'Campaign name',
  'Campaign ID',
  'Ad set name',
  'Ad set ID',
  'Ad name',
  'Ad ID',
  'Day',
]
export const META_REPORT_METRICS: readonly string[] = [
  'Amount spent',
  'Impressions',
  'Link clicks',
  'Purchases',
  'Purchases conversion value',
  'Purchase ROAS (return on ad spend)',
]

export const GOOGLE_REPORT_SELECTORS = {
  /** 报表编辑器首页：「预定义报表」菜单。 */
  predefined: 'material-button >> text=Predefined reports (Dimensions)',
  preset: (level: ReportLevel) => `[role="menuitem"] >> text=${GOOGLE_PRESET[level]}`,
  table: '[data-report="table"]',
  columns: '[aria-label="Columns"]',
  columnSearch: '[role="dialog"] input[aria-label="Search columns"]',
  columnOption: (name: string) => `[role="option"] >> text=${name}`,
  columnsApply: '[role="dialog"] material-button >> text=Apply',
  segment: '[aria-label="Segment"]',
  segmentDay: '[role="menuitem"] >> text=Day',
  dateRange: '[aria-label="Date range"]',
  dateOption: `[role="menuitem"] >> text=${REPORT_RANGE_LABEL}`,
  includeToday: '[role="checkbox"][aria-label="Include today"]',
  saveAs: 'material-button >> text=Save as',
  nameInput: '[role="dialog"] input[aria-label="Report name"]',
  saveConfirm: '[role="dialog"] material-button >> text=Save',
  /** 报表编辑器首页那一份保存报表的链接（按名字认，名字是我们起的）。 */
  savedLink: (name: string) => `a >> text=${name}`,
  downloadMenu: '[aria-label="Download"]',
  downloadCsv: '[role="menuitem"] >> text=.csv',
} as const

export const META_REPORT_SELECTORS = {
  createReport: '[role="button"] >> text=Create report',
  pivot: '[role="menuitem"] >> text=Pivot table',
  editor: '[data-report="editor"]',
  breakdowns: '[aria-label="Breakdowns"]',
  metrics: '[aria-label="Metrics"]',
  pickerSearch: '[role="dialog"] input[type="search"]',
  pickerOption: (name: string) => `[role="option"] >> text=${name}`,
  pickerDone: '[role="dialog"] [role="button"] >> text=Done',
  dateRange: '[aria-label="Date range"]',
  dateOption: `[role="menuitem"] >> text=${REPORT_RANGE_LABEL}`,
  includeToday: '[role="checkbox"][aria-label="Include today"]',
  dateUpdate: '[role="button"] >> text=Update',
  saveAs: '[role="button"] >> text=Save as',
  nameInput: '[role="dialog"] input[name="report_name"]',
  saveConfirm: '[role="dialog"] [role="button"] >> text=Save',
  savedLink: (name: string) => `a >> text=${name}`,
  exportButton: '[role="button"] >> text=Export',
  exportCsv: '[role="menuitem"] >> text=.csv',
} as const

const G = GOOGLE_REPORT_SELECTORS
const M = META_REPORT_SELECTORS

/** 一张白名单（步骤表里出现的点击 / 填写 / 下载，按动作种类收集；与步骤分开写、对不上测试会喊）。 */
interface Collected {
  click: string[]
  fill: string[]
  values: string[]
  download: string[]
}
const uniq = (xs: string[]): string[] => [...new Set(xs)]

function plan(
  platform: AdsPlatform,
  kind: AdsReportActionKind,
  steps: ActionStep[],
  allow: Collected,
  origin: string,
  verify: ActionPlan['verify'],
): ActionPlan {
  return {
    kind,
    platform,
    pace: kind === 'export_daily_report' ? 'read' : 'write',
    steps,
    allow: {
      hosts: hostsFor(platform, origin),
      click: uniq(allow.click),
      fill: uniq(allow.fill),
      values: uniq(allow.values),
      download: uniq(allow.download),
    },
    verify,
    zones: [],
    needs_sheet: false,
  }
}

/** 一份 Google 保存报表的建立步骤。 */
function googleSetupSteps(list: string, level: ReportLevel, c: Collected): ActionStep[] {
  const name = workshopReportName('google_ads', level)
  const steps: ActionStep[] = [
    { op: 'goto', url: list },
    { op: 'click', selector: G.predefined },
    { op: 'click', selector: G.preset(level) },
    { op: 'wait', selector: G.table },
    { op: 'click', selector: G.columns },
  ]
  for (const col of GOOGLE_REPORT_COLUMNS[level]) {
    steps.push({ op: 'fill', selector: G.columnSearch, value: col })
    steps.push({ op: 'click', selector: G.columnOption(col) })
    c.values.push(col)
    c.click.push(G.columnOption(col))
  }
  steps.push(
    { op: 'click', selector: G.columnsApply },
    { op: 'click', selector: G.segment },
    { op: 'click', selector: G.segmentDay },
    { op: 'click', selector: G.dateRange },
    { op: 'click', selector: G.dateOption },
    { op: 'click', selector: G.includeToday },
    { op: 'click', selector: G.saveAs },
    { op: 'fill', selector: G.nameInput, value: name },
    { op: 'click', selector: G.saveConfirm },
    { op: 'wait', selector: G.table },
  )
  c.click.push(
    G.predefined,
    G.preset(level),
    G.columns,
    G.columnsApply,
    G.segment,
    G.segmentDay,
    G.dateRange,
    G.dateOption,
    G.includeToday,
    G.saveAs,
    G.saveConfirm,
  )
  c.fill.push(G.columnSearch, G.nameInput)
  c.values.push(name)
  return steps
}

const empty = (): Collected => ({ click: [], fill: [], values: [], download: [] })

/** Meta 那一份的建立步骤（拆分维度、指标、时间、另存为）。 */
function metaSetupSteps(manage: string, c: Collected): ActionStep[] {
  const name = workshopReportName('meta_ads', 'ad')
  const steps: ActionStep[] = [
    { op: 'goto', url: manage },
    { op: 'click', selector: M.createReport },
    { op: 'click', selector: M.pivot },
    { op: 'wait', selector: M.editor },
  ]
  for (const [menu, names] of [
    [M.breakdowns, META_REPORT_BREAKDOWNS],
    [M.metrics, META_REPORT_METRICS],
  ] as const) {
    steps.push({ op: 'click', selector: menu })
    c.click.push(menu)
    for (const n of names) {
      steps.push({ op: 'fill', selector: M.pickerSearch, value: n })
      steps.push({ op: 'click', selector: M.pickerOption(n) })
      c.values.push(n)
      c.click.push(M.pickerOption(n))
    }
    steps.push({ op: 'click', selector: M.pickerDone })
  }
  steps.push(
    { op: 'click', selector: M.dateRange },
    { op: 'click', selector: M.dateOption },
    { op: 'click', selector: M.includeToday },
    { op: 'click', selector: M.dateUpdate },
    { op: 'click', selector: M.saveAs },
    { op: 'fill', selector: M.nameInput, value: name },
    { op: 'click', selector: M.saveConfirm },
    { op: 'wait', selector: M.editor },
  )
  c.click.push(
    M.createReport,
    M.pivot,
    M.pickerDone,
    M.dateRange,
    M.dateOption,
    M.includeToday,
    M.dateUpdate,
    M.saveAs,
    M.saveConfirm,
  )
  c.fill.push(M.pickerSearch, M.nameInput)
  c.values.push(name)
  return steps
}

/** 看数据的计划（本机服务进队前调；`origin` 测试指向本地假后台）。 */
export function adsReportPlan(
  account: ActionAccount,
  action: AdsReportAction,
  origin?: string,
): ActionPlan {
  if (account.platform === 'reddit') throw new Error('Reddit 不是广告后台，没有「工坊日报」。')
  const q = accountQuery(account)
  const c = empty()
  if (account.platform === 'google_ads') {
    const o = origin ?? ADS_ORIGINS.google_ads
    const list = `${o}/aw/reporting/reporteditor?${q}`
    const levels = REPORT_LEVELS.google_ads
    if (action.kind === 'setup_daily_report') {
      const steps = levels.flatMap((level) => googleSetupSteps(list, level, c))
      const last = workshopReportName('google_ads', levels[levels.length - 1] as ReportLevel)
      return plan('google_ads', action.kind, steps, c, o, {
        op: 'present',
        url: list,
        selector: G.savedLink(last),
      })
    }
    const steps: ActionStep[] = levels.flatMap((level) => {
      const link = G.savedLink(workshopReportName('google_ads', level))
      c.click.push(link, G.downloadMenu)
      c.download.push(G.downloadCsv)
      return [
        { op: 'goto', url: list },
        { op: 'click', selector: link },
        { op: 'wait', selector: G.table },
        { op: 'click', selector: G.downloadMenu },
        { op: 'download', selector: G.downloadCsv, tag: 'report' },
      ] as ActionStep[]
    })
    return plan('google_ads', action.kind, steps, c, o, { op: 'none' })
  }
  const o = origin ?? ADS_ORIGINS.meta_ads
  const manage = `${o}/adsmanager/reporting/manage?${q}`
  const name = workshopReportName('meta_ads', 'ad')
  if (action.kind === 'setup_daily_report')
    return plan('meta_ads', action.kind, metaSetupSteps(manage, c), c, o, {
      op: 'present',
      url: manage,
      selector: M.savedLink(name),
    })
  c.click.push(M.savedLink(name), M.exportButton)
  c.download.push(M.exportCsv)
  return plan(
    'meta_ads',
    action.kind,
    [
      { op: 'goto', url: manage },
      { op: 'click', selector: M.savedLink(name) },
      { op: 'wait', selector: M.editor },
      { op: 'click', selector: M.exportButton },
      { op: 'download', selector: M.exportCsv, tag: 'report' },
    ],
    c,
    o,
    { op: 'none' },
  )
}

/** 横条 / 工作台上的一句话。 */
export function adsReportActionTitle(action: AdsReportAction): string {
  return action.kind === 'setup_daily_report' ? '建「工坊日报」保存报表' : '导出「工坊日报」'
}
