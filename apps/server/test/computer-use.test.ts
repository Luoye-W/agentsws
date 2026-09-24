/**
 * WP144（docs/80）：电脑操控在服务进程这一侧——三层开关、授权、正在操作 / 停止。
 *
 * 钉住的纪律：
 * - **默认关、一条都不勾**；Docker / 托管 / 公司服务器上打不开，`forRun` 永远不给；
 * - 驱动**装好了才给**（给一个指不到文件的路径会让整次运行失败）；
 * - 授权卡批了才有授权，一次授权**只给下一次运行用一回**，过期不给；驳回什么都不发生；
 * - 看得见、停得住：带授权的运行登记成「正在操作」，停止 = 撤销授权 + 中断那次运行；
 *   总开关一关同样停。
 *
 * 不出网、不起真驱动：驱动在不在、自检、打开系统设置全是注入的替身。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, DecideInput } from '@agentsws/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { clampMinutes, createComputerUse } from '../src/computer-use.js'
import type { ComputerUseLock } from '../src/computer-use-install.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-cu-'))
  dirs.push(d)
  return d
}

const LOCK: ComputerUseLock = {
  driver: {
    name: 'cua-driver',
    version: '0.28.0',
    tag: 'cua-driver-rs-v0.28.0',
    assets: {
      'darwin-arm64': {
        url: 'https://x.invalid/d.tar.gz',
        sha256: 'a'.repeat(64),
        binary: 'cua-driver',
      },
      'darwin-x64': {
        url: 'https://x.invalid/d.tar.gz',
        sha256: 'a'.repeat(64),
        binary: 'cua-driver',
      },
    },
  },
  providers: {},
}

const T0 = Date.parse('2026-09-24T10:00:00.000Z')

function make(
  over: {
    mode?: 'local' | 'docker' | 'hosted'
    installed?: boolean
    now?: () => number
    dir?: string
    opened?: string[]
  } = {},
) {
  let mode = over.mode ?? 'local'
  const dir = over.dir ?? tempDir()
  const cu = createComputerUse({
    dir,
    dataDir: dir,
    runtimeMode: () => mode,
    clock: { now: () => new Date(T0).toISOString() },
    wallClockMs: over.now ?? (() => T0),
    platform: 'darwin',
    lock: LOCK,
    driverExists: () => over.installed ?? true,
    selfCheck: async () => ({
      ok: false,
      raw: '✅ Accessibility: granted.\n❌ Screen Recording: NOT granted.',
      checks: [
        { name: 'accessibility', ok: true, detail: '✅ Accessibility: granted.' },
        {
          name: 'screen_recording',
          ok: false,
          detail: '❌ Screen Recording: NOT granted.',
          fix: '去录屏那一页',
        },
      ],
      detail: '还有权限没给',
    }),
    openUrl: async (url) => {
      over.opened?.push(url)
    },
  })
  return { cu, dir, setMode: (m: typeof mode) => (mode = m) }
}

/** 最小的审批总线替身：decide 把卡翻成给定的状态。 */
function busOf(kind: string, state: ApprovalItem['state'], payload: unknown = { minutes: 10 }) {
  return {
    async decide(id: string, _by: never, _input: DecideInput): Promise<ApprovalItem> {
      return { id, kind, state, payload } as unknown as ApprovalItem
    },
  }
}
const APPROVE: DecideInput = { decision_token: 't', action: 'approve', via: 'workbench' as never }

