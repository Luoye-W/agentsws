/**
 * 广告后台的动作（docs/101 §4.3 / §5.1）：**只做人本来也会做的那几个**。
 *
 * - `upload_sheet`：上传官方格式的表 → 平台预览 → 截图 → 平台没报阻断错误 → 人再确认一次 → 应用 / 发布 → 截图；
 * - `export_report`：点「导出 / 下载」拿文件（看数据只用导出按钮，不解析页面上的数：决策 560）；
 * - `pause` / `enable`：在列表里点状态开关（决策 552：表单只点暂停 / 启用、改预算两类）；
 * - `set_budget`：在预算格里填卡上那个数。
 *
 * 别的按钮全不在白名单里。三条以上的改动一律走上传表——那一条在审批那一侧判（WP314 / WP316）。
 */

import type { ActionAccount, ActionPlan, AdsPlatform, SheetRef } from '../types.js'

/** 实体层级（暂停 / 启用 / 改预算按编号筛出这一条）。Meta 的「广告组」叫 ad set。 */
export type AdsEntityLevel = 'campaign' | 'ad_group' | 'ad'

export interface AdsEntity {
  level: AdsEntityLevel
  id: string
  /** 卡上给人看的名字（横条上显示，不参与定位）。 */
  name?: string
}

export type AdsAction =
  | {
      kind: 'upload_sheet'
      sheet: SheetRef
      /** 上传之前先导出一份改前表（撤销底稿）。默认要。 */
      snapshot?: boolean
    }
  | { kind: 'export_report' }
  | { kind: 'pause'; entity: AdsEntity }
  | { kind: 'enable'; entity: AdsEntity }
  | {
      kind: 'set_budget'
      entity: AdsEntity
      /** 卡上批的那个数（账户币种，两位小数以内）。插件只填这个字符串。 */
      amount: string
    }

export type AdsActionKind = AdsAction['kind']

/** 两家后台的地址（测试指向本地假页面）。 */
export interface AdsOrigins {
  google_ads: string
  meta_ads: string
}

export const ADS_ORIGINS: AdsOrigins = {
  google_ads: 'https://ads.google.com',
  meta_ads: 'https://adsmanager.facebook.com',
}

/** 插件要申请的可选权限（连接时才申请：决策 551 / docs/101 §1.4）。 */
export const ADS_HOST_PERMISSIONS: Record<AdsPlatform, string[]> = {
  google_ads: ['https://ads.google.com/*'],
  meta_ads: ['https://adsmanager.facebook.com/*', 'https://business.facebook.com/*'],
}

/** 自动化页面能开的站。 */
export const ADS_HOSTS: Record<AdsPlatform, string[]> = {
  google_ads: ['ads.google.com'],
  meta_ads: ['adsmanager.facebook.com', 'business.facebook.com'],
}

/** 一个动作是读还是写（读：每账户每天 ≤ 2；写：≤ 20）。 */
export function paceOf(kind: AdsActionKind): 'read' | 'write' {
  return kind === 'export_report' ? 'read' : 'write'
}

/** 网址里带的账户参数。 */
export function accountQuery(account: ActionAccount): string {
  if (account.platform === 'meta_ads')
    return `act=${encodeURIComponent(account.id.replace(/^act_/iu, ''))}`
  const parts: string[] = []
  if (account.ocid !== undefined && account.ocid !== '')
    parts.push(`ocid=${encodeURIComponent(account.ocid)}`)
  parts.push(`__c=${encodeURIComponent(account.id.replace(/[\s-]/gu, ''))}`)
  return parts.join('&')
}

/** 拼计划时共用的：白名单站点（真站 + 给了假站点时那一个）。 */
export function hostsFor(platform: AdsPlatform, origin: string): string[] {
  const hosts = [...ADS_HOSTS[platform]]
  try {
    const h = new URL(origin).hostname
    if (!hosts.includes(h)) hosts.push(h)
  } catch {}
  return hosts
}

/** 上传表是文字（CSV / TSV / 纯文本）就粘贴，是 Excel 就传文件。 */
export function sheetIsText(sheet: SheetRef): boolean {
  return /^text\//iu.test(sheet.mime) || /\.(csv|tsv|txt)$/iu.test(sheet.name)
}

export type { ActionPlan }
