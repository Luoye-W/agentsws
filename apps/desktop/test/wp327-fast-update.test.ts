/**
 * WP327：版本目录 + 联接切换（`src/fast-update.ts`）。文件系统、起进程全用替身：
 * 认布局、摆新版、切换、等新版报「起来了」、超时 / 新版自己退了就回滚、清理旧版本目录。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  appDirName,
  cleanupPlan,
  confirmSwitch,
  consumeDrill,
  DRILL_FILE,
  detectLayout,
  LAYOUT_FILE,
  type LayoutFs,
  ROLLBACK_FILE,
  readSwitch,
  runFastSwitch,
  STAGED_MARKER,
  SWITCH_FILE,
  stageArgs,
  stagedProblem,
  stageUpdate,
  switchCurrent,
  takeRollback,
  uninstallKeyOf,
} from '../src/fast-update.js'

const ROOT = join('/', 'Programs', 'agentsws')
const UD = join('/', 'AppData', 'agentsws')

/** 内存里的文件系统：文件、目录（列表靠前缀）、联接（link → 目标）。 */
function memFs(): LayoutFs & { files: Map<string, string>; links: Map<string, string> } {
  const files = new Map<string, string>()
  const links = new Map<string, string>()
  const resolveLink = (p: string): string => {
    for (const [l, t] of links) if (p === l || p.startsWith(l + '/')) return t + p.slice(l.length)
    return p
  }
  return {
    files,
    links,
    exists: (p) =>
      links.has(p) ||
      files.has(resolveLink(p)) ||
      [...files.keys()].some((f) => f.startsWith(resolveLink(p) + '/')),
    isLink: (p) => links.has(p),
    target: (p) => links.get(p),
    readText: (p) => files.get(resolveLink(p)),
    writeText: (p, t) => {
      files.set(resolveLink(p), t)
    },
    remove: (p) => {
      files.delete(p)
    },
    list: (dir) => [
      ...new Set(
        [...files.keys(), ...links.keys()]
          .filter((f) => f.startsWith(dir + '/'))
          .map((f) => f.slice(dir.length + 1).split('/')[0] as string),
      ),
    ],
    unlink: (p) => {
      links.delete(p)
    },
    link: (target, p) => {
      links.set(p, target)
    },
  }
}

function installed(fs: ReturnType<typeof memFs>, version: string, staged = true): string {
  const dir = join(ROOT, appDirName(version))
  fs.files.set(join(dir, 'agentsws.exe'), 'exe')
  fs.files.set(join(dir, 'resources', 'app', 'package.json'), JSON.stringify({ version }))
  if (staged) fs.files.set(join(dir, STAGED_MARKER), version)
  return dir
}

describe('认布局', () => {
  it('exe 在 current\\ 或 app-*\\ 下、current 是联接 → 版本目录布局；平铺 → 没有', () => {
    const fs = memFs()
    const dir = installed(fs, '1.0.0')
    fs.links.set(join(ROOT, 'current'), dir)
    expect(detectLayout(join(ROOT, 'current', 'agentsws.exe'), fs)).toEqual({
      root: ROOT,
      current: join(ROOT, 'current'),
      currentDir: dir,
    })
    expect(detectLayout(join(dir, 'agentsws.exe'), fs)?.root).toBe(ROOT)
    expect(detectLayout(join(ROOT, 'agentsws.exe'), fs)).toBeUndefined()
    fs.links.clear()
    expect(detectLayout(join(ROOT, 'current', 'agentsws.exe'), fs)).toBeUndefined()
  })

  it('「只摆不装」的参数：/D= 在最后、不带引号', () => {
    expect(stageArgs('C:\\Programs\\智能体 工坊')).toEqual([
      '/S',
      '--agentsws-stage',
      '/D=C:\\Programs\\智能体 工坊',
    ])
  })

  it('摆好了没有：exe、记号、包里的版本都要对', () => {
    const fs = memFs()
    expect(stagedProblem(ROOT, '1.1.0', fs)).toMatch(/没有 agentsws.exe/)
    installed(fs, '1.1.0', false)
    expect(stagedProblem(ROOT, '1.1.0', fs)).toMatch(/记号/)
    installed(fs, '1.1.0')
    expect(stagedProblem(ROOT, '1.1.0', fs)).toBeUndefined()
  })
})

