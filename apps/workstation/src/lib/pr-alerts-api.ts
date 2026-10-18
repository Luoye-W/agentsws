/**
 * WP387：你的浏览器替你建 / 导入 Google 提醒（`/v1/pr/watch/alerts*`）。单独一个文件（`pr-watch-api.ts` 是 WP386 的）。
 * 带「信息监控」（`pr.monitoring`）那条职责的分配。
 */
import type { GoogleAlertsPanelView } from '@agentsws/contracts'
import { api } from './api'

export const PR_ALERTS_KEY = ['pr-alerts'] as const

export const getPrAlerts = (assignment: string): Promise<GoogleAlertsPanelView> =>
  api('/v1/pr/watch/alerts', { assignment })

/** 出一张「要在你的 Google 账号里建 N 条提醒」的卡（同意了你的浏览器才去建）。 */
export const buildPrAlerts = (
  assignment: string,
): Promise<{ ok: true; approval_id: string; count: number } | { ok: false; reason: string }> =>
  api('/v1/pr/watch/alerts/build', { method: 'POST', assignment })

/** 让你的浏览器只读一遍已有的提醒。 */
export const readPrAlerts = (
  assignment: string,
): Promise<{ ok: true; matter_id: string } | { ok: false; reason: string }> =>
  api('/v1/pr/watch/alerts/read', { method: 'POST', assignment })
