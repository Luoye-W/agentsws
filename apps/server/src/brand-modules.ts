/**
 * WP66（52 O1「每个品牌的所有东西都单独设置」）：**一个服务进程装配多套品牌模块**。
 *
 * WP65 把品牌做成了工作区，但服务进程仍然按 bootstrap 工作区装配**一套**业务模块：
 * 按 `actor.workspace_id` 走的面（岗位、队列、知识）是对的，按装配期闭包走的面
 * （连接、活数据源、模型、渠道）还跟着第一个品牌。这个文件就是那条缺口的收口。
 *
 * 四条纪律：
 *
 * 1. **按请求取模块，不按进程**。`forWorkspace(ws)` 懒建、按 `workspace_id` 缓存；
 *    路由层一律从请求上下文取 `actor.workspace_id` 再取模块。判断收在这一处与
 *    `server.ts` 的适配层里，不散落到每条路由。
 * 2. **落盘按品牌分目录**。bootstrap 品牌**用原来那个目录一个字节不动**
 *    （`connections.json` / `models.json` / `channels.sqlite` 全在老位置），
 *    别的品牌落在 `<dbDir>/brands/<workspace_id>/` 下。存量单品牌用户零感知——
 *    这就是"一次性迁移"的全部内容：什么都不用搬。
 * 3. **凭据按品牌隔开**。同一个加密库、同一把密钥，key 名按品牌加前缀
 *    （bootstrap 前缀为空，见 {@link secretsPrefixOf}）。品牌 A 的邮箱口令、
 *    Shopify 应用密钥、模型 key 与云令牌，在 B 的任何路由里都取不到。
 * 4. **"跟随公司默认"是共享一份模块，不是抄一份**（52 O3）。新品牌默认
 *    `inherit_org: true`：它的模型面与能力开关**就是**公司默认品牌那一份对象，
 *    不存在"两份配置漂移"这种状态。关掉开关才有自己那一份。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { StartRun, WorkspaceId } from '@agentsws/contracts'
import type { ModelGatewayApi } from '@agentsws/model-gateway'
import type { Work } from '@agentsws/work'
import type { AdsStore } from './ads.js'
import type { AdsServiceAssembly } from './ads-service.js'
import type { ChannelsAssembly } from './channels.js'
import type { ChatLane } from './chat.js'
import type { ChatWidgetAssembly } from './chat-widget.js'
import type { CloudAssembly } from './cloud.js'
import type { ConnectionsAssembly } from './connections.js'
import type { KolStore } from './kol.js'
import type { KolServiceAssembly } from './kol-service.js'
import type { LiveDataSource } from './live-data.js'
import type { ModelsAssembly } from './models.js'
import type { PrStore } from './pr.js'
import type { PrServiceAssembly } from './pr-service.js'
import type { MatterRecordSource, RuntimeAssembly } from './runtime.js'
import type { SecretStore } from './secret-store.js'
import type { SocialStore } from './social.js'
import type { SocialChannelsAssembly } from './social-channels.js'
import type { SocialServiceAssembly } from './social-service.js'
import type { WorkstationDataSource } from './workstation.js'

/** 品牌落盘目录在 `dbDir` 下的那一级。 */
export const BRAND_DIR = 'brands'
/** 品牌容器自己的状态文件（现在只有"跟不跟随公司默认"这一位）。 */
export const BRAND_SETTINGS_FILE = 'brands.json'

/**
 * 这个品牌的落盘目录。
 *
 * bootstrap 品牌 = `dbDir` 本身。**这一行就是存量用户的迁移方案**：老机器上
 * 所有状态文件与 SQLite 都在 `dbDir` 下，bootstrap 品牌继续读写它们，
 * 一次文件搬家都不用做，也就不可能搬坏。
 */
export function brandDirOf(
  dbDir: string | undefined,
  workspace_id: WorkspaceId,
  bootstrap: WorkspaceId,
): string | undefined {
  if (dbDir === undefined) return undefined
  return workspace_id === bootstrap ? dbDir : join(dbDir, BRAND_DIR, workspace_id)
}

/**
 * 这个品牌在加密库里的 key 前缀。
 *
 * bootstrap 品牌是空串（存量凭据都在没有前缀的名字下，加前缀 = 全部失联）；
 * 别的品牌一律 `ws:<workspace_id>/`。
 */
