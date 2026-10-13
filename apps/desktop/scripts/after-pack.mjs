/**
 * electron-builder 的 `afterPack` 钩子（WP111）。打完包、出安装包之前做三件事：
 *
 * 1. **补齐 electron-builder 漏掉的依赖**。pnpm 的 `node_modules/.pnpm` 里带 peer 后缀的
 *    目录（`@hono+node-server@2.1.1_hono@4.13.7`）electron-builder 的收集器解析不了，
 *    日志里只有一行 `cannot find path for dependency` 就过去了——而 `@hono/node-server`
 *    正是服务进程 listen 用的那一个。**装完打不开**就是这么来的。这里按 package.json
 *    的 `dependencies` 做一次广度优先补齐：包里没有、能从源码工作区解析到，就抄进去。
 * 2. **换成捆绑 Node 的 ABI 那份原生模块**。包里被抄进来的 `better_sqlite3.node` 是按
 *    **开发机 Node** 编的；服务进程跑的是 `<resources>/node`（Node 22，ABI 127）。
 *    两者对不上就是启动时 `ERR_DLOPEN_FAILED`。`vendor/natives/<平台>/` 里那份才是对的。
 * 3. **当场证明它 import 得动**。用捆绑的那份 Node 把服务进程入口 import 一遍、
 *    把 `better-sqlite3` require 一遍。不通就让打包失败——发出去之后再发现，
 *    代价是内测用户的一个下午。交叉平台打包（在 mac 上打 win）时跳过这一步并说明。
 * 4. **第三方许可证说明**（WP148）。`<resources>/licenses/` 里放三样：按
 *    `pnpm licenses list` 生成的 `THIRD_PARTY_LICENSES.txt`（`third-party-licenses.mjs`），
 *    Electron 自己的 LICENSE 与 Chromium 的 `LICENSES.chromium.html`。托盘「开源软件许可」
 *    打开的就是这个目录里的那份 txt。**包里带原生二进制、却不在清单里**的包有一个就失败。
 * 5. **审过的官方插件清单与锁定 patch 在包里**（WP181，`<resources>/profiles/agentsws/` 的两份）。
 * 6. **钉版本表齐**（WP225，仓库根的 `*.lock.json` 抄进 `<resources>/`，包里服务进程找得到）；
 *    冒烟里还用**包里那份**主进程代码取一次 `autoUpdater`（WP218 的包在 Windows 上就坏在这一步）。
 * 7. **npm 随包带**（WP254）：捆绑 Node 旁边按官方布局有那版配套的 npm、版本与锁一致；
 *    本机平台再用捆绑的 Node 真跑一次 `npm --version`。
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stashDirOf } from './after-extract.mjs'
import { findNativeBinaries, NOTICE_FILE, writeNotice } from './third-party-licenses.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(here, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')

/** `<appOutDir>` → `<resources>`。mac 的 `.app` 是个目录，别的平台平铺。 */
export function resourcesDirOf(appOutDir, platformName, productName) {
  return platformName === 'darwin'
    ? join(appOutDir, `${productName}.app`, 'Contents', 'Resources')
    : join(appOutDir, 'resources')
}

/** electron-builder 的 `context.arch`（0=ia32 1=x64 2=armv7l 3=arm64 4=universal）。 */
export const ARCH_NAMES = ['ia32', 'x64', 'armv7l', 'arm64', 'universal']

export function targetOf(platformName, archIndex) {
  const platform = platformName === 'mas' ? 'darwin' : platformName
  return `${platform}-${ARCH_NAMES[archIndex] ?? 'x64'}`
}

// ── ① 补齐依赖 ──────────────────────────────────────────────────────────

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 包目录里已经装好的一级目录名（含 `@scope/name`）。 */
export function installedNames(nodeModulesDir) {
  const out = new Set()
  if (!existsSync(nodeModulesDir)) return out
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) {
      const scopeDir = join(nodeModulesDir, entry)
      if (!statSync(scopeDir).isDirectory()) continue
      for (const name of readdirSync(scopeDir)) out.add(`${entry}/${name}`)
    } else out.add(entry)
  }
  return out
}

/**
 * 从 `from` 这个包的位置解析 `name` 的真实目录。
 *
 * 走 `package.json` 而不是入口文件：很多包的 `exports` 不导出 `.`，
 * `require.resolve(name)` 会 `ERR_PACKAGE_PATH_NOT_EXPORTED`，而 `package.json`
 * 一定在（Node 也允许解析它，除非包显式挡住 —— 挡住了就退回按目录拼）。
 */
