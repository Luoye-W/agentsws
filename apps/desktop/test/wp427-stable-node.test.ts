/**
 * WP427（决策 1273 ②）：Windows 上服务进程的 Node 住在不随版本变的 `<根>\node\node.exe`。
 *
 * 钉住：第一次拷过去；一样就不动（同一版只比大小，不算哈希）；Node 升级了才换——正在跑的旧 Node
 * 改名让位、删不掉留到下次；新的就不了位把旧的改回来、退回版本目录那份；安装程序刚拷的（没记号）
 * 按哈希认；回滚到旧版时换回旧版自带的那份；防火墙把允许落在这份身上；选 Node 的顺序。
 */
import { posix } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FIREWALL_RULE_NAME, type FirewallRule, planFirewall } from '../src/firewall.js'
import { resolveServerRuntime } from '../src/server-process.js'
import {
  ensureStableNode,
  STABLE_NODE_MARKER,
  type StableNodeFs,
  stableNodePath,
} from '../src/stable-node.js'

/** 内存文件系统：内容就是字符串；`locked` 里的文件不能删、不能覆盖（Windows 上正在跑的 exe），但能改名。 */
function memFs(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed))
  const locked = new Set<string>()
  let hashes = 0
  const fs: StableNodeFs = {
    exists: (p) => files.has(p),
    files: (dir) =>
      [...files.keys()].filter((p) => posix.dirname(p) === dir).map((p) => posix.basename(p)),
    size: (p) => {
      const v = files.get(p)
      if (v === undefined) throw new Error(`没有 ${p}`)
      return v.length
    },
    hash: (p) => {
      hashes += 1
      return `h:${files.get(p) ?? ''}`
    },
    readText: (p) => files.get(p),
    writeText: (p, t) => {
      files.set(p, t)
    },
    mkdir: () => undefined,
    copy: (from, to) => {
      if (locked.has(to)) throw new Error('EBUSY')
      const v = files.get(from)
      if (v === undefined) throw new Error(`没有 ${from}`)
      files.set(to, v)
    },
    rename: (from, to) => {
      const v = files.get(from)
      if (v === undefined) throw new Error(`没有 ${from}`)
      files.delete(from)
      files.set(to, v)
      if (locked.delete(from)) locked.add(to)
    },
    remove: (p) => {
      if (locked.has(p)) throw new Error('EBUSY')
      files.delete(p)
    },
  }
  return { fs, files, locked, hashes: () => hashes }
}

const ROOT = '/inst'
const V1 = '/inst/app-0.2.1-beta.1/resources/node'
const V2 = '/inst/app-0.2.1-beta.2/resources/node'
const target = '/inst/node/node.exe'

