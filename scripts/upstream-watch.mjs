#!/usr/bin/env node
/**
 * 上游哨兵的观察器（WP91；docs/10 §3.3 第 ①② 步、docs/42 §3）。
 *
 *   pnpm upstream:watch --dry-run            # 本机演练：查一遍、把报告打到 stdout，不开 issue
 *   pnpm upstream:watch --scope daily        # 只查 dsh（每日那一趟）
 *   node scripts/upstream-watch.mjs --out report.md --json summary.json
 *
 * 它**只观察、只写一份 markdown**：不改版本号、不装依赖、不跑测试、不开 issue、不开 PR。
 * 开 issue 是 workflow 那一步的事（权限收在那里，docs/10 §3.3 第 ⑤ 步"L1 人看"）。
 *
 * 查不到就如实说"查不到"，不把整趟跑红：GitHub 未登录时每小时只有 60 次匿名配额，
 * 私有 registry 的包在公网也查不到——一条查不到就 exit 1 的哨兵，一个月后就没人看了。
 * 真要让查不到算失败，加 `--strict`。
 *
 * 退出码：0 正常（含"有查不到的"）；1 `--strict` 且有查不到的；2 参数或登记表有问题。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import {
  loadUpstreams,
  REPO_ROOT,
  validateShape,
  versionVerdict,
  wishlistHits,
} from './upstreams-lib.mjs'

const UA = 'agentsws-upstream-watch (+https://github.com/Luoye-W/agentsws)'
const TIMEOUT_MS = 20_000

// ── 参数 ───────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    strict: false,
    scope: 'weekly',
    only: null,
    windowDays: 7,
    out: null,
    json: null,
    now: new Date(),
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 后面缺参数`)
      return v
    }
    if (a === '--dry-run') opts.dryRun = true
    else if (a === '--strict') opts.strict = true
    else if (a === '--scope') opts.scope = next()
    else if (a === '--only')
      opts.only = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    else if (a === '--window-days') opts.windowDays = Number.parseInt(next(), 10)
    else if (a === '--out') opts.out = next()
    else if (a === '--json') opts.json = next()
    else throw new Error(`不认识的参数 ${a}`)
  }
  if (!['weekly', 'daily'].includes(opts.scope)) throw new Error('--scope 只许 weekly / daily')
  if (!Number.isFinite(opts.windowDays) || opts.windowDays <= 0)
    throw new Error('--window-days 要是正整数')
  return opts
}

/** daily 那一趟只看 runtime-dep 里的 dsh；weekly 全量。 */
export function selectUpstreams(items, opts) {
  if (opts.only) return items.filter((it) => opts.only.includes(it.id))
  if (opts.scope === 'daily') return items.filter((it) => it.id === 'dsh')
  return items
}

// ── 取数（全部容错）────────────────────────────────────────────────────────

async function getJson(url, headers = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: { 'user-agent': UA, accept: 'application/json', ...headers },
    })
    if (!res.ok) return { error: `${res.status} ${res.statusText}`, url }
    return { data: await res.json(), url }
  } catch (e) {
    return { error: String(e?.message ?? e), url }
  } finally {
    clearTimeout(t)
  }
}

const ghHeaders = () => {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return token ? { authorization: `Bearer ${token}` } : {}
}

const npmUrl = (name) => `https://registry.npmjs.org/${name.replace('/', '%2f')}`

async function observeNpm(item) {
  const r = await getJson(npmUrl(String(item.npm)))
  if (r.error) return { error: r.error }
  const d = r.data ?? {}
  const versions = Object.keys(d.versions ?? {})
  const distTags = d['dist-tags'] ?? {}
  const verdict = versionVerdict(item.locked_version, Object.values(distTags), versions)
  const times = d.time ?? {}
  return {
    distTags,
    versions,
    recent: versions
      .map((v) => ({ v, at: times[v] }))
      .filter((x) => x.at)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .slice(0, 5),
    verdict,
    homepage: d.homepage ?? null,
  }
}

