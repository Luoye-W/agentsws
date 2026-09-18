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
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

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
  return [...new Set([...Object.keys(meta?.dependencies ?? {}), ...peers])]
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
import(pathToFileURL(req.resolve('@agentsws/server')).href).then(
  (m) => {
    if (typeof m.createServer !== 'function') throw new Error('@agentsws/server 里没有 createServer')
    process.stdout.write('probe ok\\n')
  },
  (err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\\n')
    process.exit(1)
  },
)
`

export function probeBundled(nodeExec, appDir, pkgDirs) {
  return execFileSync(nodeExec, ['-e', PROBE, appDir, ...pkgDirs], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
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

  const nodeExec =
    platformName === 'win32'
      ? join(resources, 'node', 'node.exe')
      : join(resources, 'node', 'bin', 'node')
  if (!existsSync(nodeExec))
    throw new Error(`安装包里没有捆绑的 Node：${nodeExec}（extraResources 没生效？）`)

  if (platformName === hostPlatform()) {
    const out = probeBundled(
      nodeExec,
      appDir,
      plan.map((p) => p.pkgDir),
    )
    log(`捆绑 Node 冒烟：${out.trim()}`)
  } else {
    log(`跨平台打包（${platformName} ≠ ${hostPlatform()}），冒烟跳过`)
  }
}

function hostPlatform() {
  return process.platform
}
