/**
 * 测试台：假子进程、假文件系统、假打包器、可拨的钟。
 *
 * 一条线贯穿：**整套测试不起一个真进程、不写一个真文件、不发一个真请求**。
 * 值守的逻辑（计费、状态机、退避、代理）与"能不能真起一个 Node 进程"是两件事，
 * 后者由 `integration.test.ts` 里那一条真起子进程的用例单独钉。
 */
import { buildPricing, MemoryWalletStore, Wallet } from '@agentsws/metering'
import {
  type ChildHandle,
  ChildTokens,
  createMemoryKeyring,
  MemoryStandbyStore,
  MemoryTokenStore,
  type SpawnLike,
  type StandbyFs,
  type StandbyPackager,
  type StandbySecrets,
  StandbyService,
  type TempFile,
} from '../src/index.js'

/** 可拨的钟。 */
export function testClock(start = '2026-09-15T00:00:00.000Z'): {
  now: () => string
  advance: (ms: number) => void
  set: (at: string) => void
} {
  let at = Date.parse(start)
  return {
    now: () => new Date(at).toISOString(),
    advance: (ms: number) => {
      at += ms
    },
    set: (v: string) => {
      at = Date.parse(v)
    },
  }
}

export interface FakeChild extends ChildHandle {
  workspace_id: string
  env: Record<string, string>
  killed: string[]
  /** 让它"崩"一次。 */
  crash(code?: number): void
}

export interface FakeSpawn {
  spawn: SpawnLike
  /** 每次 spawn 记一条。 */
  calls: FakeChild[]
  last(): FakeChild
}

export function fakeSpawn(): FakeSpawn {
  const calls: FakeChild[] = []
  const spawn: SpawnLike = (_command, _args, options) => {
    const listeners: ((code: number | null) => void)[] = []
    const child: FakeChild = {
      pid: 1000 + calls.length,
      workspace_id: options.env.AGENTSWS_WORKSPACE_ID ?? '',
      env: options.env,
      killed: [],
      kill(signal) {
        child.killed.push(signal ?? 'SIGTERM')
      },
      onExit(listener) {
        listeners.push(listener)
      },
      crash(code = 1) {
        for (const l of [...listeners]) l(code)
      },
    }
    calls.push(child)
    return child
  }
  return { spawn, calls, last: () => calls[calls.length - 1] as FakeChild }
}

/** 内存文件系统：只记"哪个目录里有几个文件"。 */
export function fakeFs(): StandbyFs & { dirs: Map<string, number>; temps: string[] } {
  const dirs = new Map<string, number>()
  const files = new Map<string, Uint8Array>()
  const temps: string[] = []
  let n = 0
  return {
    dirs,
    temps,
    mkdir(path) {
      if (!dirs.has(path)) dirs.set(path, 0)
    },
    exists: (path) => dirs.has(path) || files.has(path),
    isEmptyDir: (path) => (dirs.get(path) ?? 0) === 0,
    writeTemp(name, bytes): TempFile {
      n += 1
      const path = `/tmp/fake-${String(n)}/${name}`
      files.set(path, bytes)
      temps.push(path)
      return {
        path,
        dispose() {
          files.delete(path)
          temps.splice(temps.indexOf(path), 1)
        },
      }
    },
    readFile: (path) => files.get(path) ?? new Uint8Array(),
  }
}

/** 假打包器：`ok = false` 时导入一律抛（"包坏了"那条用例）。 */
export function fakePackager(
  options: { ok?: boolean; fs?: ReturnType<typeof fakeFs> } = {},
): StandbyPackager & {
  imported: string[]
  exported: string[]
} {
  const imported: string[] = []
  const exported: string[] = []
  return {
    imported,
    exported,
    importPackage(input) {
      if (options.ok === false)
        return Promise.reject(new Error('manifest.json 里 data.db 的哈希对不上'))
      imported.push(input.dataDir)
      // 解包成功 = 这个目录里有东西了
      options.fs?.dirs.set(input.dataDir, 7)
      return Promise.resolve({ workspace_id: 'ws_demo', files: 7 })
    },
    exportPackage(input) {
      exported.push(input.dataDir)
      return Promise.resolve({ out: input.out, bytes: 1234 })
    },
  }
}

/** 假的随机与哈希（确定性：同一串输入永远同一个输出）。 */
export function fakeSecrets(): StandbySecrets {
  let n = 0
  return {
    newToken: () => {
      n += 1
      return `wst_child_${String(n)}`
    },
    sha256: (value: string) => `sha(${value})`,
  }
}

export interface Harness {
  service: StandbyService
  clock: ReturnType<typeof testClock>
  spawn: FakeSpawn
  fs: ReturnType<typeof fakeFs>
  packager: ReturnType<typeof fakePackager>
  wallet: Wallet
  store: MemoryStandbyStore
  childTokens: ChildTokens
  events: { type: string; workspace_id: string; reason?: string }[]
  /** 健康检查回什么。`true` = 200。 */
  healthy: { value: boolean }
  /** 代理那一跳收到的 target（断言路径与查询串）。 */
  proxied: { url: string; init?: RequestInit }[]
  /** 代理的假上游回什么。 */
  upstream: { respond: (url: string, init?: RequestInit) => Response }
}

export function harness(
  options: { credits?: number; packageOk?: boolean; seatPrice?: number } = {},
): Harness {
  const clock = testClock()
  const spawn = fakeSpawn()
  const fs = fakeFs()
  const packager = fakePackager({
    ...(options.packageOk === undefined ? {} : { ok: options.packageOk }),
    fs,
  })
  const store = new MemoryStandbyStore()
  const walletStore = new MemoryWalletStore()
  let seq = 0
  const wallet = new Wallet({
    store: walletStore,
    now: () => clock.now(),
    newId: (prefix) => `${prefix}_${String(++seq)}`,
  })
  if ((options.credits ?? 0) > 0)
    wallet.topup({ org_id: 'org_1', credits: options.credits ?? 0, kind: 'purchased' })

  const childTokens = new ChildTokens({
    store: new MemoryTokenStore(),
    secrets: fakeSecrets(),
    now: () => clock.now(),
  })
  const events: Harness['events'] = []
  const healthy = { value: true }
  const proxied: Harness['proxied'] = []
  const upstream = {
    respond: (url: string) =>
      new Response(JSON.stringify({ hit: url }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  }

  const service = new StandbyService({
    store,
    clock: { now: () => clock.now() },
    spawn: spawn.spawn,
    fetch: (input, init) => {
      if (input.endsWith('/v1/health'))
        return Promise.resolve(new Response('{}', { status: healthy.value ? 200 : 503 }))
      proxied.push({ url: input, ...(init === undefined ? {} : { init }) })
      return Promise.resolve(upstream.respond(input, init))
    },
    keyring: createMemoryKeyring(),
    packager,
    fs,
    dataRoot: '/data/standby',
    serverEntry: '/app/server/dist/index.js',
    allocatePort: () => Promise.resolve(41000 + spawn.calls.length),
    cloudBaseUrl: 'https://cloud.agentsws.app',
    childTokens,
    wallet,
    pricing: buildPricing(),
    onEvent: (e) => {
      events.push({
        type: e.type,
        workspace_id: e.workspace_id,
        ...(e.reason === undefined ? {} : { reason: e.reason }),
      })
    },
    newRequestId: () => `req_${String(++seq)}`,
  })

  return {
    service,
    clock,
    spawn,
    fs,
    packager,
    wallet,
    store,
    childTokens,
    events,
    healthy,
    proxied,
    upstream,
  }
}
