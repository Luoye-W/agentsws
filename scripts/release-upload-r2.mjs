#!/usr/bin/env node
/**
 * WP292：把一次发版的整套产物从本机传到 R2（dl.agentsws.com），不要 R2 令牌。
 *
 * CI（release.yml）只打包、收拢、建 GitHub Release，并把收拢后的整套产物留成 artifact `release-bundle`；
 * R2 这一步交给本机：用已经 `wrangler login` 过的 OAuth 身份上传，密钥不经任何人 / AI 之手。
 *
 *   node scripts/release-upload-r2.mjs --run <run_id>            # 取那次运行的 release-bundle，只打印计划
 *   node scripts/release-upload-r2.mjs --run <run_id> --upload   # 真传
 *   node scripts/release-upload-r2.mjs --dir <本地目录> [--upload]
 *       [--channel beta|stable]   只作核对：与版本号推出来的渠道不一致就拒
 *       [--dry-run]               只打印计划（默认就是；与 --upload 同时给按 dry-run）
 *       [--bucket <桶>]           默认取 release-meta.json 里 CI 记下的桶（仓库变量 R2_BUCKET），再没有就 agentsws-downloads
 *       [--base https://dl.agentsws.com] [--repo owner/name] [--keep]
 *
 * 目录结构与顺序与 release.yml 原来的 R2 两步一致：
 *   <渠道>/*.exe → *.dmg → *.blockmap → *.zip（一年 immutable）
 *   → <渠道>/latest-mac.yml → <渠道>/latest.yml → <渠道>/downloads.json（no-cache）
 *   → 根目录 downloads.json（no-cache；stable，或渠道 = 官网渠道 SITE_DOWNLOAD_CHANNEL，默认 beta）
 * 客户端看到新的 latest*.yml 时，它指的文件一定已经在了。
 *
 * wrangler 一律 `CI=true WRANGLER_SEND_METRICS=false`、去掉 CLOUDFLARE_API_TOKEN 跑（只走 OAuth）。
 * 传完用 curl 取 <base>/<渠道>/latest.yml 与 latest-mac.yml，版本对才算完。
 * 测试替身：AGENTSWS_WRANGLER（wrangler 可执行文件）；gh / curl 走 PATH。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  checkArtifacts,
  parseTag,
  parseUpdateInfo,
} from '../apps/desktop/scripts/release-manifest.mjs'

export const REPO_ROOT = resolve(import.meta.dirname, '..')
export const BUCKET = 'agentsws-downloads'
export const BASE = 'https://dl.agentsws.com'
export const BUNDLE = 'release-bundle'
/** wrangler r2 object put 单个对象的上限（wrangler 4.x：300 MiB）。超了就别开始传。 */
export const MAX_BYTES = 300 * 1024 * 1024
export const LONG = 'public, max-age=31536000, immutable'
export const SHORT = 'no-cache, max-age=0'

/** 安装包按这个顺序传（与 release.yml 原来的 for 循环同序）。 */
const PACKAGES = [
  ['.exe', 'application/vnd.microsoft.portable-executable'],
  ['.dmg', 'application/x-apple-diskimage'],
  ['.blockmap', 'application/octet-stream'],
  ['.zip', 'application/zip'],
]

