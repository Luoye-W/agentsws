/** node 适配层：真的起子进程、真的等定时器（都很快）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { nodeFileStore } from '../src/node-files.js'
import {
  cryptoRandomBytes,
  nodeAbort,
  nodeSpawner,
  nodeTimers,
  osFreePort,
  portIsFree,
  sleep,
  systemClock,
  windowsKillTree,
} from '../src/node-runtime.js'
import { desktopPaths } from '../src/paths.js'
import type { FileStore } from '../src/ports.js'
import { TRAY_ICON_2X_DATA_URL, TRAY_ICON_DATA_URL } from '../src/tray-icon.js'

const root = mkdtempSync(join(tmpdir(), 'agentsws-desktop-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('systemClock / cryptoRandomBytes', () => {
  it('给 ISO 时间与真随机字节', () => {
    expect(systemClock.now()).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    const bytes = cryptoRandomBytes(16)
    expect(bytes).toHaveLength(16)
    expect(bytes).not.toEqual(cryptoRandomBytes(16))
  })
})

describe('nodeTimers', () => {
  it('到点触发；clear 之后不触发；clear 不存在的句柄是空操作', async () => {
    const timers = nodeTimers()
    let fired = 0
    timers.setTimeout(() => {
      fired += 1
    }, 1)
    const cancelled = timers.setTimeout(() => {
      fired += 10
    }, 1)
    timers.clear(cancelled)
    timers.clear({ id: 999 })
    await sleep(30)
    expect(fired).toBe(1)
    // 触发过的句柄再 clear 也没事
    timers.clear({ id: 1 })
  })
})

describe('nodeAbort', () => {
  it('到时中断；done 之后不再中断', async () => {
    const quick = nodeAbort(1)
    await sleep(20)
    expect(quick.signal.aborted).toBe(true)
    const slow = nodeAbort(10_000)
    slow.done()
    await sleep(5)
    expect(slow.signal.aborted).toBe(false)
  })
})

describe('nodeSpawner', () => {
  const script = join(root, 'child.mjs')
  writeFileSync(
    script,
    [
      'process.stdout.write("hello " + process.env.GREETING + "\\n")',
      'process.stderr.write("oops\\n")',
      'process.exit(3)',
    ].join('\n'),
  )

  it('起真进程，收 stdout / stderr 与退出码', async () => {
    const child = nodeSpawner().spawn({
      command: process.execPath,
      args: [script],
      env: { GREETING: 'world', PATH: process.env.PATH ?? '' },
      cwd: root,
    })
    const out: string[] = []
    const err: string[] = []
    child.onStdout((chunk) => out.push(chunk))
    child.onStderr((chunk) => err.push(chunk))
    const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.onExit((code, signal) => resolve({ code, signal }))
    })
    expect(typeof child.pid).toBe('number')
    expect(out.join('')).toContain('hello world')
    expect(err.join('')).toContain('oops')
    expect(exit.code).toBe(3)
  })

  it('kill 收得掉长跑进程', async () => {
    const forever = join(root, 'forever.mjs')
    writeFileSync(forever, 'setInterval(() => {}, 1000)')
    const child = nodeSpawner().spawn({
      command: process.execPath,
      args: [forever],
      env: { PATH: process.env.PATH ?? '' },
    })
    const exited = new Promise<string | null>((resolve) => {
      child.onExit((_code, signal) => resolve(signal))
    })
    child.kill()
    expect(await exited).toBe('SIGTERM')
  })

  // WP218：Windows 那条路（在任何平台上都能模拟：platform 注入 + 假的按树强杀）
  it('Windows：先关 stdin 请它自己收尾，收尾了就不强杀', async () => {
    const polite = join(root, 'polite.mjs')
    writeFileSync(polite, "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()")
    const killTree = vi.fn()
    const child = nodeSpawner({ platform: 'win32', killTree, forceKillAfterMs: 5000 }).spawn({
      command: process.execPath,
      args: [polite],
      env: { PATH: process.env.PATH ?? '' },
      stopViaStdin: true,
    })
    const exited = new Promise<number | null>((resolve) => {
      child.onExit((code) => resolve(code))
    })
    child.kill()
    expect(await exited).toBe(0)
    expect(killTree).not.toHaveBeenCalled()
    child.kill() // 已经退了：什么都不做
    expect(killTree).not.toHaveBeenCalled()
  })

  it('Windows：关了 stdin 还赖着不走，到点按进程树强杀；SIGKILL / 没 stdin 直接强杀', async () => {
    const stubborn = join(root, 'stubborn.mjs')
    writeFileSync(stubborn, 'process.stdin.resume(); setInterval(() => {}, 1000)')
    const killTree = vi.fn((pid: number) => {
      process.kill(pid, 'SIGKILL')
    })
    const spawner = nodeSpawner({ platform: 'win32', killTree, forceKillAfterMs: 50 })
    const a = spawner.spawn({
      command: process.execPath,
      args: [stubborn],
      env: { PATH: process.env.PATH ?? '' },
      stopViaStdin: true,
    })
    const aExit = new Promise<void>((resolve) => {
      a.onExit(() => resolve())
    })
    a.kill()
    await aExit
    expect(killTree).toHaveBeenCalledTimes(1)

    for (const [stopViaStdin, signal] of [
      [true, 'SIGKILL'],
      [false, undefined],
    ] as const) {
      const b = spawner.spawn({
        command: process.execPath,
        args: [stubborn],
        env: { PATH: process.env.PATH ?? '' },
        stopViaStdin,
      })
      const bExit = new Promise<void>((resolve) => {
        b.onExit(() => resolve())
      })
      b.kill(signal)
      await bExit
    }
    expect(killTree).toHaveBeenCalledTimes(3)
  })

  it('windowsKillTree：taskkill 全路径 + /T /F', () => {
    const run = vi.fn()
    windowsKillTree(7, { SystemRoot: 'D:\\Win' }, run)
    windowsKillTree(8, { windir: 'E:\\W' }, run)
    windowsKillTree(9, {}, run)
    expect(run.mock.calls).toEqual([
      ['D:\\Win\\System32\\taskkill.exe', ['/PID', '7', '/T', '/F']],
      ['E:\\W\\System32\\taskkill.exe', ['/PID', '8', '/T', '/F']],
      ['C:\\Windows\\System32\\taskkill.exe', ['/PID', '9', '/T', '/F']],
    ])
    // 默认的 run 起不来也不抛（这台机器上没有 taskkill）
    expect(() => {
      windowsKillTree(999_999, { SystemRoot: '/nonexistent' })
    }).not.toThrow()
  })

  it('可执行文件不存在时报一次 exit（不是两次）', async () => {
    const child = nodeSpawner().spawn({
      command: join(root, 'nope-does-not-exist'),
      args: [],
      env: {},
    })
    let calls = 0
    const done = new Promise<void>((resolve) => {
      child.onExit(() => {
        calls += 1
        resolve()
      })
    })
    await done
    await sleep(20)
    expect(calls).toBe(1)
    child.kill('SIGKILL')
  })
})

describe('nodeFileStore', () => {
  const files: FileStore = nodeFileStore()
  const paths = desktopPaths(join(root, 'userData'))

  it('读不存在的文件返回 undefined', () => {
    expect(files.readText(join(root, 'nope.txt'))).toBeUndefined()
    expect(files.readBytes(join(root, 'nope.bin'))).toBeUndefined()
    expect(files.size(join(root, 'nope.bin'))).toBeUndefined()
    expect(files.exists(join(root, 'nope.bin'))).toBe(false)
  })

  it('写会自动建父目录；文本 / 字节 / 追加 / 改名 / 删除都通', () => {
    files.writeText(paths.configFile, '{"port":1}')
    expect(files.readText(paths.configFile)).toBe('{"port":1}')
    files.appendText(paths.logFile, 'a\n')
    files.appendText(paths.logFile, 'b\n')
    expect(files.readText(paths.logFile)).toBe('a\nb\n')
    expect(files.size(paths.logFile)).toBe(4)
    files.writeBytes(paths.secretsFile, new Uint8Array([1, 2, 3]))
    expect(Array.from(files.readBytes(paths.secretsFile) ?? [])).toEqual([1, 2, 3])
    files.rename(paths.logFile, `${paths.logFile}.1`)
    expect(files.exists(paths.logFile)).toBe(false)
    files.remove(`${paths.logFile}.1`)
    expect(files.exists(`${paths.logFile}.1`)).toBe(false)
    // 删不存在的也不炸
    files.remove(`${paths.logFile}.9`)
    files.ensureDir(paths.logDir)
  })

  it('ENOTDIR 这类真错误照样抛出来（size 不吞非 ENOENT）', () => {
    expect(() => files.size(join(paths.configFile, 'child'))).toThrowError()
  })

  it('读目录这类真错误照样抛出来（不是当成"不存在"吞掉）', () => {
    files.ensureDir(paths.serverDataDir)
    expect(() => files.readText(paths.serverDataDir)).toThrowError()
    expect(() => files.readBytes(paths.serverDataDir)).toThrowError()
  })
})

describe('desktopPaths', () => {
  it('全部落在 userData 下面', () => {
    const paths = desktopPaths('/Users/x/Library/Application Support/agentsws')
    expect(paths.configFile).toBe('/Users/x/Library/Application Support/agentsws/config.json')
    expect(paths.secretsFile).toContain('secrets.bin')
    expect(paths.haltFile).toContain('halt.json')
    expect(paths.logFile).toContain('/logs/desktop.log')
    expect(paths.serverLogFile).toContain('/logs/server.log')
    expect(paths.serverDataDir).toContain('/data')
    expect(paths.userData).toContain('agentsws')
  })
})

describe('tray-icon', () => {
  it('两档分辨率的 data URL 都是 PNG', () => {
    expect(TRAY_ICON_DATA_URL.startsWith('data:image/png;base64,')).toBe(true)
    expect(TRAY_ICON_2X_DATA_URL.length).toBeGreaterThan(TRAY_ICON_DATA_URL.length)
  })
})

describe('WP247：选端口用的两件', () => {
  it('系统给的端口是空的；占上之后就不空了', async () => {
    const { createServer } = await import('node:net')
    const port = await osFreePort()
    expect(port).toBeGreaterThan(0)
    expect(await portIsFree(port)).toBe(true)
    const server = createServer()
    await new Promise<void>((r) => server.listen(port, '127.0.0.1', r))
    try {
      expect(await portIsFree(port)).toBe(false)
    } finally {
      server.close()
    }
  })

  it('系统给不出端口（主机名不对）→ 抛', async () => {
    await expect(osFreePort('256.0.0.1')).rejects.toThrow()
  })
})
