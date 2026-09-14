/**
 * 服务进程端：公司档案的「你卖的是」→ 运行请求（WP54，48 v2 L2 / 46 §1）。
 *
 * 交付四把三段接起来：向导第 ① 步写档案 → `onboarding.vertical()` → 运行时装
 * `RunRequest.vertical` → 客服共享包按它取词表 / 人设 / 边界。前两段的往返在
 * `onboarding.test.ts` 里已经钉住了，这里钉住**后两段**，因为它们才是"选了虚拟
 * 产品，AI 真的换了一套话术"的那一跳：
 *
 * - 没设过档案 → 请求里**没有** `vertical`，共享包回落实物（存量工作区零变化）；
 * - 设成虚拟产品 → 下一次运行的请求里就是 `digital`，**不用重启**（晚绑定）；
 * - 改回实物 → 再下一次就是 `goods`；
 * - 只改公司名不给垂直 → 沿用上一次，运行请求跟着沿用。
 *
 * 跑的是真装配线（路由 → OnboardingPort → `createRuntime` → adapter），只在
 * `runtime.adapter` 外面套一层壳把请求抄下来——`Server.runtime` 本来就是导出的，
 * 抄完照样喂给真适配器，运行该怎么跑还怎么跑。
 */
import type { RunRequest } from '@agentsws/contracts'
import { getVerticalPack } from '@agentsws/support-core'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'

const T0 = '2026-09-14T09:00:00.000Z'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 7): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

let server: Server | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
})

/** 起一台跑真运行时的服务进程（没有模型 provider → stub 适配器）。 */
async function boot(): Promise<{
  server: Server
  /** 每一次运行的 `RunRequest`，按发生顺序。 */
  requests: RunRequest[]
  call: (method: string, path: string, body?: unknown) => Promise<Response>
  /** 起一次运行，回这次的请求。 */
  run: () => Promise<RunRequest>
}> {
  const s = await createServer({
    clock: makeClock(),
    random: seeded(),
    quiet: true,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'wang@nordvolt.cn' },
    // 局域网多播换成不做事的替身：这条测试跟发现无关，不该真去广播
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  server = s
  const runtime = s.runtime
  if (runtime === undefined) throw new Error('这个进程该有运行时')

  const requests: RunRequest[] = []
  const real = runtime.adapter.run.bind(runtime.adapter)
  runtime.adapter.run = (req, sink, signal) => {
    requests.push(req)
    return real(req, sink, signal)
  }

  const call = (method: string, path: string, body?: unknown): Promise<Response> => {
    const headers = new Headers({
      Authorization: `Bearer ${s.bootstrap.internalToken}`,
      'X-Assignment': s.bootstrap.ownerAssignment.id,
    })
    if (body !== undefined) headers.set('content-type', 'application/json')
    return s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
  }

  const run = async (): Promise<RunRequest> => {
    const before = requests.length
    const matter = s.work.createMatter({ kind: 'conversation', title: '客户来信' })
    await runtime.startRun({
      matter,
      brief: '客户问能不能退',
      actor: {
        person_id: s.bootstrap.person.id,
        assignment_id: s.bootstrap.ownerAssignment.id,
      },
    })
    const req = requests[before]
    if (req === undefined) throw new Error('这次运行没到适配器')
    return req
  }

  return { server: s, requests, call, run }
}

const profileOf = async (res: Response): Promise<{ vertical?: string }> => {
  const parsed = (await res.json()) as { data?: { vertical?: string } }
  if (parsed.data === undefined) throw new Error(`没有 data：${JSON.stringify(parsed)}`)
  return parsed.data
}

describe('48 v2 L2 档案 →「运行请求带 vertical」', () => {
  it('没设过档案 → 请求里没有 vertical，共享包回落实物', async () => {
    const m = await boot()
    const req = await m.run()
    expect(req.vertical).toBeUndefined()
    // 拿不到垂直时的行为必须与这一版上线前完全相同 = 实物那一套
    expect(getVerticalPack(req.vertical).key).toBe('goods')
  })

  it('设成虚拟产品 → 下一次运行就用虚拟那一套，不用重启', async () => {
    const m = await boot()
    // 装配好之后才写档案：晚绑定的那一跳就是这里
    const first = await m.run()
    expect(first.vertical).toBeUndefined()

    const saved = await profileOf(
      await m.call('PUT', '/v1/workspace/profile', {
        legal_name: '一家 SaaS',
        vertical: 'digital',
      }),
    )
    expect(saved.vertical).toBe('digital')

    const second = await m.run()
    expect(second.vertical).toBe('digital')
    expect(getVerticalPack(second.vertical).key).toBe('digital')
  })

  it('只改公司名不给垂直 → 沿用上一次；显式改回实物 → 请求跟着变', async () => {
    const m = await boot()
    await m.call('PUT', '/v1/workspace/profile', { legal_name: '一家 SaaS', vertical: 'digital' })

    // 改个名字不该把垂直悄悄改回实物（档案往返）
    const renamed = await profileOf(
      await m.call('PUT', '/v1/workspace/profile', { legal_name: '一家 SaaS 公司' }),
    )
    expect(renamed.vertical).toBe('digital')
    expect((await m.run()).vertical).toBe('digital')

    // 显式改回来
    const back = await profileOf(
      await m.call('PUT', '/v1/workspace/profile', {
        legal_name: '一家 SaaS 公司',
        vertical: 'goods',
      }),
    )
    expect(back.vertical).toBe('goods')
    expect((await m.run()).vertical).toBe('goods')
  })

  it('每次运行都现读一次档案：同一个运行时装配，前后两次拿到不同的垂直', async () => {
    const m = await boot()
    await m.call('PUT', '/v1/workspace/profile', { legal_name: '诺伏特', vertical: 'goods' })
    const a = await m.run()
    await m.call('PUT', '/v1/workspace/profile', { legal_name: '诺伏特', vertical: 'digital' })
    const b = await m.run()
    expect([a.vertical, b.vertical]).toEqual(['goods', 'digital'])
    // 同一条装配线：两次运行的适配器、工作区、岗位都是同一个
    expect(a.workspace_id).toBe(b.workspace_id)
    expect(a.actor.assignment_id).toBe(b.actor.assignment_id)
  })
})