describe('三层开关的前两层：默认关、只有本机档能开', () => {
  it('缺省：关着、一条职责都不勾、10 分钟；forRun 不给', () => {
    const { cu } = make()
    const v = cu.get()
    expect(v).toMatchObject({
      enabled: false,
      roles: [],
      minutes: 10,
      allowed: true,
      platform: 'darwin',
    })
    expect(v.driver).toMatchObject({
      installed: true,
      pinned_version: '0.28.0',
      platform_key: expect.any(String),
    })
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })).toBeUndefined()
  })

  it('开了、勾了、驱动在 → 给（没授权：只有命令与参数，macOS 带 --direct）', () => {
    const { cu, dir } = make()
    cu.set({ enabled: true, roles: ['site.builder'], minutes: 5 })
    expect(cu.forRun({ role_id: 'support.refund', matter_id: 'm1' })).toBeUndefined()
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })).toEqual({
      command: join(dir, 'computer-use', 'cua-driver-0.28.0', 'cua-driver'),
      args: ['mcp', '--direct'],
      minutes: 5,
    })
    // 落盘：重开进程还是这一份
    const again = make({ dir })
    expect(again.cu.get()).toMatchObject({ enabled: true, roles: ['site.builder'], minutes: 5 })
    expect(JSON.parse(readFileSync(join(dir, 'computer-use.json'), 'utf8')).version).toBe(1)
  })

  it('驱动没装 → 不给（给一个指不到文件的路径会让整次运行失败）', () => {
    const { cu } = make({ installed: false })
    cu.set({ enabled: true, roles: ['site.builder'] })
    expect(cu.get().driver.installed).toBe(false)
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })).toBeUndefined()
  })

  it('Docker / 托管档：打不开、勾不上、装不了、forRun 不给；关掉永远可以', async () => {
    const { cu, setMode } = make({ mode: 'docker' })
    expect(cu.get()).toMatchObject({
      allowed: false,
      blocked_reason: expect.stringContaining('不在你自己的电脑上'),
    })
    expect(() => cu.set({ enabled: true })).toThrow(/只在装在你自己电脑上/u)
    expect(() => cu.set({ roles: ['site.builder'] })).toThrow()
    await expect(cu.install()).rejects.toThrow()
    expect((await cu.check()).ran).toBe(false)
    expect(cu.set({ enabled: false }).enabled).toBe(false)
    // 本机档开过、之后库被搬进 Docker：以当下这一档为准
    setMode('local')
    cu.set({ enabled: true, roles: ['site.builder'] })
    setMode('hosted')
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })).toBeUndefined()
  })

  it('分钟数夹在 1–60 之间', () => {
    expect(clampMinutes(0)).toBe(1)
    expect(clampMinutes(600)).toBe(60)
    expect(clampMinutes('x')).toBe(10)
  })
})

describe('第三层：授权卡批了才有授权，一次授权只用一回', () => {
  it('批 → 记授权并重跑这件事；下一次运行带 granted_until，再下一次就没有了', async () => {
    const { cu } = make()
    cu.set({ enabled: true, roles: ['site.builder'] })
    const reruns: string[] = []
    cu.remember('apv_1', {
      matter_id: 'm1',
      minutes: 10,
      rerun: async () => {
        reruns.push('m1')
      },
    })
    const bus = cu.wrap(busOf('computer_use', 'approved'))
    await bus.decide('apv_1', undefined as never, APPROVE)
    await Promise.resolve()
    expect(reruns).toEqual(['m1'])
    const first = cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })
    expect(first).toMatchObject({
      granted_until: new Date(T0 + 10 * 60_000).toISOString(),
      grant_id: 'apv_1',
    })
    // 用掉了：同一件事再跑一次要重新授权（「每次运行先授权」）
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })?.granted_until).toBeUndefined()
    // 别的事项从来没有授权
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm2' })?.granted_until).toBeUndefined()
  })

  it('驳回 / 别的卡 / 开关在卡发出后被关掉 → 什么都不发生', async () => {
    const { cu } = make()
    cu.set({ enabled: true, roles: ['site.builder'] })
    const reruns: string[] = []
    const card = { matter_id: 'm1', minutes: 10, rerun: async () => void reruns.push('x') }
    cu.remember('apv_r', card)
    await cu.wrap(busOf('computer_use', 'rejected')).decide('apv_r', undefined as never, APPROVE)
    cu.remember('apv_o', card)
    await cu.wrap(busOf('policy_change', 'approved')).decide('apv_o', undefined as never, APPROVE)
    cu.remember('apv_off', card)
    cu.set({ enabled: false })
    await cu.wrap(busOf('computer_use', 'approved')).decide('apv_off', undefined as never, APPROVE)
    expect(reruns).toEqual([])
    cu.set({ enabled: true })
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })?.granted_until).toBeUndefined()
  })

  it('批了但过了 N 分钟才开始跑 → 不带授权', async () => {
    let now = T0
    const { cu } = make({ now: () => now })
    cu.set({ enabled: true, roles: ['site.builder'], minutes: 3 })
    cu.remember('apv_2', { matter_id: 'm1', minutes: 3, rerun: async () => undefined })
    await cu
      .wrap(busOf('computer_use', 'approved', { minutes: 3 }))
      .decide('apv_2', undefined as never, APPROVE)
    now = T0 + 3 * 60_000 + 1
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm1' })?.granted_until).toBeUndefined()
  })
})

