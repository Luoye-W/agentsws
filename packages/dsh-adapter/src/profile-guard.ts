/**
 * WP180：**完整 profile 里的守门插件**（子路径 `@agentsws/dsh-adapter/profile-guard`）。
 *
 * WP179 把官方插件管理（`plugin-manager`）与配置写回（`config-editor` / `settings`）判成 B：
 * 打开会"装任意代码没人批"、"一次表单保存就把 C 类上报打开"。WP180 撤了这几行的锁，
 * 换成**包一层**——这个插件就是完整 profile（`dsh --profile agentsws`）那条路上的那一层：
 *
 * - `configEditor.edit`：想写锁定表里的行（C 类上报、B 类开关、选了才开的那几行、守门插件自己）→ 直接拒、记一条；
 *   别的行照官方原样写。
 * - `pluginManager`：**读照常**（列插件、列 bundle、查包）；**写一律拒**——装 / 卸 / 选 bundle / 开关某一行 /
 *   放行不兼容版本都改到 profile 文件，而装插件要出卡、只从审过的清单装，那条路在 Agents 工坊的
 *   「设置 → 官方插件」（`apps/server/src/official-plugins.ts`），这里没有出卡的人。
 *
 * 我们自己的两档运行时不读 profile（`harness.ts` 自己搭树），这个插件只在完整 profile 里挂（`cordis.patch.yml`
 * 里插进来的那一行）。依赖只有类型——不 import 官方插件管理 / 配置编辑的运行期代码，挂它不会把它们拖进来。
 */
import type { Context } from '@deepseek-ai/cordis'

/** 守门插件在组合里的那一行 id（它自己也在锁定表里：配置保存改不动它）。 */
export const PROFILE_GUARD_ROW = 'agentsws-profile-guard'

/** Cordis 插件名（加载器诊断里用）。 */
export const name = PROFILE_GUARD_ROW

/**
 * 锁定表：`profiles/agentsws/cordis.patch.yml` 里出现的每一个 id + 守门插件自己。
 * `test/official-plugins.test.ts` 钉住它与那份文件逐项一致（文件改了这里不跟就红）。
 */
export const PROFILE_LOCKED_ROWS: readonly string[] = [
  'agentsws-profile-guard',
  'computer-use',
  'computer-use-cua-driver-mcp',
  'deepseek-account',
  'otel',
  'plugin-package-inventory-deepseek',
  'session-log-deepseek',
  'session-telemetry-otel',
]

/** 官方插件管理里会改 profile 文件的那几个方法（守门插件一律拒）。 */
export const PLUGIN_MANAGER_WRITES = [
  'installBundle',
  'removeBundle',
  'setBundleEnabled',
  'setPluginEnabled',
  'setVersionExemption',
] as const

/** 一次被拒：写哪一行 / 调哪个方法、为什么。 */
export interface ProfileGuardRejection {
  kind: 'config' | 'plugin'
  /** 配置写回：想写的那一行。 */
  row_id?: string
  /** 配置写回：想改的字段名（**不带值**）。 */
  fields?: string[]
  /** 插件管理：被拒的那个方法。 */
  op?: string
  message: string
}

export class ProfileGuardError extends Error {
  constructor(readonly rejection: ProfileGuardRejection) {
    super(rejection.message)
    this.name = 'ProfileGuardError'
  }
}

/** 官方 `ConfigEditor` 里我们要包的那一个方法（结构类型，不 import 官方包）。 */
export interface ConfigEditorLike {
  edit(
    entry: { id: string },
    change: (
      current: Record<string, unknown>,
      inherited: Record<string, unknown>,
    ) => Record<string, unknown>,
  ): Promise<void>
}

/**
 * 包 `configEditor.edit`：锁定表里的行直接拒（不调官方、文件一个字节不动），别的行原样交给官方。
 * 回一个撤销函数（插件卸下时把原方法放回去）。
 */
export function guardConfigEditor(
  editor: ConfigEditorLike,
  opts: { locked: readonly string[]; onRejected: (r: ProfileGuardRejection) => void },
): () => void {
  const original = editor.edit
  editor.edit = async function guarded(this: unknown, entry, change) {
    if (opts.locked.includes(entry.id)) {
      let fields: string[] = []
      try {
        fields = Object.keys(change({}, {}))
      } catch {
        fields = []
      }
      const rejection: ProfileGuardRejection = {
        kind: 'config',
        row_id: entry.id,
        fields,
        message: `${entry.id} 在锁定表里，运行中的配置保存改不动它`,
      }
      opts.onRejected(rejection)
      throw new ProfileGuardError(rejection)
    }
    return original.call(this === undefined ? editor : this, entry, change)
  }
  return () => {
    editor.edit = original
  }
}

/**
 * 包官方插件管理：会改 profile 文件的方法一律拒；读的方法不碰。回一个撤销函数。
 */
export function guardPluginManager(
  manager: Record<string, unknown>,
  opts: { onRejected: (r: ProfileGuardRejection) => void },
): () => void {
  const originals = new Map<string, unknown>()
  for (const op of PLUGIN_MANAGER_WRITES) {
    if (typeof manager[op] !== 'function') continue
    originals.set(op, manager[op])
    manager[op] = async () => {
      const rejection: ProfileGuardRejection = {
        kind: 'plugin',
        op,
        message:
          '装 / 卸 / 开关插件请到 Agents 工坊的「设置 → 官方插件」：要出卡、只从审过的清单装',
      }
      opts.onRejected(rejection)
      throw new ProfileGuardError(rejection)
    }
  }
  return () => {
    for (const [op, fn] of originals) manager[op] = fn
  }
}

/** 守门插件的配置：锁定表（不给就用 {@link PROFILE_LOCKED_ROWS}）。 */
export interface Config {
  locked?: string[]
}

/** 挂进完整 profile：官方配置编辑 / 插件管理哪个在就包哪个；被拒的记一条 warn（不带配置值）。 */
export function apply(ctx: Context, config: Config = {}): void {
  const locked = config.locked ?? PROFILE_LOCKED_ROWS
  const logger = ctx.logger(PROFILE_GUARD_ROW)
  const onRejected = (r: ProfileGuardRejection): void => {
    logger.warn(`rejected ${r.kind}: ${r.row_id ?? r.op ?? ''} ${r.message}`)
  }
  ctx.inject(['configEditor'], (c) => {
    c.effect(() =>
      guardConfigEditor(c.get('configEditor') as ConfigEditorLike, { locked, onRejected }),
    )
  })
  ctx.inject(['pluginManager'], (c) => {
    c.effect(() =>
      guardPluginManager(c.get('pluginManager') as Record<string, unknown>, { onRejected }),
    )
  })
}
