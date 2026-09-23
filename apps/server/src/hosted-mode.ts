/**
 * 托管实例模式（WP128 / docs/64 §11 / docs/74 §5）：**同一份 `apps/server`**，跑在
 * Cloudflare Container 里替商家值守聊天窗。开关是环境变量 `AGENTSWS_HOSTED=1`，
 * 其余配置（工作区号、托管令牌、转发器配对、库密钥）全由 `HostedInstanceDO` 在起容器时
 * 经环境变量给一次（契约在 `@agentsws/hosted` 的 `buildHostedEnv` / `parseHostedEnv`）。
 *
 * 与商家本机那一份只差四件事，全在这个文件里：
 *
 * 1. **起来先拉快照**（`restoreHostedSnapshot`）：容器的盘是临时的，上一次推上去的那一份
 *    工作区包（WP36 的导出格式）拉回来、导进数据目录，再起服务。**起之前**做——
 *    WP36 那条纪律：一个正在跑的服务进程不许把自己脚下的库换掉；
 * 2. **定时推快照**（`startHostedSnapshotLoop` / `pushHostedSnapshot`）：每 6 小时一次，
 *    收到 SIGTERM（取消订阅 / 平台滚动更新）时再推最后一次；
 * 3. **种两把钥匙**（`seedHostedSecrets`）：托管令牌进 `cloud.workspace_token`、
 *    转发器地址与托管配对进 `chat.relay`——于是模型面与转发器客户端**一行不改**
 *    就走现成的路（`/v1/ai/*` 计积分；`ChatRelayClient` 以 `peer: 'hosted'` 外连）；
 * 4. **模型只走云**（`ensureCloudModelDefault`）：托管实例手上没有商家自己的模型 key
 *    （商家本机推上来的包里的秘密库是商家那把钥匙加密的，这里打不开，也不该打开），
 *    所以默认模型换成「agentsws 云（用积分）」那一条。
 *
 * 商家本机推上来的包（`source = local`）里的秘密库一律删掉：邮箱口令、Shopify 密钥、
 * 模型 key 都是商家那把钥匙加密的，托管实例既打不开也不需要——**最小必要**。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import {
  type HostedBootConfig,
  hostedSnapshotUrl,
  parseHostedEnv,
  SNAPSHOT_PUSH_INTERVAL_MS,
} from '@agentsws/hosted'
import { exportWorkspace, importWorkspace } from './backup.js'
import { CLOUD_TOKEN_SECRET_ID } from './cloud-account.js'
import type { SecretStore } from './secret-store.js'

/** 转发器设置在秘密库里的 id（与 `server.ts` 里 `RELAY_SECRET_ID` 同一个）。 */
export const HOSTED_RELAY_SECRET_ID = 'chat.relay'

/** 托管实例默认模型那一条 provider 的 id。 */
export const HOSTED_CLOUD_PROVIDER_ID = 'agentsws_cloud'

export type HostedFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: Uint8Array },
) => Promise<{
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  arrayBuffer(): Promise<ArrayBuffer>
}>

const defaultFetch: HostedFetch = (input, init) =>
  fetch(input, init as RequestInit) as unknown as ReturnType<HostedFetch>

/** 是不是托管实例；是就回配置。开了开关却缺配置就**抛**——起一个半残的托管实例比不起更糟。 */
export function hostedModeOf(
  env: Record<string, string | undefined>,
): HostedBootConfig | undefined {
  const parsed = parseHostedEnv(env)
  if (parsed === undefined) return undefined
  if (!parsed.ok)
    throw new Error(
      `托管实例缺启动配置：${parsed.missing.join('、')}（这些由 HostedInstanceDO 给）`,
    )
  return parsed.config
}

/** 数据目录里有没有库（有就不导——同一张盘上重起的进程接着用自己的）。 */
function hasData(dataDir: string): boolean {
  if (!existsSync(dataDir)) return false
  return readdirSync(dataDir).some((name) => name.endsWith('.db') || name.endsWith('.sqlite'))
}

/** 删掉秘密库（连 WAL 两个旁文件）。 */
function dropSecrets(dataDir: string): void {
  for (const name of ['secrets.sqlite', 'secrets.sqlite-wal', 'secrets.sqlite-shm'])
    rmSync(join(dataDir, name), { force: true })
}

/**
 * 起来之前：把云端最新那一份拉回来导进数据目录。
 *
 * - 204：云端还没有快照（第一次订阅且商家没推过本机那份）→ 从空库起；
 * - 200：导进去（`force`：盘是新的，但万一残留也以快照为准）；
 *   `source = local`（商家本机推的）就删掉秘密库；
 * - 网络 / 格式出错：**不起空库装没事**——抛出去，容器退出，DO 按退避重起。
 */