describe('看得见、停得住', () => {
  it('带授权的运行登记成「正在操作」；授权到点就不再显示', () => {
    let now = T0
    const { cu } = make({ now: () => now })
    cu.activate(
      {
        run_id: 'run_1',
        role_id: 'site.builder',
        matter_id: 'm1',
        until: new Date(T0 + 60_000).toISOString(),
      },
      () => undefined,
    )
    expect(cu.active()).toEqual({
      run_id: 'run_1',
      role_id: 'site.builder',
      matter_id: 'm1',
      until: new Date(T0 + 60_000).toISOString(),
    })
    expect(cu.get().active?.run_id).toBe('run_1')
    now = T0 + 60_001
    expect(cu.active()).toBeUndefined()
    cu.deactivate('run_1')
  })

  it('停止 = 中断那次运行 + 撤销没用掉的授权；关总开关同样停', async () => {
    const { cu } = make()
    cu.set({ enabled: true, roles: ['site.builder'] })
    cu.remember('apv_3', { matter_id: 'm9', minutes: 10, rerun: async () => undefined })
    await cu.wrap(busOf('computer_use', 'approved')).decide('apv_3', undefined as never, APPROVE)
    const aborted: string[] = []
    cu.activate(
      { run_id: 'run_2', role_id: 'site.builder', until: new Date(T0 + 60_000).toISOString() },
      () => aborted.push('run_2'),
    )
    expect(cu.stop()).toEqual({ stopped: 1 })
    expect(aborted).toEqual(['run_2'])
    expect(cu.active()).toBeUndefined()
    expect(cu.forRun({ role_id: 'site.builder', matter_id: 'm9' })?.granted_until).toBeUndefined()

    cu.activate(
      { run_id: 'run_3', role_id: 'site.builder', until: new Date(T0 + 60_000).toISOString() },
      () => aborted.push('run_3'),
    )
    cu.set({ enabled: false })
    expect(aborted).toEqual(['run_2', 'run_3'])
  })
})

describe('向导：权限引导与自检', () => {
  it('打开系统设置那一页（macOS），只打开不替人点', async () => {
    const opened: string[] = []
    const { cu } = make({ opened })
    const r = await cu.openSettings('accessibility')
    expect(r.opened).toBe(true)
    expect(opened).toEqual([
      'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    ])
  })

  it('自检结果原样列出（含怎么修）；没装驱动时不跑', async () => {
    const { cu } = make()
    const out = await cu.check()
    expect(out).toMatchObject({ ran: true, ok: false })
    expect(out.checks.find((c) => c.name === 'screen_recording')?.fix).toBe('去录屏那一页')
    const bare = make({ installed: false }).cu
    expect(await bare.check()).toMatchObject({
      ran: false,
      detail: expect.stringContaining('还没装驱动'),
    })
  })
})
