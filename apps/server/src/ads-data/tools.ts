/**
 * WP315：投放岗看数据那三个工具的执行器（名字 / 描述在 `@agentsws/stand-ins` 的 `runtime/ads-data.ts`）。
 *
 * - `query_ads_data`：查已入库的数（`query.ts` 纯函数）+ 今天离总闸还有多少（广告库 `spendToday` + `daySpendGate`）
 *   + 正在跑的广告系列今天的止损判据（`stopLossVerdict`，与止损卡同一个函数）。没数又没连 → 回 `needs_*`，运行时出卡。
 * - `fetch_ads_data_now`：让插件现在导一次（`AdsDataService.fetchNow`）。
 * - `stage_ads_stop_loss`：经广告库那一面的 `pauseCampaign` 提卡（判据成立 L3 自动、不成立转人审）——这里不判、不改后台。
 */
import { daySpendGate, isExportPlatform, resolveAdsCaps, stopLossVerdict } from '@agentsws/ads-core'
import type { AdsActor, AdsPort } from '@agentsws/api'
import type { AdsCaps, RunRequest } from '@agentsws/contracts'
import { adsPlatformOfRole } from '@agentsws/contracts'
import {
  adsDataToolsFor,
  FETCH_ADS_DATA_TOOL,
  isAdsDataRole,
  QUERY_ADS_DATA_TOOL,
  READ_ADS_EXPORT_TOOL,
  RUN_ADS_AUDIT_TOOL,
  STAGE_ADS_STOP_LOSS_TOOL,
  type ToolExecution,
  type ToolExecutor,
} from '@agentsws/stand-ins'
import type { AdsStore } from '../ads.js'
import { ADS_ACCOUNTS_TARGET } from './accounts.js'
import { exportPlatformLabel } from './export-ingest.js'
import { exportAudit, exportCampaigns, exportOverview } from './export-view.js'
import { type AdsSort, queryAdsRows, resolveAdsWindow } from './query.js'
import type { AdsDataService } from './service.js'
import { type AdsSkillToolOptions, runAdsSkillTool } from './skill-tools.js'
import { dayBefore, yesterdayBasis } from './stop-loss.js'
import type { AdsDataPlatform } from './store.js'

export interface AdsDataToolsOptions {
  service(): Promise<AdsDataService | undefined> | AdsDataService | undefined
  ads(): AdsStore
  /** 广告库那一面（提止损卡）。 */
  port(): AdsPort | undefined
  /** 这条分配上的额度（止损线、日花费总闸）；缺的按 57 §6 默认。 */
  caps(assignment_id: string): Partial<AdsCaps>
  /**
   * 出「插件连上广告后台」那张连接卡（WP324 `askConnect`，`kind: ads_backend`、接法是插件配对）。
   * 只认「配对过」会把卡判成已连上——要的是插件里连上了这家后台（勾过风险告知），所以单独一种。
   * 不给就退回工具回 `needs_connection: 'extension'`（运行时出插件配对卡）。回出没出卡。
   */
  askConnect?(req: RunRequest, why: string): Promise<boolean>
  /** WP447：品牌有没有 App（Apple 那条体检用；品牌档案还没有这一格时不给）。 */
  hasApp?(): boolean | undefined
  /** WP452：体检 / 保本线 / 落地页一致性 / 实验那几个工具要的宿主能力。 */
  skills?: Omit<AdsSkillToolOptions, 'hasApp' | 'now'> & { now?(): string }
}

