/**
 * Meta 广告后台（adsmanager.facebook.com）的步骤表。
 *
 * 选择器全在 {@link META_ADS_SELECTORS} 一张表里：照官方帮助页对「批量导入广告（粘贴文字 / 上传表）
 * → 导入摘要 → 审核并发布」与列表开关的描述整理，**没有对真站核过**，按英文界面写。
 * 真站首跑时用测试账户逐条对一次；改版只改这一张表。
 *
 * 出处：批量导入 https://www.facebook.com/business/help/122918328469908 、
 * 导出报表 https://www.facebook.com/business/help/276601619787641 。
 */

import type { ActionAccount, ActionPlan, ActionStep } from '../types.js'
import {
  ADS_ORIGINS,
  type AdsAction,
  type AdsEntity,
  accountQuery,
  hostsFor,
  paceOf,
  sheetIsText,
} from './actions.js'

const levelPath: Record<AdsEntity['level'], string> = {
  campaign: 'campaigns',
  ad_group: 'adsets',
  ad: 'ads',
}

const levelKey: Record<AdsEntity['level'], string> = {
  campaign: 'selected_campaign_ids',
  ad_group: 'selected_adset_ids',
  ad: 'selected_ad_ids',
}

export const META_ADS_SELECTORS = {
  /** 列表上方「导出与导入」菜单 → 「批量导入广告」。 */
  importMenu: '[role="button"] >> text=Export & import',
  importItem: '[role="menuitem"] >> text=Import ads in bulk',
  pasteTab: '[role="dialog"] [role="tab"] >> text=Paste text',
  pasteBox: '[role="dialog"] textarea',
  uploadFile: '[role="dialog"] input[type="file"]',
  importButton: '[role="dialog"] [role="button"] >> text=Import',
  importSummary: '[data-bulk-import="summary"]',
  importErrors: '[data-bulk-import="summary"] [data-severity="error"]',
  reviewPublish: '[role="button"] >> text=Review and publish',
  publishButton: '[role="dialog"] [role="button"] >> text=Publish',
  publishedNote: '[data-publish="status"]',
  /** 列表（按编号筛出这一条）。 */
  row: (id: string) => `[data-row-id="${id}"]`,
  toggle: (id: string) => `[data-row-id="${id}"] input[role="switch"]`,
  toggleState: (id: string, on: boolean) =>
    `[data-row-id="${id}"] input[role="switch"][aria-checked="${on ? 'true' : 'false'}"]`,
  budgetCell: (id: string) => `[data-row-id="${id}"] [data-column="budget"]`,
  budgetEdit: (id: string) => `[data-row-id="${id}"] [data-column="budget"] [role="button"]`,
  budgetInput: '[role="dialog"] input[name="budget"]',
  budgetSave: '[role="dialog"] [role="button"] >> text=Save',
  /** 「广告报告」里保存的那份报表的导出。 */
  exportButton: '[role="button"] >> text=Export',
  exportCsv: '[role="menuitem"] >> text=.csv',
} as const

const S = META_ADS_SELECTORS

