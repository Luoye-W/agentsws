/**
 * 托盘这一侧的升级出事处置（WP111）。
 *
 * 服务进程那边的闸（`apps/server/src/upgrade-guard.ts`）负责"动数据之前先备份、
 * 迁移失败不启动、留一张纸条"。这里负责把那张纸条变成用户看得懂的一句话，
 * 外加一个按了就能回到升级之前的按钮。
 *
 * **不 import electron**，也不自己解 zip：还原那一步交给服务进程下次启动去做
 * （托盘只写一张单子）。在一台已经出事的机器上，多一处解压逻辑就是多一处会出事的地方。
 */
import type { Language } from './config.js'
import { strings } from './i18n.js'
import type { Clock, FileStore } from './ports.js'

/** 与 `apps/server/src/upgrade-guard.ts` 里的常量一一对应（两处改要一起改）。 */
export const UPGRADE_FAILED_FILE = 'upgrade-failed.json'
export const RESTORE_REQUEST_FILE = 'restore-request.json'

/** 服务进程留下的那张纸条。字段与 `UpgradeFailure` 同形（这里只读，不写）。 */
export interface UpgradeFailureNote {
  at: string
  release: string
  previous_release?: string
  /**
   * 卡在哪一步。`backup` = 连升级前那份备份都没做成（磁盘满 / 库已经坏了），
   * 迁移一步没跑，也没有可还原的东西；`migrate` = 备份好了、建服务时炸了。
   * 两步的下一步动作不一样，所以不糊成一句"升级失败"。
   */
  stage?: 'backup' | 'migrate'
  error: string
  backup?: string
  data_touched: boolean
}

/** 宽容解析：纸条坏了就当没有——一个读不懂的 JSON 不该让托盘也跟着挂。 */
export function parseFailureNote(raw: string | undefined): UpgradeFailureNote | undefined {
  if (raw === undefined) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  const note = value as Partial<UpgradeFailureNote> | null
  if (typeof note?.error !== 'string' || typeof note.release !== 'string') return undefined
  return {
    at: typeof note.at === 'string' ? note.at : '',
    release: note.release,
    ...(typeof note.previous_release === 'string'
      ? { previous_release: note.previous_release }
      : {}),
    ...(note.stage === 'backup' || note.stage === 'migrate' ? { stage: note.stage } : {}),
    error: note.error,
    ...(typeof note.backup === 'string' ? { backup: note.backup } : {}),
    data_touched: note.data_touched === true,
  }
}

export function readFailureNote(files: FileStore, dataDir: string): UpgradeFailureNote | undefined {
  return parseFailureNote(files.readText(joinPath(dataDir, UPGRADE_FAILED_FILE)))
}

/**
 * 给用户的那一句话。
 *
 * 三件事按她关心的顺序说：**数据动没动** → 备份在哪 → 下一步按什么。
 * 技术细节（错误堆栈）**不进这句话**——它在日志与诊断包里，那才是给我们看的。
 */
export function failureMessage(note: UpgradeFailureNote, language: Language): string {
  const t = strings(language)
  const head = note.data_touched ? t.upgradeFailedTouched : t.upgradeFailedIntact
  const where =
    note.stage === 'backup'
      ? t.upgradeBackupFailed
      : note.backup === undefined
        ? t.upgradeNoBackup
        : t.upgradeBackupAt.replace('{path}', note.backup)
  return `${head}\n${where}`
}

/** 还原按钮点不点得动：有纸条、且纸条里有一个备份路径。 */
export function canRestore(note: UpgradeFailureNote | undefined): note is UpgradeFailureNote {
  return note !== undefined && note.backup !== undefined && note.backup !== ''
}

export interface RestoreOrder {
  package: string
  requested_at: string
  by: string
}

/**
 * 下还原单。写完之后由调用方重启 sidecar：服务进程启动时看见这张单子，
 * 先把包导回数据目录再继续启动（`guardBeforeStart` 的第 ① 步）。
 */
export function requestRestore(input: {
  files: FileStore
  dataDir: string
  backup: string
  clock: Clock
  by?: string
}): RestoreOrder {
  const order: RestoreOrder = {
    package: input.backup,
    requested_at: input.clock.now(),
    by: input.by ?? 'tray',
  }
  input.files.writeText(
    joinPath(input.dataDir, RESTORE_REQUEST_FILE),
    `${JSON.stringify(order, null, 2)}\n`,
  )
  return order
}

/**
 * 拼路径。
 *
 * 为什么不用 `node:path`：本模块与 `paths.ts` 一样只做字符串拼装，而 Windows 上
 * `join` 会把 `/` 归一成 `\`，测试里两套断言就得分平台写。这里的输入只有
 * "数据目录 + 一个固定文件名"两段，自己判一次分隔符更直白。
 */
function joinPath(dir: string, name: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return dir.endsWith('/') || dir.endsWith('\\') ? `${dir}${name}` : `${dir}${sep}${name}`
}
