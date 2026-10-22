/**
 * WP462（急修，beta.5 真机）：**职责升大版本**之后，老分配怎么接上。
 *
 * 05 §3 的规矩不变：职责升了大版本，旧分配不能拿新定义接着用，要重新确认
 * （`effectiveConfig` 照旧在这一处拦）。这里补的是「谁来确认」：
 *
 * - **只收窄权限**的大版本（`narrow`：新版本的动作、连接、额度、数据范围都是旧版本的子集），
 *   以及**明确登记的拆分**（`split`：拆出去的那一半由 `heirs` 接着做，给原分配的同一个人补发），
 *   宿主启动时自动重确认、记一条 `assignment.role_major_upgraded`——不让人去点一个他看不懂的确认；
 * - 其余（没登记的、`widen` 放宽权限的）**不自动**：那一条分配在界面上出一张就地确认卡，
 *   别的岗位、职责照常用（一条分配不许拖垮整页）。
 *
 * 纪律与 `ROLE_ID_ALIASES` / `ROLE_ID_SPLITS` 同一条：**只可加行**。
 * 每次把内置职责升大版本，必须在这里登记一行；`test/major-upgrades.test.ts` 对着
 * 上一个发出去的版本（`test/fixtures/released-roles/`）逐条核：没登记、或者登记成
 * `narrow` / `split` 却其实放宽了权限，门禁就红。
 */
import type { Assignment, RoleId } from '@agentsws/contracts'
import type { RoleDefinitionFull } from './types.js'

export type RoleMajorUpgradeKind = 'narrow' | 'split' | 'widen'

export interface RoleMajorUpgrade {
  role_id: RoleId
  /** 从哪个大版本升上来（旧分配上记的 `role_version` 的大版本号）。 */
  from_major: number
  /** 升到哪个大版本。 */
  to_major: number
  kind: RoleMajorUpgradeKind
  /**
   * `split`：拆出去的那几条职责。原分配的同一个人、同一个品牌各补发一条
   * （范围、品牌、已有的自动化等级与采纳率按动作照抄过去）；他已经有了就不补。
   */
  heirs?: readonly RoleId[]
  /** 记进事件的那个词（哪一单改的）。 */
  reason: string
}

export const ROLE_MAJOR_UPGRADES: readonly RoleMajorUpgrade[] = [
  /*
   * WP446（docs/109 §4）：「内容与搜索」2.x → 「内容与博客」3.0.0，SEO 与 GEO 拆成 `dtc.seo`。
   * 内容那一条只少不多（三种改页面的动作、Search Console / GA4、订单只读都搬走了），
   * 搬走的那一半由 `dtc.seo` 接着做——所以对原来担内容的人，权限一样没多、一样没少。
   */
  {
    role_id: 'dtc.content',
    from_major: 2,
    to_major: 3,
    kind: 'split',
    heirs: ['dtc.seo'],
    reason: 'wp446',
  },
]

/** `2.0.0` → 2；写坏了的版本号回 NaN（任何比较都不相等 → 当成"对不上"）。 */
export function majorOf(version: string): number {
  const head = version.split('.')[0] ?? ''
  return /^\d+$/.test(head) ? Number(head) : Number.NaN
}

/** 这条分配记下的大版本与职责现在的大版本对不上（= 要重新确认）。 */
export function isStaleMajor(
  assignment: Pick<Assignment, 'role_version'>,
  role: Pick<RoleDefinitionFull, 'version'>,
): boolean {
  return majorOf(assignment.role_version) !== majorOf(role.version)
}

/**
 * 从 `from` 大版本走到 `to` 大版本要经过的那几步（每一步一行登记）。
 * 中间缺一步、或者往回走（降版本），回 `undefined`——一律不自动。
 */
export function majorUpgradePath(
  role_id: RoleId,
  from: number,
  to: number,
  table: readonly RoleMajorUpgrade[] = ROLE_MAJOR_UPGRADES,
): RoleMajorUpgrade[] | undefined {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) return undefined
  const steps: RoleMajorUpgrade[] = []
  let at = from
  while (at < to) {
    const step = table.find((u) => u.role_id === role_id && u.from_major === at)
    if (step === undefined || step.to_major <= at || step.to_major > to) return undefined
    steps.push(step)
    at = step.to_major
  }
  return steps
}

/** 这一串升级能不能不问人直接接上（每一步都只收窄或是登记过的拆分）。 */
export function autoUpgradable(path: readonly RoleMajorUpgrade[] | undefined): boolean {
  return path !== undefined && path.length > 0 && path.every((s) => s.kind !== 'widen')
}

/** 一串升级里要补发的职责（按出现顺序去重）。 */
export function heirsOf(path: readonly RoleMajorUpgrade[]): RoleId[] {
  const out: RoleId[] = []
  for (const step of path) for (const h of step.heirs ?? []) if (!out.includes(h)) out.push(h)
  return out
}

/** 界面与报错里那句话要的几格（`effectiveConfig` 拦下时放进 `details`，前端照它出确认卡）。 */
export interface RoleUpgradeNeeded {
  reason: 'role_major_upgraded'
  assignment_id: string
  role_id: RoleId
  role_name: string
  from: string
  to: string
}

/** 拦下时那句人话（不出英文、不出分配号）。 */
export function roleUpgradeText(role_name: string): string {
  return `「${role_name}」这条职责升级了，点一下确认就能接着用`
}
