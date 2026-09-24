/**
 * WP136（docs/79）：dsh 的「场景」（Profile）。
 *
 * Agents 工坊是 dsh 里的**一个**场景（固定第一、默认）；其他场景（dsh 官方模板、用户自建）
 * 由 DeepSeek 官方维护，我们只提供入口——列出来、起 / 停、新建、删自建的。
 */

/** 一个场景此刻的状态（只有 `surface: 'web'` 的会从 `stopped` 走到别的状态）。 */
export type DshSceneState = 'stopped' | 'starting' | 'running' | 'failed'

/**
 * 场景的「面」：
 * - `agentsws`：就是这个工作台本身（打开 = 回到工作台）；
 * - `web`：起一个只听本机的网页（dsh 官方的浏览器界面）；
 * - `cli`：命令行 / 程序接口（`headless` / `sdk` / `sdk-minimal` / `acp`），工作台里打不开。
 */
export type DshSceneSurface = 'agentsws' | 'web' | 'cli'

/** 谁维护它：我们（`agentsws`）/ DeepSeek 官方模板（`official`）/ 用户自己建的（`custom`）。 */
export type DshSceneOrigin = 'agentsws' | 'official' | 'custom'

export interface DshSceneView {
  /** 场景名 = `dsh --profile <name>`；Agents 工坊自己那个是 `agentsws`。 */
  name: string
  origin: DshSceneOrigin
  surface: DshSceneSurface
  /** 自建场景是从哪个官方模板建的（按它的 bundles 认；认不出就没有）。 */
  template?: string
  /** 只有 Agents 工坊是 `true`（固定第一个）。 */
  is_default: boolean
  /** 只有自建场景能删；Agents 工坊与官方场景永远 `false`。 */
  deletable: boolean
  /** 在工作台里点得开（Agents 工坊与网页场景）。 */
  launchable: boolean
  /** `$DSH_HOME/profiles/<name>` 已经在了（官方场景第一次打开时才建）。 */
  initialized: boolean
  state: DshSceneState
  /** 网页场景跑着时它听的端口（只听 127.0.0.1）。 */
  port?: number
  /** 这一次起来的时间（ISO）。 */
  started_at?: string
  /** 上一次没起来 / 意外退出时说给人听的那一句。 */
  error?: string
}

export interface DshScenesView {
  /** 这个部署能不能切场景（只有本机档能：dsh 起在用户那台电脑上）。 */
  available: boolean
  unavailable_reason?: string
  /** 装在这份 Agents 工坊里的 dsh 版本。 */
  dsh_version?: string
  /** 场景都放在这里（我们应用数据目录里的 `DSH_HOME`，不是 `~/.dsh`）。 */
  dsh_home?: string
  /** 其他场景启动时的工作目录（默认的工作区根）。 */
  workspace_root?: string
  /** Agents 工坊第一个，其次官方网页场景、自建场景，最后是命令行类官方场景。 */
  scenes: DshSceneView[]
  /** 新建场景时能选的官方模板。 */
  templates: { name: string; surface: 'web' | 'cli' }[]
}

/** 打开 / 重启一个网页场景的结果。`url` 带一次性 token，只交给打开它的那一方，不进日志。 */
export interface DshSceneOpenResult {
  scene: DshSceneView
  url: string
}
