/**
 * WP66（52 O1）：**按请求的 `workspace_id` 取模块**的那一处适配层。
 *
 * 一句话职责：把"进程装配的一个端口对象"换成"按 `actor.workspace_id` 现取的那一个"。
 *
 * 为什么收在这一个文件里：网关那一层不写业务（28 §2），而"这次请求该用哪个品牌的
 * 连接 / 模型 / 数据"是装配的事。散在每条路由里判断一次，漏掉一条就是一次串味；
 * 收在这里，`createServer` 里就只剩一行 `connections: brandConnectionsPort(brands)`。
 *
 * 判据只有一条：**每个端口方法的第一个参数都是 `actor`**（`ConnectionsActor` /
 * `ModelsActor` / `WorkActor` / …），而 `actor.workspace_id` 是网关鉴权之后解析出来的
 * 主体（20 §3），不是请求体里的一个字段、也不是路径参数。品牌 A 的令牌换不出
 * 品牌 B 的模块。没有 actor 的那几条（`runtime()` / `configured()`）在下面各自
 * 写清楚为什么走 bootstrap。
 */
import type {
  AskPort,
  CloudPort,
  ConnectionsPort,
  ModelDefaultsView,
  ModelsPort,
  WorkPort,
  WorkstationPort,
} from '@agentsws/api'
import { ApiError } from '@agentsws/api'
import type { ObjectRef, WorkspaceId } from '@agentsws/contracts'
import type { BrandModules } from './brand-modules.js'

/** 跟随公司默认时不许从这个品牌改设置——改了等于悄悄改了公司那一份。 */
const INHERITING =
  '这个品牌正在「跟随公司默认」。要单独设置，先在设置页把那个开关关掉；' +
  '要改公司默认，请切到公司默认那个品牌去改。'

/** 第一个参数看着像 actor 的话，取它的 `workspace_id`。 */
function workspaceOf(arg: unknown): WorkspaceId | undefined {
  if (arg === null || typeof arg !== 'object') return undefined
  const ws = (arg as { workspace_id?: unknown }).workspace_id
  return typeof ws === 'string' ? (ws as WorkspaceId) : undefined
}

/**
 * 把一个端口做成"每次调用先按 actor 取品牌、再转给那个品牌那一份"。
 *
 * 用 Proxy 而不是逐个方法手抄：端口是**只加不删**的（35 §2），手抄一份就等于
 * 每加一条路由都要记得来这里补一行——忘一行就是"这条路由还跟着第一个品牌"，
 * 而那正是 WP65 留下的那个洞。这里一条都漏不掉。
 *
 * 只对**方法**成立，而且这些端口的返回值一律是 `MaybePromise<T>`，所以统一
 * 返回 Promise 不改变契约。同步返回的那几个（`configured()`）单独写在 `extra` 里。
 */
function scopedPort<P extends object>(
  make: (workspace_id: WorkspaceId) => Promise<P>,
  fallback: () => WorkspaceId,
  extra: Partial<Record<string, unknown>> = {},
): P {
  return new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        if (typeof prop === 'string' && prop in extra) return extra[prop]
        if (typeof prop !== 'string') return undefined
        return (...args: unknown[]): Promise<unknown> =>
          make(workspaceOf(args[0]) ?? fallback()).then((port) => {
            const fn = (port as unknown as Record<string, unknown>)[prop]
            if (typeof fn !== 'function')
              throw new ApiError('not_implemented', `这个端口上没有 ${prop}`)
            return (fn as (...a: unknown[]) => unknown).apply(port, args)
          })
      },
      has: () => true,
    },
  ) as P
}

/**
 * 连接面（WP20）。
 *
 * `runtime()` 没有 actor——它问的是 OpenConnector 这个**进程外的 runtime** 起没起、
 * 加固过没有，与是哪个品牌无关，所以走 bootstrap 那一套。
 *
 * 死信与重投（WP55 / 18 §2.2）在这里包一层而不是改连接面本身：死信是渠道的事，
 * 连接面只是它在界面上的落脚点——而渠道现在也按品牌各一条队列。
 */
