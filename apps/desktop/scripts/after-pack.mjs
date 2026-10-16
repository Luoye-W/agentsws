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
 * 8. **打成 bundle**（WP327）：桌面壳主进程、服务进程与 dsh / cordis 那一串用 esbuild 打进 `<resources>/app/bundle/`，
 *    node_modules 里只留原生模块那几串、按位置读的数据与静态资源、指向 bundle 的桩（见 `bundle-app.mjs`）；
 *    打完先把 bundle 每个文件解析一遍，再走下面的冒烟。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stashDirOf } from './after-extract.mjs'
import { BUNDLE_DIR, bundleApp, checkSyntax } from './bundle-app.mjs'
import { npmPackageFiles } from './fetch-node.mjs'
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

/**
 * WP345（决策 871）：随包的浏览器插件（`<resources>/chrome-extension`）。缺了、没有固定 key、版本不是这一包，
 * 都回一句原因（打包失败）：版本对不上 = 插件是上次构建剩下的，装出去用户的插件就跟不上工坊。
 */
export const EXTENSION_DIR = 'chrome-extension'

export function bundledExtensionProblem(resources, appVersion) {
  let manifest
  try {
    manifest = JSON.parse(readFileSync(join(resources, EXTENSION_DIR, 'manifest.json'), 'utf8'))
  } catch {
    return `安装包里没有 ${EXTENSION_DIR}/manifest.json：先构建插件（scripts/dist.mjs 会做）`
  }
  if (typeof manifest.key !== 'string' || manifest.key === '')
    return '随包的插件没有固定 key（apps/extension/src/lib/identity.ts）：id 会跟着路径变，配对会丢'
  const version = manifest.version_name ?? manifest.version
  if (version !== appVersion) return `随包的插件版本是 ${String(version)}，这一包是 ${appVersion}`
  return undefined
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

/** WP327：安装包里 npm 的 tgz 与它的说明（`<resources>/node/npm.json`）。 */
export const NPM_TARBALL_META = 'npm.json'

/** 删掉漏进包里的「解开的 npm」（两种布局都看）；回删了几个文件。 */
export function removeUnpackedNpm(resources) {
  let files = 0
  for (const rel of [
    ['node_modules', 'npm'],
    ['lib', 'node_modules', 'npm'],
  ]) {
    const dir = join(resources, 'node', ...rel)
    if (!existsSync(dir)) continue
    files += sizeOfTree(dir).files
    rmSync(dir, { recursive: true, force: true })
    for (let up = dirname(dir); up !== join(resources, 'node'); up = dirname(up)) {
      try {
        rmdirSync(up)
      } catch {
        break
      }
    }
  }
  return files
}

/** 包里那份 npm tgz 有什么问题（空 = 没问题）：不在 / 版本或 sha512 与 `node-runtime.lock.json` 不一致。 */
export function bundledNpmTarballProblem(resources, lockNpm) {
  const meta = readJson(join(resources, 'node', NPM_TARBALL_META))
  if (meta === undefined)
    return `安装包里没有 node/${NPM_TARBALL_META}（先跑 fetch-node.mjs；extraResources 没生效？）`
  if (meta.version !== lockNpm?.version)
    return `安装包里的 npm 是 ${String(meta.version)}，锁里钉的是 ${String(lockNpm?.version)}`
  if (meta.integrity !== lockNpm?.integrity) return '安装包里 npm.json 的 sha512 与锁不一致'
  const file = join(resources, 'node', String(meta.file))
  if (!existsSync(file)) return `安装包里没有 ${file}`
  const actual = `sha512-${createHash('sha512').update(readFileSync(file)).digest('base64')}`
  if (actual !== lockNpm.integrity) return `安装包里的 ${meta.file} 校验不对（sha512 与锁不一致）`
  return undefined
}

/** 把包里的 npm tgz 解到 `dest`（`dest/package/…`），回 npm-cli.js 的路径。 */
export function unpackNpmTarball(resources, dest) {
  const meta = readJson(join(resources, 'node', NPM_TARBALL_META))
  const tgz = readFileSync(join(resources, 'node', String(meta?.file)))
  for (const f of npmPackageFiles(tgz)) {
    const to = join(dest, 'package', ...f.rel.split('/'))
    mkdirSync(dirname(to), { recursive: true })
    writeFileSync(to, f.data)
  }
  return join(dest, 'package', 'bin', 'npm-cli.js')
}

// ── ⑩ 瘦身：删掉运行时用不到的文件（WP319）──────────────────────────────

/**
 * 运行时一个都用不上的文件：类型声明、source map、TypeScript 源码（Node 跑的是编好的 .js）、增量编译缓存。
 * 原因（WP319，Luoye 10-14 真机）：asar 关着，NSIS 装 / 更新的时间几乎和文件数成正比——旧文件一个个挪走删掉、
 * 新文件一个个解出来、杀毒逐个扫；CI 上从点「重启并更新」到新版起来要 3 分半。
 */
const DROP_FILE = /(\.d\.[cm]?ts|\.map|\.tsbuildinfo)$/i
/**
 * TypeScript 源码只删**我们自己的包**（`@agentsws/*`，跑的是 dist）。第三方包里的 `src/*.ts` 不碰：
 * 有的包（dsh / cordis）在 exports 里登记了 `./src/*`，删了万一哪条路要用就是装完起不来。
 */
const DROP_OWN_TS = /(?<!\.d)\.[cm]?tsx?$/i
const OWN_SCOPE = '@agentsws/'
/** 只在包的根目录（有 package.json 的那一层）删的说明文件。 */
const DROP_AT_PACKAGE_ROOT = /^(readme|changelog|changes|history)(\.(md|markdown|txt))?$/i
/** 只在包的根目录删的目录：测试与示例。 */
/**
 * 决策 748（Luoye 10-15 同意）：dsh 自带的调试工具前端不进安装包。`dsh-experimental-inspector` 带了一整份
 * Chrome DevTools 前端（约 24 MB、769 个文件），文件名极长：beta.10 起版本目录名多一位，Windows 上最长路径
 * 正好到 260 被装包冒烟拦下。运行时用不到（只有手动开实验性检查器时才读）。路径相对 `<resources>/app/node_modules`。
 */
export const STRIP_PACKAGE_PATHS = ['@deepseek-ai/dsh-experimental-inspector/lib/devtools']

export function stripPackagePaths(nodeModules, paths = STRIP_PACKAGE_PATHS) {
  let files = 0
  let bytes = 0
  for (const rel of paths) {
    const target = join(nodeModules, ...rel.split('/'))
    if (!existsSync(target)) continue
    const size = sizeOfTree(target)
    files += size.files
    bytes += size.bytes
    rmSync(target, { recursive: true, force: true })
  }
  return { files, bytes }
}

const DROP_DIR_AT_PACKAGE_ROOT = new Set([
  'test',
  'tests',
  '__tests__',
  'example',
  'examples',
  '.github',
])

/**
 * 在 `root` 下删运行时用不到的文件，回删了几个、多少字节（**只删上面点名的那几类**，别的一个不碰）。
 * `extraDirs`：包根目录下额外整个删掉的目录名（随包 npm 的 `docs` / `man`）。
 */
export function pruneNonRuntimeFiles(root, { extraDirs = [] } = {}) {
  let files = 0
  let bytes = 0
  const dropDirs = new Set([...DROP_DIR_AT_PACKAGE_ROOT, ...extraDirs])
  const drop = (path, st) => {
    const size = st.isDirectory() ? sizeOfTree(path) : { files: 1, bytes: st.size }
    files += size.files
    bytes += size.bytes
    rmSync(path, { recursive: true, force: true })
  }
  const walk = (dir, own) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const isPackageRoot = entries.includes('package.json')
    // 进到一个包里就按它的名字定「是不是我们自己的」（嵌套的 node_modules 里再换）
    const mine = isPackageRoot
      ? String(readJson(join(dir, 'package.json'))?.name ?? '').startsWith(OWN_SCOPE)
      : own
    for (const name of entries) {
      const path = join(dir, name)
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        if (isPackageRoot && dropDirs.has(name)) drop(path, st)
        else walk(path, name === 'node_modules' ? false : mine)
        continue
      }
      if (
        DROP_FILE.test(name) ||
        (mine && DROP_OWN_TS.test(name)) ||
        (isPackageRoot && DROP_AT_PACKAGE_ROOT.test(name))
      )
        drop(path, st)
    }
  }
  walk(root, false)
  return { files, bytes }
}

