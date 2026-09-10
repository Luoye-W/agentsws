/**
 * 导出 / 导入 / 每日备份（WP36 交付 3；40 §1.3、33 §1「双向搬家」、15 §5.8）。
 *
 * 主线就是验收条那句话：**导出再导入的工作区事件链完整**——
 * 一台机器上跑出一堆真东西（成员、事项、待办、审批、凭据），导成一个包，
 * 在一个空目录里导回来，起服务进程，数得对上、链验得过、凭据文件里没有明文。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BACKUP_FORMAT,
  type BackupManifest,
  backupName,
  createServer,
  exportWorkspace,
  HANDLERS,
  importWorkspace,
  MANIFEST,
  runBackup,
  type Server,
  unzipTo,
  zipDir,
} from '../src/index.js'

const T0 = '2026-09-10T09:00:00.000Z'
/** 32 字节十六进制的假密钥；测试里从不用真凭据。 */
const SECRETS_KEY = 'a'.repeat(64)
const PLAINTEXT_PASSWORD = 'super-secret-mailbox-password-42'

function makeClock(start = T0) {
  let t = Date.parse(start)
  return {
    now: () => new Date(t).toISOString(),
    advance: (ms: number) => {
      t += ms
    },
  }
}

function seeded(seed = 13): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const temps: string[] = []
const live: Server[] = []
let clock: ReturnType<typeof makeClock>

const temp = (tag: string): string => {
  const dir = mkdtempSync(join(tmpdir(), `agentsws-${tag}-`))
  temps.push(dir)
  return dir
}

const boot = async (dbDir: string): Promise<Server> => {
  const s = await createServer({
    quiet: true,
    clock: { now: () => clock.now() },
    random: seeded(),
    scheduleIntervalMs: 0,
    dbDir,
    env: {
      AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
      AGENTSWS_SECRETS_KEY: SECRETS_KEY,
    },
  })
  live.push(s)
  return s
}

beforeEach(() => {
  clock = makeClock()
})

afterEach(async () => {
  for (const s of live.splice(0)) await s.close()
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 跑出一点真东西，回工作区 id 与几个可以数的数。 */
const populate = async (
  dbDir: string,
): Promise<{ workspace_id: string; todos: number; events: number }> => {
  const server = await boot(dbDir)
  const ws = server.bootstrap.workspace.id
  const matter = server.work.createMatter({ kind: 'conversation', title: '一件在办的事' })
  server.work.createTodo({
    title: '待办一',
    owner: server.bootstrap.person.id,
    matter_id: matter.id,
  })
  server.work.createTodo({ title: '待办二', owner: server.bootstrap.person.id })
  // 凭据：明文只在这一次出现，落盘的是 AES-256-GCM 密文
  server.secrets.put('mail:luoye@example.com', { password: PLAINTEXT_PASSWORD })
  const todos = server.work.listTodos().length
  const events = server.kernel.eventLog.readSync({ workspace_id: ws }).length
  await server.close()
  live.splice(live.indexOf(server), 1)
  return { workspace_id: ws, todos, events }
}

describe('40 §1.3 导出：一致性快照 + 清单 + 哈希', () => {
  it('导出成目录：每个库一个文件、每个文件一个 sha256、链头链尾都记下来', async () => {
    const dbDir = temp('data')
    const { workspace_id } = await populate(dbDir)
    const out = temp('pkg')

    const result = exportWorkspace({ dataDir: dbDir, workspace_id, out, clock })
    const manifest = JSON.parse(readFileSync(join(out, MANIFEST), 'utf8')) as BackupManifest

    expect(result.format).toBe('dir')
    expect(manifest.format).toBe(BACKUP_FORMAT)
    expect(manifest.workspace_id).toBe(workspace_id)
    expect(manifest.files.map((f) => f.name)).toContain('events.db')
    expect(manifest.files.map((f) => f.name)).toContain('secrets.sqlite')
    expect(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256))).toBe(true)
    expect(manifest.chain.count).toBeGreaterThan(0)
    expect(manifest.chain.last_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.secrets.records).toBe(1)
    expect(manifest.packages).toContain('events')
  })

  it('凭据只导密文：包里的字节找不到那句口令', async () => {
    const dbDir = temp('data')
    const { workspace_id } = await populate(dbDir)
    const out = temp('pkg')
    exportWorkspace({ dataDir: dbDir, workspace_id, out, clock })

    for (const name of readdirSync(out)) {
      const bytes = readFileSync(join(out, name))
      expect(bytes.includes(Buffer.from(PLAINTEXT_PASSWORD, 'utf8')), name).toBe(false)
    }
    // 字段名在（要能列出"这个连接存了什么"），值不在
    expect(readFileSync(join(out, 'secrets.sqlite')).includes(Buffer.from('password'))).toBe(true)
  })
})

