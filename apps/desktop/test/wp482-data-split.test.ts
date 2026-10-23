/**
 * WP482（决策 1643 改 B）：数据库与大文件分开选位置。
 *
 * 全部在临时目录里跑（路径带中文和空格），不碰真机的应用数据目录。钉住：
 * - 大文件那一格的检查：不提示网盘同步、网络盘照样提示（界面换话）、不许放进数据库目录里；
 *   数据库那一格不许放进大文件目录里；现在的大文件位置连不上就搬不了（source_missing）；
 * - 只搬大文件：不做备份、数据库目录一个字节不动、指针记 `blob_dir`、旧的 `blobs` 改名留 7 天（记成大文件那一格的）；
 * - 搬了大文件之后再搬数据库：留着的旧大文件目录不跟着搬，大文件仍在单独的位置；
 * - 大文件恢复默认位置：指针里不再记 `blob_dir`；
 * - 中途失败回到原来的大文件位置、指针不动；崩在半路下次启动按单子收拾；
 * - 「现在就删」只删这一格的；现在放大文件的地方永远不删；
 * - 服务进程只在大文件单独放时拿到 `AGENTSWS_BLOB_DIR`；大文件位置连不上时壳不拦。
 */
import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BLOBS_SUBDIR,
  checkDefaultBlobTarget,
  checkTarget,
  commitBlobDir,
  currentBlobDir,
  currentDataDir,
  customBlobDir,
  defaultBlobDir,
  defaultDataDir,
  dirReachable,
  latestRetired,
  measureDir,
  purgeRetired,
  RETIRED_MARK,
  readPointer,
  removeRetired,
  retiredInside,
  retireOldDir,
  writePointer,
} from '../src/data-location.js'
import {
  type DataMoveDeps,
  type DataMoveStatus,
  journalPath,
  recoverInterruptedMove,
  runDataMove,
} from '../src/data-move.js'
import { generateSecrets } from '../src/secrets.js'
import { type ServerSpawnInput, serverSpawnRequest } from '../src/server-process.js'
import { seqRandomBytes } from './fakes.js'

let root: string
let userData: string
let dataDir: string
let blobs: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp482 工坊-'))
  userData = join(root, '应用 数据')
  dataDir = defaultDataDir(userData)
  blobs = defaultBlobDir(dataDir)
  mkdirSync(dataDir, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = '2026-10-23T03:44:17.085Z'
const noSystem = { systemDirs: [] as string[] }

function seedData(): void {
  mkdirSync(join(blobs, 'knowledge', '录音 素材'), { recursive: true })
  mkdirSync(join(dataDir, 'backups'), { recursive: true })
  writeFileSync(join(dataDir, 'data.db'), randomBytes(200_000))
  writeFileSync(join(dataDir, 'secrets.sqlite'), randomBytes(8192))
  writeFileSync(join(blobs, 'knowledge', '录音 素材', '会议 1.webm'), randomBytes(300_000))
  writeFileSync(join(blobs, 'knowledge', '录音 素材', '会议 1.webm.meta.json'), '{"size":1}')
}

const tree = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {}
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const r = rel === '' ? name.name : join(rel, name.name)
      if (name.isDirectory()) walk(r)
      else if (name.isFile()) out[r] = readFileSync(join(dir, r)).toString('base64')
    }
  }
  walk('')
  return out
}

/** 假的「服务进程」：记下用哪个目录起的。 */
function harness(overrides: Partial<DataMoveDeps> & { from: string; to: string }) {
  const calls: string[] = []
  const statuses: DataMoveStatus[] = []
  const deps: DataMoveDeps = {
    userData,
    now: () => NOW,
    pause: async () => {
      calls.push('pause')
    },
    resume: async () => {
      calls.push('resume')
    },
    stopServices: async () => {
      calls.push('stop')
    },
    startServices: async (dir) => {
      calls.push(`start:${dir}`)
    },
    waitHealthy: async () => {
      calls.push('health')
      return true
    },
    onStatus: (s) => {
      statuses.push(s)
    },
    ...overrides,
  }
  return { deps, calls, statuses }
}

