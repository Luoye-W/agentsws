/**
 * `agentsws export` / `agentsws import`（40 §1.3、33 §1「双向搬家」）。
 *
 * 走的是命令行那一层：一个真跑过的数据目录 → 一个包 → 一个空目录 → 起服务进程
 * 数得对上。`import` 默认还会起一次服务进程跑 WP34 的对账（15 §5.8）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, MANIFEST } from '@agentsws/server'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { buildProgram, main } from '../src/index.js'

const temps: string[] = []
const tempDir = (tag: string): string => {
  const d = mkdtempSync(join(tmpdir(), `agentsws-cli-${tag}-`))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

let out: string[] = []
const write = (s: string): void => {
  out.push(s)
}
const text = (): string => out.join('')

beforeEach(() => {
  out = []
  process.exitCode = undefined
})

const run = async (...args: string[]): Promise<void> => {
  await buildProgram(write).parseAsync(['node', 'agentsws', ...args])
}

/** 跑一个真服务进程，留下几条可以数的东西。 */
const populate = async (dbDir: string): Promise<{ workspace_id: string; todos: number }> => {
  const server = await createServer({ quiet: true, dbDir, scheduleIntervalMs: 0 })
  const ws = server.bootstrap.workspace.id
  server.work.createTodo({ title: '待办一', owner: server.bootstrap.person.id })
  server.work.createTodo({ title: '待办二', owner: server.bootstrap.person.id })
  const todos = server.work.listTodos().length
  await server.close()
  return { workspace_id: ws, todos }
}

describe('agentsws export / import（40 §1.3）', () => {
  it('导出成目录 → 导入到空目录 → 起进程数得上，链验得过', async () => {
    const dbDir = tempDir('data')
    const { workspace_id, todos } = await populate(dbDir)
    const pkg = join(tempDir('pkg'), 'ws')

    await run('export', '--workspace', workspace_id, '--data-dir', dbDir, '--out', pkg)
    expect(text()).toContain('导出：')
    expect(text()).toMatch(/\d+ 个文件，\d+ 条事件/)
    expect(readdirSync(pkg)).toContain(MANIFEST)

    out = []
    const restored = tempDir('restored')
    await run('import', pkg, '--data-dir', restored)
    expect(text()).toContain('哈希全对上')
    expect(text()).toContain('事件链完整')
    // 15 §5.8：默认起一次进程对账，对完放开出站
    expect(text()).toContain('对账：done')
    expect(process.exitCode).toBeUndefined()

    const server = await createServer({ quiet: true, dbDir: restored, scheduleIntervalMs: 0 })
    expect(server.bootstrap.workspace.id).toBe(workspace_id)
    expect(server.work.listTodos()).toHaveLength(todos)
    await server.close()
  }, 60_000)

  it('导成 zip；--no-reconcile 只落地不起进程', async () => {
    const dbDir = tempDir('data')
    const { workspace_id } = await populate(dbDir)
    const zip = join(tempDir('pkg'), 'ws.zip')

    await run('export', '--workspace', workspace_id, '--data-dir', dbDir, '--out', zip)
    expect(text()).toContain('（zip，')

    out = []
    await run('import', zip, '--data-dir', tempDir('restored'), '--no-reconcile')
    expect(text()).toContain('事件链完整')
    expect(text()).not.toContain('对账：')
  }, 60_000)

  it('--data-dir 不给就读 AGENTSWS_DATA_DIR；都没有就说清楚', async () => {
    const dbDir = tempDir('data')
    const { workspace_id } = await populate(dbDir)
    const pkg = join(tempDir('pkg'), 'ws')
    const before = process.env.AGENTSWS_DATA_DIR
    process.env.AGENTSWS_DATA_DIR = dbDir
    try {
      await run('export', '--workspace', workspace_id, '--out', pkg)
      expect(text()).toContain('导出：')
    } finally {
      if (before === undefined) delete process.env.AGENTSWS_DATA_DIR
      else process.env.AGENTSWS_DATA_DIR = before
    }

    const beforeDb = process.env.AGENTSWS_DB_DIR
    delete process.env.AGENTSWS_DATA_DIR
    delete process.env.AGENTSWS_DB_DIR
    try {
      await main(['node', 'agentsws', 'export', '--workspace', workspace_id, '--out', pkg])
      expect(process.exitCode).toBe(1)
    } finally {
      if (beforeDb !== undefined) process.env.AGENTSWS_DB_DIR = beforeDb
    }
  }, 60_000)

  it('包坏了 → 不导，退出码 1', async () => {
    const dbDir = tempDir('data')
    const { workspace_id } = await populate(dbDir)
    const pkg = join(tempDir('pkg'), 'ws')
    await run('export', '--workspace', workspace_id, '--data-dir', dbDir, '--out', pkg)

    const victim = join(pkg, 'work.sqlite')
    const bytes = readFileSync(victim)
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff
    writeFileSync(victim, bytes)

    out = []
    await main(['node', 'agentsws', 'import', pkg, '--data-dir', tempDir('restored')])
    expect(process.exitCode).toBe(1)
  }, 60_000)
})
