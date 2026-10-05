/**
 * WP219（docs/90 §4、docs/42「内容更新」）：内容更新登记表（`content-reviews.json`）、打包计划、
 * 提案渲染——**纯函数**，不出网、不读密钥。打包 / 签名 / 校验的实现在 `@agentsws/skills`
 * （`packages/skills/dist`，要先 `tsc -b`），这里只做「登记表 → 该打哪几条」。
 *
 * 规矩（打包脚本照这个执行，测试钉住）：
 * - 只打「当前目录的条目摘要 = 最新一条审核记录的 sha256」的条目——**签出去的就是审过的那一份**；
 * - 审核记录的版本号要等于当前目录里的版本号；
 * - 扫描命中要在审核记录里逐条放行（规则 + 文件 + 命中原文 + 理由），有一条没放行就不打；
 * - `pending_merge`：那一条还在别的工作单分支上（例如 WP216 的 Shopify 技能），目录不在就跳过；
 * - 没审过的、审完又改过的、版本对不上的：不打，列进作业摘要，**不让整个发版红**（内容包是独立一步）。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const LEDGER_FILE = 'content-reviews.json'
export const LEDGER_SCHEMA = 'agentsws.content-reviews/1'

/** `@agentsws/skills` 的编译产物（打包、验签、扫描都在那里）。 */
export async function loadSkills(root = REPO_ROOT) {
  const dist = join(root, 'packages/skills/dist/index.js')
  if (!existsSync(dist)) throw new Error('packages/skills 还没编译：先跑 `pnpm exec tsc -b`')
  return import(dist)
}

export function readLedger(root = REPO_ROOT) {
  return JSON.parse(readFileSync(join(root, LEDGER_FILE), 'utf8'))
}

const isStr = (v) => typeof v === 'string' && v !== ''
const REVIEW_KEYS = [
  'version',
  'sha256',
  'reviewer',
  'reviewed_at',
  'upstream',
  'license',
  'notes_ok',
  'tests_ok',
  'summary',
]

/** 登记表的形状（CI 跑这个）。回问题清单，空 = 没问题。 */
export function checkLedger(ledger) {
  const problems = []
  if (ledger?.schema !== LEDGER_SCHEMA) problems.push(`schema 应是 ${LEDGER_SCHEMA}`)
  if (!isStr(ledger?.min_app_version)) problems.push('缺 min_app_version')
  if (!Array.isArray(ledger?.items)) return [...problems, '缺 items']
  const ids = new Set()
  for (const [i, it] of ledger.items.entries()) {
    const at = `items[${i}]${isStr(it?.id) ? `（${it.id}）` : ''}`
    if (!isStr(it?.id) || !/^[a-z]+:[a-z0-9][a-z0-9.-]*$/.test(it.id))
      problems.push(`${at}：id 不对`)
    if (ids.has(it?.id)) problems.push(`${at}：id 重复`)
    ids.add(it?.id)
    if (!['skill', 'role', 'declarative'].includes(it?.kind)) problems.push(`${at}：kind 不对`)
    if (isStr(it?.id) && it.id !== `${it.kind}:${it.id.slice(it.id.indexOf(':') + 1)}`)
      problems.push(`${at}：id 前缀应是 kind`)
    if (!isStr(it?.path) || it.path.startsWith('/') || it.path.includes('..'))
      problems.push(`${at}：path 不对`)
    if (!isStr(it?.upstream_id)) problems.push(`${at}：缺 upstream_id（对 upstreams.yml）`)
    if (!isStr(it?.title?.zh) || !isStr(it?.title?.en))
      problems.push(`${at}：缺 title.zh / title.en`)
    if (it?.platforms !== undefined && !Array.isArray(it.platforms))
      problems.push(`${at}：platforms 应是数组`)
    if (!Array.isArray(it?.reviews)) {
      problems.push(`${at}：缺 reviews 数组`)
      continue
    }
    for (const [j, r] of it.reviews.entries()) {
      for (const k of REVIEW_KEYS)
        if (r?.[k] === undefined) problems.push(`${at}.reviews[${j}]：缺 ${k}`)
      if (r?.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(r.sha256))
        problems.push(`${at}.reviews[${j}]：sha256 不对`)
      if (
        r?.upstream !== undefined &&
        (!isStr(r.upstream.repo) || !isStr(r.upstream.commit) || !isStr(r.upstream.published_at))
      )
        problems.push(`${at}.reviews[${j}]：upstream 要有 repo / commit / published_at`)
      if (r?.license !== undefined && (!isStr(r.license.before) || !isStr(r.license.after)))
        problems.push(`${at}.reviews[${j}]：license 要有 before / after`)
      if (
        r?.license !== undefined &&
        r.license.before !== r.license.after &&
        !isStr(r.license_note)
      )
        problems.push(`${at}.reviews[${j}]：许可证变了，要写 license_note（还能不能原样分发）`)
      if (r?.summary !== undefined && (!isStr(r.summary.zh) || !isStr(r.summary.en)))
        problems.push(`${at}.reviews[${j}]：summary 要有 zh / en`)
      for (const a of r?.scan_accepted ?? [])
        if (!isStr(a?.rule) || !isStr(a?.path) || !isStr(a?.match) || !isStr(a?.reason))
          problems.push(`${at}.reviews[${j}]：scan_accepted 每条要有 rule / path / match / reason`)
    }
  }
  return problems
}

