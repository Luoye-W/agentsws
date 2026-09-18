/**
 * WP111 升级闸：动数据之前先备份、迁移失败不启动、还原是一个动作。
 *
 * 判定那几条用临时库真造一次"将前进"的迁移（不是 mock 一个数字）：
 * 建一个 `_migrations` 停在 v1 的 `txn.sqlite`，而代码里的 `MIGRATIONS` 到 v2 ——
 * 这就是升级时真实发生的那一幕。临时目录名带中文与空格（Windows 上的真实路径）。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Clock, WorkspaceId } from '@agentsws/contracts'
import type BetterSqlite3 from 'better-sqlite3'
import { afterAll, describe, expect, it } from 'vitest'
import type { BackupRunInput, BackupRunResult } from '../src/backup.js'
import {
  clearUpgradeFailure,
  guardBeforeStart,
  latestUpgradeBackup,
  planUpgrade,
  pruneUpgradeBackups,
  RESTORE_REQUEST_FILE,
  readRestoreRequest,
  readSchemaVersions,
  readUpgradeFailure,
  readUpgradeState,
  recordUpgradeSuccess,
  SCHEMA_TARGETS,
  schemaFiles,
  UPGRADE_FAILED_FILE,
  UPGRADE_STATE_FILE,
  upgradeBackupName,
  workspaceIdOf,
  writeRestoreRequest,
  writeUpgradeFailure,
} from '../src/upgrade-guard.js'

const require_ = createRequire(import.meta.url)
const Database = require_('better-sqlite3') as typeof BetterSqlite3

// 路径里带中文与空格：第一位内测用户用 Windows，`C:\Users\小雨 的电脑\…` 就是这样
const root = mkdtempSync(join(tmpdir(), 'agentsws 升级闸-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
function dataDir(): string {
  seq += 1
  const dir = join(root, `第 ${seq} 次`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const clock: Clock = { now: () => '2026-09-18T10:00:00.000Z' }

/** 造一个 `_migrations` 停在 `version` 的库。 */
function makeDb(dir: string, name: string, version: number | undefined): void {
  const db = new Database(join(dir, name))
  try {
    if (version !== undefined) {
      db.exec(
        'CREATE TABLE _migrations (version INTEGER PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL) STRICT;',
      )
      for (let v = 1; v <= version; v += 1)
        db.prepare('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)').run(
          v,
          clock.now(),
        )
    } else {
      db.exec('CREATE TABLE t (a TEXT);')
    }
  } finally {
    db.close()
  }
}

function makeIdentity(dir: string, workspaceId: string): void {
  const db = new Database(join(dir, 'identity.sqlite'))
  try {
    db.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL) STRICT;')
    db.prepare('INSERT INTO workspaces (id, json) VALUES (?, ?)').run(workspaceId, '{}')
  } finally {
    db.close()
  }
}

/** 假备份：真写一个 zip 名字的文件出来，好让改名 / 保留那几步有东西可动。 */
function fakeBackup(): (input: BackupRunInput) => BackupRunResult {
  return (input) => {
    mkdirSync(input.outDir, { recursive: true })
    const out = join(input.outDir, `agentsws-${input.workspace_id}-20260918T100000Z.zip`)
    writeFileSync(out, '假的包，够用来验改名与保留')
    return { out, bytes: 42, kept: 1, pruned: [], events: 7 }
  }
}

describe('readSchemaVersions / schemaFiles', () => {
  it('每个库读出它的 `_migrations` 最高版本', () => {
    const dir = dataDir()
    makeDb(dir, 'work.sqlite', 3)
    makeDb(dir, 'events.db', 1)
    writeFileSync(join(dir, 'connections.json'), '{}')
    expect(schemaFiles(dir)).toEqual(['events.db', 'work.sqlite'])
    expect(readSchemaVersions(dir)).toEqual({ 'events.db': 1, 'work.sqlite': 3 })
  })

  it('没有 `_migrations` 那张表 → 0，**不抛**', () => {
    const dir = dataDir()
    makeDb(dir, 'data.db', undefined)
    expect(readSchemaVersions(dir)).toEqual({ 'data.db': 0 })
  })

  it('库坏了也只当 0 —— 一个做备份判定的函数不该成为"起不来"的原因', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'broken.sqlite'), '这不是一个 SQLite 文件')
    expect(readSchemaVersions(dir)).toEqual({ 'broken.sqlite': 0 })
  })

  it('目录不存在 → 空', () => {
    expect(schemaFiles(join(root, '没有这个目录'))).toEqual([])
    expect(readSchemaVersions(join(root, '没有这个目录'))).toEqual({})
  })
})

