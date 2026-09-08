import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collect,
  createKernel,
  FixedClock,
  hello,
  helloInstances,
  type Kernel,
  seededRandom,
} from '../src/index.js'

const WS = 'ws_kernel'
const kernels: Kernel[] = []
const dirs: string[] = []

async function boot(options: Parameters<typeof createKernel>[0] = {}): Promise<Kernel> {
  const kernel = await createKernel({
    clock: new FixedClock('2026-09-08T09:00:00.000Z'),
    random: seededRandom(11),
    env: {},
    ...options,
  })
  kernels.push(kernel)
  return kernel
}

afterEach(async () => {
  for (const kernel of kernels.splice(0)) await kernel.dispose()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  helloInstances.clear()
})

describe('createKernel（28 §1 内核 = Cordis 容器）', () => {
  it('四个内核服务以 Cordis 服务的形式挂在根上下文上', async () => {
    const kernel = await boot()
    expect(kernel.ctx.eventLog).toBe(kernel.eventLog)
    expect(kernel.ctx.halt).toBe(kernel.halt)
    expect(kernel.ctx.trace).toBe(kernel.trace)
    expect(kernel.ctx.modules).toBe(kernel.modules)
    expect(kernel.ctx.get('eventLog')).toBe(kernel.eventLog)
  })

  it('示例插件 inject EventLog 并写一条事件，事件能从 eventLog 读回来', async () => {
    const kernel = await boot()
    await kernel.ctx.plugin(hello, { workspace_id: WS, greeting: '你好' })

    const events = await collect(kernel.eventLog.read({ workspace_id: WS }))
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('kernel.hello')
    expect(events[0]?.payload).toEqual({ greeting: '你好' })
    expect(events[0]?.actor).toEqual({ kind: 'system', id: 'plugin:hello' })
    expect(events[0]?.correlation.trace_id).toMatch(/^[0-9a-f]{32}$/)
    expect(helloInstances.get(WS)?.event_id).toBe(events[0]?.id)
  })

  it('Schemastery 校验插件配置：缺必填拒绝，缺省值补齐', async () => {
    const kernel = await boot()
    await expect(kernel.ctx.plugin(hello, {} as never)).rejects.toThrow()
    await kernel.ctx.plugin(hello, { workspace_id: WS } as never)
    expect(helloInstances.get(WS)?.greeting).toBe('hello')
  })

  it('ctx.effect 注册的回收在 fiber 卸载时跑；事件仍在（append-only）', async () => {
    const kernel = await boot()
    const fiber = await kernel.ctx.plugin(hello, { workspace_id: WS, greeting: 'bye' })
    expect(helloInstances.has(WS)).toBe(true)
    await fiber.dispose()
    expect(helloInstances.has(WS)).toBe(false)
    expect(await collect(kernel.eventLog.read({ workspace_id: WS }))).toHaveLength(1)
  })

  it('依赖不在就挂起：eventLog 被隔离掉的子上下文里，插件不会跑', async () => {
    const kernel = await boot()
    const isolated: Context = kernel.ctx.isolate('eventLog').isolate('trace')
    const fiber = isolated.plugin(hello, { workspace_id: WS, greeting: 'hi' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(helloInstances.has(WS)).toBe(false)
    expect(await collect(kernel.eventLog.read({ workspace_id: WS }))).toHaveLength(0)
    await fiber.dispose()
  })

  it('急停来自注入的 env，不读 process.env', async () => {
    const kernel = await boot({ env: { AGENTSWS_HALT: 'outbound', AGENTSWS_MODEL_HALT: '1' } })
    expect(kernel.halt.isHalted('outbound')).toBe(true)
    expect(kernel.halt.isHalted('model')).toBe(true)
    expect(kernel.halt.isHalted('learning')).toBe(false)
  })

  it('带模块清单启动：健康度可见', async () => {
    const body = 'module\n'
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-kernel-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'm.js'), body)
    const manifestPath = join(dir, 'modules.yml')
    writeFileSync(
      manifestPath,
      JSON.stringify({
        modules: [
          {
            id: 'm',
            version: '1.0.0',
            publisher: 'official',
            entry: './m.js',
            signature: `sha256:${createHash('sha256').update(body).digest('hex')}`,
            requires: { 'agentsws.data': '^1.0.0' },
          },
        ],
      }),
    )
    const kernel = await boot({ modules: { manifestPath } })
    expect(kernel.modules.health()).toEqual([
      {
        id: 'm',
        state: 'pending',
        missing: ['agentsws.data@^1.0.0'],
        detail: 'waiting for agentsws.data@^1.0.0',
      },
    ])
  })

  it('落盘的事件日志跨进程仍然只追加', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-kernel-'))
    dirs.push(dir)
    const dbPath = join(dir, 'events.db')
    const first = await boot({ dbPath })
    await first.ctx.plugin(hello, { workspace_id: WS, greeting: 'persisted' })
    await first.dispose()
    kernels.splice(kernels.indexOf(first), 1)

    const second = await boot({ dbPath })
    const events = await collect(second.eventLog.read({ workspace_id: WS }))
    expect(events).toHaveLength(1)
    expect(() =>
      second.eventLog.database.prepare('DELETE FROM events WHERE id = ?').run(events[0]?.id),
    ).toThrow(/append-only: DELETE rejected/)
  })

  it('非法内核配置被 Schemastery 拦下', async () => {
    await expect(createKernel({ dbPath: 42 as unknown as string })).rejects.toThrow(
      /invalid kernel options/,
    )
  })

  it('dispose 幂等且摘掉服务', async () => {
    const kernel = await boot()
    await kernel.dispose()
    await kernel.dispose()
    kernels.splice(kernels.indexOf(kernel), 1)
    expect(kernel.ctx.get('eventLog')).toBeUndefined()
  })
})
