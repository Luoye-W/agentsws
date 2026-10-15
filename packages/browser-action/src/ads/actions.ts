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
      /**
       * WP316（docs/101 §5.1② 第 7 步）：提交之后再导出一份（`result`），本机拿它和上传表逐行比对。
       * 开了它，平台「已应用 / 已发布」那一格在提交后当场核（等不到就停），步骤表末尾不再回页面读回。
       */
      readback?: boolean
    }
  | { kind: 'export_report' }
  /** WP316：只导出一份改前表（`snapshot`）——Meta 改已有要它（决策 612），读操作。 */
  | { kind: 'export_snapshot' }
  | {
      kind: 'pause'
      entity: AdsEntity
      /**
       * WP316（决策 600 C）：止损（L3 自动）。前后截图截不到也先停住；
       * 停之前、停之后各导出一份（`snapshot` / `result`）作证。
       */
      stop_loss?: boolean
    }
  | { kind: 'enable'; entity: AdsEntity }
  /**
   * WP316（docs/101 §2.1）：Google「所有批量操作」里对某次上传点「撤销」（只能撤一次）。
   * Meta 没有这一按钮，撤销用改前表反向导入（另一张上传表）。
   */
  | { kind: 'undo_upload'; upload_name: string }
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
  return kind === 'export_report' || kind === 'export_snapshot' ? 'read' : 'write'
}

/** 撤销那一行按上传的文件名找（只认文件名里常见的字，别的拒：它要拼进选择器）。 */
export function safeUploadName(name: string): string {
  if (!/^[\w.\- ]{1,200}$/u.test(name)) throw new Error(`上传文件名里有不认的字：${name}`)
  return name
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
