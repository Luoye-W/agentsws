/**
 * WP327（Luoye 10-14「安装包为什么这么大」）：打完包之后，把 `<resources>/app` 里的**桌面壳主进程、服务进程
 * 与 dsh / cordis 那一整串**用 esbuild 打成一组 bundle（`<resources>/app/bundle/`），再把 node_modules 里
 * 已经打进去、运行时不再需要的文件删掉。
 *
 * 为什么文件数要紧：asar 关着（服务进程跑在随包 Node 上），NSIS 装 / 更新、杀毒扫描的时间几乎和文件数成正比
 * （WP319 / WP325：1.8 万个文件，静默装 3 分钟）。
 *
 * 怎么做才不改变运行时行为（每一条都对应一个踩过 / 想得到的坑）：
 *
 * 1. **一次构建、多个入口、共用分块**（splitting）。入口 = 桌面壳主进程、服务进程、dsh 无头子进程、
 *    以及每个 `@agentsws/*` / `@deepseek-ai/*` 包在 `exports` / `bin` 里登记的每一个具体 JS 路径。
 *    同一个源文件只进一个分块——服务进程里 cordis 只有一份实例，按名字动态加载的插件拿到的也是这一份。
 * 2. **按名字找得到**：那些入口文件原地换成一行「桩」（`export * from '<bundle 里对应的入口>'`），包的
 *    package.json 与非 JS 文件留着。cordis loader 按包名 `import()`、dsh 场景按 `bin` 起 CLI、
 *    桌面壳 `import('@agentsws/server')`、服务进程按路径被 spawn——全都落到桩上，再进 bundle。
 * 3. **自己的位置不变**：每个被打进去的模块里的 `import.meta.url / dirname / filename`、CJS 的
 *    `__dirname / __filename`，都换成「它原来所在的那个文件」的位置（按 bundle 目录的相对路径算，
 *    装到哪里都对）。按路径读 yml / md / 角色目录、`createRequire(import.meta.url)` 解析原生模块，
 *    行为与打包前一字不差。
 * 4. **原生模块、Playwright、electron-updater 及它们的依赖整串不打**（external），原样留在 node_modules。
 * 5. **删得保守**：只删「它的 JS 全进了 bundle、而且它从不按自己的位置找文件」的包；会按自己位置读文件
 *    （worker 脚本、给浏览器的静态资源…）或被 `createRequire()` 按名字运行时加载的包整包留下。
 *
 * 打完由 afterPack 照旧用捆绑的 Node 冒烟（import 服务入口、开内存库…），过了才算数。
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** 不打进 bundle 的包（连同它们的依赖整串）：原生模块、自带驱动 / 按路径起子进程的、只给 Electron 主进程用的。 */
export const EXTERNAL_ROOTS = [
  'better-sqlite3',
  'sharp',
  'koffi',
  'node-pty',
  'playwright-core',
  'playwright',
  'electron-updater',
]

/** Node / Electron 自带的模块名（`electron` 在主进程里由 Electron 提供）。 */
const BUILTIN_EXTERNALS = ['electron']

/** 要做成入口（换成桩）的包：我们自己的与 dsh / cordis 那一串。 */
export const ENTRY_SCOPES = ['@agentsws/', '@deepseek-ai/']

/** bundle 放在哪（相对 `<resources>/app`）。 */
export const BUNDLE_DIR = 'bundle'

const JS_FILE = /\.(c|m)?js$/i

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const toPosix = (p) => p.split(sep).join('/')

// ── 包清单 ───────────────────────────────────────────────────────────────

/**
 * node_modules 里的每一个包（含嵌套的 node_modules）：`{ name, dir }`。
 * 不跟符号链接（打出来的包里本来就不该有）。
 */
export function listPackages(nodeModules) {
  const out = []
  const visit = (nm) => {
    if (!existsSync(nm)) return
    for (const entry of readdirSync(nm)) {
      if (entry.startsWith('.')) continue
      const path = join(nm, entry)
      if (!lstatSync(path).isDirectory()) continue
      if (entry.startsWith('@')) {
        for (const sub of readdirSync(path)) {
          const dir = join(path, sub)
          if (lstatSync(dir).isDirectory()) addPackage(`${entry}/${sub}`, dir)
        }
      } else addPackage(entry, path)
    }
  }
  const addPackage = (name, dir) => {
    if (!existsSync(join(dir, 'package.json'))) return
    out.push({ name, dir })
    visit(join(dir, 'node_modules'))
  }
  visit(nodeModules)
  return out
}

