/**
 * WP216（Luoye 10-05）：**这个品牌的平台专属那一套**——官方技能、官方 MCP 工具、官方 CLI。
 *
 * 真源是 `@agentsws/contracts` 的 `PLATFORM_KITS`，判据是品牌档案的 `storefront_platform`。
 * 平台那一行没有专属的东西（WooCommerce / 还没建站 / 自己搭的）就回 `kit: null`，
 * 界面上什么都不出——不检测 CLI、不列技能、不出卡。
 *
 * 三条：
 *
 * - `GET /v1/platform-kit`：看现状。带 `position_id` 时只在那个岗位页需要 CLI 卡的时候才去检测本机；
 * - `POST /v1/platform-kit/cli/check`：用户点「再查一次」（装好之后），不走缓存；
 * - `PUT /v1/platform-kit/cli/login`：老接口「我登好了」——只记一个时间（WP245 后卡上不再有这个按钮）；
 * - `POST /v1/platform-kit/cli/run`（WP245）：替用户跑登记过的 install / login / version，只给人点；
 *   登录网址交给工作台打开，**不碰账号密码、不读 CLI 存的会话**；
 * - `POST /v1/platform-kit/cli/cancel`（WP245）：停掉正在跑的那件。
 */
import type {
  MaybePromise,
  PlatformCliSpec,
  PlatformMcpSpec,
  PlatformSkillSource,
} from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, OWNER_WRITE, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 看一眼这个品牌的平台套件：只读。 */
const READ = {
  // 平台套件说的是「这个品牌的 AI 手边有哪几样官方工具」——与技能页同一把闸（店主与建站四条都有）
  domain: 'skill',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

export interface PlatformKitActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

/** WP245：工作台替用户跑的两类动作（`version` = 再查一次，走检测那条路）。 */
export type PlatformCliAction = 'install' | 'login' | 'version'

/** WP245：替用户跑的那件事现在走到哪了（卡片轮询它画进度）。 */
export interface PlatformCliJobView {
  action: 'install' | 'login'
  phase:
    | 'preparing'
    | 'downloading'
    | 'installing'
    | 'waiting_browser'
    | 'done'
    | 'failed'
    | 'cancelled'
  started_at: string
  finished_at?: string
  /** 安装：npm 已经取回几个包。 */
  fetched?: number
  /** 登录：CLI 打出来的登录网址（只认 https；工作台用系统浏览器打开）。 */
  login_url?: string
  /** 登录：网页上要核对的确认码。 */
  user_code?: string
  /** 登录：CLI 自己已经开了浏览器（工作台不再开第二次）。 */
  browser_opened?: boolean
  /** 失败的种类（界面按它说人话）+ 原始码（`ENOTFOUND` / `exit 1`）。 */
  error?: {
    code:
      | 'network'
      | 'timeout'
      | 'disk_full'
      | 'permission'
      | 'denied'
      | 'expired'
      | 'not_installed'
      | 'failed'
    detail?: string
  }
  /** 「详情」里给人看的命令。 */
  command: string
  /** 「详情」里的输出尾巴（抹过令牌、去了颜色码）。 */
  log: string[]
}

/** CLI 卡上那四档（36 §7 第四档：状态用图标）。 */
export type PlatformCliState = 'missing' | 'node_old' | 'needs_login' | 'ready'

export interface PlatformCliView {
  spec: PlatformCliSpec
  /** 本机检测（没检测过 = 没有这一格）。 */
  probe?: {
    installed: boolean
    version?: string
    node_version?: string
    node_ok: boolean
    min_node_major: number
    checked_at: string
    /** WP245：`app` = 工作台装在自己数据目录里的那份；`system` = 系统里本来就有的。 */
    source?: 'app' | 'system'
  }
  /** WP245：这台机器上能不能「一键安装 / 一键登录」（没有数据目录 / CLI 不支持就没有这两样）。 */
  can?: { install: boolean; login: boolean }
  /** WP245：替用户跑的那件事（跑着的或刚结束的）。 */
  job?: PlatformCliJobView
  /** 登录成功（或老接口「我登好了」）的时间；没有就没有。 */
  login_confirmed_at?: string
  state: PlatformCliState
  /** CLI 不在 / 没登录时，哪几条职责退回 Admin API 那条路（卡上照实说）。 */
  degraded_roles: string[]
}

export interface PlatformKitView {
  /** 这个品牌的平台；没设（也推断不出）= 没有这一格。 */
  platform?: string
  /**
   * WP216：平台没设、而这个岗位页正是平台专属工具会出现的那一页（建站）——提示「先选一下你的建站平台」。
   * 带上可选的平台（与首次设置同一份清单，灰显的照样给）。
   */
  choose_platform?: { choices: { key: string; label: string; supported: boolean }[] }
  kit: null | {
    /** 平台专属的官方技能（目录名 + 给人看的名字）。 */
    skills: { name: string; display_name?: { zh: string; en: string } }[]
    skill_source?: PlatformSkillSource
    /**
     * 官方 MCP 工具源。`enabled` = 这台机器上没关（默认开）；`downloaded` = 官方工具包已经下载并起来了
     * （首次使用才下载）；`tools` = 现在真能调的。
     */
    mcp?: PlatformMcpSpec & { enabled: boolean; downloaded: boolean; tools: string[] }
    cli?: PlatformCliView
  }
}

export interface PlatformKitPort {
  view(actor: PlatformKitActor, input: { position_id?: string }): MaybePromise<PlatformKitView>
  checkCli(actor: PlatformKitActor): MaybePromise<PlatformKitView>
  confirmLogin(
    actor: PlatformKitActor,
    input: { confirmed: boolean },
  ): MaybePromise<PlatformKitView>
  /**
   * WP245：替用户跑登记过的那几条命令（安装 / 登录 / 报版本）。只接受这三类、参数在服务端拼死。
   * 没装配（老进程 / 测试）= 路由回 501。
   */
  runCli?(
    actor: PlatformKitActor,
    input: { action: PlatformCliAction },
  ): MaybePromise<PlatformKitView>
  /** WP245：停掉正在跑的那件（登录等浏览器时用户点「取消」）。 */
  cancelCli?(actor: PlatformKitActor): MaybePromise<PlatformKitView>
  /** 选建站平台（岗位页那一行下拉）。档案还没建过 → 409（先走首次设置）。 */
  setPlatform(
    actor: PlatformKitActor,
    input: { storefront_platform: string; position_id?: string },
  ): MaybePromise<PlatformKitView>
}

const LoginBody = z.object({ confirmed: z.boolean() })
/** WP245：只认这三类，不接受任意字符串。 */
const RunBody = z.object({ action: z.enum(['install', 'login', 'version']) })

/**
 * WP245：替用户跑命令只给**人**点：AI 运行那条路（`runtime` 令牌）一律拒。
 * 这两条路由也不进任何工具清单——AI 手边没有「装软件 / 登录」这一样。
 */
function humanOnly(c: Parameters<typeof principalOf>[0]): void {
  if (principalOf(c).kind === 'runtime')
    throw new ApiError('forbidden', '安装与登录只能由人在工作台上点，AI 运行不能调用')
}
const PlatformBody = z.object({
  storefront_platform: z.string().min(1).max(40),
  position_id: z.string().min(1).max(100).optional(),
})

/** 选平台是改品牌档案：与 `PUT /v1/workspace/profile` 同一把闸（负责人）。 */
const WRITE_PROFILE = OWNER_WRITE

function portOf(deps: GatewayDeps): PlatformKitPort {
  const p = deps.platformKit
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配平台套件（GatewayDeps.platformKit）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): PlatformKitActor {
  const p = principalOf(c)
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignmentOf(c).id,
  }
}

