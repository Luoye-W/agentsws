#!/usr/bin/env node
/**
 * 安装包里的**第三方许可证说明**（WP148）。
 *
 * 清单来自现成的 `pnpm licenses list --prod --json`（`-F "@agentsws/desktop..."` = 桌面壳
 * 连同它依赖的所有工作区包，一路到服务进程、dsh、sharp 的运行期依赖）；每个包的许可证
 * 全文从包目录里的 LICENSE / COPYING / NOTICE 读，没有的（libvips 的预编译包就没有）退到
 * README 里的「Licensing」那一节。我们自己的 `@agentsws/*` 不列（见仓库根的 LICENSE）。
 *
 * 另外几项不在 npm 依赖树里、却确实在安装包里的，单独写一段人话：
 * libvips（LGPL-3.0，动态库形态）、Chromium / Electron、捆绑的 Node、better-sqlite3 预编译模块。
 *
 * 打包时由 `after-pack.mjs` 调用，写到 `<resources>/licenses/THIRD_PARTY_LICENSES.txt`；
 * 托盘菜单「开源软件许可」打开的就是它。也可以单独跑：
 *
 * ```
 * node scripts/third-party-licenses.mjs [输出路径，缺省 release/THIRD_PARTY_LICENSES.txt]
 * ```
 *
 * 只读本机已装好的 node_modules，**不联网**。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(here, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '..', '..')

export const NOTICE_FILE = 'THIRD_PARTY_LICENSES.txt'

/** 包目录里算「许可证原文」的文件名。 */
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/iu

/** 我们自己的包（许可证见仓库根的 LICENSE），不进第三方清单。 */
export function isOwnPackage(name) {
  return name.startsWith('@agentsws/')
}

