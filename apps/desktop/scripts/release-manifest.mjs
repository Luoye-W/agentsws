#!/usr/bin/env node
/**
 * WP218：发版时把几台机器打出来的东西收拢成「一套」（release.yml 的 publish 那一步用；不联网）。
 *
 *   node release-manifest.mjs merge-mac --out latest-mac.yml a.yml b.yml
 *       两台 mac（arm64 / x64）各打一份 latest-mac.yml，各自只列自己那个架构——合成一份再上传，
 *       不然后传的那份把先传的盖掉，另一种 mac 就查不到更新。
 *
 *   node release-manifest.mjs downloads --version 0.2.0-beta.1 --base https://dl.agentsws.com \
 *       --dir <产物目录> --out downloads.json [--released 2026-10-05]
 *       官网下载页读的清单（apps/site/src/data/downloads.json 同一个形状）：版本、渠道、每个平台的
 *       文件名、网址、sha256、大小。sha256 与大小从产物本身算，不抄。
 *
 *   node release-manifest.mjs check --dir <产物目录> --version 0.2.0-beta.1
 *       产物结构自检：该有的文件都在、latest*.yml 里的版本与文件名对得上（dry-run 也跑这一步）。
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// ── 产物名（与 electron-builder.yml 的 artifactName 同一套）────────────────

export function artifactNames(version) {
  return {
    'mac-arm64': `Agents-Workshop-${version}-arm64.dmg`,
    'mac-x64': `Agents-Workshop-${version}-x64.dmg`,
    'win-x64': `Agents-Workshop-Setup-${version}-x64.exe`,
  }
}

/** tag → 版本与渠道。只认 `v1.2.3`（stable）与 `v1.2.3-beta.4`（beta），别的一律拒。 */
export function parseTag(tag) {
  const m = /^v(\d+\.\d+\.\d+)(-beta\.\d+)?$/.exec(tag)
  if (m === null) throw new Error(`tag 只认 v1.2.3 或 v1.2.3-beta.4：${tag}`)
  return { version: `${m[1]}${m[2] ?? ''}`, channel: m[2] === undefined ? 'stable' : 'beta' }
}

// ── latest*.yml（electron-builder 写出来的那几行，按它的固定形状读写）──────

export function parseUpdateInfo(text) {
  const info = {
    version: undefined,
    files: [],
    path: undefined,
    sha512: undefined,
    releaseDate: undefined,
  }
  let current
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim() === 'files:') continue
    const item = /^\s+-\s+(\w+):\s*(.*)$/.exec(raw)
    const field = /^\s+(\w+):\s*(.*)$/.exec(raw)
    const top = /^(\w+):\s*(.*)$/.exec(raw)
    if (item !== null) {
      current = { [item[1]]: unquote(item[2]) }
      info.files.push(current)
    } else if (field !== null && current !== undefined) {
      current[field[1]] = unquote(field[2])
    } else if (top !== null) {
      current = undefined
      info[top[1]] = unquote(top[2])
    }
  }
  for (const f of info.files) {
    if (f.size !== undefined) f.size = Number(f.size)
    if (f.blockMapSize !== undefined) f.blockMapSize = Number(f.blockMapSize)
  }
  return info
}

function unquote(v) {
  return v.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
}

export function serializeUpdateInfo(info) {
  const lines = [`version: ${info.version}`, 'files:']
  for (const f of info.files) {
    const [first, ...rest] = Object.entries(f)
    lines.push(`  - ${first[0]}: ${first[1]}`)
    for (const [k, v] of rest) lines.push(`    ${k}: ${v}`)
  }
  if (info.path !== undefined) lines.push(`path: ${info.path}`)
  if (info.sha512 !== undefined) lines.push(`sha512: ${info.sha512}`)
  if (info.releaseDate !== undefined) lines.push(`releaseDate: '${info.releaseDate}'`)
  return `${lines.join('\n')}\n`
}

/** 几份 latest-mac.yml 合成一份：文件取并集（按 url 去重），顶层 path / sha512 取第一份，日期取最晚。 */
export function mergeUpdateInfo(texts) {
  const infos = texts.map(parseUpdateInfo)
  if (infos.length === 0) throw new Error('没有可合并的 latest-mac.yml')
  const versions = new Set(infos.map((i) => i.version))
  if (versions.size !== 1)
    throw new Error(`几份 latest-mac.yml 的版本不一致：${[...versions].join(' / ')}`)
  const seen = new Set()
  const files = []
  for (const i of infos)
    for (const f of i.files) {
      if (seen.has(f.url)) continue
      seen.add(f.url)
      files.push(f)
    }
  const dates = infos.map((i) => i.releaseDate).filter((d) => d !== undefined)
  const [first] = infos
  return {
    version: first.version,
    files,
    path: first.path,
    sha512: first.sha512,
    releaseDate: dates.sort().at(-1),
  }
}

// ── downloads.json（官网下载页）────────────────────────────────────────

export function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * 官网清单。`files` = 产物目录里的文件名 → { sha256, size }（调用方从磁盘算好）。
 * 平台缺了的那一项 `url: null`（页面显示「即将提供」），不编一个点了 404 的链接。
 */
