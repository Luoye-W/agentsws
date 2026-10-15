/**
 * WP324（决策 690）：「去连接」不再跳页——在**第三栏**开一张连接卡（那几样就地连）。
 * 第三栏开不出来（单测里没有外壳）才退回连接页那一张（`?service=`）。连接页仍是总览与管理。
 */
import { useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useRailState } from '@/components/rail/rail-state'

/** 第三栏连接卡的资源地址：`agentsws://connect/<service>[+<service>…]`。 */
export const CONNECT_ADDRESS_PREFIX = 'agentsws://connect/'

export function connectAddress(services: readonly string[]): string {
  return `${CONNECT_ADDRESS_PREFIX}${services.map((s) => encodeURIComponent(s)).join('+')}`
}

/** 地址 → 要连的那几样（认不出回空）。 */
export function servicesOfAddress(address: string | undefined): string[] {
  if (address === undefined || !address.startsWith(CONNECT_ADDRESS_PREFIX)) return []
  return address
    .slice(CONNECT_ADDRESS_PREFIX.length)
    .split('+')
    .map((s) => decodeURIComponent(s))
    .filter((s) => s !== '')
}

/**
 * WP334：第三栏开不出来时退回哪一页——模型 / DeepSeek 账号在设置的模型那一档、工坊账号在账号那一档、
 * 消息渠道在消息渠道页，其余在连接页那一张。
 */
export function connectFallbackPath(first: string | undefined): string {
  if (first === undefined) return '/connections'
  if (first.startsWith('im:')) return '/im-channels'
  if (first === 'model' || first === 'deepseek_account') return '/settings?tab=models'
  if (first === 'workshop_account') return '/settings?tab=account'
  return `/connections?service=${encodeURIComponent(first)}`
}

/** 开连接卡（`undefined` / 空 = 认不出要连哪个：开连接页总览）。 */
export function useOpenConnect(): (services: string | readonly string[] | undefined) => void {
  const rail = useRailState()
  const navigate = useNavigate()
  return useCallback(
    (services) => {
      const list =
        services === undefined ? [] : typeof services === 'string' ? [services] : [...services]
      if (list.length > 0 && rail.openAddress(connectAddress(list))) return
      void navigate(connectFallbackPath(list[0]))
    },
    [rail, navigate],
  )
}
