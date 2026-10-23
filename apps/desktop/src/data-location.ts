/**
 * WP480（Luoye 10-23）：工坊数据放在哪——用户自己选一个文件夹，壳把数据搬过去。
 *
 * 这一个文件只管「位置」这件事本身：
 *
 * 1. **指针文件**（`<userData>/data-location.json`）。只记一个目录，很小，**不在数据目录里**——
 *    数据目录搬走了，指针还在原地；指针坏了 / 没有，就是默认位置 `<userData>/data`。
 * 2. **选的那个文件夹能不能用**：可写、剩余空间够（数据大小 × 1.2）、不是现在数据目录里面、
 *    不在应用自己的目录里、不是系统目录；网盘同步盘、网络盘照样能选，但要先说清风险。
 * 3. **搬走后的旧目录**：改名留 7 天，到期下次启动清掉（界面上也能「现在就删」）。
 *    删之前核对目录里我们自己放的那张小纸条——没有纸条的目录一律不删。
 *
 * 真正的复制 / 校验 / 停服务起服务在 `data-move.ts`；会碰子进程的探测（是不是网络盘）在
 * `data-location-probe.ts`。这里只用 `node:fs`，测试一律给临时目录。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep, win32 } from 'node:path'

/** 指针文件名（在 `userData` 下）。 */
export const DATA_LOCATION_FILE = 'data-location.json'
/** 搬家进行中的那张单子（在 `userData` 下）：崩了 / 断电后下次启动按它收拾。 */
export const DATA_MOVE_JOURNAL = 'data-move.json'
/** 搬走后的旧目录里放的那张纸条：只有带这张纸条的目录才会被自动删。 */
export const RETIRED_MARK = '.agentsws-retired.json'
/** 选的文件夹里已经有别的东西时，数据放进这个子文件夹。 */
export const DATA_SUBDIR = 'agentsws-data'
/** 旧目录留几天。 */
export const RETIRE_DAYS = 7
/** 剩余空间至少是数据大小的几倍。 */
export const SPACE_FACTOR = 1.2

export interface RetiredDir {
  /** 改名之后的旧目录（改名没成就是原路径）。 */
  path: string
  /** 搬之前它叫什么（界面上说「原来在哪」）。 */
  from: string
  /** 到这个时间之后，下次启动删掉。 */
  until: string
}

export interface DataLocationPointer {
  version: 1
  /** 自定义位置；没有 = 默认位置。 */
  dir?: string
  set_at?: string
  retired: RetiredDir[]
}

export function defaultDataDir(userData: string): string {
  return join(userData, 'data')
}

export function pointerPath(userData: string): string {
  return join(userData, DATA_LOCATION_FILE)
}

/** 宽容地读：坏了 / 没有就当默认位置（一个读不懂的 JSON 不该让工坊起不来）。 */
export function readPointer(userData: string): DataLocationPointer {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(pointerPath(userData), 'utf8'))
  } catch {
    return { version: 1, retired: [] }
  }
  const value = raw as Partial<DataLocationPointer> | null
  const dir = typeof value?.dir === 'string' && value.dir.trim() !== '' ? value.dir : undefined
  const retired = Array.isArray(value?.retired)
    ? value.retired.filter(
        (r): r is RetiredDir =>
          typeof r === 'object' &&
          r !== null &&
          typeof r.path === 'string' &&
          typeof r.from === 'string' &&
          typeof r.until === 'string',
      )
    : []
  return {
    version: 1,
    ...(dir === undefined ? {} : { dir }),
    ...(typeof value?.set_at === 'string' ? { set_at: value.set_at } : {}),
    retired,
  }
}