export function platformKitRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/platform-kit',
        operationId: 'getPlatformKit',
        summary:
          'WP216：这个品牌的平台专属那一套（官方技能 / 官方 MCP / 官方 CLI）。平台没有就回 kit: null，什么都不检测',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'position_id',
            in: 'query',
            description: '在哪个岗位页上看（CLI 卡只出在平台那一行写的岗位页上）',
          },
        ],
        returns: 'PlatformKitView',
      },
      async (c, deps) => {
        const position_id = c.req.query('position_id')
        return ok(
          c,
          await portOf(deps).view(
            actorOf(c),
            position_id === undefined || position_id === '' ? {} : { position_id },
          ),
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/platform-kit/cli/check',
        operationId: 'checkPlatformCli',
        summary: 'WP216：再查一次本机的官方 CLI 与 Node（不走缓存）。平台没有 CLI 就不查',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PlatformKitView',
      },
      async (c, deps) => ok(c, await portOf(deps).checkCli(actorOf(c))),
    ),
    route(
      {
        method: 'put',
        path: '/v1/platform-kit/cli/login',
        operationId: 'confirmPlatformCliLogin',
        summary:
          'WP216：用户在浏览器里自己登录完点「我登好了」（或撤回）。只记一个时间，不跑登录命令、不碰任何凭据',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: LoginBody,
        returns: 'PlatformKitView',
      },
      async (c, deps) =>
        ok(c, await portOf(deps).confirmLogin(actorOf(c), await body(c, LoginBody))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/platform-kit/cli/run',
        operationId: 'runPlatformCli',
        summary:
          'WP245：替用户跑平台 CLI 登记过的命令（install = 装进应用数据目录 / login = 起登录、网址交给工作台打开 / version = 再查一次）。只给人点',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        body: RunBody,
        returns: 'PlatformKitView',
      },
      async (c, deps) => {
        humanOnly(c)
        const port = portOf(deps)
        const input = await body(c, RunBody)
        if (input.action === 'version') return ok(c, await port.checkCli(actorOf(c)))
        if (port.runCli === undefined)
          throw new ApiError('not_implemented', '这个服务进程不能替用户跑命令')
        return ok(c, await port.runCli(actorOf(c), { action: input.action }))
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/platform-kit/cli/cancel',
        operationId: 'cancelPlatformCli',
        summary: 'WP245：停掉正在替用户跑的那件（安装 / 登录）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'PlatformKitView',
      },
      async (c, deps) => {
        humanOnly(c)
        const port = portOf(deps)
        if (port.cancelCli === undefined)
          throw new ApiError('not_implemented', '这个服务进程不能替用户跑命令')
        return ok(c, await port.cancelCli(actorOf(c)))
      },
    ),
    route(
      {
        method: 'put',
        path: '/v1/platform-kit/platform',
        operationId: 'setPlatformKitPlatform',
        summary:
          'WP216：在岗位页上选建站平台（只改品牌档案的这一格；平台专属的技能 / 工具 / CLI 卡跟着变）',
        tag: 'site',
        auth: 'bearer',
        assignment: true,
        authz: WRITE_PROFILE,
        body: PlatformBody,
        returns: 'PlatformKitView',
      },
      async (c, deps) => {
        const input = await body(c, PlatformBody)
        return ok(
          c,
          await portOf(deps).setPlatform(actorOf(c), {
            storefront_platform: input.storefront_platform,
            ...(input.position_id === undefined ? {} : { position_id: input.position_id }),
          }),
        )
      },
    ),
  ]
}
