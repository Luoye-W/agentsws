/** `Spawner` / `TimerPort` / `Clock` / `RandomBytes` 的 node 实现。 */
import { spawn } from 'node:child_process'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
import { win32 } from 'node:path'
import type { ChildHandle, Clock, RandomBytes, Spawner, TimerPort } from './ports.js'

export const systemClock: Clock = { now: () => new Date().toISOString() }

export const cryptoRandomBytes: RandomBytes = (size) => new Uint8Array(nodeRandomBytes(size))

export function nodeTimers(): TimerPort {
  let seq = 0
  const live = new Map<number, NodeJS.Timeout>()
  return {
    setTimeout(fn, ms) {
      seq += 1
      const id = seq
      const handle = setTimeout(() => {
        live.delete(id)
        fn()
      }, ms)
      // 定时器不该把进程钉住（Electron 主进程本来也不会退，这是保险）。
      handle.unref?.()
      live.set(id, handle)
      return { id }
    },
    clear(handle) {
      const timer = live.get(handle.id)
      if (timer === undefined) return
      clearTimeout(timer)
      live.delete(handle.id)
    },
  }
}

export interface NodeSpawnerOptions {
  /** 默认 `process.platform`。 */
  platform?: string
  /** Windows：关了 stdin 之后等多久还没退就按进程树强杀（默认 8 秒）。 */
  forceKillAfterMs?: number
  /** Windows 的「按进程树强杀」（默认 `taskkill /PID <pid> /T /F`）。 */
  killTree?: (pid: number) => void
}

/** `%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F`：连子孙一起结束（场景、终端不留孤儿）。 */
export function windowsKillTree(
  pid: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: (command: string, args: string[]) => void = (command, args) => {
    spawn(command, args, { stdio: 'ignore', windowsHide: true }).on('error', () => undefined)
  },
): void {
  const root = env.SystemRoot ?? env.windir ?? 'C:\\Windows'
  run(win32.join(root, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'])
}

export function nodeSpawner(options: NodeSpawnerOptions = {}): Spawner {
  const windows = (options.platform ?? process.platform) === 'win32'
  return {
    spawn(request) {
      const stdin = request.stopViaStdin === true ? 'pipe' : 'ignore'
      const child = spawn(request.command, [...request.args], {
        env: { ...request.env },
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        stdio: [stdin, 'pipe', 'pipe'],
        windowsHide: request.gui !== true,
      })
      // 管道那头的子进程先走了也别让 EPIPE 冒成未捕获异常
      child.stdin?.on('error', () => undefined)
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const handle: ChildHandle = {
        get pid() {
          return child.pid
        },
        kill(signal) {
          /*
           * WP218：Windows 上 `child.kill()` = TerminateProcess，服务进程的 SIGTERM 收尾
           * （关场景、关库）永远跑不到，它起的场景进程还会变成孤儿、锁住安装目录——
           * 下一次更新 / 卸载就「文件被占用」。所以先关 stdin 请它自己收尾，到点没退再按树强杀。
           */
          if (!windows) {
            child.kill((signal ?? 'SIGTERM') as NodeJS.Signals)
            return
          }
          const pid = child.pid
          if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return
          const force = (): void => {
            ;(options.killTree ?? windowsKillTree)(pid)
          }
          if (signal === 'SIGKILL' || child.stdin === null) {
            force()
            return
          }
          child.stdin.end()
          const timer = setTimeout(force, options.forceKillAfterMs ?? 8000)
          timer.unref?.()
          child.once('exit', () => {
            clearTimeout(timer)
          })
        },
        onStdout(cb) {
          child.stdout?.on('data', (chunk: string) => {
            cb(chunk)
          })
        },
        onStderr(cb) {
          child.stderr?.on('data', (chunk: string) => {
            cb(chunk)
          })
        },
        onExit(cb) {
          let done = false
          const fire = (code: number | null, signal: NodeJS.Signals | null): void => {
            if (done) return
            done = true
            cb(code, signal)
          }
          child.on('exit', fire)
          child.on('error', () => {
            fire(null, null)
          })
        },
      }
      return handle
    },
  }
}

/** 给 `probeHealth` 的超时中断源。 */
export function nodeAbort(timeoutMs: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)
  return {
    signal: controller.signal,
    done: () => {
      clearTimeout(timer)
    },
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