/** 跑 `pnpm licenses list`（桌面壳 + 它依赖的全部工作区包，只看生产依赖）。 */
export function pnpmLicensesJson(cwd = REPO_ROOT) {
  const out = execFileSync(
    'pnpm',
    ['-F', '@agentsws/desktop...', 'licenses', 'list', '--prod', '--json'],
    {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  return JSON.parse(out)
}

/**
 * `pnpm licenses list --json` 的形状是「许可证 → 包[]」，一个包可能有几个版本 / 几条路径。
 * 摊平成一版一条，按名字排序；去掉我们自己的包。
 */
export function flattenLicenses(json) {
  const rows = []
  for (const [license, pkgs] of Object.entries(json ?? {})) {
    for (const pkg of pkgs ?? []) {
      if (typeof pkg?.name !== 'string' || isOwnPackage(pkg.name)) continue
      const versions = Array.isArray(pkg.versions) ? pkg.versions : []
      const paths = Array.isArray(pkg.paths) ? pkg.paths : []
      versions.forEach((version, i) => {
        rows.push({
          name: pkg.name,
          version,
          license: pkg.license ?? license,
          ...(typeof pkg.homepage === 'string' ? { homepage: pkg.homepage } : {}),
          ...(typeof pkg.author === 'string' ? { author: pkg.author } : {}),
          ...(paths[i] === undefined ? {} : { path: paths[i] }),
        })
      })
    }
  }
  rows.sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  )
  return rows
}

/** README 里「Licensing / License」那一节（到下一个同级标题为止）。 */
export function readmeLicenseSection(readme) {
  const lines = readme.split(/\r?\n/u)
  const start = lines.findIndex((l) => /^#{1,3}\s+licen[cs]/iu.test(l))
  if (start < 0) return undefined
  const level = (lines[start].match(/^#+/u) ?? ['#'])[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    const m = lines[i].match(/^(#+)\s/u)
    if (m !== null && m[1].length <= level) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n').trim()
}

/** 一个包的许可证原文：LICENSE 那几种文件依次拼起来；都没有就退到 README 那一节。 */
export function licenseTextOf(dir) {
  if (dir === undefined || !existsSync(dir)) return undefined
  let entries
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return undefined
  }
  const texts = entries
    .filter((f) => LICENSE_FILE.test(f))
    .map((f) => {
      try {
        return readFileSync(join(dir, f), 'utf8').trim()
      } catch {
        return ''
      }
    })
    .filter((t) => t !== '')
  if (texts.length > 0) return texts.join('\n\n')
  const readme = entries.find((f) => /^readme(\.md)?$/iu.test(f))
  if (readme === undefined) return undefined
  return readmeLicenseSection(readFileSync(join(dir, readme), 'utf8'))
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** 捆绑的 Node、Electron 的版本（写进人话那一段；读不到就不写版本号）。 */
export function bundledVersions(desktopRoot = DESKTOP_ROOT) {
  const lock = readJson(join(desktopRoot, 'node-runtime.lock.json'))
  const electron = readJson(join(desktopRoot, 'node_modules', 'electron', 'package.json'))
  return {
    ...(typeof lock?.node?.version === 'string' ? { node: lock.node.version } : {}),
    ...(typeof electron?.version === 'string' ? { electron: electron.version } : {}),
  }
}

/** 原生二进制：Node 扩展与动态库（`.node` / `.dylib` / `.dll` / `.so[.N]`）。 */
const NATIVE_FILE = /\.(node|dylib|dll)$|\.so(\.\d+)*$/u

/**
 * 装好的 `node_modules` 里**真带着原生二进制**的那些包（打包后的 app 目录里扫）。
 * 回「包名 → 相对路径[]」，按包名排序。认包按最近的那个带 `name` 的 package.json。
 */
export function findNativeBinaries(nodeModulesDir) {
  const found = new Map()
  const walk = (dir, pkg, depth) => {
    if (depth > 24) return
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    let owner = pkg
    if (entries.includes('package.json')) {
      const name = readJson(join(dir, 'package.json'))?.name
      if (typeof name === 'string' && name !== '') owner = name
    }
    for (const entry of entries) {
      const path = join(dir, entry)
      let stat
      try {
        stat = lstatSync(path)
      } catch {
        continue
      }
      if (stat.isSymbolicLink()) continue
      if (stat.isDirectory()) walk(path, owner, depth + 1)
      else if (NATIVE_FILE.test(entry) && owner !== undefined) {
        const files = found.get(owner) ?? []
        files.push(relative(nodeModulesDir, path).split(sep).join('/'))
        found.set(owner, files)
      }
    }
  }
  walk(nodeModulesDir, undefined, 0)
  return [...found.entries()]
    .map(([pkg, files]) => ({ pkg, files: files.sort() }))
    .sort((a, b) => a.pkg.localeCompare(b.pkg))
}

/** 带原生二进制、却不在许可证清单里的包（打包时有一个就失败——说明漏了）。 */
export function uncoveredNatives(natives, rows) {
  const listed = new Set(rows.map((r) => r.name))
  return natives.filter((n) => !isOwnPackage(n.pkg) && !listed.has(n.pkg)).map((n) => n.pkg)
}

/** 第一节：不看全文也该知道的那几项。 */
export function specialSection(rows, versions = {}, natives = undefined) {
  const libvips = rows.filter((r) => r.name.startsWith('@img/sharp-libvips-'))
  const sharp = rows.find((r) => r.name === 'sharp')
  const vipsOf = (r) => readJson(join(r.path ?? '', 'versions.json'))?.vips
  const out = ['一、需要特别说明的几项', '']
  out.push(
    '1. libvips 与它依赖的图像库（libvips 本身是 LGPL-3.0-or-later；其余各库的许可证见第三节）',
    '   用在哪：截图送进模型之前先缩小（sharp → libvips）。',
    '   什么形态：动态链接库，原样放在 app/node_modules/@img/sharp-libvips-<平台>/lib/ 里；',
    '     我们没有改它，也没有把它静态链接进我们自己的代码。',
    '   你可以：换成你自己编译的、接口兼容的 libvips（替换上面那个目录里的库文件即可）。',
    '   源代码：https://github.com/libvips/libvips ；预编译脚本：https://github.com/lovell/sharp-libvips',
    '   LGPL-3.0 全文：同目录 LGPL-3.0.txt（网上：https://www.gnu.org/licenses/lgpl-3.0.txt）',
    '     （它在 GPL-3.0 之上附加条款，GPL-3.0 全文：同目录 GPL-3.0.txt，网上：https://www.gnu.org/licenses/gpl-3.0.txt）',
  )
  if (libvips.length === 0) out.push('   这一次打包的依赖里没有 libvips。')
  for (const r of libvips) {
    const vips = vipsOf(r)
    out.push(
      `   本安装包里的：${r.name}@${r.version}${vips === undefined ? '' : `（libvips ${vips}）`}`,
    )
  }
  if (sharp !== undefined) out.push(`   调用它的 sharp：${sharp.version}（${sharp.license}）`)
  out.push(
    '',
    `2. Electron${versions.electron === undefined ? '' : ` ${versions.electron}`}（MIT）与它内含的 Chromium 及其依赖`,
    '   全文见同一目录下的 LICENSE.electron.txt 与 LICENSES.chromium.html',
    '   （Electron 官方随发行包提供，原样拷进来）。',
    '',
    `3. 服务进程用的那份 Node.js${versions.node === undefined ? '' : ` v${versions.node}`}（MIT；内含 V8、OpenSSL、libuv、ICU 等）`,
    `   各自的许可证：https://github.com/nodejs/node/blob/${versions.node === undefined ? 'main' : `v${versions.node}`}/LICENSE`,
    '',
    '4. better-sqlite3 的预编译模块（MIT；内含 SQLite，公有领域）',
    '   来自 https://github.com/WiseLibs/better-sqlite3/releases ，sha256 钉在 node-runtime.lock.json 里。',
    '',
  )
  if (natives !== undefined) {
    const byName = new Map(rows.map((r) => [r.name, r.license]))
    out.push('5. 安装包里带原生二进制（.node / 动态库）的包，许可证见第二、三节', '')
    for (const n of natives) {
      out.push(`   ${n.pkg}（${byName.get(n.pkg) ?? '见仓库根 LICENSE'}）`)
      for (const f of n.files) out.push(`     app/node_modules/${f}`)
    }
    out.push('')
  }
  return out.join('\n')
}

/** 第二节：按许可证汇总（一眼看出有没有 GPL 一类）。 */
export function summarySection(rows) {
  const by = new Map()
  for (const r of rows) {
    const key = r.license ?? 'UNKNOWN'
    const names = by.get(key) ?? new Set()
    names.add(r.name)
    by.set(key, names)
  }
  const keys = [...by.keys()].sort((a, b) => by.get(b).size - by.get(a).size || a.localeCompare(b))
  const out = ['二、按许可证汇总', '']
  for (const k of keys) {
    const names = [...by.get(k)].sort()
    out.push(`${k}（${names.length}）：${names.join(', ')}`, '')
  }
  return out.join('\n')
}

/** 第三节：逐个包的许可证全文。同一个包的几个版本文本一样就只印一次。 */
export function fullTextSection(rows, textOf = licenseTextOf) {
  const out = ['三、逐个包的许可证全文', '']
  let prev
  for (const r of rows) {
    const text = textOf(r.path)
    out.push(
      '-'.repeat(72),
      `${r.name}@${r.version}  —  ${r.license}${r.homepage === undefined ? '' : `  —  ${r.homepage}`}`,
      '',
    )
    if (text === undefined)
      out.push(
        `（包里没有附许可证原文，按它 package.json 标的 ${r.license} 使用${r.author === undefined ? '' : `；作者：${r.author}`}。）`,
      )
    else if (prev !== undefined && prev.name === r.name && prev.text === text) out.push('（同上）')
    else out.push(text)
    out.push('')
    prev = { name: r.name, text }
  }
  return out.join('\n')
}

export function renderNotice(rows, versions = {}, textOf = licenseTextOf, natives = undefined) {
  const head = [
    'Agents 工坊 · 第三方软件许可说明（Third-party notices）',
    '',
    'Agents 工坊本身按 Apache-2.0 开源（见 https://github.com/Luoye-W/agentsws 的 LICENSE）。',
    '这个安装包里还带着下面这些别人写的开源软件，它们各自的许可证原样列在这里。',
    `共 ${new Set(rows.map((r) => r.name)).size} 个 npm 包（${rows.length} 个版本），另有下面第一节列的几项。`,
    '',
    '',
  ].join('\n')
  return `${head}${specialSection(rows, versions, natives)}\n${summarySection(rows)}\n${fullTextSection(rows, textOf)}`
}

/** 生成并写盘；回写了多少条、有没有 libvips（打包日志里要看得见）。 */
export function writeNotice(outFile, options = {}) {
  const rows = flattenLicenses(options.json ?? pnpmLicensesJson())
  const text = renderNotice(
    rows,
    options.versions ?? bundledVersions(),
    licenseTextOf,
    options.natives,
  )
  mkdirSync(dirname(outFile), { recursive: true })
  writeFileSync(outFile, text, 'utf8')
  return {
    file: outFile,
    packages: new Set(rows.map((r) => r.name)).size,
    libvips: rows.filter((r) => r.name.startsWith('@img/sharp-libvips-')).map((r) => r.name),
    uncovered: options.natives === undefined ? [] : uncoveredNatives(options.natives, rows),
    bytes: Buffer.byteLength(text, 'utf8'),
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = resolve(process.argv[2] ?? join(DESKTOP_ROOT, 'release', NOTICE_FILE))
  const r = writeNotice(out)
  process.stdout.write(
    `${r.file}：${r.packages} 个包，${(r.bytes / 1024).toFixed(0)} KB；libvips：${r.libvips.join(', ') || '无'}\n`,
  )
}