describe('workspaceIdOf', () => {
  it('从 identity.sqlite 里问出工作区 id（备份包的清单要它）', () => {
    const dir = dataDir()
    makeIdentity(dir, 'ws_abc123')
    expect(workspaceIdOf(dir)).toBe('ws_abc123')
  })

  it('没有 identity.sqlite / 表结构不认识 → undefined，不抛', () => {
    expect(workspaceIdOf(dataDir())).toBeUndefined()
    const dir = dataDir()
    makeDb(dir, 'identity.sqlite', 1)
    expect(workspaceIdOf(dir)).toBeUndefined()
  })
})

describe('planUpgrade', () => {
  const state = (release: string) => ({ release, at: clock.now(), versions: {} })

  it('迁移版本将前进 → 要备份，理由里写清楚从几到几', () => {
    const plan = planUpgrade({
      state: state('0.1.0-beta.1'),
      versions: { 'work.sqlite': 1 },
      release: '0.1.0-beta.1',
      targets: { 'work.sqlite': 4 },
    })
    expect(plan.backupNeeded).toBe(true)
    expect(plan.advances).toEqual([{ file: 'work.sqlite', from: 1, to: 4 }])
    expect(plan.reason).toContain('work.sqlite 1→4')
  })

  it('版本号变了也备（兜底那一条：覆盖登记不到的库）', () => {
    const plan = planUpgrade({
      state: state('0.1.0-beta.1'),
      versions: { 'work.sqlite': 9 },
      release: '0.1.0-beta.2',
      targets: { 'work.sqlite': 9 },
    })
    expect(plan.backupNeeded).toBe(true)
    expect(plan.releaseChanged).toBe(true)
    expect(plan.advances).toEqual([])
    expect(plan.reason).toContain('0.1.0-beta.1')
  })

  it('同一版本、没有前进 → 不备（每次重启都备一份是噪音）', () => {
    const plan = planUpgrade({
      state: state('0.1.0-beta.1'),
      versions: { 'work.sqlite': 9 },
      release: '0.1.0-beta.1',
      targets: { 'work.sqlite': 9 },
    })
    expect(plan.backupNeeded).toBe(false)
  })

  it('全新安装（一个库都没有）→ 不备：没有可丢的东西', () => {
    const plan = planUpgrade({ state: undefined, versions: {}, release: '0.1.0-beta.1' })
    expect(plan.empty).toBe(true)
    expect(plan.backupNeeded).toBe(false)
  })

  it('有数据但没记录过（WP111 之前装的那些）→ 按"会动"算', () => {
    const plan = planUpgrade({
      state: undefined,
      versions: { 'work.sqlite': 1 },
      release: '0.1.0-beta.1',
      targets: {},
    })
    expect(plan.firstRun).toBe(true)
    expect(plan.backupNeeded).toBe(true)
  })

  it('登记表里有、但这台机器上还没有那个库 → 不算前进（第一次建库不是升级）', () => {
    const plan = planUpgrade({
      state: state('0.1.0-beta.1'),
      versions: { 'events.db': 1 },
      release: '0.1.0-beta.1',
      targets: { 'work.sqlite': 4 },
    })
    expect(plan.advances).toEqual([])
    expect(plan.backupNeeded).toBe(false)
  })

  it('SCHEMA_TARGETS 是从真的迁移数组算的，不是手抄的数字', () => {
    expect(SCHEMA_TARGETS['work.sqlite']).toBeGreaterThan(0)
    expect(SCHEMA_TARGETS['txn.sqlite']).toBeGreaterThan(0)
  })
})

