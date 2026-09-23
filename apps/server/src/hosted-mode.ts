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
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
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

/* ── 商家本机那一侧：订阅 / 看状态 / 取回 / 覆盖（WP128 交付 5） ─────────── */

/** 聊天窗设置页「转发方式」第三项要的那一份（没有任何密钥）。 */
export interface HostedOwnerView {
  /** 云端开没开这项服务（没绑托管对象 / 没这条路由 = false，界面上说「这个节点没开通」）。 */
  available: boolean
  /** 关联过云账号没有（没关联就先去关联，订阅不了）。 */
  linked: boolean
  subscription: {
    status: 'none' | 'active' | 'grace' | 'suspended' | 'cancelling'
    current_cycle_end?: string
    grace_until?: string
    cancel_at_period_end?: boolean
  }
  hosted?: {
    state: 'running' | 'starting' | 'sleeping' | 'stopped'
    last_heartbeat_at?: string
    snapshot?: { at: string; bytes: number; source: 'hosted' | 'local' }
    snapshot_kept_until?: string
    last_error?: string
  }
  /** 取不到时的一句人话（不编一个状态）。 */
  message?: string
}

export type OwnerFetch = (input: string, init: RequestInit) => Promise<Response>

export interface HostedOwnerClientOptions {
  cloud_base_url: string
  /** 商家那把工作区令牌（WP58 存进秘密库的那一把）；每次现取。 */
  token: () => string | undefined
  workspace_id: WorkspaceId
  clock: Clock
  /** 本机数据目录（推「本机这一份」要导出它）。内存档没有。 */
  dataDir?: string
  /** 取回的包落在哪（备份目录，与值守「搬回来」同一条：落盘，不自己导入）。 */
  backupDir?: string
  fetch?: OwnerFetch
}

const NOT_LINKED =
  '还没关联 Agents 工坊账号。去"设置 → 账号与积分"里关联一次，再回来开客服增值服务。'