/** 连接卡上这一样的 kind（服务端复查认它：插件里连上了担着的那几家后台没有）。 */
export const ADS_BACKEND_NEED_KIND = 'ads_backend'

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
  /** 缺插件：能直接出卡就出（卡上连好了接着做），不能就让运行时出插件配对卡。 */
  const needPlugin = async (req: RunRequest): Promise<Record<string, unknown>> => {
    const asked = await options
      .askConnect?.(
        req,
        '每天去你的广告后台导出报表要用插件：在插件设置里点「连接」，勾上风险告知。',
      )
      .catch(() => false)
    return asked === true
      ? { connection_card: true, message: '已出一张连接卡：在卡上连好插件，我接着做。' }
      : EXTENSION_NEED
  }
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
      .filter((r) => wanted.includes(r.platform as AdsDataPlatform))
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
    const yDay = dayBefore(today)
    const yRows = svc.rows({ since: yDay, until: yDay })
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
        // WP420（自查 A4）：今天不成立再按昨天整天判（和止损卡、导数后自动判同一套）
        const basis = v.outcome === 'trigger' ? undefined : yesterdayBasis(yRows, today, c.id)
        const y =
          basis === undefined
            ? undefined
            : stopLossVerdict({
                ...(basis.roas === undefined ? {} : { roas: basis.roas }),
                spend: basis.spend,
                ...(c.daily_budget === undefined ? {} : { daily_budget: c.daily_budget }),
                caps,
              })
        const pick = y?.outcome === 'trigger' ? y : v
        return {
          campaign_id: c.id,
          platform: c.platform,
          name: c.name,
          outcome: pick.outcome,
          basis: pick === v ? 'today' : 'yesterday',
          reason: pick === v ? v.reason : pick.reason.replace('今天花了', '昨天整天花了'),
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
        return ok({ ...data, ...(await needPlugin(req)) })
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
    // WP447：只读的新平台只认两个只读工具（模型照着别的职责的样子调止损也调不动）
    if (!adsDataToolsFor(req.actor.role_id).includes(name))
      return { status: 'blocked', reason: '这条职责这一期只读，没有这个工具。' }
    const exportPlatform = adsPlatformOfRole(req.actor.role_id)?.id
    // WP452：体检十家都给；保本线 / 落地页一致性 / 实验（职责给不给看 `adsDataToolsFor`）
    if (exportPlatform !== undefined) {
      const hasApp = options.hasApp?.()
      const skill = await runAdsSkillTool(name, call.input, req, svc, exportPlatform, {
        ...(options.skills ?? {}),
        ...(hasApp === undefined ? {} : { hasApp: () => hasApp }),
        now: options.skills?.now ?? (() => new Date().toISOString()),
      })
      if (skill !== undefined) return skill
    }
    if (name === READ_ADS_EXPORT_TOOL || name === RUN_ADS_AUDIT_TOOL) {
      if (exportPlatform === undefined || !isExportPlatform(exportPlatform))
        return { status: 'blocked', reason: '这两个工具只给只读的新平台那几条职责。' }
      const label = exportPlatformLabel(exportPlatform)
      if (name === RUN_ADS_AUDIT_TOOL) {
        const hasApp = options.hasApp?.()
        return ok({
          ok: true,
          ...exportAudit(svc, exportPlatform, hasApp === undefined ? {} : { has_app: hasApp }),
        })
      }
      const overview = exportOverview(svc, exportPlatform)
      if (overview.length === 0)
        return ok({
          ok: false,
          platform: exportPlatform,
          message: `还没有${label}的报表：在它后台点「导出」，把文件拖进这条对话就行（帮助里「怎么导出报表给我」有每家几步）。`,
        })
      const limit = Math.min(Math.max(Math.floor(Number(call.input.limit ?? 20)) || 20, 1), 100)
      return ok({
        ok: true,
        platform: exportPlatform,
        overview,
        campaigns: exportCampaigns(svc, exportPlatform, limit),
        latest_import: svc.imports({ platform: exportPlatform, limit: 1 })[0],
      })
    }
    if (name === QUERY_ADS_DATA_TOOL) return query(svc, req, call.input)
    if (name === FETCH_ADS_DATA_TOOL) {
      const p = str(call.input.platform) as AdsDataPlatform | undefined
      const outcomes = await svc.fetchNow(p === undefined ? {} : { platforms: [p] })
      const needs = outcomes.find((o) => !o.ok && 'needs' in o)
      const extra =
        needs !== undefined && 'needs' in needs
          ? needs.needs === 'ads.accounts'
            ? { needs_setup: ADS_ACCOUNTS_TARGET }
            : await needPlugin(req)
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