async function observeGithub(item, sinceIso) {
  const h = ghHeaders()
  const base = `https://api.github.com/repos/${item.repo}`
  const watch = item.watch ?? []
  const out = {}

  if (watch.includes('stars') || watch.includes('releases') || watch.includes('readme')) {
    const meta = await getJson(base, h)
    if (meta.error) out.metaError = meta.error
    else
      out.meta = {
        stars: meta.data.stargazers_count,
        pushedAt: meta.data.pushed_at,
        archived: meta.data.archived,
        description: meta.data.description,
        url: meta.data.html_url,
      }
  }

  if (watch.includes('releases') || watch.includes('wishlist')) {
    const rel = await getJson(`${base}/releases?per_page=10`, h)
    if (rel.error) out.releasesError = rel.error
    else
      out.releases = (Array.isArray(rel.data) ? rel.data : []).map((r) => ({
        tag: r.tag_name,
        name: r.name,
        at: r.published_at,
        url: r.html_url,
        body: (r.body ?? '').slice(0, 4000),
        fresh: r.published_at ? r.published_at >= sinceIso : false,
      }))
  }

  if (watch.includes('readme')) {
    const c = await getJson(
      `${base}/commits?path=README.md&since=${encodeURIComponent(sinceIso)}&per_page=10`,
      h,
    )
    if (c.error) out.readmeError = c.error
    else out.readmeCommits = (Array.isArray(c.data) ? c.data : []).map(commitBrief)
  }

  for (const p of item.watch_paths ?? []) {
    const c = await getJson(
      `${base}/commits?path=${encodeURIComponent(p)}&since=${encodeURIComponent(sinceIso)}&per_page=10`,
      h,
    )
    out.pathCommits ??= []
    if (c.error) out.pathCommits.push({ path: p, error: c.error })
    else
      out.pathCommits.push({
        path: p,
        commits: (Array.isArray(c.data) ? c.data : []).map(commitBrief),
      })
  }
  return out
}

const commitBrief = (c) => ({
  sha: String(c.sha ?? '').slice(0, 8),
  at: c.commit?.author?.date ?? null,
  message: String(c.commit?.message ?? '')
    .split('\n')[0]
    .slice(0, 160),
  url: c.html_url,
})

export async function observe(item, sinceIso) {
  const o = { id: item.id, item, errors: [] }
  if (item.npm && (item.watch ?? []).includes('versions')) {
    o.npm = await observeNpm(item)
    if (o.npm.error) o.errors.push(`npm registry：${o.npm.error}`)
  }
  if (item.repo) {
    o.gh = await observeGithub(item, sinceIso)
    for (const k of ['metaError', 'releasesError', 'readmeError']) {
      if (o.gh[k]) o.errors.push(`GitHub ${k.replace('Error', '')}：${o.gh[k]}`)
    }
    for (const pc of o.gh.pathCommits ?? []) {
      if (pc.error) o.errors.push(`GitHub commits(${pc.path})：${pc.error}`)
    }
  }
  o.hits = collectWishlistHits(item, o)
  return o
}

/** wishlist 在这一周的 release notes / README 提交信息里命中了什么（docs/10 §3.3 ②）。 */
export function collectWishlistHits(item, o) {
  const hits = []
  const texts = []
  for (const r of o.gh?.releases ?? []) {
    if (r.fresh) texts.push({ where: `release ${r.tag}`, url: r.url, text: `${r.name}\n${r.body}` })
  }
  for (const c of o.gh?.readmeCommits ?? [])
    texts.push({ where: `README ${c.sha}`, url: c.url, text: c.message })
  for (const pc of o.gh?.pathCommits ?? []) {
    for (const c of pc.commits ?? [])
      texts.push({ where: `${pc.path} ${c.sha}`, url: c.url, text: c.message })
  }
  for (const v of o.npm?.recent ?? []) texts.push({ where: `npm ${v.v}`, url: null, text: v.v })
  for (const t of texts) {
    for (const w of wishlistHits(item, t.text)) hits.push({ wish: w, where: t.where, url: t.url })
  }
  return hits
}

// ── 报告（纯函数，不出网，测试盯的就是它）──────────────────────────────────

