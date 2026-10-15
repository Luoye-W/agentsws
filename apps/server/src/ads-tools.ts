/**
 * WP316：Run 里的**改广告工具**真接上（两个名字在 `@agentsws/stand-ins` 的 `runtime/ads.ts`）。
 *
 * 落到 `AdsPort` 上——与 `/v1/ads/changes`、`/v1/ads/ledger` 同一份装配。这里一行业务逻辑都没有：
 * 1. **判职责**：只有 Google / Meta 两条投放职责能用；
 * 2. **只出卡**：提一批 = 出上传表卡或逐条的小改动卡；
 * 3. 插件没连这家后台：卡照出，数据里带 `needs_connection: 'extension'`——运行就地出连接卡（WP324）。
 */
import type { AdsActor, AdsPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { RunRequest, WorkspaceId } from '@agentsws/contracts'
import type { ToolExecution, ToolExecutor } from '@agentsws/stand-ins'
import { ADS_LEDGER_TOOL, ADS_TOOL_NAMES, isAdsWiredRole } from '@agentsws/stand-ins'

export function createAdsToolExecutor(options: {
  workspace_id: WorkspaceId
  /** 懒取：投放那一摊比运行时晚建出来。 */
  port(): AdsPort | undefined
}): ToolExecutor {
  const actorOf = (request: RunRequest): AdsActor => ({
    workspace_id: options.workspace_id,
    person_id: request.actor.person_id,
    assignment_id: request.actor.assignment_id,
    role_id: request.actor.role_id,
  })
  return async ({ name, input, request }): Promise<ToolExecution> => {
    const bare = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name
    if (!ADS_TOOL_NAMES.includes(bare))
      return { status: 'error', reason: `not_an_ads_tool:${bare}` }
    if (!isAdsWiredRole(request.actor.role_id))
      return {
        status: 'blocked',
        reason: `${request.actor.role_id} 用不了改广告的工具（第一期只接 Google / Meta 两家后台）。`,
      }
    const port = options.port()
    if (port === undefined) return { status: 'error', reason: '这个进程没装投放那一摊。' }
    const actor = actorOf(request)
    try {
      if (bare === ADS_LEDGER_TOOL) {
        if (port.ledger === undefined)
          return { status: 'error', reason: '这台机器没装插件执行那一半，没有广告改动记录。' }
        const rows = (await port.ledger(actor)).rows.slice(0, 20).map((r) => ({
          change_id: r.change_id,
          title: r.title,
          state: r.state,
          ...(r.sentence === undefined ? {} : { sentence: r.sentence }),
          ...(r.platform_errors === undefined ? {} : { platform_errors: r.platform_errors }),
          ...(r.readback === undefined ? {} : { readback: r.readback.sentence }),
          ...(r.evidence_missing.length === 0 ? {} : { evidence_missing: r.evidence_missing }),
          undo: r.undo.available ? '能撤' : (r.undo.why ?? '撤不了'),
        }))
        return { status: 'ok', data: { rows } }
      }
      if (port.stageChanges === undefined)
        return {
          status: 'error',
          reason: '这台机器没装插件执行那一半，改广告只能出卡给人自己去后台改。',
        }
      const account_id = typeof input.account_id === 'string' ? input.account_id : ''
      const ops = Array.isArray(input.ops) ? input.ops : []
      if (account_id === '' || ops.length === 0)
        return { status: 'error', reason: '要给 account_id 和至少一条 ops。' }
      const out = await port.stageChanges(actor, {
        account_id,
        ops,
        ...(typeof input.reason === 'string' && input.reason !== ''
          ? { reason: input.reason }
          : {}),
      })
      const staged = out.views.filter((v) => v.staged)
      return {
        status: 'ok',
        data: {
          route: out.route,
          reason: out.reason,
          cards: staged.map((v) => ({ approval_item_id: v.approval_item_id, level: v.level })),
          ...(out.problems === undefined ? {} : { problems: out.problems }),
          ...(out.message === undefined ? {} : { message: out.message }),
          blocked: out.views.filter((v) => !v.staged).map((v) => v.message ?? ''),
          // WP324：插件没连 → 运行就地出连接卡
          ...(out.needs_connection === undefined
            ? {}
            : {
                needs_connection: out.needs_connection,
                connection_name: 'Agents 工坊助手（浏览器插件）',
              }),
          // 运行时靠这两样把「出了卡」翻成时间线上看得见的一条
          kind: 'ads_change',
          ...(staged[0]?.change_id === undefined ? {} : { change_id: staged[0].change_id }),
        },
      }
    } catch (e) {
      if (e instanceof ApiError)
        return { status: e.code === 'forbidden' ? 'blocked' : 'error', reason: e.message }
      return { status: 'error', reason: e instanceof Error ? e.message : String(e) }
    }
  }
}