describe('WP427 不随版本变的 Node', () => {
  it('第一次：连旁边的 npm 包一起拷过去，写记号', () => {
    const m = memFs({
      [`${V1}/node.exe`]: 'NODE22.1',
      [`${V1}/npm-10.9.0.tgz`]: 'npm',
      [`${V1}/npm.json`]: '{}',
    })
    const out = ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    expect(out).toEqual({ kind: 'copied', path: target })
    expect(m.files.get(target)).toBe('NODE22.1')
    expect(m.files.get('/inst/node/npm-10.9.0.tgz')).toBe('npm')
    expect(JSON.parse(m.files.get(`/inst/node/${STABLE_NODE_MARKER}`) ?? '')).toMatchObject({
      version: '0.2.1-beta.1',
      size: 8,
    })
  })

  it('同一版再启动：只比大小，不算哈希、不拷', () => {
    const m = memFs({ [`${V1}/node.exe`]: 'NODE22.1' })
    ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    const before = m.hashes()
    const out = ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    expect(out.kind).toBe('kept')
    expect(m.hashes()).toBe(before)
  })

  it('换了版本、Node 没变：不动 node.exe，只改记号（防火墙认的还是同一个文件）', () => {
    const m = memFs({ [`${V1}/node.exe`]: 'NODE22.1', [`${V2}/node.exe`]: 'NODE22.1' })
    ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    m.locked.add(target) // 上一版的子进程还挂着
    const out = ensureStableNode({ root: ROOT, bundledDir: V2, version: '0.2.1-beta.2', fs: m.fs })
    expect(out).toEqual({ kind: 'kept', path: target })
    expect(JSON.parse(m.files.get(`/inst/node/${STABLE_NODE_MARKER}`) ?? '').version).toBe(
      '0.2.1-beta.2',
    )
  })

  it('Node 升级了：正在跑的旧的改名让位，新的就位；旧的删不掉留到下次再删', () => {
    const m = memFs({ [`${V1}/node.exe`]: 'NODE22.1', [`${V2}/node.exe`]: 'NODE22.22' })
    ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    m.locked.add(target)
    const out = ensureStableNode({
      root: ROOT,
      bundledDir: V2,
      version: '0.2.1-beta.2',
      fs: m.fs,
      now: () => 42,
    })
    expect(out).toEqual({ kind: 'replaced', path: target })
    expect(m.files.get(target)).toBe('NODE22.22')
    expect(m.files.get(`${target}.old-42`)).toBe('NODE22.1')
    // 旧进程退了，下次启动清掉
    m.locked.clear()
    ensureStableNode({ root: ROOT, bundledDir: V2, version: '0.2.1-beta.2', fs: m.fs })
    expect(m.files.has(`${target}.old-42`)).toBe(false)
    // 回滚到旧版：旧版启动时换回它自带的那份（旧脚本不会配上新 Node）
    const back = ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    expect(back.kind).toBe('replaced')
    expect(m.files.get(target)).toBe('NODE22.1')
  })

  it('新的就不了位：旧的改回来，这次用版本目录里那份（不挡启动）', () => {
    const m = memFs({ [`${V1}/node.exe`]: 'NODE22.1', [`${V2}/node.exe`]: 'NODE22.22' })
    ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs })
    const rename = m.fs.rename
    m.fs.rename = (from, to) => {
      if (from.endsWith('.new')) throw new Error('EPERM')
      rename(from, to)
    }
    const out = ensureStableNode({ root: ROOT, bundledDir: V2, version: '0.2.1-beta.2', fs: m.fs })
    expect(out.kind).toBe('fallback')
    expect(m.files.get(target)).toBe('NODE22.1')
  })

  it('安装程序刚拷的（没有记号）：按哈希认，一样就不动', () => {
    const m = memFs({ [`${V2}/node.exe`]: 'NODE22.22', [target]: 'NODE22.22' })
    const out = ensureStableNode({ root: ROOT, bundledDir: V2, version: '0.2.1-beta.2', fs: m.fs })
    expect(out.kind).toBe('kept')
    expect(m.files.has(`/inst/node/${STABLE_NODE_MARKER}`)).toBe(true)
  })

  it('这一版没带 Node：退回（不抛）', () => {
    const m = memFs({})
    expect(
      ensureStableNode({ root: ROOT, bundledDir: V1, version: '0.2.1-beta.1', fs: m.fs }).kind,
    ).toBe('fallback')
  })

  it('选 Node：AGENTSWS_NODE > 不随版本变的那份 > 版本目录自带的', () => {
    const base = {
      resourcesPath: 'C:\\inst\\app-1\\resources',
      electronExecPath: 'C:\\inst\\app-1\\agentsws.exe',
      platform: 'win32',
    }
    const stable = stableNodePath('C:\\inst')
    const exists = () => true
    expect(resolveServerRuntime({ ...base, env: {}, exists, stableNode: stable }).execPath).toBe(
      stable,
    )
    expect(
      resolveServerRuntime({
        ...base,
        env: { AGENTSWS_NODE: 'D:\\n.exe' },
        exists,
        stableNode: stable,
      }).execPath,
    ).toBe('D:\\n.exe')
    expect(
      resolveServerRuntime({ ...base, env: {}, exists: (p) => p !== stable, stableNode: stable })
        .execPath,
    ).not.toBe(stable)
  })
})

describe('WP427 防火墙：允许落在不随版本变的那份身上', () => {
  const rule = (program: string, action = 'Allow'): FirewallRule => ({
    id: `id-${program}`,
    name: 'node',
    action,
    direction: 'Inbound',
    enabled: true,
    profile: 'Private',
    program,
  })
  const root = 'C:\\Users\\a\\AppData\\Local\\Programs\\agentsws'
  const stable = `${root}\\node\\node.exe`
  const v1 = `${root}\\app-0.2.1-beta.1\\resources\\node\\node.exe`

  it('以前对版本目录里的 Node 点过允许 → 带到那份身上；那份已经有了就什么都不加', () => {
    const plan = planFirewall({
      root,
      dir: `${root}\\app-0.2.1-beta.2`,
      target: stable,
      rules: [rule(v1)],
      exists: () => true,
    })
    expect(plan.add).toMatchObject({
      name: FIREWALL_RULE_NAME,
      program: stable,
      profiles: ['Private'],
    })
    const again = planFirewall({
      root,
      dir: `${root}\\app-0.2.1-beta.3`,
      target: stable,
      rules: [rule(v1), rule(stable)],
      exists: () => true,
    })
    expect(again.add).toBeUndefined()
  })
})