const VERDICT_CN = {
  behind: '**上游有更新的版本**',
  current: '就是最新的',
  ahead: '我们锁的比上游 dist-tags 里任何一个都新',
  unknown: '查不到',
}

export function renderReport(observations, opts) {
  const { scope, windowDays, now } = opts
  const L = []
  const since = new Date(now.getTime() - windowDays * 86_400_000)
  const title =
    scope === 'daily' ? `上游哨兵 · 每日 dsh 检查（${isoDay(now)}）` : `上游周报 ${isoWeek(now)}`

  L.push(`# ${title}`)
  L.push('')
  L.push(
    `观察窗口：${isoDay(since)} → ${isoDay(now)}（${windowDays} 天）。**这份报告里没有任何东西被改、被装、被合并。**`,
  )
  L.push('')

  const behind = observations.filter((o) => o.npm?.verdict?.state === 'behind')
  const hits = observations.filter((o) => o.hits?.length)
  const broken = observations.filter((o) => o.errors.length)

  L.push('| | |')
  L.push('|---|---|')
  L.push(`| 看了几个上游 | ${observations.length} |`)
  L.push(
    `| 有更新版本的 | ${behind.length === 0 ? '无' : behind.map((o) => `\`${o.id}\``).join('、')} |`,
  )
  L.push(
    `| wishlist 命中 | ${hits.length === 0 ? '无' : hits.map((o) => `\`${o.id}\``).join('、')} |`,
  )
  L.push(
    `| 查不到的 | ${broken.length === 0 ? '无' : broken.map((o) => `\`${o.id}\``).join('、')} |`,
  )
  L.push('')

  for (const o of observations) L.push(...renderSection(o, opts))

  L.push(...renderHints(observations))
  return `${L.join('\n')}\n`
}

function renderSection(o, opts) {
  const it = o.item
  const L = []
  L.push(`## ${it.id} · ${it.kind}`)
  L.push('')
  L.push(`${it.why}`)
  L.push('')

  // 更新了什么
  if (o.npm) {
    if (o.npm.error) {
      L.push(`- npm \`${it.npm}\`：查不到（${o.npm.error}）`)
    } else {
      const v = o.npm.verdict
      L.push(
        `- npm \`${it.npm}\`：锁 \`${it.locked_version}\`，dist-tags 里最高的是 \`${v.highest ?? '?'}\` → ${VERDICT_CN[v.state]}`,
      )
      const tags = Object.entries(o.npm.distTags ?? {})
        .map(([k, val]) => `\`${k}\` = \`${val}\``)
        .join('，')
      if (tags) L.push(`  - dist-tags：${tags}`)
      if (!v.lockedIsKnown && v.state !== 'unknown')
        L.push(
          `  - ⚠️ 我们锁的 \`${it.locked_version}\` **不在上游的版本表里**（撤包了？私有 registry？）`,
        )
      if (o.npm.recent?.length)
        L.push(
          `  - 最近发布：${o.npm.recent.map((r) => `\`${r.v}\`(${isoDay(new Date(r.at))})`).join('、')}`,
        )
      if (v.state === 'ahead')
        L.push(
          '  - dist-tags 要如实看（docs/42 ②）：`latest` 落在我们锁的版本**之前**，"升到 latest"是降级。',
        )
    }
  }

  // 镜像：哨兵查不了 digest（要 registry 认证），但"tag 写的是 latest"这件事
  // 本身就该每周被念一遍——那等于没锁（docs/42 §4 第 2 条）。
  if (it.image) {
    L.push(
      it.image_tag && it.image_tag !== 'latest'
        ? `- 镜像 \`${it.image}:${it.image_tag}\`（哨兵不查 digest，升级时人工比）`
        : `- 镜像 \`${it.image}:${it.image_tag ?? 'latest'}\` —— ⚠️ **这等于没锁**：每次 pull 都可能是另一个 digest`,
    )
  }

  if (it.repo) {
    const repoUrl = `https://github.com/${it.repo}`
    if (o.gh?.meta) {
      const m = o.gh.meta
      L.push(
        `- GitHub [${it.repo}](${repoUrl})：★ ${m.stars}${m.archived ? '（**已归档**）' : ''}，最后推送 ${m.pushedAt ? isoDay(new Date(m.pushedAt)) : '?'}`,
      )
    } else if (o.gh?.metaError) {
      L.push(`- GitHub [${it.repo}](${repoUrl})：查不到（${o.gh.metaError}）`)
    }
    const fresh = (o.gh?.releases ?? []).filter((r) => r.fresh)
    if (o.gh?.releasesError) L.push(`  - releases：查不到（${o.gh.releasesError}）`)
    else if (fresh.length === 0) L.push('  - 窗口内没有新 release')
    else
      for (const r of fresh)
        L.push(`  - release [\`${r.tag}\`](${r.url}) · ${isoDay(new Date(r.at))} · ${r.name ?? ''}`)

    if (o.gh?.readmeError) L.push(`  - README：查不到（${o.gh.readmeError}）`)
    else if (o.gh?.readmeCommits)
      L.push(
        o.gh.readmeCommits.length === 0
          ? '  - README 窗口内没动'
          : `  - README 动了 ${o.gh.readmeCommits.length} 次：${o.gh.readmeCommits.map((c) => `[${c.sha}](${c.url})`).join('、')}`,
      )

    for (const pc of o.gh?.pathCommits ?? []) {
      if (pc.error) L.push(`  - \`${pc.path}\`：查不到（${pc.error}）`)
      else if (pc.commits.length === 0) L.push(`  - \`${pc.path}\` 窗口内没动`)
      else
        for (const c of pc.commits) L.push(`  - \`${pc.path}\` [${c.sha}](${c.url}) ${c.message}`)
    }
  }
  L.push('')

  // 我们碰到的 seam（分类靠它，docs/42 §4 第 1 条）
  if (it.we_depend_on?.length) {
    const summary =
      it.kind === 'ported'
        ? '我们的移植点（上游改了规则要对照回来）'
        : '我们碰到的 seam（上游动了这些就要逐条对 <code>.d.ts</code> 看）'
    L.push(`<details><summary>${summary}</summary>`)
    L.push('')
    for (const s of it.we_depend_on) L.push(`- ${s}`)
    L.push('')
    L.push('</details>')
    L.push('')
  }

  // 试升级结果 / 默认值翻转本身在另外两个 job 里跑（要装依赖、要克隆上游），
  // 由 workflow 的 report 步骤拼到 dsh 这一节后面。这里只说明"这一趟跑没跑"。
  if (it.kind === 'runtime-dep') {
    L.push(
      o.npm?.verdict?.state === 'behind'
        ? '**试升级结果 / 默认值翻转**：这一趟没跑（周报只观察；dsh 的试升级在每日那一趟，其余 runtime-dep 还是人肉走 docs/42）。'
        : '**试升级结果 / 默认值翻转**：没有新版本，不跑。',
    )
    L.push('')
  }

  // wishlist 命中
  if (o.hits?.length) {
    L.push('**wishlist 命中**：')
    for (const h of o.hits)
      L.push(`- ${h.wish} —— 出处：${h.url ? `[${h.where}](${h.url})` : h.where}`)
    L.push('')
  } else if ((it.watch ?? []).includes('wishlist')) {
    L.push('wishlist：窗口内一条都没命中。')
    L.push('')
  }

  if (o.errors.length) {
    L.push(`> 查不到的部分：${o.errors.join('；')}`)
    L.push('')
  }
  return L
}