export function secretsPrefixOf(workspace_id: WorkspaceId, bootstrap: WorkspaceId): string {
  return workspace_id === bootstrap ? '' : `ws:${workspace_id}/`
}

/** 一个品牌的那一套业务模块。 */
export interface BrandModuleSet {
  workspace_id: WorkspaceId
  /** 这个品牌的落盘目录（内存档没有）。 */
  dir?: string
  /** 这个品牌自己那一段加密库视图（key 名已按品牌加过前缀）。 */
  secrets: SecretStore
  connections: ConnectionsAssembly
  /** 活数据源；接了模拟世界（demo）时没有它。 */
  liveData?: LiveDataSource
  /** 工作台数据源（活数据源，或 demo 的合成世界）。 */
  workData: WorkstationDataSource
  records: MatterRecordSource
  /**
   * WP67（48 §5.2 数据面）：这个品牌的红人库。
   *
   * 与连接、活数据源同一条纪律（本文件第 2 条）：落盘按品牌分目录。
   * 品牌 A 的红人、联系方式引用与合作预算，在 B 的任何路由里都读不到。
   */
  kol: KolStore
  /**
   * WP68（48 §5.4）：这个品牌红人库的 `/v1` 面（端口 + 起草那一跳取明文的口子）。
   *
   * 与 `kol` 分成两格：库是数据，服务是**带着加密库、审批总线与变更账本**
   * 的那一层。品牌 A 的联系方式明文只有 A 这一份服务取得到。
   */
  kolService: KolServiceAssembly
  /**
   * WP72（56 §2 数据面）：这个品牌的社媒库（四类对象）。
   *
   * 与红人库同一条纪律（本文件第 2 条）：落盘按品牌分目录。品牌 A 的帖子、
   * 排期、群成员与线程，在 B 的任何路由里都读不到——九条渠道是九个真账号，
   * 串了品牌等于发错号。
   */
  social: SocialStore
  /**
   * WP73（56 §6）：这个品牌社媒库的 `/v1` 面（端口 + 九条渠道的适配器）。
   *
   * 与 `social` 分成两格，理由与红人那两格逐字相同：库是数据，服务是**带着
   * 加密库、审批总线与变更账本**的那一层。判类（triage）与群规匹配
   * （moderation）的调用方就在这里——56 那条"群里的客户问题不归社媒运营"
   * 的边界，在服务进程里的落点是它。
   */
  socialService: SocialServiceAssembly
  /**
   * WP78（60 §5 数据面）：这个品牌的公关库（四类对象）。
   *
   * 与红人库、社媒库同一条纪律（本文件第 2 条）：落盘按品牌分目录。
   * 品牌 A 的媒体名单、稿子与提及，在 B 的任何路由里都读不到——
   * 媒体名单是一家公司攒了很多年的东西，串了品牌等于把它送人。
   */
  pr: PrStore
  /**
   * WP78（60 §5）：这个品牌公关库的 `/v1` 面（端口 + 那一轮监控）。
   *
   * 与 `kol` / `social` 分成两格，理由逐字相同：库是数据，服务是**带着审批总线
   * 与变更账本**的那一层。60 那条"客户投诉转客服"的分界，在服务进程里的落点是它。
   */
  prService: PrServiceAssembly
  /** WP73：这个品牌九条渠道的适配器与 transport（真 HTTP 那一跳 + 凭据取法）。 */
  socialChannels: SocialChannelsAssembly
  /**
   * WP75（57 §5 数据面）：这个品牌的广告库（五类对象）。
   *
   * 与红人库、社媒库同一条纪律（本文件第 2 条）：落盘按品牌分目录。
   * 这一条是三条里后果最直接的——**广告账户是花钱的**：品牌 A 的 campaign
   * 串到 B 去，等于用 B 的钱包给 A 投广告。
   */
  ads: AdsStore
  /**
   * WP75：这个品牌广告库的 `/v1` 面（端口 + 五个写口子的出卡那一跳）。
   *
   * 与 `ads` 分成两格，理由与红人 / 社媒那两组逐字相同：库是数据，服务是
   * **带着变更账本与生效配置**的那一层。04 §5 那条额度纪律（止损 L3、
   * 额度内 L2、开花钱口子永远 L1）在服务进程里的落点就是它。
   */
  adsService: AdsServiceAssembly
  work: Work
  runtime?: RuntimeAssembly
  startRun?: StartRun
  channels: ChannelsAssembly
  chat: ChatLane
  chatWidget: ChatWidgetAssembly
  /**
   * 这个品牌**自己那一份**模型面与能力开关。
   *
   * 跟随公司默认时它仍然建出来（空的、没人读），真正端出去的是
   * {@link BrandModules.models} 解析之后那一份。
   */
  ownModels: ModelsAssembly
  ownGateway: ModelGatewayApi
  ownCloud: CloudAssembly
  dispose(): Promise<void>
}

