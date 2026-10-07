/**
 * WP247（Luoye 10-07 定 85）：**本机连接器按需下载**——用户第一次点「连接店铺 / 数据后台」时，
 * 服务进程用安装包自带的 node + 钉死版本的 npm（WP245 的 `ensureNpmCli`）把钉死版本的
 * `@oomol-lab/open-connector` 装进 `<data>/runtime/open-connector/<版本>`。起停归桌面壳
 * （`apps/desktop/src/connect-launcher.ts`，sidecar 监督者）；两边只经三份小文件说话（见
 * `@agentsws/connect-adapter` 的 `local-runtime.ts`）。
 *
 * | 步 | 做什么 |
 * |---|---|
 * | 准备 | 找 / 下 npm（WP245，sha512 校验）；在 `<root>/.staging-…` 写 package.json + **锁文件** + 宿主脚本 |
 * | 下载 | `node npm-cli.js ci --ignore-scripts …`：锁文件里 318 个包**每个都按 sha512 校验**，对不上整个不装；按「已取回 N / 318」出百分比 |
 * | 校验 | 版本对得上 + 用我们的 node 真 import 一次上游包 |
 * | 落位 | 暂存目录改名成 `<版本>`；写 `current.json`（上一版记成 `previous`，保留一份可回退，更早的删掉）；删下载缓存 |
 *
 * 取消 = 按进程树杀掉 npm、删暂存目录；失败一句人话（网络 / 超时 / 磁盘满 / 没权限 / 校验不对，
 * 原始码经 WP242 的 `netCauseOf` 或 `npm error code X` 挖出来）+ 重试（下载缓存留着，重试不必全下）。
 * **不跑任何包的安装脚本**（`--ignore-scripts`；锁文件里本来也没有要跑脚本的包）。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import type { LocalConnectorJobView } from '@agentsws/api'
import {
  type ControlFile,
  type CurrentFile,
  HOST_FILE,
  HOST_SCRIPT,
  hostPackageJson,
  isVersionDir,
  type LocalRuntimeLayout,
  localRuntimeLayout,
  lockedPackageCount,
  OPEN_CONNECTOR_LOCKFILE,
  OPEN_CONNECTOR_PIN,
  type OpenConnectorLockfile,
  type OpenConnectorPin,
  parseControlFile,
  parseCurrentFile,
  parseSupervisorFile,
  type SupervisorFile,
} from '@agentsws/connect-adapter'
import { type NpmRegistryChoice, withRegistry } from './npm-registry.js'
import { ensureNpmCli, NpmRuntimeError } from './npm-runtime.js'
import {
  classifyErrorCode,
  cleanLine,
  defaultSpawnTool,
  isNpmFetchLine,
  npmErrorCode,
  npmFetchFailure,
  runEnv,
  type SpawnTool,
  type ToolProcess,
} from './platform-cli-runner.js'

export type LocalJobPhase = LocalConnectorJobView['phase']
export type LocalJobErrorCode = NonNullable<LocalConnectorJobView['error']>['code']

export class LocalRuntimeError extends Error {
  constructor(
    readonly code: 'conflict' | 'busy' | 'not_installed',
    message: string,
  ) {
    super(message)
    this.name = 'LocalRuntimeError'
  }
}

/** 读一份 JSON 小文件；没有 / 坏了都是 undefined。 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

/** 先写临时文件再改名：另一边读到的要么是旧的，要么是新的，不会是半截。 */
export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

/** `EINTEGRITY` 单列（下载的东西与锁文件对不上——多半是镜像或中间人改了包）。 */
export function installFailure(code: string | undefined): LocalJobErrorCode {
  if (code === 'EINTEGRITY') return 'integrity'
  const kind = classifyErrorCode(code)
  return kind === 'denied' || kind === 'expired' || kind === 'not_installed' ? 'failed' : kind
}

// ── 装配 ────────────────────────────────────────────────────────────────

