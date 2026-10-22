/**
 * WP429：站内通知（顶栏铃铛）与「设置 → 通知」按类别的开关。
 *
 * - `GET  /v1/notifications?view=unread|all&limit=`：本人在这个品牌里的通知（新的在前；没读的紧急档最上）+ 未读数；
 *   WP466：回之前先把本人现在挂着的系统卡（原首页告警区，`WorkstationPort.systemCards`）对进铃铛；
 * - `POST /v1/notifications/read`：把这几条标成已读（`{ ids }`）；
 * - `POST /v1/notifications/read-all`：全部已读；
 * - `GET  /v1/settings/notifications` / `PUT`：每类「站内 / 系统」两个开关。
 *
 * 都是本人自己的东西：谁都只看得到、改得了自己那一份。
 */
import {
  type MaybePromise,
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
  type NotificationList,
  type NotificationPrefs,
  type PersonId,
  type WorkspaceId,
} from '@agentsws/contracts'
import type { DeckCard } from '@agentsws/deck'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

const READ = { domain: 'approval', op: 'read', range: 'own', sensitivity: 'internal' } as const

const TAG = 'notifications'

export interface NotificationActor {
  workspace_id: WorkspaceId
  person_id: PersonId
}

export interface NotificationsPort {
  list(
    actor: NotificationActor,
    query: { view: 'unread' | 'all'; limit: number },
  ): MaybePromise<NotificationList>
  markRead(actor: NotificationActor, ids: readonly string[]): MaybePromise<{ unread: number }>
  markAllRead(actor: NotificationActor): MaybePromise<{ unread: number }>
  prefs(actor: NotificationActor): MaybePromise<NotificationPrefs>
  setPrefs(
    actor: NotificationActor,
    patch: Partial<Record<NotificationCategory, { inbox?: boolean; system?: boolean }>>,
  ): MaybePromise<NotificationPrefs>
  /**
   * WP466：本人现在挂着的系统卡（`system_alert`，原首页告警区）对进铃铛——新的进来、没了的收成已读。
   * 不给 = 这个宿主不同步（铃铛里只有别的几类）。
   */
  syncAlerts?(actor: NotificationActor, alerts: readonly DeckCard[]): MaybePromise<void>
}

/**
 * WP466：铃铛来问之前先对一遍系统卡。**永不抛**：系统卡取不到就照旧回已有的通知，铃铛不能因此空掉。
 */
async function syncSystemAlerts(
  deps: GatewayDeps,
  port: NotificationsPort,
  actor: NotificationActor,
): Promise<void> {
  if (port.syncAlerts === undefined || deps.workstation === undefined) return
  try {
    const system = await deps.workstation.systemCards(actor)
    await port.syncAlerts(actor, system.alerts)
  } catch {
    // 取不到就这一次不对，下一次再来
  }
}

const ReadBody = z.object({ ids: z.array(z.string().min(1).max(200)).max(500) })

const Channel = z.object({ inbox: z.boolean().optional(), system: z.boolean().optional() })
const PrefsBody = z.object(
  Object.fromEntries(NOTIFICATION_CATEGORIES.map((c) => [c, Channel.optional()])) as Record<
    NotificationCategory,
    z.ZodOptional<typeof Channel>
  >,
)

function portOf(deps: GatewayDeps): NotificationsPort {
  const p = deps.notifications
  if (p === undefined)
    throw new ApiError(
      'not_implemented',
      '这个服务进程没有装配站内通知（GatewayDeps.notifications）',
    )
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): NotificationActor {
  const p = principalOf(c)
  assignmentOf(c)
  return { workspace_id: p.workspace_id, person_id: p.person_id }
}

export function notificationsRoutes(): Route[] {
  const own = { auth: 'bearer', assignment: true, authz: READ, authzBypass: () => true } as const
  return [
    route(
      {
        method: 'get',
        path: '/v1/notifications',
        operationId: 'listNotifications',
        summary: 'WP429 站内通知：本人在这个品牌里的（新的在前）+ 未读数',
        tag: TAG,
        ...own,
        params: [
          { name: 'view', in: 'query', description: 'unread（默认）| all' },
          {
            name: 'limit',
            in: 'query',
            description: '最多几条（1–200，默认 50）',
            schema: { type: 'integer' },
          },
        ],
        returns: 'NotificationList',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const view = c.req.query('view') === 'all' ? 'all' : 'unread'
        const raw = Number(c.req.query('limit') ?? 50)
        const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.trunc(raw))) : 50
        const port = portOf(deps)
        await syncSystemAlerts(deps, port, actor)
        return ok(c, await port.list(actor, { view, limit }))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/notifications/read',
        operationId: 'markNotificationsRead',
        summary: 'WP429 把这几条通知标成已读',
        tag: TAG,
        ...own,
        body: ReadBody,
        returns: '{ unread }',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, ReadBody)
        return ok(c, await portOf(deps).markRead(actor, input.ids))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/notifications/read-all',
        operationId: 'markAllNotificationsRead',
        summary: 'WP429 全部已读',
        tag: TAG,
        ...own,
        returns: '{ unread }',
      },
      async (c, deps) => ok(c, await portOf(deps).markAllRead(actorOf(c))),
    ),
    route(
      {
        method: 'get',
        path: '/v1/settings/notifications',
        operationId: 'getNotificationPrefs',
        summary: 'WP429 设置 → 通知：每类「站内 / 系统」两个开关',
        tag: 'settings',
        ...own,
        returns: 'NotificationPrefs',
      },
      async (c, deps) => ok(c, await portOf(deps).prefs(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/settings/notifications',
        operationId: 'putNotificationPrefs',
        summary: 'WP429 改通知开关（只改给了的那几格；站内关了系统也跟着关）',
        tag: 'settings',
        ...own,
        body: PrefsBody,
        returns: 'NotificationPrefs',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, PrefsBody)
        const patch: Partial<Record<NotificationCategory, { inbox?: boolean; system?: boolean }>> =
          {}
        for (const cat of NOTIFICATION_CATEGORIES) {
          const v = input[cat]
          if (v === undefined) continue
          patch[cat] = {
            ...(v.inbox === undefined ? {} : { inbox: v.inbox }),
            ...(v.system === undefined ? {} : { system: v.system }),
          }
        }
        return ok(c, await portOf(deps).setPrefs(actor, patch))
      },
    ),
  ]
}
