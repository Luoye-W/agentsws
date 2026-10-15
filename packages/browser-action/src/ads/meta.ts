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
  /** WP316：发布后当场核「已发布」（读回那一版用）。 */
  publishedDone: '[data-publish="status"] >> text=Published',
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
      const readback = action.readback === true
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
        { op: 'wait', selector: readback ? S.publishedDone : S.publishedNote, timeout_ms: 120_000 },
        { op: 'capture', tag: 'after' },
        // WP316：读回——回到列表再导出一份，本机拿它和上传表逐行比对
        ...(readback
          ? ([
              { op: 'goto', url: manage('campaign') },
              { op: 'click', selector: S.exportButton },
              { op: 'download', selector: S.exportCsv, tag: 'result' },
            ] as ActionStep[])
          : []),
      ]
      return {
        ...base,
        kind: 'upload_sheet',
        needs_sheet: true,
        steps,
        allow: {
          hosts,
          click: [
            ...(snapshot || readback ? [S.exportButton] : []),
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
          download: snapshot || readback ? [S.exportCsv] : [],
        },
        verify: readback
          ? { op: 'none' }
          : { op: 'present', selector: S.publishedNote, text: 'Published' },
      }
    }
    case 'export_snapshot':
      return {
        ...base,
        kind: 'export_snapshot',
        needs_sheet: false,
        steps: [
          { op: 'goto', url: manage('campaign') },
          { op: 'click', selector: S.exportButton },
          { op: 'download', selector: S.exportCsv, tag: 'snapshot' },
        ],
        allow: { hosts, click: [S.exportButton], fill: [], values: [], download: [S.exportCsv] },
        verify: { op: 'none' },
      }
    case 'undo_upload':
      // Meta 没有「撤销这次导入」的按钮（docs/101 §7 第 3 条）：撤销走改前表反向导入（另一张上传表）
      throw new Error('Meta 没有一键撤销导入；用改前表反向导入（另一张上传表）。')
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
      // WP316（决策 600 C）：止损——截不到图也先停，停前停后各导出一份作证
      const stopLoss = action.kind === 'pause' && action.stop_loss === true
      const exportAs = (tag: 'snapshot' | 'result'): ActionStep[] => [
        { op: 'goto', url: manage('campaign') },
        { op: 'click', selector: S.exportButton },
        { op: 'download', selector: S.exportCsv, tag },
      ]
      return {
        ...base,
        kind: action.kind,
        needs_sheet: false,
        steps: [
          ...(stopLoss ? exportAs('snapshot') : []),
          { op: 'goto', url: listUrl(action.entity) },
          // 开关现在必须是「另一头」：已经是想要的状态就不点（点了反而改回去）
          { op: 'wait', selector: S.toggleState(id, !on) },
          { op: 'capture', tag: 'before', ...(stopLoss ? { optional: true } : {}) },
          { op: 'click', selector: S.toggle(id) },
          { op: 'capture', tag: 'after', ...(stopLoss ? { optional: true } : {}) },
          ...(stopLoss ? exportAs('result') : []),
        ],
        allow: {
          hosts,
          click: [...(stopLoss ? [S.exportButton] : []), S.toggle(id)],
          fill: [],
          values: [],
          ...(stopLoss ? { download: [S.exportCsv] } : {}),
        },
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
