/**
 * 装 `bsk`（腾讯 BrowserSkill 的 CLI）——**我们自己装，钉版本 + 校验 sha256**（55 §10，WP92）。
 *
 * 为什么不用上游的 `install.sh`（它确实有一个，而且写得不错）：
 *
 * | 它做的事 | 为什么我们不要 |
 * |---|---|
 * | 取 `releases/latest` 的 version.json | 「最新」不是一个版本。我们钉在 `browserskill.lock.json` 那一版，升版本是一次人做的决定（上游哨兵盯那个文件） |
 * | 校验不了就**只警告**（没有 version.json / 没有 sha256 工具时跳过） | 校验不过就不装。这是供应链，不是下载器 |
 * | 装到 `$HOME/.local/bin` 并**改用户的 ~/.zshrc** | 不动用户的 shell 配置。我们装进自己的数据目录（`AGENTSWS_DATA_DIR/bin/bsk`），只有我们自己用得着 |
 * | 装完 `bsk --version` | 这一条留着（见 {@link bskVersion}） |
 *
 * 另外两条纪律：
 * - **两个更新开关都关**：`BSK_AUTO_UPDATE=off` 关"装"（「自己把自己换掉」绕开了我们钉的
 *   版本与 sha256），`BSK_UPDATE_MANIFEST_URL` 指到回环关"查"（实测：只设前一条时
 *   daemon 照样每 30 分钟去 GitHub 取一次 version.json）；
 * - 装在数据目录下、不进 PATH：PATH 上有 `bsk` 的话，有 shell 的职责就能直接
 *   `bsk evaluate` 在页面里跑脚本（55 §10 那一行），那条路由 shell 的命令 allowlist 管（WP89）。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { BrowserSkillCheck, BrowserSkillStatus } from '@agentsws/contracts'

const execFileAsync = promisify(execFile)

/** 一个平台的产物（url + sha256），逐字来自上游 release 的 version.json。 */
export interface BrowserSkillAsset {
  url: string
  sha256: string
}

/** `browserskill.lock.json` 的形状。 */
export interface BrowserSkillLock {
  cli: { version: string; tag: string; assets: Record<string, BrowserSkillAsset> }
  plugin: { name: string; version: string }
  extension: { chrome: string; edge: string }
}

export class BrowserSkillInstallError extends Error {
  constructor(
    readonly code: 'invalid_input' | 'not_implemented' | 'provider_error',
    message: string,
  ) {
    super(message)
    this.name = 'BrowserSkillInstallError'
  }
}

/** 这台机器对应 lock 里的哪一项（键与上游 version.json 同一套写法）。 */
export function platformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : undefined
  const cpu = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined
  if (platform === 'win32' && arch === 'x64') return 'windows-x64'
  if (os === undefined || cpu === undefined) return undefined
  return `${os}-${cpu}`
}

/**
 * 仓库根的 `browserskill.lock.json`。
 *
 * 从这个模块所在目录往上找（`src/` 与编译后的 `dist/` 都在仓库里，层数不同），
 * 找不到就回 `undefined`——发行版里没带这个文件时，"装 bsk"那一步会明说装不了，
 * 而不是去 registry 猜一个版本。
 */
export function defaultLockPath(
  from: string = dirname(fileURLToPath(import.meta.url)),
): string | undefined {
  let dir = resolve(from)
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'browserskill.lock.json')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

export function readLock(path?: string): BrowserSkillLock {
  const file = path ?? defaultLockPath()
  if (file === undefined) {
    throw new BrowserSkillInstallError('not_implemented', '这个发行版里没有 browserskill.lock.json')
  }
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as BrowserSkillLock
  if (typeof parsed.cli?.version !== 'string' || typeof parsed.cli.assets !== 'object') {
    throw new BrowserSkillInstallError('invalid_input', `${file} 不是一份 BrowserSkill 钉版本表`)
  }
  return parsed
}

/** `bsk` 装在哪：数据目录下的 `bin/bsk`（不进 PATH）。 */
export function bskPathIn(dataDir: string): string {
  return join(dataDir, 'bin', process.platform === 'win32' ? 'bsk.exe' : 'bsk')
}

