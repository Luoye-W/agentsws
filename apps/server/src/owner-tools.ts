/**
 * WP153（09-26 真账号冒烟 §3）：店主的两个**只读**工具真接上数据。
 *
 * - `list_positions`：岗位名、下面的职责、谁在岗、有没有划范围；
 * - `list_connections`：连了哪些、状态、哪条职责要它但还没连。
 *
 * 数据全部来自**现有的装配**：岗位读制度面（`org.port.positions`，与「岗位」页同一份），
 * 连接读连接目录（`directory()` 与岗位连接清单同一份算法 `roleGaps`）。不新造存储。
 *
 * 三条纪律：
 *
 * 1. **只给店主**：`tools.allow` 里只有 `common.owner` 才有这两个名字（`runtime.ts`），
 *    执行器这里再判一次——别的职责就算点名调，也是 `blocked`。
 * 2. **白名单出参**：一行一行手写出来，只有名字、状态、谁要它。没有 id、没有邮箱、
 *    没有账号标识、没有任何凭据 / token / 密钥字段——绝不把上游对象整个展开进来。
 * 3. **失败说人话**：装配还没好、读不到，都回一句中文。
 */
import type { RangeRef, RoleId, RunRequest } from '@agentsws/contracts'
import type {
  OwnerConnectionGap,
  OwnerConnectionRow,
  OwnerConnectionsData,
  OwnerPositionRow,
  OwnerPositionsData,
  ToolExecution,
  ToolExecutor,
} from '@agentsws/stand-ins'
import { isOwnerRole, OWNER_CONNECTIONS_TOOL, OWNER_POSITIONS_TOOL } from '@agentsws/stand-ins'

/** 岗位视图里用得到的那几格（`org.port.positions` 的形状，只挑这些）。 */
export interface OwnerPositionSource {
  name: string
  roles: readonly { role_id: string; name: string; default: boolean }[]
  holders: readonly { name: string; ranges: readonly RangeRef[] }[]
}

/** 连接目录里用得到的那几格。 */
export interface OwnerDirectorySource {
  name: { zh: string }
  state: 'connected' | 'not_connected' | 'error'
  state_detail?: string
}

export interface OwnerToolsOptions {
  /** 岗位（带持有人）；装配还没好回 `undefined`。给的是这次运行的发起人（制度面要一个 actor）。 */
  positions(actor: RunRequest['actor']): Promise<readonly OwnerPositionSource[] | undefined>
  /** 连接目录（带运行时状态）。 */
  directory(): Promise<readonly OwnerDirectorySource[] | undefined>
  /** 这几条职责要、但还没连上的连接。 */
  gaps(
    role_ids: readonly RoleId[],
  ): Promise<
    readonly { name: { zh: string }; required: boolean; needed_by: readonly string[] }[] | undefined
  >
  /** 这个工作区现在有人在做的职责（有未撤销的分配）。 */
  activeRoleIds(): readonly RoleId[]
}

const RANGE_ZH: Readonly<Record<RangeRef['kind'], string>> = {
  brand: '品牌',
  store: '店铺',
  department: '部门',
  account: '账号',
  market: '站点',
  product_line: '品类',
}

/** 一个人的范围 → 人话（「1 个品牌、2 个店铺」；一个都没有就「还没划范围」）。不出 id。 */
export function rangeText(ranges: readonly RangeRef[]): string {
  if (ranges.length === 0) return '还没划范围'
  const counts = new Map<string, number>()
  for (const r of ranges) counts.set(r.kind, (counts.get(r.kind) ?? 0) + 1)
  return [...counts]
    .map(([kind, n]) => `${n} 个${RANGE_ZH[kind as RangeRef['kind']] ?? '范围'}`)
    .join('、')
}

/**
 * 本来就管整个工作区、不按范围分活的职责（店主、普通成员）。只由它们组成的岗位，
 * 在岗的人没划范围是正常的——说成「整个工作区」，不当成一件要处理的事。
 */
const WORKSPACE_WIDE_ROLES: ReadonlySet<string> = new Set(['common.owner', 'common.member'])

export function ownerPositionsData(rows: readonly OwnerPositionSource[]): OwnerPositionsData {
  return {
    positions: rows.map((p): OwnerPositionRow => {
      const wide = p.roles.length > 0 && p.roles.every((r) => WORKSPACE_WIDE_ROLES.has(r.role_id))
      return {
        name: p.name,
        // 「工作区成员」每个岗位都挂着，列出来只是噪音；只有它一条的岗位（普通成员）才列
        duties: (p.roles.length > 1
          ? p.roles.filter((r) => r.role_id !== 'common.member')
          : p.roles
        ).map((r) => r.name),
        holders: p.holders.map((h) => ({
          name: h.name,
          range: h.ranges.length === 0 && wide ? '整个工作区' : rangeText(h.ranges),
          has_range: h.ranges.length > 0 || wide,
        })),
        staffed: p.holders.length > 0,
      }
    }),
  }
}

export function ownerConnectionsData(
  directory: readonly OwnerDirectorySource[],
  gaps: readonly { name: { zh: string }; required: boolean; needed_by: readonly string[] }[],
): OwnerConnectionsData {
  const connected = directory
    .filter((d) => d.state !== 'not_connected')
    .map(
      (d): OwnerConnectionRow =>
        d.state === 'error'
          ? { name: d.name.zh, state: 'error', note: d.state_detail ?? '这条连接出错了' }
          : { name: d.name.zh, state: 'connected' },
    )
  const missing = gaps.map(
    (g): OwnerConnectionGap => ({
      name: g.name.zh,
      required: g.required,
      needed_by: [...g.needed_by],
    }),
  )
  return { connected, missing }
}

/** 店主两个只读工具的执行器（接在 `runtime.ts` 的工具链上，红人工具之后、Dev MCP 之前）。 */
export function createOwnerToolExecutor(options: OwnerToolsOptions): ToolExecutor {
  return async (call): Promise<ToolExecution> => {
    const bare = call.name.includes('.') ? call.name.slice(call.name.indexOf('.') + 1) : call.name
    if (!isOwnerRole(call.request.actor.role_id))
      return { status: 'blocked', reason: '只有工作区所有者能看全部岗位与连接' }
    try {
      if (bare === OWNER_POSITIONS_TOOL) {
        const rows = await options.positions(call.request.actor)
        if (rows === undefined) return { status: 'error', reason: '岗位还没装好，稍后再试' }
        return { status: 'ok', data: ownerPositionsData(rows) }
      }
      if (bare === OWNER_CONNECTIONS_TOOL) {
        const directory = await options.directory()
        if (directory === undefined)
          return { status: 'error', reason: '连接目录还没装好，稍后再试' }
        const gaps = (await options.gaps(options.activeRoleIds())) ?? []
        return { status: 'ok', data: ownerConnectionsData(directory, gaps) }
      }
      return { status: 'error', reason: `unsupported_tool：这个进程没接「${call.name}」。` }
    } catch (e) {
      return { status: 'error', reason: `没读到：${e instanceof Error ? e.message : String(e)}` }
    }
  }
}
