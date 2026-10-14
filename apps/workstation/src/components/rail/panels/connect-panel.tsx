/**
 * WP324（决策 690）：第三栏的**连接卡**——从数据看板 / 岗位页 / 消息页 / 社媒的「去连接」开（`agentsws://connect/<service>`）。
 * 就地连，不跳到连接页；连好那一样画绿勾。没有挂着哪件事（要接着做的那种在卡片流 / 时间线里，服务端出的卡）。
 * 连接页仍在，是总览与管理（卡底一个小链接）。
 */
import type { ConnectNeed } from '@agentsws/contracts'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { RailPanelBodyProps } from '@/components/rail/registry'
import { ConnectNeedsBody, useConnectContext } from '@/components/setup/connect-card'
import { servicesOfAddress } from '@/components/setup/use-open-connect'
import { useApp } from '@/lib/app-context'

export function ConnectPanel({ address, scope }: RailPanelBodyProps): ReactNode {
  const { t } = useApp()
  const services = servicesOfAddress(address)
  // 职责层开的（建站 / 管店那一路要知道是哪条职责）；岗位层就不带
  const duty =
    scope?.tier === 'role' && scope.assignment !== undefined
      ? { role_id: scope.scope_id, assignment_id: scope.assignment }
      : undefined
  const ctx = useConnectContext(duty)
  const needs: ConnectNeed[] = services.map((service) => {
    const label = ctx.providers?.find((p) => p.service === service)?.label
    const named = t(`setup.need.${service}`)
    return {
      kind: service,
      service,
      name: label ?? (named === `setup.need.${service}` ? service : named),
      required: true,
    }
  })
  return (
    <div className="flex flex-col gap-3 p-3" data-testid="connect-panel">
      {needs.length === 0 ? (
        <p className="text-sm text-ws-muted-fg">{t('setup.panel.empty')}</p>
      ) : (
        <ConnectNeedsBody needs={needs} ctx={ctx} />
      )}
      <Link
        to="/connections"
        className="text-xs text-ws-muted-fg underline-offset-4 hover:underline"
        data-testid="connect-panel-overview"
      >
        {t('setup.panel.overview')}
      </Link>
    </div>
  )
}
