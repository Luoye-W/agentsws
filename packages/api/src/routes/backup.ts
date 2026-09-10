/**
 * 备份（40 §1.3、33 §1「双向搬家」）。
 *
 * 一条路由，owner 级：把整个工作区导成一个带清单与哈希的包，落到策略里配置的目录
 * （v1 是 `AGENTSWS_BACKUP_DIR`，缺省 `<数据目录>/backups`；策略层字段见交付报告）。
 *
 * 两条边界：
 * - **路径由服务端定**。请求里没有"导到哪"这个参数——一条 owner 能调用的路由要是
 *   能往任意路径写文件，那它就不是备份路由而是一个写文件的原语。
 * - **响应里没有包**。只回落在哪、多大、多少条事件、几份保留。取包走文件系统 /
 *   NAS 共享目录，不经 HTTP：一个工作区的包可以是几百 MB。
 *
 * 导入**没有**路由：把一份备份铺到一台正在跑的服务进程底下，是运维动作不是 API 动作
 * （`agentsws import` 对着一个**没在跑**的数据目录做，导完先对账再放开出站，15 §5.8）。
 */
import { z } from 'zod'
import { ApiError } from '../errors.js'
import { assignmentOf, body, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

/** 备份是 owner 级：整库出门这件事和换密钥库密钥同一个等级。 */
const OWNER = {
  domain: 'policy',
  op: 'stage',
  range: 'workspace',
  sensitivity: 'restricted',
} as const

const ExportBody = z.object({
  /** 留最近几份；不给就按服务端配置（`AGENTSWS_BACKUP_KEEP`，缺省 7）。 */
  keep: z.number().int().min(1).max(365).optional(),
})

export interface BackupExportView {
  /** 包落在哪（服务端路径；取包走文件系统，不经 HTTP）。 */
  out: string
  bytes: number
  /** 这一份里有多少条事件（对得上就是同一条链）。 */
  events: number
  /** 目录里现在留着几份 */
  kept: number
  /** 这一次删掉的旧包 */
  pruned: string[]
  at: string
}

/** 网关只转发；导出的实现在 `apps/server/src/backup.ts`。 */
export interface BackupPort {
  export(
    actor: { workspace_id: string; person_id: string; assignment_id: string },
    input: { keep?: number | undefined },
  ): Promise<BackupExportView>
}

export function backupRoutes(): Route[] {
  return [
    route(
      {
        method: 'post',
        path: '/v1/backup/export',
        operationId: 'exportBackup',
        summary:
          '把整个工作区导成一个带清单与哈希的包，落到配置好的备份目录（owner；凭据只导密文）',
        tag: 'kernel',
        auth: 'bearer',
        assignment: true,
        authz: OWNER,
        body: ExportBody,
        returns: '{ out, bytes, events, kept, pruned[], at }（**不回包本身**）',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const backup = deps.backup
        if (backup === undefined)
          throw new ApiError('not_implemented', '这个服务进程没有装配备份（内存档没有数据目录）')
        const input = await body(c, ExportBody)
        return ok(
          c,
          await backup.export(
            {
              workspace_id: p.workspace_id,
              person_id: p.person_id,
              assignment_id: assignment.id,
            },
            { ...(input.keep === undefined ? {} : { keep: input.keep }) },
          ),
        )
      },
    ),
  ]
}