/** 这个包运行时会用到的包名（dependencies + 非可选 peer + optional）。 */
export function runtimeDeps(meta) {
  const optionalPeers = meta?.peerDependenciesMeta ?? {}
  return [
    ...Object.keys(meta?.dependencies ?? {}),
    ...Object.keys(meta?.peerDependencies ?? {}).filter((n) => optionalPeers[n]?.optional !== true),
    ...Object.keys(meta?.optionalDependencies ?? {}),
  ]
}

/** 从 `roots` 出发按依赖走一遍，回所有被带到的包名（按名字，不分版本）。 */
export function dependencyClosure(packages, roots) {
  const byName = new Map()
  for (const p of packages) {
    const list = byName.get(p.name) ?? []
    list.push(p)
    byName.set(p.name, list)
  }
  const seen = new Set()
  const queue = roots.filter((r) => byName.has(r))
  while (queue.length > 0) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    for (const p of byName.get(name) ?? []) {
      for (const dep of runtimeDeps(readJson(join(p.dir, 'package.json')))) {
        if (!seen.has(dep) && byName.has(dep)) queue.push(dep)
      }
    }
  }
  return seen
}

/** 包里有没有原生二进制（`.node` 或 `binding.gyp`）——有就不打。 */
export function hasNativeBinary(dir) {
  let found = false
  const walk = (d, depth) => {
    if (found || depth > 6) return
    let entries
    try {
      entries = readdirSync(d)
    } catch {
      return
    }
    for (const e of entries) {
      if (found) return
      if (e === 'node_modules') continue
      const p = join(d, e)
      let st
      try {
        st = lstatSync(p)
      } catch {
        continue
      }
      if (st.isDirectory()) walk(p, depth + 1)
      else if (e.endsWith('.node') || e === 'binding.gyp') found = true
    }
  }
  walk(dir, 0)
  return found
}

// ── 入口 ────────────────────────────────────────────────────────────────

/**
 * 一个 `exports` 值里的具体目标（按 node / import / default 条件挑；`types` 不要；带 `*` 的通配不要）。
 * 回相对包根的路径（`./lib/index.js`）。
 */
export function exportTargets(value) {
  const out = []
  const pick = (v) => {
    if (typeof v === 'string') {
      if (!v.includes('*')) out.push(v)
      return
    }
    if (Array.isArray(v)) {
      for (const item of v) pick(item)
      return
    }
    if (v === null || typeof v !== 'object') return
    for (const [cond, target] of Object.entries(v)) {
      if (cond === 'types' || cond === 'browser' || cond === 'require') continue
      pick(target)
    }
  }
  pick(value)
  return out
}

/** 一个包的全部入口文件（绝对路径）：exports 的每个具体 JS 目标、`bin`、没有 exports 时的 main。 */
export function packageEntryFiles(dir, meta) {
  const rels = new Set()
  const exp = meta?.exports
  if (typeof exp === 'string' || Array.isArray(exp)) for (const t of exportTargets(exp)) rels.add(t)
  else if (exp !== null && typeof exp === 'object') {
    const keys = Object.keys(exp)
    // 条件对象（没有以 . 开头的键）就是「.」那一项
    if (keys.length > 0 && !keys.some((k) => k.startsWith('.')))
      for (const t of exportTargets(exp)) rels.add(t)
    else
      for (const k of keys) {
        // `./client`：dsh 的「给浏览器的那一半」（window.__ModuleLoader__ 格式，dsh-client-modules 按路径读出来发给页面）
        if (k === './client' || k.endsWith('/client')) continue
        for (const t of exportTargets(exp[k])) rels.add(t)
      }
  } else {
    rels.add(typeof meta?.main === 'string' ? meta.main : './index.js')
  }
  const bin = meta?.bin
  if (typeof bin === 'string') rels.add(bin)
  else if (bin !== null && typeof bin === 'object') for (const v of Object.values(bin)) rels.add(v)
  const files = []
  for (const rel of rels) {
    const abs = resolve(dir, rel)
    if (!abs.startsWith(resolve(dir) + sep)) continue
    if (JS_FILE.test(abs) && existsSync(abs) && lstatSync(abs).isFile() && !isBrowserFile(abs))
      files.push(abs)
  }
  return [...new Set(files)].sort()
}

/** 给浏览器的文件（dsh 的 client 模块格式）：不做入口、不删，原样留给按路径读它的服务端。 */
export function isBrowserFile(file) {
  try {
    const head = readFileSync(file, 'utf8').slice(0, 400)
    return /^\s*(\/\/[^\n]*\n\s*)*window\.__ModuleLoader__/.test(head)
  } catch {
    return false
  }
}

