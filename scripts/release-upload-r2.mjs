#!/usr/bin/env node
/**
 * WP292：把一次发版的整套产物从本机传到 R2（dl.agentsws.com），不要 R2 令牌。
 *
 * CI（release.yml）只打包、收拢、建 GitHub Release，并把收拢后的整套产物留成 artifact `release-bundle`；
 * R2 这一步交给本机：用已经 `wrangler login` 过的 OAuth 身份上传，密钥不经任何人 / AI 之手。
 *
 *   node scripts/release-upload-r2.mjs --run <run_id>            # 取那次运行的 release-bundle，只打印计划
 *       （只看计划时也认 dry-run 那次的 release-dry-run，好在第一次真发版前演练；真传只认 release-bundle）
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
 *
 * 内容包（`--content`，release.yml 的 `content` 作业同样没填 R2 secrets 时交给本机）：
 *   node scripts/release-upload-r2.mjs --content --run <run_id> [--upload]   # 取那次运行的 content-pack
 *   node scripts/release-upload-r2.mjs --content --dir <out/content 或 r2/<渠道>> [--upload]
 *   先 `node scripts/content-pack.mjs verify --dir … --builtin`（应用里内置的公钥）验，验不过一个都不传；
 *   顺序：content/<渠道>/blobs/*（一年 immutable）→ content-manifest.json.sig → content-manifest.json（no-cache）；
 *   传完取回清单与签名，序号、签名都对才算完。要先 `pnpm exec tsc -b packages/skills`（验签在 dist 里）。
 *
 * 测试替身：AGENTSWS_WRANGLER（wrangler 可执行文件）、AGENTSWS_CONTENT_PACK（验签脚本）；gh / curl 走 PATH。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
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
export const DRY_BUNDLE = 'release-dry-run'
/** release.yml `content` 作业留下的内容包 artifact（`r2/<渠道>/…`、`github/…`、`release-meta.json`）。 */
export const CONTENT_BUNDLE = 'content-pack'
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
  const out = { dryRun: true, base: BASE, keep: false, content: false }
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
    else if (a === '--content') out.content = true
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

/**
 * 读内容包：CI 的 content-pack artifact（`r2/<渠道>/content-manifest.json(.sig)` + `blobs/`），
 * 或直接给 `r2/<渠道>` 那一层。渠道以清单里写的为准，与目录名、--channel 对不上就拒。
 */
