/**
 * WP345（决策 871）：**浏览器插件跟着工坊一起更新**——把安装包里带的插件放到数据目录下一个固定文件夹。
 *
 * 插件不上架商店。用户第一次在 Chrome 里「加载已解压」选的就是这个文件夹（`<userData>/chrome-extension`，
 * 不随 `app-<版本>` 变）；manifest 里写了固定 `key`，id 不随路径变。之后每次工坊启动：
 *
 * 1. 安装包里那一份（`<resources>/chrome-extension`）与文件夹里那一份逐个文件比摘要，一样就什么都不做；
 * 2. 不一样：先整份抄到旁边的 `chrome-extension.new-<随机>`，抄完再算一遍摘要，对上了才算完整；
 * 3. **整体替换**：旧的改名成 `chrome-extension.old-<随机>` → 新的改名成 `chrome-extension` → 删旧的。
 *    第二步改名失败就把旧的改回来（Chrome 读到的永远是一整版，不会是半新半旧）；失败照实记原因、下次启动再试；
 * 4. 结果写在文件夹旁边的 `chrome-extension.json`（服务进程读它：连接卡上「文件夹里是哪一版、上次换成没有」）。
 *
 * 换完之后由插件自己在空闲时 `chrome.runtime.reload()`（它每分钟问一次本机，见 `apps/extension/src/lib/self-update.ts`）；
 * Chrome 没开就等下次启动自然读新文件。
 *
 * 本文件不 import electron；文件系统可注入（测试里用真临时目录 + 故意失败的那一步）。
 */
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

/** 数据目录下那个固定文件夹的名字（用户在 Chrome 里选的就是它）。 */
export const EXTENSION_DIR_NAME = 'chrome-extension'
/** 安装包里插件的位置（相对 `<resources>`；`electron-builder.yml` 的 extraResources 摆的）。 */
export const BUNDLED_EXTENSION_DIR = 'chrome-extension'

export type ExtensionSyncStatus =
  /** 第一次放进去。 */
  | 'installed'
  /** 换成了安装包里那一版。 */
  | 'updated'
  /** 一样，没动。 */
  | 'unchanged'
  /** 没换成（旧版留着）。 */
  | 'failed'
  /** 安装包里没带插件（开发时没构建）：文件夹不动。 */
  | 'no_bundle'

/** `chrome-extension.json` 的内容（服务进程 `apps/server/src/extension-install.ts` 读同一个形状）。 */
export interface ExtensionSyncState {
  status: ExtensionSyncStatus
  at: string
  /** 安装包里那一版（manifest 的 `version_name`，没有就 `version`）。 */
  bundled_version?: string
  /** 现在文件夹里那一版。 */
  folder_version?: string
  /** 换之前文件夹里那一版（`updated` 才有）。 */
  previous_version?: string
  /** 没换成的原因（`failed` 才有）。 */
  error?: string
}

/** 本文件要的那点文件系统。 */
export interface ExtensionSyncFs {
  exists(path: string): boolean
  /** 目录里的条目（不跟符号链接）；读不了回空。 */
  list(dir: string): { name: string; dir: boolean }[]
  read(path: string): Buffer
  copyDir(from: string, to: string): void
  rename(from: string, to: string): void
  removeDir(path: string): void
  writeText(path: string, text: string): void
}

export function nodeExtensionSyncFs(): ExtensionSyncFs {
  return {
    exists: (p) => existsSync(p),
    list: (dir) => {
      try {
        return readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
        }))
      } catch {
        return []
      }
    },
    read: (p) => readFileSync(p),
    copyDir: (from, to) => {
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    },
    rename: (from, to) => {
      renameSync(from, to)
    },
    removeDir: (p) => {
      rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
    },
    writeText: (p, text) => {
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, text)
    },
  }
}

/** 数据目录下那个固定文件夹。 */
export function extensionFolder(userData: string): string {
  return join(userData, EXTENSION_DIR_NAME)
}

/** 文件夹旁边那份状态（`<文件夹>.json`）。 */
export function extensionStateFile(folder: string): string {
  return `${folder}.json`
}

/**
 * 安装包里插件在哪：打包后 `<resources>/chrome-extension`；开发期给仓库里构建出来的那一份。
 */
export function bundledExtensionDir(
  resourcesPath: string | undefined,
  devCandidate: string,
): string {
  return resourcesPath === undefined ? devCandidate : join(resourcesPath, BUNDLED_EXTENSION_DIR)
}

/** 某个插件目录的版本（`version_name` 优先：Chrome 的 `version` 只有数字，beta 号在 `version_name` 里）。 */
export function manifestVersion(dir: string, fs: ExtensionSyncFs): string | undefined {
  try {
    const m = JSON.parse(fs.read(join(dir, 'manifest.json')).toString('utf8')) as {
      version?: unknown
      version_name?: unknown
    }
    if (typeof m.version_name === 'string' && m.version_name !== '') return m.version_name
    return typeof m.version === 'string' && m.version !== '' ? m.version : undefined
  } catch {
    return undefined
  }
}

