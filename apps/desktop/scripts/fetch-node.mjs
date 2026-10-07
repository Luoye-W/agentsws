#!/usr/bin/env node
/**
 * 把一份**独立的 Node 运行时**与**按它的 ABI 预编译的原生模块**下到 `vendor/`
 * （WP111；13 §5「一个安装包把运行时带齐」）。
 *
 * 为什么不借 Electron 自带的 Node：`better-sqlite3` 的 C++ 编不过 Electron 44 的 V8 头，
 * 而在 pnpm workspace 里为 Electron 重建还会把仓库里给普通 Node 用的那份 `.node` 覆盖掉
 * （见 README「原生模块与 sidecar 的 Node」）。所以服务进程跑在**独立 Node** 上，
 * 那份 Node 由这个脚本带进安装包。
 *
 * 两条纪律：
 *
 * 1. **每一个字节都对过 sha256**。Node 的哈希来自官方 `SHASUMS256.txt`，
 *    原生模块的哈希是我们自己第一次下的时候记下来的——两者都钉在
 *    `node-runtime.lock.json` 里并签进仓库。下回来对不上就当场失败，不覆盖、不将就。
 *    `--write-lock` 是唯一会改那份锁的入口（升 Node 版本时手动跑一次，diff 进 PR）。
 * 2. **ABI 必须一致**。捆绑的 Node 是 v22（`NODE_MODULE_VERSION` 127），原生模块就必须
 *    是 v127 那一份。脚本只按锁里的 `abi` 取 prebuild，绝不去碰仓库 `node_modules` 里
 *    那份给开发机 Node 用的 `.node`。
 *
 * 用法：
 *
 * ```
 * node scripts/fetch-node.mjs                      # 当前平台
 * node scripts/fetch-node.mjs --target win32-x64   # 指定平台
 * node scripts/fetch-node.mjs --all                # 锁里登记的全部平台（发版矩阵用）
 * node scripts/fetch-node.mjs --write-lock         # 重算 sha256 并写回锁（升版本时）
 * ```
 *
 * 3. **npm 跟着 Node 走**（WP254，决策 99）。一键安装平台 CLI、按需下载连接器都要 npm；以前安装包里
 *    只有一个 `node`，第一次点按钮还得联网下 npm。现在把**这版 Node 官方配套的那版 npm**
 *    （`nodejs.org/dist/index.json` 的 `npm` 字段）一起放进去，摆成官方发行包的布局——服务进程
 *    `apps/server/src/npm-runtime.ts` 的 `bundledNpmCandidates` 先找的就是这两处，不用再联网。
 *    来源是 registry 上同一个 tgz（Node 仓库的 `deps/npm` 就是解开的它），sha512 钉在锁里，
 *    与 registry 的 `dist.integrity` 逐字相同；四个平台共用一份，Windows 不必为它去下 30 MB 的 zip。
 *
 * 产物（`vendor/` 已 gitignore）：
 *
 * ```
 * vendor/node/<target>/bin/node          # win32 是 vendor/node/win32-x64/node.exe
 * vendor/node/<target>/lib/node_modules/npm/…   # win32 是 vendor/node/win32-x64/node_modules/npm/…
 * vendor/natives/<target>/<pkg>/<version>/build/Release/<file>.node
 * ```
 */
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
export const DESKTOP_ROOT = resolve(here, '..')
export const LOCK_FILE = join(DESKTOP_ROOT, 'node-runtime.lock.json')
export const VENDOR_DIR = join(DESKTOP_ROOT, 'vendor')

/** `process.platform`-`process.arch` → 官方发行包里那一段名字。 */
export const NODE_DIST_NAME = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64',
  'win32-x64': 'win-x64',
}

/** 这个平台上，捆绑的 Node 可执行文件落在 `vendor/node/<target>/` 里的哪儿。 */
export function nodeExecRelPath(target) {
  return target.startsWith('win32-') ? 'node.exe' : join('bin', 'node')
}

/**
 * 官方下载地址。
 *
 * Windows 单取一个 `node.exe`（`SHASUMS256.txt` 里就有这一行），
 * 免得为了一个可执行文件去解 60 MB 的 zip；其余平台取 `.tar.gz`，只抽里头的 `bin/node`。
 */
