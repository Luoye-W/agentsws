/**
 * WP259 端到端：「交给它」一大段多行需求不再被 400 静默拒收，完整原文进首轮运行。
 *
 * 真装配线（路由 → 网关校验 → positions.ts / work 端口 → 工作模型），只把 `startRun` 换成
 * 记账的替身——它收到的 `brief` 就是首轮运行拿到的任务文本。钉住：
 * - 岗位入口（自动路由 / 指定职责）：超长多行 → 标题「第一句…」，描述与运行任务都是完整原文；
 * - `POST /v1/matters`（「用这条职责开」）：超长不再 400；带 `run: true` 开完立刻起首轮运行，
 *   时间线第一条就是用户原话全文（10-07 真机：原来不起跑、时间线空着）；
 * - 正好 120 字不拆、空白回一句人话。
 */
import type { Assignment, Matter, MatterEvent } from '@agentsws/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-10-07T01:00:00.000Z'

/** 200 字上下、分四行的建站需求（10-07 真机那段同样的形状）。 */
const LONG = [
  '用 agentsws-theme 帮我搭一个英文首页，先别发布。',
  '首屏放主推的三款产品，每款配一句卖点；下面依次是品牌故事、客户评价、常见问题和订阅邮件的入口。',
  '颜色跟品牌色走，字体用无衬线，手机上要好看。做好之后推一个未发布主题，把预览链接给我，我看过再决定要不要发布。',
  '别动现在在线的主题，也别改商品价格和库存；有拿不准的地方先停下来问我，不要自己猜。页脚记得放退换货政策、运费说明和联系邮箱的链接。',
].join('\n')

let server: Server
const briefs: { matter: Matter; brief: string; assignment_id: string }[] = []
const held = new Map<string, Assignment>()

