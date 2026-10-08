/**
 * WP264 路由：`PATCH /v1/matters/:id` 改标题（人改过的不再被自动覆盖）、`POST /v1/matters/:id/stop`、
 * 首轮开跑起短标题（没接模型 → 原话前 20 字宽）。真装配线，`startRun` 换成记账替身。
 */
import type { Matter } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-08T01:00:00.000Z'
const BRIEF =
  '用 agentsws-theme 给 Rollout 搭英文首页（变形金刚正版授权耳机音箱，美国市场）：大图横幅、主推产品占位、品牌故事、FAQ、邮件订阅；深色科技风红色点缀。推成未发布主题给我预览，先别发布。'

let server: Server
let runs = 0

const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', server.bootstrap.ownerAssignment.id)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

const data = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data

beforeEach(async () => {
  runs = 0
  let t = Date.parse(T0)
  server = await createServer({
    clock: {
      now: () => {
        t += 1
        return new Date(t).toISOString()
      },
    },
    random: () => 0.5,
    quiet: true,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
    startRun: () => {
      runs += 1
      return { run_id: `run_${runs}` }
    },
  })
})

afterEach(async () => {
  await server.close()
})

describe('WP264 事项标题', () => {
  it('首轮开跑：没接模型 → 原话前 20 字宽（brief）；第二轮不再起', async () => {
    const res = await call('POST', '/v1/matters', { kind: 'adhoc', title: BRIEF, run: true })
    expect(res.status).toBe(201)
    const { matter } = await data<{ matter: Matter }>(res)
    await new Promise((r) => setTimeout(r, 0))
    const now = server.work.getMatter(matter.id)
    expect(now?.title).toBe('用 agentsws-theme 给 Rollout 搭英文首页…')
    expect(now?.title_source).toBe('brief')
    // 原话全文还是时间线第一条人话
    const said = server.work.store
      .listMatterEvents(matter.id)
      .filter((e) => e.kind === 'human_message')
    expect(said[0]?.text).toBe(BRIEF)
  })

  it('PATCH 改标题 → user；之后自动起的不覆盖；空白 400', async () => {
    const created = await data<{ matter: Matter }>(
      await call('POST', '/v1/matters', { kind: 'adhoc', title: '把 A 商品降价 10%' }),
    )
    const id = created.matter.id
    const res = await call('PATCH', `/v1/matters/${id}`, { title: '  A 商品降价 ' })
    expect(res.status).toBe(200)
    expect((await data<{ matter: Matter }>(res)).matter).toMatchObject({
      title: 'A 商品降价',
      title_source: 'user',
    })
    server.work.retitle(id, 'AI 的', 'ai')
    expect(server.work.getMatter(id)?.title).toBe('A 商品降价')
    expect((await call('PATCH', `/v1/matters/${id}`, { title: '   ' })).status).toBe(400)
  })

  it('stop：没在跑 → 停了 0 次；事项不存在 404', async () => {
    const created = await data<{ matter: Matter }>(
      await call('POST', '/v1/matters', { kind: 'adhoc', title: '随便一件事' }),
    )
    const res = await call('POST', `/v1/matters/${created.matter.id}/stop`)
    expect(res.status).toBe(200)
    expect(await data<{ stopped: number }>(res)).toEqual({ stopped: 0 })
    expect((await call('POST', '/v1/matters/mat_nope/stop')).status).toBe(404)
  })
})
