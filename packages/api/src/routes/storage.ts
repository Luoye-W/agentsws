/**
 * 数据后端（41 §2.4「一键选与技术入口」）。
 *
 * 三条不可让步的边界，与连接面（20）逐字相同：
 *
 * 1. **凭据只走 `POST /v1/storage/backend` 这一条路，而且只走一次。**
 *    请求体里的连接串与 access key 由处理器原样交给端口，端口写进本机加密库，
 *    然后没有任何一处再持有它：不进事件日志、不进 trace、不进响应体、不进 OpenAPI 示例，
 *    也永远不会出现在 `GET /v1/storage` 里。
 * 2. **`GET /v1/storage` 永不含凭据。** 只有「现在用的是哪一档、多大、上次备份什么时候」，
 *    以及给运维看的**脱敏后**后端描述（主机与库名，没有用户名密码）。
 * 3. **网关里不写业务**（28 §2）：怎么连、怎么测、怎么迁，全在 `apps/server` 装配的
 *    `StoragePort` 里；这一层只做路由声明、权限判定与信封。
 *
 * 权限：读走 `store_config.read@workspace`；改与迁移走 `policy.stage@workspace`
 * ——换数据后端是整个工作区的事，客服岗位看不到也改不了。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'storage'

// ── 端口类型（apps/server 实现）────────────────────────────────────────

/** 41 §2 的三档。`managed` 只有说明页，不建集群（WP40 范围）。 */
export type StorageTier = 'local' | 'byo_cloud' | 'managed'

/** 一个后端的对外形状。**这里没有、也不会有任何凭据字段。** */
export interface StorageBackendView {
  /** `sqlite` / `postgres`；对象存储是 `local` / `s3`。 */
  kind: string
  /** 脱敏后的位置：SQLite 是路径，Postgres 是 `主机:端口/库名`，S3 是 `endpoint/bucket`。 */
  display: string
  /** 占用（字节）；算不出来就不出这一格，别用 0 冒充。 */
  bytes?: number
  /** 对象存储专有：对象个数。 */
  objects?: number
  /** 大文件这一档是不是加密的（21 §4 的每对象密钥）。 */
  encrypted?: boolean
}

export interface StorageView {
  tier: StorageTier
  database: StorageBackendView
  blobs: StorageBackendView
  /** 上一次备份成功的时间；从没备份过就不出这一格。 */
  last_backup_at?: string
  /** 迁移之后旧后端只读保留到什么时候（41 §2.2 的 7 天）。 */
  previous_backend_readonly_until?: string
  /** 「高级」一栏：当前生效的环境变量**名与脱敏值**（凭据类只出「已设置」）。 */
  env: { name: string; value: string; secret: boolean }[]
  /** compose 文件在仓库里的位置，给想自己改的人。 */
  compose_url: string
}

export interface StorageTestResult {
  ok: boolean
  /** 失败时给人话（「连不上」「用户名密码不对」「桶不存在」）。 */
  reason?: string
  /** 成功时给一点点证据：版本号、桶里有几个对象。 */
  detail?: string
}

export interface StorageMigrationView {
  id: string
  state: 'running' | 'done' | 'failed'
  /** 走到哪一步了：导出 → 导入 → 切换 → 旧后端转只读。 */
  step: 'export' | 'import' | 'switch' | 'retire' | 'finished'
  started_at: string
  finished_at?: string
  /** 导了多少条 / 多少字节，给人看的进度。 */
  exported_records?: number
  exported_bytes?: number
  reason?: string
  /** 旧后端只读保留到什么时候。 */
  previous_readonly_until?: string
}

/**
 * 凭据只在这个形状里出现一次，然后进本机加密库。
 *
 * 每个字段都显式带 `| undefined`：`exactOptionalPropertyTypes` 下，
 * zod 解析出来的可选字段就是这个形状，不写就得在每个调用点抖一次 spread。
 */
export interface StorageBackendInput {
  database_url?: string | undefined
  blob_endpoint?: string | undefined
  blob_bucket?: string | undefined
  blob_region?: string | undefined
  blob_prefix?: string | undefined
  blob_access_key_id?: string | undefined
  blob_secret_access_key?: string | undefined
}