describe('40 §1.3 导入：核对哈希 → 验链 → 先对账再放开出站', () => {
  it('导出 → 空目录导入 → 事件链完整，待办与成员数一致', async () => {
    const dbDir = temp('data')
    const before = await populate(dbDir)
    const pkg = temp('pkg')
    exportWorkspace({ dataDir: dbDir, workspace_id: before.workspace_id, out: pkg, clock })

    const restored = temp('restored')
    const result = await importWorkspace({ pkg, dataDir: restored })
    expect(result.files_verified).toBeGreaterThan(0)
    expect(result.chain.ok).toBe(true)
    expect(result.chain.events).toBe(before.events)

    const server = await boot(restored)
    expect(server.bootstrap.workspace.id).toBe(before.workspace_id)
    expect(server.work.listTodos()).toHaveLength(before.todos)
    expect(server.kernel.eventLog.verifyChain(before.workspace_id).ok).toBe(true)
    expect(server.secrets.get('mail:luoye@example.com')?.password).toBe(PLAINTEXT_PASSWORD)
  })

  it('zip 也走同一条路：导成 zip → 从 zip 导回来', async () => {
    const dbDir = temp('data')
    const before = await populate(dbDir)
    const zip = join(temp('out'), 'ws.zip')
    const exported = exportWorkspace({
      dataDir: dbDir,
      workspace_id: before.workspace_id,
      out: zip,
      clock,
    })
    expect(exported.format).toBe('zip')
    expect(exported.bytes).toBeGreaterThan(0)

    const restored = temp('restored')
    const result = await importWorkspace({ pkg: zip, dataDir: restored })
    expect(result.chain.ok).toBe(true)
    expect(result.chain.events).toBe(before.events)
  })

  it('包被改过一个字节 → 不导，报 corrupt（坏包不铺到新机器上）', async () => {
    const dbDir = temp('data')
    const before = await populate(dbDir)
    const pkg = temp('pkg')
    exportWorkspace({ dataDir: dbDir, workspace_id: before.workspace_id, out: pkg, clock })
    const victim = join(pkg, 'work.sqlite')
    const bytes = readFileSync(victim)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
    writeFileSync(victim, bytes)

    await expect(importWorkspace({ pkg, dataDir: temp('restored') })).rejects.toThrow(/哈希对不上/)
  })

  it('目标目录非空 → 拒；显式 force 才覆盖', async () => {
    const dbDir = temp('data')
    const before = await populate(dbDir)
    const pkg = temp('pkg')
    exportWorkspace({ dataDir: dbDir, workspace_id: before.workspace_id, out: pkg, clock })

    const busy = temp('busy')
    writeFileSync(join(busy, 'something.txt'), 'x')
    await expect(importWorkspace({ pkg, dataDir: busy })).rejects.toThrow(/不是空的/)
    const forced = await importWorkspace({ pkg, dataDir: busy, force: true })
    expect(forced.chain.ok).toBe(true)
  })

  it('不是导出包 / 格式版本对不上 → 说清楚，不猜', async () => {
    const junk = temp('junk')
    await expect(importWorkspace({ pkg: junk, dataDir: temp('r') })).rejects.toThrow(
      /不是一个导出包/,
    )
    writeFileSync(join(junk, MANIFEST), JSON.stringify({ format: 999, files: [] }))
    await expect(importWorkspace({ pkg: junk, dataDir: temp('r') })).rejects.toThrow(/包格式是 999/)
  })

  it('15 §5.8：afterImport 那一步跑得到（恢复之后先对账再放开出站）', async () => {
    const dbDir = temp('data')
    const before = await populate(dbDir)
    const pkg = temp('pkg')
    exportWorkspace({ dataDir: dbDir, workspace_id: before.workspace_id, out: pkg, clock })

    const restored = temp('restored')
    const result = await importWorkspace({
      pkg,
      dataDir: restored,
      afterImport: async (dir) => {
        const server = await boot(dir)
        const report = await server.reconcile.run()
        return { reconcile: report.state, pending: report.unresolved.length }
      },
    })
    expect(result.reconcile).toEqual({ reconcile: 'done', pending: 0 })
  })
})