export interface InstallInput {
  /** 数据目录（`AGENTSWS_DATA_DIR`）。 */
  dataDir: string
  /** 钉版本表；不给就读仓库根那一份。 */
  lock?: BrowserSkillLock
  /** 下载用的 fetch（测试注入一台假 release 服务器）。 */
  fetchImpl?: typeof fetch
  /** 解包目录；不给就用系统临时目录。 */
  tmpRoot?: string
}

export interface InstallResult {
  path: string
  version: string
  sha256: string
}

/** 一份下载内容的 sha256（小写十六进制）。 */
export function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 下载 → **校验 sha256** → 解包 → 装到 `AGENTSWS_DATA_DIR/bin/bsk`。
 *
 * 校验不过 = 当场停，不留下任何文件。这一条是这个模块存在的理由（上游的
 * `install.sh` 在拿不到校验和时会"跳过校验继续装"，我们不接受那一种）。
 */
export async function installBrowserSkillCli(input: InstallInput): Promise<InstallResult> {
  const lock = input.lock ?? readLock()
  const key = platformKey()
  if (key === undefined) {
    throw new BrowserSkillInstallError(
      'not_implemented',
      `这个平台没有官方产物（${process.platform}/${process.arch}）`,
    )
  }
  if (key === 'windows-x64') {
    // 上游 Windows 出的是 .zip；解 zip 要么拖一个依赖、要么调 PowerShell。
    // 先不做：Windows 用户按 `scripts/dev-browserskill.md` 手工装，设置页会说这一句。
    throw new BrowserSkillInstallError(
      'not_implemented',
      'Windows 暂时还不能一键装 bsk：请按官方说明手工装好，再在下面填 bsk 的路径',
    )
  }
  const asset = lock.cli.assets[key]
  if (asset === undefined) {
    throw new BrowserSkillInstallError('not_implemented', `钉版本表里没有这个平台：${key}`)
  }
  const fetchImpl = input.fetchImpl ?? fetch
  const res = await fetchImpl(asset.url)
  if (!res.ok) {
    throw new BrowserSkillInstallError('provider_error', `下载失败：HTTP ${res.status}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const actual = sha256Of(bytes)
  if (actual !== asset.sha256.toLowerCase()) {
    throw new BrowserSkillInstallError(
      'provider_error',
      `校验不过：期望 ${asset.sha256.toLowerCase()}，实际 ${actual}。没有装任何东西。`,
    )
  }
  const tmp = mkdtempSync(join(input.tmpRoot ?? tmpdir(), 'agentsws-bsk-'))
  const archive = join(tmp, 'bsk.tar.gz')
  writeFileSync(archive, bytes)
  try {
    await execFileAsync('tar', ['-xzf', archive, '-C', tmp])
  } catch (e) {
    throw new BrowserSkillInstallError(
      'provider_error',
      `解包失败：${e instanceof Error ? e.message : String(e)}`,
    )
  }
  const extracted = join(tmp, 'bsk')
  if (!existsSync(extracted)) {
    throw new BrowserSkillInstallError('provider_error', '包里没有 bsk 这个文件')
  }
  const target = bskPathIn(input.dataDir)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, readFileSync(extracted))
  chmodSync(target, 0o755)
  return { path: target, version: lock.cli.version, sha256: actual }
}

/**
 * daemon 的清单地址指到一个**没人监听的回环端口** = 查不到更新。
 *
 * 与 `dsh-adapter/src/browserskill.ts` 的 `BSK_NO_UPDATE_MANIFEST` 是同一条纪律
 * （这个包不依赖那个包，所以各写一份，改要一起改）。实测：`BSK_AUTO_UPDATE=off`
 * 只关掉"装"，daemon **照样**每 30 分钟去 GitHub 取一次 version.json。
 */
const NO_UPDATE_MANIFEST = 'http://127.0.0.1:1/agentsws-no-update-check.json'

/** 跑一次 `bsk` 子命令（两个更新开关永远带着：既不自己换版本，也不去查）。 */
async function runBsk(
  bskPath: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(bskPath, args, {
      timeout: timeoutMs,
      env: {
        ...process.env,
        BSK_AUTO_UPDATE: 'off',
        BSK_UPDATE_MANIFEST_URL: NO_UPDATE_MANIFEST,
      },
      maxBuffer: 4 * 1024 * 1024,
    })
    return { stdout, code: 0 }
  } catch (e) {
    const err = e as { stdout?: string; code?: number }
    // `bsk doctor` 有 fail 时退出码非 0，但 stdout 里那份 JSON 照样是我们要的
    return { stdout: err.stdout ?? '', code: typeof err.code === 'number' ? err.code : 1 }
  }
}

/** 装上的那一份自己报的版本（`bsk --version`）；报不出来就 `undefined`。 */
export async function bskVersion(bskPath: string, timeoutMs = 10_000): Promise<string | undefined> {
  const { stdout } = await runBsk(bskPath, ['--version'], timeoutMs)
  const text = stdout.trim()
  if (text === '') return undefined
  // 上游是 `bsk 0.3.0` 这样一行
  return text.split(/\s+/u).pop()
}

function toChecks(value: unknown): BrowserSkillCheck[] {
  if (!Array.isArray(value)) return []
  const out: BrowserSkillCheck[] = []
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue
    const r = raw as Record<string, unknown>
    const status = r.status
    out.push({
      name: typeof r.name === 'string' ? r.name : '?',
      ok: r.ok !== false,
      status:
        status === 'fail' || status === 'warn' || status === 'na' || status === 'ok'
          ? status
          : r.ok === false
            ? 'fail'
            : 'ok',
      detail: typeof r.detail === 'string' ? r.detail : '',
      ...(typeof r.hint === 'string' ? { hint: r.hint } : {}),
    })
  }
  return out
}

export interface DoctorInput {
  /** `bsk` 在哪。 */
  bskPath: string
  /** 钉版本表里那一版（对不上就该重装）。 */
  pinnedVersion?: string
  /** 这一档允不允许用 BrowserSkill（非个人档不允许）。 */
  allowed?: boolean
  timeoutMs?: number
}

/**
 * 设置页第 ③ 步：跑一次 `bsk doctor --json`，把它那几条检查原样端出去。
 *
 * **不替上游解释**：daemon 起没起、扩展连没连、版本配不配，都是它自己那几条
 * `CheckResult`（含 `hint`——上游写的"怎么修"比我们编的准）。我们只加两件它不知道的事：
 * 这一档允不允许用（`allowed`），以及我们钉的版本是哪一版。
 */
export async function browserSkillDoctor(input: DoctorInput): Promise<BrowserSkillStatus> {
  const installed = existsSync(input.bskPath)
  const base: BrowserSkillStatus = {
    installed,
    checks: [],
    ok: false,
    ...(installed ? { bsk_path: input.bskPath } : {}),
    ...(input.pinnedVersion === undefined ? {} : { pinned_version: input.pinnedVersion }),
  }
  if (input.allowed === false) {
    return {
      ...base,
      detail:
        '这台服务不在你自己的电脑上（Docker / 托管档）：bsk 与浏览器扩展都在你那台电脑上，连不过来。',
    }
  }
  if (!installed) {
    return { ...base, detail: '还没装 bsk（设置页第 ② 步）' }
  }
  const version = await bskVersion(input.bskPath, input.timeoutMs ?? 10_000)
  const { stdout } = await runBsk(input.bskPath, ['doctor', '--json'], input.timeoutMs ?? 30_000)
  let checks: BrowserSkillCheck[] = []
  try {
    const parsed: unknown = JSON.parse(stdout)
    checks = toChecks(Array.isArray(parsed) ? parsed : (parsed as { checks?: unknown })?.checks)
  } catch {
    return {
      ...base,
      ...(version === undefined ? {} : { version }),
      detail: 'bsk doctor 没给出能看懂的结果（试试在终端里跑一次 `bsk doctor`）',
    }
  }
  const ok = checks.length > 0 && !checks.some((c) => c.status === 'fail')
  return {
    ...base,
    ...(version === undefined ? {} : { version }),
    checks,
    ok,
    ...(ok ? {} : { detail: checks.find((c) => c.status === 'fail')?.detail ?? '还有检查没通过' }),
  }
}