/**
 * 打包计划：每一条该不该打、为什么。`skills` 是 `@agentsws/skills` 的模块（`loadSkills()`）。
 * 回 `{ ready: [{ entry, meta, dir }], skipped: [{ id, why }] }`。
 */
export function planPack(ledger, { root = REPO_ROOT, skills }) {
  const ready = []
  const skipped = []
  for (const it of ledger.items) {
    const dir = join(root, it.path)
    if (!existsSync(dir)) {
      skipped.push({
        id: it.id,
        why: isStr(it.pending_merge) ? `还在 ${it.pending_merge} 的分支上` : `目录不在：${it.path}`,
      })
      continue
    }
    if (it.kind !== 'skill') {
      skipped.push({ id: it.id, why: `${it.kind} 类条目用户端还不支持（docs/90 §3.2），先不打` })
      continue
    }
    let files
    let bytes
    try {
      ;({ files, bytes } = skills.readContentDir(dir))
    } catch (e) {
      skipped.push({ id: it.id, why: `目录里有不该有的文件：${e.message}` })
      continue
    }
    const digest = skills.contentItemDigest(files)
    const name = it.id.slice(it.id.indexOf(':') + 1)
    const version = skills.bundledSkillVersion(skills.readBundledSkill(name, dirname(dir)).markdown)
    const review = it.reviews.at(-1)
    if (review === undefined) {
      skipped.push({ id: it.id, why: '还没审过' })
      continue
    }
    if (review.sha256 !== digest) {
      skipped.push({
        id: it.id,
        why: `审完之后目录又改过（审的是 ${review.sha256.slice(0, 12)}…，现在是 ${digest.slice(0, 12)}…）`,
      })
      continue
    }
    if (review.version !== version) {
      skipped.push({
        id: it.id,
        why: `审核记录的版本 ${review.version} 与目录里的 ${version} 对不上`,
      })
      continue
    }
    const hits = skills.scanContentFiles(bytes)
    const open = skills.unacceptedScanHits(hits, review.scan_accepted ?? [])
    if (open.length > 0) {
      skipped.push({
        id: it.id,
        why: `可疑指令扫描有 ${open.length} 处没放行：${open.map((h) => `${h.rule}@${h.path}:${h.line}`).join('、')}`,
      })
      continue
    }
    ready.push({
      entry: it,
      dir,
      meta: {
        id: it.id,
        kind: it.kind,
        name,
        version,
        title: it.title,
        summary: review.summary,
        upstream: {
          id: it.upstream_id,
          repo: review.upstream.repo,
          ...(isStr(review.upstream.tag) ? { tag: review.upstream.tag } : {}),
          commit: review.upstream.commit,
          published_at: review.upstream.published_at,
          license: review.license.after,
        },
        review: {
          reviewer: review.reviewer,
          reviewed_at: review.reviewed_at,
          license_before: review.license.before,
          license_after: review.license.after,
          scan_hits: hits.length,
          scan_rules: [...new Set(hits.map((h) => h.rule))].sort(),
          notes_ok: review.notes_ok === true,
          tests_ok: review.tests_ok === true,
          ...(isStr(review.proposal) ? { proposal: review.proposal } : {}),
        },
        ...(Array.isArray(it.platforms) && it.platforms.length > 0
          ? { platforms: it.platforms }
          : {}),
        ...(isStr(it.min_app_version) ? { min_app_version: it.min_app_version } : {}),
      },
    })
  }
  return { ready, skipped }
}

