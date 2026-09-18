/**
 * WP95（36 §11，`sidebar-compare` #5 / #8）：第三栏的布局**按作用域分桶**。
 *
 * 官方按 session 分桶（`dsh.sidebar-right.v1.<sessionId>`），我们按
 * **岗位 / 事项 / 职责**分——54 定了岗位是任务主入口，"上一次在这里开的是哪个面板"
 * 这件事跟着的就该是岗位，不是一条对话。
 *
 * 桶怎么算（先长后短，第一条命中就停）：
 *
 * | 在哪一页 | 桶 | 为什么是它 |
 * |---|---|---|
 * | `/matters/:id` | `matter:<id>` | 在一件事上开的是"这件事的"面板（证据 / 变更审阅 / 运行中），换一件事该换一套 |
 * | `/positions/:asg/duties/:role` | `role:<role_id>` | 职责页看的是那条职责 |
 * | `/positions/:asg` | `position:<asg>` | 岗位页 |
 * | 其余任何一页 | `position:<当前分配>`，算不出来就 `default` | 首页 / 知识库…跟着当前岗位走（与 `rail-scope.ts` 同一条规矩） |
 *
 * **这里只算桶，不碰存储**：存在哪、怎么读写在 `lib/ui-state.ts`——40 §1.2 的闸
 * （`test/local-cache.test.ts`）钉住"只有三个文件碰得到本机存储"，这个文件不在那三个里。
 */
import { parseDutyPath, parsePositionPath } from '@/components/rail/rail-scope'

/** `/matters/mat_1` → `mat_1`（问 AI 与变更审阅都要这个边界）。 */
export function parseMatterPath(pathname: string): string | undefined {
  const m = /^\/matters\/([^/]+)\/?$/.exec(pathname)
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1])
}

/**
 * 这一页的第三栏布局记在哪个桶里。
 *
 * `assignment` 是当前分配（`useApp().position`）；没有就落到 `default`——
 * 一个还没进过任何岗位的浏览器不该把布局写进某个猜出来的桶里。
 */
export function railLayoutBucket(pathname: string, assignment: string | null): string {
  const matter = parseMatterPath(pathname)
  if (matter !== undefined) return `matter:${matter}`
  const duty = parseDutyPath(pathname)
  if (duty !== undefined) return `role:${duty.role_id}`
  const position = parsePositionPath(pathname)
  if (position !== undefined) return `position:${position}`
  return assignment === null || assignment === '' ? 'default' : `position:${assignment}`
}
