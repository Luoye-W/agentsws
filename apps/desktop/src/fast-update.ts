/**
 * WP327（决策 630 / 730）：Windows「旧版关掉 → 新版打开」的空窗缩到秒级。
 *
 * 安装目录（`build/installer.nsh` 摆的）：
 *
 * ```
 * <根>\current\        目录联接 → 下面某一版（快捷方式、开机启动、卸载登记都指它）
 * <根>\app-<版本>\     一版一整套
 * ```
 *
 * 一次更新：
 * 1. **后台准备**（旧版照常用）：electron-updater 照旧下载安装包、校验 sha512；下完用安装包的「只摆不装」
 *    （`/S --agentsws-stage /D=<根>`，低优先级）解到 `<根>\app-<新版>\`，再用新版自带的 Node 把服务入口
 *    import 一遍——都过了才显示「重启并更新」。
 * 2. **点「重启并更新」**：「正在更新」小窗 → 停服务进程 → 藏起窗口与托盘、放开单实例锁 → 把 `current`
 *    改指新版 → 起新版 → 旧版在后台等新版报「起来了」（最多 60 秒）→ 旧版退出。
 * 3. **回滚**：60 秒内新版没报起来（或它自己退了）→ 结束新版、`current` 改回旧版、记一笔、重开旧版。
 * 4. **清理**：新版起来几分钟后低优先级删掉更早的版本目录，只留当前与上一版。
 *
 * 平铺布局（老安装、或这个盘建不了联接）→ 走老路（安装程序静默装）。本文件不 import electron，
 * 文件系统、起进程都注入，切换 / 回滚 / 清理的每条路都在 vitest 里用替身跑。
 */
import { basename, dirname, join } from 'node:path'
import { compareVersions } from './updater.js'

/** 安装包「只摆不装」的开关（`build/installer.nsh` 认它）。 */
export const STAGE_FLAG = '--agentsws-stage'
/** 摆好的版本目录里，安装包写的那一个记号（内容是版本号）。 */
export const STAGED_MARKER = '.agentsws-staged'
/** 根上的联接名。 */
export const CURRENT_LINK = 'current'
/** 根上记「当前 / 上一版」的小文件。 */
export const LAYOUT_FILE = 'layout.json'
/** 安装器写的「卸载登记在哪」（第一行 HKCU / HKLM，第二行键）。 */
export const INSTALL_INFO_FILE = 'agentsws-install.txt'
/** 用户数据目录里：一次切换的记录（旧版写，新版起来后改成 healthy）。 */
export const SWITCH_FILE = 'update-switch.json'
/** 用户数据目录里：回滚记录（重开的旧版读它说一声）。 */
export const ROLLBACK_FILE = 'update-rollback.json'
/** 用户数据目录里：回滚演练（只有 CI 会放；新版看到写着自己的版本就假装起不来）。 */
export const DRILL_FILE = 'update-drill.json'
/** 新版要在多久内报「起来了」。 */
export const HEALTHY_TIMEOUT_MS = 60_000

export const appDirName = (version: string): string => `app-${version}`

/** 布局要的那点文件系统（真的那份在 main.ts 里包 node:fs）。 */
export interface LayoutFs {
  exists(path: string): boolean
  /** 是不是目录联接 / 符号链接。 */
  isLink(path: string): boolean
  /** 联接指向的真实目录（读不到回 undefined）。 */
  target(path: string): string | undefined
  readText(path: string): string | undefined
  writeText(path: string, text: string): void
  remove(path: string): void
  list(dir: string): string[]
  /** 删联接（不碰它指向的目录）。 */
  unlink(path: string): void
  /** 建目录联接 `link` → `target`。 */
  link(target: string, link: string): void
}

export interface VersionedLayout {
  /** 安装根目录。 */
  root: string
  /** `<根>\current`。 */
  current: string
  /** `current` 现在指向的版本目录。 */
  currentDir: string
}

/**
 * 正在跑的这一份是不是装在版本目录布局里：exe 在 `<根>\current\` 或 `<根>\app-*\` 下，
 * 且 `<根>\current` 是个联接。不是就回 undefined（平铺 → 老路）。
 */
export function detectLayout(execPath: string, fs: LayoutFs): VersionedLayout | undefined {
  const exeDir = dirname(execPath)
  const name = basename(exeDir)
  if (name.toLowerCase() !== CURRENT_LINK && !/^app-/i.test(name)) return undefined
  const root = dirname(exeDir)
  const current = join(root, CURRENT_LINK)
  if (!fs.exists(current) || !fs.isLink(current)) return undefined
  const currentDir = fs.target(current)
  if (currentDir === undefined) return undefined
  return { root, current, currentDir }
}

