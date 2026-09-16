/**
 * WP70（54 §4）：**先岗位、后职责**这条规矩要用到的三件小事，一份真源。
 *
 * - `myAssignments` / `positionHref`：一个岗位实体里**本人**那几条分配（别人那条
 *   不能拿来开事，否则就是借岗位扩权——54 §2 与 WP69 的老规矩）；
 * - `assignmentForPosition`：进岗位页时当前分配跟着岗位走（不属于这个岗位才换）；
 * - `groupDutiesByPosition`：一串职责按岗位归堆，归不进去的落在最后那一堆
 *   （历史数据里确实有只挂零散职责、不属于任何岗位的人）。
 */
import type { PositionInstanceData } from '@/lib/api'

/** 一个岗位实体里本人持有的分配（顺序 = 职责顺序）。 */
export function myAssignments(instance: PositionInstanceData): string[] {
  return instance.roles.map((r) => r.my_assignment_id).filter((x): x is string => x !== undefined)
}

/** 岗位在工作台里的地址——地址栏那个 id 是**分配** id（36 §3 / 54 §5.2 第 1 条）。 */
export function positionHref(instance: PositionInstanceData): string | undefined {
  const first = myAssignments(instance)[0]
  return first === undefined ? undefined : `/positions/${first}`
}

/**
 * 进岗位页时该把 `X-Assignment` 切到哪一条。
 *
 * 当前分配已经属于这个岗位就**不动**（职责层的切换只在岗位页折叠层里做，
 * 不该因为点了一下左栏就被顶回第一条）；不属于就用地址栏那条（它必属于本岗位）。
 * 没装岗位面的服务进程（`instances` 为空）退回现状：地址栏是哪条就是哪条。
 */
export function assignmentForPosition(
  instances: PositionInstanceData[] | undefined,
  urlId: string,
  current: string | null,
): string {
  if (instances === undefined || current === null || current === urlId) return urlId
  const here = instances.find((p) => myAssignments(p).includes(urlId))
  if (here === undefined) return urlId
  return myAssignments(here).includes(current) ? current : urlId
}

/** 归堆用的最小岗位形状：有名字、知道自己含哪几条职责。 */
export interface PositionRoleSet {
  id: string
  name: string
  roles: { role_id: string }[]
}

export interface DutyGroup<T> {
  /** 归不进任何岗位的那一堆没有 id（界面上显示「未归岗位 · N 条职责」）。 */
  position_id?: string
  name?: string
  duties: T[]
}

/**
 * 一串职责按岗位归堆。一条职责挂在多个岗位里时归**第一个**含它的岗位——
 * 这里是展示用的归堆，不是权限判定（权限永远看那条分配本身，05 §4 不变）。
 */
export function groupDutiesByPosition<T extends { role_id: string }>(
  duties: T[],
  positions: PositionRoleSet[],
): DutyGroup<T>[] {
  const groups: DutyGroup<T>[] = []
  const loose: T[] = []
  const bucket = new Map<string, T[]>()

  for (const duty of duties) {
    const owner = positions.find((p) => p.roles.some((r) => r.role_id === duty.role_id))
    if (owner === undefined) {
      loose.push(duty)
      continue
    }
    const list = bucket.get(owner.id)
    if (list === undefined) bucket.set(owner.id, [duty])
    else list.push(duty)
  }

  for (const position of positions) {
    const list = bucket.get(position.id)
    if (list === undefined || list.length === 0) continue
    groups.push({ position_id: position.id, name: position.name, duties: list })
  }
  if (loose.length > 0) groups.push({ duties: loose })
  return groups
}
