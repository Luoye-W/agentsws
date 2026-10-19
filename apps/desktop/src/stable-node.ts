/**
 * WP427（决策 1273 ②）：Windows 上服务进程的 Node 住在一个**不随版本变**的路径上。
 *
 * 为什么：WP327 起一版一个目录（`<根>\app-<版本>\resources\node\node.exe`），Windows 防火墙按**真实路径**
 * 记「允许」——换一版就是新路径，开了「和同事一起用」的人每次更新都被问一次「Node 要联网」。
 * WP422 试过更新时把允许规则带过去，可改规则要管理员权限，默认的「按用户装」拿不到。
 *
 * 做法：服务进程改从 `<根>\node\node.exe` 起（`<根>` = 安装目录，按用户装就在
 * `%LOCALAPPDATA%\Programs\agentsws`，普通用户可写，**不要管理员权限**）。防火墙认的路径从此不变，
 * 允许一次一直有效。这份 Node 由这一版自己的 `resources\node\` 同步过来：
 *
 * - 一样（大小 + sha256 对得上）→ 什么都不做（每次启动只比大小与记号，换版本那一次才算一遍哈希）；
 * - 不在 / 不一样（Node 本身升级了）→ 先拷成 `node.exe.new`，再把旧的**改名**成 `node.exe.old-<时间>`
 *   （Windows 上正在跑的 exe 不能覆盖、不能删，但能改名——上一版还有子进程挂着也换得了），
 *   再把新的改名就位；中途失败就把旧的改回来，退回用版本目录里那一份（会多问一次防火墙，但不挡启动）；
 * - 旁边那几个小文件（npm 的包、清单——npm 按 Node 所在目录找它们）每次换版本时一起同步；
 * - 回滚（新版 60 秒没起来、切回旧版）：旧版启动时同样按「自己带的那一份」同步回去，所以不会出现
 *   旧版的服务脚本配新版 Node 的情况。
 *
 * 安装程序（`build/installer.nsh`）切好 `current` 之后也拷一份过去（按机器装时只有安装程序有权限写
 * Program Files）；之后应用每次启动按上面那条规矩核对一遍。
 *
 * 本文件不 import electron；文件系统是注入的，四条路都在 vitest 里用替身跑。
 */
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** `<根>\node`。 */
export const STABLE_NODE_DIR = 'node'
/** 记号：这份是从哪一版、多大、什么哈希的 Node 拷来的。 */
export const STABLE_NODE_MARKER = '.agentsws-node.json'
const EXE = 'node.exe'

export interface StableNodeFs {
  exists(path: string): boolean
  /** 目录下的文件名（只要文件；读不了回空）。 */
  files(dir: string): string[]
  size(path: string): number
  /** sha256 十六进制。 */
  hash(path: string): string
  readText(path: string): string | undefined
  writeText(path: string, text: string): void
  mkdir(path: string): void
  copy(from: string, to: string): void
  rename(from: string, to: string): void
  remove(path: string): void
}

interface Marker {
  version: string
  size: number
  sha256: string
}

export type StableNodeOutcome =
  | { kind: 'kept'; path: string }
  | { kind: 'copied'; path: string }
  | { kind: 'replaced'; path: string }
  | { kind: 'fallback'; reason: string }

export const stableNodePath = (root: string): string => join(root, STABLE_NODE_DIR, EXE)

function readMarker(fs: StableNodeFs, file: string): Marker | undefined {
  try {
    const raw = JSON.parse(fs.readText(file) ?? '') as Partial<Marker>
    return typeof raw.version === 'string' &&
      typeof raw.size === 'number' &&
      typeof raw.sha256 === 'string'
      ? { version: raw.version, size: raw.size, sha256: raw.sha256 }
      : undefined
  } catch {
    return undefined
  }
}

/** 旁边那几个小文件：大小不一样就覆盖（一个没成不挡）。 */
function syncSiblings(fs: StableNodeFs, from: string, to: string): void {
  for (const name of fs.files(from)) {
    if (name.toLowerCase() === EXE) continue
    const src = join(from, name)
    const dst = join(to, name)
    try {
      if (fs.exists(dst) && fs.size(dst) === fs.size(src)) continue
      fs.copy(src, dst)
    } catch {
      // npm 包拷不过去：服务进程第一次要 npm 时会自己下（WP327 那条路）
    }
  }
}