const call = async (
  method: string,
  path: string,
  options: { body?: unknown; assignment?: string } = {},
): Promise<Response> => {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${server.bootstrap.internalToken}`)
  headers.set('X-Assignment', options.assignment ?? server.bootstrap.ownerAssignment.id)
  if (options.body !== undefined) headers.set('content-type', 'application/json')
  return server.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  )
}

const json = async <T>(res: Response): Promise<T> => {
  const parsed = (await res.json()) as { data?: unknown; code?: string; message?: string }
  if (parsed.data === undefined) throw new Error(`没有 data：${parsed.code} ${parsed.message}`)
  return parsed.data as T
}

const idOf = (role_id: string): string => {
  const a = held.get(role_id)
  if (a === undefined) throw new Error(`没挂上这条职责：${role_id}`)
  return a.id
}

const timeline = (matter_id: string): MatterEvent[] => server.work.store.listMatterEvents(matter_id)

beforeEach(async () => {
  briefs.length = 0
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
    startRun: (input) => {
      briefs.push({
        matter: input.matter,
        brief: input.brief,
        assignment_id: input.actor.assignment_id,
      })
      return { run_id: `run_${briefs.length}` }
    },
  })
  held.clear()
  for (const role_id of ['dtc.store', 'dtc.content']) {
    held.set(
      role_id,
      server.roles.assignments.create({
        person_id: server.bootstrap.person.id,
        workspace_id: server.bootstrap.workspace.id,
        role_id,
        granted_by: server.bootstrap.person.id,
        ranges: [{ kind: 'store', id: 'store_1' }],
      }),
    )
  }
})

afterEach(async () => {
  await server.close()
})

describe('WP259 岗位入口：长文本照收，完整原文进首轮运行', () => {
  it('需求本身 ≥ 200 字、多行', () => {
    expect(Array.from(LONG).length).toBeGreaterThanOrEqual(200)
    expect(LONG.split('\n')).toHaveLength(4)
  })

  it('直接把整段当标题交（老客户端 / 直接调接口）→ 服务端拆开，不 400', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', { body: { title: LONG } })
    expect(res.status).toBe(201)
    const out = await json<{ matter: Matter; run_id?: string }>(res)
    // WP264（决策 184）：首轮开跑时起短标题；测试里没接模型 → 退回原话前 20 字宽（WP259 的「首句…」只是临时的）
    expect(out.matter.title).toBe('用 agentsws-theme 帮我搭一个英文首页，先…')
    expect(server.work.getMatter(out.matter.id)?.title_source).toBe('brief')
    expect(out.run_id).toBeDefined()
    expect(server.work.getMatter(out.matter.id)?.context.summary).toBe(LONG)
    // 首轮运行收到的任务就是完整原文（不是标题、也不把开头重复一遍）
    expect(briefs).toHaveLength(1)
    expect(briefs[0]?.brief).toBe(LONG)
    const said = timeline(out.matter.id).filter((e) => e.kind === 'human_message')
    expect(said.map((e) => e.text)).toEqual([LONG])
  })

  it('工作台拆好的（标题 + 完整原文）→ 运行拿到的还是原文一份', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', {
      body: { title: '用 agentsws-theme 帮我搭一个英文首页，先别发布…', summary: LONG },
    })
    expect(res.status).toBe(201)
    expect(briefs[0]?.brief).toBe(LONG)
  })

  it('指定职责（role_id）也一样：原文进运行，用的是那条职责的分配', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', {
      body: { title: LONG, role_id: 'dtc.content' },
    })
    expect(res.status).toBe(201)
    expect(briefs[0]?.brief).toBe(LONG)
    expect(briefs[0]?.assignment_id).toBe(idOf('dtc.content'))
  })

  it('空白：400，回一句人话', async () => {
    const res = await call('POST', '/v1/positions/web-ops/matters', { body: { title: '   ' } })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { message: string }
    expect(body.message).toContain('说一句要办的事')
    expect(briefs).toHaveLength(0)
  })
})

describe('WP259 「用这条职责开」（POST /v1/matters）', () => {
  it('超长多行 + run → 不 400；开完立刻用这条职责起首轮运行，时间线第一条是原话全文', async () => {
    const res = await call('POST', '/v1/matters', {
      body: { kind: 'adhoc', title: LONG, run: true },
      assignment: idOf('dtc.store'),
    })
    expect(res.status).toBe(201)
    const out = await json<{ matter: Matter; run_id?: string }>(res)
    expect(Array.from(out.matter.title).length).toBeLessThanOrEqual(120)
    expect(out.matter.entry).toBe('role')
    expect(out.matter.role_id).toBe('dtc.store')
    expect(out.matter.context.summary).toBe(LONG)
    expect(out.run_id).toBe('run_1')
    expect(briefs).toEqual([
      expect.objectContaining({ brief: LONG, assignment_id: idOf('dtc.store') }),
    ])
    const events = timeline(out.matter.id)
    expect(events[0]).toMatchObject({ kind: 'human_message', text: LONG })
    expect(events.some((e) => e.kind === 'run' && e.run_id === 'run_1')).toBe(true)
  })

  it('短标题 + run：任务文本就是那一句', async () => {
    const res = await call('POST', '/v1/matters', {
      body: { kind: 'adhoc', title: '把首页 banner 换成秋季款', run: true },
      assignment: idOf('dtc.store'),
    })
    expect(res.status).toBe(201)
    expect(briefs[0]?.brief).toBe('把首页 banner 换成秋季款')
  })

  it('正好 120 字、不带 run：原样当标题，不拆、不起跑（老行为）', async () => {
    const title = '字'.repeat(120)
    const res = await call('POST', '/v1/matters', {
      body: { kind: 'adhoc', title },
      assignment: idOf('dtc.store'),
    })
    expect(res.status).toBe(201)
    const out = await json<{ matter: Matter; run_id?: string }>(res)
    expect(out.matter.title).toBe(title)
    expect(out.matter.context.summary).toBe('')
    expect(out.run_id).toBeUndefined()
    expect(briefs).toHaveLength(0)
  })

  it('121 字一行：拆成「前 40 字…」，原文进描述', async () => {
    const title = '字'.repeat(121)
    const out = await json<{ matter: Matter }>(
      await call('POST', '/v1/matters', {
        body: { kind: 'adhoc', title },
        assignment: idOf('dtc.store'),
      }),
    )
    expect(out.matter.title).toBe(`${'字'.repeat(40)}…`)
    expect(out.matter.context.summary).toBe(title)
  })

  it('空白：400，回一句人话（不再是 zod 原文）', async () => {
    const res = await call('POST', '/v1/matters', {
      body: { kind: 'adhoc', title: ' \n ', run: true },
      assignment: idOf('dtc.store'),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { message: string }).message).toContain('说一句要办的事')
  })
})
