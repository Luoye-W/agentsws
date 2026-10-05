/**
 * WP111：`scripts/after-pack.mjs` 的三件事——补依赖、换原生模块、算路径。
 *
 * 为什么值得测：这三件都**只在打包那一刻发生**，错了不会红在任何单元测试上，
 * 只会变成内测用户那边"装完点开没反应"。所以拿真的临时目录跑一遍。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ARCH_NAMES,
  copyLockFiles,
  fillMissingDependencies,
  findNativeModules,
  installedNames,
  missingProfileFiles,
  missingWorkstation,
  PROFILE_DIR,
  PROFILE_FILES,
  planNativeSwap,
  probeBundled,
  repoLockFiles,
  resourcesDirOf,
  runtimeDependencyNames,
  targetOf,
  unreachableLockFiles,
  WORKSTATION_DIR,
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

  it('WP218：optionalDependencies 也算（sharp 按平台装的二进制包挂在这里）', () => {
    expect(
      runtimeDependencyNames({
        dependencies: { 'detect-libc': '*' },
        optionalDependencies: { '@img/sharp-win32-x64': '*', 'detect-libc': '*' },
      }),
    ).toEqual(['detect-libc', '@img/sharp-win32-x64'])
  })

  it('两边都写了的只算一次；没有 package.json 也不炸', () => {
    expect(
      runtimeDependencyNames({ dependencies: { a: '*' }, peerDependencies: { a: '*' } }),
    ).toEqual(['a'])
    expect(runtimeDependencyNames(undefined)).toEqual([])
  })
})

describe('WP218：工作台产物在包里', () => {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')

  it('没有 index.html 就报出来（afterPack 据此让打包失败）', () => {
    const resources = scratch()
    expect(missingWorkstation(resources)).toBe(true)
    mkdirSync(join(resources, WORKSTATION_DIR), { recursive: true })
    writeFileSync(join(resources, WORKSTATION_DIR, 'index.html'), '<!doctype html>')
    expect(missingWorkstation(resources)).toBe(false)
  })

  it('打包配置把 apps/workstation/dist 摆进 <resources>/workstation', () => {
    const yml = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/- from: \.\.\/workstation\/dist\n\s+to: workstation\n/)
    // 更新源：默认 generic → 自有下载站；文件名不随渠道变
    expect(yml).toMatch(/publish:\n\s+provider: generic\n\s+url: https:\/\/dl\.agentsws\.com\/beta/)
    expect(yml).toContain('detectUpdateChannel: false')
  })
})

describe('WP181：审过的官方插件清单与锁定 patch 在包里', () => {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')

  it('少一份就报出来（afterPack 据此让打包失败）；两份都在就是空', () => {
    const resources = scratch()
    expect(missingProfileFiles(resources)).toEqual([...PROFILE_FILES])
    mkdirSync(join(resources, PROFILE_DIR), { recursive: true })
    writeFileSync(join(resources, PROFILE_DIR, 'cordis.patch.yml'), '[]')
    expect(missingProfileFiles(resources)).toEqual(['plugin-allowlist.yml'])
    writeFileSync(join(resources, PROFILE_DIR, 'plugin-allowlist.yml'), '[]')
    expect(missingProfileFiles(resources)).toEqual([])
  })

  it('打包配置把仓库里那两份摆进 <resources>/profiles/agentsws，源文件真在', () => {
    const yml = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
    const block = yml.slice(yml.indexOf('from: ../../profiles/agentsws'))
    expect(block.startsWith('from: ../../profiles/agentsws')).toBe(true)
    expect(block).toMatch(
      /^from: \.\.\/\.\.\/profiles\/agentsws\n\s+to: profiles\/agentsws\n\s+filter:\n\s+- cordis\.patch\.yml\n\s+- plugin-allowlist\.yml/,
    )
    for (const name of PROFILE_FILES) {
      expect(existsSync(join(desktop, '..', '..', 'profiles', 'agentsws', name)), name).toBe(true)
    }
  })
})

describe('WP225：钉版本表齐', () => {
  const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')

  it('仓库根上按名字规矩收（computer-use / browserskill 两份都在，别的 json 不收）', () => {
    const names = repoLockFiles(repo)
    expect(names).toContain('computer-use.lock.json')
    expect(names).toContain('browserskill.lock.json')
    expect(names.every((n: string) => n.endsWith('.lock.json'))).toBe(true)
    const fake = scratch()
    writeFileSync(join(fake, 'a.lock.json'), '{}')
    writeFileSync(join(fake, 'package.json'), '{}')
    writeFileSync(join(fake, 'pnpm-lock.yaml'), '')
    writeFileSync(join(fake, 'Weird.lock.json'), '{}')
    expect(repoLockFiles(fake)).toEqual(['a.lock.json'])
  })

  it('抄进 <resources>/ 之后，照服务进程的找法从包里 dist 往上找得到；没抄就报出来', () => {
    const resources = scratch()
    const appDir = join(resources, 'app')
    mkdirSync(join(appDir, 'node_modules', '@agentsws', 'server', 'dist'), { recursive: true })
    const names = ['computer-use.lock.json', 'browserskill.lock.json']
    expect(unreachableLockFiles(appDir, resources, names)).toEqual(names)
    copyLockFiles(repo, resources, names)
    expect(unreachableLockFiles(appDir, resources, names)).toEqual([])
    expect(readFileSync(join(resources, names[0] as string), 'utf8')).toBe(
      readFileSync(join(repo, names[0] as string), 'utf8'),
    )
  })

  it('找到的不在安装包里（打包机上往上找到了别处那份）也算没带', () => {
    const outer = scratch()
    const resources = join(outer, 'resources')
    const appDir = join(resources, 'app')
    mkdirSync(join(appDir, 'node_modules', '@agentsws', 'server', 'dist'), { recursive: true })
    writeFileSync(join(outer, 'x.lock.json'), '{}')
    expect(unreachableLockFiles(appDir, resources, ['x.lock.json'])).toEqual(['x.lock.json'])
  })
})

describe('WP225：冒烟用包里那份代码取 autoUpdater、找钉版本表', () => {
  const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')

  /** 摆一个最小的「安装包」：app/dist 里放主进程那份取 autoUpdater 的代码（现转译）、两个假依赖。 */
  function fakePackage(updaterSource: string): { resources: string; appDir: string } {
    const resources = scratch()
    const appDir = join(resources, 'app')
    writePackage(appDir, { name: 'app', type: 'module' })
    const src = readFileSync(join(desktop, 'src', 'electron-updater-module.ts'), 'utf8')
    const js = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText
    mkdirSync(join(appDir, 'dist'), { recursive: true })
    writeFileSync(join(appDir, 'dist', 'electron-updater-module.js'), js)
    const eu = join(appDir, 'node_modules', 'electron-updater')
    writePackage(eu, { name: 'electron-updater', main: 'main.js' })
    writeFileSync(join(eu, 'main.js'), updaterSource)
    const server = join(appDir, 'node_modules', '@agentsws', 'server')
    writePackage(server, { name: '@agentsws/server', type: 'module', main: './dist/index.js' })
    mkdirSync(join(server, 'dist'), { recursive: true })
    writeFileSync(join(server, 'dist', 'index.js'), 'export function createServer() {}\n')
    writeFileSync(
      join(server, 'dist', 'computer-use-install.js'),
      [
        "import { existsSync } from 'node:fs'",
        "import { dirname, join } from 'node:path'",
        "import { fileURLToPath } from 'node:url'",
        'export function defaultLockPath() {',
        '  let dir = dirname(fileURLToPath(import.meta.url))',
        '  for (let i = 0; i < 8; i += 1) {',
        "    const c = join(dir, 'computer-use.lock.json')",
        '    if (existsSync(c)) return c',
        '    dir = dirname(dir)',
        '  }',
        '}',
      ].join('\n'),
    )
    return { resources, appDir }
  }

  // 照 electron-updater 的 main.js：getter 一读就要 electron（捆绑 Node 里没有）
  const realShape = [
    "Object.defineProperty(exports, '__esModule', { value: true })",
    "Object.defineProperty(exports, 'autoUpdater', { enumerable: true, get: () => require('electron') })",
  ].join('\n')

  it('取得到、钉版本表在包里：updater ok / locks ok / probe ok', () => {
    const { resources, appDir } = fakePackage(realShape)
    writeFileSync(join(resources, 'computer-use.lock.json'), '{}')
    const out = probeBundled(process.execPath, appDir, [])
    expect(out).toContain('updater ok')
    expect(out).toContain('locks ok')
    expect(out).toContain('probe ok')
  })

  it('包里那份 electron-updater 没有 autoUpdater：冒烟失败（打包随之失败）', () => {
    const { resources, appDir } = fakePackage('exports.NsisUpdater = class {}\n')
    writeFileSync(join(resources, 'computer-use.lock.json'), '{}')
    expect(() => probeBundled(process.execPath, appDir, [])).toThrow(/取不到 autoUpdater/)
  })

  it('钉版本表没进包：冒烟失败', () => {
    const { appDir } = fakePackage(realShape)
    expect(() => probeBundled(process.execPath, appDir, [])).toThrow(/找不到钉版本表/)
  })
})
