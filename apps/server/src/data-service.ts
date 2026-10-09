/**
 * WP192（docs/83 §4、docs/75）：官方数据接口统一能力口的**本机那一头**。
 *
 * 本机只认能力，不认上游。一项能力走哪条来源由设置里的数据来源路由决定
 * （`data_source_routing` 的键 `data.<能力>`，默认只有「Agents 工坊（用积分）」一级）：
 *
 * | 级 | 这一版怎么走 |
 * |---|---|
 * | `byo_source`（自带数据接口） | 这些能力本机还没有自带适配器——当「没配」，落下一级 |
 * | `workshop`（Agents 工坊，用积分） | 关联了账号就转给云上 `/v1/data/*`；没关联当「没配」 |
 *
 * 都没有就回一句人话（`not_implemented`），不编数据。云上那句人话（402 积分不够、501 还没开通……）
 * 原样带回去；连不上是「稍后再试」。令牌只在 `cloud.call` 那一跳进头。
 */
import type { DataServiceActor, DataServiceApiPort } from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type {
  DataCallResult,
  DataCapabilityList,
  DataSourceLevel,
  DataTaskItemsPage,
  DataTaskView,
  WorkspaceId,
} from '@agentsws/contracts'
import { DATA_SERVICE_CLOUD_PATHS } from '@agentsws/contracts'
import type { CloudAssembly } from './cloud.js'
import type { KolCloudCall } from './kol-cloud-sync.js'

/** 同步调用要等上游（搜索结果页、外链列表……），比读余额的 8 秒长。 */
export const DATA_CALL_TIMEOUT_MS = 60_000

const NOT_LINKED =
  '这项数据要用「Agents 工坊官方数据接口」（扣积分），先去"设置 → 账号与积分"里关联一次账号。'

/** 这项能力按路由走得到哪一级：`workshop` 或者谁都没有。 */
export function dataLevelOf(
  cloud: Pick<CloudAssembly, 'dataRouteOf' | 'linked'>,
  capability: string,
): { level: DataSourceLevel } | { level: undefined; reason: string } {
  const route = cloud.dataRouteOf(capability)
  let sawWorkshop = false
  for (const level of route.order) {
    if (route.disabled.includes(level)) continue
    // 自带数据接口：这些能力本机还没有适配器，当「没配」处理，落下一级
    if (level === 'workshop') {
      sawWorkshop = true
      if (cloud.linked()) return { level }
    }
  }
  return {
    level: undefined,
    reason: sawWorkshop
      ? NOT_LINKED
      : '这项数据的来源都关掉了。去连接页「数据从哪里来」打开「Agents 工坊官方数据接口」。',
  }
}

/** 云上那一跳的失败 → 一句人话 + 一个本机的码（云上的话原样带回）。 */
function unwrap<T>(res: KolCloudCall<T>, action: string): T {
  if (res.ok && res.data !== undefined) return res.data
  const said = res.message
  if (res.status === 0)
    throw new ApiError('provider_unavailable', `云上暂时${action}不了（联系不上），稍后再试一次。`)
  if (res.status === 402)
    throw new ApiError('budget_exhausted', said ?? '积分不够了，去"账号与积分"里充值后再试。')
  if (res.status === 404) throw new ApiError('not_found', said ?? '没有这项能力或这个任务。')
  if (res.status === 410) throw new ApiError('not_found', said ?? '结果过了保留期，已经删了。')
  if (res.status === 429)
    throw new ApiError('rate_limited', said ?? '今天的次数到上限了，明天再试或联系我们调高。')
  if (res.status === 409) throw new ApiError('conflict', said ?? '任务还没跑完，结果还取不到。')
  if (res.status === 501) throw new ApiError('not_implemented', said ?? '这项数据还没有开通。')
  if (res.status >= 500)
    throw new ApiError('provider_unavailable', said ?? `云上这一次没有${action}成，稍后再试。`)
  throw new ApiError('invalid_input', said ?? `云上没答应这一次${action}。`)
}

/** 一个品牌的数据能力口（云客户端那一份按品牌取）。 */
export function createDataService(cloud: CloudAssembly): {
  capabilities(): Promise<DataCapabilityList>
  call(
    capability: string,
    input: { input: Record<string, unknown>; fresh?: boolean },
  ): Promise<DataCallResult>
  submit(input: {
    capability: string
    input: Record<string, unknown>
    max_items?: number
    idempotency_key?: string
  }): Promise<DataTaskView>
  task(id: string): Promise<DataTaskView>
  items(id: string, cursor?: string): Promise<DataTaskItemsPage>
  cancel(id: string): Promise<DataTaskView>
} {
  const need = (capability: string): void => {
    const got = dataLevelOf(cloud, capability)
    if (got.level === undefined) throw new ApiError('not_implemented', got.reason)
  }
  const linked = (): void => {
    if (!cloud.linked()) throw new ApiError('not_implemented', NOT_LINKED)
  }
  const tasks = DATA_SERVICE_CLOUD_PATHS.tasks
  return {
    async capabilities() {
      linked()
      return unwrap(
        await cloud.call<DataCapabilityList>(DATA_SERVICE_CLOUD_PATHS.capabilities),
        '取能力清单',
      )
    },
    async call(capability, input) {
      need(capability)
      return unwrap(
        await cloud.call<DataCallResult>(
          `${DATA_SERVICE_CLOUD_PATHS.call}/${encodeURIComponent(capability)}`,
          { method: 'POST', body: input, timeout_ms: DATA_CALL_TIMEOUT_MS },
        ),
        '查',
      )
    },
    async submit(input) {
      need(input.capability)
      return unwrap(
        await cloud.call<DataTaskView>(tasks, {
          method: 'POST',
          body: {
            ...input,
            // 没给幂等键就现生成一个：这一次提交自己不会重发，但云上要求必须有
            idempotency_key: input.idempotency_key ?? `local-${crypto.randomUUID()}`,
          },
          timeout_ms: DATA_CALL_TIMEOUT_MS,
        }),
        '提交任务',
      )
    },
    async task(id) {
      linked()
      return unwrap(await cloud.call<DataTaskView>(`${tasks}/${encodeURIComponent(id)}`), '查任务')
    },
    async items(id, cursor) {
      linked()
      const q = cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`
      return unwrap(
        await cloud.call<DataTaskItemsPage>(`${tasks}/${encodeURIComponent(id)}/items${q}`, {
          timeout_ms: DATA_CALL_TIMEOUT_MS,
        }),
        '取结果',
      )
    },
    async cancel(id) {
      linked()
      return unwrap(
        await cloud.call<DataTaskView>(`${tasks}/${encodeURIComponent(id)}/cancel`, {
          method: 'POST',
        }),
        '取消任务',
      )
    },
  }
}

/** 按工作区（品牌）取那一份云客户端，拼成本机 API 那一面。 */
export function dataServiceApiPort(
  cloudOf: (workspace_id: WorkspaceId) => Promise<CloudAssembly>,
): DataServiceApiPort {
  const of = async (actor: DataServiceActor) =>
    createDataService(await cloudOf(actor.workspace_id as WorkspaceId))
  return {
    capabilities: async (actor) => (await of(actor)).capabilities(),
    call: async (actor, capability, input) => (await of(actor)).call(capability, input),
    submit: async (actor, input) => (await of(actor)).submit(input),
    task: async (actor, id) => (await of(actor)).task(id),
    items: async (actor, id, cursor) => (await of(actor)).items(id, cursor),
    cancel: async (actor, id) => (await of(actor)).cancel(id),
  }
}
