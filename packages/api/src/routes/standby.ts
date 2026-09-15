/**
 * 在线值守在**本地**这一面（49 §6 WP60、48 L7、41 §2.4）。
 *
 * 连接页"数据后端"三档底下那一格"在线值守（agentsws 托管）"点开走的就是这几条。
 * 五步向导：
 *
 * | 步 | 这里的哪一条 | 干什么 |
 * |---|---|---|
 * | ① 关联账号 | `GET /v1/standby`（`linked: false` 就跳 WP58 的账号 tab） | 没账号就没有第二步 |
 * | ② 看余额与月费 | `GET /v1/standby` 的 `seat_price` + WP59 的 `/v1/cloud/credits` | 先说多少钱再问要不要 |
 * | ③ 本地导出 | `POST /v1/backup/export`（WP36，已有） | 搬家包 |
 * | ④ 上传并开通 | `POST /v1/standby/switch` | 把包传到云上、开值守、起进程 |
 * | ⑤ 桌面切远程 | `GET /v1/standby` 的 `remote_url` | 桌面壳指到 `https://<云>/w/<ws>` |
 *
 * 反向"接回本机"是 `POST /v1/standby/bring-home`：云上 `export` → 本地 `import`
 * → 停云上那个进程 → 切回本地模式。**两个方向用的是同一个包格式**（33 双向搬家），
 * 所以这两条路由是对称的，不是一条真路加一条摆设。
 *
 * 一条纪律与 WP59 的 `/v1/cloud/*` 逐字相同：**本地不记账、不记状态**。
 * 值守的状态、座位单价、到期时间全是云上那一份的透传；本地一个都不自己算
 * ——自己算就是第二本账，两本账必然对不上。
 */
import type { MaybePromise, StandbyLocalView } from '@agentsws/contracts'
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps } from '../types.js'

/** 读：与"数据后端""模型""账号"同一格。 */
const READ = {
  domain: 'store_config',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

/** 写：花钱与搬家，owner 级（与备份导出、换秘密库密钥同一个等级）。 */
const WRITE = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const TAG = 'standby'

export interface StandbyActor {
  workspace_id: string
  person_id: string
  assignment_id: string
}

/** 切过去之后的回执。**不回任何令牌**。 */
export interface StandbySwitchView {
  /** 云上那一份的状态。 */
  status: string
  /** 桌面壳要指向的地址（`https://<云>/w/<ws>`）。 */
  remote_url: string
  /** 传上去的包有多大（对账用）。 */
  bytes: number
  /** 这一期付到什么时候。 */
  period_end: string
  /** 可复制的嵌入脚本。 */
  embed_snippet: string
}

/** 接回本机之后的回执。 */
export interface StandbyBringHomeView {
  /** 导回来的包落在哪（服务端路径；取包走文件系统，不经 HTTP）。 */
  out: string
  bytes: number
  /** 云上那个进程停了没有。 */
  stopped: boolean
  /** 下一步要做什么（人话）。 */
  next: string
}

/** 网关只转发；实现在 `apps/server/src/standby.ts`。 */
export interface StandbyPort {
  /** 现在是什么状况（没关联账号不是错，回 `linked: false` + 一句人话）。 */
  view(actor: StandbyActor): MaybePromise<StandbyLocalView>
  /** ④ 导出 → 上传 → 开通 → 起进程。 */
  switchToCloud(
    actor: StandbyActor,
    input: { seats: number; force?: boolean | undefined },
  ): Promise<StandbySwitchView>
  /** 反向：云上导出 → 本地落盘 → 停云上那个进程。 */
  bringHome(actor: StandbyActor): Promise<StandbyBringHomeView>
}

const SwitchBody = z.object({
  /** 座位数（按 `standby.seat.month` × 座位数计价）。 */
  seats: z.number().int().min(1).max(500).default(1),
  /**
   * 云上这个工作区已经有数据时要不要盖掉。
   *
   * 默认 `false`：把一个租户现在的数据盖掉不该是默认行为——它没有"撤销"。
   */
  force: z.boolean().optional(),
})

function portOf(deps: GatewayDeps): StandbyPort {
  const p = deps.standby
  if (p === undefined)
    throw new ApiError('not_implemented', '这个服务进程没有装配在线值守（49 §6 WP60）')
  return p
}

function actorOf(c: Parameters<typeof principalOf>[0]): StandbyActor {
  const p = principalOf(c)
  const assignment = c.get('rctx').assignment
  if (assignment === undefined) throw new ApiError('invalid_input', '缺少 X-Assignment 头')
  return {
    workspace_id: p.workspace_id,
    person_id: p.person_id,
    assignment_id: assignment.id,
  }
}

export function standbyRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/standby',
        operationId: 'getStandby',
        summary: '在线值守现在是什么状况（没关联账号回 linked: false，不是错）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: READ,
        returns: 'StandbyLocalView',
      },
      async (c, deps) => ok(c, await portOf(deps).view(actorOf(c))),
    ),
    route(
      {
        method: 'post',
        path: '/v1/standby/switch',
        operationId: 'switchToStandby',
        summary: '切到在线值守：本地导出 → 上传到云 → 开通 → 云上起进程（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        // 这一条会让云上那个进程开始替你收发邮件与聊天：急停 outbound 时它必须停
        outbound: true,
        body: SwitchBody,
        returns: 'StandbySwitchView',
      },
      async (c, deps) => {
        const actor = actorOf(c)
        const input = await body(c, SwitchBody)
        return ok(
          c,
          await portOf(deps).switchToCloud(actor, {
            seats: input.seats,
            ...(input.force === undefined ? {} : { force: input.force }),
          }),
          201,
        )
      },
    ),
    route(
      {
        method: 'post',
        path: '/v1/standby/bring-home',
        operationId: 'bringStandbyHome',
        summary: '接回本机：云上导出 → 落到本机 → 停云上那个进程（owner）',
        tag: TAG,
        auth: 'bearer',
        assignment: true,
        authz: WRITE,
        outbound: true,
        returns: 'StandbyBringHomeView',
      },
      async (c, deps) => ok(c, await portOf(deps).bringHome(actorOf(c)), 201),
    ),
  ]
}
