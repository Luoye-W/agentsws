/**
 * WP345（决策 871）：**插件随工坊安装与更新**的服务端那一半（路由与形状在 `@agentsws/api` 的
 * `routes/extension-install.ts`）。
 *
 * - 文件夹由桌面壳放（`apps/desktop/src/extension-sync.ts`），经 `AGENTSWS_EXTENSION_DIR` 告诉这里；
 *   旁边的 `<文件夹>.json` 是桌面壳上次换文件夹的结果。这里**只读不写**。
 * - 插件每分钟来报一次自己的版本（{@link ExtensionInstallPort.report}），回它文件夹里是哪一版——
 *   不一样插件就等空闲 reload。重载后报上来「从哪版换来」记一条 `extension.updated`；重载了还是旧版
 *   （多半从别的文件夹加载）记 `extension.update_failed`，连接卡上照实说一句。
 * - 正在跑的版本只放内存：本机重启后等插件下一次来问（最多一分钟）就又有了；事件日志里留着历史。
 * - 打开文件夹 / Chrome 扩展页：网页自己做不到（`chrome://` 打不开、本机文件夹摸不到），由本机起一个
 *   与本进程脱钩的进程去开。起 Chrome 只给一份干净的环境变量（不带本机密钥）。
 */

import { spawn } from 'node:child_process'
import type {
  ExtensionFolderSync,
  ExtensionInstallPort,
  ExtensionInstallView,
  ExtensionOpenResult,
  ExtensionRunningVersion,
} from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import { browserCandidates, type Env } from './readonly-browser/find-browser.js'

/** 起一个与本进程脱钩的进程。起得来回 true（不看退出码：Windows 的 explorer.exe 成功了也回 1）。 */
export type Launch = (
  command: string,
  args: string[],
  env: Record<string, string>,
) => Promise<boolean>

/** 真的那一个：脱钩起（detached + unref），不接输出；`spawn` 事件到了就算起来了。 */
export const spawnDetached: Launch = (command, args, env) =>
  new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', env })
      child.once('error', () => resolve(false))
      child.once('spawn', () => {
        child.unref()
        resolve(true)
      })
    } catch {
      resolve(false)
    }
  })

export interface ExtensionInstallOptions {
  /** 插件的固定文件夹；没有 = 不是桌面版（开发时直接跑服务 / 服务在别的电脑上）。 */
  dir: string | undefined
  platform: NodeJS.Platform
  env: Env
  readText(path: string): string | undefined
  exists(path: string): boolean
  launch: Launch
  /** 给浏览器的干净环境变量（不带本机密钥）。 */
  browserEnv(env: Env): Record<string, string>
  now(): string
  /** 记一条事件到这个工作区的事件日志。 */
  record(
    workspace_id: WorkspaceId,
    type: 'extension.updated' | 'extension.update_failed',
    payload: Record<string, string>,
  ): void
}

const SYNC_STATUSES: readonly ExtensionFolderSync['status'][] = [
  'installed',
  'updated',
  'unchanged',
  'failed',
  'no_bundle',
]

/** 某个插件目录的版本（`version_name` 优先）。 */
export function folderVersion(
  dir: string,
  readText: (path: string) => string | undefined,
): string | undefined {
  try {
    const m = JSON.parse(readText(joinPath(dir, 'manifest.json')) ?? '') as {
      version?: unknown
      version_name?: unknown
    }
    if (typeof m.version_name === 'string' && m.version_name !== '') return m.version_name
    return typeof m.version === 'string' && m.version !== '' ? m.version : undefined
  } catch {
    return undefined
  }
}

/** 桌面壳写的 `<文件夹>.json`。读不懂回 undefined。 */
export function readSyncState(
  dir: string,
  readText: (path: string) => string | undefined,
): { sync: ExtensionFolderSync; bundled_version?: string } | undefined {
  try {
    const raw = JSON.parse(readText(`${dir}.json`) ?? '') as Record<string, unknown>
    const status = raw.status as ExtensionFolderSync['status']
    if (!SYNC_STATUSES.includes(status) || typeof raw.at !== 'string') return undefined
    return {
      sync: {
        status,
        at: raw.at as ExtensionFolderSync['at'],
        ...(typeof raw.error === 'string' ? { error: raw.error } : {}),
      },
      ...(typeof raw.bundled_version === 'string' ? { bundled_version: raw.bundled_version } : {}),
    }
  } catch {
    return undefined
  }
}

/** 文件夹路径拼接（不 import node:path：路径分隔符跟着文件夹自己走，Windows 路径在 mac 上测也对）。 */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith(sep) ? `${dir}${name}` : `${dir}${sep}${name}`
}