/** 一棵目录里有几个文件、多少字节（不跟符号链接）。 */
export function sizeOfTree(root) {
  let files = 0
  let bytes = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const path = join(dir, name)
      let st
      try {
        st = lstatSync(path)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) walk(path)
      else {
        files += 1
        bytes += st.size
      }
    }
  }
  walk(root)
  return { files, bytes }
}

// ── ⑫ WP327：Windows 安装器挪进版本目录的条目清单 ───────────────────────────

/** 生成到 `build/` 里、由 `build/installer.nsh` include 的那份（只给 NSIS 用；不进仓库）。 */
export const APP_ENTRIES_NSH = 'agentsws-app-entries.nsh'

/**
 * win-unpacked 根上的每个条目 → NSIS 宏 `agentswsAppEntries CMD`（对每个条目各展开一次 CMD）。
 * 安装器只挪 / 只删这些名字，安装目录里别的东西（用户自己放的、卸载程序、版本目录、联接）一个不碰。
 */
export function appEntriesNsh(names) {
  const bad = names.find((n) => /["$\r\n]/.test(n) || n === 'current' || n.startsWith('app-'))
  if (bad !== undefined) throw new Error(`win-unpacked 根上有安装器处理不了的名字：${bad}`)
  return [
    '; WP327：afterPack 按这一版 win-unpacked 根上的条目生成（scripts/after-pack.mjs），不要手改。',
    '!macro agentswsAppEntries CMD',
    ...[...names].sort().map((n) => `  !insertmacro \${CMD} "${n}"`),
    '!macroend',
    '',
  ].join('\r\n')
}

// ── 钩子本体 ────────────────────────────────────────────────────────────

/**
 * 10-15 Luoye：内测用户在 Mac 上下载打开报「agentsws 已损坏，请移到垃圾箱」。
 * 原因：没有苹果开发者签名（`identity: null`），afterPack 又改了 .app 里的文件，Electron 自带的链接器签名
 * 对不上了；从浏览器下载带上「来自网络」标记后，M 芯片 Mac 就把它判成「已损坏」，弹窗里没有「仍要打开」。
 * 在苹果开发者签名 + 公证上线前，先给整个 .app 做一次**本机自签（ad-hoc）**：系统改报「无法验证开发者」，
 * 用户在「系统设置 → 隐私与安全性」点「仍要打开」即可，不用开终端。
 *
 * 先逐个签 Resources 里的散装 Mach-O（捆绑的 node、原生模块 .node / .dylib），再整包 `--deep` 签，最后严格校验。
 */
const MACHO_MAGICS = new Set([
  'feedfacf',
  'cffaedfe',
  'feedface',
  'cefaedfe',
  'cafebabe',
  'bebafeca',
])

export function isMachO(file) {
  try {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.alloc(4)
      if (readSync(fd, buf, 0, 4, 0) < 4) return false
      return MACHO_MAGICS.has(buf.toString('hex'))
    } finally {
      closeSync(fd)
    }
  } catch {
    return false
  }
}

function looseMachOFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        // 嵌套的 .app / .framework 交给 --deep
        if (/\.(app|framework)$/.test(entry.name)) continue
        walk(full)
      } else if (entry.isFile() && isMachO(full)) out.push(full)
    }
  }
  walk(dir)
  return out
}

