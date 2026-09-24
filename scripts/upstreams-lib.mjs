/**
 * 上游登记表的读取、校验与"锁的版本对不对得上"（WP91，docs/10 §3.2）。
 *
 * 这个模块**不依赖任何 npm 包**，理由很实在：哨兵的周报 job 只需要读一份 yml 再查几个
 * HTTP 接口，为这点事装一整棵 monorepo 的依赖树是浪费；`node scripts/check-upstreams.mjs`
 * 也应该在一棵没 install 过的树上就能跑。代价是只认 `upstreams.yml` 顶部写明的那个 YAML
 * 子集——所以解析器是**严格**的：看不懂的写法一律报错，绝不"尽量猜"。
 * （测试里还会拿 `yaml` 包的解析结果对一遍，证明这个子集解析器没跑偏。）
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const KINDS = ['runtime-dep', 'vendored', 'ported', 'reference', 'wrapped-plugin']
export const WATCH_ITEMS = ['versions', 'releases', 'readme', 'stars', 'default_flips', 'wishlist']

/** 允许出现的字段（多一个都算写坏了——拼错的字段名不报错等于静默失效）。 */
const SCALAR_FIELDS = [
  'id',
  'kind',
  'why',
  'npm',
  'repo',
  'image',
  'image_tag',
  'image_digest',
  'locked_version',
  'pinned_commit',
  'pin',
  'lockfile_single',
  'release_age_prefix',
  'bin_version',
  'bin_tag_prefix',
  'bin_lock_file',
]
const LIST_FIELDS = [
  'watch',
  'locked_in',
  'image_in',
  'we_depend_on',
  'watch_paths',
  'wishlist',
  'covered_by',
]
const ALL_FIELDS = [...SCALAR_FIELDS, ...LIST_FIELDS]

// ── YAML 子集解析 ──────────────────────────────────────────────────────────

/**
 * 认得的东西，仅此而已：
 *   - 注释行（`#` 起头）与空行
 *   - 顶层 `upstreams:`
 *   - 缩进 2 的 `- key: value` 起一条新记录，同一条记录后续字段缩进 4
 *   - 值：裸标量 / `'单引号'` / `[a, b, c]` 流式列表 / 空值 + 缩进 6 的 `- item` 块列表
 *
 * 行内注释只在 ` #` （前面有空白）时才当注释剥掉；值里真要带 `#` 就加单引号。
 */
export function parseUpstreamsYaml(text, file = 'upstreams.yml') {
  const lines = text.split('\n')
  const fail = (i, msg) => {
    throw new Error(`${file}:${i + 1}: ${msg}`)
  }

  let seenRoot = false
  const items = []
  /** @type {{ item: Record<string, unknown>, key: string } | null} */
  let pendingList = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.includes('\t')) fail(i, '不许用 tab 缩进')
    const bare = stripComment(raw)
    if (bare.trim() === '') continue

    const indent = bare.length - bare.trimStart().length
    const body = bare.trim()

    if (indent === 0) {
      if (body !== 'upstreams:') fail(i, `顶层只许有 \`upstreams:\`，看到的是 \`${body}\``)
      if (seenRoot) fail(i, '`upstreams:` 出现了两次')
      seenRoot = true
      pendingList = null
      continue
    }
    if (!seenRoot) fail(i, '内容出现在 `upstreams:` 之前')

    if (indent === 2) {
      if (!body.startsWith('- ')) fail(i, '缩进 2 的行必须是 `- key: value`（一条新记录的第一行）')
      const item = {}
      items.push(item)
      pendingList = assignField(item, body.slice(2), i, fail)
      continue
    }

    if (indent === 4) {
      if (items.length === 0) fail(i, '字段出现在任何一条记录之前')
      if (body.startsWith('- ')) fail(i, '缩进 4 的列表项要放到缩进 6（块列表挂在字段下面）')
      pendingList = assignField(items[items.length - 1], body, i, fail)
      continue
    }

    if (indent === 6) {
      if (!body.startsWith('- ')) fail(i, '缩进 6 的行只许是块列表项 `- …`')
      if (!pendingList) fail(i, '块列表没有对应的字段')
      pendingList.item[pendingList.key].push(scalar(body.slice(2).trim(), i, fail))
      continue
    }

    fail(i, `缩进 ${indent} 不在这个子集里（只许 0 / 2 / 4 / 6）`)
  }

  if (!seenRoot) fail(lines.length - 1, '没有找到 `upstreams:`')
  return items
}

