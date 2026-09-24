/**
 * 装电脑操控的驱动 `cua-driver`——**我们自己装，钉版本 + 校验 sha256**（docs/80 §6，WP144）。
 *
 * 做法照 WP92 的 `browserskill-install.ts`：
 *
 * | 上游的 `install.sh` / `install.ps1` 做的事 | 为什么我们不要 |
 * |---|---|
 * | 取最新版（或按频道） | 「最新」不是一个版本。我们钉在 `computer-use.lock.json` 那一版，跟着 dsh 文档引用的版本升（docs/42） |
 * | 装 `CuaDriver.app` 到 `/Applications`、链接到 `~/.local/bin` 并改 PATH | 不动系统目录、不改 shell 配置。解到数据目录（`AGENTSWS_DATA_DIR/computer-use/`），只有我们用 |
 * | 驱动自带 `update --apply` = 再跑一次上面那个脚本 | 两个开关（遥测 / 查更新）运行时一律关；门禁也拒 `check_for_update` |
 *
 * 另外两条：
 * - **不打进安装包**：用户在设置页打开「电脑操控」、点第 ① 步时才下；
 * - **装好了才挂**：设置页、`forRun()`、`dsh-adapter` 的 `cuaDriverUsable()` 三处都问这一句。
 */
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 一个平台的产物：下载地址、sha256（逐字抄自上游 checksums.txt）、包里可执行文件叫什么。 */
export interface CuaDriverAsset {
  url: string
  sha256: string
  binary: string
}

/** `computer-use.lock.json` 的形状（只列我们读的那几格）。 */
export interface ComputerUseLock {
  driver: {
    name: string
    version: string
    tag: string
    assets: Record<string, CuaDriverAsset>
  }
  providers: Record<string, string>
}

export class ComputerUseInstallError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_implemented' | 'provider_error',
    message: string,
  ) {
    super(message)
    this.name = 'ComputerUseInstallError'
  }
}

/** 这台机器对应 lock 里的哪一项。 */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os =
    platform === 'darwin'
      ? 'darwin'
      : platform === 'win32'
        ? 'windows'
        : platform === 'linux'
          ? 'linux'
          : undefined
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (os === undefined || cpu === undefined) return undefined
  return `${os}-${cpu}`
}

/** 仓库根的 `computer-use.lock.json`（从这个模块所在目录往上找，src / dist 层数不同）。 */
export function defaultLockPath(
  from: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = resolve(from)
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'computer-use.lock.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function readLock(path?: string): ComputerUseLock {
  const file = path ?? defaultLockPath()
  if (file === undefined) {
    throw new ComputerUseInstallError('not_implemented', '这个发行版里没有 computer-use.lock.json')
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ComputerUseLock
  if (typeof parsed.driver?.version !== 'string' || typeof parsed.driver.assets !== 'object') {
    throw new ComputerUseInstallError('invalid_input', `${file} 不是一份电脑操控驱动的钉版本表`)
  }
  return parsed
}

/** 驱动装在哪个目录：数据目录下按版本分（升版本 = 新目录，旧的不覆盖正在用的那一份）。 */
export function driverDirIn(dataDir: string, version: string): string {
  return join(dataDir, 'computer-use', `cua-driver-${version}`)
}

/** 驱动可执行文件的绝对路径。 */
export function driverPathIn(dataDir: string, lock: ComputerUseLock, key = platformKey()): string {
  const binary =
    (key === undefined ? undefined : lock.driver.assets[key]?.binary) ??
    (process.platform === 'win32' ? 'cua-driver.exe' : 'cua-driver')
  return join(driverDirIn(dataDir, lock.driver.version), binary)
}

/**
 * 传给驱动的参数。
 *
 * macOS 用 `mcp --direct`：上游说明「macOS 把辅助功能与屏幕录制记在**负责的那个应用**
 * 身上」；不加 `--direct` 时 `mcp` 会经 LaunchServices 去起 `/Applications/CuaDriver.app`
 * 的常驻进程（我们不装它、它也不随我们的运行退出）。`--direct` = 驱动进程自己跑、
 * 权限记在**启动它的那个应用**——也就是桌面版「Agents 工坊」——上，运行一结束它就退出。
 * Windows / Linux 上 `mcp` 本来就是直接跑（Windows 没有 TCC 那一套）。
 */
export function driverArgs(platform: NodeJS.Platform = process.platform): string[] {
  return platform === 'darwin' ? ['mcp', '--direct'] : ['mcp']
}

/** 一份下载内容的 sha256（小写十六进制）。 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface InstallInput {
  dataDir: string
  lock?: ComputerUseLock
  /** 下载用的 fetch（测试注入一台假 release 服务器）。 */
  fetchImpl?: typeof fetch
  tmpRoot?: string
  /** 测试用：假装是哪个平台。 */
  platformKey?: string
}

