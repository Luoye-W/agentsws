/**
 * WP136（docs/79）：在 Agents 工坊里切换 dsh 场景（Profile）。
 *
 * Agents 工坊是 dsh 里的**一个**场景，固定第一、默认；其他场景（官方模板 `web` 等、用户自建的）
 * 由 DeepSeek 官方维护——我们只提供入口：列出来、起 / 停 / 重启网页场景、新建、删自建的。
 *
 * 四条纪律（docs/79 §3）：
 * 1. **用捆绑的 Node 跑捆绑的 `dsh`**：服务进程自己就跑在捆绑的 Node 上（桌面壳 `resolveServerRuntime`），
 *    所以 `process.execPath` 就是它；`dsh` 从 dsh-adapter 的依赖解析（`dshLauncher()`），不走 PATH。
 * 2. **`DSH_HOME` 在我们的应用数据目录里**（桌面壳传 `AGENTSWS_DSH_HOME = <userData>/dsh`），
 *    永远不落到 `~/.dsh`——用户另装的那份 dsh 用它自己的，两个版本不互改配置。
 * 3. **其他场景按 dsh 默认运行**：我们的七行锁定（`profiles/agentsws/cordis.patch.yml`）一行都不带过去，
 *    也不给它们打任何 patch。
 * 4. **我们的业务数据它们够不着**：工作区根不在（也不包含）我们的数据目录；环境变量白名单继承，
 *    我们的密钥一个都不带（`sceneEnv`）。
 */
import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ApiError } from '@agentsws/api'
import type {
  DshSceneOpenResult,
  DshSceneState,
  DshScenesView,
  DshSceneView,
} from '@agentsws/contracts'
import {
  AGENTSWS_SCENE,
  DSH_SCENE_TEMPLATES,
  type DshLauncher,
  dshLauncher,
  isInside,
  parseWebSceneUrl,
  portOfUrl,
  RESERVED_SCENE_NAMES,
  redactSceneUrl,
  sceneDir,
  sceneEnv,
  sceneNameProblem,
  sceneTemplate,
  surfaceOfBundles,
  webSceneArgs,
} from '@agentsws/dsh-adapter'

const execFileAsync = promisify(execFile)

/** 桌面壳传进来的 `DSH_HOME`（`<userData>/dsh`）。 */
export const DSH_HOME_ENV = 'AGENTSWS_DSH_HOME'
/** 桌面壳的应用数据目录（`<userData>`：`secrets.bin` / `config.json` 所在）；其他场景的工作目录不许碰它。 */
export const DSH_APP_DATA_ENV = 'AGENTSWS_APP_DATA_DIR'
/** 其他场景的工作目录；不给就是 `~/dsh-workspace`。 */
export const DSH_WORKSPACE_ENV = 'AGENTSWS_DSH_WORKSPACE'

/**
 * 我们的 `DSH_HOME` 放哪：显式给了用给的；否则放在数据目录**旁边**（`<数据目录>/../dsh`，
 * 桌面壳的布局下正好是 `<userData>/dsh`）。**不放进数据目录里面**：备份 / 导出会把它整个打包，
 * 而那里面有 dsh 的本机凭据库和各场景装的插件。没有数据目录（全内存档）就没有场景可切。
 */
export function dshHomeOf(
  env: Readonly<Record<string, string | undefined>>,
  dbDir: string | undefined,
): string | undefined {
  const explicit = env[DSH_HOME_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit)
  if (dbDir === undefined) return undefined
  return resolve(dbDir, '..', 'dsh')
}

/** 其他场景的默认工作区根。 */
export function workspaceRootOf(env: Readonly<Record<string, string | undefined>>): string {
  const explicit = env[DSH_WORKSPACE_ENV]?.trim()
  return explicit !== undefined && explicit !== ''
    ? resolve(explicit)
    : join(homedir(), 'dsh-workspace')
}

export interface DshScenesOptions {
  dshHome: string
  /** 其他场景启动时的工作目录。 */
  workspaceRoot: string
  /**
   * 其他场景**不许**碰的目录（我们的数据目录、应用数据目录）。工作区根既不能在它们里面，
   * 也不能包含它们——任一成立就不装配（`available: false`）。
   */
  protectedDirs: readonly string[]
  /** 跑 `dsh` 的 Node。不给 = `process.execPath`（服务进程自己跑在捆绑的 Node 上）。 */
  nodeExec?: string
  /** 不给 = 从 dsh-adapter 的依赖解析。测试塞一个假的。 */
  launcher?: DshLauncher
  /** 继承哪些变量由 `sceneEnv` 的白名单决定；这里给的是"从哪儿继承"。 */
  baseEnv?: Readonly<Record<string, string | undefined>>
  now?: () => string
  /** 网页场景多久没打出网址就算没起来。 */
  startTimeoutMs?: number
  /** 发了 SIGTERM 之后等多久再 SIGKILL（dsh 自己的关机上限是 5 秒）。 */
  stopTimeoutMs?: number
  /** 只记"谁起了、谁停了、为什么失败"；网址里的 token 在这之前已经抹掉。 */
  log?: (line: string) => void
}