/** 作业摘要（`$GITHUB_STEP_SUMMARY`）。 */
export function renderPlan(plan, manifest) {
  const lines = ['## 内容包', '']
  if (manifest !== undefined)
    lines.push(
      `渠道 \`${manifest.channel}\` · 序号 ${manifest.serial} · 钥匙 \`${manifest.key_id}\``,
      '',
    )
  lines.push('| 条目 | 版本 | 结果 |', '|---|---|---|')
  for (const r of plan.ready)
    lines.push(
      `| ${r.meta.id} | ${r.meta.version} | 打进包（${r.meta.review.reviewer} ${r.meta.review.reviewed_at} 审）|`,
    )
  for (const s of plan.skipped) lines.push(`| ${s.id} | — | 没打：${s.why} |`)
  if (plan.ready.length === 0) lines.push('', '没有审过的条目，这一趟不出包。')
  return `${lines.join('\n')}\n`
}

/** 包写到哪：R2 布局（`<渠道>/blobs/<sha>`）与 GitHub Release 平铺布局（`blob-<sha>`）。 */
export function packLayout(built) {
  const out = []
  const ch = built.manifest.channel
  out.push({
    r2: `${ch}/content-manifest.json`,
    gh: 'content-manifest.json',
    bytes: built.manifestBytes,
  })
  out.push({
    r2: `${ch}/content-manifest.json.sig`,
    gh: 'content-manifest.json.sig',
    bytes: Buffer.from(built.signature),
  })
  for (const [sha, b] of built.blobs)
    out.push({ r2: `${ch}/blobs/${sha}`, gh: `blob-${sha}`, bytes: b })
  return out
}

// ---------- 提案（上游例程发现新版 → 待审升级） ----------

function licenseOf(files, skills) {
  const lic = files.get('LICENSE')
  if (lic !== undefined) {
    const head =
      lic
        .toString('utf8')
        .split('\n')
        .find((l) => l.trim() !== '') ?? ''
    return head.trim()
  }
  const md = files.get('SKILL.md')
  if (md === undefined) return '（没有 LICENSE 文件）'
  try {
    return (
      skills.splitFrontmatter(md.toString('utf8')).frontmatter.extra.license ??
      '（frontmatter 没写）'
    )
  } catch {
    return '（读不出）'
  }
}

/**
 * 待审升级提案（markdown）：文件级改动 + 正文按段 diff + 许可证对比 + 可疑指令扫描 + 分界线检查 +
 * 审核清单 + 一条审核记录草稿（审核人照着填进登记表）。
 */
