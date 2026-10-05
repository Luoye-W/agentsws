/**
 * WP216（Luoye 10-05「也要引导用户设置 Shopify CLI 啥的」）：**平台官方 CLI 的检测与引导状态**。
 *
 * 平台专属（哪个 CLI、命令是什么、最低 Node 版本）全在 `@agentsws/contracts` 的 `PLATFORM_KITS`
 * 那一行里，这个文件里**没有一个平台名**——以后接 WooCommerce / Shopline 的 CLI，往表里加一行就行。
 *
 * 四条纪律：
 *
 * 1. **不进安装包**（「不打包重型本机运行时」）：我们只检测、只给官方安装命令与教程；装是用户自己在终端里装。
 * 2. **登录永远是用户本人在浏览器里完成**：我们不跑登录命令、不碰账号密码、不读 CLI 自己存的会话文件。
 *    「登好了没有」只有两个来源：用户在卡上点「我登好了」（按品牌记一笔时间，**不存任何凭据**），
 *    或者之后一次真的主题命令成功（同一个口子记）。
 * 3. **平台对不上就不检测**：调用方先按品牌档案查 `platformKitOf(...)?.cli`，没有就不调这里——
 *    非 Shopify 的品牌一次 `shopify version` 都不跑。
 * 4. **子进程环境走白名单**（与 `shopify-theme.ts` 同一张 `PASSTHROUGH_ENV`），另加平台那一行要求的
 *    关遥测变量；输出只取版本号，不进事件、不进日志。
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PlatformCliSpec } from '@agentsws/contracts'
import { PASSTHROUGH_ENV } from './shopify-theme.js'

/** 跑一条命令（测试注入假 CLI / 假 node）。`ENOENT` = 没装。 */
export type ProbeExec = (
  bin: string,
  args: readonly string[],
  opts: { env: Record<string, string>; timeoutMs: number },
) => Promise<{ ok: boolean; stdout: string; missing?: boolean }>

/** 检测出来的样子（给卡片用；没有一个凭据、没有一行原始输出）。 */
export interface PlatformCliProbe {
  installed: boolean
  /** `shopify version` 报的版本号（只取 `x.y.z`）。 */
  version?: string
  /** 本机 PATH 里的 node 版本（CLI 用的就是它）。 */
  node_version?: string
  /** node 够不够官方要求的最低主版本；没有 node 也算不够。 */
  node_ok: boolean
  min_node_major: number
  checked_at: string
}

/** 只取版本号（`3.84.1`、`v22.11.0` → `22.11.0`）；认不出回 undefined。 */
export function parseVersion(text: string): string | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m === null ? undefined : `${m[1]}.${m[2]}.${m[3]}`
}

export function nodeMajorOk(version: string | undefined, min: number): boolean {
  if (version === undefined) return false
  const major = Number(version.split('.')[0])
  return Number.isFinite(major) && major >= min
}

/** 子进程环境：白名单 + 平台那一行要求的关遥测变量。 */
export function probeEnv(
  spec: Pick<PlatformCliSpec, 'telemetry_off_env'>,
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of PASSTHROUGH_ENV) {
    const value = env[key]
    if (typeof value === 'string') out[key] = value
  }
  out.CI = '1'
  for (const [k, v] of Object.entries(spec.telemetry_off_env)) out[k] = v
  return out
}

export function defaultProbeExec(): ProbeExec {
  return (bin, args, opts) =>
    new Promise((resolve) => {
      execFile(
        bin,
        [...args],
        { env: opts.env, timeout: opts.timeoutMs, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err === null) {
            resolve({ ok: true, stdout: String(stdout) })
            return
          }
          const e = err as NodeJS.ErrnoException
          resolve({ ok: false, stdout: String(stdout ?? ''), missing: e.code === 'ENOENT' })
        },
      )
    })
}

export interface PlatformCliProber {
  /** 检测一次（`fresh` = 不用缓存）。**永不抛**——查不出就是没装。 */
  probe(spec: PlatformCliSpec, opts?: { fresh?: boolean }): Promise<PlatformCliProbe>
}

export function createPlatformCliProber(options: {
  now: () => string
  env?: NodeJS.ProcessEnv
  exec?: ProbeExec
  /** 缓存多久（毫秒）：卡片每次刷新都去跑一遍 CLI 太重。默认 5 分钟。 */
  ttlMs?: number
  timeoutMs?: number
}): PlatformCliProber {
  const exec = options.exec ?? defaultProbeExec()
  const env = options.env ?? process.env
  const ttl = options.ttlMs ?? 5 * 60 * 1000
  const timeoutMs = options.timeoutMs ?? 20_000
  const cache = new Map<string, { at: number; value: PlatformCliProbe }>()
  return {
    async probe(spec, opts = {}) {
      const hit = cache.get(spec.id)
      const nowMs = Date.parse(options.now())
      if (opts.fresh !== true && hit !== undefined && nowMs - hit.at < ttl) return hit.value
      const childEnv = probeEnv(spec, env)
      const [cli, node] = await Promise.all([
        exec(spec.bin, spec.version_args, { env: childEnv, timeoutMs }).catch(() => ({
          ok: false,
          stdout: '',
        })),
        exec('node', ['--version'], { env: childEnv, timeoutMs }).catch(() => ({
          ok: false,
          stdout: '',
        })),
      ])
      const version = cli.ok ? parseVersion(cli.stdout) : undefined
      const node_version = node.ok ? parseVersion(node.stdout) : undefined
      const value: PlatformCliProbe = {
        installed: cli.ok,
        ...(version === undefined ? {} : { version }),
        ...(node_version === undefined ? {} : { node_version }),
        node_ok: nodeMajorOk(node_version, spec.min_node_major),
        min_node_major: spec.min_node_major,
        checked_at: options.now(),
      }
      cache.set(spec.id, { at: nowMs, value })
      return value
    },
  }
}

// ── 「我登好了」：按品牌记一笔时间（不存任何凭据） ─────────────────────────

interface LoginFile {
  version: 1
  /** CLI id → 用户说「登好了」的时间。 */
  confirmed: Record<string, string>
}

/**
 * 按品牌的数据目录存一个 JSON（没有数据目录 = 只在内存里）。
 * 里面只有「哪个 CLI、什么时候」，**没有账号、没有店铺、没有令牌**。
 */
export class PlatformCliLoginStore {
  private readonly file: string | undefined
  private state: LoginFile

  constructor(dataDir: string | undefined) {
    this.file = dataDir === undefined ? undefined : join(dataDir, 'platform-cli.json')
    this.state = { version: 1, confirmed: {} }
    if (this.file !== undefined && existsSync(this.file)) {
      try {
        const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LoginFile>
        if (raw.confirmed !== undefined && typeof raw.confirmed === 'object')
          this.state.confirmed = { ...raw.confirmed }
      } catch {
        // 坏文件当没有：最坏是卡上回到「还没登录」，用户再点一次
      }
    }
  }

  confirmedAt(cli_id: string): string | undefined {
    return this.state.confirmed[cli_id]
  }

  set(cli_id: string, at: string | undefined): void {
    if (at === undefined) delete this.state.confirmed[cli_id]
    else this.state.confirmed[cli_id] = at
    if (this.file === undefined) return
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8')
  }
}