describe('upgradeBackupName / pruneUpgradeBackups / latestUpgradeBackup', () => {
  it('文件名带旧版本号，时间戳还在前面（保留策略靠它排序）', () => {
    expect(upgradeBackupName('agentsws-ws_a-20260918T100000Z.zip', '0.1.0-beta.1')).toBe(
      'agentsws-ws_a-20260918T100000Z-from-0.1.0-beta.1.zip',
    )
  })

  it('版本号里的怪字符换成下划线（别让一个版本号把路径拆了）', () => {
    expect(upgradeBackupName('x.zip', '0.1.0/../etc')).toBe('x-from-0.1.0_.._etc.zip')
  })

  it('只留最近 5 份，从旧到新删；日常备份一个不碰', () => {
    const dir = dataDir()
    for (let i = 1; i <= 7; i += 1)
      writeFileSync(join(dir, `agentsws-ws_a-2026091${i}T100000Z-from-0.1.${i}.zip`), 'x')
    writeFileSync(join(dir, 'agentsws-ws_a-20260901T100000Z.zip'), '每日备份')

    const pruned = pruneUpgradeBackups(dir)
    expect(pruned).toHaveLength(2)
    expect(existsSync(join(dir, 'agentsws-ws_a-20260901T100000Z.zip'))).toBe(true)
    expect(existsSync(join(dir, 'agentsws-ws_a-20260911T100000Z-from-0.1.1.zip'))).toBe(false)
    expect(existsSync(join(dir, 'agentsws-ws_a-20260917T100000Z-from-0.1.7.zip'))).toBe(true)
  })

  it('「还原上一份」只认升级前那种 —— 用户按它想的是"回到升级之前"，不是"回到昨天"', () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'agentsws-ws_a-20260918T110000Z.zip'), '每日备份，更新')
    writeFileSync(join(dir, 'agentsws-ws_a-20260917T100000Z-from-0.1.0.zip'), '升级前')
    expect(latestUpgradeBackup(dir)).toBe(
      join(dir, 'agentsws-ws_a-20260917T100000Z-from-0.1.0.zip'),
    )
    expect(latestUpgradeBackup(join(root, '没有'))).toBeUndefined()
    expect(pruneUpgradeBackups(join(root, '没有'))).toEqual([])
  })
})

describe('失败纸条', () => {
  it('写 → 读 → 清', () => {
    const dir = dataDir()
    expect(readUpgradeFailure(dir)).toBeUndefined()
    writeUpgradeFailure(dir, {
      at: clock.now(),
      release: '0.1.0-beta.2',
      previous_release: '0.1.0-beta.1',
      stage: 'migrate',
      error: 'boom',
      backup: join(dir, 'b.zip'),
      data_touched: false,
    })
    expect(readUpgradeFailure(dir)?.data_touched).toBe(false)
    expect(readUpgradeFailure(dir)?.stage).toBe('migrate')
    expect(existsSync(join(dir, UPGRADE_FAILED_FILE))).toBe(true)
    clearUpgradeFailure(dir)
    expect(readUpgradeFailure(dir)).toBeUndefined()
  })
})

describe('guardBeforeStart', () => {
  it('真造一次"将前进"的迁移 → 先备份，文件名带旧版本号', async () => {
    const dir = dataDir()
    // `txn.sqlite` 代码里到 v2，磁盘上停在 v1 —— 这就是升级时真实发生的那一幕。
    // **版本号故意不变**，好让这条断言只由"迁移将前进"这一条撑着。
    expect(SCHEMA_TARGETS['txn.sqlite']).toBeGreaterThan(1)
    makeDb(dir, 'txn.sqlite', 1)
    makeIdentity(dir, 'ws_beta')
    recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.1', clock })

    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.1',
      clock,
      env: {},
      backup: fakeBackup(),
    })
    expect(report.plan.releaseChanged).toBe(false)
    expect(report.plan.backupNeeded).toBe(true)
    expect(report.plan.advances).toEqual([
      { file: 'txn.sqlite', from: 1, to: SCHEMA_TARGETS['txn.sqlite'] },
    ])
    expect(report.backup).toContain('-from-0.1.0-beta.1.zip')
    expect(existsSync(report.backup as string)).toBe(true)
  })

  it('只是版本号变了（迁移没前进）→ 照样备，兜底那一条', async () => {
    const dir = dataDir()
    makeDb(dir, 'txn.sqlite', SCHEMA_TARGETS['txn.sqlite'] as number)
    makeIdentity(dir, 'ws_beta')
    recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.1', clock })

    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.2',
      clock,
      env: {},
      backup: fakeBackup(),
    })
    expect(report.plan.advances).toEqual([])
    expect(report.plan.releaseChanged).toBe(true)
    expect(report.backup).toContain('-from-0.1.0-beta.1.zip')
  })

  it('没有要动数据的迹象 → 一个字节都不写', async () => {
    const dir = dataDir()
    makeDb(dir, 'events.db', 1)
    recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.1', clock })
    let called = 0
    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.1',
      clock,
      env: {},
      backup: () => {
        called += 1
        throw new Error('不该备份')
      },
    })
    expect(called).toBe(0)
    expect(report.backup).toBeUndefined()
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('**备份失败就不往下走** —— 留不成还照样跑迁移等于把闸拆了', async () => {
    const dir = dataDir()
    makeDb(dir, 'txn.sqlite', 1)
    await expect(
      guardBeforeStart({
        dataDir: dir,
        release: '0.1.0-beta.2',
        clock,
        env: {},
        backup: () => {
          throw new Error('磁盘满了')
        },
      }),
    ).rejects.toThrow('磁盘满了')
  })

  it('还原单：先办它，办完把单子与失败纸条一起清掉', async () => {
    const dir = dataDir()
    makeDb(dir, 'txn.sqlite', 1)
    writeUpgradeFailure(dir, {
      at: clock.now(),
      release: '0.1.0-beta.2',
      stage: 'migrate',
      error: 'boom',
      backup: join(dir, 'b.zip'),
      data_touched: false,
    })
    writeRestoreRequest(dir, {
      package: join(dir, 'b.zip'),
      requested_at: clock.now(),
      by: 'tray',
    })

    const restored: string[] = []
    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.2',
      clock,
      env: {},
      backup: fakeBackup(),
      restore: async (r) => {
        restored.push(r.pkg)
      },
    })
    expect(restored).toEqual([join(dir, 'b.zip')])
    expect(report.restored).toBe(join(dir, 'b.zip'))
    expect(existsSync(join(dir, RESTORE_REQUEST_FILE))).toBe(false)
    expect(readUpgradeFailure(dir)).toBeUndefined()
  })

  it('还原单坏了当没有（一个读不懂的 JSON 不该让服务起不来）', () => {
    const dir = dataDir()
    writeFileSync(join(dir, RESTORE_REQUEST_FILE), '{ 这不是 JSON')
    expect(readRestoreRequest(dir)).toBeUndefined()
    writeFileSync(join(dir, RESTORE_REQUEST_FILE), '{"package":""}')
    expect(readRestoreRequest(dir)).toBeUndefined()
  })

  it('备份目录听 AGENTSWS_BACKUP_DIR 的', async () => {
    const dir = dataDir()
    const elsewhere = join(root, '备份 放这儿')
    makeDb(dir, 'txn.sqlite', 1)
    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.2',
      clock,
      env: { AGENTSWS_BACKUP_DIR: elsewhere },
      backup: fakeBackup(),
    })
    expect(report.backup?.startsWith(elsewhere)).toBe(true)
  })
})