describe('每天一份（25 调度器 ⑫）', () => {
  it('runBackup 导一个 zip 并按保留份数删旧的', async () => {
    const dbDir = temp('data')
    const { workspace_id } = await populate(dbDir)
    const outDir = temp('backups')

    for (let i = 0; i < 3; i += 1) {
      runBackup({ dataDir: dbDir, workspace_id, outDir, clock, keep: 2 })
      clock.advance(24 * 60 * 60 * 1000)
    }
    const kept = readdirSync(outDir).filter((f) => f.endsWith('.zip'))
    expect(kept).toHaveLength(2)
    // 名字按时间排序 = 按字典序排序（删旧的靠这一条）
    expect([...kept].sort()).toEqual(kept.sort())
    // 留下的能导回来
    const restored = temp('restored')
    const out = await importWorkspace({ pkg: join(outDir, kept[1] as string), dataDir: restored })
    expect(out.chain.ok).toBe(true)
  })

  it('backupName 里的时间戳可排序、不带冒号（Windows 也能落盘）', () => {
    const name = backupName('ws_1', '2026-09-10T04:00:00.000Z')
    expect(name).toBe('agentsws-ws_1-20260910T040000Z.zip')
    expect(name).not.toContain(':')
  })

  it('落盘档会建 sched_backup（每天 04:00），内存档不建', async () => {
    const server = await boot(temp('data'))
    const task = server.schedule.scheduler.get('sched_backup')
    expect(task?.handler).toBe(HANDLERS.backup)
    expect(task?.trigger).toMatchObject({ kind: 'cron', expr: '0 4 * * *' })
    expect(server.schedule.scheduler.handlers()).toContain(HANDLERS.backup)

    const memory = await createServer({
      quiet: true,
      clock: { now: () => clock.now() },
      random: seeded(),
      scheduleIntervalMs: 0,
    })
    live.push(memory)
    expect(memory.schedule.scheduler.get('sched_backup')).toBeUndefined()
  })

  it('POST /v1/backup/export（owner）导一份到配置好的目录；响应里没有包本身', async () => {
    const dbDir = temp('data')
    const outDir = temp('backups')
    const server = await createServer({
      quiet: true,
      clock: { now: () => clock.now() },
      random: seeded(),
      scheduleIntervalMs: 0,
      dbDir,
      env: {
        AGENTSWS_OWNER_EMAIL: 'luoye@example.com',
        AGENTSWS_SECRETS_KEY: SECRETS_KEY,
        AGENTSWS_BACKUP_DIR: outDir,
      },
    })
    live.push(server)

    const res = await server.gateway.fetch(
      new Request('http://127.0.0.1/v1/backup/export', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${server.bootstrap.internalToken}`,
          'X-Assignment': server.bootstrap.ownerAssignment.id,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ keep: 3 }),
      }),
    )
    expect(res.status).toBe(200)
    const out = ((await res.json()) as { data: { out: string; events: number; kept: number } }).data
    expect(out.out.startsWith(outDir)).toBe(true)
    expect(out.events).toBeGreaterThan(0)
    expect(out.kept).toBe(1)
    expect(readdirSync(outDir)).toHaveLength(1)
  })
})

describe('最小 zip（不引依赖）', () => {
  it('打包 → 解包，字节一模一样；CRC 对不上就报 corrupt', () => {
    const src = temp('src')
    writeFileSync(join(src, 'a.txt'), 'x'.repeat(5000)) // 压得动 → deflate
    writeFileSync(join(src, 'b.bin'), Buffer.from([0, 1, 2, 3])) // 压不动 → store
    const zip = join(temp('out'), 'p.zip')
    zipDir(src, zip)

    const back = temp('back')
    expect(unzipTo(zip, back).sort()).toEqual(['a.txt', 'b.bin'])
    expect(readFileSync(join(back, 'a.txt'), 'utf8')).toBe('x'.repeat(5000))
    expect([...readFileSync(join(back, 'b.bin'))]).toEqual([0, 1, 2, 3])

    const bytes = readFileSync(zip)
    // 打第一个文件的数据段一个字节：CRC 立刻对不上
    bytes[40] = (bytes[40] ?? 0) ^ 0xff
    const broken = join(temp('out2'), 'broken.zip')
    writeFileSync(broken, bytes)
    expect(() => unzipTo(broken, temp('back2'))).toThrow()
  })

  it('不是 zip → 说清楚', () => {
    const file = join(temp('out'), 'nope.zip')
    writeFileSync(file, 'this is not a zip')
    expect(() => unzipTo(file, temp('back'))).toThrow(/不是一个 zip 包/)
  })
})