function stripComment(line) {
  if (/^\s*#/.test(line)) return ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === "'") quoted = !quoted
    if (!quoted && c === '#' && i > 0 && /\s/.test(line[i - 1])) return line.slice(0, i)
  }
  return line
}

/** 写一个字段；返回"这是个等着块列表的字段"或 null。 */
function assignField(item, text, i, fail) {
  const m = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(text)
  if (!m) fail(i, `看不懂的行：\`${text}\``)
  const key = m[1]
  const rest = m[2].trim()
  if (key in item) fail(i, `字段 \`${key}\` 重复了`)

  if (rest === '') {
    item[key] = []
    return { item, key }
  }
  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) fail(i, '流式列表要在同一行闭合')
    const inner = rest.slice(1, -1).trim()
    item[key] = inner === '' ? [] : inner.split(',').map((s) => scalar(s.trim(), i, fail))
    return null
  }
  item[key] = scalar(rest, i, fail)
  return null
}

function scalar(text, i, fail) {
  if (text === '') fail(i, '空标量（要空值就写成空列表或直接不写这个字段）')
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) fail(i, '单引号没闭合')
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"')) fail(i, '这个子集只认单引号（双引号的转义规则太多）')
  if (text === 'true') return true
  if (text === 'false') return false
  return text
}

// ── 形状校验 ───────────────────────────────────────────────────────────────

/** @returns {string[]} 问题清单；空数组 = 没问题。 */
export function validateShape(items) {
  const problems = []
  const p = (msg) => problems.push(msg)
  if (!Array.isArray(items) || items.length === 0) {
    p('登记表是空的')
    return problems
  }

  const seen = new Set()
  for (const [idx, it] of items.entries()) {
    const where = it.id ? `[${it.id}]` : `[第 ${idx + 1} 条]`

    for (const k of Object.keys(it)) {
      if (!ALL_FIELDS.includes(k)) p(`${where} 不认识的字段 \`${k}\``)
      else if (LIST_FIELDS.includes(k) && !Array.isArray(it[k])) p(`${where} \`${k}\` 要写成列表`)
      else if (SCALAR_FIELDS.includes(k) && Array.isArray(it[k])) p(`${where} \`${k}\` 要写成标量`)
    }

    if (!it.id) p(`${where} 缺 \`id\``)
    else if (!/^[a-z0-9][a-z0-9-]*$/.test(String(it.id))) p(`${where} \`id\` 只许 a-z 0-9 与连字符`)
    else if (seen.has(it.id)) p(`${where} \`id\` 重复`)
    else seen.add(it.id)

    if (!it.kind) p(`${where} 缺 \`kind\``)
    else if (!KINDS.includes(String(it.kind)))
      p(`${where} \`kind\` 只许是 ${KINDS.join(' / ')}，写的是 \`${it.kind}\``)

    if (!it.why || String(it.why).trim() === '') p(`${where} 缺 \`why\`（一句话：我们哪里用到它）`)

    const watch = Array.isArray(it.watch) ? it.watch : []
    if (watch.length === 0) p(`${where} \`watch\` 不能为空`)
    for (const w of watch) {
      if (!WATCH_ITEMS.includes(String(w))) p(`${where} \`watch\` 里不认识的项 \`${w}\``)
    }

    if (!it.npm && !it.repo && !it.image) p(`${where} npm / repo / image 至少要有一个`)
    if (it.repo && !/^[\w.-]+\/[\w.-]+$/.test(String(it.repo)))
      p(`${where} \`repo\` 要写成 owner/name，写的是 \`${it.repo}\``)

    if (watch.includes('versions') && !it.npm) p(`${where} watch 里有 versions 就要有 \`npm\``)
    for (const need of ['releases', 'readme', 'stars']) {
      if (watch.includes(need) && !it.repo) p(`${where} watch 里有 ${need} 就要有 \`repo\``)
    }
    if (watch.includes('wishlist') && (!it.wishlist || it.wishlist.length === 0))
      p(`${where} watch 里有 wishlist，但 \`wishlist\` 是空的`)
    if (it.wishlist?.length && !watch.includes('wishlist'))
      p(`${where} 写了 \`wishlist\` 却没在 \`watch\` 里盯它`)

    if (it.pin !== undefined && !['exact', 'allow_caret'].includes(String(it.pin)))
      p(`${where} \`pin\` 只许 exact / allow_caret`)
    if (it.kind === 'runtime-dep' && !it.locked_version && !it.pinned_commit)
      p(`${where} runtime-dep 要么有 \`locked_version\`、要么有 \`pinned_commit\``)
    if (it.locked_version && it.pinned_commit) p(`${where} locked_version 与 pinned_commit 二选一`)
    if (it.locked_in?.length && !it.npm) p(`${where} 有 \`locked_in\` 就要有 \`npm\``)
    if (it.locked_in?.length && !it.locked_version)
      p(`${where} 有 \`locked_in\` 就要有 \`locked_version\``)
    if (it.image_tag && !it.image) p(`${where} 有 \`image_tag\` 就要有 \`image\``)
    // WP146：镜像同 npm 一样要锁死——tag 会被重打、`latest` 每次 pull 都可能换，只有 digest 不会变
    if (it.image_digest !== undefined) {
      if (!it.image) p(`${where} 有 \`image_digest\` 就要有 \`image\``)
      if (!DIGEST_RE.test(String(it.image_digest)))
        p(`${where} \`image_digest\` 要写成 sha256:<64 位十六进制>，写的是 \`${it.image_digest}\``)
    }
    if (it.image_in?.length && (!it.image_tag || !it.image_digest))
      p(`${where} 有 \`image_in\` 就要有 \`image_tag\` 与 \`image_digest\``)
    if (it.kind === 'runtime-dep' && it.image) {
      if (!it.image_tag || it.image_tag === 'latest')
        p(`${where} runtime-dep 的镜像要锁正式版 tag，不许 \`latest\`（docs/42 红线 3）`)
      if (!it.image_digest)
        p(`${where} runtime-dep 的镜像要同时锁 \`image_digest\`（tag 会被重打）`)
      if (!it.image_in?.length) p(`${where} runtime-dep 的镜像要写 \`image_in\`（哪些文件引用它）`)
    }
    const bin = ['bin_version', 'bin_tag_prefix', 'bin_lock_file'].filter(
      (k) => it[k] !== undefined,
    )
    if (bin.length > 0 && bin.length < 3)
      p(`${where} bin_version / bin_tag_prefix / bin_lock_file 要么都写、要么都不写`)
    if (bin.length === 3 && !it.repo)
      p(`${where} 有 \`bin_version\` 就要有 \`repo\`（比的是它的 release）`)
    if (it.lockfile_single !== undefined && typeof it.lockfile_single !== 'boolean')
      p(`${where} \`lockfile_single\` 只许 true / false`)
    if (String(it.locked_version ?? '').startsWith('^') && it.pin !== 'allow_caret')
      p(`${where} \`locked_version\` 带 ^ 就要显式写 \`pin: allow_caret\`（docs/42 红线 3）`)
  }
  return problems
}