/** 安装包「只摆不装」的参数（`/D=` 必须最后、不带引号——起的时候要 windowsVerbatimArguments）。 */
export function stageArgs(root: string): string[] {
  return ['/S', STAGE_FLAG, `/D=${root}`]
}

/** 摆好了没有：exe、记号（版本对得上）、`resources\app\package.json` 的版本。不好回原因。 */
export function stagedProblem(
  root: string,
  version: string,
  fs: Pick<LayoutFs, 'exists' | 'readText'>,
  exeName = 'agentsws.exe',
): string | undefined {
  const dir = join(root, appDirName(version))
  if (!fs.exists(join(dir, exeName))) return `${dir} 里没有 ${exeName}`
  const marker = fs.readText(join(dir, STAGED_MARKER))?.trim()
  if (marker !== version) return `摆好的记号是 ${marker ?? '（没有）'}，应是 ${version}`
  try {
    const pkg = JSON.parse(fs.readText(join(dir, 'resources', 'app', 'package.json')) ?? '{}') as {
      version?: string
    }
    if (pkg.version !== version) return `摆好的那一版是 ${String(pkg.version)}，应是 ${version}`
  } catch {
    return '摆好的那一版读不到 package.json'
  }
  return undefined
}

export interface LayoutRecord {
  current: string
  previous?: string
}