/** 这个 JS 文件是不是 CommonJS（`.cjs`，或 `.js` 且往上最近的 package.json 没写 `type: module`）。 */
export function isCommonJsFile(file) {
  if (/\.cjs$/i.test(file)) return true
  if (!/\.js$/i.test(file)) return false
  let dir = dirname(file)
  for (let i = 0; i < 12; i += 1) {
    const meta = readJson(join(dir, 'package.json'))
    if (meta !== undefined) return meta.type !== 'module'
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return true
}

/** 文件所在包是不是 ESM（`.mjs`，或 `.js` 且最近的 package.json 写了 `type: module`）。 */
export function isEsmFile(file, packageDir) {
  if (file.endsWith('.mjs')) return true
  if (file.endsWith('.cjs')) return false
  return readJson(join(packageDir, 'package.json'))?.type === 'module'
}

/** 入口名（bundle 里的文件名）：路径里的分隔符与 @ 换成安全字符。 */
export function entryNameFor(appDir, file) {
  return toPosix(relative(appDir, file))
    .replace(/^node_modules\//, '')
    .replace(/\.(c|m)?js$/i, '')
    .replace(/node_modules\//g, '')
    .replace(/[@/]/g, (c) => (c === '@' ? '' : '__'))
}

// ── 改写「自己的位置」────────────────────────────────────────────────────

/**
 * 每个输出文件开头的小助手：按 bundle 文件自己的位置 + 相对路径，算出模块「原来」的 URL / 路径。
 * 名字都带 `__aw_` 前缀，不会和被打进来的代码撞名。
 * - `require`：ESM 输出里 esbuild 对 external 的 `require()` 生成的 `__require` 查的就是它；
 * - `__aw_import`：算出来的 `import(x)`（esbuild 看不见）——相对路径按模块**原来**的位置解析。
 */
export const BANNER = [
  "import { createRequire as __aw_cr } from 'node:module';",
  "import { fileURLToPath as __aw_fp } from 'node:url';",
  "import { realpathSync as __aw_rp } from 'node:fs';",
  'const require = __aw_cr(import.meta.url);',
  'const __aw_url = (r) => new URL(r, import.meta.url).href;',
  'const __aw_file = (r) => __aw_fp(__aw_url(r));',
  String.raw`const __aw_dir = (r) => __aw_fp(new URL('.', __aw_url(r))).replace(/[\\/]+$/, '');`,
  // `import.meta.main`：这个模块原来那个文件（现在是桩）是不是进程入口
  String.raw`const __aw_main = (r) => { try { const n = (p) => { const x = __aw_rp.native(p); return process.platform === 'win32' ? x.toLowerCase() : x }; return process.argv[1] !== undefined && n(process.argv[1]) === n(__aw_file(r)) } catch { return false } };`,
  // `import.meta.resolve('./x')`：相对路径按原位置；包名照常（bundle 与原位置找到的是同一个 node_modules）
  String.raw`const __aw_resolve = (b, s) => (/^\.\.?\//.test(s) ? new URL(s, b).href : import.meta.resolve(s));`,
  String.raw`const __aw_import = (b, s) => import(typeof s === 'string' && /^\.\.?\//.test(s) ? new URL(s, b).href : s);`,
].join('\n')

/** 算出来的动态 import（`import(x)`，不是字面量；`obj.import(...)` 这种方法调用不算）。 */
const COMPUTED_IMPORT = /(?<![\w$.])import\s*\(\s*(?![\s'"`)])/g

/** `async import(…) {` 这种叫 import 的方法定义不是动态 import。 */
const METHOD_NAMED_IMPORT = /(?:\basync\s+|^\s*)import\s*\([^()]*\)\s*\{/gm

/**
 * 算出来的动态 import：参数是同一文件里 `const X = '<字面量>'` 的，按字面量算（`constSpecs`）；
 * 其余的说不清会加载什么（`computedImport: true`）。
 */
export function computedImports(code) {
  const stripped = code.replace(METHOD_NAMED_IMPORT, '')
  const constSpecs = []
  let computedImport = false
  for (const m of stripped.matchAll(new RegExp(`${COMPUTED_IMPORT.source}([^)]*)\\)?`, 'g'))) {
    const arg = (m[1] ?? '').trim()
    const id = /^[A-Za-z_$][\w$]*$/.test(arg) ? arg : undefined
    const lit =
      id === undefined
        ? undefined
        : new RegExp(
            `(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*['"]([^'"]+)['"]`,
          ).exec(code)?.[1]
    if (lit === undefined) computedImport = true
    else constSpecs.push(lit)
  }
  return { computedImport, constSpecs }
}

/** 一个源文件的「位置相关」事实（只读文本，不跑代码）。 */
export function scanSource(code) {
  const literals = (re) => [...code.matchAll(re)].map((m) => m[1])
  const metaUrlUses = code.match(/import\.meta\.url\b/g)?.length ?? 0
  const forRequire = code.match(/createRequire\(\s*import\.meta\.url\s*\)/g)?.length ?? 0
  return {
    /** 按自己的位置找东西（只为 `createRequire(import.meta.url)` 解析包名的不算）。 */
    locationAware:
      /\b__dirname\b|\b__filename\b/.test(code) ||
      /import\.meta\.(dirname|filename)\b/.test(code) ||
      metaUrlUses > forRequire,
    ...computedImports(code),
    /** `new URL('<字面量>', import.meta.url)` 里的字面量。 */
    urlRefs: literals(/new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g),
    /** `import.meta.resolve('<字面量>')`。 */
    metaResolves: literals(/import\.meta\.resolve\(\s*['"]([^'"]+)['"]\s*\)/g),
    /** `join(__dirname, 'a', 'b.js')` / `resolve(__dirname, …)` 拼出来的相对路径。 */
    dirnameJoins: [
      ...code.matchAll(/\b(?:join|resolve)\(\s*__dirname\s*((?:,\s*['"][^'"]+['"]\s*)+)\)/g),
    ].map((m) => [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]).join('/')),
    required: runtimeRequiredNames(code),
    cjs: looksCommonJs(code),
  }
}

/**
 * 按名字在运行时 `require` 的包（esbuild 看不见的那种）：`const r = createRequire(…)` 之后 `r('x')`、
 * `r.resolve('x')`，以及任何 `require.resolve('x')`。回包名（去掉子路径）。
 */
export function runtimeRequiredNames(code) {
  const names = new Set()
  const fns = new Set()
  for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\.)?createRequire\s*\(/g))
    fns.add(m[1])
  const add = (spec) => {
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('node:')) return
    names.add(packageNameOf(spec))
  }
  for (const fn of fns) {
    const esc = fn.replace(/\$/g, '\\$')
    for (const m of code.matchAll(
      new RegExp(`(?<![\\w$.])${esc}(?:\\.resolve)?\\(\\s*['"]([^'"\\s]+)['"]`, 'g'),
    ))
      add(m[1])
  }
  for (const m of code.matchAll(/\brequire\.resolve\(\s*['"]([^'"\s]+)['"]/g)) add(m[1])
  return [...names]
}

/** CommonJS 文件里字面量 `require('x')` 的包名（原样留在磁盘上的 CJS 文件，它要的包也得留）。 */
export function literalRequires(code) {
  const names = new Set()
  for (const m of code.matchAll(/(?<![\w$.])require\(\s*['"]([^'"\s]+)['"]\s*\)/g)) {
    const spec = m[1]
    if (!spec.startsWith('.') && !spec.startsWith('/') && !spec.startsWith('node:'))
      names.add(packageNameOf(spec))
  }
  return [...names]
}

/** 看起来是 CommonJS（没有顶层 import / export 语句）。 */
export function looksCommonJs(code) {
  return !/^\s*(import\s*[\w{*'"]|export\s)/m.test(code)
}

/**
 * 把一个模块的源码改成「位置不变」的样子：`rel` 是从 bundle 目录到这个文件原位置的相对路径（posix）。
 * - `import.meta.url / dirname / filename` → 模块顶上新加的常量（标识符替换，字符串里出现也不会坏语法）；
 * - 算出来的 `import(x)` → `__aw_import(<原位置>, x)`（相对路径按原位置解析）；
 * - CommonJS 里用到 `__dirname / __filename` → 模块顶上声明一份（esbuild 把 CJS 包进函数，只在这个模块里生效）；
 * - 开头的 `#!` 去掉（不然前面加不了代码）。
 */
export function rewriteLocation(code, rel) {
  let body = code.startsWith('#!') ? code.slice(code.indexOf('\n') + 1) : code
  const lit = JSON.stringify(rel)
  const head = []
  const meta = /import\.meta\.(url|dirname|filename|main|resolve)\b/.test(body)
  const dyn = computedImports(body)
  const computed = dyn.computedImport || dyn.constSpecs.length > 0
  if (meta || computed) {
    body = body
      .replace(/import\.meta\.url\b/g, '__aw_m_url')
      .replace(/import\.meta\.dirname\b/g, '__aw_m_dirname')
      .replace(/import\.meta\.filename\b/g, '__aw_m_filename')
      .replace(/import\.meta\.resolve\s*\(/g, '__aw_resolve(__aw_m_url, ')
    const usesMain = /import\.meta\.main\b/.test(body)
    if (usesMain) {
      body = body.replace(/import\.meta\.main\b/g, '__aw_m_main')
      head.push(`const __aw_m_main = __aw_main(${lit});`)
    }
    if (computed) body = replaceComputedImports(body)
    head.push(
      `const __aw_m_url = __aw_url(${lit}), __aw_m_dirname = __aw_dir(${lit}), __aw_m_filename = __aw_file(${lit});`,
    )
  }
  if (/\b__dirname\b|\b__filename\b/.test(body) && looksCommonJs(body)) {
    head.push(`var __dirname = __aw_dir(${lit}), __filename = __aw_file(${lit});`)
  }
  if (head.length === 0) return body === code ? code : body
  return `${head.join('\n')}\n${body}`
}

/** 把算出来的 `import(x)` 换成 `__aw_import(__aw_m_url, x)`；叫 import 的方法定义不动。 */
function replaceComputedImports(body) {
  const keep = new Set()
  for (const m of body.matchAll(METHOD_NAMED_IMPORT)) {
    const at = m.index + m[0].indexOf('import')
    keep.add(at)
  }
  return body.replace(new RegExp(COMPUTED_IMPORT.source, 'g'), (match, offset) =>
    keep.has(offset) ? match : '__aw_import(__aw_m_url, ',
  )
}

/** 包名（`@s/n/sub` → `@s/n`）。 */
export function packageNameOf(spec) {
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? spec)
}

/** 一个文件属于哪个包（最深的那个包目录）。 */
export function owningPackage(packages, file) {
  let best
  for (const p of packages) {
    const prefix = p.dir + sep
    if (file.startsWith(prefix) && (best === undefined || p.dir.length > best.dir.length)) best = p
  }
  return best
}

// ── 规划与构建 ───────────────────────────────────────────────────────────

const isScoped = (name) => ENTRY_SCOPES.some((s) => name.startsWith(s))

/** 一个包目录里的文件（不进嵌套的 node_modules）。 */
export function packageFiles(dir) {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e)
      const st = lstatSync(p)
      if (st.isDirectory()) {
        if (e !== 'node_modules') walk(p)
      } else out.push(p)
    }
  }
  walk(dir)
  return out
}

/**
 * 起点规划：包清单、不打的（原生模块等整串 + `keepNames` 整串）、入口
 * （`@agentsws/*` / `@deepseek-ai/*` 登记的每个具体 JS 路径 + `extraEntries`）。
 */
export function planBundle(appDir, { extraEntries = [], keepNames = [] } = {}) {
  const nodeModules = join(appDir, 'node_modules')
  const packages = listPackages(nodeModules)
  const nativeRoots = packages.filter((p) => hasNativeBinary(p.dir)).map((p) => p.name)
  const externals = dependencyClosure(packages, [...EXTERNAL_ROOTS, ...nativeRoots, ...keepNames])
  const entries = new Map()
  const skipped = []
  for (const p of packages) {
    if (!isScoped(p.name) || externals.has(p.name)) continue
    const meta = readJson(join(p.dir, 'package.json'))
    for (const file of packageEntryFiles(p.dir, meta)) {
      if (!isEsmFile(file, p.dir)) {
        skipped.push(toPosix(relative(appDir, file)))
        continue
      }
      entries.set(entryNameFor(appDir, file), file)
    }
  }
  for (const file of extraEntries)
    if (existsSync(file)) entries.set(entryNameFor(appDir, file), file)
  return { packages, externals, entries, skipped }
}

/** esbuild 插件：external 判定 + 改写位置 + 记下每个文件的位置事实。 */
function locationPlugin({ outdir, externals, facts, unresolved, dynamicCjs }) {
  return {
    name: 'agentsws-location',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData?.agentsws === true) return undefined
        const spec = args.path
        if (spec.startsWith('node:') || BUILTIN_EXTERNALS.includes(spec))
          return { path: spec, external: true }
        if (/^[a-z]+:/i.test(spec) || spec.startsWith('.') || spec.startsWith('/')) return undefined
        if (externals.has(packageNameOf(spec))) return { path: spec, external: true }
        const r = await build.resolve(spec, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          importer: args.importer,
          pluginData: { agentsws: true },
        })
        if (r.errors.length > 0) {
          // 解析不到（可选依赖没装、别的平台的包、给浏览器的）：留给运行时，与打包前一样到用时才失败
          unresolved.add(spec)
          return { path: spec, external: true }
        }
        // `await import('<CommonJS 包>')`：Node 会按 cjs-module-lexer 给出具名导出，esbuild 分块后只剩 default
        // （10-14 实测 undici 的 getGlobalDispatcher 拿成 undefined）。这类包整包不打、留在磁盘上，由 Node 自己加载
        if (args.kind === 'dynamic-import' && isCommonJsFile(r.path))
          dynamicCjs.add(packageNameOf(spec))
        return r
      })
      build.onLoad({ filter: /\.(c|m)?js$/ }, (args) => {
        const code = readFileSync(args.path, 'utf8')
        facts.set(args.path, scanSource(code))
        const rel = toPosix(relative(outdir, args.path))
        return {
          contents: rewriteLocation(code, rel),
          loader: 'js',
          resolveDir: dirname(args.path),
        }
      })
    },
  }
}