export const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

// ── 与仓库实际锁的版本对账 ─────────────────────────────────────────────────

const stripRange = (v) => String(v).replace(/^[\^~]/, '')

/**
 * `locked_in` 的每个 package.json、pnpm-lock.yaml 的唯一解析版本、
 * pnpm-workspace.yaml 的 minimumReleaseAgeExclude —— 三处都要和登记表一致。
 * @returns {string[]} 问题清单
 */
export function checkPins(items, root = REPO_ROOT) {
  const problems = []
  const p = (msg) => problems.push(msg)
  const lock = readIfExists(join(root, 'pnpm-lock.yaml'))
  const ws = readIfExists(join(root, 'pnpm-workspace.yaml'))

  for (const it of items) {
    const where = `[${it.id}]`
    const want = String(it.locked_version ?? '')
    const allowCaret = it.pin === 'allow_caret'

    for (const rel of it.locked_in ?? []) {
      const abs = join(root, String(rel))
      if (!existsSync(abs)) {
        p(`${where} locked_in 指向不存在的文件：${rel}`)
        continue
      }
      let pkg
      try {
        pkg = JSON.parse(readFileSync(abs, 'utf8'))
      } catch {
        p(`${where} ${rel} 不是合法的 JSON`)
        continue
      }
      const declared = [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ]
        .map((f) => pkg[f]?.[String(it.npm)])
        .find((v) => v !== undefined)
      if (declared === undefined) {
        p(`${where} ${rel} 里根本没有依赖 \`${it.npm}\``)
      } else if (!allowCaret && /^[\^~]/.test(String(declared))) {
        // 先说这一条：范围本身就是问题，版本号对不对得上是次要的（docs/42 红线 3）
        p(`${where} ${rel} 用了范围 \`${declared}\`——runtime-dep 要锁精确版本（docs/42 红线 3）`)
      } else if (declared !== want && !(allowCaret && stripRange(declared) === stripRange(want))) {
        p(`${where} ${rel} 声明的是 \`${declared}\`，登记表写的是 \`${want}\``)
      }
    }

    const wantSingle = it.lockfile_single ?? Boolean(it.npm && it.locked_version)
    if (wantSingle && it.npm && it.locked_version) {
      if (lock === null) p(`${where} 要查 lockfile，但 pnpm-lock.yaml 不在`)
      else {
        const found = lockfileVersions(lock, String(it.npm))
        if (found.length === 0) p(`${where} pnpm-lock.yaml 里没有 \`${it.npm}\``)
        else if (found.length > 1)
          p(`${where} pnpm-lock.yaml 里 \`${it.npm}\` 解析出多个版本：${found.join(' / ')}`)
        else if (found[0] !== stripRange(want))
          p(`${where} pnpm-lock.yaml 里 \`${it.npm}\` 是 ${found[0]}，登记表写的是 ${want}`)
      }
    }

    if (it.release_age_prefix) {
      if (ws === null) p(`${where} 要查 minimumReleaseAgeExclude，但 pnpm-workspace.yaml 不在`)
      else {
        const entries = releaseAgeExcludes(ws).filter((e) =>
          e.name.startsWith(String(it.release_age_prefix)),
        )
        if (entries.length === 0)
          p(`${where} minimumReleaseAgeExclude 里一条 \`${it.release_age_prefix}*\` 都没有`)
        for (const e of entries) {
          if (e.version !== stripRange(want))
            p(
              `${where} minimumReleaseAgeExclude 的 \`${e.name}@${e.version}\` 不是登记表的 ${want}`,
            )
        }
      }
    }

    problems.push(...checkImagePins(it, root))
    problems.push(...checkBinLock(it, root))

    for (const rel of it.covered_by ?? []) {
      if (!existsSync(join(root, String(rel)))) p(`${where} covered_by 指向不存在的路径：${rel}`)
    }
  }
  return problems
}

const escapeRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * 一段文字里对某个镜像的全部**带 tag 或 digest** 的引用（`仓库:tag`、`仓库@sha256:…`、两者都有）。
 * 光秃秃的仓库名（注释里说"起一个 `ghcr.io/x/y` 容器"）不算引用，不返回。
 */
export function findImageRefs(text, image) {
  const re = new RegExp(
    `${escapeRe(image)}(?::[A-Za-z0-9_][A-Za-z0-9_.-]*)?(?:@sha256:[0-9a-f]+)?`,
    'g',
  )
  return [...String(text).matchAll(re)].map((m) => m[0]).filter((ref) => ref !== image)
}

/**
 * WP146：`image_in` 里的每个文件都必须**至少引用一次**这个镜像，而且每一处都逐字等于
 * `image:image_tag@image_digest`。compose 里的 digest 被改了、哪一处退回 `:latest`、
 * 只写 tag 不写 digest —— 都在这里红。
 * @returns {string[]}
 */
export function checkImagePins(it, root = REPO_ROOT) {
  const problems = []
  if (!it.image || !it.image_in?.length || !it.image_tag || !it.image_digest) return problems
  const where = `[${it.id}]`
  const want = `${it.image}:${it.image_tag}@${it.image_digest}`
  for (const rel of it.image_in) {
    const text = readIfExists(join(root, String(rel)))
    if (text === null) {
      problems.push(`${where} image_in 指向不存在的文件：${rel}`)
      continue
    }
    const refs = findImageRefs(text, it.image)
    if (refs.length === 0)
      problems.push(`${where} ${rel} 里没有引用 \`${it.image}\`（要写成 \`${want}\`）`)
    for (const ref of new Set(refs)) {
      if (ref !== want)
        problems.push(`${where} ${rel} 引用的是 \`${ref}\`，登记表锁的是 \`${want}\``)
    }
  }
  return problems
}

/**
 * 不走 npm 的二进制（BrowserSkill 的 `bsk`）：版本与 sha256 钉在一份 JSON 里
 * （`{ cli: { version, tag }, plugin?: { name, version } }`）。登记表的 `bin_version` 要等于
 * 它的 `cli.version`、`cli.tag` 要等于 `bin_tag_prefix + bin_version`；同一份文件里若也记了
 * npm 插件的版本，那也要等于 `locked_version`（两边一起升，不许只改一边）。
 * @returns {string[]}
 */
