/**
 * 周报里的「依赖安全公告」一节（WP368，决策 984）。
 *
 * 跑两次 `pnpm audit --json`（一次 `--prod`），只读 pnpm-lock.yaml、不装依赖，两秒左右。
 * 公告分三组，只有第一组报警：
 * - **运行时**：`--prod` 查得到、而且路径不在下面的 {@link BUILD_ONLY_PATHS} 里——会跟着软件跑到用户机器上；
 * - **构建期**：写在 `dependencies` 里、但只在构建时跑的（静态官网、shadcn 命令行）；
 * - **开发期**：只在 `devDependencies` 下面的（vitest / wrangler / electron-builder 之类）。
 * 后两组单列、不报警：它们碰不到用户，攒着等工具链顺手升级。
 *
 * 查不到（没装 pnpm、registry 不通）就如实写"查不到"，和别的上游一样不把整趟跑红。
 */

import { spawnSync } from 'node:child_process'
import { REPO_ROOT } from './upstreams-lib.mjs'

/**
 * 写在 `dependencies` 里、但只在构建时跑的路径前缀（`pnpm audit` 的路径写法：`apps/site` → `apps__site`）。
 * 新加一条要写清为什么它碰不到用户。
 */
export const BUILD_ONLY_PATHS = [
  // 官网（WP197）：纯静态站，astro / sharp 只在 `astro build` 时跑，产物是 HTML + 图片
  'apps__site>',
  // 工作台只 `@import "shadcn/tailwind.css"`（Vite 构建时内联）和用它的命令行加组件，运行时不加载
  'apps__workstation>shadcn>',
]

const SEVERITY_RANK = { critical: 4, high: 3, moderate: 2, low: 1, info: 0 }
const SEVERITY_CN = { critical: '严重', high: '高危', moderate: '中危', low: '低危', info: '提示' }

/** `pnpm audit --json [--prod]`。有公告时它退 1，所以只认 stdout 能不能解析。 */
export function runPnpmAudit({ prod }, cwd = REPO_ROOT) {
  const args = ['audit', '--json', ...(prod ? ['--prod'] : [])]
  const r = spawnSync('pnpm', args, { cwd, encoding: 'utf8', timeout: 120_000 })
  if (r.error) return { error: `pnpm ${args.join(' ')}：${r.error.message}` }
  try {
    const json = JSON.parse(r.stdout)
    if (json && typeof json.advisories === 'object') return { json }
  } catch {}
  const why = (r.stderr || r.stdout || '').trim().split('\n')[0]?.slice(0, 200)
  return { error: `pnpm ${args.join(' ')} 退 ${r.status}：${why || '没有输出'}` }
}

const keyOf = (a) => `${a.github_advisory_id}|${a.module_name}|${a.vulnerable_versions}`
const pathsOf = (a) => (a.findings ?? []).flatMap((f) => f.paths ?? [])

/**
 * 纯函数：两份 `pnpm audit --json` → 三组公告。同一条公告（GHSA + 包 + 受影响范围）只出现在一组里，
 * 运行时 > 构建期 > 开发期。
 */
export function classifyAudit(prodJson, allJson, buildOnly = BUILD_ONLY_PATHS) {
  const isBuildOnly = (p) => buildOnly.some((prefix) => p.startsWith(prefix))
  const prodPaths = new Map()
  for (const a of Object.values(prodJson?.advisories ?? {})) prodPaths.set(keyOf(a), pathsOf(a))

  const out = { runtime: [], build: [], dev: [] }
  const seen = new Set()
  const all = [
    ...Object.values(prodJson?.advisories ?? {}),
    ...Object.values(allJson?.advisories ?? {}),
  ]
  for (const a of all) {
    const key = keyOf(a)
    if (seen.has(key)) continue
    seen.add(key)
    const inProd = prodPaths.get(key) ?? []
    const runtimePaths = inProd.filter((p) => !isBuildOnly(p))
    const group = runtimePaths.length > 0 ? 'runtime' : inProd.length > 0 ? 'build' : 'dev'
    const paths = group === 'runtime' ? runtimePaths : group === 'build' ? inProd : pathsOf(a)
    out[group].push({
      ghsa: a.github_advisory_id ?? String(a.id),
      module: a.module_name,
      severity: a.severity,
      title: a.title ?? '',
      versions: [...new Set((a.findings ?? []).map((f) => f.version))],
      patched: a.patched_versions ?? '',
      paths,
    })
  }
  const order = (x, y) =>
    (SEVERITY_RANK[y.severity] ?? 0) - (SEVERITY_RANK[x.severity] ?? 0) ||
    x.module.localeCompare(y.module)
  for (const g of Object.values(out)) g.sort(order)
  return out
}