/** 跑一次 esbuild（`esbuild` 注入）。 */
export async function buildBundle({ esbuild, appDir, plan }) {
  const outdir = join(appDir, BUNDLE_DIR)
  rmSync(outdir, { recursive: true, force: true })
  mkdirSync(outdir, { recursive: true })
  const facts = new Map()
  const unresolved = new Set()
  const dynamicCjs = new Set()
  const result = await esbuild.build({
    absWorkingDir: appDir,
    entryPoints: Object.fromEntries(plan.entries),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    splitting: true,
    outdir,
    entryNames: '[name]',
    chunkNames: 'chunk-[hash]',
    keepNames: true,
    metafile: true,
    logLevel: 'silent',
    banner: { js: BANNER },
    plugins: [locationPlugin({ outdir, externals: plan.externals, facts, unresolved, dynamicCjs })],
  })
  const inputs = new Set(Object.keys(result.metafile.inputs).map((p) => resolve(appDir, p)))
  return { outdir, metafile: result.metafile, facts, unresolved, inputs, dynamicCjs }
}

/**
 * 看一次构建的结果，回下一轮要加的东西：
 * - `entries`：会被「按路径 / 算出来的 import」加载的包里的**每个** ESM 文件（这样按路径加载落到桩上，再进 bundle）；
 * - `keepNames`：要整包留在磁盘上的第三方包（运行时按名字 require / resolve 的、按 `__dirname` 起 worker 的
 *   CommonJS 包、留在磁盘上的 CJS 文件要的包）；
 * - `rawFiles` / `rawDirs`：原样留下的文件与目录（CJS worker、给浏览器的静态目录）。
 */
