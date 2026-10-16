/**
 * 连接这一摊用哪条分配去问（从连接页抽出来，WP356 设置弹窗里拆开的几节共用）。
 *
 * 连接由**工作区所有者**管（05 common.owner 的 authorize_connector）。一个人可能同时
 * 是客服和所有者，网关又是一次请求绑一个 Assignment（31 §3.1），所以显式用所有者那条，
 * 而不是跟着左栏当前选中的岗位走。
 *
 * WP276（docs/95 §2.1）：② 同事互联里每个人都能接自己的连接（谁接的谁管）——没有所有者那条
 * 就用自己任意一条分配。插件配对、取数路线、数据后端这些家务仍只给发起人（看 `ownerId`）。
 */
import { useQuery } from '@tanstack/react-query'
import { getPositions } from '@/lib/api'
import { useMode } from '@/lib/mode'

export function useConnectAs(): {
  ownerId: string | undefined
  asId: string | undefined
  pending: boolean
} {
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const { mode } = useMode()
  const ownerId = positions.data?.positions.find((p) => p.role_id === 'common.owner')?.position_id
  const asId = ownerId ?? (mode === 'peers' ? positions.data?.positions[0]?.position_id : undefined)
  return { ownerId, asId, pending: positions.isPending }
}
