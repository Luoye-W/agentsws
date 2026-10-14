/**
 * Google 广告后台（ads.google.com）的步骤表。
 *
 * 选择器全在 {@link GOOGLE_ADS_SELECTORS} 一张表里：照官方帮助页对「批量上传 → 预览 → 应用」、
 * 「广告系列列表」的描述整理，**没有对真站核过**（本单纪律不许打开真实广告后台），按英文界面写。
 * 真站首跑时用测试账户逐条对一次（报告里列为要定的事）；改版只改这一张表。
 *
 * 出处：批量上传 https://support.google.com/google-ads/answer/10702433 、
 * 报表下载 https://support.google.com/google-ads/answer/2404176 。
 */

import type { ActionAccount, ActionPlan, ActionStep } from '../types.js'
import {
  ADS_ORIGINS,
  type AdsAction,
  type AdsEntity,
  accountQuery,
  hostsFor,
  paceOf,
} from './actions.js'

const levelPath: Record<AdsEntity['level'], string> = {
  campaign: 'campaigns',
  ad_group: 'adgroups',
  ad: 'ads',
}

const levelKey: Record<AdsEntity['level'], string> = {
  campaign: 'campaignId',
  ad_group: 'adGroupId',
  ad: 'adId',
}

export const GOOGLE_ADS_SELECTORS = {
  /** 工具 → 批量操作 → 上传。 */
  uploadNew: '[aria-label="Upload"]',
  uploadFile: 'input[type="file"]',
  previewButton: 'material-button >> text=Preview',
  previewReady: '[data-bulk-upload="preview"]',
  previewErrors: '[data-bulk-upload="preview"] [data-severity="error"]',
  previewSummary: '[data-bulk-upload="preview"] [data-bulk-upload="summary"]',
  applyButton: 'material-button >> text=Apply',
  appliedStatus: '[data-bulk-upload="status"]',
  /** 列表（按编号筛出这一条）。 */
  row: (id: string) => `[data-row-id="${id}"]`,
  statusMenu: (id: string) => `[data-row-id="${id}"] [data-column="status"] [role="button"]`,
  statusOption: (label: 'Enabled' | 'Paused') => `[role="menuitem"] >> text=${label}`,
  statusCell: (id: string) => `[data-row-id="${id}"] [data-column="status"]`,
  budgetEdit: (id: string) =>
    `[data-row-id="${id}"] [data-column="budget"] [aria-label="Edit budget"]`,
  budgetInput: '[role="dialog"] input[aria-label="Budget"]',
  budgetSave: '[role="dialog"] material-button >> text=Save',
  budgetCell: (id: string) => `[data-row-id="${id}"] [data-column="budget"]`,
  /** 统计表右上角的下载。 */
  downloadMenu: '[aria-label="Download"]',
  downloadCsv: '[role="menuitem"] >> text=.csv',
} as const

const S = GOOGLE_ADS_SELECTORS

export function googleAdsPlan(
  account: ActionAccount,
  action: AdsAction,
  origin: string = ADS_ORIGINS.google_ads,
): ActionPlan {
  const q = accountQuery(account)
  const hosts = hostsFor('google_ads', origin)
  const listUrl = (entity: AdsEntity): string =>
    `${origin}/aw/${levelPath[entity.level]}?${q}&${levelKey[entity.level]}=${encodeURIComponent(entity.id)}`
  const base = { platform: 'google_ads' as const, pace: paceOf(action.kind), zones: [] }

  switch (action.kind) {
    case 'upload_sheet': {
      const uploads = `${origin}/aw/bulk/uploads?${q}`
      const snapshot = action.snapshot !== false
      const steps: ActionStep[] = [
        ...(snapshot
          ? ([
              { op: 'goto', url: `${origin}/aw/campaigns?${q}` },
              { op: 'click', selector: S.downloadMenu },
              { op: 'download', selector: S.downloadCsv, tag: 'snapshot' },
            ] as ActionStep[])
          : []),
        { op: 'goto', url: uploads },
        { op: 'click', selector: S.uploadNew },
        { op: 'upload', selector: S.uploadFile },
        { op: 'click', selector: S.previewButton },
        { op: 'wait', selector: S.previewReady, timeout_ms: 120_000 },
        { op: 'read', selector: S.previewSummary, key: 'preview_summary' },
        { op: 'capture', tag: 'preview' },
        {
          op: 'expect_none',
          selector: S.previewErrors,
          why: '平台预览报了错误，不能提交，退回去改',
        },
        { op: 'confirm', prompt: '平台预览没报错。确认提交？' },
        { op: 'click', selector: S.applyButton },
        { op: 'wait', selector: S.appliedStatus, timeout_ms: 120_000 },
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
            ...(snapshot ? [S.downloadMenu] : []),
            S.uploadNew,
            S.previewButton,
            S.applyButton,
          ],
          fill: [],
          values: [],
          upload: [S.uploadFile],
          download: snapshot ? [S.downloadCsv] : [],
        },
        verify: { op: 'present', selector: S.appliedStatus, text: 'Applied' },
      }
    }
    case 'export_report':
      return {
        ...base,
        kind: 'export_report',
        needs_sheet: false,
        steps: [
          { op: 'goto', url: `${origin}/aw/reporting/reporteditor?${q}` },
          { op: 'click', selector: S.downloadMenu },
          { op: 'download', selector: S.downloadCsv, tag: 'report' },
        ],
        allow: { hosts, click: [S.downloadMenu], fill: [], values: [], download: [S.downloadCsv] },
        verify: { op: 'none' },
      }
    case 'pause':
    case 'enable': {
      const id = action.entity.id
      const want = action.kind === 'pause' ? 'Paused' : 'Enabled'
      return {
        ...base,
        kind: action.kind,
        needs_sheet: false,
        steps: [
          { op: 'goto', url: listUrl(action.entity) },
          { op: 'wait', selector: S.row(id) },
          { op: 'capture', tag: 'before' },
          { op: 'click', selector: S.statusMenu(id) },
          { op: 'click', selector: S.statusOption(want) },
          { op: 'capture', tag: 'after' },
        ],
        allow: { hosts, click: [S.statusMenu(id), S.statusOption(want)], fill: [], values: [] },
        verify: {
          op: 'present',
          url: listUrl(action.entity),
          selector: S.statusCell(id),
          text: want,
        },
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