export function readLayoutRecord(root: string, fs: LayoutFs): LayoutRecord | undefined {
  try {
    const raw = JSON.parse(fs.readText(join(root, LAYOUT_FILE)) ?? '') as Partial<LayoutRecord>
    return typeof raw.current === 'string'
      ? {
          current: raw.current,
          ...(typeof raw.previous === 'string' ? { previous: raw.previous } : {}),
        }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 把 `current` 改指 `targetDir`（删联接 + 建联接；普通用户权限、毫秒级）。建不出来就把原来那个指回去再抛。
 * 记下「当前 / 上一版」（目录名）。
 */
export function switchCurrent(layout: VersionedLayout, targetDir: string, fs: LayoutFs): void {
  const before = fs.target(layout.current)
  fs.unlink(layout.current)
  try {
    fs.link(targetDir, layout.current)
  } catch (err) {
    if (before !== undefined) fs.link(before, layout.current)
    throw err
  }
  const record: LayoutRecord = {
    current: basename(targetDir),
    ...(before === undefined ? {} : { previous: basename(before) }),
  }
  fs.writeText(join(layout.root, LAYOUT_FILE), `${JSON.stringify(record)}\n`)
}

/**
 * 该删哪些版本目录：比当前旧的 `app-*` 里，除了「上一版」（layout.json 记的；没记就是比当前旧的里面最新的一版）
 * 都删。`staging`（正在准备 / 已准备好一版新的）为假时，比当前新的（回滚剩下的）与没摆完的 `app-*.part` 也删；
 * 为真时它们不动（可能正是摆好等着切的那一版）。
 */
export function cleanupPlan(
  entries: readonly string[],
  currentName: string,
  record?: LayoutRecord,
  { staging = false }: { staging?: boolean } = {},
): string[] {
  const versionOf = (n: string): string => n.replace(/^app-/i, '')
  const apps = entries.filter(
    (n) => /^app-/i.test(n) && n.toLowerCase() !== currentName.toLowerCase(),
  )
  const parts = apps.filter((n) => n.endsWith('.part'))
  const older = apps
    .filter((n) => !n.endsWith('.part'))
    .filter((n) => compareVersions(versionOf(n), versionOf(currentName)) < 0)
    .sort((a, b) => compareVersions(versionOf(b), versionOf(a)))
  const newer = apps
    .filter((n) => !n.endsWith('.part'))
    .filter((n) => compareVersions(versionOf(n), versionOf(currentName)) > 0)
  const previous =
    record?.previous !== undefined && older.includes(record.previous) ? record.previous : older[0]
  return [...older.filter((n) => n !== previous), ...(staging ? [] : [...newer, ...parts])]
}

// ── 后台准备 ──────────────────────────────────────────────────────────────

export interface StageDeps {
  layout: VersionedLayout
  fs: Pick<LayoutFs, 'exists' | 'readText' | 'remove'>
  version: string
  /** electron-updater 下好、校验过的安装包。 */
  installer: string
  exeName?: string
  /** 起安装包（低优先级），等它退出；回退出码。 */
  run: (command: string, args: readonly string[]) => Promise<number | null>
  /** 用新版自带的 Node 把服务入口 import 一遍；回问题（没问题回 undefined）。 */
  smoke: (dir: string) => Promise<string | undefined>
  log: (message: string, fields?: Record<string, unknown>) => void
}

/** 旧版开着时把新版摆到 `<根>\app-<新版>\` 并冒烟。回 undefined = 准备好了；否则回原因（调用方退回老路）。 */
export async function stageUpdate(d: StageDeps): Promise<string | undefined> {
  const dir = join(d.layout.root, appDirName(d.version))
  if (basename(d.layout.currentDir).toLowerCase() === appDirName(d.version).toLowerCase())
    return '要装的这一版就是正在跑的这一版'
  if (stagedProblem(d.layout.root, d.version, d.fs, d.exeName) !== undefined) {
    const t0 = Date.now()
    const code = await d.run(d.installer, stageArgs(d.layout.root))
    d.log('新版解到旁边的目录', { version: d.version, code: code ?? 'none', ms: Date.now() - t0 })
    if (code !== 0) return `安装包「只摆不装」退出码 ${String(code)}`
    const problem = stagedProblem(d.layout.root, d.version, d.fs, d.exeName)
    if (problem !== undefined) return problem
  }
  const smoke = await d.smoke(dir)
  if (smoke !== undefined) return `新版冒烟没过：${smoke}`
  return undefined
}

// ── 切换记录（旧版写、新版确认）───────────────────────────────────────────

export interface SwitchRecord {
  token: string
  from: string
  to: string
  fromDir: string
  toDir: string
  started_at: string
  state: 'switching' | 'healthy'
  healthy_at?: string
}

export function readSwitch(file: string, fs: Pick<LayoutFs, 'readText'>): SwitchRecord | undefined {
  try {
    const raw = JSON.parse(fs.readText(file) ?? '') as Partial<SwitchRecord>
    return typeof raw.token === 'string' && typeof raw.to === 'string'
      ? (raw as SwitchRecord)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * 新版这一侧：服务进程健康之后调一次。这次切换是冲着我来的、还在等 → 写成 healthy（旧版看到就退）。
 * 回是否写了。
 */
export function confirmSwitch(input: {
  file: string
  version: string
  now: () => Date
  fs: Pick<LayoutFs, 'readText' | 'writeText'>
}): boolean {
  const rec = readSwitch(input.file, input.fs)
  if (rec === undefined || rec.to !== input.version || rec.state !== 'switching') return false
  const next: SwitchRecord = { ...rec, state: 'healthy', healthy_at: input.now().toISOString() }
  input.fs.writeText(input.file, `${JSON.stringify(next)}\n`)
  return true
}

/** 回滚演练：用户数据目录里放着、写的是我这一版 → 删掉它、回 true（这一次假装起不来）。 */
export function consumeDrill(input: {
  file: string
  version: string
  fs: Pick<LayoutFs, 'readText' | 'remove'>
}): boolean {
  try {
    const raw = JSON.parse(input.fs.readText(input.file) ?? '') as { break?: unknown }
    if (raw.break !== input.version) return false
    input.fs.remove(input.file)
    return true
  } catch {
    return false
  }
}

// ── 旧版这一侧：切过去、等、不行就切回来 ─────────────────────────────────────

export interface SpawnedApp {
  pid: number | undefined
  /** 进程退了（带退出码）。 */
  exited: Promise<number | null>
}

export interface FastSwitchDeps {
  layout: VersionedLayout
  fs: LayoutFs
  userData: string
  from: string
  to: string
  exeName: string
  token: string
  now: () => Date
  sleep: (ms: number) => Promise<void>
  /** 停服务进程、藏窗口与托盘、放开单实例锁（做完才切）。 */
  quiesce: () => Promise<void>
  /** 起 `<exe>`（脱离，不跟着我们退）。 */
  launch: (exe: string, args: readonly string[]) => SpawnedApp
  /** 按进程树结束。 */
  killTree: (pid: number) => void
  /** 新版的服务报的版本（问不到回 undefined）：新版改了「起来了」的写法时的兜底认法。 */
  probeVersion?: () => Promise<string | undefined>
  log: (message: string, fields?: Record<string, unknown>) => void
  timeoutMs?: number
}

export type FastSwitchOutcome =
  | { ok: true; seconds: number }
  | { ok: false; reason: 'timeout' | 'exited' | 'switch'; detail: string }

/**
 * 一次「只切换」的更新。成功 → 调用方退出；失败 → 已经切回旧版、重开了旧版、记了一笔，调用方同样退出
 * （重开的旧版会接着跑）。切换本身就失败（联接建不出来）→ 什么都没动，调用方可以退回老路。
 */
export async function runFastSwitch(d: FastSwitchDeps): Promise<FastSwitchOutcome> {
  const started = d.now().getTime()
  const fromDir = d.layout.currentDir
  const toDir = join(d.layout.root, appDirName(d.to))
  const switchFile = join(d.userData, SWITCH_FILE)
  const record: SwitchRecord = {
    token: d.token,
    from: d.from,
    to: d.to,
    fromDir,
    toDir,
    started_at: d.now().toISOString(),
    state: 'switching',
  }
  await d.quiesce()
  d.fs.writeText(switchFile, `${JSON.stringify(record)}\n`)
  try {
    switchCurrent(d.layout, toDir, d.fs)
  } catch (err) {
    d.log('切换版本目录失败（没动）', { error: String(err) })
    return { ok: false, reason: 'switch', detail: String(err) }
  }
  d.log('已切到新版本目录，起新版', { to: d.to, dir: toDir })
  const exe = join(d.layout.current, d.exeName)
  const child = d.launch(exe, ['--updated'])
  let exitCode: number | null | undefined
  void child.exited.then((code) => {
    exitCode = code
  })
  const timeout = d.timeoutMs ?? HEALTHY_TIMEOUT_MS
  let failure: { reason: 'timeout' | 'exited'; detail: string } | undefined
  for (;;) {
    const rec = readSwitch(switchFile, d.fs)
    if (rec?.token === d.token && rec.state === 'healthy') break
    if (d.probeVersion !== undefined && (await d.probeVersion()) === d.to) break
    // 还没报起来就退了（不论退出码）：没起来
    if (exitCode !== undefined) {
      failure = { reason: 'exited', detail: `新版退出码 ${String(exitCode)}` }
      break
    }
    if (d.now().getTime() - started > timeout) {
      failure = { reason: 'timeout', detail: `${Math.round(timeout / 1000)} 秒内新版没报起来` }
      break
    }
    await d.sleep(500)
  }
  const seconds = Math.round((d.now().getTime() - started) / 1000)
  if (failure === undefined) {
    d.log('新版起来了', { to: d.to, seconds })
    return { ok: true, seconds }
  }
  d.log('新版没起来，回滚到旧版', { to: d.to, ...failure })
  if (child.pid !== undefined) {
    try {
      d.killTree(child.pid)
    } catch (err) {
      d.log('结束新版失败', { error: String(err) })
    }
  }
  try {
    switchCurrent(d.layout, fromDir, d.fs)
  } catch (err) {
    d.log('切回旧版本目录失败', { error: String(err) })
  }
  d.fs.writeText(
    join(d.userData, ROLLBACK_FILE),
    `${JSON.stringify({ from: d.from, to: d.to, reason: failure.reason, detail: failure.detail, at: d.now().toISOString() })}\n`,
  )
  d.launch(exe, ['--agentsws-rolled-back'])
  return { ok: false, ...failure }
}

/** 重开的旧版：有回滚记录就读出来（并删掉，只说一次）。 */
export function takeRollback(input: {
  userData: string
  fs: Pick<LayoutFs, 'readText' | 'remove'>
}): { from: string; to: string; reason: string } | undefined {
  const file = join(input.userData, ROLLBACK_FILE)
  try {
    const raw = JSON.parse(input.fs.readText(file) ?? '') as {
      from?: unknown
      to?: unknown
      reason?: unknown
    }
    input.fs.remove(file)
    if (typeof raw.from !== 'string' || typeof raw.to !== 'string') return undefined
    return { from: raw.from, to: raw.to, reason: String(raw.reason ?? '') }
  } catch {
    return undefined
  }
}

/** 安装器写的卸载登记位置 → `reg add` 的键（HKCU\…）。读不到回 undefined。 */
export function uninstallKeyOf(text: string | undefined): string | undefined {
  const [hive, key] = (text ?? '').split(/\r?\n/).map((s) => s.trim())
  if ((hive !== 'HKCU' && hive !== 'HKLM') || key === undefined || key === '') return undefined
  if (!/^Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\[^"\r\n]+$/i.test(key))
    return undefined
  return `${hive}\\${key}`
}
