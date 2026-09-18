/**
 * 升级前先备份，迁移失败就不启动（WP111；13 §5「更新前跑一次冒烟；失败回滚」）。
 *
 * 起因很具体：一位非技术的内测用户，装的是一个还在频繁升级的东西。升级出事的时候，
 * 她唯一需要确认的一句话是「**我的数据还在吗**」。所以这一层只做三件事，每件都能
 * 用一句话向她解释：
 *
 * 1. **要动数据之前，先留一份完整的**。各库的迁移是在 `createServer()` 里各自跑的
 *    （每个 store 构造时调自己的 `migrate`），所以这道闸摆在**进程入口**，
 *    在 `createServer()` 之前：判定"这次会不会动数据"，会动就先 `runBackup`。
 * 2. **迁移失败就不启动**，并留下一张纸条：出了什么事、数据动没动、备份在哪。
 *    半启动比不启动糟得多——她会以为能用，然后往一个坏掉的库里写东西。
 * 3. **还原是一个动作**：托盘写一张 `restore-request.json`，进程下次启动看见它就
 *    先把那个包导回去再启动。不给桌面壳一条"自己去解 zip"的路——那是在一个
 *    已经出事的机器上再加一处可能出事的地方。
 *
 * ## 「会不会动数据」怎么判
 *
 * 两条判据，取并集（宁可多备一份）：
 *
 * - **迁移版本将前进**：`SCHEMA_TARGETS` 里登记的库，磁盘上的版本 < 代码里的最高版本。
 *   这是精确的那一条，但只覆盖得了能静态 import 到迁移数组的那几个包。
 * - **发行版号变了**：上次成功启动记的 `release` 与这次不一样。这是兜底的那一条——
 *   覆盖全部库，代价是没有迁移的版本也会白备一份。
 *
 * 为什么不做成"全精确"：各包的迁移数组大多是模块私有的，为了这道闸把它们全导出去，
 * 等于为了一个判定在十几个包上开口子，而那些口子将来一定会有人忘了同步。
 * 一份多余的备份的代价是几十 MB 磁盘；一次漏掉的备份的代价是她的数据。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import type { Clock, Iso8601, WorkspaceId } from '@agentsws/contracts'
import { MIGRATIONS as TXN_MIGRATIONS } from '@agentsws/txn'
import { WORK_MIGRATIONS } from '@agentsws/work'
import type BetterSqlite3 from 'better-sqlite3'
import {
  type BackupRunInput,
  type BackupRunResult,
  backupDirOf,
  backupKeepOf,
  importWorkspace,
  runBackup,
} from './backup.js'

/** 上一次成功启动时的样子。桌面壳的诊断包也读它（迁移版本表那一栏）。 */
export const UPGRADE_STATE_FILE = 'upgrade-state.json'
/** 迁移失败时留下的纸条。托盘看见它就说"升级没成功，数据没动，备份在 X"。 */
export const UPGRADE_FAILED_FILE = 'upgrade-failed.json'
/** 托盘按下「还原上一份备份」写的那张单子。进程下次启动先办它。 */
export const RESTORE_REQUEST_FILE = 'restore-request.json'

/** 升级前的自动备份**只留最近 5 份**（日常备份那条线仍是 `AGENTSWS_BACKUP_KEEP`）。 */
export const UPGRADE_BACKUP_KEEP = 5

/**
 * 各库当前代码里的最高迁移版本。
 *
 * 只登记**能静态 import 到迁移数组**的那几个；登记不了的靠 `release` 变化兜底
 * （见文件头）。加一条的成本是一行 import——欢迎后来人往里加。
 */
export const SCHEMA_TARGETS: Readonly<Record<string, number>> = {
  'work.sqlite': maxVersion(WORK_MIGRATIONS),
  'txn.sqlite': maxVersion(TXN_MIGRATIONS),
}

function maxVersion(migrations: readonly { version: number }[]): number {
  return migrations.reduce((n, m) => Math.max(n, m.version), 0)
}

export interface UpgradeState {
  /** 上次成功启动时的发行版号（`AGENTSWS_VERSION`）。 */
  release: string
  at: Iso8601
  /** 库文件名 → 磁盘上的 `_migrations` 最高版本。 */
  versions: Record<string, number>
}

export interface SchemaAdvance {
  file: string
  from: number
  to: number
}