export function buildDownloads({ version, channel, base, released, files, extension }) {
  const names = artifactNames(version)
  const dir = `${base.replace(/\/+$/, '')}/${channel}`
  const item = (file) => {
    const f = files[file]
    return f === undefined
      ? { file, url: null, sha256: null, size: null }
      : { file, url: `${dir}/${file}`, sha256: f.sha256, size: f.size }
  }
  const ext = extension === undefined ? undefined : files[extension]
  return {
    $comment: 'WP218：发版流水线生成（release.yml → scripts/release-manifest.mjs），不要手改。',
    version,
    channel,
    released: released ?? null,
    desktop: [
      { id: 'mac-arm64', os: 'mac', arch: 'arm64', ...item(names['mac-arm64']) },
      { id: 'mac-x64', os: 'mac', arch: 'x64', ...item(names['mac-x64']) },
      { id: 'win-x64', os: 'win', arch: 'x64', ...item(names['win-x64']) },
    ],
    extension: {
      id: 'extension',
      version,
      browsers: ['chrome', 'edge'],
      file: extension ?? `agents-workshop-extension-${version}.zip`,
      url: ext === undefined ? null : `${dir}/${extension}`,
      sha256: ext?.sha256 ?? null,
      size: ext?.size ?? null,
    },
  }
}

/**
 * 产物结构自检：返回问题清单（空 = 没毛病）。
 * Windows 那一份是主路径，缺了就是问题；mac 两份缺哪份报哪份。
 */
export function checkArtifacts(names, version, read) {
  const problems = []
  const want = artifactNames(version)
  const has = new Set(names)
  if (!has.has(want['win-x64'])) problems.push(`缺 Windows 安装包 ${want['win-x64']}`)
  if (!has.has(`${want['win-x64']}.blockmap`))
    problems.push('缺 Windows 安装包的 .blockmap（差分更新用）')
  if (!has.has('latest.yml')) problems.push('缺 latest.yml（Windows 应用内更新查的就是它）')
  else {
    const info = parseUpdateInfo(read('latest.yml'))
    if (info.version !== version)
      problems.push(`latest.yml 的版本是 ${info.version}，不是 ${version}`)
    if (!info.files.some((f) => f.url === want['win-x64']))
      problems.push(`latest.yml 里没有 ${want['win-x64']}`)
  }
  for (const id of ['mac-arm64', 'mac-x64'])
    if (!has.has(want[id])) problems.push(`缺 ${id} 的 ${want[id]}`)
  if (has.has('latest-mac.yml')) {
    const info = parseUpdateInfo(read('latest-mac.yml'))
    if (info.version !== version)
      problems.push(`latest-mac.yml 的版本是 ${info.version}，不是 ${version}`)
    for (const id of ['mac-arm64', 'mac-x64'])
      if (has.has(want[id]) && !info.files.some((f) => f.url === want[id]))
        problems.push(`latest-mac.yml 里没有 ${want[id]}（两份没合并？）`)
  } else problems.push('缺 latest-mac.yml')
  return problems
}

// ── 命令行 ──────────────────────────────────────────────────────────────

function opt(args, name) {
  const i = args.indexOf(name)
  return i < 0 ? undefined : args[i + 1]
}

function main(argv) {
  const [cmd, ...args] = argv
  if (cmd === 'merge-mac') {
    const out = opt(args, '--out')
    const inputs = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out')
    writeFileSync(
      out,
      serializeUpdateInfo(mergeUpdateInfo(inputs.map((p) => readFileSync(p, 'utf8')))),
    )
    process.stdout.write(`合并 ${inputs.length} 份 → ${out}\n`)
    return
  }
  if (cmd === 'downloads') {
    const dir = resolve(opt(args, '--dir'))
    const version = opt(args, '--version')
    const { channel } = parseTag(`v${version}`)
    const files = {}
    let extension
    for (const name of readdirSync(dir)) {
      if (!/\.(dmg|exe|zip)$/.test(name)) continue
      const path = join(dir, name)
      files[name] = { sha256: sha256Of(path), size: statSync(path).size }
      if (name.endsWith('.zip') && name.includes('extension')) extension = name
    }
    const manifest = buildDownloads({
      version,
      channel,
      base: opt(args, '--base'),
      released: opt(args, '--released'),
      files,
      extension,
    })
    writeFileSync(opt(args, '--out'), `${JSON.stringify(manifest, null, 2)}\n`)
    process.stdout.write(`downloads.json：${version}（${channel}）\n`)
    return
  }
  if (cmd === 'check') {
    const dir = resolve(opt(args, '--dir'))
    const version = opt(args, '--version')
    const problems = checkArtifacts(readdirSync(dir), version, (n) =>
      readFileSync(join(dir, n), 'utf8'),
    )
    if (problems.length > 0) {
      process.stderr.write(`产物结构不对：\n  ${problems.join('\n  ')}\n`)
      process.exit(1)
    }
    process.stdout.write(`产物结构没问题：${version}\n`)
    return
  }
  if (cmd === 'tag') {
    const parsed = parseTag(args[0] ?? '')
    process.stdout.write(`version=${parsed.version}\nchannel=${parsed.channel}\n`)
    return
  }
  throw new Error(`不认识的子命令：${cmd}（merge-mac / downloads / check / tag）`)
}

const self = fileURLToPath(import.meta.url).toLowerCase()
if (process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self) {
  try {
    main(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
}
