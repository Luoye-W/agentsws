/**
 * WP463（docs/111 §3，决策 1471–1477）：**这台机器上 ego 装没装、能不能跑**。
 *
 * ego（lite.ego.app）是用户自己装的浏览器；我们不打包、不分发、不代下载，只负责找到它的命令行
 * `ego-browser`，确认跑得通，再把路径交给运行时（`RunBrowser{mode:'ego'}`）。
 *
 * **找的顺序**：设置里存过的路径 → PATH → 常见安装位置。10-22 两台机器实测（ego 0.6.0.16 /
 * 运行时 v2.1.0）：
 *
 * | 平台 | 位置 |
 * |---|---|
 * | Mac | `~/.local/bin/ego-browser`（指向 `~/.local/share/ego/active_version_dir/Helpers/ego-browser`）；应用在 `/Applications/ego lite.app` |
 * | Windows | `%USERPROFILE%\.local\share\ego\active_version_dir\ego-browser.exe`；`active_version_dir` 是目录联接，指向 `C:\Program Files\Citro Labs\ego lite\Application\<版本号>\` |
 *
 * 两条硬规矩：
 * - **不能只靠 PATH**：ego 的首次引导只把目录加进**用户级 PATH**，早就在跑的进程（我们的服务
 *   进程正是）看不到——Windows 远程实测 `Get-Command ego-browser` 找不到，按上面的路径直接跑正常。
 * - **每次按联接取，不缓存版本目录**：升级后联接指向会变；这里只记经联接的那条路径，
 *   从不 `realpath` 成版本目录。
 *
 * **「能用」**= 跑 `ego-browser skill` 退出码 0、首行形如
 * `[ego-browser:skill] ego-browser usage guide v<版本>`（判法与运行时同一份：`egoSkillVerdict`）。
 * 这里只跑 `skill` 这一条只读命令：不调 `upgrade`、不读 ego 的 Profile / cookie、不改它的设置。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { EGO_SKILL_TIMEOUT_MS, egoSkillVerdict } from '@agentsws/dsh-adapter'

/** 一次探测的结果。 */
export interface EgoDetection {
  ok: boolean
  /** 能跑的那一个（`ok`）；不能跑时是找到了但跑不通的第一个。 */
  path?: string
  version?: string
  /** 没装 / 跑不起来时说给人听的那一句。 */
  detail?: string
}

/** 跑一次 `ego-browser skill` 的进程结果（测试注入假的）。 */
export interface EgoSkillRun {
  exit_code: number | null
  stdout: string
  stderr: string
  timed_out?: boolean
  spawn_error?: string
}

export interface EgoDetectOptions {
  /** 设置里存过的路径（用户手动指过才有）。 */
  savedPath?: string
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  /** 用户目录（缺省 `os.homedir()`；Windows 优先看 `USERPROFILE`）。 */
  homedir?: string
  /** 这个文件在不在（测试注入；缺省 `existsSync` + 是文件）。 */
  exists?(path: string): boolean
  /** 跑一次 `skill`（测试注入；缺省同步 spawn，不经 shell）。 */
  runSkill?(path: string): EgoSkillRun
}

/** 缺省的 `skill` 跑法：同步、不经 shell、有超时（实测 0.4 秒）。 */
export function runEgoSkillSync(path: string): EgoSkillRun {
  const res = spawnSync(path, ['skill'], {
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: EGO_SKILL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  })
  const code = (res.error as NodeJS.ErrnoException | undefined)?.code
  return {
    exit_code: res.status,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    ...(code === 'ETIMEDOUT' ? { timed_out: true } : {}),
    ...(res.error !== undefined && code !== 'ETIMEDOUT' ? { spawn_error: res.error.message } : {}),
  }
}

function fileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

/** 按顺序列出要试的路径（去重）：存过的 → PATH → 常见安装位置。 */
export function egoCandidates(options: EgoDetectOptions = {}): string[] {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const exe = win ? 'ego-browser.exe' : 'ego-browser'
  const home = options.homedir ?? (win ? (env.USERPROFILE ?? osHomedir()) : osHomedir())
  const out: string[] = []
  const add = (path: string | undefined) => {
    if (path === undefined || path.trim() === '') return
    const v = path.trim()
    if (!out.includes(v)) out.push(v)
  }
  add(options.savedPath)
  const pathVar = (win ? (env.Path ?? env.PATH) : env.PATH) ?? ''
  for (const dir of pathVar.split(win ? ';' : ':')) {
    if (dir.trim() !== '') add(p.join(dir.trim(), exe))
  }
  if (win) {
    add(p.join(home, '.local', 'share', 'ego', 'active_version_dir', exe))
  } else {
    add(p.join(home, '.local', 'bin', exe))
    add(p.join(home, '.local', 'share', 'ego', 'active_version_dir', 'Helpers', exe))
  }
  return out
}

/** 探一次：挨个试，第一个 `skill` 跑得通的就是它。 */
export function detectEgoBrowser(options: EgoDetectOptions = {}): EgoDetection {
  const exists = options.exists ?? fileExists
  const run = options.runSkill ?? runEgoSkillSync
  let firstFailure: EgoDetection | undefined
  for (const path of egoCandidates(options)) {
    if (!exists(path)) continue
    const verdict = egoSkillVerdict(run(path))
    if (verdict.ok) return { ok: true, path, version: verdict.version }
    firstFailure ??= { ok: false, path, detail: verdict.detail }
  }
  return (
    firstFailure ?? {
      ok: false,
      detail: '这台电脑上没找到 ego（`ego-browser`）。装好 ego、完成首次引导后再来看看。',
    }
  )
}