export function checkBinLock(it, root = REPO_ROOT) {
  const problems = []
  if (!it.bin_lock_file || !it.bin_version) return problems
  const where = `[${it.id}]`
  const rel = String(it.bin_lock_file)
  const text = readIfExists(join(root, rel))
  if (text === null) return [`${where} bin_lock_file 指向不存在的文件：${rel}`]
  let lock
  try {
    lock = JSON.parse(text)
  } catch {
    return [`${where} ${rel} 不是合法的 JSON`]
  }
  const cli = lock?.cli ?? {}
  if (cli.version !== String(it.bin_version))
    problems.push(
      `${where} ${rel} 的 cli.version 是 \`${cli.version}\`，登记表写的是 \`${it.bin_version}\``,
    )
  const wantTag = `${it.bin_tag_prefix ?? ''}${it.bin_version}`
  if (cli.tag !== wantTag)
    problems.push(`${where} ${rel} 的 cli.tag 是 \`${cli.tag}\`，应该是 \`${wantTag}\``)
  const plugin = lock?.plugin
  if (plugin && it.npm && plugin.name === it.npm && plugin.version !== String(it.locked_version))
    problems.push(
      `${where} ${rel} 的 plugin.version 是 \`${plugin.version}\`，登记表锁的是 \`${it.locked_version}\``,
    )
  return problems
}

function readIfExists(abs) {
  return existsSync(abs) ? readFileSync(abs, 'utf8') : null
}

/** pnpm-lock.yaml 的 `packages:` 段里，某个包解析出来的全部版本。 */
export function lockfileVersions(lockText, name) {
  const out = new Set()
  let inPackages = false
  for (const line of lockText.split('\n')) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true
      continue
    }
    if (inPackages && /^\S/.test(line)) break
    if (!inPackages) continue
    // `  '@scope/pkg@1.2.3':` / `  pkg@1.2.3:`。peer 后缀（`(x@1)`）正常只出现在
    // snapshots: 段，这里仍然剥一次，免得哪天上游改了格式就静默漏。
    const m = /^ {2}'?(.+?)'?:\s*$/.exec(line)
    if (!m) continue
    const spec = m[1].replace(/\(.*$/, '')
    const at = spec.lastIndexOf('@')
    if (at <= 0) continue
    if (spec.slice(0, at) === name) out.add(spec.slice(at + 1))
  }
  return [...out].sort()
}

/** pnpm-workspace.yaml 的 minimumReleaseAgeExclude 段。 */
export function releaseAgeExcludes(wsText) {
  const out = []
  let inside = false
  for (const line of wsText.split('\n')) {
    if (/^minimumReleaseAgeExclude:\s*$/.test(line)) {
      inside = true
      continue
    }
    if (inside && /^\S/.test(line)) break
    if (!inside) continue
    const m = /^\s*-\s*'?([^'\s]+)'?\s*$/.exec(stripComment(line))
    if (!m) continue
    const at = m[1].lastIndexOf('@')
    if (at <= 0) continue
    out.push({ name: m[1].slice(0, at), version: m[1].slice(at + 1) })
  }
  return out
}

// ── 版本号比较（dist-tags 要如实看，docs/42 ②）─────────────────────────────

/** semver 比较，认预发布后缀。a > b 返回正数。 */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre = ''] = String(v).split('-', 2)
    return [core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre]
  }
  const [ca, pa] = split(a)
  const [cb, pb] = split(b)
  for (let i = 0; i < 3; i++) {
    if ((ca[i] ?? 0) !== (cb[i] ?? 0)) return (ca[i] ?? 0) - (cb[i] ?? 0)
  }
  if (pa === pb) return 0
  if (pa === '') return 1 // 正式版 > 预发布版
  if (pb === '') return -1
  const xa = pa.split('.')
  const xb = pb.split('.')
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const u = xa[i]
    const v = xb[i]
    if (u === v) continue
    if (u === undefined) return -1
    if (v === undefined) return 1
    const nu = /^\d+$/.test(u)
    const nv = /^\d+$/.test(v)
    if (nu && nv) return Number(u) - Number(v)
    if (nu !== nv) return nu ? -1 : 1
    return u < v ? -1 : 1
  }
  return 0
}

/**
 * 锁的版本相对上游处在什么位置。
 *
 * 候选只取 **dist-tags 指着的那几个版本**，不取整张版本表：版本表里常年躺着早年的
 * 试验号（`@playwright/mcp` 就有一串 `1.52.0-alpha-…` 比现在的 `0.0.81` 还"大"），
 * 拿全表取最大会得出一个谁也不会去升的目标。
 *
 * 也**不是**"latest 不等于锁的就叫落后"：上游预发布期的 `latest` 可能比我们锁的还旧
 * （0.1.6-alpha.1 挂在 `alpha` 上、`latest` 还停在 0.1.5-rc.1），那时"升到 latest"是降级。
 */
