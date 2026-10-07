/**
 * WP245：给「一键安装平台 CLI」找一份 **npm**——用户机器上多半没有 Node，更没有 npm。
 *
 * WP254（决策 99）起安装包里**随 node 一起带了配套的 npm**（`apps/desktop/scripts/fetch-node.mjs` 按官方
 * 发行包布局摆好，版本与 sha512 钉在 `apps/desktop/node-runtime.lock.json`），所以按这个顺序找：
 *
 * 1. 捆绑 node 旁边自带的 npm（官方发行包的布局：`<dir>/../lib/node_modules/npm`，Windows 是
 *    `<dir>/node_modules/npm`）——装好的桌面版与开发机都走这一条，**不联网**；
 * 2. 之前下载过的那一份：`<tools>/npm/<版本>/package/bin/npm-cli.js`（WP254 之前装的、或服务进程跑在
 *    Electron 自带 Node 上那一档）；
 * 3. 都没有：从 npm 官方源下**钉死的那一版**（{@link NPM_RUNTIME}），**校验 sha512**（与 registry 上
 *    `dist.integrity` 逐字相同）后解到上面那个目录。校验不过就不解、不留文件。
 *
 * 之后一律用「我们自己的 node + npm-cli.js」起 npm（`node npm-cli.js …`），不经 `npm.cmd` 壳、
 * 不看系统 PATH 上有没有 npm、不要管理员。解包用纯 JS（gzip 走 `node:zlib`），不依赖系统 `tar`
 * ——Windows 上中文用户名路径与 Git 带的 GNU tar 都不是问题。
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, sep } from 'node:path'
import { gunzipSync } from 'node:zlib'

/**
 * 钉死的 npm（升级走 docs/42：改这里的版本与 integrity，两样都从 registry 的 `dist` 逐字抄）。
 * 10.9.x 与捆绑的 Node 22 同一代；`engines.node` 是 `^18.17.0 || >=20.5.0`。
 */
export const NPM_RUNTIME = {
  version: '10.9.9',
  integrity:
    'sha512-1g+6jLQvaIuB4zwvHL7yrXuXcWZwDsCtBX8bbWDqbvJSSr9nPiDDWTHNgwXR27iIcTTW7v3A57hDW9RYv2W4Yg==',
} as const

export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org'

export class NpmRuntimeError extends Error {
  constructor(
    readonly code: 'network' | 'integrity' | 'bad_archive' | 'disk',
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options)
    this.name = 'NpmRuntimeError'
  }
}

/** 捆绑 node 旁边自带 npm 的那两处（官方发行包布局）。 */
export function bundledNpmCandidates(
  nodeExec: string,
  platform: string = process.platform,
): string[] {
  const dir = dirname(nodeExec)
  const win = join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')
  const unix = join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  return platform === 'win32' ? [win, unix] : [unix, win]
}

/** 下载过的那一份在哪。 */
export function cachedNpmCli(toolsDir: string, version: string = NPM_RUNTIME.version): string {
  return join(toolsDir, 'npm', version, 'package', 'bin', 'npm-cli.js')
}

/** `sha512-<base64>` 校验。 */
export function integrityOk(bytes: Uint8Array, integrity: string): boolean {
  const m = /^sha512-(.+)$/.exec(integrity.trim())
  if (m === null) return false
  return createHash('sha512').update(bytes).digest('base64') === m[1]
}

// ── 极简 tar 解包（npm 包的 tgz：ustar + 偶尔的 pax / GNU 长名） ────────────

function cString(buf: Uint8Array, start: number, len: number): string {
  const slice = buf.subarray(start, start + len)
  const end = slice.indexOf(0)
  return Buffer.from(end < 0 ? slice : slice.subarray(0, end)).toString('utf8')
}

function octal(buf: Uint8Array, start: number, len: number): number {
  const text = cString(buf, start, len).trim()
  return text === '' ? 0 : Number.parseInt(text, 8)
}

function paxPath(data: Uint8Array): string | undefined {
  const text = Buffer.from(data).toString('utf8')
  for (const line of text.split('\n')) {
    const m = /^\d+ path=(.*)$/.exec(line)
    if (m?.[1] !== undefined) return m[1]
  }
  return undefined
}