export interface OpenConnectorInstallerOptions {
  /** 服务进程的数据目录（`AGENTSWS_DB_DIR`）——桌面壳按同一个目录找。 */
  dataDir: string
  now: () => string
  /** 跑 npm 与校验用的 node（默认 `process.execPath`：安装包自带的那份）。 */
  nodeExec?: string
  env?: NodeJS.ProcessEnv
  spawn?: SpawnTool
  /** 找 / 下 npm（默认 WP245 的 `ensureNpmCli`，装在 `<data>/tools/npm`）；`registry` 是这一次的源。 */
  npmCli?: (onDownload: () => void, registry?: string) => Promise<string>
  /**
   * WP254（决策 100 / 123）：这一次下载用哪个源（每台机记的那一份）。不给 = 只看环境变量。
   * 换源不换校验：锁文件里每个包的 sha512 照样逐个对。
   */
  registry?: () => NpmRegistryChoice
  /** 测试换成自己的小包；不给 = 代码里钉死的那一版。 */
  pin?: OpenConnectorPin
  lockfile?: OpenConnectorLockfile
  /** 下载 + 安装的总时限（默认 20 分钟——国内网络慢）。 */
  timeoutMs?: number
  /** 装好之后的冒烟（默认：用我们的 node 真 import 一次上游包）。回 `undefined` = 过了，字符串 = 原因。 */
  verify?: (dir: string) => Promise<string | undefined>
  /** 删除下载前等桌面壳把它停下来，最多等多久（默认 20 秒）。 */
  stopWaitMs?: number
  sleep?: (ms: number) => Promise<void>
}

/** 服务进程这一侧看到的全部（`status` 由 connections 结合加固检查算，见 {@link localStatus}）。 */
export interface LocalRuntimeSnapshot {
  version: string
  download_bytes: number
  installed?: string
  previous?: string
  update_available: boolean
  desired: 'run' | 'stop'
  job?: LocalConnectorJobView
  supervisor?: SupervisorFile
}

export interface OpenConnectorInstaller {
  readonly layout: LocalRuntimeLayout
  snapshot(): LocalRuntimeSnapshot
  /** 开始下载（已经在下 → `conflict`）。立刻返回，进度看 `snapshot().job`。 */
  install(): LocalConnectorJobView
  /**
   * 工作台升级后钉的版本变了、而这台机器装的是旧版：后台把新版下好（下好桌面壳自动切过去，
   * 旧版留一份可回退）。没装过、已是新版、正在下载都不动。回「开始了没有」。
   */
  autoUpdate(): boolean
  cancel(): LocalConnectorJobView | undefined
  /** 请桌面壳重启它（`restart_seq + 1`）。 */
  restart(): void
  /** 换回上一版（没有上一版 → `not_installed`）。 */
  rollback(): void
  /** 删除下载：先请桌面壳停、等它停下，再删 `<data>/runtime/open-connector`（数据目录不动）。 */
  remove(): Promise<void>
  dispose(): void
}

const RUNNING = new Set<LocalJobPhase>(['preparing', 'downloading', 'verifying'])

export function isLocalJobRunning(job: LocalConnectorJobView | undefined): boolean {
  return job !== undefined && RUNNING.has(job.phase)
}

/** 默认冒烟：在装好的目录里用我们的 node 真 import 一次（包坏了、Node 太老都在这里露馅）。 */
export function defaultVerify(nodeExec: string, spawnTool: SpawnTool, env: Record<string, string>) {
  return async (dir: string): Promise<string | undefined> => {
    const code =
      "await import('@oomol-lab/open-connector'); await import('@hono/node-server'); console.log('ok')"
    const proc = spawnTool(nodeExec, ['--input-type=module', '-e', code], { env, cwd: dir })
    const lines: string[] = []
    proc.onLine((l) => lines.push(cleanLine(l)))
    const timer = setTimeout(() => proc.kill(), 60_000)
    timer.unref?.()
    const exit = await proc.done
    clearTimeout(timer)
    if (exit === 0 && lines.includes('ok')) return undefined
    return lines.filter((l) => l !== '').slice(-1)[0] ?? `exit ${exit}`
  }
}