describe('切换与清理', () => {
  it('切换：current 改指新版，记下当前 / 上一版；建不出来就指回去', () => {
    const fs = memFs()
    const old = installed(fs, '1.0.0')
    const next = installed(fs, '1.1.0')
    fs.links.set(join(ROOT, 'current'), old)
    const layout = { root: ROOT, current: join(ROOT, 'current'), currentDir: old }
    switchCurrent(layout, next, fs)
    expect(fs.links.get(join(ROOT, 'current'))).toBe(next)
    expect(JSON.parse(fs.files.get(join(ROOT, LAYOUT_FILE)) ?? '')).toEqual({
      current: 'app-1.1.0',
      previous: 'app-1.0.0',
    })
    let calls = 0
    const once: LayoutFs = {
      ...fs,
      link: (t, p) => {
        calls += 1
        if (calls === 1) throw new Error('EPERM')
        fs.link(t, p)
      },
    }
    expect(() => switchCurrent({ ...layout, currentDir: next }, old, once)).toThrow('EPERM')
    expect(fs.links.get(join(ROOT, 'current'))).toBe(next)
  })

  it('清理：留当前与上一版；正在准备时比当前新的与 .part 不动', () => {
    const entries = [
      'app-1.0.0',
      'app-1.1.0',
      'app-1.2.0',
      'app-1.3.0',
      'app-1.3.0.part',
      'current',
      'Uninstall.exe',
    ]
    expect(
      cleanupPlan(entries, 'app-1.2.0', { current: 'app-1.2.0', previous: 'app-1.1.0' }),
    ).toEqual(['app-1.0.0', 'app-1.3.0', 'app-1.3.0.part'])
    expect(cleanupPlan(entries, 'app-1.2.0', undefined, { staging: true })).toEqual(['app-1.0.0'])
    // layout.json 记的上一版不在了：留比当前旧的里面最新的
    expect(
      cleanupPlan(['app-0.9.0', 'app-1.0.0', 'app-1.2.0'], 'app-1.2.0', {
        current: 'app-1.2.0',
        previous: 'app-1.1.0',
      }),
    ).toEqual(['app-0.9.0'])
  })
})

describe('后台准备', () => {
  const layoutOf = (fs: ReturnType<typeof memFs>, v: string) => {
    const dir = installed(fs, v)
    fs.links.set(join(ROOT, 'current'), dir)
    return { root: ROOT, current: join(ROOT, 'current'), currentDir: dir }
  }

  it('跑安装包「只摆不装」→ 核对 → 冒烟；已经摆好的不再跑安装包', async () => {
    const fs = memFs()
    const layout = layoutOf(fs, '1.0.0')
    const runs: string[][] = []
    const deps = {
      layout,
      fs,
      version: '1.1.0',
      installer: 'C:\\cache\\Setup.exe',
      run: async (_c: string, args: readonly string[]) => {
        runs.push([...args])
        installed(fs, '1.1.0')
        return 0
      },
      smoke: async () => undefined,
      log: () => undefined,
    }
    expect(await stageUpdate(deps)).toBeUndefined()
    expect(runs).toEqual([stageArgs(ROOT)])
    expect(await stageUpdate(deps)).toBeUndefined()
    expect(runs).toHaveLength(1)
  })

  it('安装包退出码不是 0、冒烟没过、要装的就是正在跑的：都说原因（调用方退回老路）', async () => {
    const fs = memFs()
    const layout = layoutOf(fs, '1.0.0')
    const base = {
      layout,
      fs,
      installer: 'x.exe',
      log: () => undefined,
      smoke: async () => undefined,
    }
    expect(await stageUpdate({ ...base, version: '1.1.0', run: async () => 2 })).toMatch(/退出码 2/)
    expect(await stageUpdate({ ...base, version: '1.0.0', run: async () => 0 })).toMatch(/正在跑/)
    installed(fs, '1.2.0')
    expect(
      await stageUpdate({
        ...base,
        version: '1.2.0',
        run: async () => 0,
        smoke: async () => 'import 失败',
      }),
    ).toMatch(/冒烟没过：import 失败/)
  })
})