/** 打开一个文件夹用哪个命令。 */
export function folderOpener(platform: NodeJS.Platform, dir: string): [string, string[]] {
  if (platform === 'darwin') return ['open', [dir]]
  if (platform === 'win32') return ['explorer.exe', [dir]]
  return ['xdg-open', [dir]]
}

/**
 * 扩展页地址：Edge 是 `edge://extensions`，Chrome / Chromium 是 `chrome://extensions`。
 * 实测（WP345，Chrome 155）：命令行带上它 Chrome 不认，开成一个新标签页——所以连接卡上把这串复制好，请人粘贴。
 */
export function extensionsPageFor(executable: string): string {
  return /msedge|microsoft edge/i.test(executable) ? 'edge://extensions' : 'chrome://extensions'
}

const NO_FOLDER = '这台电脑上还没有插件文件夹（要用桌面版 Agents 工坊）。'
const NO_CHROME = '没找到 Chrome。装好 Chrome 后，在地址栏输入 chrome://extensions 也能打开扩展页。'
const LAUNCH_FAILED = '没打开 Chrome：自己打开它，在地址栏粘贴 chrome://extensions。'

export function createExtensionInstall(options: ExtensionInstallOptions): ExtensionInstallPort {
  const running = new Map<string, ExtensionRunningVersion & { workspace_id: WorkspaceId }>()

  const folder = (): string | undefined =>
    options.dir !== undefined && options.exists(options.dir) ? options.dir : undefined

  return {
    view(workspace_id): ExtensionInstallView {
      const dir = folder()
      const version = dir === undefined ? undefined : folderVersion(dir, options.readText)
      const state =
        options.dir === undefined ? undefined : readSyncState(options.dir, options.readText)
      return {
        ...(dir === undefined ? {} : { folder: dir }),
        ...(version === undefined ? {} : { folder_version: version }),
        ...(state?.bundled_version === undefined ? {} : { bundled_version: state.bundled_version }),
        ...(state === undefined ? {} : { sync: state.sync }),
        running: [...running.values()]
          .filter((r) => r.workspace_id === workspace_id)
          .map(({ workspace_id: _ws, ...view }) => view),
        can_open: dir !== undefined,
      }
    },

    async open(target): Promise<ExtensionOpenResult> {
      if (target === 'folder') {
        const dir = folder()
        if (dir === undefined) return { opened: false, message: NO_FOLDER }
        const [command, args] = folderOpener(options.platform, dir)
        const opened = await options.launch(command, args, options.browserEnv(options.env))
        return opened ? { opened } : { opened, message: `没打开，文件夹在：${dir}` }
      }
      const executable = browserCandidates(options.platform, options.env).find((p) =>
        options.exists(p),
      )
      if (executable === undefined) return { opened: false, message: NO_CHROME }
      // 带上扩展页地址：Chrome 155 不认（开成新标签页），但把浏览器叫到前面、开好一个新标签页；
      // 地址交回给卡片复制好，用户在地址栏粘贴（将来 Chrome 放开了就直接是扩展页）
      const address = extensionsPageFor(executable)
      const opened = await options.launch(executable, [address], options.browserEnv(options.env))
      return opened ? { opened, address } : { opened, address, message: LAUNCH_FAILED }
    },

    report(session, input) {
      const before = running.get(session.token_id)
      // 放弃过的那一版：插件之后照常报（不再带 gave_up），只要还是同一个旧版本就一直记着
      const stuck =
        input.gave_up ?? (before?.version === input.version ? before.stuck_on : undefined)
      running.set(session.token_id, {
        workspace_id: session.workspace_id,
        token_id: session.token_id,
        extension_id: session.extension_id,
        version: input.version,
        at: options.now() as ExtensionRunningVersion['at'],
        ...(stuck === undefined ? {} : { stuck_on: stuck }),
      })
      if (input.reloaded_from !== undefined && input.reloaded_from !== input.version)
        options.record(session.workspace_id, 'extension.updated', {
          token_id: session.token_id,
          extension_id: session.extension_id,
          from: input.reloaded_from,
          to: input.version,
        })
      if (input.gave_up !== undefined && before?.stuck_on !== input.gave_up)
        options.record(session.workspace_id, 'extension.update_failed', {
          token_id: session.token_id,
          extension_id: session.extension_id,
          running: input.version,
          wanted: input.gave_up,
        })
      const dir = folder()
      const version = dir === undefined ? undefined : folderVersion(dir, options.readText)
      return version === undefined ? {} : { folder_version: version }
    },
  }
}