function resolvePackageDir(name, fromDir) {
  const req = createRequire(join(fromDir, 'package.json'))
  try {
    return dirname(req.resolve(`${name}/package.json`))
  } catch {
    // 继续试目录拼法
  }
  let dir = fromDir
  for (let i = 0; i < 12; i += 1) {
    const guess = join(dir, 'node_modules', ...name.split('/'))
    if (existsSync(join(guess, 'package.json'))) return guess
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/**
 * 一个包在运行期真会 import 的那些名字。
 *
 * `peerDependencies` 也算：dsh 那一串插件把兄弟包全写成 peer
 * （`@deepseek-ai/dsh-agent-loop` 的 `lib/index.js` 直接 `import '@deepseek-ai/dsh-session-persistence'`），
 * 只看 `dependencies` 会漏掉几十个，装完点开就是 `ERR_MODULE_NOT_FOUND`。
 * `peerDependenciesMeta[x].optional` 的不算——那些本来就允许缺席。
 */
export function runtimeDependencyNames(meta) {
  const optional = meta?.peerDependenciesMeta ?? {}
  const peers = Object.keys(meta?.peerDependencies ?? {}).filter(
    (name) => optional[name]?.optional !== true,
  )
  // WP218：optionalDependencies 也算——sharp 的 `@img/sharp-win32-x64` 这类按平台装的二进制包就挂在这里，
  // 收集器漏了它，Windows 上一用图片就 "Could not load the sharp module"。没装（别的平台的）补齐时自然跳过。
  return [
    ...new Set([
      ...Object.keys(meta?.dependencies ?? {}),
      ...peers,
      ...Object.keys(meta?.optionalDependencies ?? {}),
    ]),
  ]
}

/**
 * 广度优先补齐：从包里已有的每个包出发看它运行期要什么，
 * 缺的就从源码工作区抄一份进来，再看抄进来那个包自己还缺什么。
 *
 * 返回补了哪些（打包日志里要看得见——静悄悄地补东西比不补更难查）。
 */
export function fillMissingDependencies(appDir, sourceRoots) {
  const nodeModules = join(appDir, 'node_modules')
  mkdirSync(nodeModules, { recursive: true })
  const have = installedNames(nodeModules)
  const queue = [...have]
  const added = []
  let guard = 0
  while (queue.length > 0 && guard < 20000) {
    guard += 1
    const name = queue.shift()
    const pkgDir = join(nodeModules, ...name.split('/'))
    const meta = readJson(join(pkgDir, 'package.json'))
    for (const dep of runtimeDependencyNames(meta)) {
      if (have.has(dep)) continue
      // 源码工作区里那一份的位置：先按这个包在源码里的位置找，再退到几个根
      const froms = [...sourceRoots, pkgDir]
      let from
      for (const root of froms) {
        from = resolvePackageDir(dep, root)
        if (from !== undefined) break
      }
      if (from === undefined) continue
      const to = join(nodeModules, ...dep.split('/'))
      mkdirSync(dirname(to), { recursive: true })
      cpSync(from, to, { recursive: true, dereference: true })
      have.add(dep)
      added.push(dep)
      queue.push(dep)
    }
  }
  return added
}

// ── ② 换原生模块 ────────────────────────────────────────────────────────

/** 包里所有的 `<pkg>/build/Release/*.node`，连同那个包的名字与版本。 */
export function findNativeModules(nodeModulesDir) {
  const out = []
  const walk = (dir, depth) => {
    if (depth > 8 || !existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith('.')) continue
      const path = join(dir, entry)
      let stat
      try {
        stat = statSync(path)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const meta = readJson(join(path, 'package.json'))
      const release = join(path, 'build', 'Release')
      if (meta?.name !== undefined && existsSync(release)) {
        for (const file of readdirSync(release)) {
          if (file.endsWith('.node'))
            out.push({ pkg: meta.name, version: meta.version, file: join(release, file) })
        }
      }
      walk(join(path, 'node_modules'), depth + 1)
      if (entry.startsWith('@')) walk(path, depth + 1)
    }
  }
  walk(nodeModulesDir, 0)
  return out
}

/**
 * 这些 `.node` 不是运行时要加载的东西，prebuild 包里也没有它们。
 *
 * `test_extension.node` 是 better-sqlite3 自己那套测试用的 SQLite 扩展。
 * 逐个具名放行，而不是"配不上就跳过"——后者等于把这道闸拆了。
 */
export const NON_RUNTIME_NATIVES = ['test_extension.node']

/**
 * 每一个 `.node` 配一份 `vendor/natives/<平台>/<包>/<版本>/…` 里的替身。
 *
 * **配不上就报错**，不静默跳过：一个 ABI 不对的 `better_sqlite3.node` 留在包里，
 * 用户那边是"点开没反应"，而这里报错只是让打包红一次。
 */
export function planNativeSwap(found, stagedDir, required = ['better-sqlite3']) {
  const plan = []
  const missing = []
  const skipped = []
  for (const item of found) {
    if (!required.includes(item.pkg)) continue
    const fileName = item.file.split(/[\\/]/).pop() ?? ''
    if (NON_RUNTIME_NATIVES.includes(fileName)) {
      skipped.push(item.file)
      continue
    }
    const source = join(stagedDir, item.pkg, item.version ?? '', 'build', 'Release', fileName)
    if (existsSync(source))
      plan.push({ from: source, to: item.file, pkgDir: resolve(item.file, '..', '..', '..') })
    else missing.push(`${item.pkg}@${item.version ?? '?'} → ${source}`)
  }
  return { plan, missing, skipped }
}

// ── ③ 冒烟：捆绑的 Node 真的 import 得动 ────────────────────────────────

/**
 * 探针：用**捆绑的那份 Node** 把每个原生模块包 require 一遍（真开一次内存库），
 * 再把服务进程入口 import 一遍。前者验 ABI，后者验依赖补齐得全不全。
 *
 * `process.argv` 里第一个是 appDir，其余是每个原生模块包的目录。
 */
const PROBE = `
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const [appDir, ...pkgDirs] = process.argv.slice(1)
for (const dir of pkgDirs) {
  const D = createRequire(dir + '/package.json')(dir)
  const db = new D(':memory:')
  db.prepare('select 1 as one').get()
  db.close()
}
const req = createRequire(appDir + '/package.json')
// WP218：N-API 的原生依赖（不按 ABI 换，但要确认这个平台那一份真在包里）：图片、Windows 进程控制、终端
for (const name of ['sharp', 'koffi', 'node-pty']) {
  let resolved
  try {
    resolved = req.resolve(name)
  } catch {
    continue
  }
  req(resolved)
  process.stdout.write('native ok: ' + name + '\\n')
}
;(async () => {
  // WP225：应用内更新。用**包里那份** electron-updater 与**包里那份**主进程代码
  // （dist/electron-updater-module.js）走一遍主进程取 autoUpdater 的路——WP218 的包就是这一步拿到 undefined。
  // 只认「有」不去读：读 getter 要 require('electron')，捆绑的 Node 里没有。
  const updaterMod = await import(pathToFileURL(req.resolve('electron-updater')).href)
  const helper = await import(pathToFileURL(appDir + '/dist/electron-updater-module.js').href)
  if (helper.autoUpdaterHolder(updaterMod) === undefined)
    throw new Error('包里的 electron-updater 取不到 autoUpdater（应用内更新会坏）')
  process.stdout.write('updater ok\\n')
  // WP225：钉版本表——用包里服务进程**自己的** defaultLockPath() 找，找到的必须在安装包里
  // （在打包机上往上找可能找到仓库里那份，那不算）
  const path = require('node:path')
  const fs = require('node:fs')
  const serverDist = path.dirname(req.resolve('@agentsws/server'))
  // 比真实路径（mac 的临时目录 /var → /private/var；Windows 8.3 短名与大小写）
  const norm = (p) => {
    const real = fs.realpathSync.native(p)
    return process.platform === 'win32' ? real.toLowerCase() : real
  }
  const resourcesDir = path.dirname(appDir)
  for (const file of ['computer-use-install.js', 'browserskill-install.js']) {
    const modPath = path.join(serverDist, file)
    if (!fs.existsSync(modPath)) continue
    const found = (await import(pathToFileURL(modPath).href)).defaultLockPath()
    if (found === undefined || !norm(found).startsWith(norm(resourcesDir + path.sep)))
      throw new Error(file + ' 在安装包里找不到钉版本表（找到的是 ' + found + '）')
  }
  process.stdout.write('locks ok\\n')
  const m = await import(pathToFileURL(req.resolve('@agentsws/server')).href)
  if (typeof m.createServer !== 'function') throw new Error('@agentsws/server 里没有 createServer')
  process.stdout.write('probe ok\\n')
})().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n')
  process.exit(1)
})
`

export function probeBundled(nodeExec, appDir, pkgDirs) {
  return execFileSync(nodeExec, ['-e', PROBE, appDir, ...pkgDirs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
}

// ── ④ 第三方许可证 ─────────────────────────────────────────────────────

/** 安装包里放许可证的目录（`<resources>/licenses`）。托盘菜单按同一个相对路径找。 */
export const LICENSES_DIR = 'licenses'

/** 随安装包带的许可证全文（仓库 `apps/desktop/licenses/`，取自 SPDX license-list-data）。 */
export const BUNDLED_LICENSE_TEXTS = ['LGPL-3.0.txt', 'GPL-3.0.txt']

/**
 * Electron 发行包自带的两份许可证 → `licenses/` 里的名字。
 * mac 上只剩 `after-extract.mjs` 存下的那份；win / linux 上 electron-builder 把它们留在应用根目录
 * （`LICENSE.electron.txt` 是它改过的名）——所以几处都找，找到哪份拷哪份。
 */
export const ELECTRON_LICENSES = [
  ['LICENSE.electron.txt', 'LICENSE.electron.txt'],
  ['LICENSE', 'LICENSE.electron.txt'],
  ['LICENSES.chromium.html', 'LICENSES.chromium.html'],
]

export function copyElectronLicenses(searchDirs, licensesDir) {
  const copied = new Set()
  mkdirSync(licensesDir, { recursive: true })
  for (const [from, to] of ELECTRON_LICENSES) {
    if (copied.has(to)) continue
    for (const dir of searchDirs) {
      const source = join(dir, from)
      if (!existsSync(source)) continue
      copyFileSync(source, join(licensesDir, to))
      copied.add(to)
      break
    }
  }
  return [...copied].sort()
}

// ── ⑤ 审过的官方插件清单与锁定 patch（WP181）─────────────────────────────

/** 安装包里放 profile 的目录（`<resources>/profiles/agentsws`）。桌面壳按同一个相对路径给服务进程。 */
export const PROFILE_DIR = join('profiles', 'agentsws')

/**
 * WP218：工作台的构建产物（`<resources>/workstation`）。WP111 起的安装包一直没带它，
 * 装好点「打开工作台」是一张 404——这里缺了就打包失败。
 */
export const WORKSTATION_DIR = 'workstation'

export function missingWorkstation(resources) {
  return !existsSync(join(resources, WORKSTATION_DIR, 'index.html'))
}

/** 必须在包里的两份（`electron-builder.yml` 的 extraResources 带进来）。 */
export const PROFILE_FILES = ['cordis.patch.yml', 'plugin-allowlist.yml']

/**
 * 包里缺了哪几份（空 = 都在）。缺了打包失败——不然装好的桌面版「设置 → 官方插件」整页
 * 读不到清单（fail closed，没法装），而且锁定 patch 没了守门就没有真源可比。
 */
export function missingProfileFiles(resources) {
  return PROFILE_FILES.filter((name) => !existsSync(join(resources, PROFILE_DIR, name)))
}

// ── ⑦ 钉版本表（WP225）──────────────────────────────────────────────────

/**
 * 仓库根上的钉版本表（`computer-use.lock.json`、`browserskill.lock.json`，以后同类的也按这个名字规矩放）。
 * 服务进程按「从自己所在目录往上找」读它们（`defaultLockPath`）；WP218 的包里一份都没带，
 * 「下载电脑操控驱动」「装 bsk」在装好的桌面版上直接报「这个发行版里没有 …lock.json」。
 * 按名字规矩收、不写死清单：以后再加一份锁表不用回来改这里。
 */
export const LOCK_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.lock\.json$/

export function repoLockFiles(repoRoot) {
  return readdirSync(repoRoot)
    .filter((name) => LOCK_FILE_PATTERN.test(name))
    .sort()
}

/** 抄到 `<resources>/`：包里服务进程在 `<resources>/app/node_modules/@agentsws/server/dist`，往上 5 层就到。 */
export function copyLockFiles(repoRoot, resources, names) {
  for (const name of names) copyFileSync(join(repoRoot, name), join(resources, name))
}

/**
 * 照服务进程 `defaultLockPath` 的找法（从 dist 往上最多 8 层，先找到的算）把每一份找一遍，
 * 回**找不到、或找到的不在安装包里**的那些（空 = 齐了）。
 */
export function unreachableLockFiles(appDir, resources, names) {
  const start = join(appDir, 'node_modules', '@agentsws', 'server', 'dist')
  const inside = resolve(resources) + sep
  return names.filter((name) => {
    let dir = resolve(start)
    for (let i = 0; i < 8; i += 1) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return !candidate.startsWith(inside)
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return true
  })
}

// ── ⑧ 随包的 npm（WP254，决策 99）────────────────────────────────────────

/**
 * 捆绑 Node 旁边那份 npm 的入口（官方发行包布局：Windows `node/node_modules/npm`，
 * 其余 `node/lib/node_modules/npm`）。服务进程 `bundledNpmCandidates` 先找的就是它——
 * 找到了，一键安装平台 CLI、下载连接器都不必再联网下 npm。
 */
export function bundledNpmCli(resources, platformName) {
  const nodeDir = join(resources, 'node')
  return platformName === 'win32'
    ? join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
}

/**
 * 把 `vendor/node/<target>` 里的 npm 补进包里（10-07 Windows CI 实测：electron-builder 的
 * extraResources 会跳过名为 `node_modules` 的目录，全匹配的 filter 也拦不住，npm 于是没进包）。
 * 包里已经有就不动；vendor 里也没有就留给下面的检查报错。返回是否补了。
 */
export function placeBundledNpm(resources, platformName, vendorNodeDir) {
  const cli = bundledNpmCli(resources, platformName)
  if (existsSync(cli)) return false
  const npmDir = dirname(dirname(cli))
  const from = join(vendorNodeDir, relative(join(resources, 'node'), npmDir))
  if (!existsSync(join(from, 'bin', 'npm-cli.js'))) return false
  cpSync(from, npmDir, { recursive: true, dereference: true })
  return true
}

/** 包里那份 npm 有什么问题（空 = 没问题）：不在 / 版本与 `node-runtime.lock.json` 不一致。 */
export function bundledNpmProblem(resources, platformName, expectedVersion) {
  const cli = bundledNpmCli(resources, platformName)
  if (!existsSync(cli))
    return `安装包里没有随包的 npm：${cli}（先跑 fetch-node.mjs；extraResources 没生效？）`
  const meta = readJson(join(dirname(dirname(cli)), 'package.json'))
  if (meta?.version !== expectedVersion)
    return `安装包里的 npm 是 ${String(meta?.version)}，锁里钉的是 ${expectedVersion}`
  return undefined
}

// ── 钩子本体 ────────────────────────────────────────────────────────────

export default async function afterPack(context) {
  const platformName = context.electronPlatformName
  const productName = context.packager.appInfo.productName
  const resources = resourcesDirOf(context.appOutDir, platformName, productName)
  const appDir = join(resources, 'app')
  const target = targetOf(platformName, context.arch)
  const log = (line) => {
    process.stdout.write(`  • afterPack ${line}\n`)
  }

  const added = fillMissingDependencies(appDir, [
    join(REPO_ROOT, 'apps', 'server'),
    join(REPO_ROOT, 'apps', 'desktop'),
    REPO_ROOT,
    // WP218：pnpm 把所有间接依赖提升在 `.pnpm/node_modules` 里——sharp 按平台装的 `@img/sharp-<平台>`
    // 只在这里解析得到（从上面几个根解析不到，WP111 起的包里一直没有它，一用图片就炸）
    join(REPO_ROOT, 'node_modules', '.pnpm'),
  ])
  log(`补齐依赖 ${added.length} 个${added.length === 0 ? '' : `：${added.join(', ')}`}`)

  const stagedDir = join(DESKTOP_ROOT, 'vendor', 'natives', target)
  if (!existsSync(stagedDir))
    throw new Error(
      `没有 ${stagedDir}：先跑 \`node scripts/fetch-node.mjs --target ${target}\` 把捆绑的 Node 与原生模块下下来`,
    )
  const found = findNativeModules(join(appDir, 'node_modules'))
  const { plan, missing, skipped } = planNativeSwap(found, stagedDir)
  if (missing.length > 0)
    throw new Error(`这些原生模块没有对应 ABI 的 prebuild：\n  ${missing.join('\n  ')}`)
  for (const item of plan) cpSync(item.from, item.to, { dereference: true })
  log(`原生模块换成捆绑 Node 的 ABI 那份：${plan.length} 个，跳过 ${skipped.length} 个（非运行时）`)

  /*
   * ④ 许可证：放在冒烟之前——冒烟只在本机平台跑，许可证每个平台都要有。
   * 原生二进制按**包里真有的**扫（换过 ABI 之后的那一份），清单来自 `pnpm licenses list`。
   */
  const licensesDir = join(resources, LICENSES_DIR)
  const natives = findNativeBinaries(join(appDir, 'node_modules'))
  const notice = writeNotice(join(licensesDir, NOTICE_FILE), { natives })
  if (notice.uncovered.length > 0)
    throw new Error(
      `这些包带着原生二进制，却不在第三方许可证清单里：${notice.uncovered.join(', ')}`,
    )
  // 先找 afterExtract 存下的那份（mac 上只有它），再找 win / linux 留在根目录的那份
  const stash = stashDirOf(context.appOutDir)
  const electronLicenses = copyElectronLicenses([stash, context.appOutDir, resources], licensesDir)
  // 09-24：GPL-3.0 / LGPL-3.0 全文随安装包带（libvips 是 LGPL-3.0；仓库里那两份取自 SPDX license-list-data）
  for (const name of BUNDLED_LICENSE_TEXTS) {
    copyFileSync(join(DESKTOP_ROOT, 'licenses', name), join(licensesDir, name))
  }
  rmSync(stash, { recursive: true, force: true })
  try {
    rmdirSync(dirname(stash)) // 只在空了的时候删得掉（别的架构可能还在用）
  } catch {
    // 不空 / 不在：留着
  }
  log(
    `第三方许可证：${notice.packages} 个包，原生二进制 ${natives.length} 个包` +
      `（libvips：${notice.libvips.join(', ') || '无'}）；Electron / Chromium：${electronLicenses.join(', ') || '没找到'}`,
  )

  // ⑤ WP181：官方插件清单与锁定 patch 在不在（每个平台都要有，放在冒烟之前）
  const missingProfile = missingProfileFiles(resources)
  if (missingProfile.length > 0)
    throw new Error(
      `安装包里没有 ${PROFILE_DIR} 下的 ${missingProfile.join('、')}（extraResources 没生效？）`,
    )
  log(`官方插件清单与锁定 patch：${PROFILE_FILES.join('、')}`)

  // ⑥ WP218：工作台产物在不在（先 `pnpm --filter @agentsws/workstation build`）
  if (missingWorkstation(resources))
    throw new Error(
      `安装包里没有 ${WORKSTATION_DIR}/index.html：先 \`pnpm --filter @agentsws/workstation build\``,
    )
  log('工作台产物：在')

  // ⑦ WP225：钉版本表（每个平台都要有，放在冒烟之前；冒烟里再用包里服务进程自己的找法验一次）
  const locks = repoLockFiles(REPO_ROOT)
  copyLockFiles(REPO_ROOT, resources, locks)
  const unreachable = unreachableLockFiles(appDir, resources, locks)
  if (unreachable.length > 0)
    throw new Error(`安装包里的服务进程找不到这些钉版本表：${unreachable.join('、')}`)
  log(`钉版本表：${locks.join('、')}`)

  const nodeExec =
    platformName === 'win32'
      ? join(resources, 'node', 'node.exe')
      : join(resources, 'node', 'bin', 'node')
  if (!existsSync(nodeExec))
    throw new Error(`安装包里没有捆绑的 Node：${nodeExec}（extraResources 没生效？）`)

  // ⑧ WP254：npm 随包带（每个平台都查；本机平台再用捆绑的 Node 真跑一次 `npm --version`）
  const npmVersion = readJson(join(DESKTOP_ROOT, 'node-runtime.lock.json'))?.npm?.version
  if (placeBundledNpm(resources, platformName, join(DESKTOP_ROOT, 'vendor', 'node', target)))
    log('随包的 npm：extraResources 漏了 node_modules，已从 vendor 补进来')
  const npmProblem = bundledNpmProblem(resources, platformName, npmVersion)
  if (npmProblem !== undefined) throw new Error(npmProblem)
  log(`随包的 npm：${npmVersion}`)

  if (platformName === hostPlatform()) {
    const out = probeBundled(
      nodeExec,
      appDir,
      plan.map((p) => p.pkgDir),
    )
    log(`捆绑 Node 冒烟：${out.trim()}`)
    const npmOut = execFileSync(nodeExec, [bundledNpmCli(resources, platformName), '--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' },
    }).trim()
    if (npmOut !== npmVersion)
      throw new Error(`捆绑 Node 跑随包的 npm 回的是 ${npmOut}，应是 ${npmVersion}`)
    log(`随包 npm 冒烟：${npmOut}`)
  } else {
    log(`跨平台打包（${platformName} ≠ ${hostPlatform()}），冒烟跳过`)
  }
}

function hostPlatform() {
  return process.platform
}