export function nodeDownloadUrl(version, target) {
  const dist = NODE_DIST_NAME[target]
  if (dist === undefined) throw new Error(`不认识的平台：${target}`)
  const base = `https://nodejs.org/dist/v${version}`
  return target.startsWith('win32-')
    ? { url: `${base}/${dist}/node.exe`, kind: 'exe', shasumKey: `${dist}/node.exe` }
    : {
        url: `${base}/node-v${version}-${dist}.tar.gz`,
        kind: 'tar.gz',
        shasumKey: `node-v${version}-${dist}.tar.gz`,
        member: `node-v${version}-${dist}/bin/node`,
      }
}

/** `prebuild-install` 用的那套命名（我们直接取，不跑 node-gyp）。 */
export function prebuildUrl(pkg, version, abi, target) {
  const [platform, arch] = target.split('-')
  return (
    `https://github.com/${pkg.repo}/releases/download/v${version}/` +
    `${pkg.name}-v${version}-node-v${abi}-${platform}-${arch}.tar.gz`
  )
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** `SHASUMS256.txt` → `{ 文件名: sha256 }`。 */
export function parseShasums(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (m?.[1] !== undefined && m[2] !== undefined) out[m[2]] = m[1]
  }
  return out
}

// ── 最小 tar 读取（只为了从官方包里抽一个文件；不引依赖）─────────────────
//
// ustar：512 字节头 + 内容按 512 对齐。长名走 `prefix` 字段（GNU 的 'L' 与 pax 的
// 'x' 头都跳过——Node 与 prebuild 的包里用不到）。

function tarString(buf, offset, length) {
  const raw = buf.subarray(offset, offset + length)
  const end = raw.indexOf(0)
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8')
}

/** 从 tar 字节流里取出第一个名字匹配的文件；取不到返回 undefined。 */
export function tarExtract(buf, wanted) {
  let offset = 0
  while (offset + 512 <= buf.length) {
    const name = tarString(buf, offset, 100)
    if (name === '') break
    const sizeOctal = tarString(buf, offset + 124, 12).trim()
    const size = sizeOctal === '' ? 0 : Number.parseInt(sizeOctal, 8)
    const type = tarString(buf, offset + 156, 1)
    const prefix = tarString(buf, offset + 345, 155)
    const full = prefix === '' ? name : `${prefix}/${name}`
    const body = offset + 512
    if (type !== 'x' && type !== 'g' && wanted(full))
      return { name: full, data: buf.subarray(body, body + size) }
    offset = body + Math.ceil(size / 512) * 512
  }
  return undefined
}

// ── npm（WP254）────────────────────────────────────────────────────────

/**
 * npm 在 `vendor/node/<target>/` 里摆在哪：与 Node 官方发行包同一布局
 * （Windows zip 里是 `node_modules/npm`，其余 tar.gz 里是 `lib/node_modules/npm`）。
 * 服务进程 `bundledNpmCandidates(<node 可执行文件>)` 按这两处找，两边改要一起改。
 */
export function npmRelDir(target) {
  return target.startsWith('win32-')
    ? join('node_modules', 'npm')
    : join('lib', 'node_modules', 'npm')
}

/** registry 上 npm 的 tgz 地址。 */
export function npmTarballUrl(version) {
  return `https://registry.npmjs.org/npm/-/npm-${version}.tgz`
}

/** `sha512-<base64>`（与 registry 的 `dist.integrity`、package-lock 的 `integrity` 同一写法）。 */
export function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

/** 与 {@link checkSha} 同一纪律：锁里没有 = 失败。 */
export function checkIntegrity(what, expected, actual) {
  if (expected === undefined || expected === '')
    throw new Error(`${what}：锁里没有 npm 的 integrity。升版本请先跑 --write-lock 并把 diff 提交`)
  if (expected !== actual)
    throw new Error(`${what} 的 sha512 对不上\n  锁里：${expected}\n  实际：${actual}`)
}

