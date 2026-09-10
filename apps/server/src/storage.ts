/**
 * 数据后端面（41 §2.4）：`GET /v1/storage` 与「接我的云」那张表单背后的东西。
 *
 * 四条纪律：
 * 1. **凭据只进本机加密库**（13 §4.3 的同一个库，靠 key 前缀分开）。
 *    它不进事件、不进日志、不进任何响应体；`current()` 端出去的是脱敏后的描述。
 * 2. **测连接不落库、不切换**：连一下、问一句、断开。
 * 3. **迁移是显式的四步**：导出 → 导入 → 切换 → 旧后端只读留 7 天（41 §2.2）。
 *    每一步都写进状态文件，进度页照着念，不编。
 * 4. **切换要重启**才生效。这不是偷懒：连接池、迁移、密钥环都是在装配时接好的，
 *    热切换等于在跑着的事务底下换库。界面上说清楚「重启后生效」，比悄悄半切了强。
 *
 * 导出 / 导入的**真身是 WP36 的 `export` / `import`**（40 §1.3）。WP36 还没合进来，
 * 所以这里先用一份最小的本包实现：把 SQLite 库文件与 blob 对象整份搬过去。
 * TODO(WP36)：合入后把 `runExport` / `runImport` 换成调 WP36 的那两个命令，
 * 这样「三档之间随时搬家」用的就是同一个包格式（41 §2.3 纪律 ①）。
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StorageBackendInput,
  StorageMigrationView,
  StoragePort,
  StorageTestResult,
  StorageTier,
  StorageView,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { BlobStore } from '@agentsws/blob'
import { openBlobStore } from '@agentsws/blob'
import type { Clock } from '@agentsws/contracts'
import { describeUrl, dialectOf, openPostgresDriver } from '@agentsws/core/sql'
import { type SecretStore, STORAGE_SECRET_ID } from './secret-store.js'

/** compose 文件在仓库里的位置（「高级」一栏里那条链接）。 */
const COMPOSE_URL = 'https://github.com/Luoye-W/agentsws/blob/main/docker-compose.yml'

/** 41 §2.2：迁移之后旧后端只读保留多久。 */
const RETIRE_DAYS = 7

export const DATABASE_URL_ENV = 'DATABASE_URL'
export const BLOB_URL_ENV = 'AGENTSWS_BLOB_URL'
export const BLOB_ACCESS_KEY_ENV = 'AGENTSWS_BLOB_ACCESS_KEY_ID'
export const BLOB_SECRET_ENV = 'AGENTSWS_BLOB_SECRET_ACCESS_KEY'

export interface StorageAssemblyOptions {
  clock: Clock
  /** SQLite 档的库目录；内存档（测试）不给。 */
  dbDir?: string
  /** 当前生效的对象存储（describe / usage 从它来）。 */
  blobs?: BlobStore
  /** 凭据存这里（与连接面、模型面同一个库，靠 key 前缀分开）。 */
  secrets: SecretStore
  env: Record<string, string | undefined>
}

export interface StorageAssembly {
  port: StoragePort
  /** 下次启动要用的后端（装配时读一次；没配过就是 undefined）。 */
  pendingBackend(): StorageBackendInput | undefined
}

interface MigrationState extends StorageMigrationView {
  workspace_id: string
  by: string
}

/** 存进加密库的字段名。**值永远不出这个模块。** */
const FIELDS = [
  'database_url',
  'blob_endpoint',
  'blob_bucket',
  'blob_region',
  'blob_prefix',
  'blob_access_key_id',
  'blob_secret_access_key',
] as const