export function analyze({ plan, facts }) {
  const { packages, externals } = plan
  const dynamic = new Set()
  const keepNames = new Set()
  const rawFiles = new Set()
  const rawDirs = new Set()
  for (const [file, f] of facts) {
    const pkg = owningPackage(packages, file)
    if (pkg === undefined || externals.has(pkg.name)) continue
    const here = dirname(file)
    for (const name of f.required) if (!isScoped(name)) keepNames.add(name)
    for (const spec of [...f.metaResolves, ...f.constSpecs]) {
      if (spec.startsWith('.')) continue
      const name = packageNameOf(spec)
      if (!isScoped(name) && !spec.startsWith('node:')) keepNames.add(name)
    }
    for (const ref of f.urlRefs) {
      const abs = resolve(here, ref)
      if (ref.endsWith('/')) rawDirs.add(abs)
      else if (/\.cjs$/i.test(ref)) rawFiles.add(abs)
      else if (JS_FILE.test(ref)) dynamic.add(pkg.dir)
    }
    if (f.computedImport) dynamic.add(pkg.dir)
    if (f.cjs && f.dirnameJoins.some((p) => JS_FILE.test(p))) {
      if (isScoped(pkg.name))
        for (const p of f.dirnameJoins)
          if (JS_FILE.test(p)) rawFiles.add(resolve(here, p))
          else keepNames.add(pkg.name)
    }
  }
  for (const file of rawFiles) {
    if (!existsSync(file)) continue
    for (const name of literalRequires(readFileSync(file, 'utf8')))
      if (!isScoped(name)) keepNames.add(name)
  }
  for (const name of [...keepNames]) if (isBuiltin(name)) keepNames.delete(name)
  // 带 .html 的目录是给浏览器的静态站（dsh inspector 的 devtools 之类）：整棵原样留下
  for (const dir of dynamic)
    for (const file of packageFiles(dir)) if (/\.html?$/i.test(file)) rawDirs.add(dirname(file))
  const underRaw = (file) => [...rawDirs].some((d) => file.startsWith(d + sep) || file === d)
  const entries = []
  for (const dir of dynamic) {
    for (const file of packageFiles(dir)) {
      if (isBrowserFile(file)) continue
      if (!JS_FILE.test(file) || rawFiles.has(file) || underRaw(file)) continue
      if (isEsmFile(file, owningPackage(packages, file)?.dir ?? dir)) entries.push(file)
    }
  }
  return { entries, keepNames: [...keepNames].sort(), rawFiles, rawDirs, dynamic }
}