/** 先写临时文件再改名：写到一半断电，指针要么是旧的、要么是新的，不会是半张。 */
export function writePointer(userData: string, pointer: DataLocationPointer): void {
  mkdirSync(userData, { recursive: true })
  const file = pointerPath(userData)
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`)
  renameSync(tmp, file)
}

/** 现在用的数据目录：指针里有就用它，没有就是默认位置。 */
export function currentDataDir(userData: string, pointer = readPointer(userData)): string {
  return pointer.dir ?? defaultDataDir(userData)
}

export function isDefaultDir(userData: string, dir: string): boolean {
  return samePath(dir, defaultDataDir(userData))
}

// ── 路径比较 ─────────────────────────────────────────────────────────

/** Windows 路径不分大小写；`\\server\share` 与盘符都按 win32 规则比。 */
function isWinPath(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')
}

function norm(p: string): string {
  if (isWinPath(p))
    return win32
      .resolve(p)
      .replace(/[\\/]+$/, '')
      .toLowerCase()
  const r = resolve(p)
  return r.length > 1 ? r.replace(/\/+$/, '') : r
}

export function samePath(a: string, b: string): boolean {
  return norm(a) === norm(b)
}

/** `child` 在 `parent` 里面（不含相等）。 */
export function isInside(child: string, parent: string): boolean {
  const c = norm(child)
  const p = norm(parent)
  if (c === p) return false
  const s = isWinPath(child) || isWinPath(parent) ? '\\' : sep
  const base = p.endsWith(s) ? p : `${p}${s}`
  return c.startsWith(base)
}

// ── 选的那个文件夹 ───────────────────────────────────────────────────

export type TargetProblem =
  /** 就是现在这个位置。 */
  | 'same_place'
  /** 在现在的数据目录里面（复制会套娃）。 */
  | 'inside_current'
  /** 在工坊自己的应用目录里（卸载 / 更新会清掉）。 */
  | 'inside_app'
  /** 系统目录（Windows、Program Files、/System、/Library……）。 */
  | 'system_dir'
  /** 文件夹不存在 / 打不开。 */
  | 'not_found'
  /** 写不进去。 */
  | 'not_writable'
  /** 剩余空间不够（数据 × 1.2）。 */
  | 'no_space'
  /** 那里已经有一份东西（`agentsws-data` 子文件夹已存在且不空）。 */
  | 'target_has_data'

export type TargetWarning =
  /** 网盘同步文件夹（OneDrive、iCloud、Dropbox、百度网盘……）：同步时可能把库文件弄坏。 */
  | 'cloud_sync'
  /** 网络盘 / NAS：断网时工坊打不开。 */
  | 'network'

export interface DataTargetCheck {
  ok: boolean
  /** 用户在框里选的那个文件夹。 */
  chosen: string
  /** 数据实际会放到哪（选的文件夹是空的就是它本身，否则是它下面的 `agentsws-data`）。 */
  target: string
  /** 要搬多少。 */
  bytes: number
  files: number
  /** 那个盘还剩多少（查不到就没有）。 */
  free_bytes?: number
  /** 大约要多久（秒）。 */
  estimate_seconds: number
  problems: TargetProblem[]
  warnings: TargetWarning[]
}

export interface DirSize {
  bytes: number
  files: number
}

/** 数一遍目录有多大（符号链接不跟进去）。目录不在就是 0。 */
export function measureDir(dir: string): DirSize {
  let bytes = 0
  let files = 0
  const walk = (d: string): void => {
    let names: string[]
    try {
      names = readdirSync(d)
    } catch {
      return
    }
    for (const name of names) {
      const p = join(d, name)
      let st: ReturnType<typeof lstatSync>
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p)
      else {
        files += 1
        if (st.isFile()) bytes += st.size
      }
    }
  }
  walk(dir)
  return { bytes, files }
}

/**
 * 系统目录：选到这些地方一律不让（更新 / 系统清理会动它们，普通用户也没权限）。
 * 盘符根（`D:\`）、`/Volumes/xxx` 不在这里——那是正常的「放到另一个盘」。
 */
export function systemDirs(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (platform === 'win32') {
    const drive = env.SystemDrive ?? 'C:'
    return [
      env.SystemRoot ?? env.windir ?? `${drive}\\Windows`,
      env.ProgramFiles ?? `${drive}\\Program Files`,
      env['ProgramFiles(x86)'] ?? `${drive}\\Program Files (x86)`,
      env.ProgramData ?? `${drive}\\ProgramData`,
      `${drive}\\$Recycle.Bin`,
      `${drive}\\System Volume Information`,
    ]
  }
  if (platform === 'darwin')
    return [
      '/System',
      '/Library',
      '/Applications',
      '/usr',
      '/bin',
      '/sbin',
      '/etc',
      '/var',
      '/private',
      '/tmp',
      '/cores',
      '/dev',
      '/opt',
    ]
  return ['/usr', '/bin', '/sbin', '/etc', '/var', '/proc', '/sys', '/dev', '/boot', '/tmp', '/opt']
}

/** 网盘同步文件夹的样子（只提示，不拦）。 */
const CLOUD_SYNC = [
  /onedrive/i,
  /dropbox/i,
  /icloud/i,
  /mobile documents/i,
  /library[\\/]cloudstorage/i,
  /google drive/i,
  /googledrive/i,
  /百度网盘/,
  /baidunetdisk/i,
  /坚果云/,
  /nutstore/i,
  /wps\s*网盘/i,
  /wpsdrive/i,
  /阿里云盘/,
  /aliyundrive/i,
  /夸克网盘/,
  /[\\/]box[\\/]/i,
  /[\\/]box$/i,
  /seafile/i,
  /synologydrive/i,
]

export function looksCloudSynced(path: string): boolean {
  return CLOUD_SYNC.some((re) => re.test(path))
}

/** `\\server\share` 这种网络路径（盘符映射的网络盘要靠 `driveIsNetwork` 去问系统）。 */
export function isUncPath(path: string): boolean {
  return /^\\\\[^\\]+\\[^\\]+/.test(path)
}

/** 选的文件夹 → 数据实际放哪：空文件夹就用它本身，否则放进它下面的 `agentsws-data`。 */
export function targetFor(chosen: string): string {
  let names: string[] = []
  try {
    names = readdirSync(chosen).filter((n) => n !== '.DS_Store' && n !== 'desktop.ini')
  } catch {
    return chosen
  }
  return names.length === 0 ? chosen : join(chosen, DATA_SUBDIR)
}

function dirNotEmpty(dir: string): boolean {
  try {
    return readdirSync(dir).some((n) => n !== '.DS_Store' && n !== 'desktop.ini')
  } catch {
    return false
  }
}

/** 往文件夹里写一个小文件再删掉：写得进就算可写。 */
export function probeWritable(dir: string): boolean {
  const probe = join(dir, `.agentsws-write-test-${randomBytes(4).toString('hex')}`)
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** 那个盘还剩多少字节；查不到回 `undefined`（不因为查不到就拦）。 */
export function freeBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(dir)
    return Number(s.bavail) * Number(s.bsize)
  } catch {
    return undefined
  }
}

/**
 * 大约要多久（秒）：本机盘按每秒 80 MB 估，网络盘按 10 MB；再加每个文件 2 毫秒的零头；
 * 复制完还要逐个文件再读一遍核对（× 1.5）。只是给人一个量级，不追求准。
 */
export function estimateSeconds(size: DirSize, network: boolean): number {
  const mbps = network ? 10 : 80
  const seconds = (size.bytes / (mbps * 1024 * 1024)) * 1.5 + size.files * 0.002
  return Math.max(5, Math.ceil(seconds + 10))
}

export interface CheckTargetInput {
  chosen: string
  /** 现在的数据目录。 */
  current: string
  userData: string
  /** 应用自己的目录（`process.resourcesPath` 等）：选到里面不行。 */
  appDirs?: readonly string[]
  /** 系统目录清单（不给就按平台取；测试给 `[]`，临时目录在 macOS 上就在 `/var` 下面）。 */
  systemDirs?: readonly string[]
  /** 现在的数据有多大（不给就现数一遍）。 */
  size?: DirSize
  /** 这个路径是不是网络盘（盘符映射的网络盘、`/Volumes` 下的 smb）。 */
  network?: boolean
  /** 测试注入：剩余空间。 */
  free?: (dir: string) => number | undefined
  writable?: (dir: string) => boolean
}

/** 把一个选好的文件夹从头到尾查一遍。`ok` 为真才允许开搬。 */
export function checkTarget(input: CheckTargetInput): DataTargetCheck {
  const chosen = input.chosen
  const problems: TargetProblem[] = []
  const warnings: TargetWarning[] = []
  const size = input.size ?? measureDir(input.current)
  const exists = existsSync(chosen)
  const target = exists ? targetFor(chosen) : chosen
  const network = input.network === true || isUncPath(chosen)

  if (!isAbsolute(chosen) && !isWinPath(chosen)) problems.push('not_found')
  else if (!exists) problems.push('not_found')

  if (samePath(target, input.current) || samePath(chosen, input.current))
    problems.push('same_place')
  else if (isInside(target, input.current)) problems.push('inside_current')
  else if (
    isInside(target, input.userData) &&
    !samePath(target, defaultDataDir(input.userData)) &&
    !isInside(target, defaultDataDir(input.userData))
  )
    // `userData` 里除了默认那个位置，其余都是工坊自己的东西（配置、密钥、日志、插件）
    problems.push('inside_app')
  if (input.appDirs?.some((d) => samePath(target, d) || isInside(target, d)) === true)
    problems.push('inside_app')

  const sys = input.systemDirs ?? systemDirs(process.platform, process.env)
  if (sys.some((d) => samePath(chosen, d) || isInside(chosen, d))) problems.push('system_dir')

  if (exists && problems.length === 0) {
    if (!samePath(target, chosen) && existsSync(target) && dirNotEmpty(target))
      problems.push('target_has_data')
    if (!(input.writable ?? probeWritable)(chosen)) problems.push('not_writable')
  }

  const free = exists ? (input.free ?? freeBytes)(chosen) : undefined
  if (free !== undefined && free < size.bytes * SPACE_FACTOR && !problems.includes('not_found'))
    problems.push('no_space')

  if (looksCloudSynced(chosen)) warnings.push('cloud_sync')
  if (network) warnings.push('network')

  return {
    ok: problems.length === 0,
    chosen,
    target,
    bytes: size.bytes,
    files: size.files,
    ...(free === undefined ? {} : { free_bytes: free }),
    estimate_seconds: estimateSeconds(size, network),
    problems: [...new Set(problems)],
    warnings,
  }
}

/**
 * 恢复默认位置的那一份检查：目标固定是 `<userData>/data`。
 * 默认位置上要是还躺着一份搬走前留下的旧目录（改名没成功那种），它是过期的——先清掉再搬。
 */
export function checkDefaultTarget(input: Omit<CheckTargetInput, 'chosen'>): DataTargetCheck {
  const target = defaultDataDir(input.userData)
  const size = input.size ?? measureDir(input.current)
  const problems: TargetProblem[] = []
  if (samePath(target, input.current)) problems.push('same_place')
  const pointer = readPointer(input.userData)
  const staleRetired = pointer.retired.some((r) => samePath(r.path, target))
  if (existsSync(target) && dirNotEmpty(target) && !staleRetired) problems.push('target_has_data')
  mkdirSync(input.userData, { recursive: true })
  if (!(input.writable ?? probeWritable)(input.userData)) problems.push('not_writable')
  const free = (input.free ?? freeBytes)(input.userData)
  if (free !== undefined && free < size.bytes * SPACE_FACTOR) problems.push('no_space')
  return {
    ok: problems.length === 0,
    chosen: target,
    target,
    bytes: size.bytes,
    files: size.files,
    ...(free === undefined ? {} : { free_bytes: free }),
    estimate_seconds: estimateSeconds(size, false),
    problems,
    warnings: [],
  }
}

// ── 旧目录：改名留 7 天 ──────────────────────────────────────────────

function stamp(iso: string): string {
  return iso
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, '')
    .replace('T', '-')
    .slice(0, 13)
}

/**
 * 搬完之后把旧目录改个名（`data` → `data-moved-20261023-1144`），里面放一张纸条，记进指针。
 * 改名没成（Windows 上偶尔有文件被杀毒软件占着）就原地留着，照样记、照样到期清。
 */
export function retireOldDir(input: {
  userData: string
  dir: string
  now: string
  days?: number
}): RetiredDir {
  const until = new Date(
    Date.parse(input.now) + (input.days ?? RETIRE_DAYS) * 86_400_000,
  ).toISOString()
  let path = input.dir
  const renamed = join(dirname(input.dir), `${basename(input.dir)}-moved-${stamp(input.now)}`)
  try {
    if (!existsSync(renamed)) {
      renameSync(input.dir, renamed)
      path = renamed
    }
  } catch {
    path = input.dir
  }
  try {
    writeFileSync(
      join(path, RETIRED_MARK),
      `${JSON.stringify({ from: input.dir, retired_at: input.now, until }, null, 2)}\n`,
    )
  } catch {
    // 纸条写不进去：这个目录到期时不会被自动删（宁可留着，不误删）
  }
  const entry: RetiredDir = { path, from: input.dir, until }
  const pointer = readPointer(input.userData)
  writePointer(input.userData, {
    ...pointer,
    retired: [...pointer.retired.filter((r) => !samePath(r.path, path)), entry],
  })
  return entry
}

/**
 * 删一个旧目录。三道保险：必须带我们的纸条；不能是（或包含）现在的数据目录；不能是 userData 本身。
 * 删成了（或它已经不在了）回 `true`。
 */
export function removeRetired(input: { userData: string; entry: RetiredDir }): boolean {
  const { entry } = input
  const current = currentDataDir(input.userData)
  if (!existsSync(entry.path)) return true
  if (samePath(entry.path, current) || isInside(current, entry.path)) return false
  if (samePath(entry.path, input.userData) || isInside(input.userData, entry.path)) return false
  if (!existsSync(join(entry.path, RETIRED_MARK))) return false
  try {
    rmSync(entry.path, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 启动时清到期的旧目录（`force` = 界面上点了「现在就删」，不看到期没到期）。
 * 回删掉了哪些；删不掉的留在清单里下次再试，已经不在的直接从清单里拿掉。
 */
export function purgeRetired(input: {
  userData: string
  now: string
  force?: boolean
}): RetiredDir[] {
  const pointer = readPointer(input.userData)
  if (pointer.retired.length === 0) return []
  const nowMs = Date.parse(input.now)
  const removed: RetiredDir[] = []
  const keep: RetiredDir[] = []
  for (const entry of pointer.retired) {
    const due = input.force === true || Date.parse(entry.until) <= nowMs
    if (!existsSync(entry.path)) continue
    if (due && removeRetired({ userData: input.userData, entry })) removed.push(entry)
    else keep.push(entry)
  }
  writePointer(input.userData, { ...pointer, retired: keep })
  return removed
}

/** 界面上那一句「旧位置的数据留到 X」用的：还留着的那一份（最近搬走的那个）。 */
export function latestRetired(userData: string): RetiredDir | undefined {
  const list = readPointer(userData).retired.filter((r) => existsSync(r.path))
  return list.at(-1)
}

/** 记下新位置（默认位置就把 `dir` 拿掉）。 */
export function commitDataDir(input: { userData: string; dir: string; now: string }): void {
  const pointer = readPointer(input.userData)
  const { dir: _old, ...rest } = pointer
  writePointer(
    input.userData,
    isDefaultDir(input.userData, input.dir)
      ? { ...rest, set_at: input.now }
      : { ...rest, dir: input.dir, set_at: input.now },
  )
}

/** 指针里的位置现在打不打得开（NAS 断网、移动硬盘没插）。默认位置总当打得开（不在就建）。 */
export function dataDirReachable(userData: string, dir: string): boolean {
  if (isDefaultDir(userData, dir)) return true
  try {
    return lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}