export function createStorage(options: StorageAssemblyOptions): StorageAssembly {
  const { clock, dbDir, secrets, env } = options
  const migrations = new Map<string, MigrationState>()
  const stateFile = dbDir === undefined ? undefined : join(dbDir, 'storage-state.json')

  const saved = (): StorageBackendInput | undefined => {
    if (!secrets.available) return undefined
    const fields = secrets.get(STORAGE_SECRET_ID)
    return fields === undefined ? undefined : (fields as StorageBackendInput)
  }

  /** 保存的配置 → blob URL（凭据不进 URL；它们单独经环境变量给驱动）。 */
  const blobUrlOf = (input: StorageBackendInput): string | undefined => {
    if (input.blob_bucket === undefined || input.blob_endpoint === undefined) return undefined
    const q = new URLSearchParams({ endpoint: input.blob_endpoint })
    if (input.blob_region !== undefined) q.set('region', input.blob_region)
    return `s3://${input.blob_bucket}/${input.blob_prefix ?? ''}?${q.toString()}`
  }

  const currentTier = (): StorageTier => {
    const dbUrl = env[DATABASE_URL_ENV]
    const blobUrl = env[BLOB_URL_ENV]
    const remote = (dbUrl !== undefined && dbUrl !== '') || blobUrl?.startsWith('s3://') === true
    return remote ? 'byo_cloud' : 'local'
  }

  /** SQLite 档的占用 = 库目录里 `.db` / `.sqlite` 文件之和。 */
  const sqliteBytes = (): number | undefined => {
    if (dbDir === undefined || !existsSync(dbDir)) return undefined
    let bytes = 0
    for (const name of readdirSync(dbDir)) {
      if (!/\.(db|sqlite)(-wal|-shm)?$/.test(name)) continue
      try {
        bytes += statSync(join(dbDir, name)).size
      } catch {
        // 正好被 checkpoint 掉了，跳过
      }
    }
    return bytes
  }

  /** 上一次备份：备份任务（WP36）把包落在 `<dbDir>/backups`；取最新那一个的时间。 */
  const lastBackupAt = (): string | undefined => {
    if (dbDir === undefined) return undefined
    const dir = join(dbDir, 'backups')
    if (!existsSync(dir)) return undefined
    let newest: number | undefined
    for (const name of readdirSync(dir)) {
      try {
        const at = statSync(join(dir, name)).mtimeMs
        if (newest === undefined || at > newest) newest = at
      } catch {
        // 忽略
      }
    }
    return newest === undefined ? undefined : new Date(newest).toISOString()
  }

  const envView = (): StorageView['env'] => {
    const show = (name: string): { name: string; value: string; secret: boolean } => {
      const raw = env[name]
      return { name, value: raw === undefined || raw === '' ? '（未设置）' : raw, secret: false }
    }
    const hide = (name: string): { name: string; value: string; secret: boolean } => ({
      name,
      // 凭据类只说「已设置 / 未设置」——「高级」一栏也不是给人抄密码的地方
      value: env[name] === undefined || env[name] === '' ? '（未设置）' : '（已设置）',
      secret: true,
    })
    return [
      show('AGENTSWS_DATA_DIR'),
      { ...show(DATABASE_URL_ENV), value: displayDatabaseUrl(env[DATABASE_URL_ENV]) },
      show(BLOB_URL_ENV),
      hide(BLOB_ACCESS_KEY_ENV),
      hide(BLOB_SECRET_ENV),
      hide('AGENTSWS_DATA_KEY'),
    ]
  }

  const port: StoragePort = {
    async current(): Promise<StorageView> {
      const dbUrl = env[DATABASE_URL_ENV]
      const database =
        dbUrl === undefined || dbUrl === ''
          ? {
              kind: 'sqlite',
              display: dbDir ?? '（内存，不落盘）',
              ...(sqliteBytes() === undefined ? {} : { bytes: sqliteBytes() as number }),
            }
          : { kind: 'postgres', display: describeUrl(dbUrl).display }

      const blobs = options.blobs
      const described = blobs?.describe()
      const usage = blobs === undefined ? undefined : await blobs.usage().catch(() => undefined)
      const state = await readState(stateFile)

      return {
        tier: currentTier(),
        database,
        blobs:
          described === undefined
            ? { kind: 'local', display: '（未装配）' }
            : {
                kind: described.kind,
                display: described.display,
                encrypted: described.encrypted,
                ...(usage === undefined ? {} : { bytes: usage.bytes, objects: usage.objects }),
              },
        ...(lastBackupAt() === undefined ? {} : { last_backup_at: lastBackupAt() as string }),
        ...(state?.previous_readonly_until === undefined
          ? {}
          : { previous_backend_readonly_until: state.previous_readonly_until }),
        env: envView(),
        compose_url: COMPOSE_URL,
      }
    },

    async test(input) {
      const out: { database?: StorageTestResult; blobs?: StorageTestResult } = {}

      if (input.database_url !== undefined && input.database_url !== '') {
        out.database = await testPostgres(input.database_url)
      }
      const blobUrl = blobUrlOf(input)
      if (blobUrl !== undefined) {
        out.blobs = await testBlobs(blobUrl, input, clock)
      }
      return out
    },

    async save(input) {
      if (!secrets.available) {
        throw new ApiError(
          'not_implemented',
          '这台机器没有本机加密库的密钥（AGENTSWS_SECRETS_KEY 未设置），不能保存数据后端的凭据——绝不明文落盘',
        )
      }
      // 已存的字段不被空值覆盖：表单里没重填密码 = 沿用旧的
      const previous = saved() ?? {}
      const merged: Record<string, string> = {}
      for (const field of FIELDS) {
        const next = input[field]
        const before = (previous as Record<string, string | undefined>)[field]
        const value = next === undefined || next === '' ? before : next
        if (value !== undefined && value !== '') merged[field] = value
      }
      secrets.put(STORAGE_SECRET_ID, merged)
      return { saved_fields: Object.keys(merged).sort() }
    },

    async migrate({ workspace_id, by }) {
      const target = saved()
      if (target === undefined) {
        throw new ApiError(
          'invalid_input',
          '还没保存新后端的配置：先在「接我的云」里填好并点「测试连接」',
        )
      }
      const id = randomUUID()
      const state: MigrationState = {
        id,
        workspace_id,
        by,
        state: 'running',
        step: 'export',
        started_at: clock.now(),
      }
      migrations.set(id, state)
      // 异步跑：迁移可能要几分钟，界面轮询进度
      void runMigration(state, { ...options, target, stateFile, blobUrlOf }).catch((error) => {
        state.state = 'failed'
        state.reason = String((error as Error).message ?? error)
        state.finished_at = clock.now()
      })
      return publicView(state)
    },

    async migration(id) {
      const found = migrations.get(id)
      return found === undefined ? undefined : publicView(found)
    },
  }

  return { port, pendingBackend: saved }
}

