/**
 * WP224（docs/91 §2.2 #1）：**本周经营一页纸**的服务端那一半——取面板、出卡。
 *
 * 一页纸怎么写在 `@agentsws/deck` 的 `composeWeeklyReview`（纯函数）；这里只做两件事：
 *
 * 1. **按岗位取面板上下文**：老板那一面（店铺订单、投放 / 社媒 / 红人的投影）、「内容与搜索」
 *    担着的人那一面（按页收入周报卡只发给他）、客服担着的人那一面（回信草稿只在他队列里）。
 *    用的就是工作台面板那一份 `queryContext`——数字只从面板来。
 * 2. **秘书每周一推一张**：`weekly_review` 卡发给老板（L3 自动出、看完归档，不进审批队列）。
 *    同一周再跑一次 = 同一个 dedupe_key：还没归档的那张出新一版，已归档的被新的取代（`supersedes`），
 *    不会一周两张。
 *
 * 多品牌：一个品牌一个实例，各取各的面板、各出各的卡（WP215 每品牌调度）。
 */
import type { PositionSummary, WorkstationPort } from '@agentsws/api'
import type {
  ApprovalBus,
  Assignment,
  Clock,
  WeeklyReviewPayload,
  WorkspaceId,
} from '@agentsws/contracts'
import { composeWeeklyReview, type QueryContext } from '@agentsws/deck'

export interface WeeklyReviewServiceOptions {
  workspace_id: WorkspaceId
  clock: Clock
  /** 这个品牌里还在的分配（谁担着哪条职责）。 */
  assignments(): Assignment[]
  approvals: Pick<ApprovalBus, 'create'>
  /** 这个品牌的工作台端口（面板上下文从它来）。 */
  port(): Promise<WorkstationPort>
  brandName(): string | undefined
}

export interface WeeklyReviewService {
  /** 现在拼一份（不出卡；预览与测试用）。没有老板岗位就是 `undefined`。 */
  build(): Promise<WeeklyReviewPayload | undefined>
  /** 拼一份并推给老板（定时任务每周一调；「现在出一份」也调它）。 */
  run(): Promise<{ approval_item_id?: string; skipped?: string; week_of?: string }>
}

const OWNER_ROLE = 'common.owner'

export function createWeeklyReviewService(
  options: WeeklyReviewServiceOptions,
): WeeklyReviewService {
  const holderOf = (role_id: string): Assignment | undefined =>
    options.assignments().find((a) => a.role_id === role_id && a.revoked_at === undefined)

  /** 某条分配那一面的面板上下文（近 7 天）。拿不到就没有——那一块写「没接」。 */
  const contextOf = async (
    port: WorkstationPort,
    a: Assignment | undefined,
  ): Promise<QueryContext | undefined> => {
    if (a === undefined) return undefined
    const actor = { workspace_id: options.workspace_id, person_id: a.person_id }
    const position = (await port.positions(actor)).find(
      (p: PositionSummary) => p.position_id === a.id,
    )
    if (position === undefined) return undefined
    try {
      return await port.queryContext(actor, position, 'last_7d')
    } catch {
      return undefined
    }
  }

  const build = async (): Promise<WeeklyReviewPayload | undefined> => {
    const owner = holderOf(OWNER_ROLE)
    if (owner === undefined) return undefined
    const port = await options.port()
    const base = await contextOf(port, owner)
    if (base === undefined) return undefined
    const content = await contextOf(port, holderOf('dtc.content'))
    const support = await contextOf(port, holderOf('dtc.support'))
    const brand = options.brandName()
    return composeWeeklyReview({
      now: options.clock.now(),
      base,
      ...(content === undefined ? {} : { content }),
      ...(support === undefined ? {} : { support }),
      ...(brand === undefined ? {} : { brand }),
      held: [
        ...new Set(
          options
            .assignments()
            .filter((a) => a.revoked_at === undefined)
            .map((a) => a.role_id),
        ),
      ],
    })
  }

  return {
    build,
    async run() {
      const owner = holderOf(OWNER_ROLE)
      if (owner === undefined)
        return { skipped: '这个品牌没有「公司设置与授权」岗位，一页纸没人收' }
      const payload = await build()
      if (payload === undefined) return { skipped: '老板那一面的面板读不到' }
      const ws = options.workspace_id
      const item = await options.approvals.create<WeeklyReviewPayload>({
        workspace_id: ws,
        schema_version: 1,
        kind: 'weekly_review',
        role_id: OWNER_ROLE,
        subject: { object: { type: 'workspace', id: ws } },
        dedupe_key: `dk_${ws}|weekly_review|${payload.week_of}`,
        title: `本周经营一页纸 · ${payload.week_of}`,
        summary: payload.situation,
        payload,
        evidence: { source_events: [], provenance: { seen: [] }, precheck: {} },
        // 秘书推的（41 §1：秘书以本人权限运行，只读、不动任何东西）
        proposer: { kind: 'agent', id: 'agent_secretary', assignment_id: owner.id },
        automation: {
          level_at_creation: 'L3',
          auto_approved: true,
          mandate_check: { within: true, caps_hit: [] },
          sampling: { selected: false },
        },
        routing: {
          recipients: [{ person: owner.person_id, via: 'role_holder' }],
          rule: 'role_holder',
          escalation: { after_hours: 72, business_hours: true, chain: [], escalated_at: [] },
          separation_of_duties: false,
        },
        priority: 'digest',
      })
      return { approval_item_id: item.id, week_of: payload.week_of }
    },
  }
}
