/**
 * WP480：用户自己选数据存放位置、壳自动搬家（`src/data-location.ts` / `src/data-move.ts`）。
 *
 * 全部在临时目录里跑（路径里故意带中文和空格），不碰真机的应用数据目录。钉住：
 * - 选的文件夹查得对：可写、空间够（× 1.2）、不在现在的数据目录里、不在应用目录 / 系统目录、网盘与网络盘提示；
 * - 搬家成功：逐文件核对、指针最后才写、旧目录改名留 7 天带纸条；
 * - 空间不够 / 不可写 / 中途失败 / 核对不上 / 新位置起不来：都回旧位置起、新位置抄了一半的清掉、指针不动；
 * - 备份做不成：一个进程都不停、什么都不动；
 * - 恢复默认位置；崩在半路下次启动收拾；到期的旧目录才删、没纸条的不删、现在的数据目录永远不删；
 * - 本机加密密钥不随数据搬：搬完用同一把钥匙还解得开。
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  checkDefaultTarget,
  checkTarget,
  commitDataDir,
  currentDataDir,
  DATA_SUBDIR,
  dataDirReachable,
  defaultDataDir,
  estimateSeconds,
  isInside,
  isUncPath,
  latestRetired,
  looksCloudSynced,
  measureDir,
  pointerPath,
  purgeRetired,
  RETIRED_MARK,
  readPointer,
  removeRetired,
  retireOldDir,
  samePath,
  systemDirs,
  targetFor,
  writePointer,
} from '../src/data-location.js'
import { driveIsNetwork, networkMountFor } from '../src/data-location-probe.js'
import {
  copyTree,
  type DataMoveDeps,
  DataMoveError,
  type DataMoveStatus,
  holdDuringMove,
  journalPath,
  readJournal,
  recoverInterruptedMove,
  runDataMove,
} from '../src/data-move.js'
import { nodeFileStore } from '../src/node-files.js'
import { createSecretVault } from '../src/secrets.js'
import { fakeSafeStorage, seqRandomBytes } from './fakes.js'

let root: string
let userData: string
let current: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp480 工坊-'))
  userData = join(root, '应用 数据')
  current = defaultDataDir(userData)
  mkdirSync(current, { recursive: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const NOW = '2026-10-23T03:44:17.085Z'

/** 造一份像样的数据目录：几个库文件、一个 blob 子目录（中文名）、一份备份。 */
function seedData(dir: string): void {
  mkdirSync(join(dir, 'blobs', '图片 素材'), { recursive: true })
  mkdirSync(join(dir, 'backups'), { recursive: true })
  writeFileSync(join(dir, 'data.db'), randomBytes(200_000))
  writeFileSync(join(dir, 'data.db-wal'), randomBytes(4096))
  writeFileSync(join(dir, 'secrets.sqlite'), randomBytes(8192))
  writeFileSync(join(dir, 'upgrade-state.json'), '{"release":"0.2.1-beta.11"}\n')
  writeFileSync(join(dir, 'blobs', '图片 素材', '封面 1.png'), randomBytes(50_000))
  writeFileSync(join(dir, 'backups', 'agentsws-ws_1-20261023T034417Z.zip'), randomBytes(30_000))
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

const noSystem = { systemDirs: [] as string[] }

describe('选的文件夹查得对', () => {
  it('空文件夹：就放它本身；带中文和空格照样行；估得出要多久', () => {
    seedData(current)
    const chosen = join(root, '新 位置', '工坊 数据')
    mkdirSync(chosen, { recursive: true })
    const check = checkTarget({ chosen, current, userData, ...noSystem })
    expect(check.ok).toBe(true)
    expect(check.target).toBe(chosen)
    expect(check.bytes).toBeGreaterThan(280_000)
    expect(check.files).toBe(6)
    expect(check.problems).toEqual([])
    expect(check.estimate_seconds).toBeGreaterThan(0)
  })

  it('不空的文件夹：放进它下面的 agentsws-data', () => {
    const chosen = join(root, 'D盘')
    mkdirSync(chosen)
    writeFileSync(join(chosen, '别的文件.txt'), 'x')
    expect(targetFor(chosen)).toBe(join(chosen, DATA_SUBDIR))
    const check = checkTarget({ chosen, current, userData, ...noSystem })
    expect(check.ok).toBe(true)
    expect(check.target).toBe(join(chosen, DATA_SUBDIR))
  })

  it('那里已经有一份 agentsws-data 且不空：不让', () => {
    const chosen = join(root, 'NAS')
    mkdirSync(join(chosen, DATA_SUBDIR), { recursive: true })
    writeFileSync(join(chosen, DATA_SUBDIR, 'data.db'), 'old')
    const check = checkTarget({ chosen, current, userData, ...noSystem })
    expect(check.ok).toBe(false)
    expect(check.problems).toContain('target_has_data')
  })

  it('就是现在的位置 / 在现在的数据目录里面 / 在应用目录里：不让', () => {
    expect(checkTarget({ chosen: current, current, userData, ...noSystem }).problems).toContain(
      'same_place',
    )
    const inner = join(current, '子目录')
    mkdirSync(inner)
    expect(checkTarget({ chosen: inner, current, userData, ...noSystem }).problems).toContain(
      'inside_current',
    )
    const logs = join(userData, 'logs')
    mkdirSync(logs)
    expect(checkTarget({ chosen: logs, current, userData, ...noSystem }).problems).toContain(
      'inside_app',
    )
    const app = join(root, 'Agents 工坊.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    expect(
      checkTarget({
        chosen: join(app, 'Contents'),
        current,
        userData,
        appDirs: [app],
        ...noSystem,
      }).problems,
    ).toContain('inside_app')
  })

  it('系统目录：不让', () => {
    const sys = join(root, 'Windows')
    mkdirSync(join(sys, 'System32'), { recursive: true })
    const check = checkTarget({
      chosen: join(sys, 'System32'),
      current,
      userData,
      systemDirs: [sys],
    })
    expect(check.problems).toContain('system_dir')
    // 各平台的清单里有该有的
    expect(systemDirs('win32', { SystemRoot: 'C:\\Windows' })).toContain('C:\\Windows')
    expect(systemDirs('win32', {})).toContain('C:\\Program Files')
    expect(systemDirs('darwin', {})).toContain('/System')
    expect(systemDirs('linux', {})).toContain('/usr')
  })

  it('写不进去 / 空间不够（× 1.2）：不让', () => {
    seedData(current)
    const chosen = join(root, '只读')
    mkdirSync(chosen)
    const size = measureDir(current)
    expect(
      checkTarget({ chosen, current, userData, writable: () => false, ...noSystem }).problems,
    ).toContain('not_writable')
    const tight = checkTarget({
      chosen,
      current,
      userData,
      free: () => Math.floor(size.bytes * 1.1),
      ...noSystem,
    })
    expect(tight.problems).toContain('no_space')
    expect(tight.free_bytes).toBe(Math.floor(size.bytes * 1.1))
    expect(
      checkTarget({ chosen, current, userData, free: () => size.bytes * 2, ...noSystem }).ok,
    ).toBe(true)
  })

  it('文件夹不存在：不让', () => {
    const check = checkTarget({ chosen: join(root, '没有'), current, userData, ...noSystem })
    expect(check.problems).toContain('not_found')
  })

  it('网盘同步文件夹、网络盘：能选，但要提示', () => {
    const cloud = join(root, 'OneDrive - 公司')
    mkdirSync(cloud)
    const check = checkTarget({ chosen: cloud, current, userData, ...noSystem })
    expect(check.ok).toBe(true)
    expect(check.warnings).toEqual(['cloud_sync'])
    const nas = join(root, 'nas')
    mkdirSync(nas)
    const viaNas = checkTarget({ chosen: nas, current, userData, network: true, ...noSystem })
    expect(viaNas.ok).toBe(true)
    expect(viaNas.warnings).toEqual(['network'])
    // 网络盘估得慢一些
    expect(estimateSeconds({ bytes: 500 * 1024 ** 2, files: 10 }, true)).toBeGreaterThan(
      estimateSeconds({ bytes: 500 * 1024 ** 2, files: 10 }, false),
    )
    for (const p of [
      'C:\\Users\\a\\OneDrive\\x',
      '/Users/a/Library/Mobile Documents/com~apple~CloudDocs/x',
      '/Users/a/Library/CloudStorage/GoogleDrive-a/x',
      'D:\\百度网盘\\x',
      'D:\\坚果云\\x',
      '/Users/a/Dropbox/x',
    ])
      expect(looksCloudSynced(p)).toBe(true)
    expect(looksCloudSynced('D:\\工坊数据')).toBe(false)
  })

  it('Windows：\\\\server\\share 当网络盘；盘符映射的问系统；路径不分大小写', async () => {
    expect(isUncPath('\\\\nas\\share\\工坊')).toBe(true)
    expect(isUncPath('Z:\\工坊')).toBe(false)
    expect(await driveIsNetwork('\\\\nas\\share', 'win32', async () => 'Fixed')).toBe(true)
    const calls: string[][] = []
    const exec = async (cmd: string, args: readonly string[]): Promise<string> => {
      calls.push([cmd, ...args])
      return 'Network\r\n'
    }
    expect(await driveIsNetwork('z:\\工坊 数据', 'win32', exec)).toBe(true)
    expect(calls[0]?.at(-1)).toContain("DriveInfo]::new('Z')")
    expect(await driveIsNetwork('D:\\工坊', 'win32', async () => 'Fixed')).toBe(false)
    expect(await driveIsNetwork('relative', 'win32', exec)).toBe(false)
    // 问不到当「不是」（不拦人）
    expect(
      await driveIsNetwork('Z:\\x', 'win32', async () => {
        throw new Error('no powershell')
      }),
    ).toBe(false)
    expect(samePath('C:\\Users\\A\\Data', 'c:/users/a/data\\')).toBe(true)
    expect(isInside('C:\\Users\\A\\Data\\x', 'c:\\users\\a\\data')).toBe(true)
    expect(isInside('C:\\Users\\A\\Database', 'c:\\users\\a\\data')).toBe(false)
  })

  it('macOS：/Volumes 下的 smb 挂载点当网络盘', async () => {
    const mount = [
      '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
      '//luoye@nas._smb._tcp.local/工坊 on /Volumes/工坊 (smbfs, nodev, nosuid, mounted by luoye)',
      '/dev/disk5s1 on /Volumes/移动硬盘 (exfat, local, nodev, nosuid, noowners)',
    ].join('\n')
    expect(networkMountFor('/Volumes/工坊/数据', mount)).toBe(true)
    expect(networkMountFor('/Volumes/移动硬盘/数据', mount)).toBe(false)
    expect(networkMountFor('/Users/a/数据', mount)).toBe(false)
    expect(await driveIsNetwork('/Volumes/工坊/x', 'darwin', async () => mount)).toBe(true)
    expect(await driveIsNetwork('/x', 'aix', async () => mount)).toBe(false)
  })
})

describe('复制 + 逐文件校验', () => {
  it('整份抄过去，中文名、子目录、符号链接都在；内容一字不差', async () => {
    seedData(current)
    mkdirSync(join(current, 'open-connector', 'node_modules', '.bin'), { recursive: true })
    writeFileSync(join(current, 'open-connector', 'host.mjs'), 'export {}')
    symlinkSync('../../host.mjs', join(current, 'open-connector', 'node_modules', '.bin', 'host'))
    const to = join(root, '新 位置')
    const phases: string[] = []
    const report = await copyTree(current, to, {
      onProgress: (p) => {
        phases.push(p.phase)
      },
    })
    expect(report.files).toBe(7)
    expect(report.links).toBe(1)
    expect(tree(to)).toEqual(tree(current))
    expect(phases).toContain('copy')
    expect(phases.at(-1)).toBe('verify')
  })

  it('抄完被人改坏了一个字节：核对拦得住（verify_failed）', async () => {
    seedData(current)
    const to = join(root, '新')
    await expect(
      copyTree(current, to, {
        beforeVerify: (dir) => {
          writeFileSync(join(dir, 'data.db'), Buffer.alloc(200_000, 1))
        },
      }),
    ).rejects.toMatchObject({ code: 'verify_failed' })
    await expect(
      copyTree(current, join(root, '新2'), {
        beforeVerify: (dir) => {
          writeFileSync(join(dir, 'upgrade-state.json'), 'short')
        },
      }),
    ).rejects.toMatchObject({ code: 'verify_failed' })
  })

  it('磁盘满 / 没权限：分别报 no_space / not_writable', async () => {
    seedData(current)
    const err = (code: string): Error => Object.assign(new Error(code), { code })
    await expect(
      copyTree(current, join(root, 'a'), {
        beforeFile: () => {
          throw err('ENOSPC')
        },
      }),
    ).rejects.toMatchObject({ code: 'no_space' })
    await expect(
      copyTree(current, join(root, 'b'), {
        beforeFile: () => {
          throw err('EACCES')
        },
      }),
    ).rejects.toMatchObject({ code: 'not_writable' })
    await expect(
      copyTree(current, join(root, 'c'), {
        beforeFile: () => {
          throw err('EIO')
        },
      }),
    ).rejects.toMatchObject({ code: 'copy_failed' })
  })
})

/** 一套假的「服务进程」：记下用哪个目录起的、停了几次。 */
function harness(overrides: Partial<DataMoveDeps> & { to: string }) {
  const calls: string[] = []
  const statuses: DataMoveStatus[] = []
  let running: string | undefined = current
  const deps: DataMoveDeps = {
    userData,
    from: current,
    now: () => NOW,
    pause: async () => {
      calls.push('pause')
    },
    resume: async () => {
      calls.push('resume')
    },
    backup: async () => {
      calls.push('backup')
    },
    stopServices: async () => {
      calls.push('stop')
      running = undefined
    },
    startServices: async (dir) => {
      calls.push(`start:${dir}`)
      running = dir
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
  return { deps, calls, statuses, running: () => running }
}

describe('搬家', () => {
  it('成功：暂停 → 备份 → 停 → 抄 + 核对 → 新位置起 → 健康 → 记下 → 旧目录改名留 7 天', async () => {
    seedData(current)
    const before = tree(current)
    const to = join(root, '新 位置', DATA_SUBDIR)
    const h = harness({ to })
    const result = await runDataMove(h.deps)
    expect(result.state).toBe('done')
    expect(h.calls).toEqual(['pause', 'backup', 'stop', `start:${to}`, 'health'])
    expect(h.running()).toBe(to)
    expect(tree(to)).toEqual(before)
    // 指针最后才写：指向新位置
    expect(currentDataDir(userData)).toBe(to)
    expect(readPointer(userData).dir).toBe(to)
    // 旧目录改了名、带纸条、记进清单，留 7 天
    expect(existsSync(current)).toBe(false)
    const old = latestRetired(userData)
    expect(old?.from).toBe(current)
    expect(old?.path).toMatch(/data-moved-20261023-0344$/)
    expect(old?.until).toBe('2026-10-30T03:44:17.085Z')
    expect(existsSync(join(old?.path ?? '', RETIRED_MARK))).toBe(true)
    expect(tree(old?.path ?? '')).toMatchObject(before)
    // 搬家单收掉了
    expect(existsSync(journalPath(userData))).toBe(false)
    // 进度一步一步报：有抄、有核对、最后是 done
    const steps = h.statuses.flatMap((s) => (s.state === 'running' ? [s.step] : []))
    for (const step of ['pause', 'backup', 'stop', 'copy', 'verify', 'start', 'check', 'finish'])
      expect(steps).toContain(step)
    expect(h.statuses.at(-1)).toMatchObject({ state: 'done', to, from: current })
  })

  it('备份做不成：一个进程都不停、什么都不动，暂停放开', async () => {
    seedData(current)
    const to = join(root, '新')
    const h = harness({
      to,
      backup: async () => {
        throw new Error('磁盘满了')
      },
    })
    const result = await runDataMove(h.deps)
    expect(result).toMatchObject({ state: 'failed', code: 'backup_failed', recovered: true })
    expect(h.calls).toEqual(['pause', 'resume'])
    expect(existsSync(to)).toBe(false)
    expect(readPointer(userData).dir).toBeUndefined()
  })

  it('空间不够（抄到一半满了）：回旧位置起，新位置抄了一半的清掉，指针不动', async () => {
    seedData(current)
    const before = tree(current)
    const to = join(root, '小 U 盘', DATA_SUBDIR)
    let n = 0
    const h = harness({
      to,
      copyOptions: {
        beforeFile: () => {
          n += 1
          if (n === 3) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })
        },
      },
    })
    const result = await runDataMove(h.deps)
    expect(result).toMatchObject({
      state: 'failed',
      code: 'no_space',
      step: 'copy',
      back_to: current,
      recovered: true,
    })
    expect(h.calls).toEqual(['pause', 'backup', 'stop', `start:${current}`, 'health'])
    expect(h.running()).toBe(current)
    expect(existsSync(to)).toBe(false)
    expect(tree(current)).toEqual(before)
    expect(readPointer(userData).dir).toBeUndefined()
    expect(existsSync(journalPath(userData))).toBe(false)
  })

  it('不可写：报 not_writable，回旧位置', async () => {
    seedData(current)
    const to = join(root, '只读盘')
    const h = harness({
      to,
      copyOptions: {
        beforeFile: () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
        },
      },
    })
    expect(await runDataMove(h.deps)).toMatchObject({ state: 'failed', code: 'not_writable' })
    expect(h.running()).toBe(current)
  })

  it('选的是一个空文件夹（不是这次建的）：失败时只清里面抄的，文件夹本身留着', async () => {
    seedData(current)
    const to = join(root, '我建的空文件夹')
    mkdirSync(to)
    const h = harness({
      to,
      copyOptions: {
        beforeFile: (rel) => {
          if (rel.includes('封面')) throw new Error('盘被拔了')
        },
      },
    })
    expect(await runDataMove(h.deps)).toMatchObject({ state: 'failed', code: 'copy_failed' })
    expect(existsSync(to)).toBe(true)
    expect(readdirSync(to)).toEqual([])
  })

  it('新位置起不来（健康检查没过）：停掉、回旧位置起，报 start_failed', async () => {
    seedData(current)
    const to = join(root, '新')
    let checks = 0
    const h = harness({
      to,
      waitHealthy: async () => {
        checks += 1
        return checks > 1
      },
    })
    const result = await runDataMove(h.deps)
    expect(result).toMatchObject({ state: 'failed', code: 'start_failed', recovered: true })
    expect(h.calls).toEqual(['pause', 'backup', 'stop', `start:${to}`, 'stop', `start:${current}`])
    expect(h.running()).toBe(current)
    expect(existsSync(to)).toBe(false)
    expect(readPointer(userData).dir).toBeUndefined()
    expect(existsSync(current)).toBe(true)
  })

  it('连旧位置都没起来：照实报 recovered=false（要人看一眼）', async () => {
    seedData(current)
    const h = harness({
      to: join(root, '新'),
      waitHealthy: async () => false,
    })
    expect(await runDataMove(h.deps)).toMatchObject({ state: 'failed', recovered: false })
  })

  it('服务进程停不干净：不抄，回旧位置', async () => {
    seedData(current)
    const to = join(root, '新')
    const h = harness({
      to,
      stopServices: async () => {
        throw new Error('15 秒没退')
      },
    })
    expect(await runDataMove(h.deps)).toMatchObject({ state: 'failed', code: 'unknown' })
    expect(existsSync(to)).toBe(false)
  })

  it('恢复默认位置：从自定义位置搬回 <userData>/data，指针里不再记目录', async () => {
    const custom = join(root, 'NAS 盘', DATA_SUBDIR)
    mkdirSync(custom, { recursive: true })
    seedData(custom)
    rmSync(current, { recursive: true, force: true })
    commitDataDir({ userData, dir: custom, now: NOW })
    expect(currentDataDir(userData)).toBe(custom)
    const check = checkDefaultTarget({ current: custom, userData, free: () => 10 ** 12 })
    expect(check.ok).toBe(true)
    expect(check.target).toBe(defaultDataDir(userData))
    const h = harness({ to: check.target, from: custom })
    const before = tree(custom)
    expect((await runDataMove(h.deps)).state).toBe('done')
    expect(readPointer(userData).dir).toBeUndefined()
    expect(currentDataDir(userData)).toBe(defaultDataDir(userData))
    expect(tree(defaultDataDir(userData))).toEqual(before)
    expect(latestRetired(userData)?.from).toBe(custom)
  })

  it('恢复默认位置：默认位置上已经有一份不明数据就不让；是我们留下的旧目录则不算', () => {
    const custom = join(root, '别处')
    mkdirSync(custom)
    seedData(custom)
    seedData(current)
    expect(checkDefaultTarget({ current: custom, userData }).problems).toContain('target_has_data')
    // 改名没成、原地留着的旧目录 → 记在清单里，不拦
    writePointer(userData, {
      version: 1,
      dir: custom,
      retired: [{ path: current, from: current, until: NOW }],
    })
    expect(checkDefaultTarget({ current: custom, userData }).problems).not.toContain(
      'target_has_data',
    )
    expect(checkDefaultTarget({ current: current, userData }).problems).toContain('same_place')
    expect(
      checkDefaultTarget({ current: custom, userData, writable: () => false, free: () => 1 })
        .problems,
    ).toEqual(expect.arrayContaining(['not_writable', 'no_space']))
  })

  it('本机加密密钥不随数据搬：搬完用 userData 里同一把钥匙还解得开', async () => {
    // 壳的 safeStorage 密文在 userData（不在数据目录里）
    const files = nodeFileStore()
    const vault = createSecretVault({
      files,
      path: join(userData, 'secrets.bin'),
      safeStorage: fakeSafeStorage(),
      randomBytes: seqRandomBytes(7),
    })
    const { secrets } = vault.loadOrCreate()
    // 服务进程拿这把钥匙加密过的一条凭据，躺在数据目录里
    const key = Buffer.from(secrets.serverSecretsKey, 'hex')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const sealed = Buffer.concat([cipher.update('邮箱应用专用密码', 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    writeFileSync(join(current, 'secret.bin'), Buffer.concat([iv, tag, sealed]))
    seedData(current)
    const to = join(root, '新 位置')
    expect((await runDataMove(harness({ to }).deps)).state).toBe('done')
    // 钥匙没动、没被抄走
    expect(existsSync(join(userData, 'secrets.bin'))).toBe(true)
    expect(existsSync(join(to, 'secrets.bin'))).toBe(false)
    const reloaded = createSecretVault({
      files,
      path: join(userData, 'secrets.bin'),
      safeStorage: fakeSafeStorage(),
      randomBytes: seqRandomBytes(99),
    }).loadOrCreate()
    expect(reloaded.created).toBe(false)
    const blob = readFileSync(join(to, 'secret.bin'))
    const decipher = createDecipheriv(
      'aes-256-gcm',
      Buffer.from(reloaded.secrets.serverSecretsKey, 'hex'),
      blob.subarray(0, 12),
    )
    decipher.setAuthTag(blob.subarray(12, 28))
    const plain = Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString(
      'utf8',
    )
    expect(plain).toBe('邮箱应用专用密码')
  })
})

describe('崩在半路，下次启动收拾', () => {
  it('抄到一半崩了（指针还指旧位置）：新位置那份是这次建的就删掉，照旧用旧位置', () => {
    seedData(current)
    const to = join(root, '新')
    mkdirSync(to)
    writeFileSync(join(to, 'data.db'), 'half')
    writeFileSync(
      journalPath(userData),
      JSON.stringify({ from: current, to, created_target: true, step: 'copy', started_at: NOW }),
    )
    const out = recoverInterruptedMove({ userData, now: NOW })
    expect(out.action).toBe('dropped_partial_copy')
    expect(existsSync(to)).toBe(false)
    expect(currentDataDir(userData)).toBe(current)
    expect(existsSync(journalPath(userData))).toBe(false)
  })

  it('指针已经写到新位置（崩在改名那一步）：用新位置，旧目录照常改名留 7 天', () => {
    seedData(current)
    const to = join(root, '新')
    mkdirSync(to)
    commitDataDir({ userData, dir: to, now: NOW })
    writeFileSync(
      journalPath(userData),
      JSON.stringify({ from: current, to, created_target: true, step: 'finish', started_at: NOW }),
    )
    const out = recoverInterruptedMove({ userData, now: NOW })
    expect(out.action).toBe('kept_new_retired_old')
    expect(existsSync(to)).toBe(true)
    expect(latestRetired(userData)?.from).toBe(current)
  })

  it('没有单子 / 单子读不懂：什么都不做', () => {
    expect(recoverInterruptedMove({ userData, now: NOW }).action).toBe('none')
    writeFileSync(journalPath(userData), 'not json')
    expect(readJournal(userData)).toBeUndefined()
    expect(recoverInterruptedMove({ userData, now: NOW }).action).toBe('none')
    expect(existsSync(journalPath(userData))).toBe(false)
  })
})

describe('旧目录：到期才删，没纸条不删，现在的数据目录永远不删', () => {
  it('没到期不删；到期删；「现在就删」不看到期', () => {
    seedData(current)
    const old = retireOldDir({ userData, dir: current, now: NOW })
    expect(purgeRetired({ userData, now: '2026-10-29T00:00:00.000Z' })).toEqual([])
    expect(existsSync(old.path)).toBe(true)
    expect(purgeRetired({ userData, now: '2026-10-31T00:00:00.000Z' })).toHaveLength(1)
    expect(existsSync(old.path)).toBe(false)
    expect(readPointer(userData).retired).toEqual([])

    const again = join(root, '另一份')
    mkdirSync(again)
    seedData(again)
    const entry = retireOldDir({ userData, dir: again, now: NOW })
    expect(purgeRetired({ userData, now: NOW, force: true })).toHaveLength(1)
    expect(existsSync(entry.path)).toBe(false)
  })

  it('目录里没有我们的纸条：不删（留在清单里）', () => {
    const stray = join(root, '用户自己的')
    mkdirSync(stray)
    writeFileSync(join(stray, '重要.docx'), 'x')
    writePointer(userData, {
      version: 1,
      retired: [{ path: stray, from: stray, until: '2026-01-01T00:00:00.000Z' }],
    })
    expect(purgeRetired({ userData, now: NOW, force: true })).toEqual([])
    expect(existsSync(join(stray, '重要.docx'))).toBe(true)
    expect(readPointer(userData).retired).toHaveLength(1)
  })

  it('清单里写的是现在的数据目录 / userData 本身：不删', () => {
    seedData(current)
    writeFileSync(join(current, RETIRED_MARK), '{}')
    const entry = { path: current, from: current, until: '2026-01-01T00:00:00.000Z' }
    expect(removeRetired({ userData, entry })).toBe(false)
    writeFileSync(join(userData, RETIRED_MARK), '{}')
    expect(
      removeRetired({ userData, entry: { path: userData, from: userData, until: entry.until } }),
    ).toBe(false)
    expect(existsSync(join(current, 'data.db'))).toBe(true)
  })

  it('已经不在的旧目录：从清单里拿掉', () => {
    writePointer(userData, {
      version: 1,
      retired: [{ path: join(root, '早没了'), from: 'x', until: NOW }],
    })
    purgeRetired({ userData, now: NOW })
    expect(readPointer(userData).retired).toEqual([])
    expect(
      removeRetired({ userData, entry: { path: join(root, '早没了'), from: 'x', until: NOW } }),
    ).toBe(true)
  })
})

describe('指针文件', () => {
  it('没有 / 坏了 = 默认位置；不在数据目录里', () => {
    expect(currentDataDir(userData)).toBe(defaultDataDir(userData))
    writeFileSync(pointerPath(userData), '{bad')
    expect(readPointer(userData)).toEqual({ version: 1, retired: [] })
    expect(pointerPath(userData).startsWith(`${defaultDataDir(userData)}${sep}`)).toBe(false)
    writeFileSync(
      pointerPath(userData),
      JSON.stringify({ dir: '  ', retired: [{ path: 1 }, { path: 'a', from: 'b', until: 'c' }] }),
    )
    expect(readPointer(userData)).toEqual({
      version: 1,
      retired: [{ path: 'a', from: 'b', until: 'c' }],
    })
  })

  it('自定义位置打不开（NAS 没挂上）：认得出来，不拿一个空目录顶上', () => {
    const nas = join(root, 'Volumes', 'NAS', DATA_SUBDIR)
    commitDataDir({ userData, dir: nas, now: NOW })
    expect(dataDirReachable(userData, currentDataDir(userData))).toBe(false)
    expect(existsSync(nas)).toBe(false)
    mkdirSync(nas, { recursive: true })
    expect(dataDirReachable(userData, nas)).toBe(true)
    expect(dataDirReachable(userData, defaultDataDir(userData))).toBe(true)
  })
})

describe('搬家期间别处的启动请求不执行', () => {
  it('moving 时 start / restart 只记一行；搬完照常', () => {
    const inner = { start: vi.fn(), restart: vi.fn(), stop: vi.fn(), name: 'server' }
    let moving = true
    const held: string[] = []
    const guarded = holdDuringMove(
      inner,
      () => moving,
      (w) => {
        held.push(w)
      },
    )
    guarded.start()
    guarded.restart()
    guarded.stop()
    expect(inner.start).not.toHaveBeenCalled()
    expect(inner.restart).not.toHaveBeenCalled()
    expect(inner.stop).toHaveBeenCalledTimes(1)
    expect(held).toEqual(['start', 'restart'])
    moving = false
    guarded.start()
    expect(inner.start).toHaveBeenCalledTimes(1)
    expect(guarded.name).toBe('server')
  })

  it('DataMoveError 带着原因码', () => {
    expect(new DataMoveError('no_space', 'x').code).toBe('no_space')
  })
})

describe('接线：桥、主进程、本机连接器', () => {
  const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

  it('preload 只在个人档挂 dataLocation，页面只能说 chosen / default', () => {
    const preload = read('src/preload.cts')
    expect(preload).toMatch(/info\.data_location !== true/)
    expect(preload).toMatch(/dataLocation: \{[\s\S]*get:[\s\S]*choose:[\s\S]*move:[\s\S]*onChange:/)
    expect(preload).toContain("to === 'default' ? 'default' : 'chosen'")
  })

  it('主进程：开机先收拾 / 清旧目录 / 按指针定目录；自定义位置打不开不起服务；搬家时拦退出', () => {
    const main = read('src/main.ts')
    const boot = main.indexOf('recoverInterruptedMove({')
    expect(boot).toBeGreaterThan(0)
    expect(main.indexOf('purgeRetired({ userData: paths.userData')).toBeGreaterThan(boot)
    expect(main).toContain('paths.serverDataDir = currentDataDir(paths.userData)')
    expect(main).toContain('dataDirReachable(paths.userData, paths.serverDataDir)')
    expect(main).toMatch(/if \(dataMoving\) \{\s*event\.preventDefault\(\)/)
    expect(main).toContain('holdDuringMove(')
    // 页面传不进路径：move 只认 'default'，其余走刚才 choose() 查过的那一个
    expect(main).toContain("const toDefault = raw === 'default'")
    // 本机连接器的数据目录每次现取
    expect(main).toContain('dataDir: () => paths.serverDataDir')
  })
})

describe('搬之前的备份走服务进程（与升级闸同一个 runBackup）', () => {
  it('POST /v1/backup/export，带会话与岗位；回包落在哪', async () => {
    const { createApiClient } = await import('../src/api-client.js')
    const seen: { url: string; method?: string; headers?: Record<string, string> }[] = []
    let body: unknown = { data: { out: '/数据/backups/agentsws-ws_1-x.zip', bytes: 1 } }
    let ok = true
    const api = createApiClient({
      baseUrl: 'http://127.0.0.1:4884',
      sessionKey: 's'.repeat(64),
      fetchImpl: async (url, init) => {
        seen.push({
          url,
          ...(init?.method === undefined ? {} : { method: init.method }),
          ...(init?.headers === undefined ? {} : { headers: init.headers }),
        })
        return {
          ok,
          status: ok ? 200 : 500,
          text: async () => JSON.stringify(body),
          headers: { get: () => null },
        }
      },
    })
    const session = { cookie: 'c=1', name: 'c', value: '1', person: { id: 'p', email: 'e' } }
    expect(await api.exportBackup?.(session, 'asg_1')).toEqual({
      ok: true,
      value: '/数据/backups/agentsws-ws_1-x.zip',
    })
    expect(seen[0]).toMatchObject({
      url: 'http://127.0.0.1:4884/v1/backup/export',
      method: 'POST',
      headers: { cookie: 'c=1', 'X-Assignment': 'asg_1' },
    })
    body = { data: {} }
    expect((await api.exportBackup?.(session, 'asg_1'))?.ok).toBe(false)
    ok = false
    body = { error: { message: '磁盘满了' } }
    expect(await api.exportBackup?.(session, 'asg_1')).toEqual({ ok: false, reason: '磁盘满了' })
  })
})