// ── 桩与删减 ─────────────────────────────────────────────────────────────

/** 入口原位置上的那一行桩：转到 bundle 里对应的入口（带不带 default 按 bundle 的导出定）。 */
export function stubSource(stubFile, bundleFile, { hasDefault, hashbang }) {
  let rel = toPosix(relative(dirname(stubFile), bundleFile))
  if (!rel.startsWith('.')) rel = `./${rel}`
  const lines = []
  if (hashbang !== undefined) lines.push(hashbang)
  lines.push('// WP327：已打进 <resources>/app/bundle（scripts/bundle-app.mjs），这里只转过去。')
  lines.push(`export * from ${JSON.stringify(rel)};`)
  if (hasDefault) lines.push(`export { default } from ${JSON.stringify(rel)};`)
  return `${lines.join('\n')}\n`
}

/**
 * 一个包怎么删：`keep` 整包不动（不打的那些）；`pure` 第三方包、运行时只经 bundle 用到——整包删；
 * `partial` 我们自己的 / dsh 那一串 / 按位置找文件的——只删进了 bundle 的 JS，其余（数据、静态资源、
 * worker 脚本、package.json）留下，入口换成桩。
 */
export function packageDecision({ pkg, plan, facts, inputs, analysis }) {
  if (plan.externals.has(pkg.name)) return 'keep'
  if (isScoped(pkg.name) || analysis.dynamic.has(pkg.dir)) return 'partial'
  const prefix = pkg.dir + sep
  for (const [file, f] of facts) {
    if (!file.startsWith(prefix) || owningPackage(plan.packages, file) !== pkg) continue
    if (f.locationAware || f.computedImport || f.urlRefs.length > 0) return 'partial'
  }
  void inputs
  return 'pure'
}

