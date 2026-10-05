/**
 * WP234（docs/54 §6.2 / §6.3）：第 ③ 步「你的岗位」那块板的状态与规则。纯函数，与界面分开。
 *
 * 板上是一份**岗位清单**（名字 + 职责）。三条规则：
 *
 * 1. **推荐不选中**：推荐只是标签；点了某条职责才进板。
 * 2. **没动过手就按建议分**：每选一条，整块板按建议重排（AI 给了划分就用 AI 的名字与分法，
 *    剩下的走 `proposePositions`）。
 * 3. **动过手就以用户为准**：拖动 / 移动 / 新建 / 改名 / 删空之后，再选的职责只往里加
 *    （放进同类别的那个岗位，没有就新开一个），不再整块重排。
 */
import {
  categoryOfRole,
  MAX_DUTIES_PER_POSITION,
  type PlannedPosition,
  type PositionCatalogEntry,
  proposePositions,
} from '@agentsws/contracts'

export interface BoardRow {
  /** 界面里的 key（不是岗位 id；岗位 id 在「完成」时由服务端定）。 */
  key: string
  name: string
  role_ids: string[]
  template_id?: string
  /** 用户自己新建的：变空了也不自动收掉（删要他自己点）。 */
  manual?: true
}

export interface Board {
  selected: string[]
  rows: BoardRow[]
  /** 用户动过板的结构没有（动过就不再整块重排）。 */
  customized: boolean
  /** 自增编号，给新行发 key 用。 */
  seq: number
}

export const EMPTY_BOARD: Board = { selected: [], rows: [], customized: false, seq: 0 }

const withKeys = (positions: PlannedPosition[], seq: number): { rows: BoardRow[]; seq: number } => {
  let n = seq
  const rows = positions.map((p) => {
    n += 1
    return {
      key: `row-${String(n)}`,
      name: p.name,
      role_ids: [...p.role_ids],
      ...(p.template_id === undefined ? {} : { template_id: p.template_id }),
    }
  })
  return { rows, seq: n }
}

/**
 * 按建议分：AI 给过划分就先按它（只留选中的那几条），剩下的走算法。
 * 没给就整份走算法。
 */
export function regroup(
  selected: readonly string[],
  catalog: readonly PositionCatalogEntry[],
  suggested: readonly PlannedPosition[] = [],
): PlannedPosition[] {
  const out: PlannedPosition[] = []
  const used = new Set<string>()
  for (const p of suggested) {
    const ids = p.role_ids.filter((id) => selected.includes(id) && !used.has(id))
    if (ids.length === 0) continue
    for (const id of ids) used.add(id)
    out.push({ ...p, role_ids: ids })
  }
  const rest = selected.filter((id) => !used.has(id))
  return [...out, ...proposePositions(rest, catalog)]
}

/** 按建议重排整块板（「按建议分」按钮与没动过手时的每一次选择）。 */
export function rearrange(
  board: Board,
  catalog: readonly PositionCatalogEntry[],
  suggested: readonly PlannedPosition[] = [],
): Board {
  const { rows, seq } = withKeys(regroup(board.selected, catalog, suggested), board.seq)
  return { ...board, rows, seq, customized: false }
}

/** 选一条职责。 */
export function selectDuty(
  board: Board,
  role_id: string,
  catalog: readonly PositionCatalogEntry[],
  suggested: readonly PlannedPosition[] = [],
): Board {
  if (board.selected.includes(role_id)) return board
  const next = { ...board, selected: [...board.selected, role_id] }
  if (!board.customized) return rearrange(next, catalog, suggested)
  // 动过手：只往里加——同类别的那个岗位，没有就新开一个
  const cat = categoryOfRole(role_id, catalog)
  const home = board.rows.find((r) => cat !== undefined && r.template_id === cat.id)
  if (home !== undefined)
    return {
      ...next,
      rows: board.rows.map((r) =>
        r.key === home.key ? { ...r, role_ids: [...r.role_ids, role_id] } : r,
      ),
    }
  const seq = board.seq + 1
  return {
    ...next,
    seq,
    rows: [
      ...board.rows,
      {
        key: `row-${String(seq)}`,
        name: cat?.name ?? '我的岗位',
        role_ids: [role_id],
        ...(cat === undefined ? {} : { template_id: cat.id }),
      },
    ],
  }
}

/** 去掉一条职责：从板上拿掉；系统开的行变空就收掉（用户自己建的留着）。 */
export function deselectDuty(
  board: Board,
  role_id: string,
  catalog: readonly PositionCatalogEntry[],
  suggested: readonly PlannedPosition[] = [],
): Board {
  if (!board.selected.includes(role_id)) return board
  const next = { ...board, selected: board.selected.filter((id) => id !== role_id) }
  if (!board.customized) return rearrange(next, catalog, suggested)
  return {
    ...next,
    rows: board.rows
      .map((r) => ({ ...r, role_ids: r.role_ids.filter((id) => id !== role_id) }))
      .filter((r) => r.role_ids.length > 0 || r.manual === true),
  }
}

/** 把一条职责移到另一个岗位（拖动或「移到…」）。 */
export function moveDuty(board: Board, role_id: string, toKey: string): Board {
  const from = board.rows.find((r) => r.role_ids.includes(role_id))
  if (from === undefined || from.key === toKey || !board.rows.some((r) => r.key === toKey))
    return board
  return {
    ...board,
    customized: true,
    rows: board.rows.map((r) => {
      if (r.key === from.key) return { ...r, role_ids: r.role_ids.filter((id) => id !== role_id) }
      if (r.key === toKey) return { ...r, role_ids: [...r.role_ids, role_id] }
      return r
    }),
  }
}

/** 新建一个空岗位（之后往里拖）。 */
export function addRow(board: Board, name: string): Board {
  const seq = board.seq + 1
  return {
    ...board,
    seq,
    customized: true,
    rows: [...board.rows, { key: `row-${String(seq)}`, name, role_ids: [], manual: true }],
  }
}

/** 改名（复用 WP196 的意思：名字是用户的，以他为准）。 */
export function renameRow(board: Board, key: string, name: string): Board {
  return {
    ...board,
    customized: true,
    rows: board.rows.map((r) => (r.key === key ? { ...r, name } : r)),
  }
}

/** 删一个空岗位（有职责的删不掉——先把职责移走）。 */
export function removeRow(board: Board, key: string): Board {
  const row = board.rows.find((r) => r.key === key)
  if (row === undefined || row.role_ids.length > 0) return board
  return { ...board, customized: true, rows: board.rows.filter((r) => r.key !== key) }
}

/** 这一行太多了，建议拆（阈值与服务端同一个数）。 */
export function tooMany(row: BoardRow, max = MAX_DUTIES_PER_POSITION): boolean {
  return row.role_ids.length > max
}

/** 交给服务端的岗位清单（空行不交；名字空就用「我的岗位」）。 */
export function planOf(board: Board): PlannedPosition[] {
  return board.rows
    .filter((r) => r.role_ids.length > 0)
    .map((r) => ({
      name: r.name.trim() === '' ? '我的岗位' : r.name.trim(),
      role_ids: [...r.role_ids],
      ...(r.template_id === undefined ? {} : { template_id: r.template_id }),
    }))
}