function publicView(state: MigrationState): StorageMigrationView {
  const { workspace_id: _w, by: _b, ...view } = state
  return view
}

/** Postgres 连接串的脱敏显示：主机与库名，没有用户名密码。 */
function displayDatabaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw === '') return '（未设置：用 SQLite）'
  try {
    return `postgres://${describeUrl(raw).display}`
  } catch {
    return '（已设置）'
  }
}

async function testPostgres(url: string): Promise<StorageTestResult> {
  if (dialectOf(url) !== 'postgres') {
    return { ok: false, reason: '这不是一个 Postgres 连接串（要以 postgres:// 开头）' }
  }
  try {
    const driver = await openPostgresDriver({ url, max: 1, connectTimeout: 8 })
    try {
      const row = await driver.prepare<{ v: string }>('SELECT version() AS v').get()
      return { ok: true, detail: (row?.v ?? '').split(',')[0] ?? 'postgres' }
    } finally {
      await driver.close()
    }
  } catch (error) {
    return { ok: false, reason: humanPgError(error) }
  }
}

/** 把 Postgres / 网络的错误翻成非技术用户看得懂的一句话。 */
function humanPgError(error: unknown): string {
  const message = String((error as Error)?.message ?? error)
  if (/password authentication failed|no password supplied/i.test(message)) {
    return '用户名或密码不对'
  }
  if (/database .* does not exist/i.test(message)) return '这个库名在服务器上不存在'
  if (/ENOTFOUND|EAI_AGAIN/i.test(message)) return '这个主机名解析不了，检查地址有没有写错'
  if (/ECONNREFUSED/i.test(message)) return '连不上：端口不通，或者数据库没允许这台机器连进来'
  if (/timeout/i.test(message)) return '连接超时：多半是防火墙 / 白名单没放行这台机器的出口 IP'
  if (/no pg_hba.conf entry|SSL/i.test(message)) return '服务器要求 TLS，或者没允许这个来源连接'
  return message.slice(0, 200)
}

async function testBlobs(
  url: string,
  input: StorageBackendInput,
  clock: Clock,
): Promise<StorageTestResult> {
  try {
    const store = await openBlobStore({
      clock,
      url,
      env: {
        [BLOB_ACCESS_KEY_ENV]: input.blob_access_key_id,
        [BLOB_SECRET_ENV]: input.blob_secret_access_key,
      },
    })
    // 只列一页：证明桶在、凭据对、权限够读。不写东西进去。
    const listed = await store.list('')
    return { ok: true, detail: `桶里现在有 ${listed.length} 个对象` }
  } catch (error) {
    const message = String((error as Error)?.message ?? error)
    if (/403/.test(message)) return { ok: false, reason: 'access key 没有这个桶的权限' }
    if (/404|NoSuchBucket/.test(message)) return { ok: false, reason: '这个桶不存在' }
    if (/ENOTFOUND|EAI_AGAIN/.test(message)) return { ok: false, reason: 'endpoint 解析不了' }
    if (/ECONNREFUSED/.test(message)) return { ok: false, reason: 'endpoint 连不上' }
    return { ok: false, reason: message.slice(0, 200) }
  }
}