describe('大文件那一格的检查', () => {
  it('默认跟着数据库：在数据目录的 blobs 里；指针单独记了就用它', () => {
    expect(currentBlobDir(userData)).toBe(join(dataDir, BLOBS_SUBDIR))
    expect(customBlobDir(userData)).toBeUndefined()
    const nas = join(root, 'NAS 盘', '工坊 大文件')
    commitBlobDir({ userData, dir: nas, now: NOW })
    expect(currentBlobDir(userData)).toBe(nas)
    expect(customBlobDir(userData)).toBe(nas)
    // 数据库那一格不受影响
    expect(currentDataDir(userData)).toBe(dataDir)
    expect(readPointer(userData).dir).toBeUndefined()
    // 搬回数据目录下的 blobs = 默认位置，指针里不再记
    commitBlobDir({ userData, dir: blobs, now: NOW })
    expect(readPointer(userData).blob_dir).toBeUndefined()
  })

  it('不提示网盘同步；网络盘照样提示；不许放进数据库目录里', () => {
    seedData()
    const onedrive = join(root, 'OneDrive', '大文件')
    mkdirSync(onedrive, { recursive: true })
    const forBlobs = checkTarget({
      chosen: onedrive,
      current: blobs,
      userData,
      kind: 'blobs',
      other: dataDir,
      network: true,
      size: measureDir(blobs),
      ...noSystem,
    })
    expect(forBlobs.ok).toBe(true)
    expect(forBlobs.kind).toBe('blobs')
    expect(forBlobs.warnings).toEqual(['network'])
    // 同一个文件夹给数据库：网盘同步要提示
    const forDb = checkTarget({
      chosen: onedrive,
      current: dataDir,
      userData,
      network: true,
      ...noSystem,
    })
    expect(forDb.warnings).toEqual(['cloud_sync', 'network'])

    // 放进数据库目录里（搬数据库时会被一起抄走）：不让
    const inside = join(dataDir, '大文件 这里')
    mkdirSync(inside)
    const bad = checkTarget({
      chosen: inside,
      current: blobs,
      userData,
      kind: 'blobs',
      other: dataDir,
      ...noSystem,
    })
    expect(bad.ok).toBe(false)
    expect(bad.problems).toContain('inside_current')
  })

  it('数据库不许放进单独放的大文件目录里', () => {
    const nas = join(root, 'NAS', '大文件')
    const inNas = join(nas, '库 放这')
    mkdirSync(inNas, { recursive: true })
    const check = checkTarget({
      chosen: inNas,
      current: dataDir,
      userData,
      other: nas,
      ...noSystem,
    })
    expect(check.ok).toBe(false)
    expect(check.problems).toContain('inside_current')
  })

  it('恢复默认位置：现在的大文件位置连不上就搬不了；连得上、默认位置空着就行', () => {
    const nas = join(root, 'NAS', '大文件')
    const missing = checkDefaultBlobTarget({ userData, current: nas, dataDir })
    expect(missing.ok).toBe(false)
    expect(missing.problems).toContain('source_missing')
    expect(missing.target).toBe(blobs)
    mkdirSync(nas, { recursive: true })
    writeFileSync(join(nas, 'a.bin'), randomBytes(1000))
    const ok = checkDefaultBlobTarget({ userData, current: nas, dataDir, free: () => 1e12 })
    expect(ok).toMatchObject({ ok: true, target: blobs, bytes: 1000, files: 1, kind: 'blobs' })
    // 已经在默认位置
    expect(checkDefaultBlobTarget({ userData, current: blobs, dataDir }).problems).toContain(
      'same_place',
    )
  })

  it('数大小时能跳过子目录（数据库那一格不算跟着它放的大文件）', () => {
    seedData()
    const all = measureDir(dataDir)
    const dbOnly = measureDir(dataDir, [blobs])
    const blobOnly = measureDir(blobs)
    expect(dbOnly.bytes + blobOnly.bytes).toBe(all.bytes)
    expect(dbOnly.files + blobOnly.files).toBe(all.files)
  })
})

