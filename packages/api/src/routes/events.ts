/**
 * 21 §1 / 28 §2 事件流。
 *
 * v1 实现的是**长轮询**（不是 WS/SSE）：`GET /v1/events?since=<ulid>&types=&wait_ms=`
 * 返回 `{ events, next_since, has_more }`；客户端拿 `next_since` 继续拉，
 * 断线只需带上最后一条 ulid 即可续传，无丢无重（28 §4 用例 4）。
 * WS 面留给后续任务包，路径与参数保持一致。
 */
import type { EventEnvelope } from '@agentsws/contracts'
import { ApiError } from '../errors.js'
import { assignmentOf, intParam, listParam, ok, principalOf } from '../helpers.js'
import { type Route, route } from '../route-spec.js'

const READ = {
  domain: 'event_log',
  op: 'read',
  range: 'workspace',
  sensitivity: 'internal',
} as const

const DEFAULT_LIMIT = 200
const DEFAULT_MAX_WAIT = 25_000
const DEFAULT_POLL_INTERVAL = 50

export function eventRoutes(): Route[] {
  return [
    route(
      {
        method: 'get',
        path: '/v1/events',
        operationId: 'readEvents',
        summary: '事件流（长轮询，按 ulid 续传）',
        tag: 'event',
        auth: 'bearer',
        assignment: true,
        authz: READ,
        params: [
          { name: 'since', in: 'query', description: '上次收到的最后一条事件 id（ulid）' },
          { name: 'types', in: 'query', description: '事件类型，逗号分隔' },
          { name: 'run', in: 'query', description: 'run_id' },
          {
            name: 'limit',
            in: 'query',
            description: `一次最多返回多少条，默认 ${DEFAULT_LIMIT}`,
            schema: { type: 'integer' },
          },
          {
            name: 'wait_ms',
            in: 'query',
            description: '无新事件时最多挂多久（长轮询），默认 0',
            schema: { type: 'integer' },
          },
        ],
        returns: '{ events, next_since, has_more }',
      },
      async (c, deps) => {
        const p = principalOf(c)
        assignmentOf(c)
        const cfg = deps.options?.events ?? {}
        const maxWait = cfg.maxWaitMs ?? DEFAULT_MAX_WAIT
        const pollInterval = cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL
        const limit = intParam(c, 'limit') ?? cfg.defaultLimit ?? DEFAULT_LIMIT
        if (limit === 0) throw new ApiError('invalid_input', 'limit 必须大于 0')
        const waitMs = Math.min(intParam(c, 'wait_ms') ?? 0, maxWait)
        const since = c.req.query('since')
        const types = listParam(c, 'types')
        const run = c.req.query('run')
        const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

        const filter = {
          workspace_id: p.workspace_id,
          limit,
          ...(since === undefined ? {} : { since }),
          ...(types === undefined ? {} : { types }),
          ...(run === undefined ? {} : { run_id: run }),
        }
        const read = async (): Promise<EventEnvelope[]> => {
          const out: EventEnvelope[] = []
          for await (const e of deps.eventLog.read(filter)) out.push(e)
          return out
        }

        let events = await read()
        // 轮询轮数由 wait_ms / 间隔决定，不依赖时钟前进（测试里时钟是注入的假时钟）。
        const rounds = waitMs <= 0 ? 0 : Math.ceil(waitMs / pollInterval)
        for (let i = 0; i < rounds && events.length === 0; i += 1) {
          await sleep(pollInterval)
          events = await read()
        }
        const last = events[events.length - 1]
        return ok(c, {
          events,
          next_since: last?.id ?? since ?? null,
          has_more: events.length === limit,
        })
      },
    ),
  ]
}