export function readContentBundle(dir, wantChannel) {
  const root = resolve(dir)
  if (!existsSync(root)) throw new Error(`目录不存在：${root}`)
  const r2 = join(root, 'r2')
  let chDir = root
  if (existsSync(r2)) {
    const chans = readdirSync(r2).filter((d) => statSync(join(r2, d)).isDirectory())
    const pick = wantChannel ?? (chans.length === 1 ? chans[0] : undefined)
    if (pick === undefined || !chans.includes(pick))
      throw new Error(`${r2} 里的渠道是 ${chans.join(' / ') || '（空）'}，用 --channel 指一个`)
    chDir = join(r2, pick)
  }
  const manifestPath = join(chDir, 'content-manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`${chDir} 里没有 content-manifest.json`)
  if (!existsSync(`${manifestPath}.sig`))
    throw new Error(`${chDir} 里没有 content-manifest.json.sig`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const { channel, serial } = manifest
  const problems = []
  if (channel !== 'beta' && channel !== 'stable') problems.push(`清单里的渠道是 ${channel}`)
  if (chDir !== root && basename(chDir) !== channel)
    problems.push(`目录 r2/${basename(chDir)} 里的清单写的是 ${channel} 渠道`)
  if (wantChannel !== undefined && wantChannel !== channel)
    problems.push(`内容包是 ${channel} 渠道，--channel ${wantChannel} 对不上`)
  if (problems.length > 0) throw new Error(`内容包不对，不传：\n  ${problems.join('\n  ')}`)
  const blobsDir = join(chDir, 'blobs')
  const blobs = existsSync(blobsDir)
    ? readdirSync(blobsDir).filter((n) => statSync(join(blobsDir, n)).isFile())
    : []
  const metaPath = join(root, 'release-meta.json')
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : undefined
  return { chDir, channel, serial, blobs, meta }
}

/** 与 release.yml `content` 作业原来的 R2 一步同序：先文件（一年 immutable）、再签名、最后清单（no-cache）。 */
export function planContentUploads({ chDir, channel, blobs }) {
  const plan = [...blobs].sort().map((b) => ({
    file: join(chDir, 'blobs', b),
    key: `content/${channel}/blobs/${b}`,
    contentType: 'application/octet-stream',
    cacheControl: LONG,
  }))
  const name = 'content-manifest.json'
  plan.push({
    file: join(chDir, `${name}.sig`),
    key: `content/${channel}/${name}.sig`,
    contentType: 'text/plain',
    cacheControl: SHORT,
  })
  plan.push({
    file: join(chDir, name),
    key: `content/${channel}/${name}`,
    contentType: 'application/json',
    cacheControl: SHORT,
  })
  return plan
}

/** 传完取回清单与签名：序号对、签名与本地那份一字不差才算完。 */
export function verifyContentRemote({ base, chDir, channel, serial, exec, now }) {
  const problems = []
  const get = (path) => {
    const url = `${base.replace(/\/+$/, '')}/content/${channel}/${path}?v=${now()}`
    const r = exec('curl', ['-fsSL', '--max-time', '30', url], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (r.status !== 0) problems.push(`取不到 ${url}（curl 退出码 ${r.status}）`)
    return r.status === 0 ? String(r.stdout ?? '') : undefined
  }
  const text = get('content-manifest.json')
  if (text !== undefined) {
    let got
    try {
      got = JSON.parse(text).serial
    } catch {
      got = '（不是 JSON）'
    }
    if (got !== serial) problems.push(`远端清单的序号是 ${got}，不是 ${serial}`)
  }
  const sig = get('content-manifest.json.sig')
  const local = readFileSync(join(chDir, 'content-manifest.json.sig'), 'utf8')
  if (sig !== undefined && sig.trim() !== local.trim()) problems.push('远端签名与本地这份不一样')
  return problems
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

/** 取那次运行的 artifact：按顺序试 `names`，第一个取得到的为准。 */
function download(opts, names, { exec, env, log }) {
  const tmp = mkdtempSync(join(tmpdir(), 'agentsws-release-'))
  const got = names.find((name) => {
    const args = ['run', 'download', opts.run, '-n', name, '-D', tmp]
    if (opts.repo !== undefined) args.push('-R', opts.repo)
    log(`取运行 ${opts.run} 的 ${name} → ${tmp}`)
    return exec('gh', args, { cwd: REPO_ROOT, env, stdio: 'inherit' }).status === 0
  })
  if (got === undefined) {
    if (!opts.keep) rmSync(tmp, { recursive: true, force: true })
    throw new Error(
      `gh run download 没成：那次运行没有 ${names.join(' / ')}（没跑到那一步？dry-run 的产物只能看计划、不传）`,
    )
  }
  return tmp
}

/** 安装包那一套：计划 + 传完怎么核。 */
function prepareInstallers(dir, opts, { exec, now, log }) {
  const bundle = readBundle(dir)
  const rel = resolveRelease(bundle, opts.channel)
  const notes = []
  let refuse
  if (bundle.meta?.dry_run === true) {
    refuse = '这是 dry-run 那次运行的产物（打的是分支，不是 tag），不传'
    notes.push('（这是 dry-run 那次运行的产物：只能看计划，不能传）')
  }
  const plan = planUploads({ ...bundle, channel: rel.channel, siteChannel: rel.siteChannel })
  const rootDownloads = plan.some((p) => p.key === 'downloads.json')
  if (!rootDownloads)
    notes.push(`  （根目录 downloads.json 不动：${rel.channel} 不是官网渠道 ${rel.siteChannel}）`)
  log(`${rel.tag ?? `v${rel.version}`}（${opts.base}/${rel.channel}/）`)
  const args = { base: opts.base, channel: rel.channel, version: rel.version, rootDownloads }
  return {
    info: rel,
    plan,
    bucket: rel.bucket,
    notes,
    refuse,
    verify: () => verifyRemote({ ...args, exec, now }),
    done: `✓ ${opts.base}/${rel.channel}/latest.yml 已是 ${rel.version}`,
  }
}

/** 内容包那一套：先用应用里内置的公钥验，验不过一个都不传。 */
function prepareContent(dir, opts, { exec, now, env, log }) {
  const bundle = readContentBundle(dir, opts.channel)
  const notes = []
  let refuse
  if (bundle.meta?.upload === false) {
    refuse = '那次运行只打包自检（没打算发内容包），不传'
    notes.push('（那次运行只打包自检：只能看计划，不能传）')
  }
  const script = env.AGENTSWS_CONTENT_PACK || join(REPO_ROOT, 'scripts', 'content-pack.mjs')
  log(`用应用里内置的公钥验 ${bundle.chDir}`)
  const v = exec(process.execPath, [script, 'verify', '--dir', bundle.chDir, '--builtin'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  })
  if (v.status !== 0)
    throw new Error(
      '内置公钥验不过，一个都没传（签名对不上应用，或者还没 `pnpm exec tsc -b packages/skills`）',
    )
  const plan = planContentUploads(bundle)
  log(`内容包 ${bundle.channel} 序号 ${bundle.serial}（${opts.base}/content/${bundle.channel}/）`)
  const args = { base: opts.base, ...bundle }
  return {
    info: bundle,
    plan,
    bucket: bundle.meta?.bucket || BUCKET,
    notes,
    refuse,
    verify: () => verifyContentRemote({ ...args, exec, now }),
    done: `✓ ${opts.base}/content/${bundle.channel}/content-manifest.json 已是序号 ${bundle.serial}`,
  }
}

export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env
  const log = deps.log ?? ((s) => process.stdout.write(`${s}\n`))
  const exec = deps.exec ?? defaultExec
  const now = deps.now ?? Date.now
  const opts = parseArgs(argv)
  let dir = opts.dir
  let tmp
  if (opts.run !== undefined) {
    // 只看计划时也认 dry-run 那次的产物（release-dry-run），方便第一次真发版前演练；真传只认 release-bundle
    const names = opts.content ? [CONTENT_BUNDLE] : opts.dryRun ? [BUNDLE, DRY_BUNDLE] : [BUNDLE]
    tmp = download(opts, names, { exec, env, log })
    dir = tmp
  }
  try {
    const ctx = { exec, now, env, log }
    const job = opts.content ? prepareContent(dir, opts, ctx) : prepareInstallers(dir, opts, ctx)
    const { plan, notes } = job
    const bucket = opts.bucket ?? job.bucket
    log(`→ ${bucket}，${plan.length} 个对象：`)
    const tooBig = []
    for (const [i, p] of plan.entries()) {
      const size = statSync(p.file).size
      if (size > MAX_BYTES) tooBig.push(`${p.key}（${mb(size)}）`)
      log(
        `  ${String(i + 1).padStart(2)}. ${p.key}  ${mb(size)}  ${p.contentType}  ${p.cacheControl}`,
      )
    }
    for (const n of notes) log(n)
    if (tooBig.length > 0)
      throw new Error(
        `超过 wrangler 单个对象上限 ${mb(MAX_BYTES)}，一个都没传：${tooBig.join('、')}`,
      )
    if (opts.dryRun) {
      log('只是计划，一个字节都没传。确认无误后加 --upload 真传。')
      return { ...job.info, plan, uploaded: false }
    }
    if (job.refuse !== undefined) throw new Error(job.refuse)
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
          `传 ${p.key} 没成，停在这里（排在它后面的没动；清单 / latest*.yml 最后才传，客户端不会看到半截版本）`,
        )
    }
    const problems = job.verify()
    if (problems.length > 0) throw new Error(`传完了，但校验没过：\n  ${problems.join('\n  ')}`)
    log(job.done)
    return { ...job.info, plan, uploaded: true }
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