/** 一个网页场景的进程。 */
interface Running {
  child: ChildProcess
  state: DshSceneState
  url?: string
  port?: number
  startedAt: string
  stopping: boolean
  ready: Promise<string>
}

export interface DshScenesManager {
  readonly dshHome: string
  readonly workspaceRoot: string
  list(): DshScenesView
  create(input: { name: string; template: string }): Promise<DshSceneView>
  remove(name: string, confirm: string): Promise<{ deleted: true }>
  open(name: string): Promise<DshSceneOpenResult>
  stop(name: string): Promise<DshSceneView>
  restart(name: string): Promise<DshSceneOpenResult>
  /** 起一个场景用的命令行、工作目录与环境（边界测试直接读它）。 */
  launchSpec(name: string): {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
  }
  /** 关服务进程时把起过的场景全停掉。 */
  close(): Promise<void>
}

/** 工作区根与受保护目录的关系；有问题回一句人话。 */
export function workspaceProblem(
  root: string,
  protectedDirs: readonly string[],
): string | undefined {
  for (const dir of protectedDirs) {
    if (isInside(root, dir)) return `其他场景的工作目录（${root}）不能放在 Agents 工坊的数据目录里`
    if (isInside(dir, root)) return `其他场景的工作目录（${root}）不能包含 Agents 工坊的数据目录`
  }
  return undefined
}

// ── 读目录 ────────────────────────────────────────────────────────────────

interface OnDisk {
  name: string
  /** 有 `package.json`（dsh 真把它初始化过）。 */
  initialized: boolean
  bundles: readonly string[]
}

/** `$DSH_HOME/profiles/*`：每个目录读一下它的 `dsh.profile.bundles`。 */
function readProfiles(dshHome: string): OnDisk[] {
  const root = join(dshHome, 'profiles')
  if (!existsSync(root)) return []
  const out: OnDisk[] = []
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    try {
      if (!lstatSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    const manifest = join(dir, 'package.json')
    let bundles: readonly string[] = []
    let initialized = false
    if (existsSync(manifest)) {
      initialized = true
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          dsh?: { profile?: { bundles?: unknown } }
        }
        const raw = pkg.dsh?.profile?.bundles
        if (Array.isArray(raw)) bundles = raw.filter((b): b is string => typeof b === 'string')
      } catch {
        // 坏掉的 package.json：当作命令行类场景列出来（能删，打不开）
      }
    }
    out.push({ name, initialized, bundles })
  }
  return out
}

/** 一组 bundles 是从哪个官方模板建的（逐字相同才算）。 */
function templateOfBundles(bundles: readonly string[]): string | undefined {
  return DSH_SCENE_TEMPLATES.find(
    (t) => t.bundles.length === bundles.length && t.bundles.every((b, i) => b === bundles[i]),
  )?.name
}

// ── 管理器 ────────────────────────────────────────────────────────────────