describe('只搬大文件', () => {
  it('成功：不做备份、数据库一个字节不动、指针记 blob_dir、旧的 blobs 改名留 7 天', async () => {
    seedData()
    const dbBefore = tree(dataDir)
    const blobsBefore = tree(blobs)
    const to = join(root, 'NAS 盘', '工坊 大文件')
    const h = harness({ kind: 'blobs', from: blobs, to })
    const result = await runDataMove(h.deps)
    expect(result).toMatchObject({ state: 'done', which: 'blobs', from: blobs, to })
    // 没有备份那一步
    expect(h.calls).toEqual(['pause', 'stop', `start:${to}`, 'health'])
    const steps = h.statuses.flatMap((s) => (s.state === 'running' ? [s.step] : []))
    expect(steps).not.toContain('backup')
    expect(h.statuses.every((s) => s.state === 'idle' || s.which === 'blobs')).toBe(true)
    // 大文件逐个对上
    expect(tree(to)).toEqual(blobsBefore)
    // 指针：大文件单独放了，数据库还是默认位置
    expect(readPointer(userData).blob_dir).toBe(to)
    expect(readPointer(userData).dir).toBeUndefined()
    expect(currentBlobDir(userData)).toBe(to)
    // 旧的 blobs 改名留在数据目录里，记成大文件那一格的
    expect(existsSync(blobs)).toBe(false)
    const old = latestRetired(userData, 'blobs')
    expect(old?.kind).toBe('blobs')
    expect(old?.path).toMatch(/blobs-moved-20261023-0344$/)
    expect(old?.until).toBe('2026-10-30T03:44:17.085Z')
    expect(existsSync(join(old?.path ?? '', RETIRED_MARK))).toBe(true)
    expect(latestRetired(userData)).toBeUndefined()
    // 数据库那一边除了旧 blobs 改了名，什么都没动
    const dbAfter = tree(dataDir)
    for (const [name, bytes] of Object.entries(dbBefore)) {
      if (name.startsWith(`${BLOBS_SUBDIR}/`) || name.startsWith(`${BLOBS_SUBDIR}\\`)) continue
      expect(dbAfter[name]).toBe(bytes)
    }
    expect(existsSync(journalPath(userData))).toBe(false)
  })

  it('中途失败（空间不够）：回到原来的大文件位置，新位置抄了一半的清掉，指针不动', async () => {
    seedData()
    const to = join(root, '外置 硬盘', '大文件')
    let n = 0
    const h = harness({
      kind: 'blobs',
      from: blobs,
      to,
      copyOptions: {
        beforeFile: () => {
          n += 1
          if (n === 2) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        },
      },
    })
    const result = await runDataMove(h.deps)
    expect(result).toMatchObject({
      state: 'failed',
      which: 'blobs',
      code: 'no_space',
      back_to: blobs,
      recovered: true,
    })
    expect(h.calls.at(-2)).toBe(`start:${blobs}`)
    expect(existsSync(to)).toBe(false)
    expect(readPointer(userData).blob_dir).toBeUndefined()
    expect(existsSync(join(blobs, 'knowledge'))).toBe(true)
  })

  it('搬了大文件之后再搬数据库：留着的旧大文件目录不跟着搬，大文件仍在单独的位置', async () => {
    seedData()
    const nas = join(root, 'NAS', '大文件')
    await runDataMove(harness({ kind: 'blobs', from: blobs, to: nas }).deps)
    const retiredBlobs = latestRetired(userData, 'blobs')?.path ?? ''
    expect(retiredInside(userData, dataDir)).toEqual([retiredBlobs])

    const newDb = join(root, '新 盘', 'agentsws-data')
    const h = harness({
      from: dataDir,
      to: newDb,
      backup: async () => undefined,
      copyOptions: { skip: retiredInside(userData, dataDir) },
    })
    const result = await runDataMove(h.deps)
    expect(result.state).toBe('done')
    expect(currentDataDir(userData)).toBe(newDb)
    // 大文件还在 NAS 上，指针没被搬数据库冲掉
    expect(currentBlobDir(userData)).toBe(nas)
    expect(readPointer(userData).blob_dir).toBe(nas)
    // 新数据库目录里没有旧大文件那一份
    expect(readdirSync(newDb).some((n) => n.startsWith('blobs'))).toBe(false)
    expect(existsSync(join(newDb, 'data.db'))).toBe(true)
  })

  it('大文件恢复默认位置：搬回数据目录下的 blobs，指针里不再记', async () => {
    const nas = join(root, 'NAS', '大文件')
    mkdirSync(nas, { recursive: true })
    writeFileSync(join(nas, '附件.pdf'), randomBytes(4000))
    commitBlobDir({ userData, dir: nas, now: NOW })
    const check = checkDefaultBlobTarget({ userData, current: nas, dataDir, free: () => 1e12 })
    expect(check.ok).toBe(true)
    const result = await runDataMove(harness({ kind: 'blobs', from: nas, to: check.target }).deps)
    expect(result.state).toBe('done')
    expect(readPointer(userData).blob_dir).toBeUndefined()
    expect(currentBlobDir(userData)).toBe(blobs)
    expect(existsSync(join(blobs, '附件.pdf'))).toBe(true)
    expect(latestRetired(userData, 'blobs')?.from).toBe(nas)
  })
})