export interface InstallResult {
  path: string
  version: string
  sha256: string
}

/**
 * 下载 → **校验 sha256** → 解包 → 放到 `AGENTSWS_DATA_DIR/computer-use/cua-driver-<版本>/`。
 *
 * 校验不过 = 当场停，**不留下任何文件**。解包用系统自带的 `tar`（macOS / Windows 10+
 * 的 `tar` 都是 bsdtar，认 `.tar.gz` 也认 `.zip`），先解到临时目录、确认可执行文件在，
 * 再整目录挪过去——半截的包不会出现在驱动路径上。
 */
export async function installCuaDriver(input: InstallInput): Promise<InstallResult> {
  const lock = input.lock ?? readLock()
  const key = input.platformKey ?? platformKey()
  if (key === undefined) {
    throw new ComputerUseInstallError(
      'not_implemented',
      `这个平台没有官方产物（${process.platform}/${process.arch}）`,
    )
  }
  const asset = lock.driver.assets[key]
  if (asset === undefined) {
    throw new ComputerUseInstallError('not_implemented', `钉版本表里没有这个平台：${key}`)
  }
  const fetchImpl = input.fetchImpl ?? fetch
  const res = await fetchImpl(asset.url)
  if (!res.ok) {
    throw new ComputerUseInstallError('provider_error', `下载失败：HTTP ${res.status}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const actual = sha256Of(bytes)
  if (actual !== asset.sha256.toLowerCase()) {
    throw new ComputerUseInstallError(
      'provider_error',
      `校验不过：期望 ${asset.sha256.toLowerCase()}，实际 ${actual}。没有装任何东西。`,
    )
  }
  // 临时目录与目标在同一个盘上（默认就在数据目录里），最后那一下 rename 才不会跨盘失败
  const tmpRoot = input.tmpRoot ?? join(input.dataDir, 'computer-use')
  mkdirSync(tmpRoot, { recursive: true })
  const tmp = mkdtempSync(join(tmpRoot, '.install-'))
  try {
    const archive = join(tmp, asset.url.endsWith('.zip') ? 'driver.zip' : 'driver.tar.gz')
    writeFileSync(archive, bytes)
    const staged = join(tmp, 'x')
    mkdirSync(staged)
    try {
      await execFileAsync('tar', ['-xf', archive, '-C', staged])
    } catch (e) {
      throw new ComputerUseInstallError(
        'provider_error',
        `解包失败：${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (!existsSync(join(staged, asset.binary))) {
      throw new ComputerUseInstallError('provider_error', `包里没有 ${asset.binary} 这个文件`)
    }
    const target = driverDirIn(input.dataDir, lock.driver.version)
    mkdirSync(dirname(target), { recursive: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(staged, target)
    const path = join(target, asset.binary)
    chmodSync(path, 0o755)
    return { path, version: lock.driver.version, sha256: actual }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

// ── 设置页第 ③ 步：自检（驱动的 `check_permissions`，`prompt: false`）────────────

/** 系统设置里对应那一页（macOS）。只打开给人看，不替人点。 */
export const MAC_SETTINGS_URL = {
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  screen_recording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
} as const

/** 一条检查没过时「怎么修」那一句（我们补的；驱动原话照样列在 `detail` 里）。 */
function fixFor(name: string, platform: NodeJS.Platform): string | undefined {
  if (platform !== 'darwin') return undefined
  if (name === 'accessibility') {
    return '打开「系统设置 → 隐私与安全性 → 辅助功能」，把「Agents 工坊」打开（没有就点 + 加进去），然后重开 Agents 工坊。'
  }
  if (name === 'screen_recording') {
    return '打开「系统设置 → 隐私与安全性 → 录屏与系统录音」，把「Agents 工坊」打开，然后重开 Agents 工坊。'
  }
  return undefined
}

export interface PermissionCheckRow {
  name: string
  ok: boolean
  detail: string
  fix?: string
}

/**
 * 把 `check_permissions` 的结果翻成一行一条。**不替上游解释**：驱动报了哪几个布尔值
 * 就列哪几条（macOS 是 `accessibility` / `screen_recording`），原话放在 `detail` 里。
 */
export function permissionRows(
  structured: Record<string, unknown> | undefined,
  text: string,
  platform: NodeJS.Platform = process.platform,
): PermissionCheckRow[] {
  const rows: PermissionCheckRow[] = []
  const lines = text.split('\n').map((l) => l.trim())
  for (const [name, value] of Object.entries(structured ?? {})) {
    if (typeof value !== 'boolean') continue
    const label = name.replace(/_/gu, ' ')
    const line =
      lines.find((l) => l.toLowerCase().includes(label.toLowerCase())) ?? `${name}: ${value}`
    const fix = value ? undefined : fixFor(name, platform)
    rows.push({ name, ok: value, detail: line, ...(fix === undefined ? {} : { fix }) })
  }
  return rows
}

/** 自检时驱动的环境：遥测与查更新两个开关都关（与 `dsh-adapter` 挂提供方时同一份）。 */
export function selfCheckEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
    CUA_TELEMETRY_ENABLED: 'false',
    CUA_DRIVER_RS_UPDATE_CHECK: 'false',
  }
}

export interface SelfCheckInput {
  driverPath: string
  args?: string[]
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export interface SelfCheckOutcome {
  ok: boolean
  checks: PermissionCheckRow[]
  raw: string
  detail?: string
}

/**
 * 起一次驱动（`mcp`，macOS 带 `--direct`），走最小的 MCP 握手，调**一次**
 * `check_permissions {prompt: false}`，然后关掉。
 *
 * - `prompt: false`：只读 TCC 状态，**不弹系统授权框**（上游：`prompt` 缺省就是 false，
 *   显式 true 在任何模式下都会被拒）；
 * - 不截屏、不点、不发任何输入——这正是上游自己的「已装驱动兼容性测试」做的那一件事；
 * - 权限记在谁身上：macOS 的 `--direct` 下是**启动它的应用**（桌面版 Agents 工坊），
 *   所以这里报的就是 Agents 工坊有没有那两项权限。
 */
export async function runSelfCheck(input: SelfCheckInput): Promise<SelfCheckOutcome> {
  const platform = input.platform ?? process.platform
  const timeoutMs = input.timeoutMs ?? 20_000
  const child = spawn(input.driverPath, input.args ?? driverArgs(platform), {
    env: input.env ?? selfCheckEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (c: Buffer) => {
    if (stderr.length < 4000) stderr += c.toString('utf8')
  })
  const pending = new Map<number, (msg: Record<string, unknown>) => void>()
  let buf = ''
  child.stdout.on('data', (c: Buffer) => {
    buf += c.toString('utf8')
    let i = buf.indexOf('\n')
    while (i >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      i = buf.indexOf('\n')
      if (line === '') continue
      try {
        const msg = JSON.parse(line) as Record<string, unknown>
        if (typeof msg.id === 'number') pending.get(msg.id)?.(msg)
      } catch {
        // 不是 JSON 的行（驱动的横幅等）不理
      }
    }
  })
  const exited = new Promise<never>((_, reject) => {
    child.on('error', (e) => reject(e))
    child.on('exit', (code) =>
      reject(
        new Error(
          `驱动退出了（退出码 ${code ?? '?'}）${stderr === '' ? '' : `：${stderr.trim()}`}`,
        ),
      ),
    )
  })
  let nextId = 0
  const request = (method: string, params: Record<string, unknown>) =>
    new Promise<Record<string, unknown>>((resolveReq) => {
      nextId += 1
      pending.set(nextId, resolveReq)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`)
    })
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等了 ${timeoutMs / 1000} 秒驱动没回应`)), timeoutMs)
  })
  try {
    const flow = (async () => {
      const init = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agentsws-self-check', version: '1' },
      })
      if (init.error !== undefined) throw new Error(`握手失败：${JSON.stringify(init.error)}`)
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
      )
      return request('tools/call', { name: 'check_permissions', arguments: { prompt: false } })
    })()
    const reply = await Promise.race([flow, exited, timeout])
    if (reply.error !== undefined) {
      return { ok: false, checks: [], raw: JSON.stringify(reply.error), detail: '驱动拒绝了自检' }
    }
    const result = (reply.result ?? {}) as {
      content?: { type?: string; text?: string }[]
      structuredContent?: Record<string, unknown>
      isError?: boolean
    }
    const raw = (result.content ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
    const checks = permissionRows(result.structuredContent, raw, platform)
    const ok = result.isError !== true && checks.length > 0 && checks.every((c) => c.ok)
    return {
      ok,
      checks,
      raw,
      ...(ok ? {} : { detail: result.isError === true ? '驱动报错了' : '还有权限没给' }),
    }
  } catch (e) {
    return {
      ok: false,
      checks: [],
      raw: stderr,
      detail: e instanceof Error ? e.message : String(e),
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    exited.catch(() => undefined)
    child.stdin.end()
    if (child.exitCode === null) child.kill()
  }
}