export interface BrandModulesOptions {
  /** 这个进程第一次启动时建出来的那个品牌（落盘目录与凭据前缀的基准）。 */
  bootstrap: WorkspaceId
  /** 懒建一套。容器保证同一个 `workspace_id` 只会并发地建一次。 */
  create(workspace_id: WorkspaceId): Promise<BrandModuleSet>
  /** 这个组织的"公司默认品牌"（跟随公司默认时读它那一份）。缺省就是 bootstrap。 */
  orgDefault?(workspace_id: WorkspaceId): WorkspaceId
  /** `brands.json` 的目录；不给就全内存（测试与一次性任务）。 */
  dbDir?: string
  /** 现在这个组织下有哪些品牌（`all()` 要用它）。缺省只有 bootstrap。 */
  brands?(): WorkspaceId[]
}

export interface BrandModules {
  /** 这个进程的 bootstrap 品牌。 */
  readonly bootstrap: WorkspaceId
  /** 取（必要时懒建）一个品牌的那一套模块。 */
  forWorkspace(workspace_id: WorkspaceId): Promise<BrandModuleSet>
  /** 已经建出来的那一套；没建过回 `undefined`（**不触发懒建**）。 */
  peek(workspace_id: WorkspaceId): BrandModuleSet | undefined
  /** 现在建出来的全部（顺序不保证）。 */
  loaded(): BrandModuleSet[]
  /**
   * 这个组织下每个品牌的那一套（没建过的**会**建出来）。
   *
   * 调度器那几条按品牌跑的任务（收信轮询、出站对账、Amazon SLA、令牌刷新）用它：
   * 一个没人访问过的品牌照样要收信。
   */
  all(): Promise<BrandModuleSet[]>
  /** 这个品牌解析之后的模型面（跟随公司默认时是公司默认品牌那一份）。 */
  models(workspace_id: WorkspaceId): Promise<ModelsAssembly>
  /** 同上，能力开关那一份（49 M5）。 */
  cloud(workspace_id: WorkspaceId): Promise<CloudAssembly>
  /** 这个品牌解析之后的模型网关（运行时与聊天车道用它）。 */
  gateway(workspace_id: WorkspaceId): Promise<ModelGatewayApi>
  /** 跟不跟随公司默认（52 O3）。bootstrap / 公司默认品牌恒为 `false`。 */
  inheritsOrg(workspace_id: WorkspaceId): boolean
  /** 这个品牌是不是公司默认那一个（设置页据此把开关画成灰的）。 */
  isOrgDefault(workspace_id: WorkspaceId): boolean
  /** 公司默认品牌（跟随时读它那一份）。 */
  orgDefaultOf(workspace_id: WorkspaceId): WorkspaceId
  /** 改"跟随公司默认"。改完这个品牌的模块会重建一次（下一次请求生效）。 */
  setInheritOrg(workspace_id: WorkspaceId, inherit: boolean): Promise<void>
  /** 离开 / 删品牌：关掉这一套（下一次 `forWorkspace` 会重新建）。 */
  release(workspace_id: WorkspaceId): Promise<void>
  /** 关掉全部（进程退出）。 */
  dispose(): Promise<void>
}

interface BrandSettingsFile {
  version: 1
  /** `workspace_id` → 跟不跟随公司默认。**只落"显式关过"的那几条**（见下）。 */
  inherit_org?: Record<string, boolean>
}