function paxPath(data) {
  for (const line of data.toString('utf8').split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(line)
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/**
 * tar 里的**全部普通文件**（npm 包会用 pax 'x' / GNU 'L' 长名，这里都认）。
 * 路径带 `..`、是绝对路径或盘符开头 → 整包当场拒绝（不是跳过：打包机上不将就）。
 */
export function tarEntries(buf) {
  const out = []
  let offset = 0
  let longName
  while (offset + 512 <= buf.length) {
    const header = buf.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const sizeOctal = tarString(buf, offset + 124, 12).trim()
    const size = sizeOctal === '' ? 0 : Number.parseInt(sizeOctal, 8)
    const modeOctal = tarString(buf, offset + 100, 8).trim()
    const mode = modeOctal === '' ? 0o644 : Number.parseInt(modeOctal, 8)
    const type = tarString(buf, offset + 156, 1)
    const prefix = tarString(buf, offset + 345, 155)
    const base = tarString(buf, offset, 100)
    const body = offset + 512
    const data = buf.subarray(body, body + size)
    offset = body + Math.ceil(size / 512) * 512
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'L') {
      longName = tarString(data, 0, data.length)
      continue
    }
    if (type === 'g') continue
    const name = (longName ?? (prefix === '' ? base : `${prefix}/${base}`)).replace(/\\/g, '/')
    longName = undefined
    if (type !== '0' && type !== '') continue
    const parts = name.split('/').filter((p) => p !== '' && p !== '.')
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..'))
      throw new Error(`包里有越界路径，拒绝解开：${name}`)
    out.push({ name: parts.join('/'), data, mode })
  }
  return out
}

/** npm 包的 tgz → 去掉开头 `package/` 之后的文件表（`rel` 用 `/` 分隔）。 */
export function npmPackageFiles(tgz) {
  return tarEntries(gunzipSync(tgz))
    .filter((e) => e.name.startsWith('package/'))
    .map((e) => ({ rel: e.name.slice('package/'.length), data: e.data, mode: e.mode }))
    .filter((e) => e.rel !== '')
}

/**
 * 把 npm 摆进 `vendor/node/<target>/<npmRelDir>`，并核对一遍：`bin/npm-cli.js` 在、
 * `package.json` 的版本与锁里一致。回落盘的根目录。
 */
export function installNpmFiles(files, root, version) {
  for (const f of files) writeFile(join(root, ...f.rel.split('/')), f.data, (f.mode & 0o111) !== 0)
  const meta = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (meta.version !== version) throw new Error(`npm 包的版本是 ${meta.version}，锁里是 ${version}`)
  readFileSync(join(root, 'bin', 'npm-cli.js'))
  return root
}

// ── 下载 ────────────────────────────────────────────────────────────────

async function download(url) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${url}`)
  return Buffer.from(await res.arrayBuffer())
}

function writeFile(path, data, executable = false) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  if (executable) chmodSync(path, 0o755)
}

export function readLock(path = LOCK_FILE) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * 校验：期望值缺席 = 失败。
 *
 * 「锁里没这一条就放过」等于没有锁——第一次跑 `--write-lock` 之外的任何一次，
 * 都必须有一个已经签进仓库的期望值可对。
 */
export function checkSha(what, expected, actual) {
  if (expected === undefined)
    throw new Error(`${what}：锁里没有这一项的 sha256。升版本请先跑 --write-lock 并把 diff 提交`)
  if (expected !== actual)
    throw new Error(`${what} 的 sha256 对不上\n  锁里：${expected}\n  实际：${actual}`)
}

async function fetchNodeRuntime(lock, target, { writeLock, shasums }) {
  const { version } = lock.node
  const spec = nodeDownloadUrl(version, target)
  const bytes = await download(spec.url)
  const actual = sha256(bytes)
  if (writeLock) {
    const official = shasums[spec.shasumKey]
    if (official !== undefined && official !== actual)
      throw new Error(`${spec.url} 与官方 SHASUMS256.txt 对不上`)
    lock.node.targets[target] = { sha256: actual }
  } else {
    checkSha(spec.url, lock.node.targets[target]?.sha256, actual)
  }
  const out = join(VENDOR_DIR, 'node', target, nodeExecRelPath(target))
  if (spec.kind === 'exe') {
    writeFile(out, bytes, true)
  } else {
    const found = tarExtract(gunzipSync(bytes), (name) => name === spec.member)
    if (found === undefined) throw new Error(`包里没有 ${spec.member}`)
    writeFile(out, found.data, true)
  }
  return out
}

/**
 * 取 npm 的 tgz（一次，四个平台共用）。`--write-lock` 时先问 nodejs.org 这版 Node 配的是哪版 npm、
 * 再问 registry 它的 integrity，下回来与 registry 对上了才写进锁；平时只认锁里那一份。
 */
async function fetchNpmTarball(lock, { writeLock }) {
  if (writeLock) {
    const index = JSON.parse(
      (await download('https://nodejs.org/dist/index.json')).toString('utf8'),
    )
    const row = index.find((r) => r.version === `v${lock.node.version}`)
    if (typeof row?.npm !== 'string')
      throw new Error(`nodejs.org 的版本表里查不到 Node ${lock.node.version} 配的 npm`)
    const meta = JSON.parse(
      (await download(`https://registry.npmjs.org/npm/${row.npm}`)).toString('utf8'),
    )
    lock.npm = {
      ...lock.npm,
      version: row.npm,
      integrity: meta.dist.integrity,
      tarball: meta.dist.tarball,
      ...(typeof meta.dist.unpackedSize === 'number'
        ? { unpacked_bytes: meta.dist.unpackedSize }
        : {}),
      ...(typeof meta.dist.fileCount === 'number' ? { files: meta.dist.fileCount } : {}),
    }
  }
  const version = lock.npm?.version
  if (typeof version !== 'string')
    throw new Error('锁里没有 npm 的版本。升版本请先跑 --write-lock 并把 diff 提交')
  const url = lock.npm.tarball ?? npmTarballUrl(version)
  const bytes = await download(url)
  checkIntegrity(url, lock.npm.integrity, sha512Integrity(bytes))
  if (writeLock) lock.npm.tarball_bytes = bytes.length
  return { version, files: npmPackageFiles(bytes) }
}