describe('切过去、等、不行就切回来', () => {
  const setup = () => {
    const fs = memFs()
    const old = installed(fs, '1.0.0')
    const next = installed(fs, '1.1.0')
    fs.links.set(join(ROOT, 'current'), old)
    const layout = { root: ROOT, current: join(ROOT, 'current'), currentDir: old }
    let clock = 0
    const launched: { exe: string; args: readonly string[] }[] = []
    const killed: number[] = []
    const base = {
      layout,
      fs,
      userData: UD,
      from: '1.0.0',
      to: '1.1.0',
      exeName: 'agentsws.exe',
      token: 't-1',
      now: () => new Date(clock),
      sleep: async (ms: number) => {
        clock += ms
      },
      quiesce: async () => undefined,
      killTree: (pid: number) => {
        killed.push(pid)
      },
      log: () => undefined,
    }
    return { fs, old, next, base, launched, killed, tick: () => clock }
  }

  it('新版报了「起来了」：成功，current 留在新版', async () => {
    const t = setup()
    const out = await runFastSwitch({
      ...t.base,
      launch: (exe, args) => {
        t.launched.push({ exe, args })
        // 新版起来后按约定改记录
        confirmSwitch({
          file: join(UD, SWITCH_FILE),
          version: '1.1.0',
          now: () => new Date(),
          fs: t.fs,
        })
        return { pid: 42, exited: new Promise(() => undefined) }
      },
    })
    expect(out.ok).toBe(true)
    expect(t.launched).toEqual([
      { exe: join(ROOT, 'current', 'agentsws.exe'), args: ['--updated'] },
    ])
    expect(t.fs.links.get(join(ROOT, 'current'))).toBe(t.next)
    expect(readSwitch(join(UD, SWITCH_FILE), t.fs)?.state).toBe('healthy')
    expect(t.killed).toEqual([])
  })

  it('新版的服务报了新版本号也算起来了（新版换了写法时的兜底）', async () => {
    const t = setup()
    const out = await runFastSwitch({
      ...t.base,
      launch: () => ({ pid: 1, exited: new Promise(() => undefined) }),
      probeVersion: async () => (t.tick() > 3000 ? '1.1.0' : undefined),
    })
    expect(out.ok).toBe(true)
  })

  it('60 秒没报起来：结束新版、current 指回旧版、记回滚、重开旧版', async () => {
    const t = setup()
    const out = await runFastSwitch({
      ...t.base,
      launch: (exe, args) => {
        t.launched.push({ exe, args })
        return { pid: 77, exited: new Promise(() => undefined) }
      },
    })
    expect(out).toMatchObject({ ok: false, reason: 'timeout' })
    expect(t.killed).toEqual([77])
    expect(t.fs.links.get(join(ROOT, 'current'))).toBe(t.old)
    expect(t.launched.map((l) => l.args)).toEqual([['--updated'], ['--agentsws-rolled-back']])
    expect(takeRollback({ userData: UD, fs: t.fs })).toMatchObject({
      from: '1.0.0',
      to: '1.1.0',
      reason: 'timeout',
    })
    expect(t.fs.files.has(join(UD, ROLLBACK_FILE))).toBe(false)
    expect(t.tick()).toBeGreaterThanOrEqual(60_000)
  })

  it('新版还没报起来就自己退了：立刻回滚', async () => {
    const t = setup()
    const out = await runFastSwitch({
      ...t.base,
      launch: () => ({ pid: 5, exited: Promise.resolve(1) }),
    })
    expect(out).toMatchObject({ ok: false, reason: 'exited' })
    expect(t.fs.links.get(join(ROOT, 'current'))).toBe(t.old)
    expect(t.tick()).toBeLessThan(5000)
  })

  it('切换本身失败（联接建不出来）：不起新版，交给调用方走老路', async () => {
    const t = setup()
    let launched = false
    const out = await runFastSwitch({
      ...t.base,
      fs: {
        ...t.fs,
        link: (target, p) => {
          if (target === t.next) throw new Error('EPERM')
          t.fs.link(target, p)
        },
      },
      launch: () => {
        launched = true
        return { pid: 1, exited: new Promise(() => undefined) }
      },
    })
    expect(out).toMatchObject({ ok: false, reason: 'switch' })
    expect(launched).toBe(false)
    expect(t.fs.links.get(join(ROOT, 'current'))).toBe(t.old)
  })
})

describe('新版这一侧与杂项', () => {
  it('确认切换只认冲着我来、还在等的那一次', () => {
    const fs = memFs()
    const file = join(UD, SWITCH_FILE)
    expect(confirmSwitch({ file, version: '1.1.0', now: () => new Date(0), fs })).toBe(false)
    fs.writeText(file, JSON.stringify({ token: 'a', to: '1.2.0', state: 'switching' }))
    expect(confirmSwitch({ file, version: '1.1.0', now: () => new Date(0), fs })).toBe(false)
    fs.writeText(file, JSON.stringify({ token: 'a', to: '1.1.0', state: 'switching' }))
    expect(confirmSwitch({ file, version: '1.1.0', now: () => new Date(0), fs })).toBe(true)
    expect(confirmSwitch({ file, version: '1.1.0', now: () => new Date(0), fs })).toBe(false)
  })

  it('回滚演练：写着我这一版才算，用一次就删', () => {
    const fs = memFs()
    const file = join(UD, DRILL_FILE)
    fs.writeText(file, JSON.stringify({ break: '1.2.0' }))
    expect(consumeDrill({ file, version: '1.1.0', fs })).toBe(false)
    expect(consumeDrill({ file, version: '1.2.0', fs })).toBe(true)
    expect(consumeDrill({ file, version: '1.2.0', fs })).toBe(false)
  })

  it('卸载登记的键：只认 HKCU / HKLM 下的 Uninstall\\…', () => {
    expect(
      uninstallKeyOf(
        'HKCU\r\nSoftware\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc-123\r\n',
      ),
    ).toBe('HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\abc-123')
    expect(uninstallKeyOf('HKCU\r\nSoftware\\Evil\r\n')).toBeUndefined()
    expect(uninstallKeyOf(undefined)).toBeUndefined()
  })
})