export function createBrandModules(options: BrandModulesOptions): BrandModules {
  const bootstrap = options.bootstrap
  const stateFile =
    options.dbDir === undefined ? undefined : join(options.dbDir, BRAND_SETTINGS_FILE)

  let state: BrandSettingsFile = { version: 1, inherit_org: {} }
  if (stateFile !== undefined) {
    try {
      const parsed = JSON.parse(readFileSync(stateFile, 'utf8')) as BrandSettingsFile
      state = { version: 1, inherit_org: parsed.inherit_org ?? {} }
    } catch {
      // 第一次跑，或者文件坏了：从空开始（空 = 新品牌跟随公司默认，正是 52 O3 的默认值）
    }
  }
  const flush = (): void => {
    if (stateFile === undefined) return
    mkdirSync(options.dbDir as string, { recursive: true })
    writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  }

  const orgDefaultOf = (workspace_id: WorkspaceId): WorkspaceId => {
    const found = options.orgDefault?.(workspace_id) ?? bootstrap
    // 自指是唯一的死循环来源：公司默认品牌自己永远不跟随任何人
    return found === workspace_id ? workspace_id : found
  }
  const isOrgDefault = (workspace_id: WorkspaceId): boolean =>
    orgDefaultOf(workspace_id) === workspace_id
  const inheritsOrg = (workspace_id: WorkspaceId): boolean => {
    if (isOrgDefault(workspace_id)) return false
    // 没记过 = 跟随（52 O3「新品牌默认跟随组织默认」）
    return state.inherit_org?.[workspace_id] ?? true
  }

  const built = new Map<WorkspaceId, BrandModuleSet>()
  const building = new Map<WorkspaceId, Promise<BrandModuleSet>>()

  const forWorkspace = async (workspace_id: WorkspaceId): Promise<BrandModuleSet> => {
    const ready = built.get(workspace_id)
    if (ready !== undefined) return ready
    const inflight = building.get(workspace_id)
    // 同一个品牌并发进来两条请求：只建一次，第二条等第一条
    if (inflight !== undefined) return inflight
    const promise = options
      .create(workspace_id)
      .then((set) => {
        built.set(workspace_id, set)
        return set
      })
      .finally(() => {
        building.delete(workspace_id)
      })
    building.set(workspace_id, promise)
    return promise
  }

  /** 跟随公司默认时把取值转给公司默认品牌那一套。 */
  const resolved = async (workspace_id: WorkspaceId): Promise<BrandModuleSet> =>
    forWorkspace(inheritsOrg(workspace_id) ? orgDefaultOf(workspace_id) : workspace_id)

  const release = async (workspace_id: WorkspaceId): Promise<void> => {
    const inflight = building.get(workspace_id)
    if (inflight !== undefined) await inflight.catch(() => undefined)
    const set = built.get(workspace_id)
    if (set === undefined) return
    built.delete(workspace_id)
    await set.dispose()
  }

  return {
    bootstrap,
    forWorkspace,
    peek: (workspace_id) => built.get(workspace_id),
    loaded: () => [...built.values()],
    async all() {
      const ids = new Set<WorkspaceId>([bootstrap, ...(options.brands?.() ?? [])])
      const out: BrandModuleSet[] = []
      for (const id of ids) out.push(await forWorkspace(id))
      return out
    },
    models: async (workspace_id) => (await resolved(workspace_id)).ownModels,
    cloud: async (workspace_id) => (await resolved(workspace_id)).ownCloud,
    gateway: async (workspace_id) => (await resolved(workspace_id)).ownGateway,
    inheritsOrg,
    isOrgDefault,
    orgDefaultOf,
    async setInheritOrg(workspace_id, inherit) {
      if (isOrgDefault(workspace_id)) return
      const rows = { ...(state.inherit_org ?? {}) }
      rows[workspace_id] = inherit
      state = { version: 1, inherit_org: rows }
      flush()
      /*
       * 关掉"跟随"之后这个品牌要用**自己那一份**模型面，而运行时与聊天车道是在
       * 装配那一刻拿到网关的——所以把这一套整个丢掉重建，下一次请求自然是新的。
       * 不这么做的话，开关看着变了、真正跑模型的还是公司那一份。
       */
      await release(workspace_id)
    },
    release,
    async dispose() {
      const sets = [...built.values()]
      built.clear()
      for (const set of sets) await set.dispose()
    },
  }
}
