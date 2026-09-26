/**
 * WP153（09-26 真账号冒烟 §3）：**店主查得到「有哪些岗位、有哪些连接」**。
 *
 * 冒烟里店主职责被问「有哪些岗位和连接、先处理哪三件事」，只能回一句「这个工作区没有给我
 * 能列出岗位和连接的工具」。这里是那两个**只读**工具的名字、给模型看的描述、回来的数据形状，
 * 以及 stub 运行时用的那一段剧本（岔口 + 说人话）。真正取数据在服务端
 * （`apps/server/src/owner-tools.ts`，读现有的岗位与连接装配，不新造存储）。
 *
 * 数据形状是**白名单**：只有名字、状态、谁要它——没有 id、没有邮箱、没有任何凭据 / token 字段。
 * 模型拿到什么，屏幕上就可能出现什么，所以从源头就不给。
 */
import type { RunRequest, ToolDef } from '@agentsws/contracts'

export const OWNER_ROLE_ID = 'common.owner'
export const OWNER_POSITIONS_TOOL = 'list_positions'
export const OWNER_CONNECTIONS_TOOL = 'list_connections'

/** 店主的两个只读工具（排好序：`tools.allow` 要字节稳定）。 */
export const OWNER_TOOL_NAMES: readonly string[] = [
  OWNER_CONNECTIONS_TOOL,
  OWNER_POSITIONS_TOOL,
].sort()

/** 这次运行是不是店主职责。 */
export const isOwnerRole = (role_id: string): boolean => role_id === OWNER_ROLE_ID

/** 给模型看的定义（描述写人话：它是在挑工具的那一刻读描述的）。 */
export const OWNER_TOOL_DEFS: readonly ToolDef[] = [
  {
    name: OWNER_CONNECTIONS_TOOL,
    description:
      '列出这个工作区的连接：已经接上的（店铺、邮箱、广告账号这类）、出错要重新授权的，' +
      '以及哪条职责要用、但还没连上的。只读，不带任何密钥或令牌。',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: OWNER_POSITIONS_TOOL,
    description:
      '列出这个工作区的岗位：每个岗位下面有哪些职责、谁在岗、负责范围有没有划。' +
      '只读，只有名字，没有联系方式。',
    input_schema: { type: 'object', properties: {} },
  },
]

export const OWNER_TOOL_DEF_BY_NAME: ReadonlyMap<string, ToolDef> = new Map(
  OWNER_TOOL_DEFS.map((d) => [d.name, d]),
)

/** 一个岗位（`list_positions` 回的一行）。 */
export interface OwnerPositionRow {
  name: string
  /** 下面的职责（中文名）。 */
  duties: string[]
  /** 谁在岗；`range` 是人话（「整个品牌」「2 个店铺」「还没划范围」）。 */
  holders: { name: string; range: string; has_range: boolean }[]
  staffed: boolean
}

export interface OwnerPositionsData {
  positions: OwnerPositionRow[]
}

/** 一条已经接上的连接（出错的也在这里，`state: 'error'`）。 */
export interface OwnerConnectionRow {
  name: string
  state: 'connected' | 'error'
  /** 出错时的一句人话（「要重新授权」）。 */
  note?: string
}

/** 一条有职责要、但还没连上的连接。 */
export interface OwnerConnectionGap {
  name: string
  required: boolean
  /** 哪几条职责要它（中文名）。 */
  needed_by: string[]
}

export interface OwnerConnectionsData {
  connected: OwnerConnectionRow[]
  missing: OwnerConnectionGap[]
}

/** 一串名字最多列 3 个，多了说「等 N 个」（回话要短：用户是非开发者，减字）。 */
function few(list: readonly string[], unit = '条'): string {
  if (list.length <= 3) return list.join('、')
  const head = list.slice(0, 3).join('、')
  // 英文名结尾（「X Ads」）后面空一格再接「等」，读起来不粘
  return `${head}${/[\w)]$/.test(head) ? ' ' : ''}等 ${list.length} ${unit}`
}

const MENTIONS = /岗位|职责|连接|连上|接上|谁在做|谁在岗|position|connection/i

/**
 * stub 的岔口：店主职责、工具面里有这两个工具、而且问的是岗位 / 连接，才走这一边；
 * 否则照旧（stub 的其余路径一个字节不变）。回的是要调的工具（按名字排）。
 */
export function ownerBranch(req: RunRequest, text: string): string[] | undefined {
  if (!isOwnerRole(req.actor.role_id)) return undefined
  const calls = OWNER_TOOL_NAMES.filter((n) => req.tools.allow.includes(n))
  if (calls.length === 0 || !MENTIONS.test(text)) return undefined
  // 先岗位后连接：说「谁缺什么」之前先知道有哪些岗位
  return [...calls].sort((a, b) =>
    a === OWNER_POSITIONS_TOOL ? -1 : b === OWNER_POSITIONS_TOOL ? 1 : 0,
  )
}

/** 工具回的 data → 形状（认不出就 undefined，不猜）。 */
export function positionsOf(data: unknown): OwnerPositionsData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return Array.isArray(o.positions) ? (o as unknown as OwnerPositionsData) : undefined
}

export function connectionsOf(data: unknown): OwnerConnectionsData | undefined {
  const o = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  return Array.isArray(o.connected) && Array.isArray(o.missing)
    ? (o as unknown as OwnerConnectionsData)
    : undefined
}