export interface UpgradePlan {
  /** 这台机器上第一次跑这道闸（没有 state 文件）。 */
  firstRun: boolean
  /** 数据目录里一个库都没有 —— 全新安装，没有可丢的东西。 */
  empty: boolean
  releaseChanged: boolean
  previousRelease: string | undefined
  advances: SchemaAdvance[]
  /** 要不要在跑迁移之前先备份。 */
  backupNeeded: boolean
  /** 给日志与托盘的那一句人话。 */
  reason: string
}

// ── 读磁盘上的迁移版本 ─────────────────────────────────────────────────

const SQLITE_EXT = ['.db', '.sqlite']

/** 数据目录顶层的库文件（WAL / SHM 边角不算）。 */
export function schemaFiles(dataDir: string): string[] {
  if (!existsSync(dataDir)) return []
  return readdirSync(dataDir)
    .filter((name) => SQLITE_EXT.some((ext) => name.endsWith(ext)))
    .sort()
}

function openReadonly(path: string): BetterSqlite3.Database {
  const require = createRequire(import.meta.url)
  const Database = require('better-sqlite3') as typeof BetterSqlite3
  return new Database(path, { readonly: true })
}

/**
 * 每个库的 `_migrations` 最高版本。
 *
 * **只读打开**，而且读不出来就当 0 —— 这道闸自己绝不能成为"打不开就起不来"的原因。
 * 库坏了该由真正打开它的那一步去报，不该由一个做备份判定的函数去报。
 */
export function readSchemaVersions(dataDir: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of schemaFiles(dataDir)) {
    let db: BetterSqlite3.Database | undefined
    try {
      db = openReadonly(join(dataDir, name))
      const has = (
        db
          .prepare(
            "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='_migrations'",
          )
          .get() as { n: number }
      ).n
      const row =
        has === 0
          ? undefined
          : (db.prepare('SELECT MAX(version) AS v FROM _migrations').get() as
              | { v: number | null }
              | undefined)
      out[name] = row?.v ?? 0
    } catch {
      out[name] = 0
    } finally {
      db?.close()
    }
  }
  return out
}

/** 从 `identity.sqlite` 里问工作区 id（备份包的清单要它）。问不到就 undefined。 */
export function workspaceIdOf(dataDir: string): WorkspaceId | undefined {
  const path = join(dataDir, 'identity.sqlite')
  if (!existsSync(path)) return undefined
  let db: BetterSqlite3.Database | undefined
  try {
    db = openReadonly(path)
    const row = db.prepare('SELECT id FROM workspaces ORDER BY id LIMIT 1').get() as
      | { id: string }
      | undefined
    return row?.id as WorkspaceId | undefined
  } catch {
    return undefined
  } finally {
    db?.close()
  }
}

// ── 判定 ───────────────────────────────────────────────────────────────

export function readUpgradeState(dataDir: string): UpgradeState | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, UPGRADE_STATE_FILE), 'utf8')) as UpgradeState
    if (typeof raw.release !== 'string') return undefined
    return { release: raw.release, at: raw.at, versions: raw.versions ?? {} }
  } catch {
    return undefined
  }
}

export function planUpgrade(input: {
  state: UpgradeState | undefined
  versions: Record<string, number>
  release: string
  targets?: Readonly<Record<string, number>>
}): UpgradePlan {
  const targets = input.targets ?? SCHEMA_TARGETS
  const empty = Object.keys(input.versions).length === 0
  const firstRun = input.state === undefined
  const previousRelease = input.state?.release
  const releaseChanged = previousRelease !== undefined && previousRelease !== input.release

  const advances: SchemaAdvance[] = []
  for (const [file, target] of Object.entries(targets)) {
    const from = input.versions[file]
    if (from === undefined) continue
    if (target > from) advances.push({ file, from, to: target })
  }

  // 全新安装：没有可丢的东西，备份一个空目录没有意义。
  // 有数据但**没有** state 文件（WP111 之前装的那些）：不知道上一版是什么，按"会动"算。
  const backupNeeded = !empty && (firstRun || releaseChanged || advances.length > 0)
  const reason = empty
    ? '数据目录是空的，全新安装'
    : advances.length > 0
      ? `迁移版本将前进：${advances.map((a) => `${a.file} ${a.from}→${a.to}`).join('、')}`
      : releaseChanged
        ? `版本从 ${previousRelease as string} 升到 ${input.release}`
        : firstRun
          ? '这台机器上第一次跑升级闸，上一版是什么不知道'
          : '没有要动数据的迹象'
  return { firstRun, empty, releaseChanged, previousRelease, advances, backupNeeded, reason }
}