/** 一条 tar 里的路径能不能落盘：不许绝对路径、不许 `..`（防目录穿越）。 */
export function safeEntryPath(name: string): string | undefined {
  const clean = name.replace(/\\/g, '/').replace(/^\.\//, '')
  if (clean === '' || isAbsolute(clean) || /^[A-Za-z]:/.test(clean)) return undefined
  const parts = clean.split('/').filter((p) => p !== '' && p !== '.')
  if (parts.some((p) => p === '..')) return undefined
  return parts.join('/')
}

/** 把一份 `.tgz` 解到 `dest`（只认普通文件与目录；链接之类跳过）。返回写了几个文件。 */
export function extractTgz(tgz: Uint8Array, dest: string): number {
  let tar: Buffer
  try {
    tar = gunzipSync(tgz)
  } catch (err) {
    throw new NpmRuntimeError('bad_archive', '下载的 npm 包解不开', { cause: err })
  }
  let offset = 0
  let files = 0
  let longName: string | undefined
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const size = octal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 0)
    const prefix = cString(header, 345, 155)
    const base = cString(header, 0, 100)
    const dataStart = offset + 512
    const data = tar.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    if (type === 'L') {
      longName = cString(data, 0, data.length)
      continue
    }
    if (type === 'g') continue
    const name = longName ?? (prefix === '' ? base : `${prefix}/${base}`)
    longName = undefined
    const rel = safeEntryPath(name)
    if (rel === undefined) continue
    const target = normalize(join(dest, ...rel.split('/')))
    if (!target.startsWith(normalize(dest) + sep) && target !== normalize(dest)) continue
    if (type === '5') {
      mkdirSync(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\0') continue
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, data)
    files += 1
  }
  return files
}

// ── 找 / 下 npm ─────────────────────────────────────────────────────────

export interface EnsureNpmOptions {
  /** 跑 npm 的 node（服务进程自己的 `process.execPath`）。 */
  nodeExec: string
  /** 应用自己的工具目录（`<data>/tools`）。 */
  toolsDir: string
  /** 下载源（`npm_config_registry` 有就用它，镜像也行——sha512 照样要对上）。 */
  registry?: string
  fetchImpl?: typeof fetch
  exists?: (path: string) => boolean
  platform?: string
  /** 下载超时（毫秒），默认 2 分钟。 */
  timeoutMs?: number
  /** 钉哪一版（测试换成自己造的包；不给 = {@link NPM_RUNTIME}）。 */
  pin?: { version: string; integrity: string }
  /** 进度：开始下载 npm 时叫一声（界面上的「下载中」）。 */
  onDownload?: () => void
}

/** npm 的 tarball 地址：`<registry>/npm/-/npm-<版本>.tgz`。 */
export function npmTarballUrl(registry: string, version: string = NPM_RUNTIME.version): string {
  return `${registry.replace(/\/+$/, '')}/npm/-/npm-${version}.tgz`
}

/**
 * 找一份能用的 `npm-cli.js`；没有就下钉死的那一版并校验。**校验不过不留任何文件。**
 * 网络错误原样带 `cause`（调用方用 WP242 的 `netCauseOf` 挖出 `ENOTFOUND` 之类说人话）。
 */
export async function ensureNpmCli(options: EnsureNpmOptions): Promise<string> {
  const exists = options.exists ?? existsSync
  for (const candidate of bundledNpmCandidates(options.nodeExec, options.platform)) {
    if (exists(candidate)) return candidate
  }
  const pin = options.pin ?? NPM_RUNTIME
  const cached = cachedNpmCli(options.toolsDir, pin.version)
  if (exists(cached)) return cached
  options.onDownload?.()
  const doFetch = options.fetchImpl ?? fetch
  const url = npmTarballUrl(options.registry ?? DEFAULT_NPM_REGISTRY, pin.version)
  let bytes: Uint8Array
  try {
    const res = await doFetch(url, { signal: AbortSignal.timeout(options.timeoutMs ?? 120_000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    throw new NpmRuntimeError('network', `下载 npm 失败：${url}`, { cause: err })
  }
  if (!integrityOk(bytes, pin.integrity))
    throw new NpmRuntimeError('integrity', '下载的 npm 校验不对（sha512 不一致），没有安装')
  const finalDir = dirname(dirname(dirname(cached)))
  const staging = `${finalDir}.part-${process.pid}-${Date.now().toString(36)}`
  try {
    mkdirSync(staging, { recursive: true })
    extractTgz(bytes, staging)
    if (!existsSync(join(staging, 'package', 'bin', 'npm-cli.js')))
      throw new NpmRuntimeError('bad_archive', '下载的 npm 包里没有 npm-cli.js')
    mkdirSync(dirname(finalDir), { recursive: true })
    if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true })
    renameSync(staging, finalDir)
  } catch (err) {
    rmSync(staging, { recursive: true, force: true })
    if (err instanceof NpmRuntimeError) throw err
    throw new NpmRuntimeError('disk', `npm 解不到 ${finalDir}`, { cause: err })
  }
  return cached
}