/** 整个目录的摘要：每个文件的相对路径 + 内容，按路径排好再算 sha256。目录不在回 undefined。 */
export function treeDigest(dir: string, fs: ExtensionSyncFs): string | undefined {
  if (!fs.exists(dir)) return undefined
  const files: string[] = []
  const walk = (rel: string): void => {
    for (const e of fs.list(rel === '' ? dir : join(dir, rel))) {
      const child = rel === '' ? e.name : `${rel}/${e.name}`
      if (e.dir) walk(child)
      else files.push(child)
    }
  }
  walk('')
  files.sort()
  const hash = createHash('sha256')
  for (const f of files) {
    const body = fs.read(join(dir, ...f.split('/')))
    hash.update(`${f}\0${body.length}\0`)
    hash.update(body)
  }
  return hash.digest('hex')
}

/** 上次被打断留下的 `chrome-extension.new-*` / `.old-*`（只认我们自己起的名字）。 */
export function leftovers(target: string, fs: ExtensionSyncFs): string[] {
  const name = basename(target)
  return fs
    .list(dirname(target))
    .filter(
      (e) => e.dir && (e.name.startsWith(`${name}.new-`) || e.name.startsWith(`${name}.old-`)),
    )
    .map((e) => join(dirname(target), e.name))
}

export interface SyncInput {
  /** 安装包里那一份。 */
  source: string
  /** 数据目录下那个固定文件夹。 */
  target: string
  fs?: ExtensionSyncFs
  now(): Date
  /** 临时目录名里那一段随机（测试给定值）。 */
  random?: () => string
  /** 改名失败时等一下再试（Windows 上杀毒软件可能刚好在扫）。 */
  sleep?: (ms: number) => Promise<void>
  /** 改名最多试几次（默认 3）。 */
  attempts?: number
}

const errorText = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, 300)

/**
 * 把安装包里的插件同步到固定文件夹（见文件头）。**从不抛**：结果写进状态文件，也原样回给调用方记日志。
 */
export async function syncBundledExtension(input: SyncInput): Promise<ExtensionSyncState> {
  const fs = input.fs ?? nodeExtensionSyncFs()
  const at = input.now().toISOString()
  const random = input.random ?? (() => Math.random().toString(36).slice(2, 10))
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const attempts = Math.max(1, input.attempts ?? 3)
  const { source, target } = input
  const folderVersion = (): string | undefined => manifestVersion(target, fs)

  const finish = (state: ExtensionSyncState): ExtensionSyncState => {
    try {
      fs.writeText(extensionStateFile(target), `${JSON.stringify(state, null, 2)}\n`)
    } catch {
      // 状态文件写不了不影响插件本身；连接卡上就少一句「上次换成没有」
    }
    return state
  }

  const bundled = manifestVersion(source, fs)
  const folderBefore = folderVersion()
  if (bundled === undefined)
    return finish({
      status: 'no_bundle',
      at,
      ...(folderBefore === undefined ? {} : { folder_version: folderBefore }),
    })

  // 上次被打断留下的临时目录先清掉（不清也不碍事，只是占地方）
  for (const dir of leftovers(target, fs)) {
    try {
      fs.removeDir(dir)
    } catch {
      // 下次再清
    }
  }

  const failed = (error: string): ExtensionSyncState =>
    finish({
      status: 'failed',
      at,
      bundled_version: bundled,
      ...(folderBefore === undefined ? {} : { folder_version: folderBefore }),
      error,
    })

  let want: string | undefined
  try {
    want = treeDigest(source, fs)
    if (want !== undefined && treeDigest(target, fs) === want)
      return finish({ status: 'unchanged', at, bundled_version: bundled, folder_version: bundled })
  } catch (err) {
    return failed(`读不了插件文件：${errorText(err)}`)
  }

  const tag = random()
  const staging = `${target}.new-${tag}`
  const backup = `${target}.old-${tag}`
  const dropStaging = (): void => {
    try {
      fs.removeDir(staging)
    } catch {
      // 留着，下次启动清
    }
  }

  // ① 抄到旁边，再校验一遍
  try {
    fs.copyDir(source, staging)
    if (treeDigest(staging, fs) !== want) {
      dropStaging()
      return failed('抄出来的插件文件和安装包里的对不上')
    }
  } catch (err) {
    dropStaging()
    return failed(`抄插件文件失败：${errorText(err)}`)
  }

  const renameWithRetry = async (from: string, to: string): Promise<void> => {
    for (let i = 1; ; i += 1) {
      try {
        fs.rename(from, to)
        return
      } catch (err) {
        if (i >= attempts) throw err
        await sleep(300 * i)
      }
    }
  }

  // ② 整体替换
  const hadOld = fs.exists(target)
  if (hadOld) {
    try {
      await renameWithRetry(target, backup)
    } catch (err) {
      dropStaging()
      return failed(`旧版文件夹挪不开（可能正被占用）：${errorText(err)}`)
    }
  }
  try {
    await renameWithRetry(staging, target)
  } catch (err) {
    // 新的放不进去：把旧的改回来
    if (hadOld) {
      try {
        await renameWithRetry(backup, target)
      } catch (restoreErr) {
        dropStaging()
        return failed(
          `新版放不进去，旧版也没改回来（旧版在 ${basename(backup)}）：${errorText(err)}；${errorText(restoreErr)}`,
        )
      }
    }
    dropStaging()
    return failed(`新版放不进去：${errorText(err)}`)
  }
  if (hadOld) {
    try {
      fs.removeDir(backup)
    } catch {
      // 删不掉旧版不碍事（下次启动清）
    }
  }
  return finish({
    status: hadOld ? 'updated' : 'installed',
    at,
    bundled_version: bundled,
    folder_version: bundled,
    ...(hadOld && folderBefore !== undefined ? { previous_version: folderBefore } : {}),
  })
}