export function brandConnectionsPort(brands: BrandModules): ConnectionsPort {
  const of = async (ws: WorkspaceId): Promise<ConnectionsPort> =>
    (await brands.forWorkspace(ws)).connections.port
  return scopedPort<ConnectionsPort>(of, () => brands.bootstrap, {
    runtime: async () => (await of(brands.bootstrap)).runtime(),
    deadLetters: async (actor: { workspace_id: WorkspaceId }) => {
      const brand = await brands.forWorkspace(actor.workspace_id)
      return (await brand.channels.deadLetters()).map((d) => ({
        id: d.id,
        channel: d.event.channel,
        reason: d.reason,
        attempts: d.attempts,
        at: new Date(d.at_ms).toISOString(),
        // 列表里只有"是谁 / 何时 / 为什么"：正文永远不进这一层
        ...(d.event.actor?.display === undefined ? {} : { from: d.event.actor.display }),
        ...(d.last_error === undefined ? {} : { last_error: d.last_error }),
      }))
    },
    requeueDeadLetter: async (actor: { workspace_id: WorkspaceId }, id: string) =>
      (await brands.forWorkspace(actor.workspace_id)).channels.requeueDeadLetter(id),
  })
}

export interface BrandModelsPortOptions {
  brands: BrandModules
  /** 公司默认品牌的名字（界面上那句"跟随「XX」的设置"）。 */
  brandName(workspace_id: WorkspaceId): string
}

/**
 * 模型面（WP25 / WP42）+ 52 O3 的"跟随公司默认"。
 *
 * 读：跟随时读公司默认品牌那一份（`brands.models` 自己解析）。
 * 写：跟随时一律拒——不然在 B 上点保存会悄悄改掉公司那一份，用户完全看不出来。
 */
export function brandModelsPort(options: BrandModelsPortOptions): ModelsPort {
  const { brands } = options
  const of = async (ws: WorkspaceId): Promise<ModelsPort> => (await brands.models(ws)).port
  const writable = (ws: WorkspaceId): void => {
    if (brands.inheritsOrg(ws)) throw new ApiError('invalid_input', INHERITING)
  }
  /** 三个只有多品牌才有意义的位（单品牌机器上 `inherit_org` 恒为 false）。 */
  const withInheritance = (ws: WorkspaceId, view: ModelDefaultsView): ModelDefaultsView => ({
    ...view,
    inherit_org: brands.inheritsOrg(ws),
    org_default: brands.isOrgDefault(ws),
    ...(brands.isOrgDefault(ws)
      ? {}
      : { org_default_brand: options.brandName(brands.orgDefaultOf(ws)) }),
  })
  type Actor = { workspace_id: WorkspaceId }
  return scopedPort<ModelsPort>(of, () => brands.bootstrap, {
    save: async (actor: Actor, id: string, input: unknown) => {
      writable(actor.workspace_id)
      return (await of(actor.workspace_id)).save(
        actor as Parameters<ModelsPort['save']>[0],
        id,
        input as Parameters<ModelsPort['save']>[2],
      )
    },
    remove: async (actor: Actor, id: string) => {
      writable(actor.workspace_id)
      return (await of(actor.workspace_id)).remove(actor as Parameters<ModelsPort['remove']>[0], id)
    },
    defaults: async (actor: Actor) =>
      withInheritance(
        actor.workspace_id,
        await (await of(actor.workspace_id)).defaults(
          actor as Parameters<ModelsPort['defaults']>[0],
        ),
      ),
    setDefaults: async (actor: Actor, input: unknown) => {
      writable(actor.workspace_id)
      return withInheritance(
        actor.workspace_id,
        await (await of(actor.workspace_id)).setDefaults(
          actor as Parameters<ModelsPort['setDefaults']>[0],
          input as Parameters<ModelsPort['setDefaults']>[1],
        ),
      )
    },
    /*
     * 首页那条"还没接模型"的黄条问它。没有 actor——它问的是**这台机器**有没有
     * 能用的模型，所以按 bootstrap 品牌答（那也正是黄条的语境：刚装完、
     * 还只有一个品牌）。它必须是同步的，所以只看已经建出来的那一套。
     */
    configured: (): boolean => brands.peek(brands.bootstrap)?.ownModels.configured() ?? false,
    setInheritance: async (actor: Actor, input: { inherit_org: boolean }) => {
      if (brands.isOrgDefault(actor.workspace_id))
        throw new ApiError(
          'invalid_input',
          '这个品牌就是公司默认那一个，它的设置**就是**公司默认，没有可跟随的对象',
        )
      await brands.setInheritOrg(actor.workspace_id, input.inherit_org)
      return withInheritance(
        actor.workspace_id,
        await (await of(actor.workspace_id)).defaults(
          actor as Parameters<ModelsPort['defaults']>[0],
        ),
      )
    },
  })
}