/** 删掉空目录（自底向上）。 */
function removeEmptyDirs(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e)
    if (lstatSync(p).isDirectory()) removeEmptyDirs(p)
  }
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir)
  } catch {
    // 留着
  }
}

/** 照规划删文件、写桩。回 `{ stubs, droppedPackages, droppedFiles }`。 */
export function applyPrune({ appDir, plan, built, analysis }) {
  const outByEntry = new Map()
  for (const [out, meta] of Object.entries(built.metafile.outputs)) {
    if (meta.entryPoint === undefined) continue
    outByEntry.set(resolve(appDir, meta.entryPoint), { file: resolve(appDir, out), meta })
  }
  const entryFiles = new Set(plan.entries.values())
  const hashbangs = new Map()
  for (const file of entryFiles) {
    const head = existsSync(file) ? readFileSync(file, 'utf8').slice(0, 300) : ''
    if (head.startsWith('#!')) hashbangs.set(file, head.slice(0, head.indexOf('\n')))
  }
  const underRaw = (file) =>
    analysis.rawFiles.has(file) || [...analysis.rawDirs].some((d) => file.startsWith(d + sep))
  let droppedFiles = 0
  const droppedPackages = []
  for (const pkg of plan.packages) {
    if (!existsSync(pkg.dir)) continue
    const decision = packageDecision({
      pkg,
      plan,
      facts: built.facts,
      inputs: built.inputs,
      analysis,
    })
    if (decision === 'keep') continue
    const files = packageFiles(pkg.dir)
    if (decision === 'pure') {
      for (const f of files) rmSync(f, { force: true })
      droppedFiles += files.length
      droppedPackages.push(pkg.name)
      continue
    }
    for (const f of files) {
      if (entryFiles.has(f) || underRaw(f)) continue
      if (JS_FILE.test(f) && built.inputs.has(f)) {
        rmSync(f, { force: true })
        droppedFiles += 1
      }
    }
  }
  // 桌面壳自己的 dist（不在 node_modules 里）：进了 bundle 的删掉，入口换桩；preload（.cjs）等按路径加载的留着
  const ownDist = join(appDir, 'dist')
  if (existsSync(ownDist))
    for (const f of packageFiles(ownDist)) {
      if (entryFiles.has(f) || !built.inputs.has(f)) continue
      rmSync(f, { force: true })
      droppedFiles += 1
    }
  let stubs = 0
  for (const file of entryFiles) {
    const out = outByEntry.get(file)
    if (out === undefined) throw new Error(`bundle 里没有入口 ${file}`)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(
      file,
      stubSource(file, out.file, {
        hasDefault: (out.meta.exports ?? []).includes('default'),
        hashbang: hashbangs.get(file),
      }),
    )
    stubs += 1
  }
  removeEmptyDirs(join(appDir, 'node_modules'))
  return { stubs, droppedPackages, droppedFiles }
}