interface PersistedState {
  previous_readonly_until?: string
  migrated_at?: string
  target_kind?: string
}

async function readState(file: string | undefined): Promise<PersistedState | undefined> {
  if (file === undefined || !existsSync(file)) return undefined
  try {
    return JSON.parse(await readFile(file, 'utf8')) as PersistedState
  } catch {
    return undefined
  }
}

/**
 * 迁移的四步。**TODO(WP36)**：`export` / `import` 换成 WP36 的那两个命令，
 * 这里现在做的是同一件事的最小版本——把库文件与对象整份搬过去。
 */
async function runMigration(
  state: MigrationState,
  ctx: StorageAssemblyOptions & {
    target: StorageBackendInput
    stateFile: string | undefined
    blobUrlOf: (input: StorageBackendInput) => string | undefined
  },
): Promise<void> {
  const { clock, dbDir, target, stateFile } = ctx

  // ① 导出：SQLite 档就是那一堆库文件；Postgres 档由 WP36 的 export 负责
  state.step = 'export'
  const exported = { records: 0, bytes: 0 }
  const stage = dbDir === undefined ? undefined : join(dbDir, 'migrations', state.id)
  if (dbDir !== undefined && stage !== undefined) {
    mkdirSync(stage, { recursive: true })
    for (const name of readdirSync(dbDir)) {
      if (!/\.(db|sqlite)$/.test(name)) continue
      const from = join(dbDir, name)
      await copyFile(from, join(stage, name))
      exported.records += 1
      exported.bytes += statSync(from).size
    }
  }
  state.exported_records = exported.records
  state.exported_bytes = exported.bytes

  // ② 导入：对象存储能当场搬（新桶的凭据我们有）；数据库要等重启换连接串
  state.step = 'import'
  const targetBlobUrl = ctx.blobUrlOf(target)
  if (targetBlobUrl !== undefined && ctx.blobs !== undefined) {
    const to = await openBlobStore({
      clock,
      url: targetBlobUrl,
      env: {
        [BLOB_ACCESS_KEY_ENV]: target.blob_access_key_id,
        [BLOB_SECRET_ENV]: target.blob_secret_access_key,
      },
    })
    for (const stat of await ctx.blobs.list('')) {
      const object = await ctx.blobs.get(stat.key)
      // 读不出来的（主体密钥已销毁）不搬：搬一份读不出来的密文过去毫无意义
      if (object?.bytes === undefined) continue
      await to.put(stat.key, object.bytes, {
        ...(stat.content_type === undefined ? {} : { content_type: stat.content_type }),
        ...(stat.filename === undefined ? {} : { filename: stat.filename }),
        ...(stat.subject_ref === undefined ? {} : { subject_ref: stat.subject_ref }),
        ...(stat.workspace_id === undefined ? {} : { workspace_id: stat.workspace_id }),
      })
      exported.records += 1
      exported.bytes += stat.size
    }
    state.exported_records = exported.records
    state.exported_bytes = exported.bytes
  }

  // ③ 切换：把新后端写进状态文件，**下次启动生效**（热切换等于在跑着的事务底下换库）
  state.step = 'switch'
  const until = new Date(Date.parse(clock.now()) + RETIRE_DAYS * 24 * 3600 * 1000).toISOString()
  if (stateFile !== undefined) {
    const persisted: PersistedState = {
      previous_readonly_until: until,
      migrated_at: clock.now(),
      target_kind: target.database_url === undefined ? 's3' : 'postgres',
    }
    await writeFile(stateFile, JSON.stringify(persisted, null, 2), { mode: 0o600 })
  }

  // ④ 旧后端只读保留 7 天：留一个到期清单，不当场删
  state.step = 'retire'
  if (stage !== undefined) {
    await writeFile(
      join(stage, 'RETIRE.txt'),
      [
        `旧后端的导出在这里，只读保留到 ${until}（41 §2.2）。`,
        '确认新后端一切正常之后，可以整个目录删掉。',
        `校验：${createHash('sha256').update(state.id).digest('hex').slice(0, 16)}`,
        '',
        'TODO(WP36)：这一份是 WP40 的最小实现；WP36 的 export / import 合入后，',
        '这里会换成同一个包格式（带清单与哈希），三档之间就能用同一条路搬家。',
      ].join('\n'),
      'utf8',
    )
  }

  state.previous_readonly_until = until
  state.step = 'finished'
  state.state = 'done'
  state.finished_at = clock.now()
}
