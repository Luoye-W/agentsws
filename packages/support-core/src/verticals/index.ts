/**
 * 垂直包 registry —— **唯一的解析入口**（48 v2 L2）。
 *
 * 所有读工作区的代码通过 `WorkspaceProfile.vertical` 取包；运行时经
 * `RunRequest.vertical` 拿到同一个值。
 *
 * `null` / `undefined` / 任何非法值 → `goods`。存量工作区、老的导出包、手改过的库行，
 * 全部落在这一条上，而那正是"现有电商工作区零变化"的兜底：拿不到垂直时的行为
 * 必须与这一版上线前完全相同。
 */
import { digitalPack } from './digital/index.js'
import { goodsPack } from './goods/index.js'
import { isVertical, type Vertical, type VerticalPack } from './types.js'

const PACKS: Record<Vertical, VerticalPack> = {
  goods: goodsPack,
  digital: digitalPack,
}

/** 取包。非法值一律按"没选过"处理，回落实物。 */
export function getVerticalPack(vertical: Vertical | string | null | undefined): VerticalPack {
  return isVertical(vertical) ? PACKS[vertical] : goodsPack
}

/** 非法值一律按"没选过"处理（导入的档案、老数据、手填的字段）。 */
export function normalizeVertical(vertical: unknown): Vertical | undefined {
  return isVertical(vertical) ? vertical : undefined
}

/** 首次设置那一步要列的选项：`key` + 中文名 + 一句人话。 */
export function verticalChoices(): { key: Vertical; label: string; hint: string }[] {
  return [goodsPack, digitalPack].map((p) => ({ key: p.key, label: p.labelZh, hint: p.hintZh }))
}

export { digitalPack } from './digital/index.js'
export { goodsPack } from './goods/index.js'
export * from './render.js'
export * from './types.js'