export async function restoreHostedSnapshot(input: {
  config: HostedBootConfig
  dataDir: string
  fetch?: HostedFetch
  log?: (line: string) => void
}): Promise<'restored' | 'empty' | 'kept'> {
  const log = input.log ?? (() => {})
  if (hasData(input.dataDir)) {
    log('托管实例：数据目录里已经有库，接着用（不拉快照）')
    return 'kept'
  }
  const res = await (input.fetch ?? defaultFetch)(hostedSnapshotUrl(input.config.cloud_base_url), {
    method: 'GET',
    headers: { Authorization: `Bearer ${input.config.cloud_token}` },
  })
  if (res.status === 204) {
    log('托管实例：云端还没有快照，从空库起')
    return 'empty'
  }
  if (!res.ok) throw new Error(`托管实例：拉快照失败（HTTP ${String(res.status)}）`)
  const stage = mkdtempSync(join(tmpdir(), 'agentsws-hosted-restore-'))
  try {
    const zip = join(stage, 'snapshot.zip')
    writeFileSync(zip, new Uint8Array(await res.arrayBuffer()))
    await importWorkspace({ pkg: zip, dataDir: input.dataDir, force: true })
    if (res.headers.get('x-agentsws-snapshot-source') === 'local') {
      dropSecrets(input.dataDir)
      log('托管实例：导入了商家本机推上来的那一份（秘密库已删，最小必要）')
    } else log('托管实例：导入了上一次自己推上去的那一份')
    return 'restored'
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** 推一份快照上去（导出 → PUT）。回推了多少字节。 */
export async function pushHostedSnapshot(input: {
  config: HostedBootConfig
  dataDir: string
  clock: Clock
  fetch?: HostedFetch
}): Promise<number> {
  const stage = mkdtempSync(join(tmpdir(), 'agentsws-hosted-push-'))
  try {
    const out = join(stage, 'snapshot.zip')
    exportWorkspace({
      dataDir: input.dataDir,
      workspace_id: input.config.workspace_id as WorkspaceId,
      out,
      clock: input.clock,
    })
    const body = new Uint8Array(readFileSync(out))
    const res = await (input.fetch ?? defaultFetch)(
      hostedSnapshotUrl(input.config.cloud_base_url),
      {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${input.config.cloud_token}`,
          'content-type': 'application/zip',
        },
        body,
      },
    )
    if (!res.ok) throw new Error(`托管实例：推快照失败（HTTP ${String(res.status)}）`)
    return body.byteLength
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
}

/** 每 6 小时推一次。回一个停下来的函数。失败只记一行，下一拍再推。 */
export function startHostedSnapshotLoop(input: {
  config: HostedBootConfig
  dataDir: string
  clock: Clock
  fetch?: HostedFetch
  log?: (line: string) => void
  intervalMs?: number
}): () => void {
  const timer = setInterval(() => {
    pushHostedSnapshot(input).then(
      (bytes) => input.log?.(`托管实例：快照已推（${String(bytes)} 字节）`),
      (err: unknown) =>
        input.log?.(`托管实例：${err instanceof Error ? err.message : String(err)}`),
    )
  }, input.intervalMs ?? SNAPSHOT_PUSH_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * 种钥匙：托管令牌与转发器配对进这个品牌的秘密库（每次起来都种——令牌每次起容器都换）。
 * 秘密库没钥匙（不该发生：DO 总会给）就什么都不做，转发器那边会显示「未连接」。
 */
export function seedHostedSecrets(secrets: SecretStore, config: HostedBootConfig): boolean {
  if (!secrets.available) return false
  secrets.put(CLOUD_TOKEN_SECRET_ID, { token: config.cloud_token })
  secrets.put(HOSTED_RELAY_SECRET_ID, {
    endpoint: config.relay_endpoint,
    pairing_token: config.relay_pairing,
  })
  return true
}

/** 哪个品牌接托管：托管的工作区是这家公司的一个品牌就是它，否则是 bootstrap 那一个（空库起）。 */
export function hostedTargetOf(
  config: HostedBootConfig,
  bootstrap: WorkspaceId,
  brands: readonly WorkspaceId[],
): WorkspaceId {
  return brands.includes(config.workspace_id as WorkspaceId)
    ? (config.workspace_id as WorkspaceId)
    : bootstrap
}

/**
 * 默认模型换成「agentsws 云（用积分）」：写 `models.json`（`createModels` 启动时读它）。
 * 已有的别的 provider 留着（没 key，界面上会是 inactive），按用途的指派清掉——
 * 全部落到云那一条上。
 */
export function ensureCloudModelDefault(
  dir: string,
  config: HostedBootConfig,
  defaults: { label: string; model: string; region: 'cn' | 'global' },
): void {
  const file = join(dir, 'models.json')
  let state: {
    version: 1
    providers: { id: string; kind: string; [k: string]: unknown }[]
    defaults: Record<string, unknown>
    tests: Record<string, unknown>
    [k: string]: unknown
  } = { version: 1, providers: [], defaults: {}, tests: {} }
  if (existsSync(file)) {
    try {
      state = { ...state, ...(JSON.parse(readFileSync(file, 'utf8')) as typeof state) }
    } catch {
      // 坏了就从空的来：这个文件只有非秘密的配置
    }
  }
  const existing = state.providers.find((p) => p.kind === 'agentsws_cloud')
  const id = existing?.id ?? HOSTED_CLOUD_PROVIDER_ID
  if (existing === undefined)
    state.providers.push({
      id,
      kind: 'agentsws_cloud',
      label: defaults.label,
      base_url: `${config.cloud_base_url}/v1/ai`,
      model: defaults.model,
      region: defaults.region,
    })
  state.defaults = { ...state.defaults, default: id, by_purpose: {} }
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}
