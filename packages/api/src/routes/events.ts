/**
 * 21 §1 / 28 §2 事件流。
 *
 * 两个面读的是同一份东西：
 * - `GET /v1/events`（本文件）：长轮询，`?since=<ulid|时间>&until=<时间>&types=`，
 *   返回 `{ events, next_since, has_more }`；断线只需带上最后一条 ulid 即可续传，
 *   无丢无重（28 §4 用例 4）。
 * - `GET /v1/ws`（`routes/ws.ts`）：同一份可见性规则下的**摘要**推送。
 *
 * WP33 改了一件事：**非 owner 不再一律 403**（docs/35 §4 WP24 的遗留）。事件日志按岗位可读——
 * 有 `event_log.read/workspace` 的（common.owner）看全部；只有 `own` 的（common.member）
 * 看得到「与本 Assignment 相关」的那些：本人做的、本人岗位的审批项、本岗位 staged 的变更，
 * 以及这些东西所属的那次运行的其余事件。
 */
import type { ApprovalItem, Assignment, EventEnvelope, StagedChange } from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { assignmentOf, intParam, listParam, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'
import type { GatewayDeps, Principal } from '../types.js'

/**
 * 事件日志的读权限元组。
 *
 * `range: 'own'` 是 WP33 的关键改动：原来写死 `workspace`，于是任何非 owner 拿到的都是 403。
 * 判「能不能看全部」放到处理器里再查一次 `workspace`。
 */
const READ = {
  domain: 'event_log',
  op: 'read',
  range: 'own',
  sensitivity: 'internal',
} as const

const READ_ALL = { ...READ, range: 'workspace' } as const

export const DEFAULT_EVENT_LIMIT = 200
const DEFAULT_MAX_WAIT = 25_000
const DEFAULT_POLL_INTERVAL = 50

/** 26 个 Crockford Base32 字符（21 §1「id 为 ULID，时间有序」）。 */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** `since` 既可以是续传游标（ulid），也可以是时间下界（ISO-8601）。 */
export function parseSince(raw: string | undefined): { cursor?: string; from?: string } {
  if (raw === undefined || raw.trim() === '') return {}
  const value = raw.trim()
  if (ULID_RE.test(value)) return { cursor: value }
  const at = Date.parse(value)
  // 不是 ulid 也不是时间：当成游标原样下推（测试替身的假 ulid、别的实现的 id 形状）
  if (Number.isNaN(at)) return { cursor: value }
  return { from: new Date(at).toISOString() }
}

/** `until` 只能是时间（ISO-8601），闭区间。 */
export function parseUntil(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const at = Date.parse(raw.trim())
  if (Number.isNaN(at)) throw new ApiError('invalid_input', 'until 必须是 ISO-8601 时间')
  return new Date(at).toISOString()
}

/**
 * 一个岗位看得见哪些事件（19 §3 过滤下推的同一条原则：先算可见集合，不是先给再抹）。
 *
 * 判据按便宜到贵排：
 * 1. `actor.id` 就是本人 / 本岗位 —— 自己做的事一定看得见；
 * 2. `subject` 是审批项 —— 取那张卡：本岗位职责的、或本人是收件人 / 受理人 / 提议者的，算；
 * 3. `subject` / `correlation` 是账本条目 —— 取那条变更：`assignment_id` 是本岗位的，算；
 * 4. 上面任一条命中时把它的 `run_id` 记下来 —— 同一次运行的其余事件（`tool.call`、
 *    `text.delta` …）跟着可见，否则一条运行的事件会被切得七零八落。
 *
 * 第 4 条要两趟：第一趟定可见集合与 run 集合，第二趟把挂在这些 run 上的补进来。
 */
export class AssignmentVisibility {
  readonly #deps: GatewayDeps
  readonly #principal: Principal
  readonly #assignment: Assignment
  readonly #approvals = new Map<string, ApprovalItem | undefined>()
  readonly #changes = new Map<string, StagedChange | undefined>()

  constructor(deps: GatewayDeps, principal: Principal, assignment: Assignment) {
    this.#deps = deps
    this.#principal = principal
    this.#assignment = assignment
  }

  async #approval(id: string): Promise<ApprovalItem | undefined> {
    if (this.#approvals.has(id)) return this.#approvals.get(id)
    let item: ApprovalItem | undefined
    try {
      item = await this.#deps.approvals.get(id)
    } catch {
      // 查不动就当看不见——可见性判断不该把整条事件流拖垮
      item = undefined
    }
    this.#approvals.set(id, item)
    return item
  }

  async #change(id: string): Promise<StagedChange | undefined> {
    if (this.#changes.has(id)) return this.#changes.get(id)
    let change: StagedChange | undefined
    try {
      change = await this.#deps.changes.get(id)
    } catch {
      change = undefined
    }
    this.#changes.set(id, change)
    return change
  }

  #minesApproval(item: ApprovalItem): boolean {
    const me = this.#principal.person_id
    if (item.workspace_id !== this.#principal.workspace_id) return false
    if (item.role_id === this.#assignment.role_id) return true
    if (item.routing.recipients.some((r) => r.person === me)) return true
    if (item.routing.assignee === me) return true
    if (item.proposer.assignment_id === this.#assignment.id) return true
    return item.proposer.kind === 'person' && item.proposer.id === me
  }

  /** 单条事件的直接判定（不含「同一次运行」的传递可见性）。 */
  async direct(e: EventEnvelope): Promise<boolean> {
    if (e.workspace_id !== this.#principal.workspace_id) return false
    if (e.actor.id === this.#principal.person_id || e.actor.id === this.#assignment.id) return true
    const subject = e.subject
    if (subject?.type === 'approval_item') {
      const item = await this.#approval(subject.id)
      if (item !== undefined && this.#minesApproval(item)) return true
    }
    const change_id =
      e.correlation.change_id ?? (subject?.type === 'staged_change' ? subject.id : undefined)
    if (change_id !== undefined) {
      const change = await this.#change(change_id)
      if (change !== undefined && change.assignment_id === this.#assignment.id) return true
    }
    return false
  }

  /** 两趟：先直接判定并收集可见的 run_id，再把同一次运行的其余事件补进来。 */
  async filter(events: EventEnvelope[]): Promise<EventEnvelope[]> {
    const visible = new Set<string>()
    const runs = new Set<string>()
    for (const e of events) {
      if (!(await this.direct(e))) continue
      visible.add(e.id)
      const run = e.correlation.run_id ?? e.actor.run_id
      if (run !== undefined) runs.add(run)
    }
    return events.filter((e) => {
      if (visible.has(e.id)) return true
      const run = e.correlation.run_id ?? e.actor.run_id
      return run !== undefined && runs.has(run)
    })
  }
}

/** 有没有「看全工作区」的权限（owner 一档）。 */
export function canReadAll(deps: GatewayDeps, assignment_id: string): boolean {
  return deps.roles.can(assignment_id, READ_ALL.domain, READ_ALL.op, {
    range: READ_ALL.range,
    sensitivity: READ_ALL.sensitivity,
  })
}

export interface EventQuery {
  cursor?: string | undefined
  from?: string | undefined
  until?: string | undefined
  types?: string[] | undefined
  run_id?: string | undefined
  limit: number
}

/**
 * 读一批事件并按岗位过滤。
 *
 * `limit` 是**过滤前**的读取上限：过滤会让实际返回条数变少，这是按岗位可读的必然结果；
 * 续传游标用过滤前最后一条的 id，所以下一页不会漏也不会重。
 */
export async function readVisibleEvents(
  deps: GatewayDeps,
  principal: Principal,
  assignment: Assignment,
  query: EventQuery,
): Promise<{ events: EventEnvelope[]; scanned: EventEnvelope[] }> {
  const filter = {
    workspace_id: principal.workspace_id,
    limit: query.limit,
    ...(query.cursor === undefined ? {} : { since: query.cursor }),
    ...(query.types === undefined ? {} : { types: query.types }),
    ...(query.run_id === undefined ? {} : { run_id: query.run_id }),
  }
  const scanned: EventEnvelope[] = []
  for await (const e of deps.eventLog.read(filter)) scanned.push(e)
  // 时间范围在网关这一层过滤：契约的 `EventLog.read` 只有 ulid 游标，没有时间上下界
  // （21 的遗留，见交付报告「需要契约改动」）。ulid 时间有序，所以顺序不受影响。
  const ranged = scanned.filter(
    (e) =>
      (query.from === undefined || e.at >= query.from) &&
      (query.until === undefined || e.at <= query.until),
  )
  if (canReadAll(deps, assignment.id)) return { events: ranged, scanned }
  const visibility = new AssignmentVisibility(deps, principal, assignment)
  return { events: await visibility.filter(ranged), scanned }
}

export function eventRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/events',
        operationId: 'readEvents',
        summary: '事件流（长轮询，按 ulid 续传；非 owner 只看得到与本岗位相关的）',
        tag: 'event',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          {
            name: 'since',
            in: 'query',
            description: '上次收到的最后一条事件 id（ulid），或时间下界（ISO-8601）',
          },
          { name: 'until', in: 'query', description: '时间上界（ISO-8601，闭区间）' },
          { name: 'types', in: 'query', description: '事件类型，逗号分隔' },
          { name: 'run', in: 'query', description: 'run_id' },
          {
            name: 'limit',
            in: 'query',
            description: `一次最多读多少条（过滤前），默认 ${DEFAULT_EVENT_LIMIT}`,
            schema: { type: 'integer' },
          },
          {
            name: 'wait_ms',
            in: 'query',
            description: '无新事件时最多挂多久（长轮询），默认 0',
            schema: { type: 'integer' },
          },
        ],
        returns: '{ events, next_since, has_more, scope }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        const assignment = assignmentOf(c)
        const cfg = deps.options?.events ?? {}
        const maxWait = cfg.maxWaitMs ?? DEFAULT_MAX_WAIT
        const pollInterval = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL
        const limit = intParam(c, 'limit') ?? cfg.defaultLimit ?? DEFAULT_EVENT_LIMIT
        if (limit === 0) throw new ApiError('invalid_input', 'limit 必须大于 0')
        const waitMs = Math.min(intParam(c, 'wait_ms') ?? 0, maxWait)
        const { cursor, from } = parseSince(c.req.query('since'))
        const until = parseUntil(c.req.query('until'))
        const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
        const query: EventQuery = {
          cursor,
          from,
          until,
          types: listParam(c, 'types'),
          run_id: c.req.query('run'),
          limit,
        }

        let out = await readVisibleEvents(deps, p, assignment, query)
        // 轮询轮数由 wait_ms / 间隔决定，不依赖时钟前进（测试里时钟是注入的假时钟）。
        const rounds = waitMs <= 0 ? 0 : Math.ceil(waitMs / pollInterval)
        for (let i = 0; i < rounds && out.events.length === 0; i += 1) {
          await sleep(pollInterval)
          out = await readVisibleEvents(deps, p, assignment, query)
        }
        // 续传游标用**过滤前**最后一条：否则被过滤掉的那些会被反复重读。
        const last = out.scanned[out.scanned.length - 1]
        return ok(c, {
          events: out.events,
          next_since: last?.id ?? cursor ?? null,
          has_more: out.scanned.length === limit,
          scope: canReadAll(deps, assignment.id) ? 'workspace' : 'assignment',
        })
      },
    ),
  ]
}
