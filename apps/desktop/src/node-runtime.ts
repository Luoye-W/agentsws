/** `Spawner` / `TimerPort` / `Clock` / `RandomBytes` 的 node 实现。 */
import { spawn } from 'node:child_process'
import { randomBytes as nodeRandomBytes } from 'node:crypto'
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

export function nodeSpawner(): Spawner {
  return {
    spawn(request) {
      const child = spawn(request.command, [...request.args], {
        env: { ...request.env },
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      const handle: ChildHandle = {
        get pid() {
          return child.pid
        },
        kill(signal) {
          child.kill((signal ?? 'SIGTERM') as NodeJS.Signals)
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
