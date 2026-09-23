/**
 * 运营后台「客服增值服务」那一块的 Workers 实现（WP128）。
 *
 * 一个组织可能有好几个品牌工作区，每个工作区一个 `ChatRelayDO`（订阅在那里）和
 * 一个 `HostedInstanceDO`（容器在那里）。这一口按工作区挨个问两个对象，拼成一份摘要。
 * 工作区清单从账号库的工作区关联里来（`store.links(org)`）。
 *
 * 只读：后台这一块不提供「替用户开 / 停容器」的按钮——起停只跟着订阅走，
 * 人为插手会让「为什么这个月扣了钱容器却停着」这种问题没有答案。
 */
import type { SubscriptionStatus, VerifiedCloudToken } from '@agentsws/contracts'
import type {
  HostedInstanceStatus,
  SupportServiceAdminPort,
  SupportServiceSummary,
} from '@agentsws/hosted'
import type { WorkerEnv } from './env.js'
import { HOSTED_INTERNAL } from './hosted-instance-do.js'
import { withInternalHeaders } from './internal.js'

export function remoteSupportServiceAdminPort(
  env: WorkerEnv,
  workspacesOf: (org_id: string) => string[],
): SupportServiceAdminPort | undefined {
  const relay = env.CHAT_RELAY
  if (relay === undefined) return undefined
  const hosted = env.HOSTED_INSTANCE
  return {
    async summary(org_id: string): Promise<SupportServiceSummary> {
      const workspaces: SupportServiceSummary['workspaces'] = []
      for (const workspace_id of [...new Set(workspacesOf(org_id))]) {
        // 订阅在转发器对象里；那几条内部路由要一个 principal——后台是系统身份
        const principal: VerifiedCloudToken = {
          account_id: 'system',
          org_id,
          workspace_id,
          scopes: [],
        }
        const subRes = await relay
          .get(relay.idFromName(workspace_id))
          .fetch(
            withInternalHeaders(
              new Request('https://relay.internal/__internal/support-subscription'),
              { principal },
            ),
          )
        const sub = subRes.ok
          ? (
              (await subRes.json()) as {
                data: {
                  status: SubscriptionStatus
                  current_cycle_end?: string
                  grace_until?: string
                }
              }
            ).data
          : { status: 'none' as const }
        const row: SupportServiceSummary['workspaces'][number] = {
          workspace_id,
          subscription_status: sub.status,
          ...(sub.current_cycle_end === undefined
            ? {}
            : { current_cycle_end: sub.current_cycle_end }),
          ...(sub.grace_until === undefined ? {} : { grace_until: sub.grace_until }),
        }
        if (hosted !== undefined) {
          const res = await hosted
            .get(hosted.idFromName(workspace_id))
            .fetch(new Request(`https://hosted.internal${HOSTED_INTERNAL.status}`))
          if (res.ok) {
            const status = ((await res.json()) as { data: HostedInstanceStatus }).data
            // 从没订过的工作区：托管对象是空的，不出这一格
            if (status.workspace_id !== '') row.hosted = status
          }
        }
        // 从没订过、也没有托管记录的工作区不列（一个组织十个品牌，只看订过的那几个）
        if (row.subscription_status !== 'none' || row.hosted !== undefined) workspaces.push(row)
      }
      return { org_id, workspaces }
    },
  }
}