describe('崩在半路，下次启动收拾（大文件那一格）', () => {
  it('指针还没写：新位置那份是这次建的就删掉，照旧用原来的大文件位置', () => {
    seedData()
    const to = join(root, 'NAS', '大文件')
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, 'half.bin'), 'x')
    writeFileSync(
      journalPath(userData),
      JSON.stringify({ kind: 'blobs', from: blobs, to, created_target: true, step: 'copy' }),
    )
    const out = recoverInterruptedMove({ userData, now: NOW })
    expect(out.action).toBe('dropped_partial_copy')
    expect(existsSync(to)).toBe(false)
    expect(currentBlobDir(userData)).toBe(blobs)
    expect(existsSync(join(blobs, 'knowledge'))).toBe(true)
  })

  it('指针已经写到新位置：用新位置，旧的 blobs 照常改名留 7 天（记成大文件那一格）', () => {
    seedData()
    const to = join(root, 'NAS', '大文件')
    mkdirSync(to, { recursive: true })
    commitBlobDir({ userData, dir: to, now: NOW })
    writeFileSync(
      journalPath(userData),
      JSON.stringify({ kind: 'blobs', from: blobs, to, created_target: true, step: 'finish' }),
    )
    const out = recoverInterruptedMove({ userData, now: NOW })
    expect(out.action).toBe('kept_new_retired_old')
    expect(existsSync(blobs)).toBe(false)
    expect(latestRetired(userData, 'blobs')?.from).toBe(blobs)
    expect(currentDataDir(userData)).toBe(dataDir)
  })
})

