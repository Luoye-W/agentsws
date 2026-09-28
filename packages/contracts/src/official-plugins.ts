/**
 * WP180：**官方插件**（dsh 官方插件管理包一层后打开）与**配置写回**的契约。
 *
 * Luoye 09-29「官方功能优先」+ WP179 B 类结论：`plugin-manager` / `config-editor` 两类
 * "包一层就能开"。包的那一层就是这里的三条：
 *
 * 1. 装、升级、卸载一律出卡（`ApprovalKind` `official_plugin`），卡上写插件名、版本、来源、
 *    许可证、会注册哪些工具、会不会出网；
 * 2. 只许从审过的清单装（仓库里的 `profiles/agentsws/plugin-allowlist.yml`），清单外的直接拒；
 * 3. 装完不许写回 profile patch——锁定表里的行一行都改不动；运行中保存配置也只许写不在锁定表里的行。
 */

/** 一次插件变动：装、升级、卸载。 */
export type OfficialPluginAction = 'install' | 'upgrade' | 'uninstall'

/**
 * 插件从哪来：
 * - `shipped`：dsh 安装里自带、默认关着的官方可选包（上游 `OPTIONAL_BUNDLES`）——"装"就是选进来，不下载；
 * - `npm`：官方发在 npm 上的包（按清单里写死的版本装）。
 */
export type OfficialPluginSource = 'shipped' | 'npm'

/** 审过的清单里的一项（`profiles/agentsws/plugin-allowlist.yml` 的一行）。 */
export interface OfficialPluginSpec {
  /** 包名（`@deepseek-ai/…`）。 */
  name: string
  /** 审过的那个版本（写死，不用范围）。 */
  version: string
  source: OfficialPluginSource
  /** 许可证（SPDX，逐个核过包里的 `license` 字段与 LICENSE 文件）。 */
  license: string
  /** 界面上的名字（人话，短）。 */
  title: string
  /** 一句话：它是干什么的。 */
  summary: string
  /** 它会注册哪些工具（给模型用的工具名；没有就是空数组）。 */
  tools: string[]
  /** 会不会出网（自己往外发请求、下载东西）。 */
  network: boolean
  /** 出网的话，发到哪、发什么（人话）。 */
  network_note?: string
  /** 它会往组合里插哪几行（上游 bundle 的 `cordis.patch.yml` 里 `insert` 的 id）。 */
  rows: string[]
}

/**
 * 一个插件在这台机器上的状态。
 *
 * - `available`：清单里有、没装；
 * - `installed`：装着，版本就是审过的那个；
 * - `upgradable`：装着的是旧的审过版本，清单与 dsh 安装里都是新版本了——升级要出卡；
 * - `pending`：有一张卡还没批；
 * - `unreviewed`：dsh 安装里带的版本和清单里审过的对不上（dsh 升级了、清单还没重审）——
 *   装不了；已经装着的也**不进组合**，直到清单重审。
 */
export type OfficialPluginState =
  | 'available'
  | 'installed'
  | 'upgradable'
  | 'pending'
  | 'unreviewed'

export interface OfficialPluginView extends OfficialPluginSpec {
  state: OfficialPluginState
  /** 装着的版本（没装就没有）。 */
  installed_version?: string
  /** dsh 安装里实际带的版本（`shipped` 才有；找不到这个包就没有）。 */
  available_version?: string
  /** 有一张还没批的卡：批了要做什么、卡的 id。 */
  pending?: { action: OfficialPluginAction; approval_item_id: string }
}

export interface OfficialPluginsView {
  plugins: OfficialPluginView[]
  /** 这台服务进程装不了插件时的原因（人话）；能装就没有。 */
  blocked_reason?: string
}

/** 装 / 升级 / 卸载卡（`ApprovalKind` `official_plugin`）的 payload：卡上要写的都在这里。 */
export interface OfficialPluginCardPayload {
  action: OfficialPluginAction
  name: string
  title: string
  /** 这次要装成的版本（卸载时是装着的那个版本）。 */
  version: string
  /** 升级前的版本。 */
  from_version?: string
  source: OfficialPluginSource
  license: string
  tools: string[]
  network: boolean
  network_note?: string
}

/** 一次配置写回请求：写哪一行、写成什么。 */
export interface ProfileConfigWrite {
  /** 组合树里那一行的 id。 */
  row_id: string
  config: Record<string, unknown>
}

/** 配置写回被拒的原因码。 */
export type ProfileConfigRejectReason = 'locked_row' | 'unknown_row' | 'invalid_config'

/** 配置写回的结果。 */
export type ProfileConfigWriteResult =
  | { ok: true; row_id: string }
  | { ok: false; row_id: string; reason: ProfileConfigRejectReason; message: string }
