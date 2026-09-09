/** 测试替身：假时钟、假定时器、假子进程、假 safeStorage、假 fetch。 */
import type {
  ChildHandle,
  Clock,
  FetchLike,
  FetchResponseLike,
  SafeStorageLike,
  Spawner,
  SpawnRequest,
  TimerHandle,
  TimerPort,
} from '../src/ports.js'

export function fakeClock(start = '2026-09-09T00:00:00.000Z'): Clock & { tick(ms: number): void } {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    tick: (ms) => {
      at += ms
    },
  }
}

export interface FakeTimers extends TimerPort {
  /** 跑掉所有已到期的定时器（按注册顺序）。 */
  runAll(): void
  /** 只跑下一个。 */
  runNext(): void
  pending(): number
  lastDelay(): number | undefined
}

export function fakeTimers(): FakeTimers {
  let seq = 0
  const queue: { handle: TimerHandle; fn: () => void; ms: number }[] = []
  let lastDelay: number | undefined
  return {
    setTimeout(fn, ms) {
      seq += 1
      const handle = { id: seq }
      lastDelay = ms
      queue.push({ handle, fn, ms })
      return handle
    },
    clear(handle) {
      const idx = queue.findIndex((t) => t.handle.id === handle.id)
      if (idx >= 0) queue.splice(idx, 1)
    },
    runAll() {
      while (queue.length > 0) {
        const next = queue.shift()
        next?.fn()
      }
    },
    runNext() {
      const next = queue.shift()
      next?.fn()
    },
    pending: () => queue.length,
    lastDelay: () => lastDelay,
  }
}

export interface FakeChild extends ChildHandle {
  emitStdout(chunk: string): void
  emitStderr(chunk: string): void
  exit(code: number | null, signal?: string | null): void
  killed: string[]
}

export function fakeChild(pid = 4242): FakeChild {
  let stdout: ((chunk: string) => void) | undefined
  let stderr: ((chunk: string) => void) | undefined
  const exits: ((code: number | null, signal: string | null) => void)[] = []
  const killed: string[] = []
  return {
    pid,
    killed,
    kill(signal) {
      killed.push(signal ?? 'SIGTERM')
    },
    onStdout(cb) {
      stdout = cb
    },
    onStderr(cb) {
      stderr = cb
    },
    onExit(cb) {
      exits.push(cb)
    },
    emitStdout(chunk) {
      stdout?.(chunk)
    },
    emitStderr(chunk) {
      stderr?.(chunk)
    },
    exit(code, signal = null) {
      for (const cb of [...exits]) cb(code, signal)
    },
  }
}

export interface FakeSpawner extends Spawner {
  requests: SpawnRequest[]
  children: FakeChild[]
  /** 下一次 spawn 抛这个错。 */
  failNext(error: Error): void
}

export function fakeSpawner(): FakeSpawner {
  const requests: SpawnRequest[] = []
  const children: FakeChild[] = []
  let failure: Error | undefined
  return {
    requests,
    children,
    failNext(error) {
      failure = error
    },
    spawn(request) {
      requests.push(request)
      if (failure !== undefined) {
        const err = failure
        failure = undefined
        throw err
      }
      const child = fakeChild(1000 + children.length)
      children.push(child)
      return child
    },
  }
}

/** 假 safeStorage：base64 反转，够验证"存进去的不是明文"。 */
export function fakeSafeStorage(available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => {
      const bytes = new TextEncoder().encode(plain)
      return Uint8Array.from(bytes, (b) => b ^ 0x5a)
    },
    decryptString: (encrypted) =>
      new TextDecoder().decode(Uint8Array.from(encrypted, (b) => b ^ 0x5a)),
  }
}

export function response(status: number, body: string): FetchResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  }
}

export function fakeFetch(
  handler: (url: string) => FetchResponseLike | Promise<FetchResponseLike>,
): FetchLike & { calls: string[] } {
  const calls: string[] = []
  const impl = (async (url: string) => {
    calls.push(url)
    return handler(url)
  }) as FetchLike & { calls: string[] }
  impl.calls = calls
  return impl
}

/** 确定性 randomBytes：0,1,2,… 循环。 */
export function seqRandomBytes(seed = 0): (size: number) => Uint8Array {
  let n = seed
  return (size) =>
    Uint8Array.from({ length: size }, () => {
      n = (n + 1) % 256
      return n
    })
}