// ── 备份文件名带旧版本号 ────────────────────────────────────────────────

/**
 * `runBackup` 出的名字是 `agentsws-<ws>-<时间戳>.zip`；升级前那一份在尾巴上补一段
 * `-from-<旧版本>`。为什么是尾巴：`runBackup` 的保留策略按**前缀**筛、按**名字**排序，
 * 时间戳还在前面，所以补在后面既不影响筛也不影响排。
 */
export function upgradeBackupName(original: string, previousRelease: string): string {
  const safe = previousRelease.replace(/[^0-9A-Za-z._-]/g, '_')
  return original.replace(/\.zip$/, `-from-${safe}.zip`)
}

/** 升级前那一份**只保留最近 5 份**：按名字排序（= 按时间），多出来的从旧到新删。 */
export function pruneUpgradeBackups(dir: string, keep = UPGRADE_BACKUP_KEEP): string[] {
  if (!existsSync(dir)) return []
  const mine = readdirSync(dir)
    .filter((f) => /-from-.+\.zip$/.test(f))
    .sort()
  const doomed = mine.slice(0, Math.max(0, mine.length - Math.max(1, keep)))
  for (const f of doomed) rmSync(join(dir, f), { force: true })
  return doomed
}

// ── 失败纸条与还原单 ───────────────────────────────────────────────────

/**
 * 卡在哪一步。两步的**下一步动作不一样**，所以不能糊成一句"升级失败"：
 *
 * - `backup` —— 连升级前那份备份都没做成（磁盘满、库已经坏了）。这时**迁移一步没跑**，
 *   数据是升级前的样子。该做的是腾磁盘 / 导诊断包，不是"还原"。
 * - `migrate` —— 备份好了，建服务时炸了。该做的是还原那一份。
 */
export type UpgradeFailureStage = 'backup' | 'migrate'

export interface UpgradeFailure {
  at: Iso8601
  release: string
  previous_release?: string
  stage: UpgradeFailureStage
  /** 出了什么事（已经是给人看的一句话 + 原始错误）。 */
  error: string
  /** 升级前那一份备份落在哪；没备份过就没有这一项。 */
  backup?: string
  /** 迁移动过数据没有。这道闸的整个意义就是让这一格永远是 false。 */
  data_touched: boolean
}

