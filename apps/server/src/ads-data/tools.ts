/**
 * WP315：投放岗看数据那三个工具的执行器（名字 / 描述在 `@agentsws/stand-ins` 的 `runtime/ads-data.ts`）。
 *
 * - `query_ads_data`：查已入库的数（`query.ts` 纯函数）+ 今天离总闸还有多少（广告库 `spendToday` + `daySpendGate`）
 *   + 正在跑的广告系列今天的止损判据（`stopLossVerdict`，与止损卡同一个函数）。没数又没连 → 回 `needs_*`，运行时出卡。
 * - `fetch_ads_data_now`：让插件现在导一次（`AdsDataService.fetchNow`）。
 * - `stage_ads_stop_loss`：经广告库那一面的 `pauseCampaign` 提卡（判据成立 L3 自动、不成立转人审）——这里不判、不改后台。
 */
import { daySpendGate, resolveAdsCaps, stopLossVerdict } from '@agentsws/ads-core'
import type { AdsActor, AdsPort } from '@agentsws/api'
import type { AdsCaps, RunRequest } from '@agentsws/contracts'
import {
  FETCH_ADS_DATA_TOOL,
  isAdsDataRole,
  QUERY_ADS_DATA_TOOL,
  STAGE_ADS_STOP_LOSS_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { AdsStore } from '../ads.js'
import { ADS_ACCOUNTS_TARGET } from './accounts.js'
import { type AdsSort, queryAdsRows, resolveAdsWindow } from './query.js'
import type { AdsDataService } from './service.js'
import type { AdsDataPlatform } from './store.js'

export interface AdsDataToolsOptions {
  service(): Promise<AdsDataService | undefined> | AdsDataService | undefined
  ads(): AdsStore
  /** 广告库那一面（提止损卡）。 */
  port(): AdsPort | undefined
  /** 这条分配上的额度（止损线、日花费总闸）；缺的按 57 §6 默认。 */
  caps(assignment_id: string): Partial<AdsCaps>
}

const bare = (name: string): string =>
  name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined
const ok = (data: unknown): ToolExecution => ({ status: 'ok', data })

const EXTENSION_NEED = {
  needs_connection: 'extension',
  connection_name: 'Agents 工坊助手（Chrome 插件，连上广告后台）',
}

function actorOf(req: RunRequest): AdsActor {
  return {
    workspace_id: req.workspace_id,
    person_id: req.actor.person_id,
    assignment_id: req.actor.assignment_id,
    role_id: req.actor.role_id,
  } as AdsActor
}

export function createAdsDataToolExecutor(options: AdsDataToolsOptions): ToolExecutor {
  const query = async (svc: AdsDataService, req: RunRequest, input: Record<string, unknown>) => {
    const today = svc.today()
    const window = resolveAdsWindow(
      {
        ...(str(input.period) === undefined ? {} : { period: str(input.period) as string }),
        ...(str(input.since) === undefined ? {} : { since: str(input.since) as string }),
        ...(str(input.until) === undefined ? {} : { until: str(input.until) as string }),
      },
      today,
    )
    if ('problem' in window) return ok({ ok: false, problems: [window.problem] })
    const wanted = svc.wanted()
    const platform = str(input.platform) as AdsDataPlatform | undefined
    const rows = svc
      .rows({
        since: window.since,
        until: window.until,
        ...(platform === undefined ? {} : { platform }),
      })
      .filter((r) => wanted.includes(r.platform))
    const status = svc.status().filter((s) => platform === undefined || s.platform === platform)
    const caps = resolveAdsCaps(options.caps(req.actor.assignment_id))
    const ads = options.ads()
    const spent = ads.spendToday({ platforms: wanted })
    const gate = daySpendGate({
      spend_by_platform: Object.fromEntries(
        spent.by_platform
          .filter((b) => !spent.missing.includes(b.platform))
          .map((b) => [b.platform, b.spend]),
      ),
      caps,
      expected_platforms: wanted,
    })
    const stop_loss = ads
      .campaigns()
      .filter((c) => wanted.includes(c.platform as AdsDataPlatform) && c.status === 'active')
      .filter((c) => platform === undefined || c.platform === platform)
      .filter((c) => c.metrics?.spend !== undefined && c.metrics.spend > 0)
      .map((c) => {
        const v = stopLossVerdict({
          ...(c.metrics?.roas === undefined ? {} : { roas: c.metrics.roas }),
          ...(c.metrics?.spend === undefined ? {} : { spend: c.metrics.spend }),
          ...(c.daily_budget === undefined ? {} : { daily_budget: c.daily_budget }),
          caps,
        })
        return {
          campaign_id: c.id,
          platform: c.platform,
          name: c.name,
          outcome: v.outcome,
          reason: v.reason,
        }
      })
      .sort((a, b) => (a.outcome === b.outcome ? 0 : a.outcome === 'trigger' ? -1 : 1))
      .slice(0, 20)
    const result = queryAdsRows(rows, {
      ...(str(input.level) === undefined ? {} : { level: str(input.level) as never }),
      ...(str(input.sort) === undefined ? {} : { sort: str(input.sort) as AdsSort }),
      ...(input.order === 'asc' ? { order: 'asc' as const } : {}),
      ...(typeof input.limit === 'number' ? { limit: input.limit } : {}),
      ...(input.status === 'enabled' || input.status === 'paused' ? { status: input.status } : {}),
      ...(str(input.search) === undefined ? {} : { search: str(input.search) as string }),
    })
    const data: Record<string, unknown> = {
      ok: true,
      today,
      window,
      freshness: status,
      ...result,
      spend_gate: {
        ...gate,
        missing: spent.missing,
        ...(spent.currency === undefined ? {} : { currency: spent.currency }),
      },
      stop_loss,
    }
    // 一行数都没有：缺账户 → 配置卡；插件没连、邮箱也没有 → 连接卡（运行时据此出卡，补完接着做）
    if (rows.length === 0 && status.every((s) => s.last_import === undefined)) {
      if (status.every((s) => s.account === undefined))
        return ok({ ...data, needs_setup: ADS_ACCOUNTS_TARGET })
      if (status.every((s) => s.plugin === 'not_connected'))
        return ok({ ...data, ...EXTENSION_NEED })
    }
    return ok(data)
  }

  return async (call) => {
    const name = bare(call.name)
    const req = call.request
    if (!isAdsDataRole(req.actor.role_id))
      return { status: 'blocked', reason: '广告数据只给投放岗位那几条职责。' }
    const svc = await options.service()
    if (svc === undefined)
      return { status: 'error', reason: '这台机器没装看数据（托管实例没有插件）。' }
    if (name === QUERY_ADS_DATA_TOOL) return query(svc, req, call.input)
    if (name === FETCH_ADS_DATA_TOOL) {
      const p = str(call.input.platform) as AdsDataPlatform | undefined
      const outcomes = await svc.fetchNow(p === undefined ? {} : { platforms: [p] })
      const needs = outcomes.find((o) => !o.ok && 'needs' in o)
      const extra =
        needs !== undefined && 'needs' in needs
          ? needs.needs === 'ads.accounts'
            ? { needs_setup: ADS_ACCOUNTS_TARGET }
            : EXTENSION_NEED
          : {}
      return ok({ ok: outcomes.some((o) => o.ok), outcomes, ...extra })
    }
    if (name === STAGE_ADS_STOP_LOSS_TOOL) {
      const id = str(call.input.campaign_id)
      const port = options.port()
      if (id === undefined) return ok({ ok: false, problems: ['要给 campaign_id。'] })
      if (port === undefined) return { status: 'error', reason: '这台机器没装广告库那一面。' }
      if (options.ads().campaign(id) === undefined)
        return ok({
          ok: false,
          problems: [`没有这条广告系列：${id}（用 query_ads_data 回的 stop_loss[].campaign_id）`],
        })
      const note = str(call.input.note)
      const staged = await port.pauseCampaign(actorOf(req), id, {
        reason: 'stop_loss',
        ...(note === undefined ? {} : { note }),
      })
      return ok({ ok: staged.staged, ...staged })
    }
    return { status: 'error', reason: `unsupported_tool：这个进程没接「${call.name}」。` }
  }
}