/** 查一趟：两次 audit 都成才分组，任何一次查不到就整节写"查不到"。 */
export function observeDepAudit(run = runPnpmAudit) {
  const prod = run({ prod: true })
  if (prod.error) return { errors: [prod.error] }
  const all = run({ prod: false })
  if (all.error) return { errors: [all.error] }
  return { errors: [], ...classifyAudit(prod.json, all.json) }
}

/** 运行时这一组里严重 + 高危的条数（周报摘要表与 summary.json 用）。 */
export const alarming = (audit) =>
  (audit?.runtime ?? []).filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK.high)

const countLine = (list) => {
  if (list.length === 0) return '无'
  const n = {}
  for (const a of list) n[a.severity] = (n[a.severity] ?? 0) + 1
  return Object.keys(SEVERITY_RANK)
    .filter((s) => n[s])
    .map((s) => `${SEVERITY_CN[s]} ${n[s]}`)
    .join('、')
}

const row = (a) => {
  const via = a.paths[0] ?? '?'
  const more = a.paths.length > 1 ? `（等 ${a.paths.length} 条路径）` : ''
  return `| ${SEVERITY_CN[a.severity] ?? a.severity} | \`${a.module}@${a.versions.join(' / ')}\` | [${a.ghsa}](https://github.com/advisories/${a.ghsa}) ${a.title} | \`${a.patched}\` | \`${via}\`${more} |`
}
const HEAD = ['| 级别 | 包 | 公告 | 修好的版本 | 从哪儿进来 |', '|---|---|---|---|---|']

/** 周报里的那一节。`audit` 为空（daily / `--no-audit`）就不出。 */
export function renderAuditSection(audit) {
  if (!audit) return []
  const L = ['## 依赖安全公告', '']
  if (audit.errors.length) {
    L.push(`这一趟查不到：${audit.errors[0]}。**查不到 ≠ 没有**，下一趟仍要看。`, '')
    return L
  }
  L.push(
    `\`pnpm audit\` 只读锁文件。**运行时**（会跟着软件跑到用户机器上的）：${countLine(audit.runtime)}。`,
    '',
  )
  if (audit.runtime.length) L.push(...HEAD, ...audit.runtime.map(row), '')
  const quiet = [...audit.build, ...audit.dev]
  L.push(
    `<details><summary>构建期 ${audit.build.length} 条 · 开发期 ${audit.dev.length} 条（碰不到用户，不报警）</summary>`,
    '',
  )
  if (quiet.length) L.push(...HEAD, ...quiet.map(row))
  else L.push('无。')
  L.push('', '</details>', '')
  return L
}

/** 「给评估例程的提示」里加的那几行：只为运行时的严重 / 高危出声，同一个包合成一行。 */
export function auditHints(audit) {
  if (!audit) return []
  if (audit.errors.length) return [`- 依赖安全公告这一趟查不到（${audit.errors[0]}）。`]
  const byModule = new Map()
  for (const a of alarming(audit)) {
    const m = byModule.get(a.module) ?? { versions: new Set(), ghsas: new Set(), worst: a.severity }
    for (const v of a.versions) m.versions.add(v)
    m.ghsas.add(a.ghsa)
    byModule.set(a.module, m)
  }
  const lines = [...byModule].map(
    ([mod, m]) =>
      `- 运行时依赖 \`${mod}@${[...m.versions].join(' / ')}\` 有${SEVERITY_CN[m.worst]}公告（${[...m.ghsas].join('、')}）：先看它在我们的运行时会不会真加载，再定顶不顶。`,
  )
  if (lines.length)
    lines.push(
      '- 顶的做法：`pnpm-workspace.yaml` 的 overrides 写修好的精确版本（WP368 的 compression / proxy-addr 是例子），`pnpm why <包> -r` 只剩新版；上游跟上了就删掉那条覆盖。',
    )
  return lines
}
