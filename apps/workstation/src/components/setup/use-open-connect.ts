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

/** 开连接卡（`undefined` / 空 = 认不出要连哪个：开连接页总览）。 */
export function useOpenConnect(): (services: string | readonly string[] | undefined) => void {
  const rail = useRailState()
  const navigate = useNavigate()
  return useCallback(
    (services) => {
      const list =
        services === undefined ? [] : typeof services === 'string' ? [services] : [...services]
      if (list.length > 0 && rail.openAddress(connectAddress(list))) return
      const first = list[0]
      void navigate(
        first === undefined
          ? '/connections'
          : first.startsWith('im:')
            ? '/im-channels'
            : `/connections?service=${encodeURIComponent(first)}`,
      )
    },
    [rail, navigate],
  )
}