/** 末尾那一段：给"判断层"（将来的评估例程 / 现在的人）看的提示。 */
function renderHints(observations) {
  const L = ['## 给评估例程的提示', '']
  const behind = observations.filter((o) => o.npm?.verdict?.state === 'behind')
  const ahead = observations.filter((o) => o.npm?.verdict?.state === 'ahead')
  const hits = observations.flatMap((o) => (o.hits ?? []).map((h) => ({ id: o.id, ...h })))
  const broken = observations.filter((o) => o.errors.length)

  if (behind.length === 0) L.push('- 没有 runtime-dep 落后于上游，这一周不需要动版本号。')
  for (const o of behind) {
    L.push(
      `- \`${o.id}\`：\`${o.item.locked_version}\` → \`${o.npm.verdict.highest}\`。按 docs/42 走完 ①→⑦，**先在当前代码树重采基线**，别沿用上一次那份。`,
    )
  }
  for (const o of ahead) {
    L.push(
      `- \`${o.id}\`：我们锁的版本比 \`latest\` 新（上游还在预发布期）。不要把"升到 latest"当动作——那是降级。`,
    )
  }
  for (const h of hits) {
    L.push(
      `- \`${h.id}\` 命中 wishlist「${h.wish}」：按 docs/10 §3.3 ⑥ 起一条"重判"，不是一次升级。`,
    )
  }
  for (const o of broken) {
    L.push(`- \`${o.id}\` 这一趟查不到（${o.errors[0]}）。**查不到 ≠ 没变**，下一趟仍要看。`)
  }
  L.push('')
  L.push(
    '判断层要回答的还是那三问（docs/10 §3.3 ②）：碰没碰我们的 seam · 破坏性还是增量 · 命不命中 wishlist。',
  )
  L.push('决定权在人：这条报告只摆事实，17 §4「任一红 = 不升级」。')
  L.push('')
  return L
}

