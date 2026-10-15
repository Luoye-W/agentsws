/**
 * WP337：有任务在做时点「重启并更新」——三选一、等空闲、暂停全部 / 放开。
 *
 * | 组 | 钉什么 |
 * |---|---|
 * | 状态机 | 现在重启 = 自检 → 暂停全部 → 装；空闲时重启 = 按钮变「等」、输出结束才走、可取消；稍后 = 不动；装不上 = 放开 |
 * | 原生框 | 一句「还有 N 件在做」+ 清单（列不下说还有几件）+ 三个按钮；Mac 退出版 |
 * | 合并 | 官方场景算一件；服务端问不到退回运行次数 |
 * | 托盘 | 等的时候一项「等空闲后重启（点了取消）」 |
 */
import { describe, expect, it } from 'vitest'
import type { DesktopRestartReadiness } from '../src/bridge-types.js'
import { strings } from '../src/i18n.js'
import { silentLogger } from '../src/logging.js'
import { buildTrayMenu } from '../src/menu.js'
import { choiceOf, mergeReadiness, restartBox } from '../src/restart-choice.js'
import {
  createUpdateController,
  type RestartChoice,
  type UpdateBackend,
  type UpdateControllerOptions,
} from '../src/update-controller.js'
import { fakeTimers } from './fakes.js'

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

function rig(patch: Partial<UpdateControllerOptions> & { busy?: boolean[] } = {}) {
  const timers = fakeTimers()
  const calls: string[] = []
  const busy = [...(patch.busy ?? [])]
  const primary: UpdateBackend = {
    check: async () => ({ version: '0.2.2' }),
    download: async () => undefined,
    install: () => {
      calls.push('install')
    },
  }
  const c = createUpdateController({
    mode: 'auto',
    primary,
    smoke: async () => {
      calls.push('smoke')
      return true
    },
    confirmRestart: async () => true,
    outputBusy: async () => busy.shift() ?? false,
    pauseAll: async (to) => {
      calls.push(`pause:${to}`)
    },
    resumeAll: async () => {
      calls.push('resume')
    },
    openDownloadPage: () => undefined,
    downloadPage: 'https://agentsws.com/download/',
    logger: silentLogger(),
    timers,
    ...patch,
  })
  const ready = async () => {
    await c.check()
    await c.download()
  }
  return { c, timers, calls, ready }
}

describe('WP337 状态机：三选一', () => {
  it('现在重启：自检 → 暂停全部 → 装（按钮先变「正在重启」）', async () => {
    const r = rig({ chooseRestart: async () => 'now' })
    await r.ready()
    expect(await r.c.install()).toBe('installing')
    expect(r.calls).toEqual(['smoke', 'pause:0.2.2', 'install'])
    expect(r.c.status().state).toBe('installing')
  })

  it('稍后：什么都不动，按钮还是「重启并更新」', async () => {
    const r = rig({ chooseRestart: async () => 'later' })
    await r.ready()
    expect(await r.c.install()).toBe('cancelled')
    expect(r.calls).toEqual([])
    expect(r.c.status().state).toBe('ready')
  })

  it('空闲时重启：等到没有正在输出的才走（后台 / 定时到那一刻再暂停）', async () => {
    const r = rig({ chooseRestart: async () => 'idle', busy: [true, true, false] })
    await r.ready()
    expect(await r.c.install()).toBe('waiting')
    expect(r.c.status()).toEqual({ state: 'waiting', version: '0.2.2', source: 'primary' })
    // 还在输出：两拍都不走
    r.timers.runNext()
    await flush()
    r.timers.runNext()
    await flush()
    expect(r.calls).toEqual([])
    expect(r.c.status().state).toBe('waiting')
    // 输出结束：自检 → 暂停 → 装
    r.timers.runNext()
    await flush()
    expect(r.calls).toEqual(['smoke', 'pause:0.2.2', 'install'])
    expect(r.timers.pending()).toBe(0)
  })

  it('等的时候点一下取消：回到「重启并更新」、不再问', async () => {
    const r = rig({ chooseRestart: async () => 'idle', busy: [true] })
    await r.ready()
    await r.c.install()
    expect(r.c.cancelWait()).toBe(true)
    expect(r.c.status()).toEqual({ state: 'ready', version: '0.2.2', source: 'primary' })
    expect(r.timers.pending()).toBe(0)
    expect(r.c.cancelWait()).toBe(false)
    expect(r.calls).toEqual([])
  })

  it('页面上已经选了：不再问壳', async () => {
    let asked = 0
    const r = rig({
      chooseRestart: async (): Promise<RestartChoice> => {
        asked += 1
        return 'later'
      },
    })
    await r.ready()
    expect(await r.c.install('now')).toBe('installing')
    expect(asked).toBe(0)
  })

  it('暂停之后安装程序没起来：放开（接着做），按钮报没装上', async () => {
    const r = rig({ chooseRestart: async () => 'now' })
    await r.ready()
    const c2 = createUpdateController({
      ...({} as UpdateControllerOptions),
      mode: 'auto',
      primary: {
        check: async () => ({ version: '0.2.2' }),
        download: async () => undefined,
        install: () => {
          throw new Error('NSIS 没起来')
        },
      },
      smoke: async () => true,
      confirmRestart: async () => true,
      chooseRestart: async () => 'now',
      pauseAll: async () => {
        r.calls.push('pause')
      },
      resumeAll: async () => {
        r.calls.push('resume')
      },
      openDownloadPage: () => undefined,
      downloadPage: 'x',
      logger: silentLogger(),
      timers: r.timers,
    })
    await c2.check()
    await c2.download()
    expect(await c2.install()).toBe('blocked')
    expect(r.calls).toEqual(['pause', 'resume'])
    expect(c2.status()).toMatchObject({ state: 'error', stage: 'install', code: 'install' })
  })

  it('自检没过：不暂停、不装', async () => {
    const r = rig({ chooseRestart: async () => 'now', smoke: async () => false })
    await r.ready()
    expect(await r.c.install()).toBe('blocked')
    expect(r.calls).toEqual([])
  })

  it('暂停没成：照样重启（最坏就是老样子）', async () => {
    const r = rig({
      chooseRestart: async () => 'now',
      pauseAll: async () => {
        throw new Error('服务没回')
      },
    })
    await r.ready()
    expect(await r.c.install()).toBe('installing')
    expect(r.calls).toEqual(['smoke', 'install'])
  })
})