export function writeUpgradeFailure(dataDir: string, failure: UpgradeFailure): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, UPGRADE_FAILED_FILE), `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
}

export function readUpgradeFailure(dataDir: string): UpgradeFailure | undefined {
  try {
    return JSON.parse(readFileSync(join(dataDir, UPGRADE_FAILED_FILE), 'utf8')) as UpgradeFailure
  } catch {
    return undefined
  }
}

export function clearUpgradeFailure(dataDir: string): void {
  rmSync(join(dataDir, UPGRADE_FAILED_FILE), { force: true })
}

export interface RestoreRequest {
  /** 要还原哪一个包（绝对路径）。 */
  package: string
  requested_at: Iso8601
  /** 谁下的单（`tray` = 托盘那个按钮）。 */
  by: string
}

export function writeRestoreRequest(dataDir: string, request: RestoreRequest): void {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(
    join(dataDir, RESTORE_REQUEST_FILE),
    `${JSON.stringify(request, null, 2)}\n`,
    'utf8',
  )
}

export function readRestoreRequest(dataDir: string): RestoreRequest | undefined {
  try {
    const raw = JSON.parse(
      readFileSync(join(dataDir, RESTORE_REQUEST_FILE), 'utf8'),
    ) as RestoreRequest
    return typeof raw.package === 'string' && raw.package !== '' ? raw : undefined
  } catch {
    return undefined
  }
}

/**
 * 最近一份升级前备份（托盘「还原上一份备份」默认选它）。
 *
 * 只认带 `-from-` 的那些：日常的每日备份不该被"还原上一份"这个按钮选中——
 * 用户按它的时候心里想的是"回到升级之前"，不是"回到昨天"。
 */
export function latestUpgradeBackup(backupDir: string): string | undefined {
  if (!existsSync(backupDir)) return undefined
  const mine = readdirSync(backupDir)
    .filter((f) => /-from-.+\.zip$/.test(f))
    .sort()
  const last = mine[mine.length - 1]
  return last === undefined ? undefined : join(backupDir, last)
}

// ── 闸本体 ─────────────────────────────────────────────────────────────

export interface UpgradeGuardInput {
  dataDir: string
  release: string
  clock: Clock
  env: Record<string, string | undefined>
  /** 测试用的注入口；不给就是真的 `runBackup` / `importWorkspace`。 */
  backup?: (input: BackupRunInput) => BackupRunResult
  restore?: (input: { pkg: string; dataDir: string }) => Promise<void>
  log?: (line: string) => void
}

export interface UpgradeGuardReport {
  plan: UpgradePlan
  /** 这次备份落在哪（没备份就没有）。 */
  backup?: string
  /** 这次还原了哪一个包（没还原就没有）。 */
  restored?: string
  versions: Record<string, number>
}

/**
 * 在 `createServer()` **之前**跑：先办还原单，再按判定决定要不要备份。
 *
 * 这一层不认识服务进程，也不碰迁移本身——迁移是各个 store 构造时自己跑的。
 * 它只保证"跑之前有一份完好的"。
 */
export async function guardBeforeStart(input: UpgradeGuardInput): Promise<UpgradeGuardReport> {
  const dataDir = resolve(input.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const log = input.log ?? (() => undefined)

  // ① 还原单：出事之后用户按了托盘那个按钮。先办它，再谈别的。
  let restored: string | undefined
  const request = readRestoreRequest(dataDir)
  if (request !== undefined) {
    log(`收到还原请求：${request.package}`)
    const restore =
      input.restore ??
      (async (r) => {
        await importWorkspace({ pkg: r.pkg, dataDir: r.dataDir, force: true })
      })
    await restore({ pkg: request.package, dataDir })
    restored = request.package
    rmSync(join(dataDir, RESTORE_REQUEST_FILE), { force: true })
    clearUpgradeFailure(dataDir)
    log(`已还原：${request.package}`)
  }

  // ② 这次会不会动数据
  const versions = readSchemaVersions(dataDir)
  const state = readUpgradeState(dataDir)
  const plan = planUpgrade({ state, versions, release: input.release })
  log(`升级闸：${plan.reason}`)
  if (!plan.backupNeeded) return { plan, versions, ...(restored === undefined ? {} : { restored }) }

  // ③ 备份。**备份失败就不往下走**——这道闸存在的全部意义就是"动之前先留一份"，
  //    留不成还照样跑迁移，等于把闸拆了还留着门框。
  const workspace_id = workspaceIdOf(dataDir) ?? ('ws_unknown' as WorkspaceId)
  const outDir = backupDirOf(input.env, dataDir)
  const previous = plan.previousRelease ?? 'unknown'
  const run = input.backup ?? runBackup
  const result = run({
    dataDir,
    workspace_id,
    outDir,
    clock: input.clock,
    // 升级前这一份自己数自己的（5 份）；日常备份那条线仍看 AGENTSWS_BACKUP_KEEP
    keep: Math.max(backupKeepOf(input.env), UPGRADE_BACKUP_KEEP),
    release: previous,
  })
  const named = join(outDir, upgradeBackupName(basename(result.out), previous))
  renameSync(result.out, named)
  pruneUpgradeBackups(outDir)
  log(`升级前已备份：${named}（${result.bytes} 字节，${result.events} 条事件）`)
  return { plan, versions, backup: named, ...(restored === undefined ? {} : { restored }) }
}

/** 启动成功之后记一笔：下次就知道上一版是什么、各库到哪一版了。 */
export function recordUpgradeSuccess(input: {
  dataDir: string
  release: string
  clock: Clock
}): UpgradeState {
  const dataDir = resolve(input.dataDir)
  const state: UpgradeState = {
    release: input.release,
    at: input.clock.now(),
    // 迁移已经跑完了，这时候读到的才是"到了哪一版"
    versions: readSchemaVersions(dataDir),
  }
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, UPGRADE_STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  clearUpgradeFailure(dataDir)
  return state
}