export function versionVerdict(locked, tagVersions, allVersions) {
  const lock = stripRange(locked)
  const cand = [...new Set((tagVersions ?? []).filter(Boolean))]
  const all = (allVersions ?? cand).filter(Boolean)
  if (cand.length === 0) return { state: 'unknown', highest: null, lockedIsKnown: false }
  const highest = cand.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b))
  const cmp = compareVersions(highest, lock)
  return {
    state: cmp > 0 ? 'behind' : cmp === 0 ? 'current' : 'ahead',
    highest,
    lockedIsKnown: all.includes(lock),
  }
}

const stripV = (t) => String(t).replace(/^v/, '')

/** 镜像 tag 里的**正式版**（`v1.2.3` / `1.2.3`）；commit 短哈希、`latest`、`-rc` 一律不算。 */
export function stableImageTags(tags) {
  return (tags ?? []).filter((t) => /^v?\d+\.\d+\.\d+$/.test(String(t)))
}

/**
 * 镜像锁的版本相对上游处在什么位置（WP146）。
 *
 * - `state`：锁的 tag 与上游最高正式版比 —— behind / current / ahead / unknown
 * - `tagMoved`：锁的那个 tag **现在**指向的 digest 与我们锁的不一样（上游重打了 tag）。
 *   我们钉了 digest，不受影响；但这是要人看一眼的事，报告里单列。
 */
export function imageVerdict({ lockedTag, lockedDigest, tags, lockedTagDigest }) {
  const stable = stableImageTags(tags)
  const tagMoved = Boolean(lockedTagDigest && lockedDigest && lockedTagDigest !== lockedDigest)
  const lockedIsKnown = (tags ?? []).includes(lockedTag)
  if (stable.length === 0) return { state: 'unknown', highest: null, tagMoved, lockedIsKnown }
  const highest = stable.reduce((a, b) => (compareVersions(stripV(a), stripV(b)) >= 0 ? a : b))
  const cmp = compareVersions(stripV(highest), stripV(lockedTag))
  return {
    state: cmp > 0 ? 'behind' : cmp === 0 ? 'current' : 'ahead',
    highest,
    tagMoved,
    lockedIsKnown,
  }
}

/**
 * 二进制（`bin_tag_prefix`）在 GitHub releases 里的最新正式版，与锁的比。
 * 草稿与预发布不算；一条带前缀的都没有就是 unknown（查不到 ≠ 没变）。
 */
export function binReleaseVerdict(releases, prefix, locked) {
  const cand = (releases ?? [])
    .filter((r) => !r.draft && !r.prerelease && String(r.tag ?? '').startsWith(prefix))
    .map((r) => String(r.tag).slice(prefix.length))
    .filter((v) => /^v?\d+\.\d+\.\d+$/.test(v))
  if (cand.length === 0) return { state: 'unknown', highest: null }
  const highest = cand.reduce((a, b) => (compareVersions(stripV(a), stripV(b)) >= 0 ? a : b))
  const cmp = compareVersions(stripV(highest), stripV(locked))
  return { state: cmp > 0 ? 'behind' : cmp === 0 ? 'current' : 'ahead', highest }
}

/** 一条记录里 wishlist 的哪些词命中了这段文字。 */
export function wishlistHits(item, text) {
  if (!item.wishlist?.length || !text) return []
  const hay = String(text).toLowerCase()
  return item.wishlist.filter((w) =>
    keywordsOf(String(w)).some((k) => k.length >= 3 && hay.includes(k)),
  )
}

/** 从一条 wishlist 里抠出可搜的关键词（ASCII 词 + 长度 ≥ 2 的中文串）。 */
export function keywordsOf(wish) {
  const ascii = wish.toLowerCase().match(/[a-z][a-z0-9_@/.-]{2,}/g) ?? []
  const cjk = wish.match(/[一-龥]{2,}/g) ?? []
  return [...new Set([...ascii, ...cjk])].filter((w) => !STOP.has(w))
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'able'])

/** 读并解析仓库根的 upstreams.yml。 */
export function loadUpstreams(root = REPO_ROOT) {
  const file = join(root, 'upstreams.yml')
  return parseUpstreamsYaml(readFileSync(file, 'utf8'), 'upstreams.yml')
}