/** 上次换下来、当时还被占着的旧 Node：这次删得掉就删。 */
function sweepOld(fs: StableNodeFs, dir: string): void {
  for (const name of fs.files(dir)) {
    if (!/^node\.exe\.(old-\d+|new)$/i.test(name)) continue
    try {
      fs.remove(join(dir, name))
    } catch {
      // 还被占着：下次再删
    }
  }
}

/**
 * 核对 / 同步那份不随版本变的 Node。永远不抛：不成就回 `fallback`（调用方用版本目录里那一份）。
 *
 * @param root 安装根目录（`<根>`，`current` 联接所在的那一层）
 * @param bundledDir 这一版自带的 `resources\node`
 */
export function ensureStableNode(input: {
  root: string
  bundledDir: string
  version: string
  fs: StableNodeFs
  now?: () => number
}): StableNodeOutcome {
  const { fs } = input
  const bundled = join(input.bundledDir, EXE)
  const dir = join(input.root, STABLE_NODE_DIR)
  const target = join(dir, EXE)
  const markerFile = join(dir, STABLE_NODE_MARKER)
  try {
    if (!fs.exists(bundled)) return { kind: 'fallback', reason: `这一版没带 Node：${bundled}` }
    const marker = readMarker(fs, markerFile)
    const present = fs.exists(target)
    // 快路：这一版自己拷过、大小没变
    if (present && marker?.version === input.version && fs.size(target) === marker.size) {
      sweepOld(fs, dir)
      return { kind: 'kept', path: target }
    }
    const size = fs.size(bundled)
    const sha256 = fs.hash(bundled)
    const write = (): void => {
      fs.writeText(markerFile, `${JSON.stringify({ version: input.version, size, sha256 })}\n`)
    }
    if (present && fs.size(target) === size) {
      // 记号对得上就不用再算一遍那份的哈希；没记号（安装程序刚拷的）才算
      const same = marker !== undefined ? marker.sha256 === sha256 : fs.hash(target) === sha256
      if (same) {
        syncSiblings(fs, input.bundledDir, dir)
        write()
        sweepOld(fs, dir)
        return { kind: 'kept', path: target }
      }
    }
    fs.mkdir(dir)
    syncSiblings(fs, input.bundledDir, dir)
    const fresh = `${target}.new`
    fs.copy(bundled, fresh)
    if (fs.size(fresh) !== size) {
      fs.remove(fresh)
      return { kind: 'fallback', reason: '拷过去的 Node 大小不对' }
    }
    if (!present) {
      fs.rename(fresh, target)
      write()
      return { kind: 'copied', path: target }
    }
    const old = `${target}.old-${String((input.now ?? Date.now)())}`
    fs.rename(target, old)
    try {
      fs.rename(fresh, target)
    } catch (err) {
      // 新的就不了位：把旧的改回来
      try {
        fs.rename(old, target)
      } catch {
        // 改不回来：下次启动没有 node.exe → 走「不在」那条路重拷
      }
      throw err
    }
    write()
    try {
      fs.remove(old)
    } catch {
      // 旧的还被占着（上一版的子进程）：留着，下次启动再删
    }
    return { kind: 'replaced', path: target }
  } catch (err) {
    return { kind: 'fallback', reason: err instanceof Error ? err.message : String(err) }
  }
}

/** 真的那份文件系统。 */
export function nodeStableNodeFs(): StableNodeFs {
  return {
    exists: (p) => existsSync(p),
    files: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isFile())
          .map((e) => e.name)
      } catch {
        return []
      }
    },
    size: (p) => statSync(p).size,
    hash: (p) => createHash('sha256').update(readFileSync(p)).digest('hex'),
    readText: (p) => {
      try {
        return readFileSync(p, 'utf8')
      } catch {
        return undefined
      }
    },
    writeText: (p, text) => {
      writeFileSync(p, text)
    },
    mkdir: (p) => {
      mkdirSync(p, { recursive: true })
    },
    copy: (from, to) => {
      copyFileSync(from, to)
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    remove: (p) => {
      rmSync(p, { force: true })
    },
  }
}