export function createOpenConnectorInstaller(
  options: OpenConnectorInstallerOptions,
): OpenConnectorInstaller {
  const layout = localRuntimeLayout(options.dataDir)
  const pin = options.pin ?? OPEN_CONNECTOR_PIN
  const lockfile = options.lockfile ?? OPEN_CONNECTOR_LOCKFILE
  const env = options.env ?? process.env
  const nodeExec = options.nodeExec ?? process.execPath
  const spawnTool = options.spawn ?? defaultSpawnTool()
  const toolsDir = join(options.dataDir, 'tools')
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const envRegistry = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY
  const chooseRegistry = (): NpmRegistryChoice =>
    options.registry?.() ??
    (envRegistry === undefined || envRegistry === ''
      ? { source: 'official' }
      : { source: 'custom', url: envRegistry })
  const npmCli =
    options.npmCli ??
    ((onDownload: () => void, registry?: string) =>
      ensureNpmCli({
        nodeExec,
        toolsDir,
        onDownload,
        ...(registry === undefined || registry === '' ? {} : { registry }),
      }))
  // npm 与冒烟共用的子进程环境：WP245 的白名单（代理 / 证书 / 源地址照样放行），PATH 最前面是我们的 node
  const childEnv = (choice?: NpmRegistryChoice): Record<string, string> => {
    const base = runEnv({ telemetry_off_env: {} }, env, { nodeExec, action: 'install', toolsDir })
    return choice === undefined ? base : withRegistry(base, choice)
  }
  const verify = options.verify ?? defaultVerify(nodeExec, spawnTool, childEnv())

  let job: LocalConnectorJobView | undefined
  let proc: ToolProcess | undefined
  let cancelled = false

  const current = (): CurrentFile | undefined => {
    const parsed = parseCurrentFile(readJson(layout.current))
    // 记着的那一版目录被人删了 = 没装（别让壳去起一个不存在的东西）
    return parsed !== undefined && existsSync(layout.versionDir(parsed.version))
      ? parsed
      : undefined
  }
  const control = (): ControlFile =>
    parseControlFile(readJson(layout.control)) ?? {
      desired: 'run',
      restart_seq: 0,
      updated_at: '',
    }
  const writeControl = (patch: Partial<Pick<ControlFile, 'desired' | 'restart_seq'>>): void => {
    writeJsonAtomic(layout.control, { ...control(), ...patch, updated_at: options.now() })
  }

  const snapshot = (): LocalRuntimeSnapshot => {
    const cur = current()
    const supervisor = parseSupervisorFile(readJson(layout.supervisor))
    return {
      version: pin.version,
      download_bytes: pin.downloadBytes,
      ...(cur === undefined ? {} : { installed: cur.version }),
      ...(cur?.previous !== undefined && existsSync(layout.versionDir(cur.previous))
        ? { previous: cur.previous }
        : {}),
      update_available: cur !== undefined && cur.version !== pin.version,
      desired: control().desired,
      ...(job === undefined ? {} : { job: { ...job } }),
      ...(supervisor === undefined ? {} : { supervisor }),
    }
  }

  const finish = (
    phase: 'done' | 'failed' | 'cancelled',
    error?: LocalConnectorJobView['error'],
  ): void => {
    if (job === undefined || !RUNNING.has(job.phase)) return
    job.phase = phase
    job.finished_at = options.now()
    if (error !== undefined) job.error = error
  }

  /** 只删我们自己建的、能点名的目录（暂存 / 版本 / 缓存），一律在 `layout.root` 底下。 */
  const removeOwned = (path: string): void => {
    if (dirname(path) !== layout.root) throw new Error(`不在下载目录里：${path}`)
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  }

  /** 只留当前与上一版；更早的（目录名是版本号的）删掉。 */
  const prune = (keep: readonly string[]): void => {
    let names: string[] = []
    try {
      names = readdirSync(layout.root)
    } catch {
      return
    }
    for (const name of names) {
      if (isVersionDir(name) && !keep.includes(name)) removeOwned(join(layout.root, name))
      if (name.startsWith('.staging-')) removeOwned(join(layout.root, name))
    }
  }

  const run = async (staging: string): Promise<void> => {
    if (job === undefined) return
    const fail = (code: LocalJobErrorCode, detail?: string): void => {
      finish('failed', { code, ...(detail === undefined ? {} : { detail }) })
    }
    // WP254：这一次用哪个源，记在任务上（「出错」那一行据此决定给不给「换国内源再试」）
    const choice = chooseRegistry()
    job.registry = choice.source
    let cli: string
    try {
      cli = await npmCli(() => {
        if (job?.phase === 'preparing') job.phase = 'downloading'
      }, choice.url)
    } catch (err) {
      // 下 npm 失败（WP245 的分类：网络 / 磁盘 / 校验不对……）；分不出来的按网络算——那一步只有下载
      const { code, detail } = npmFetchFailure(err)
      const local: LocalJobErrorCode =
        err instanceof NpmRuntimeError && err.code === 'integrity'
          ? 'integrity'
          : code === 'network' ||
              code === 'timeout' ||
              code === 'disk_full' ||
              code === 'permission'
            ? code
            : 'network'
      return fail(local, detail)
    }
    if (cancelled) return finish('cancelled')
    try {
      mkdirSync(staging, { recursive: true })
      writeJsonAtomic(join(staging, 'package.json'), hostPackageJson(pin))
      writeJsonAtomic(join(staging, 'package-lock.json'), lockfile)
      writeFileSync(join(staging, HOST_FILE), HOST_SCRIPT)
    } catch (err) {
      const code = installFailure((err as NodeJS.ErrnoException).code)
      return fail(code === 'failed' ? 'permission' : code, (err as NodeJS.ErrnoException).code)
    }
    job.phase = 'downloading'
    const args = [
      cli,
      'ci',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--no-update-notifier',
      '--loglevel=http',
      '--cache',
      layout.cache,
    ]
    const log: string[] = []
    const started = spawnTool(nodeExec, args, { env: childEnv(choice), cwd: staging })
    proc = started
    started.onLine((raw) => {
      const line = cleanLine(raw)
      if (line === '') return
      log.push(line)
      if (log.length > 60) log.shift()
      if (job !== undefined && isNpmFetchLine(line) && /\.tgz\b/.test(line))
        job.fetched = Math.min(job.total, job.fetched + 1)
    })
    let timedOut = false
    const timer = setTimeout(
      () => {
        timedOut = true
        started.kill()
      },
      options.timeoutMs ?? 20 * 60_000,
    )
    timer.unref?.()
    const exit = await started.done
    clearTimeout(timer)
    proc = undefined
    if (cancelled) return finish('cancelled')
    if (timedOut) return fail('timeout')
    if (exit !== 0) {
      const code = npmErrorCode(log)
      return fail(installFailure(code), code ?? `exit ${exit}`)
    }
    job.phase = 'verifying'
    job.fetched = job.total
    const pkg = readJson(join(staging, 'node_modules', ...pin.package.split('/'), 'package.json'))
    const got = (pkg as { version?: unknown } | undefined)?.version
    if (got !== pin.version) return fail('integrity', `version ${String(got)}`)
    const bad = await verify(staging)
    if (cancelled) return finish('cancelled')
    if (bad !== undefined) return fail('failed', bad.slice(0, 200))
    // 落位：暂存目录 → <版本>；上一版留着可回退
    const before = current()
    const target = layout.versionDir(pin.version)
    if (before?.version === pin.version) throw new LocalRuntimeError('conflict', '这一版已经装着')
    removeOwned(target)
    renameSync(staging, target)
    const next: CurrentFile = {
      version: pin.version,
      ...(before === undefined ? {} : { previous: before.version }),
      installed_at: options.now(),
    }
    writeJsonAtomic(layout.current, next)
    if (control().desired === 'stop') writeControl({ desired: 'run' })
    prune([next.version, ...(next.previous === undefined ? [] : [next.previous])])
    removeOwned(layout.cache)
    finish('done')
  }

  return {
    layout,
    snapshot,
    install() {
      if (isLocalJobRunning(job)) throw new LocalRuntimeError('conflict', '已经在下载了')
      const cur = current()
      if (cur?.version === pin.version) throw new LocalRuntimeError('conflict', '这一版已经装好了')
      cancelled = false
      job = {
        phase: 'preparing',
        version: pin.version,
        started_at: options.now(),
        fetched: 0,
        total: lockedPackageCount(lockfile),
      }
      const staging = join(layout.root, `.staging-${pin.version}-${Date.now().toString(36)}`)
      void run(staging)
        .catch((err: unknown) => {
          const code = (err as NodeJS.ErrnoException).code
          finish('failed', {
            code: installFailure(code),
            detail: code ?? (err instanceof Error ? err.message : String(err)).slice(0, 200),
          })
        })
        .finally(() => {
          // 没走到落位的暂存目录一律清掉（下载缓存留着，重试接着用）
          if (existsSync(staging)) removeOwned(staging)
        })
      return { ...job }
    },
    autoUpdate() {
      const cur = current()
      if (cur === undefined || cur.version === pin.version || isLocalJobRunning(job)) return false
      this.install()
      return true
    },
    cancel() {
      if (job === undefined) return undefined
      if (RUNNING.has(job.phase)) {
        cancelled = true
        proc?.kill()
        if (proc === undefined) finish('cancelled')
      }
      return { ...job }
    },
    restart() {
      if (current() === undefined) throw new LocalRuntimeError('not_installed', '连接器还没下载')
      const c = control()
      writeControl({ desired: 'run', restart_seq: c.restart_seq + 1 })
    },
    rollback() {
      const cur = current()
      const prev = snapshot().previous
      if (cur === undefined || prev === undefined)
        throw new LocalRuntimeError('not_installed', '没有可以回退的上一版')
      writeJsonAtomic(layout.current, {
        version: prev,
        previous: cur.version,
        installed_at: options.now(),
      } satisfies CurrentFile)
    },
    async remove() {
      if (isLocalJobRunning(job)) throw new LocalRuntimeError('busy', '正在下载，先取消')
      if (!existsSync(layout.root)) return
      writeControl({ desired: 'stop' })
      const deadline = options.stopWaitMs ?? 20_000
      for (let waited = 0; waited < deadline; waited += 250) {
        const s = parseSupervisorFile(readJson(layout.supervisor))
        if (s === undefined || (s.state === 'stopped' && s.pid === undefined)) break
        await sleep(250)
      }
      const s = parseSupervisorFile(readJson(layout.supervisor))
      if (s !== undefined && s.pid !== undefined)
        throw new LocalRuntimeError('busy', '连接器还在运行，没能停下来；稍后再试')
      rmSync(layout.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      job = undefined
    },
    dispose() {
      if (!isLocalJobRunning(job)) return
      cancelled = true
      proc?.kill()
    },
  }
}

/**
 * 顶上那一行（WP247 要做 5）：没下载 / 下载中 / 启动中 / 就绪 / 出错 / 停着。
 *
 * `hardened` 是加固检查的结论（`ready` / `absent` = 探不到 / `unhardened`）。**加固不过不算就绪**——
 * 进程起着但鉴权或加密没开，照样是「出错」（08 §5）。
 */
export function localStatus(
  s: LocalRuntimeSnapshot,
  hardened: 'ready' | 'absent' | 'unhardened',
): 'not_installed' | 'downloading' | 'starting' | 'ready' | 'error' | 'stopped' {
  if (isLocalJobRunning(s.job)) return 'downloading'
  if (s.installed === undefined) return s.job?.phase === 'failed' ? 'error' : 'not_installed'
  if (s.desired === 'stop') return 'stopped'
  if (hardened === 'ready') return 'ready'
  if (hardened === 'unhardened') return 'error'
  const sup = s.supervisor
  if (sup === undefined) return 'starting'
  if (sup.state === 'failed') return 'error'
  if (sup.state === 'backoff' && sup.attempts >= 3) return 'error'
  if (sup.state === 'stopped') return 'stopped'
  return 'starting'
}