export function parseArgs(argv) {
  const out = { dryRun: true, base: BASE, keep: false }
  const takes = { '--run': 'run', '--dir': 'dir', '--channel': 'channel', '--bucket': 'bucket' }
  Object.assign(takes, { '--base': 'base', '--repo': 'repo' })
  let upload = false
  let dry = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a in takes) {
      const v = argv[++i]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 后面要跟一个值`)
      out[takes[a]] = v
    } else if (a === '--upload') upload = true
    else if (a === '--dry-run') dry = true
    else if (a === '--keep') out.keep = true
    else throw new Error(`不认识的参数：${a}`)
  }
  if ((out.run === undefined) === (out.dir === undefined))
    throw new Error('--run <run_id> 与 --dir <目录> 二选一')
  if (out.run !== undefined && !/^\d+$/.test(out.run))
    throw new Error(`run id 是一串数字：${out.run}`)
  if (out.channel !== undefined && !['beta', 'stable'].includes(out.channel))
    throw new Error(`--channel 只认 beta / stable：${out.channel}`)
  out.dryRun = dry || !upload
  return out
}

/** 读一套产物：CI 的 release-bundle（`artifacts/` + `downloads.json` + `release-meta.json`），或全摊在一个目录里。 */
export function readBundle(dir) {
  const root = resolve(dir)
  if (!existsSync(root)) throw new Error(`目录不存在：${root}`)
  const nested = join(root, 'artifacts')
  const filesDir = existsSync(nested) && statSync(nested).isDirectory() ? nested : root
  const downloads = [join(root, 'downloads.json'), join(filesDir, 'downloads.json')].find((p) =>
    existsSync(p),
  )
  if (downloads === undefined) throw new Error(`${root} 里没有 downloads.json`)
  const metaPath = join(root, 'release-meta.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined
  const names = readdirSync(filesDir).filter((n) => statSync(join(filesDir, n)).isFile())
  return { filesDir, downloads, meta, names }
}

/** 版本与渠道：以 latest.yml 为准，再与 downloads.json / release-meta.json / --channel 逐一对上，对不上就拒。 */
export function resolveRelease(bundle, wantChannel) {
  const { filesDir, names, meta } = bundle
  if (meta?.dry_run === true)
    throw new Error('这是 dry-run 那次运行的产物（打的是分支，不是 tag），不传')
  if (!names.includes('latest.yml')) throw new Error('缺 latest.yml')
  const read = (n) => readFileSync(join(filesDir, n), 'utf8')
  const { version } = parseUpdateInfo(read('latest.yml'))
  const { channel } = parseTag(`v${version}`)
  const problems = checkArtifacts(names, version, read)
  const dl = JSON.parse(readFileSync(bundle.downloads, 'utf8'))
  if (dl.version !== version)
    problems.push(`downloads.json 的版本是 ${dl.version}，不是 ${version}`)
  if (dl.channel !== channel)
    problems.push(`downloads.json 的渠道是 ${dl.channel}，不是 ${channel}`)
  if (meta !== undefined && meta.version !== version)
    problems.push(`release-meta.json 的版本是 ${meta.version}，不是 ${version}`)
  if (wantChannel !== undefined && wantChannel !== channel)
    problems.push(`版本 ${version} 属于 ${channel} 渠道，--channel ${wantChannel} 对不上`)
  if (problems.length > 0) throw new Error(`产物不对，不传：\n  ${problems.join('\n  ')}`)
  return {
    version,
    channel,
    siteChannel: meta?.site_channel || 'beta',
    tag: meta?.tag,
    bucket: meta?.bucket || BUCKET,
  }
}

/** 上传计划（有序）：安装包 / blockmap → latest*.yml → 渠道 downloads.json → 根目录 downloads.json。 */
export function planUploads({ filesDir, names, downloads, channel, siteChannel = 'beta' }) {
  const plan = []
  const sorted = [...names].sort()
  for (const [ext, contentType] of PACKAGES)
    for (const n of sorted)
      if (n.endsWith(ext))
        plan.push({
          file: join(filesDir, n),
          key: `${channel}/${n}`,
          contentType,
          cacheControl: LONG,
        })
  const short = (file, key, contentType) => ({ file, key, contentType, cacheControl: SHORT })
  plan.push(short(join(filesDir, 'latest-mac.yml'), `${channel}/latest-mac.yml`, 'text/yaml'))
  plan.push(short(join(filesDir, 'latest.yml'), `${channel}/latest.yml`, 'text/yaml'))
  plan.push(short(downloads, `${channel}/downloads.json`, 'application/json'))
  if (channel === 'stable' || channel === siteChannel)
    plan.push(short(downloads, 'downloads.json', 'application/json'))
  return plan
}

export function wranglerArgs(bucket, item) {
  return [
    'r2',
    'object',
    'put',
    `${bucket}/${item.key}`,
    '--file',
    item.file,
    '--cache-control',
    item.cacheControl,
    '--content-type',
    item.contentType,
    '--remote',
  ]
}

/** 等同 `CI=true WRANGLER_SEND_METRICS=false env -u CLOUDFLARE_API_TOKEN`：只走 wrangler login 的 OAuth。 */
export function wranglerEnv(env) {
  const out = { ...env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
  delete out.CLOUDFLARE_API_TOKEN
  delete out.CF_API_TOKEN
  return out
}

export function resolveWrangler(env) {
  if (env.AGENTSWS_WRANGLER) return env.AGENTSWS_WRANGLER
  const local = join(REPO_ROOT, 'apps', 'cloud-worker', 'node_modules', '.bin', 'wrangler')
  if (existsSync(local)) return local
  throw new Error('找不到 wrangler：先在仓库根 pnpm install（用 apps/cloud-worker 里那份）')
}

function defaultExec(cmd, args, opts) {
  return spawnSync(cmd, args, { ...opts, encoding: 'utf8' })
}

/** 传完取回 latest*.yml（带一个随手的查询串躲缓存），版本对才算完；根目录 downloads.json 传了也核一下。 */
export function verifyRemote({ base, channel, version, rootDownloads, exec, now }) {
  const problems = []
  const get = (path) => {
    const url = `${base.replace(/\/+$/, '')}/${path}?v=${now()}`
    const r = exec('curl', ['-fsSL', '--max-time', '30', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (r.status !== 0) problems.push(`取不到 ${url}（curl 退出码 ${r.status}）`)
    return r.status === 0 ? String(r.stdout ?? '') : undefined
  }
  for (const name of ['latest.yml', 'latest-mac.yml']) {
    const text = get(`${channel}/${name}`)
    if (text === undefined) continue
    const got = parseUpdateInfo(text).version
    if (got !== version) problems.push(`${channel}/${name} 上的版本是 ${got}，不是 ${version}`)
  }
  if (rootDownloads) {
    const text = get('downloads.json')
    if (text !== undefined) {
      let got
      try {
        got = JSON.parse(text).version
      } catch {
        got = '（不是 JSON）'
      }
      if (got !== version) problems.push(`根目录 downloads.json 的版本是 ${got}，不是 ${version}`)
    }
  }
  return problems
}

const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`

export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`))
  const exec = deps.exec ?? defaultExec
  const now = deps.now ?? Date.now
  const opts = parseArgs(argv)
  let dir = opts.dir
  let tmp
  if (opts.run !== undefined) {
    tmp = mkdtempSync(join(tmpdir(), 'agentsws-release-'))
    const args = ['run', 'download', opts.run, '-n', BUNDLE, '-D', tmp]
    if (opts.repo !== undefined) args.push('-R', opts.repo)
    log(`取运行 ${opts.run} 的 ${BUNDLE} → ${tmp}`)
    const r = exec('gh', args, { cwd: REPO_ROOT, env, stdio: 'inherit' })
    if (r.status !== 0) {
      if (!opts.keep) rmSync(tmp, { recursive: true, force: true })
      throw new Error(
        `gh run download 没成：那次运行没有 ${BUNDLE}（dry-run 的叫 release-dry-run，不传；或者没跑到「收拢」）`,
      )
    }
    dir = tmp
  }
  try {
    const bundle = readBundle(dir)
    const rel = resolveRelease(bundle, opts.channel)
    const plan = planUploads({ ...bundle, channel: rel.channel, siteChannel: rel.siteChannel })
    const rootDownloads = plan.some((p) => p.key === 'downloads.json')
    const bucket = opts.bucket ?? rel.bucket
    log(
      `${rel.tag ?? `v${rel.version}`} → ${bucket}（${opts.base}/${rel.channel}/），${plan.length} 个对象：`,
    )
    const tooBig = []
    for (const [i, p] of plan.entries()) {
      const size = statSync(p.file).size
      if (size > MAX_BYTES) tooBig.push(`${p.key}（${mb(size)}）`)
      log(
        `  ${String(i + 1).padStart(2)}. ${p.key}  ${mb(size)}  ${p.contentType}  ${p.cacheControl}`,
      )
    }
    if (!rootDownloads)
      log(`  （根目录 downloads.json 不动：${rel.channel} 不是官网渠道 ${rel.siteChannel}）`)
    if (tooBig.length > 0)
      throw new Error(
        `超过 wrangler 单个对象上限 ${mb(MAX_BYTES)}，一个都没传：${tooBig.join('、')}`,
      )
    if (opts.dryRun) {
      log('只是计划，一个字节都没传。确认无误后加 --upload 真传。')
      return { ...rel, plan, uploaded: false }
    }
    const wrangler = resolveWrangler(env)
    const wenv = wranglerEnv(env)
    for (const p of plan) {
      log(`↑ ${p.key}`)
      const r = exec(wrangler, wranglerArgs(bucket, p), {
        cwd: REPO_ROOT,
        env: wenv,
        stdio: 'inherit',
      })
      if (r.status !== 0)
        throw new Error(
          `传 ${p.key} 没成，停在这里（排在它后面的没动；latest*.yml 最后才传，客户端不会看到半截版本）`,
        )
    }
    const problems = verifyRemote({
      base: opts.base,
      channel: rel.channel,
      version: rel.version,
      rootDownloads,
      exec,
      now,
    })
    if (problems.length > 0) throw new Error(`传完了，但校验没过：\n  ${problems.join('\n  ')}`)
    log(`✓ ${opts.base}/${rel.channel}/latest.yml 已是 ${rel.version}`)
    return { ...rel, plan, uploaded: true }
  } finally {
    if (tmp !== undefined && !opts.keep) rmSync(tmp, { recursive: true, force: true })
  }
}

const self = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self) {
  run(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