const READY: DesktopRestartReadiness = {
  total: 8,
  idle: false,
  counts: { output: 2, background: 1, scheduled: 5 },
  items: [
    { kind: 'output', title: '回复客户 Anna 的退货' },
    { kind: 'output', title: '查一下在售产品' },
    { kind: 'scheduled', title: '每天出周报' },
    { kind: 'scheduled', title: 'A' },
    { kind: 'scheduled', title: 'B' },
    { kind: 'scheduled', title: 'C' },
    { kind: 'scheduled', title: 'D' },
    { kind: 'background', title: '收信' },
  ],
}

describe('WP337 原生框', () => {
  it('一句「还有 N 件在做」+ 清单（列 6 行，列不下说还有几件）+ 三个按钮', () => {
    const t = strings('zh-CN')
    const box = restartBox(READY, t, { platform: 'win32', verb: 'restart' })
    expect(box.message).toBe('还有 8 件在做')
    expect(box.buttons).toEqual(['现在重启', '空闲时重启', '稍后'])
    expect(box.cancelId).toBe(2)
    expect(box.type).toBe('none')
    const lines = box.detail.split('\n')
    expect(lines.slice(0, 6)).toEqual([
      '• 回复客户 Anna 的退货',
      '• 查一下在售产品',
      '• 每天出周报',
      '• A',
      '• B',
      '• C',
    ])
    expect(lines).toContain('…还有 2 件')
    expect(lines.at(-1)).toBe('暂停的会在新版打开后自动接着做')
  })

  it('Mac 退出版：现在退出 / 空闲时退出 / 稍后', () => {
    const box = restartBox(READY, strings('zh-CN'), { platform: 'darwin', verb: 'quit' })
    expect(box.buttons).toEqual(['现在退出', '空闲时退出', '稍后'])
    expect(box.type).toBe('warning')
  })

  it('按钮序号 → 选择（关掉框 = 稍后）', () => {
    expect([0, 1, 2, -1].map(choiceOf)).toEqual(['now', 'idle', 'later', 'later'])
  })
})

describe('WP337 合并', () => {
  it('官方场景算一件；服务端问不到退回运行次数（没有事项名）', () => {
    const merged = mergeReadiness({
      server: undefined,
      officialScene: true,
      officialLabel: '官方场景（重启会关掉）',
      fallbackRuns: 2,
    })
    expect(merged).toMatchObject({ total: 3, idle: false, counts: { output: 2 } })
    expect(merged.items).toEqual([{ kind: 'output', title: '官方场景（重启会关掉）' }])
    expect(mergeReadiness({ server: READY, officialScene: false, officialLabel: 'x' })).toEqual(
      READY,
    )
  })
})

describe('WP337 托盘', () => {
  const base = {
    language: 'zh-CN' as const,
    serverUrl: 'http://127.0.0.1:4317',
    version: '0.2.1',
    server: { state: 'running' as const, restarts: 0 },
    health: undefined,
    paused: false,
    launchAtLogin: false,
    mode: 'local' as const,
  }
  it('等空闲后重启：一项，点了取消', () => {
    const items = buildTrayMenu({
      ...(base as unknown as Parameters<typeof buildTrayMenu>[0]),
      appUpdate: { state: 'waiting', version: '0.2.2' },
    })
    expect(items.find((i) => i.id === 'cancel-update-wait')?.label).toBe('等空闲后重启（点了取消）')
  })
  it('Mac 等空闲后退出：同一个动作', () => {
    const items = buildTrayMenu({
      ...(base as unknown as Parameters<typeof buildTrayMenu>[0]),
      quitWaiting: true,
    })
    expect(items.find((i) => i.id === 'cancel-update-wait')?.label).toBe('等空闲后退出（点了取消）')
  })
})

describe('WP337 服务端那一份 → 壳用的', () => {
  it('不认识的条目丢掉、数字夹成非负整数、total 是三类之和', async () => {
    const { readinessOf } = await import('../src/api-client.js')
    expect(
      readinessOf({
        idle: false,
        paused: false,
        counts: { output: 1, background: -3, scheduled: 2.7 },
        items: [
          { kind: 'output', title: '回复 Anna' },
          { kind: 'weird', title: 'x' },
          { kind: 'scheduled' },
        ],
      }),
    ).toEqual({
      total: 3,
      idle: false,
      counts: { output: 1, background: 0, scheduled: 2 },
      items: [{ kind: 'output', title: '回复 Anna' }],
    })
    expect(readinessOf({ runs: 1 })).toBeUndefined()
  })
})