describe('旧目录：两格分开删；现在放大文件的地方永远不删', () => {
  it('「现在就删」只删这一格的', () => {
    const oldDb = join(root, 'data-moved-x')
    const oldBlobs = join(dataDir, 'blobs-moved-x')
    mkdirSync(oldDb, { recursive: true })
    mkdirSync(oldBlobs, { recursive: true })
    retireOldDir({ userData, dir: oldDb, now: NOW })
    retireOldDir({ userData, dir: oldBlobs, now: NOW, kind: 'blobs' })
    const dbEntry = latestRetired(userData)
    const blobEntry = latestRetired(userData, 'blobs')
    expect(dbEntry).toBeDefined()
    expect(blobEntry).toBeDefined()
    const removed = purgeRetired({ userData, now: NOW, force: true, kind: 'blobs' })
    expect(removed.map((r) => r.path)).toEqual([blobEntry?.path])
    expect(existsSync(blobEntry?.path ?? '')).toBe(false)
    expect(existsSync(dbEntry?.path ?? '')).toBe(true)
    expect(latestRetired(userData)).toBeDefined()
    // 到期了照样两格都清（启动时不带 kind）
    purgeRetired({ userData, now: '2026-11-30T00:00:00.000Z' })
    expect(existsSync(dbEntry?.path ?? '')).toBe(false)
  })

  it('清单里写的是现在放大文件的地方：不删', () => {
    const nas = join(root, 'NAS', '大文件')
    mkdirSync(nas, { recursive: true })
    writeFileSync(join(nas, RETIRED_MARK), '{}')
    commitBlobDir({ userData, dir: nas, now: NOW })
    const entry = { kind: 'blobs' as const, path: nas, from: nas, until: NOW }
    writePointer(userData, { ...readPointer(userData), retired: [entry] })
    expect(removeRetired({ userData, entry })).toBe(false)
    expect(existsSync(nas)).toBe(true)
  })

  it('老指针（WP480 写的、没有 kind）读出来都算数据库那一格', () => {
    const old = join(root, 'data-moved-old')
    mkdirSync(old)
    writeFileSync(
      join(userData, 'data-location.json'),
      JSON.stringify({ version: 1, retired: [{ path: old, from: dataDir, until: NOW }] }),
    )
    expect(latestRetired(userData)?.path).toBe(old)
    expect(latestRetired(userData, 'blobs')).toBeUndefined()
    expect(readPointer(userData).blob_dir).toBeUndefined()
  })
})

describe('服务进程拿到的大文件位置', () => {
  const secrets = generateSecrets(seqRandomBytes())
  const input = (patch: Partial<ServerSpawnInput> = {}): ServerSpawnInput => ({
    runtime: { kind: 'node', execPath: '/usr/local/bin/node' },
    entry: '/opt/server/dist/index.js',
    port: 4904,
    dataDir: '/data',
    halt: [],
    secrets,
    version: '0.1.0',
    baseEnv: { PATH: '/usr/bin' },
    ...patch,
  })

  it('单独放了才给 AGENTSWS_BLOB_DIR；跟着数据库时不给（服务进程用 <数据目录>/blobs）', () => {
    const nas = 'Z:\\工坊 大文件'
    expect(serverSpawnRequest(input({ blobDir: nas })).env.AGENTSWS_BLOB_DIR).toBe(nas)
    expect(serverSpawnRequest(input()).env.AGENTSWS_BLOB_DIR).toBeUndefined()
    expect(serverSpawnRequest(input({ blobDir: nas })).env.AGENTSWS_DB_DIR).toBe('/data')
  })

  it('大文件位置连不上认得出（壳只记一行，不拦）', () => {
    expect(dirReachable(join(root, '没插的硬盘'))).toBe(false)
    expect(dirReachable(dataDir)).toBe(true)
  })
})

describe('接线：桥、主进程', () => {
  const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  it('preload：每个方法多一个 which，只认 blobs，其余当数据库', () => {
    const preload = read('src/preload.cts')
    expect(preload).toContain("which === 'blobs' ? 'blobs' : 'database'")
    expect(preload).toContain("to === 'default' ? 'default' : 'chosen'")
  })

  it('主进程：按指针给服务进程大文件位置；大文件连不上不弹框拦人；只搬大文件时不做备份', () => {
    const main = read('src/main.ts')
    expect(main).toContain('let serverBlobDir = customBlobDir(paths.userData)')
    expect(main).toContain('...(serverBlobDir === undefined ? {} : { blobDir: serverBlobDir })')
    // 打不开就弹框的只有数据库那一格
    expect(main).not.toMatch(/while \([^)]*dirReachable\(serverBlobDir/)
    expect(main).toMatch(/which === 'blobs'\s*\?\s*\{\}\s*:\s*\{\s*backup:/)
    expect(main).toContain(
      "const kindOf = (raw: unknown): DataLocationKind => (raw === 'blobs' ? 'blobs' : 'database')",
    )
  })
})