export interface StoragePort {
  /** 当前后端、大小、上次备份。**永不含凭据。** */
  current(workspace_id: string): Promise<StorageView>
  /** 测连接：不落库、不切换，只是连一下再断开。 */
  test(
    input: StorageBackendInput,
  ): Promise<{ database?: StorageTestResult; blobs?: StorageTestResult }>
  /** 把凭据写进本机加密库（不生效，等 `migrate` 或重启）。返回存了哪些**字段名**。 */
  save(input: StorageBackendInput): Promise<{ saved_fields: string[] }>
  /** 迁移：export → import 到新后端 → 切换 → 旧后端只读保留 7 天。 */
  migrate(input: { workspace_id: string; by: string }): Promise<StorageMigrationView>
  /** 迁移进度（前端轮询）。 */
  migration(id: string): Promise<StorageMigrationView | undefined>
}

// ── 请求体 ────────────────────────────────────────────────────────────

/**
 * 连接串与 access key。**校验只看形状，不看值**——
 * zod 的 issue 里只有 path 与 message，值一个字节都不会出现在错误信封里。
 */
const BackendBody = z.object({
  database_url: z
    .string()
    .min(1)
    .max(2000)
    .regex(/^postgres(ql)?:\/\//, 'Postgres 连接串要以 postgres:// 开头')
    .optional(),
  blob_endpoint: z.string().url().max(500).optional(),
  blob_bucket: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[a-z0-9][a-z0-9.-]*$/, '桶名只能是小写字母、数字、点与连字符')
    .optional(),
  blob_region: z.string().max(60).optional(),
  blob_prefix: z.string().max(200).optional(),
  blob_access_key_id: z.string().min(1).max(500).optional(),
  blob_secret_access_key: z.string().min(1).max(500).optional(),
})

const MigrateBody = z.object({
  /** 明确确认：迁移会切换整个工作区的后端，不是一个可以顺手点的按钮。 */
  confirm: z.literal(true),
})

function port(deps: { storage?: StoragePort }): StoragePort {
  if (deps.storage === undefined) {
    throw new ApiError('not_implemented', '这个服务进程没有装配数据后端面')
  }
  return deps.storage
}

export function storageRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/storage',
        operationId: 'getStorage',
        summary: '当前数据后端、占用、上次备份',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: '{ tier, database, blobs, last_backup_at?, env, compose_url }（**永不含凭据**）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        return ok(c, await port(deps).current(p.workspace_id))
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/storage/test',
        operationId: 'testStorageBackend',
        summary: '测一下这套连接串 / 桶能不能用（不落库、不切换）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: BackendBody,
        returns: '{ database?: { ok, reason?, detail? }, blobs?: { … } }',
      },
      async (c, deps) => {
        assignmentOf(c)
        const input = await body(c, BackendBody)
        return ok(c, await port(deps).test(input))
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/storage/backend',
        operationId: 'saveStorageBackend',
        summary: '把数据后端的配置与凭据存进本机加密库（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: BackendBody,
        returns: '{ saved_fields }（只有**字段名**；值永远不回来）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const input = await body(c, BackendBody)
        const out = await port(deps).save(input)
        // 21 §1：谁在什么时候改了数据后端必须看得见；**值一个字节都不进日志**
        deps.eventLog.append?.({
          schema_version: 1,
          workspace_id: p.workspace_id,
          type: 'storage.backend_configured',
          actor: { kind: 'person', id: p.person_id },
          correlation: { trace_id: c.get('rctx').trace_id },
          payload: { fields: out.saved_fields },
        })
        return ok(c, out)
      },
    ),

    route(
      {
        method: 'post',
        path: '/v1/storage/migrate',
        operationId: 'migrateStorage',
        summary: '迁移到已保存的新后端：导出 → 导入 → 切换 → 旧后端只读留 7 天（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        body: MigrateBody,
        returns: '{ id, state, step, … }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        await body(c, MigrateBody)
        const out = await port(deps).migrate({
          workspace_id: p.workspace_id,
          by: p.person_id,
        })
        deps.eventLog.append?.({
          schema_version: 1,
          workspace_id: p.workspace_id,
          type: 'storage.migration_started',
          actor: { kind: 'person', id: p.person_id },
          correlation: { trace_id: c.get('rctx').trace_id },
          payload: { migration_id: out.id },
        })
        return ok(c, out)
      },
    ),

    route(
      {
        method: 'get',
        path: '/v1/storage/migrations/:id',
        operationId: 'getStorageMigration',
        summary: '迁移进度',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [{ name: 'id', in: 'path', required: true, description: '迁移 id' }],
        returns: '{ id, state, step, exported_records?, … }',
      },
      async (c, deps) => {
        assignmentOf(c)
        const id = c.req.param('id') ?? ''
        const found = await port(deps).migration(id)
        if (found === undefined) throw new ApiError('not_found', `没有这次迁移：${id}`)
        return ok(c, found)
      },
    ),
  ]
}