export function metaAdsPlan(
  account: ActionAccount,
  action: AdsAction,
  origin: string = ADS_ORIGINS.meta_ads,
): ActionPlan {
  const q = accountQuery(account)
  const hosts = hostsFor('meta_ads', origin)
  const manage = (level: AdsEntity['level']): string =>
    `${origin}/adsmanager/manage/${levelPath[level]}?${q}`
  const listUrl = (entity: AdsEntity): string =>
    `${manage(entity.level)}&${levelKey[entity.level]}=${encodeURIComponent(entity.id)}`
  const base = { platform: 'meta_ads' as const, pace: paceOf(action.kind), zones: [] }

  switch (action.kind) {
    case 'upload_sheet': {
      const paste = sheetIsText(action.sheet)
      const snapshot = action.snapshot !== false
      const steps: ActionStep[] = [
        { op: 'goto', url: manage('campaign') },
        ...(snapshot
          ? ([
              { op: 'click', selector: S.exportButton },
              { op: 'download', selector: S.exportCsv, tag: 'snapshot' },
            ] as ActionStep[])
          : []),
        { op: 'click', selector: S.importMenu },
        { op: 'click', selector: S.importItem },
        ...(paste
          ? ([
              { op: 'click', selector: S.pasteTab },
              { op: 'paste', selector: S.pasteBox },
            ] as ActionStep[])
          : ([{ op: 'upload', selector: S.uploadFile }] as ActionStep[])),
        { op: 'click', selector: S.importButton },
        { op: 'wait', selector: S.importSummary, timeout_ms: 120_000 },
        { op: 'read', selector: S.importSummary, key: 'preview_summary' },
        { op: 'capture', tag: 'preview' },
        {
          op: 'expect_none',
          selector: S.importErrors,
          why: '平台导入摘要里有阻断错误，不能发布，退回去改',
        },
        { op: 'confirm', prompt: '导入成草稿了，没报错。确认发布？' },
        { op: 'click', selector: S.reviewPublish },
        { op: 'click', selector: S.publishButton },
        { op: 'wait', selector: S.publishedNote, timeout_ms: 120_000 },
        { op: 'capture', tag: 'after' },
      ]
      return {
        ...base,
        kind: 'upload_sheet',
        needs_sheet: true,
        steps,
        allow: {
          hosts,
          click: [
            ...(snapshot ? [S.exportButton] : []),
            S.importMenu,
            S.importItem,
            ...(paste ? [S.pasteTab] : []),
            S.importButton,
            S.reviewPublish,
            S.publishButton,
          ],
          fill: [],
          values: [],
          ...(paste ? { paste: [S.pasteBox] } : { upload: [S.uploadFile] }),
          download: snapshot ? [S.exportCsv] : [],
        },
        verify: { op: 'present', selector: S.publishedNote, text: 'Published' },
      }
    }
    case 'export_report':
      return {
        ...base,
        kind: 'export_report',
        needs_sheet: false,
        steps: [
          { op: 'goto', url: `${origin}/adsmanager/reporting/manage?${q}` },
          { op: 'click', selector: S.exportButton },
          { op: 'download', selector: S.exportCsv, tag: 'report' },
        ],
        allow: { hosts, click: [S.exportButton], fill: [], values: [], download: [S.exportCsv] },
        verify: { op: 'none' },
      }
    case 'pause':
    case 'enable': {
      const id = action.entity.id
      const on = action.kind === 'enable'
      return {
        ...base,
        kind: action.kind,
        needs_sheet: false,
        steps: [
          { op: 'goto', url: listUrl(action.entity) },
          // 开关现在必须是「另一头」：已经是想要的状态就不点（点了反而改回去）
          { op: 'wait', selector: S.toggleState(id, !on) },
          { op: 'capture', tag: 'before' },
          { op: 'click', selector: S.toggle(id) },
          { op: 'capture', tag: 'after' },
        ],
        allow: { hosts, click: [S.toggle(id)], fill: [], values: [] },
        verify: { op: 'present', url: listUrl(action.entity), selector: S.toggleState(id, on) },
      }
    }
    case 'set_budget': {
      const id = action.entity.id
      return {
        ...base,
        kind: 'set_budget',
        needs_sheet: false,
        steps: [
          { op: 'goto', url: listUrl(action.entity) },
          { op: 'wait', selector: S.row(id) },
          { op: 'capture', tag: 'before' },
          { op: 'click', selector: S.budgetEdit(id) },
          { op: 'fill', selector: S.budgetInput, value: action.amount },
          { op: 'click', selector: S.budgetSave },
          { op: 'capture', tag: 'after' },
        ],
        allow: {
          hosts,
          click: [S.budgetEdit(id), S.budgetSave],
          fill: [S.budgetInput],
          values: [action.amount],
        },
        verify: {
          op: 'present',
          url: listUrl(action.entity),
          selector: S.budgetCell(id),
          text: action.amount,
        },
      }
    }
  }
}