// ── ISO 周与日 ─────────────────────────────────────────────────────────────

export function isoDay(d) {
  return d.toISOString().slice(0, 10)
}

/** ISO-8601 周号，用来给周报去重（同一周只开一条 issue）。 */
export function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((t - start) / 86_400_000 + 1) / 7)
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`
}

// ── main ───────────────────────────────────────────────────────────────────

export async function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (e) {
    process.stderr.write(`upstream-watch: ${e.message}\n`)
    return 2
  }

  let items
  try {
    items = loadUpstreams(REPO_ROOT)
  } catch (e) {
    process.stderr.write(`upstream-watch: 读不了 upstreams.yml —— ${e.message}\n`)
    return 2
  }
  const shape = validateShape(items)
  if (shape.length > 0) {
    process.stderr.write(`upstream-watch: 登记表有问题，先跑 check-upstreams\n`)
    for (const s of shape) process.stderr.write(`  - ${s}\n`)
    return 2
  }

  const selected = selectUpstreams(items, opts)
  if (selected.length === 0) {
    process.stderr.write('upstream-watch: 一个上游都没选中\n')
    return 2
  }
  const sinceIso = new Date(opts.now.getTime() - opts.windowDays * 86_400_000).toISOString()

  const observations = []
  for (const it of selected) {
    process.stderr.write(`… ${it.id}\n`)
    observations.push(await observe(it, sinceIso))
  }

  const report = renderReport(observations, opts)
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true })
    writeFileSync(opts.out, report)
    process.stderr.write(`报告写到 ${opts.out}\n`)
  }
  if (!opts.out || opts.dryRun) process.stdout.write(report)

  if (opts.json) {
    const dsh = observations.find((o) => o.id === 'dsh')
    const summary = {
      scope: opts.scope,
      week: isoWeek(opts.now),
      day: isoDay(opts.now),
      title:
        opts.scope === 'daily'
          ? `上游哨兵：dsh ${dsh?.item?.locked_version ?? '?'} → ${dsh?.npm?.verdict?.highest ?? '?'}`
          : `上游周报 ${isoWeek(opts.now)}`,
      dsh_locked: dsh?.item?.locked_version ?? null,
      dsh_target: dsh?.npm?.verdict?.highest ?? null,
      dsh_changed: dsh?.npm?.verdict?.state === 'behind',
      unreachable: observations.filter((o) => o.errors.length).map((o) => o.id),
    }
    mkdirSync(dirname(opts.json), { recursive: true })
    writeFileSync(opts.json, `${JSON.stringify(summary, null, 2)}\n`)
  }

  const unreachable = observations.filter((o) => o.errors.length)
  if (unreachable.length > 0) {
    process.stderr.write(`upstream-watch: ${unreachable.length} 个上游这一趟查不到\n`)
    if (opts.strict) return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(await main(process.argv.slice(2)))
}
