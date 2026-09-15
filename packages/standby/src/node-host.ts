/**
 * 把 Node 的真家伙（`child_process.spawn`、`fs`、端口）包成这个包认的那几个接口。
 *
 * 分出来是为了让 `orchestrator.ts` / `service.ts` 里**一行 `node:` 的 import 都没有**：
 * 那两个文件是逻辑，逻辑该能在测试里全程不碰文件系统、不起进程地跑完。
 */
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  ChildHandle,
  SpawnLike,
  SpawnOptions,
  StandbyFs,
  StandbySecrets,
  TempFile,
} from './types.js'

/**
 * 真随机与真哈希。`node:crypto` 在整个包里**只在这个文件出现**——
 * 逻辑那几个文件要能在测试里全程不碰系统资源地跑完。
 */
export const nodeSecrets: StandbySecrets = {
  newToken: () => `wst_${randomBytes(32).toString('base64url')}`,
  sha256: (value: string) => createHash('sha256').update(value).digest('hex'),
}

/**
 * `child_process.spawn` 的适配。
 *
 * `stdio: 'ignore'` 是有意的：子进程的 stdout 里有工作区 id、owner 邮箱、
 * 内部凭据的前八位（见 `apps/server` 的启动打印）。把它接到云进程的日志里，
 * 就等于把每个租户的这几样东西抄进我们的日志——49 M6 说的"入口不存正文"
 * 在这里同样成立。
 */
export const nodeSpawnAdapter: SpawnLike = (
  command: string,
  args: string[],
  options: SpawnOptions,
): ChildHandle => {
  const child = nodeSpawn(command, args, {
    env: options.env,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdio: 'ignore',
    detached: false,
  })
  let exited = false
  const listeners: ((code: number | null) => void)[] = []
  const fire = (code: number | null): void => {
    if (exited) return
    exited = true
    for (const l of [...listeners]) l(code)
  }
  child.on('exit', (code) => {
    fire(code)
  })
  // 起都没起来（可执行找不到、权限不对）：与"起来了又退了"走同一条路，
  // 否则这个 error 会变成一个没人接的 unhandled exception 把云进程带走
  child.on('error', () => {
    fire(null)
  })
  return {
    pid: child.pid,
    kill(signal?: string) {
      try {
        child.kill((signal ?? 'SIGTERM') as NodeJS.Signals)
      } catch {
        // 已经退了：没什么可杀的
      }
    },
    onExit(listener: (code: number | null) => void) {
      listeners.push(listener)
    },
  }
}

/**
 * 传给子进程的基础环境变量。
 *
 * **不是 `...process.env`**：云进程自己的环境里有 New API 的内部密钥、Stripe 的
 * 密钥、云侧库的路径。整份继承过去，等于每个租户的进程里都有一份我们的钥匙。
 * 所以这里是白名单——只有"一个 Node 进程要活下去"必须的那几个。
 */
export const CHILD_ENV_PASSTHROUGH = ['PATH', 'HOME', 'TMPDIR', 'TZ', 'LANG', 'LC_ALL'] as const

export function baseChildEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of CHILD_ENV_PASSTHROUGH) {
    const value = env[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

export const nodeFs: StandbyFs = {
  mkdir(path: string) {
    mkdirSync(path, { recursive: true })
  },
  exists: (path: string) => existsSync(path),
  isEmptyDir(path: string) {
    if (!existsSync(path)) return true
    return readdirSync(path).length === 0
  },
  writeTemp(name: string, bytes: Uint8Array): TempFile {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-standby-'))
    const path = join(dir, name)
    writeFileSync(path, bytes)
    return {
      path,
      dispose() {
        rmSync(dirname(path), { recursive: true, force: true })
      },
    }
  },
  readFile: (path: string) => readFileSync(path),
}

/**
 * 要一个**本机回环**上的空闲端口。
 *
 * 只绑 127.0.0.1：子进程本来就只该被同机的云进程转发到，绑 0.0.0.0 等于
 * 把每个租户的服务进程直接挂到公网上，再在前面加一层代理也挡不住有人直连端口。
 */
export async function allocateLoopbackPort(): Promise<number> {
  const server = createServer()
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve()
    })
  })
  if (port === 0) throw new Error('要不到空闲端口')
  return port
}