// ── 一条龙（afterPack 调它）──────────────────────────────────────────────

/**
 * 打 bundle → 看哪些包会按路径 / 按名字在运行时加载东西，补入口 / 补「整包留下」，再打（最多几轮，直到不再变）
 * → 写桩 → 删减。`esbuild` 注入（afterPack 里用开发依赖那一份）。
 * 默认额外入口：桌面壳主进程（`dist/main.js`）、dsh 无头子进程（按路径 spawn）、装包前冒烟按路径取的 official-plugins。
 */
export async function bundleApp({ esbuild, appDir: given, log = () => undefined, maxRounds = 6 }) {
  // esbuild 给的路径都是真实路径（mac 的 /var → /private/var、Windows 的短名）；包目录也按真实路径算，才对得上
  const appDir = realpathSync.native(given)
  const extraEntries = [
    join(appDir, 'dist', 'main.js'),
    join(appDir, 'node_modules', '@agentsws', 'dsh-adapter', 'dist', 'headless', 'child.js'),
    // 装包前冒烟（scripts/preinstall-smoke.mjs --app）与 afterPack 的冒烟按路径取这几个
    ...['official-plugins.js', 'computer-use-install.js', 'browserskill-install.js'].map((f) =>
      join(appDir, 'node_modules', '@agentsws', 'server', 'dist', f),
    ),
    join(appDir, 'dist', 'electron-updater-module.js'),
  ]
  const more = new Set()
  const keepNames = new Set()
  let plan
  let built
  let analysis
  for (let round = 1; ; round += 1) {
    plan = planBundle(appDir, {
      extraEntries: [...extraEntries, ...more],
      keepNames: [...keepNames],
    })
    built = await buildBundle({ esbuild, appDir, plan })
    analysis = analyze({ plan, facts: built.facts })
    const before = more.size + keepNames.size
    for (const f of analysis.entries) more.add(f)
    for (const n of analysis.keepNames) keepNames.add(n)
    for (const n of built.dynamicCjs) if (!isScoped(n)) keepNames.add(n)
    // 已经不打的包里的文件不必再做入口
    for (const f of [...more]) {
      const pkg = owningPackage(plan.packages, f)
      if (pkg !== undefined && plan.externals.has(pkg.name)) more.delete(f)
    }
    if (more.size + keepNames.size === before) break
    if (round >= maxRounds) throw new Error(`bundle 规划 ${maxRounds} 轮还没收敛`)
  }
  const applied = applyPrune({ appDir, plan, built, analysis })
  log(
    `bundle：${built.inputs.size} 个模块 → ${Object.keys(built.metafile.outputs).length} 个文件；` +
      `入口 / 桩 ${applied.stubs} 个（按路径或算出来的 import 加载的包 ${analysis.dynamic.size} 个）；` +
      `整包不打 ${plan.externals.size} 个（其中按名字运行时加载 ${keepNames.size} 个：${[...keepNames].join(', ') || '无'}）；` +
      `删了 ${applied.droppedPackages.length} 个包、共 ${applied.droppedFiles} 个文件` +
      (plan.skipped.length > 0 ? `；CommonJS 入口原样留下 ${plan.skipped.length} 个` : ''),
  )
  if (built.unresolved.size > 0)
    log(
      `bundle：解析不到、留给运行时（与打包前一样到用时才失败）：${[...built.unresolved].sort().join(', ')}`,
    )
  return { plan, built, analysis, applied }
}

/**
 * 一个 node 进程里把 bundle 目录下每个文件按 ES 模块**只解析不执行**一遍（`vm.SourceTextModule`）：
 * 撞名（banner 与模块顶层同名）、改写坏了语法之类的错误在打包时就暴露。回解析了几个。
 */
export function checkSyntax(nodeExec, dir) {
  const script = [
    "const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');",
    'const dir = process.argv[1]; let n = 0;',
    'for (const f of fs.readdirSync(dir)) { if (!/\\.js$/.test(f)) continue;',
    "  const file = path.join(dir, f); new vm.SourceTextModule(fs.readFileSync(file, 'utf8'), { identifier: file }); n += 1 }",
    'process.stdout.write(String(n))',
  ].join('\n')
  const out = execFileSync(
    nodeExec,
    ['--experimental-vm-modules', '--no-warnings', '-e', script, dir],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    },
  )
  return Number(out.trim())
}