/** 云侧那一面（49 M2 / M5）：余额与价目按品牌各自那把令牌，能力开关按品牌各一份。 */
export function brandCloudPort(brands: BrandModules): CloudPort {
  const of = async (ws: WorkspaceId): Promise<CloudPort> => (await brands.cloud(ws)).port
  type Actor = { workspace_id: WorkspaceId }
  return scopedPort<CloudPort>(of, () => brands.bootstrap, {
    setCapabilitySources: async (actor: Actor, input: { capability_sources: never }) => {
      if (brands.inheritsOrg(actor.workspace_id)) throw new ApiError('invalid_input', INHERITING)
      return (await of(actor.workspace_id)).setCapabilitySources(
        actor as Parameters<CloudPort['setCapabilitySources']>[0],
        input,
      )
    },
  })
}

/**
 * 工作台面板（36 §3）：数字块与"店铺后台"分块读的是**这个品牌**的数据源。
 *
 * `label(ref)` 是这一族端口里唯一一个**同步且没有 actor** 的方法（拼卡片时一条一条
 * 地调），所以它不能走上面那个 Proxy——那会把一个 Promise 塞进卡片的 `customer_label`。
 * 网关那边改成先问 `labelFor(actor, ref)`：那一条按品牌翻，`label` 只剩兼容用的退路。
 */
export function brandWorkstationPort(
  brands: BrandModules,
  make: (workspace_id: WorkspaceId) => Promise<WorkstationPort>,
): WorkstationPort {
  return scopedPort<WorkstationPort>(make, () => brands.bootstrap, {
    label: (ref: ObjectRef): string | undefined =>
      brands.peek(brands.bootstrap)?.workData.label(ref),
    /*
     * 只看**已经建出来**的那一套：走到拼卡片这一步时，本次请求早就
     * `positions(actor)` 过一轮了，那个品牌一定已经在容器里。
     */
    labelFor: (actor: { workspace_id: WorkspaceId }, ref: ObjectRef): string | undefined =>
      brands.peek(actor.workspace_id)?.workData.label(ref),
  })
}

/** 36 §3「问 AI」：问的是"我这个品牌现在怎么样"，用这个品牌的模型与事项。 */
export function brandAskPort(
  brands: BrandModules,
  make: (workspace_id: WorkspaceId) => Promise<AskPort>,
): AskPort {
  return scopedPort<AskPort>(make, () => brands.bootstrap)
}

/** 37 工作模型（事项 / 目标 / 待办 / 计划 / 复盘）：一个品牌一份 `Work`。 */
export function brandWorkPort(
  brands: BrandModules,
  make: (workspace_id: WorkspaceId) => Promise<WorkPort>,
): WorkPort {
  return scopedPort<WorkPort>(make, () => brands.bootstrap)
}