export function createDshScenes(options: DshScenesOptions): DshScenesManager {
  const dshHome = resolve(options.dshHome)
  const workspaceRoot = resolve(options.workspaceRoot)
  const nodeExec = options.nodeExec ?? process.execPath
  const now = options.now ?? (() => new Date().toISOString())
  const startTimeoutMs = options.startTimeoutMs ?? 60_000
  const stopTimeoutMs = options.stopTimeoutMs ?? 8_000
  const log = options.log ?? (() => undefined)
  const baseEnv = options.baseEnv ?? process.env
  let launcherCache = options.launcher
  const launcher = (): DshLauncher => {
    launcherCache ??= dshLauncher()
    return launcherCache
  }
  const running = new Map<string, Running>()
  /** 上一次没起来 / 意外退出的原因（场景名 → 一句人话）。 */
  const lastError = new Map<string, string>()

  const wsProblem = workspaceProblem(workspaceRoot, options.protectedDirs)
  if (wsProblem !== undefined) throw new Error(wsProblem)

  const viewOf = (
    name: string,
    origin: DshSceneView['origin'],
    surface: DshSceneView['surface'],
    initialized: boolean,
    template?: string,
  ): DshSceneView => {
    const proc = running.get(name)
    const error = lastError.get(name)
    return {
      name,
      origin,
      surface,
      ...(template === undefined ? {} : { template }),
      is_default: origin === 'agentsws',
      deletable: origin === 'custom',
      launchable: surface !== 'cli',
      initialized,
      state:
        origin === 'agentsws'
          ? 'running'
          : (proc?.state ?? (error === undefined ? 'stopped' : 'failed')),
      ...(proc?.port === undefined ? {} : { port: proc.port }),
      ...(proc === undefined ? {} : { started_at: proc.startedAt }),
      ...(proc === undefined && error !== undefined ? { error } : {}),
    }
  }

  const scenes = (): DshSceneView[] => {
    const disk = readProfiles(dshHome)
    const diskByName = new Map(disk.map((d) => [d.name, d]))
    const official = DSH_SCENE_TEMPLATES.map((t) =>
      viewOf(t.name, 'official', t.surface, diskByName.get(t.name)?.initialized === true),
    )
    const custom = disk
      .filter((d) => !RESERVED_SCENE_NAMES.includes(d.name))
      .map((d) => {
        const template = templateOfBundles(d.bundles)
        return viewOf(d.name, 'custom', surfaceOfBundles(d.bundles), d.initialized, template)
      })
    return [
      viewOf(AGENTSWS_SCENE, 'agentsws', 'agentsws', true),
      ...official.filter((s) => s.surface === 'web'),
      ...custom,
      ...official.filter((s) => s.surface !== 'web'),
    ]
  }

  const find = (name: string): DshSceneView => {
    const scene = scenes().find((s) => s.name === name)
    if (scene === undefined) throw new ApiError('not_found', `没有这个场景：${name}`)
    return scene
  }

  const launchSpec: DshScenesManager['launchSpec'] = (name) => {
    // 名字先过一遍目录规则（官方模板名与列出来的自建名都合法）
    sceneDir(dshHome, name)
    return {
      command: nodeExec,
      args: [launcher().bin, '--profile', name, ...webSceneArgs()],
      cwd: workspaceRoot,
      env: sceneEnv({ base: baseEnv, dshHome }),
    }
  }

  const start = (name: string): Running => {
    const spec = launchSpec(name)
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(spec.cwd, { recursive: true })
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const stderrTail: string[] = []
    let resolveReady: (url: string) => void = () => undefined
    let rejectReady: (err: Error) => void = () => undefined
    const ready = new Promise<string>((res, rej) => {
      resolveReady = res
      rejectReady = rej
    })
    // 没人等的时候别让它变成 unhandled rejection
    ready.catch(() => undefined)
    const proc: Running = { child, state: 'starting', startedAt: now(), stopping: false, ready }
    running.set(name, proc)
    lastError.delete(name)
    log(`场景 ${name}：启动（pid ${String(child.pid ?? '?')}）`)

    const timer = setTimeout(() => {
      if (proc.state !== 'starting') return
      fail(`没在 ${Math.round(startTimeoutMs / 1000)} 秒内起来`)
      child.kill('SIGKILL')
    }, startTimeoutMs)
    timer.unref?.()

    const fail = (reason: string): void => {
      proc.state = 'failed'
      lastError.set(name, reason)
      rejectReady(new ApiError('provider_unavailable', `场景「${name}」没起来：${reason}`))
    }

    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let nl = buffer.indexOf('\n')
      while (nl >= 0) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        const url = proc.state === 'starting' ? parseWebSceneUrl(line) : undefined
        if (url !== undefined) {
          proc.url = url
          const port = portOfUrl(url)
          if (port !== undefined) proc.port = port
          proc.state = 'running'
          clearTimeout(timer)
          log(`场景 ${name}：已就绪 ${redactSceneUrl(url)}`)
          resolveReady(url)
        }
        nl = buffer.indexOf('\n')
      }
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        stderrTail.push(redactSceneUrl(trimmed).slice(0, 300))
        if (stderrTail.length > 20) stderrTail.shift()
      }
    })
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      clearTimeout(timer)
      if (running.get(name) === proc) running.delete(name)
      const how = signal === null ? `代码 ${String(code)}` : `信号 ${signal}`
      if (proc.stopping) {
        log(`场景 ${name}：已关闭（${how}）`)
        rejectReady(new ApiError('conflict', `场景「${name}」已经关了`))
        return
      }
      const tail = stderrTail.at(-1)
      if (proc.state === 'starting') fail(tail ?? `进程退出了（${how}）`)
      else if (proc.state === 'running')
        lastError.set(name, `意外退出了（${how}）${tail === undefined ? '' : `：${tail}`}`)
      log(`场景 ${name}：退出（${how}）`)
    }
    child.on('exit', onExit)
    child.on('error', (err) => {
      clearTimeout(timer)
      if (running.get(name) === proc) running.delete(name)
      fail(`起不来：${err.message}`)
    })
    return proc
  }

  const stopProc = async (name: string): Promise<void> => {
    const proc = running.get(name)
    if (proc === undefined) return
    proc.stopping = true
    const exited = new Promise<void>((res) => {
      if (proc.child.exitCode !== null || proc.child.signalCode !== null) res()
      else proc.child.once('exit', () => res())
    })
    proc.child.kill('SIGTERM')
    const timeout = new Promise<'timeout'>((res) => {
      setTimeout(() => res('timeout'), stopTimeoutMs).unref?.()
    })
    if ((await Promise.race([exited, timeout])) === 'timeout') {
      proc.child.kill('SIGKILL')
      await exited
    }
    running.delete(name)
    lastError.delete(name)
  }

  const openable = (name: string): DshSceneView => {
    if (name === AGENTSWS_SCENE)
      throw new ApiError('invalid_input', 'Agents 工坊就是这个工作台，不用另外打开')
    const scene = find(name)
    if (scene.surface !== 'web')
      throw new ApiError(
        'invalid_input',
        `「${name}」是给命令行 / 程序用的场景，没有网页界面，这里打不开`,
      )
    return scene
  }

  const open = async (name: string): Promise<DshSceneOpenResult> => {
    openable(name)
    const proc = running.get(name) ?? start(name)
    const url = proc.url ?? (await proc.ready)
    return { scene: find(name), url }
  }

  return {
    dshHome,
    workspaceRoot,
    launchSpec,
    list() {
      let version: string | undefined
      try {
        version = launcher().version
      } catch {
        version = undefined
      }
      return {
        available: true,
        ...(version === undefined ? {} : { dsh_version: version }),
        dsh_home: dshHome,
        workspace_root: workspaceRoot,
        scenes: scenes(),
        templates: DSH_SCENE_TEMPLATES.map((t) => ({ name: t.name, surface: t.surface })),
      }
    },
    async create({ name, template }) {
      const problem = sceneNameProblem(name)
      if (problem !== undefined) throw new ApiError('invalid_input', problem)
      if (sceneTemplate(template) === undefined)
        throw new ApiError('invalid_input', `没有这个官方模板：${template}`)
      const dir = sceneDir(dshHome, name)
      if (existsSync(dir)) throw new ApiError('conflict', `已经有一个叫「${name}」的场景了`)
      mkdirSync(dshHome, { recursive: true })
      mkdirSync(workspaceRoot, { recursive: true })
      // 只建不起：`--from-default-profile` 配一个配置导出，dsh 建好目录、打印组合、退出
      try {
        await execFileAsync(
          nodeExec,
          [
            launcher().bin,
            '--profile',
            name,
            '--from-default-profile',
            template,
            '--dump-default-config',
          ],
          {
            cwd: workspaceRoot,
            env: sceneEnv({ base: baseEnv, dshHome }),
            timeout: 60_000,
            maxBuffer: 16 * 1024 * 1024,
            windowsHide: true,
          },
        )
      } catch (err) {
        const detail =
          err instanceof Error ? err.message.split('\n').find((l) => l.includes('dsh:')) : undefined
        throw new ApiError(
          'provider_unavailable',
          `建不了这个场景${detail === undefined ? '' : `：${detail.trim()}`}`,
        )
      }
      if (!existsSync(join(dir, 'package.json')))
        throw new ApiError('provider_unavailable', 'dsh 没有把这个场景建出来')
      log(`场景 ${name}：已从模板 ${template} 新建`)
      return find(name)
    },
    async remove(name, confirm) {
      if (confirm !== name) throw new ApiError('invalid_input', '要删的话，请再输入一遍场景名确认')
      const scene = find(name)
      if (!scene.deletable)
        throw new ApiError(
          'forbidden',
          scene.origin === 'agentsws' ? 'Agents 工坊不能删' : '官方场景不能删，只能删你自己建的',
        )
      await stopProc(name)
      const dir = sceneDir(dshHome, name)
      // 目录本身是个链接就只拆链接，不顺着删到别处去
      if (lstatSync(dir).isSymbolicLink()) rmSync(dir, { force: true })
      else rmSync(dir, { recursive: true, force: true })
      lastError.delete(name)
      log(`场景 ${name}：已删除`)
      return { deleted: true }
    },
    open,
    async stop(name) {
      if (name === AGENTSWS_SCENE)
        throw new ApiError('invalid_input', 'Agents 工坊就是这个工作台，关它请退出应用')
      find(name)
      await stopProc(name)
      return find(name)
    },
    async restart(name) {
      openable(name)
      await stopProc(name)
      return open(name)
    },
    async close() {
      await Promise.all([...running.keys()].map((name) => stopProc(name)))
    },
  }
}

/** 这个部署不能切场景时 `list` 回的那一份（其余路由回 `not_implemented`）。 */
export function unavailableScenes(reason: string): DshScenesView {
  return { available: false, unavailable_reason: reason, scenes: [], templates: [] }
}