describe('recordUpgradeSuccess', () => {
  it('起来了才记：下次就知道上一版是什么、各库到了哪一版', () => {
    const dir = dataDir()
    makeDb(dir, 'work.sqlite', 2)
    const state = recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.3', clock })
    expect(state.release).toBe('0.1.0-beta.3')
    expect(state.versions['work.sqlite']).toBe(2)
    expect(readUpgradeState(dir)).toEqual(state)
    expect(JSON.parse(readFileSync(join(dir, UPGRADE_STATE_FILE), 'utf8')).release).toBe(
      '0.1.0-beta.3',
    )
  })

  it('记成功顺手把失败纸条清掉（这一版起来了，上一版的事翻篇）', () => {
    const dir = dataDir()
    writeUpgradeFailure(dir, {
      at: clock.now(),
      release: 'x',
      stage: 'migrate',
      error: 'boom',
      data_touched: false,
    })
    recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.3', clock })
    expect(readUpgradeFailure(dir)).toBeUndefined()
  })

  it('state 文件坏了当没有', () => {
    const dir = dataDir()
    writeFileSync(join(dir, UPGRADE_STATE_FILE), '不是 JSON')
    expect(readUpgradeState(dir)).toBeUndefined()
    writeFileSync(join(dir, UPGRADE_STATE_FILE), '{"release":1}')
    expect(readUpgradeState(dir)).toBeUndefined()
  })
})

describe('真备份 + 真还原走一遍（不注入替身）', () => {
  it('升级前的包能原样导回去', async () => {
    const dir = dataDir()
    makeDb(dir, 'txn.sqlite', 1)
    makeIdentity(dir, 'ws_real')
    recordUpgradeSuccess({ dataDir: dir, release: '0.1.0-beta.1', clock })

    const report = await guardBeforeStart({
      dataDir: dir,
      release: '0.1.0-beta.2',
      clock,
      env: {},
    })
    const pkg = report.backup as string
    expect(existsSync(pkg)).toBe(true)

    // 把库改坏，再按还原单起一次
    writeFileSync(join(dir, 'txn.sqlite'), '毁了')
    writeRestoreRequest(dir, { package: pkg, requested_at: clock.now(), by: 'tray' })
    await guardBeforeStart({ dataDir: dir, release: '0.1.0-beta.2', clock, env: {} })

    expect(readSchemaVersions(dir)['txn.sqlite']).toBe(1)
    expect(workspaceIdOf(dir)).toBe('ws_real' as WorkspaceId)
  })
})
