/**
 * WP111：`scripts/after-pack.mjs` 的三件事——补依赖、换原生模块、算路径。
 *
 * 为什么值得测：这三件都**只在打包那一刻发生**，错了不会红在任何单元测试上，
 * 只会变成内测用户那边"装完点开没反应"。所以拿真的临时目录跑一遍。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ARCH_NAMES,
  fillMissingDependencies,
  findNativeModules,
  installedNames,
  planNativeSwap,
  resourcesDirOf,
  runtimeDependencyNames,
  targetOf,
} from '../scripts/after-pack.mjs'

const root = mkdtempSync(join(tmpdir(), 'agentsws-after-pack-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

let seq = 0
function scratch(): string {
  seq += 1
  const dir = join(root, `case-${seq}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function writePackage(dir: string, meta: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(meta))
}

describe('resourcesDirOf', () => {
  it('mac 的 .app 是个目录，别的平台平铺', () => {
    expect(resourcesDirOf('/out', 'darwin', 'agentsws')).toBe(
      join('/out', 'agentsws.app', 'Contents', 'Resources'),
    )
    expect(resourcesDirOf('/out', 'win32', 'agentsws')).toBe(join('/out', 'resources'))
    expect(resourcesDirOf('/out', 'linux', 'agentsws')).toBe(join('/out', 'resources'))
  })
})

describe('targetOf', () => {
  it('electron-builder 的 arch 是个数字下标', () => {
    expect(ARCH_NAMES[1]).toBe('x64')
    expect(targetOf('win32', 1)).toBe('win32-x64')
    expect(targetOf('darwin', 3)).toBe('darwin-arm64')
    expect(targetOf('mas', 3)).toBe('darwin-arm64')
    expect(targetOf('linux', 99)).toBe('linux-x64')
  })
})

describe('installedNames', () => {
  it('作用域包按 `@scope/name` 数，点开头的目录不算', () => {
    const dir = join(scratch(), 'node_modules')
    writePackage(join(dir, 'ws'), { name: 'ws' })
    writePackage(join(dir, '@agentsws', 'server'), { name: '@agentsws/server' })
    mkdirSync(join(dir, '.bin'), { recursive: true })
    expect([...installedNames(dir)].sort()).toEqual(['@agentsws/server', 'ws'])
  })

  it('目录不存在 → 空集合', () => {
    expect(installedNames(join(root, '没有这个目录')).size).toBe(0)
  })
})

describe('fillMissingDependencies', () => {
  it('把 electron-builder 漏收的 pnpm 依赖抄进来（连它自己的依赖一起）', () => {
    const dir = scratch()
    const appDir = join(dir, 'app')
    const source = join(dir, 'source')

    // 包里：只有 @agentsws/server，它要 @hono/node-server（peer 后缀目录，收集器漏了）
    writePackage(join(appDir, 'node_modules', '@agentsws', 'server'), {
      name: '@agentsws/server',
      dependencies: { '@hono/node-server': '^2.1.1' },
    })
    // 源码工作区里：@hono/node-server 在，而且它自己还要一个 hono
    writePackage(join(source, 'node_modules', '@hono', 'node-server'), {
      name: '@hono/node-server',
      dependencies: { hono: '^4.0.0' },
    })
    writeFileSync(join(source, 'node_modules', '@hono', 'node-server', 'index.js'), '// stub')
    writePackage(join(source, 'node_modules', 'hono'), { name: 'hono' })
    writePackage(source, { name: 'source-root' })

    const added = fillMissingDependencies(appDir, [source])
    expect(added.sort()).toEqual(['@hono/node-server', 'hono'])
    expect(existsSync(join(appDir, 'node_modules', '@hono', 'node-server', 'index.js'))).toBe(true)
    expect(existsSync(join(appDir, 'node_modules', 'hono', 'package.json'))).toBe(true)
  })

  it('已经在包里的不重复抄；源码里也没有的跳过（不假装补上了）', () => {
    const dir = scratch()
    const appDir = join(dir, 'app')
    writePackage(join(appDir, 'node_modules', 'a'), { name: 'a', dependencies: { b: '*', z: '*' } })
    writePackage(join(appDir, 'node_modules', 'b'), { name: 'b' })
    writeFileSync(join(appDir, 'node_modules', 'b', 'marker'), 'original')

    const added = fillMissingDependencies(appDir, [join(dir, '空的')])
    expect(added).toEqual([])
    expect(readFileSync(join(appDir, 'node_modules', 'b', 'marker'), 'utf8')).toBe('original')
  })

  it('包里一个 node_modules 都没有也不炸', () => {
    const appDir = join(scratch(), 'app')
    expect(fillMissingDependencies(appDir, [])).toEqual([])
    expect(existsSync(join(appDir, 'node_modules'))).toBe(true)
  })
})

describe('findNativeModules', () => {
  it('嵌套的那一份也找得到（kernel 自己锁着 better-sqlite3 11）', () => {
    const nm = join(scratch(), 'node_modules')
    const root12 = join(nm, 'better-sqlite3')
    writePackage(root12, { name: 'better-sqlite3', version: '12.11.1' })
    mkdirSync(join(root12, 'build', 'Release'), { recursive: true })
    writeFileSync(join(root12, 'build', 'Release', 'better_sqlite3.node'), 'v12')

    const nested = join(nm, '@agentsws', 'kernel', 'node_modules', 'better-sqlite3')
    writePackage(join(nm, '@agentsws', 'kernel'), { name: '@agentsws/kernel' })
    writePackage(nested, { name: 'better-sqlite3', version: '11.10.0' })
    mkdirSync(join(nested, 'build', 'Release'), { recursive: true })
    writeFileSync(join(nested, 'build', 'Release', 'better_sqlite3.node'), 'v11')
    writeFileSync(join(nested, 'build', 'Release', 'readme.txt'), '不是 .node')

    const found = findNativeModules(nm)
    expect(found.map((f) => `${f.pkg}@${f.version}`).sort()).toEqual([
      'better-sqlite3@11.10.0',
      'better-sqlite3@12.11.1',
    ])
  })

  it('目录不存在 → 空', () => {
    expect(findNativeModules(join(root, '没有'))).toEqual([])
  })
})

describe('planNativeSwap', () => {
  it('每个 .node 配一份同版本的 prebuild', () => {
    const dir = scratch()
    const staged = join(dir, 'staged')
    const target = join(staged, 'better-sqlite3', '12.11.1', 'build', 'Release')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'better_sqlite3.node'), 'abi127')

    const { plan, missing } = planNativeSwap(
      [
        {
          pkg: 'better-sqlite3',
          version: '12.11.1',
          file: join(
            dir,
            'app',
            'node_modules',
            'better-sqlite3',
            'build',
            'Release',
            'better_sqlite3.node',
          ),
        },
      ],
      staged,
    )
    expect(missing).toEqual([])
    expect(plan).toHaveLength(1)
    expect(plan[0]?.from).toBe(join(target, 'better_sqlite3.node'))
    expect(plan[0]?.pkgDir.endsWith(join('node_modules', 'better-sqlite3'))).toBe(true)
  })

  it('**配不上就报错**：ABI 不对的 .node 留在包里 = 用户那边点开没反应', () => {
    const { plan, missing } = planNativeSwap(
      [
        {
          pkg: 'better-sqlite3',
          version: '9.9.9',
          file: '/app/x/build/Release/better_sqlite3.node',
        },
      ],
      join(root, '空的'),
    )
    expect(plan).toEqual([])
    expect(missing[0]).toContain('better-sqlite3@9.9.9')
  })

  it('白名单之外的原生模块不动（sharp / koffi 这些是 N-API，跨 ABI 通用）', () => {
    const { plan, missing } = planNativeSwap(
      [{ pkg: 'sharp', version: '0.35.4', file: '/app/x/build/Release/sharp.node' }],
      join(root, '空的'),
    )
    expect(plan).toEqual([])
    expect(missing).toEqual([])
  })
})

describe('runtimeDependencyNames', () => {
  it('`dependencies` 与 `peerDependencies` 都算', () => {
    expect(
      runtimeDependencyNames({
        dependencies: { zod: '^4' },
        peerDependencies: { '@deepseek-ai/dsh-session-persistence': '^0.1.6' },
      }).sort(),
    ).toEqual(['@deepseek-ai/dsh-session-persistence', 'zod'])
  })

  it('标了 optional 的 peer 不算（那些本来就允许缺席）', () => {
    expect(
      runtimeDependencyNames({
        peerDependencies: { a: '*', b: '*' },
        peerDependenciesMeta: { b: { optional: true } },
      }),
    ).toEqual(['a'])
  })

  it('两边都写了的只算一次；没有 package.json 也不炸', () => {
    expect(
      runtimeDependencyNames({ dependencies: { a: '*' }, peerDependencies: { a: '*' } }),
    ).toEqual(['a'])
    expect(runtimeDependencyNames(undefined)).toEqual([])
  })
})