export function adhocSignMacApp(appPath, log, run = execFileSync) {
  const loose = looseMachOFiles(join(appPath, 'Contents', 'Resources'))
  for (const file of loose) run('codesign', ['--force', '--sign', '-', file], { stdio: 'pipe' })
  run('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'pipe' })
  run('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'pipe' })
  log(`本机自签（ad-hoc）：散装二进制 ${loose.length} 个 + 整包，校验通过`)
}

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

  // ⑫ WP327：Windows 安装器要挪进 app-<版本> 的条目（build/installer.nsh include 它）
  if (platformName === 'win32') {
    const entries = readdirSync(context.appOutDir)
    writeFileSync(join(DESKTOP_ROOT, 'build', APP_ENTRIES_NSH), appEntriesNsh(entries))
    log(`安装器的版本目录条目：${entries.length} 个`)
  }

  // ⑪ WP327：打成 bundle（放在许可证之后——许可证清单按打包前的依赖算；放在冒烟之前——打完照样要 import 得动）
  const beforeBundle = sizeOfTree(appDir)
  const esbuild = await import('esbuild')
  await bundleApp({ esbuild, appDir, log })
  const parsed = checkSyntax(process.execPath, join(appDir, BUNDLE_DIR))
  const afterBundle = sizeOfTree(appDir)
  log(
    `bundle 后 <resources>/app：${beforeBundle.files} → ${afterBundle.files} 个文件、` +
      `${Math.round(beforeBundle.bytes / 1e6)} → ${Math.round(afterBundle.bytes / 1e6)} MB（bundle 解析过 ${parsed} 个）`,
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

  // ⑥bis WP345：随包的浏览器插件（固定 key、版本 = 这一包）
  const extensionProblem = bundledExtensionProblem(resources, context.packager.appInfo.version)
  if (extensionProblem !== undefined) throw new Error(extensionProblem)
  log(`浏览器插件：${context.packager.appInfo.version}`)

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

  // ⑧ WP254 → WP327：npm 随包带，但只带 tgz（`<resources>/node/npm-<版本>.tgz` + `npm.json`）。
  // 服务进程第一次要 npm 时校验后解到自己的工具目录（apps/server/src/npm-runtime.ts）。万一解开的那 2009 个文件
  // 还是进了包（extraResources 的过滤没生效），这里删掉——它们是安装 / 更新慢的大头之一
  const lockNpm = readJson(join(DESKTOP_ROOT, 'node-runtime.lock.json'))?.npm
  const npmVersion = lockNpm?.version
  const strayNpm = removeUnpackedNpm(resources)
  if (strayNpm > 0) log(`随包的 npm：删了漏进来的解开版 ${strayNpm} 个文件（只留 tgz）`)
  const npmProblem = bundledNpmTarballProblem(resources, lockNpm)
  if (npmProblem !== undefined) throw new Error(npmProblem)
  log(`随包的 npm：${npmVersion}（tgz）`)

  // ⑩ WP319：瘦身（放在冒烟之前——删过之后照样 import 得动，才算数）
  const before = sizeOfTree(context.appOutDir)
  const prunedApp = pruneNonRuntimeFiles(join(appDir, 'node_modules'))
  const stripped = stripPackagePaths(join(appDir, 'node_modules'))
  log(`去掉 dsh 调试工具前端：${stripped.files} 个文件（${Math.round(stripped.bytes / 1e6)} MB）`)
  const after = sizeOfTree(context.appOutDir)
  log(
    `瘦身：删了 ${prunedApp.files} 个运行时用不到的文件（${Math.round(prunedApp.bytes / 1e6)} MB）；` +
      `安装目录 ${before.files} → ${after.files} 个文件、${Math.round(after.bytes / 1e6)} MB`,
  )

  if (platformName === hostPlatform()) {
    const out = probeBundled(
      nodeExec,
      appDir,
      plan.map((p) => p.pkgDir),
    )
    log(`捆绑 Node 冒烟：${out.trim()}`)
    // 照服务进程的做法把 tgz 解到临时目录，用捆绑的 Node 真跑一次 `npm --version`
    const npmTmp = mkdtempSync(join(tmpdir(), 'agentsws-npm-'))
    try {
      const cli = unpackNpmTarball(resources, npmTmp)
      const npmOut = execFileSync(nodeExec, [cli, '--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', npm_config_update_notifier: 'false' },
      }).trim()
      if (npmOut !== npmVersion)
        throw new Error(`捆绑 Node 跑随包的 npm 回的是 ${npmOut}，应是 ${npmVersion}`)
      log(`随包 npm 冒烟（从 tgz 解开）：${npmOut}`)
    } finally {
      rmSync(npmTmp, { recursive: true, force: true })
    }
  } else {
    log(`跨平台打包（${platformName} ≠ ${hostPlatform()}），冒烟跳过`)
  }

  // ⑬ 10-15：mac 整包本机自签（放在最后——之后不能再改 .app 里任何文件）
  if (platformName === 'darwin' && hostPlatform() === 'darwin') {
    adhocSignMacApp(join(context.appOutDir, `${productName}.app`), log)
  }
}

function hostPlatform() {
  return process.platform
}