export function renderProposal({ id, fromDir, toDir, skills, upstream = {}, at }) {
  const read = (dir) => {
    try {
      return { ...skills.readContentDir(dir), problem: undefined }
    } catch (e) {
      return { files: [], bytes: new Map(), problem: e.message }
    }
  }
  const before = read(fromDir)
  const after = read(toDir)
  const changes = []
  const was = new Map(before.files.map((f) => [f.path, f]))
  for (const f of after.files) {
    const old = was.get(f.path)
    if (old === undefined) changes.push(`| 新加 | \`${f.path}\` | ${f.size} B |`)
    else if (old.sha256 !== f.sha256)
      changes.push(`| 改了 | \`${f.path}\` | ${old.size} → ${f.size} B |`)
    was.delete(f.path)
  }
  for (const f of was.values()) changes.push(`| 删了 | \`${f.path}\` | ${f.size} B |`)
  const licBefore = licenseOf(before.bytes, skills)
  const licAfter = licenseOf(after.bytes, skills)
  const hits = skills.scanContentFiles(after.bytes)
  const sections = skills.diffSkillMarkdown(
    before.bytes.get('SKILL.md')?.toString('utf8'),
    after.bytes.get('SKILL.md')?.toString('utf8') ?? '',
  )
  const digest =
    after.files.length > 0 ? skills.contentItemDigest(after.files) : '（目录不合规，算不出）'
  const L = []
  L.push(`# 待审升级：${id}`, '')
  L.push(
    `- 上游：${upstream.repo ?? '—'} ${upstream.tag ?? ''} \`${upstream.commit ?? '—'}\`（${upstream.published_at ?? '日期待填'}）`,
  )
  L.push(`- 生成于：${at ?? new Date().toISOString()}`)
  L.push(`- 新目录的条目摘要：\`${digest}\``, '')
  L.push('## 许可证', '')
  L.push(
    licBefore === licAfter
      ? `没变：${licAfter}`
      : `【标红】变了：「${licBefore}」→「${licAfter}」——先确认还能不能原样分发（不能就改成首次使用时下载，docs/90 §9）`,
    '',
  )
  L.push('## 可疑指令扫描', '')
  if (hits.length === 0) L.push('没有命中。', '')
  else {
    L.push(
      `【标红】命中 ${hits.length} 处，**不自动通过**：逐条看，确属误报的写进审核记录的 \`scan_accepted\`（规则 + 文件 + 命中原文 + 理由）。`,
      '',
    )
    L.push('| 规则 | 类别 | 位置 | 命中原文 |', '|---|---|---|---|')
    for (const h of hits)
      L.push(
        `| ${h.rule} | ${h.label} | \`${h.path}:${h.line}\` | ${h.match.replace(/\|/g, '\\|')} |`,
      )
    L.push('')
  }
  L.push('## 分界线（内容包里只许声明式文件）', '')
  L.push(
    after.problem === undefined
      ? '过了：新目录里只有说明文字类文件。'
      : `【标红】${after.problem}——这些文件不能进内容包（改到程序的跟软件版本走）`,
    '',
  )
  L.push('## 文件', '')
  if (changes.length === 0) L.push('文件没有变化。', '')
  else L.push('| 改动 | 文件 | 大小 |', '|---|---|---|', ...changes, '')
  L.push('## 正文按段', '')
  if (sections.length === 0) L.push('SKILL.md 正文没有变化。', '')
  for (const s of sections) {
    L.push(
      `### ${s.change === 'added' ? '新加' : s.change === 'removed' ? '删了' : '改了'}：${s.heading || '开头'}`,
      '',
    )
    if (s.before !== undefined) L.push('原来：', '', '```', s.before, '```', '')
    if (s.after !== undefined) L.push('新版：', '', '```', s.after, '```', '')
  }
  L.push('## 审核清单（docs/42「内容更新」）', '')
  L.push('- [ ] 许可证没变（变了：写 license_note，能不能原样分发）')
  L.push('- [ ] 可疑指令：没有命中，或每一条都写了放行理由')
  L.push('- [ ] 我们的旁注（AGENTSWS.md / 改写规矩）仍对得上，新正文没有跟它打架的地方')
  L.push('- [ ] 测试与模拟全过（`scripts/verify-changed.sh` + fast 模拟三包 stub）')
  L.push('- [ ] 版本号已改，登记表加了下面这条审核记录', '')
  L.push('## 审核记录草稿（审完填进 `content-reviews.json` 对应条目的 `reviews` 末尾）', '')
  L.push('```json')
  L.push(
    JSON.stringify(
      {
        version: '<目录里的新版本号>',
        sha256: digest,
        reviewer: '<审核人>',
        reviewed_at: '<YYYY-MM-DD>',
        upstream: {
          repo: upstream.repo ?? '',
          tag: upstream.tag ?? '',
          commit: upstream.commit ?? '',
          published_at: upstream.published_at ?? '',
        },
        license: { before: licBefore, after: licAfter },
        notes_ok: false,
        tests_ok: false,
        scan_accepted: hits.map((h) => ({
          rule: h.rule,
          path: h.path,
          match: h.match,
          reason: '<为什么放行>',
        })),
        summary: { zh: '<一句改了什么>', en: '<one line>' },
        proposal: `docs/upstream/proposals/<文件名>.md`,
      },
      null,
      2,
    ),
  )
  L.push('```', '')
  return {
    markdown: `${L.join('\n')}\n`,
    hits,
    licenseChanged: licBefore !== licAfter,
    digest,
    boundaryProblem: after.problem,
  }
}