async function fetchNatives(lock, target, { writeLock }) {
  const abi = lock.node.abi
  const out = []
  for (const pkg of lock.natives) {
    for (const version of pkg.versions) {
      const url = prebuildUrl(pkg, version, abi, target)
      const bytes = await download(url)
      const actual = sha256(bytes)
      const key = `${version}/${target}`
      if (writeLock) {
        pkg.sha256 = { ...pkg.sha256, [key]: actual }
      } else {
        checkSha(url, pkg.sha256?.[key], actual)
      }
      const found = tarExtract(gunzipSync(bytes), (name) => name.endsWith('.node'))
      if (found === undefined) throw new Error(`prebuild 里没有 .node：${url}`)
      const dest = join(VENDOR_DIR, 'natives', target, pkg.name, version, found.name)
      writeFile(dest, found.data)
      out.push(dest)
    }
  }
  return out
}

export function parseArgs(argv) {
  const targets = []
  let all = false
  let writeLock = false
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--all') all = true
    else if (arg === '--write-lock') writeLock = true
    else if (arg === '--target') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error('--target 后面要跟平台，例如 darwin-arm64')
      targets.push(next)
      i += 1
    } else throw new Error(`不认识的参数：${arg}`)
  }
  return { targets, all, writeLock }
}

export async function main(argv = process.argv.slice(2)) {
  const { targets, all, writeLock } = parseArgs(argv)
  const lock = readLock()
  const wanted = all
    ? Object.keys(lock.node.targets)
    : targets.length > 0
      ? targets
      : [`${process.platform}-${process.arch}`]

  const shasums = writeLock
    ? parseShasums(
        (await download(`https://nodejs.org/dist/v${lock.node.version}/SHASUMS256.txt`)).toString(
          'utf8',
        ),
      )
    : {}

  for (const target of wanted)
    if (NODE_DIST_NAME[target] === undefined) throw new Error(`不支持的平台：${target}`)
  // WP254：npm 只下一次（与平台无关），每个平台摆一份
  const npm = await fetchNpmTarball(lock, { writeLock })

  for (const target of wanted) {
    rmSync(join(VENDOR_DIR, 'node', target), { recursive: true, force: true })
    rmSync(join(VENDOR_DIR, 'natives', target), { recursive: true, force: true })
    const exec = await fetchNodeRuntime(lock, target, { writeLock, shasums })
    const npmDir = installNpmFiles(
      npm.files,
      join(VENDOR_DIR, 'node', target, npmRelDir(target)),
      npm.version,
    )
    const natives = await fetchNatives(lock, target, { writeLock })
    process.stdout.write(
      `${target}：node → ${exec}，npm ${npm.version} → ${npmDir}，原生模块 ${natives.length} 个\n`,
    )
  }

  if (writeLock) {
    writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`)
    process.stdout.write(`锁已重算：${LOCK_FILE}（把 diff 一起提交）\n`)
  }
}

// 被 import（测试）时什么都不做。
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  await main()
}