export function createHostedOwnerClient(options: HostedOwnerClientOptions): {
  status(): Promise<HostedOwnerView>
  subscribe(): Promise<HostedOwnerView>
  cancel(): Promise<HostedOwnerView>
  bringHome(): Promise<{ saved_to?: string; bytes?: number; message: string }>
  seed(): Promise<{ bytes: number; message: string }>
} {
  const base = options.cloud_base_url.replace(/\/+$/, '')
  const doFetch: OwnerFetch = options.fetch ?? ((input, init) => fetch(input, init))
  const call = async (path: string, init: RequestInit = {}): Promise<Response | undefined> => {
    const token = options.token()
    if (token === undefined) return undefined
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${token}`)
    return doFetch(`${base}${path}`, { ...init, headers })
  }
  const empty = (linked: boolean, message?: string): HostedOwnerView => ({
    available: false,
    linked,
    subscription: { status: 'none' },
    ...(message === undefined ? {} : { message }),
  })

  const status = async (): Promise<HostedOwnerView> => {
    if (options.token() === undefined) return empty(false, NOT_LINKED)
    try {
      const sub = await call('/v1/support/subscription')
      if (sub === undefined || sub.status === 404)
        return empty(true, '这个云节点还没开通客服增值服务。')
      if (!sub.ok) return empty(true, `暂时取不到订阅状态（HTTP ${String(sub.status)}）`)
      const subData = ((await sub.json()) as { data: HostedOwnerView['subscription'] }).data
      const view: HostedOwnerView = {
        available: true,
        linked: true,
        subscription: {
          status: subData.status,
          ...(subData.current_cycle_end === undefined
            ? {}
            : { current_cycle_end: subData.current_cycle_end }),
          ...(subData.grace_until === undefined ? {} : { grace_until: subData.grace_until }),
          ...(subData.cancel_at_period_end === undefined
            ? {}
            : { cancel_at_period_end: subData.cancel_at_period_end }),
        },
      }
      const hosted = await call('/v1/support/hosted')
      if (hosted?.ok === true) {
        const data = (
          (await hosted.json()) as {
            data: NonNullable<HostedOwnerView['hosted']> & { workspace_id: string }
          }
        ).data
        if (data.workspace_id !== '')
          view.hosted = {
            state: data.state,
            ...(data.last_heartbeat_at === undefined
              ? {}
              : { last_heartbeat_at: data.last_heartbeat_at }),
            ...(data.snapshot === undefined ? {} : { snapshot: data.snapshot }),
            ...(data.snapshot_kept_until === undefined
              ? {}
              : { snapshot_kept_until: data.snapshot_kept_until }),
            ...(data.last_error === undefined ? {} : { last_error: data.last_error }),
          }
      }
      return view
    } catch {
      return empty(true, '暂时连不上云端（网络不通）。本机的聊天窗照常工作。')
    }
  }

  const change = async (method: 'POST' | 'DELETE'): Promise<HostedOwnerView> => {
    if (options.token() === undefined) return empty(false, NOT_LINKED)
    const res = await call('/v1/support/subscription', { method })
    if (res !== undefined && !res.ok && res.status !== 402) {
      const view = await status()
      return { ...view, message: `没办成（HTTP ${String(res.status)}）。钱一分没动。` }
    }
    return status()
  }

  return {
    status,
    subscribe: () => change('POST'),
    cancel: () => change('DELETE'),
    /** 取回云端那一份：落进备份目录（不自己导入——WP36 那条：跑着的进程不换自己脚下的库）。 */
    bringHome: async () => {
      if (options.token() === undefined) return { message: NOT_LINKED }
      if (options.backupDir === undefined)
        return { message: '这台机器是内存档，没有地方放取回来的那一份。' }
      const res = await call('/v1/support/hosted/snapshot')
      if (res === undefined || res.status === 204)
        return { message: '云端还没有快照（托管实例起来后每 6 小时推一份）。' }
      if (!res.ok) return { message: `取回失败（HTTP ${String(res.status)}）` }
      const bytes = new Uint8Array(await res.arrayBuffer())
      const at = res.headers.get('x-agentsws-snapshot-at') ?? options.clock.now()
      mkdirSync(options.backupDir, { recursive: true })
      const saved_to = join(
        options.backupDir,
        `hosted-${options.workspace_id}-${at.replaceAll(':', '-')}.zip`,
      )
      writeFileSync(saved_to, bytes)
      return {
        saved_to,
        bytes: bytes.byteLength,
        message:
          '云端那一份已经放进备份目录。要用它替换本机：先关掉 Agents 工坊，再用「导入」把这个包导进来。',
      }
    },
    /** 用本机这一份覆盖云端：托管实例下次起来就用它（知识、话术、聊天窗设置跟着上去）。 */
    seed: async () => {
      if (options.token() === undefined) return { bytes: 0, message: NOT_LINKED }
      if (options.dataDir === undefined)
        return { bytes: 0, message: '这台机器是内存档，没有可推的那一份。' }
      const stage = mkdtempSync(join(tmpdir(), 'agentsws-hosted-seed-'))
      try {
        const out = join(stage, 'local.zip')
        exportWorkspace({
          dataDir: options.dataDir,
          workspace_id: options.workspace_id,
          out,
          clock: options.clock,
        })
        const body = new Uint8Array(readFileSync(out))
        const res = await call('/v1/support/hosted/snapshot', {
          method: 'PUT',
          headers: { 'content-type': 'application/zip' },
          body,
        })
        if (res === undefined || !res.ok)
          return { bytes: 0, message: `推上去没成功（HTTP ${String(res?.status ?? 0)}）` }
        return {
          bytes: body.byteLength,
          message: '本机这一份已经推上去了。托管实例下次重起就用它（秘密库不带上去）。',
        }
      } finally {
        rmSync(stage, { recursive: true, force: true })
      }
    },
  }
}
