/**
 * WP438：报表里要的那一点岗位信息——名字（页签前面、固定到哪）、本人在这个岗位的分配（结论卡的动作钮开事要它）、
 * 这个岗位下本人持有的职责（固定到哪一条）。读的是 `['positions']` 那份缓存，不多发请求。
 */
import { useQuery } from '@tanstack/react-query'
import { getPositions } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export interface PositionInfo {
  name?: string
  assignment?: string
  duties: { role_id: string; role_name: string; assignment: string }[]
}

export function usePositionInfo(position: string | undefined): PositionInfo {
  const { lang } = useApp()
  const positions = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const inst = positions.data?.instances?.find((i) => i.position_id === position)
  if (inst === undefined) return { duties: [] }
  const duties = inst.roles.flatMap((r) =>
    r.my_assignment_id === undefined
      ? []
      : [{ role_id: r.role_id, role_name: r.role_name, assignment: r.my_assignment_id }],
  )
  const assignment = duties[0]?.assignment
  return {
    name: lang === 'en' ? inst.name.en : inst.name.zh,
    ...(assignment === undefined ? {} : { assignment }),
    duties,
  }
}