/**
 * 「最该先处理的」排序：出错的连接 → 缺的必需连接 → 没人在岗的岗位 → 范围是空的人 → 缺的可选连接。
 * 先修坏的、再补卡住开工的，最后才是锦上添花——与 36 §2「只有要人拍板的才是卡」同一个口径：
 * 先说挡路的。
 */
export function ownerPriorities(
  positions: OwnerPositionsData | undefined,
  connections: OwnerConnectionsData | undefined,
): string[] {
  const broken = (connections?.connected ?? [])
    .filter((c) => c.state === 'error')
    .map((c) => `把「${c.name}」重新接一次——${c.note ?? '这条连接出错了'}，用它的活现在都停着。`)
  const required = (connections?.missing ?? [])
    .filter((g) => g.required)
    .map((g) => `把「${g.name}」连上——${few(g.needed_by)}职责要它才能开工。`)
  // 同一类的并成一件事说（十个岗位没人在岗，不该占掉三件事里的三件）
  const empty = (positions?.positions ?? []).filter((p) => !p.staffed).map((p) => `「${p.name}」`)
  const staffing =
    empty.length === 0
      ? []
      : [`给没人在岗的岗位安排人：${few(empty, '个')}——这些岗位的活现在没人接。`]
  const noRange = (positions?.positions ?? []).flatMap((p) =>
    p.holders.filter((h) => !h.has_range).map((h) => `「${p.name}」的 ${h.name}`),
  )
  const ranges =
    noRange.length === 0
      ? []
      : [`给${few(noRange, '人')}划负责范围——现在是空的，按范围分的活派不到头上。`]
  const optional = (connections?.missing ?? [])
    .filter((g) => !g.required)
    .map((g) => `「${g.name}」`)
  const extra = optional.length === 0 ? [] : [`有空再连${few(optional)}——用得上，不连也能先干。`]
  // 缺的必需连接最多占两件：第三件留给「没人在岗」这类别的挡路的事，三件事不全是同一类
  return [
    ...broken,
    ...required.slice(0, 2),
    ...staffing,
    ...ranges,
    ...required.slice(2),
    ...extra,
  ].slice(0, 3)
}

/**
 * stub 运行时给店主的那段回话（markdown：粗体、列表、编号——时间线会安全地渲染出来）。
 * 读不到的那一半照实说，不编。
 */
export function renderOwnerAnswer(input: {
  positions?: OwnerPositionsData
  connections?: OwnerConnectionsData
  /** 没读成的工具 → 原因（人话）。 */
  failed?: Readonly<Record<string, string>>
}): string {
  const { positions, connections } = input
  const failed = input.failed ?? {}
  const head: string[] = []
  if (positions !== undefined) head.push(`**${positions.positions.length} 个岗位**`)
  if (connections !== undefined) {
    const ok = connections.connected.filter((c) => c.state === 'connected').length
    head.push(ok > 0 ? `**${ok} 条连接**已接上` : '**还没接任何连接**')
    const req = connections.missing.filter((g) => g.required).length
    if (req > 0) head.push(`还差 **${req} 条必需的连接**`)
  }
  const lines: string[] = [
    head.length > 0 ? `这个工作区现在有 ${head.join('，')}。` : '这次岗位和连接都没读到。',
  ]

  if (positions !== undefined) {
    lines.push('', '**岗位**')
    if (positions.positions.length === 0) lines.push('- 还没有勾任何岗位。')
    for (const p of positions.positions) {
      const who = p.staffed
        ? `在岗：${p.holders.map((h) => `${h.name}（${h.range}）`).join('、')}`
        : '还没人在岗'
      lines.push(`- **${p.name}**：${few(p.duties) || '没有职责'}；${who}`)
    }
  } else if (failed[OWNER_POSITIONS_TOOL] !== undefined) {
    lines.push('', `岗位清单没读到：${failed[OWNER_POSITIONS_TOOL]}。`)
  }

  if (connections !== undefined) {
    lines.push('', '**连接**')
    const ok = connections.connected.filter((c) => c.state === 'connected').map((c) => c.name)
    lines.push(`- 已接上：${ok.length > 0 ? ok.join('、') : '一条都还没接'}`)
    for (const c of connections.connected)
      if (c.state === 'error') lines.push(`- 出错：${c.name}（${c.note ?? '要重新接'}）`)
    for (const g of connections.missing)
      if (g.required) lines.push(`- 还没连（**必需**）：${g.name}——${few(g.needed_by)}职责要它`)
    // 可选的并成一行：二十条可选连接一条一行，要紧的就淹没了
    const optional = connections.missing.filter((g) => !g.required).map((g) => g.name)
    if (optional.length > 0) lines.push(`- 还可以接（可选）：${few(optional)}`)
  } else if (failed[OWNER_CONNECTIONS_TOOL] !== undefined) {
    lines.push('', `连接清单没读到：${failed[OWNER_CONNECTIONS_TOOL]}。`)
  }

  const todo = ownerPriorities(positions, connections)
  const count = todo.length === 3 ? '三' : todo.length === 2 ? '两' : '一'
  lines.push('', `**最该先处理的${todo.length === 0 ? '事' : `${count}件事`}**`)
  if (todo.length === 0) lines.push('眼下没有挡路的：岗位都有人，必需的连接都接上了。')
  todo.forEach((t, i) => {
    lines.push(`${i + 1}. ${t}`)
  })
  return lines.join('\n')
}
