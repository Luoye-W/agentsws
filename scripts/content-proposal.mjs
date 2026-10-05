#!/usr/bin/env node
/**
 * WP219（docs/42「内容更新」、docs/90 §7）：上游例程发现随软件带的第三方内容有新版之后，
 * 生成一份**待审升级提案**——diff + 许可证对比 + 可疑指令扫描 + 分界线检查 + 审核记录草稿。
 *
 * ```
 * # 已经把候选新版放在一个目录里（改写类技能：人把上游改动移植进来之后）
 * node scripts/content-proposal.mjs --item skill:cold-email --to /tmp/cold-email-new \
 *   --repo coreyhaines31/marketingskills --commit <sha> --published-at 2026-10-02 \
 *   [--out docs/upstream/proposals/2026-10-05-cold-email.md]
 *
 * # 官方原样收录的（目录里有 agentsws.json，WP216）：按旁注把官方文件下到临时目录再比（要出网）
 * node scripts/content-proposal.mjs --item skill:shopify --fetch --ref v2.2.0 [--published-at …]
 *
 * # 每周例程（.github/workflows/upstream-watch.yml）：所有官方原样收录的条目，上游有新 release 就各出一份
 * node scripts/content-proposal.mjs --all-official --out-dir out/content-proposals
 * ```
 *
 * 只出提案、不改仓库里的技能目录、不改登记表；有命中 / 许可证变了 / 有脚本文件时**标红**，退出码 3
 * （例程据此不把它当「可直接合」的提案）。要先 `pnpm exec tsc -b`。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSkills, REPO_ROOT, readLedger, renderProposal } from './content-pack-lib.mjs'

function arg(args, name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

/** 官方原样收录的技能：照 `agentsws.json` 把官方那几个文件下到一个临时目录（我们的旁注照抄过去）。 */
export async function fetchOfficial(itemDir, ref, fetchImpl = fetch) {
  const meta = JSON.parse(readFileSync(join(itemDir, 'agentsws.json'), 'utf8'))
  const { repo, path } = meta.upstream
  const out = mkdtempSync(join(tmpdir(), 'agentsws-proposal-'))
  const target = join(out, 'candidate')
  cpSync(itemDir, target, { recursive: true })
  const files = ['SKILL.md', ...meta.references, 'LICENSE']
  const sha = {}
  for (const f of files) {
    const url =
      f === 'LICENSE'
        ? `https://raw.githubusercontent.com/${repo}/${ref}/LICENSE`
        : `https://raw.githubusercontent.com/${repo}/${ref}/${path}/${f}`
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`下不到 ${url}（HTTP ${res.status}）`)
    const bytes = Buffer.from(await res.arrayBuffer())
    mkdirSync(dirname(join(target, f)), { recursive: true })
    writeFileSync(join(target, f), bytes)
    sha[f] = createHash('sha256').update(bytes).digest('hex')
  }
  return { dir: target, repo, sha }
}

/** 上游最新的正式 release 的 tag（GitHub API；没有就 `undefined`）。 */
async function latestReleaseTag(repo, token, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      accept: 'application/vnd.github+json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (!res.ok) return undefined
  return (await res.json()).tag_name
}

/**
 * 每周例程用：登记表里**官方原样收录**的条目（目录里有 `agentsws.json`），上游出了新 release 就各出一份提案
 * 到 `--out-dir`。没有新版的不出。回退出码：有标红的 3，否则 0。
 */
async function allOfficial(argv, root) {
  const outDir = resolve(root, arg(argv, '--out-dir', 'out/content-proposals'))
  const skills = await loadSkills()
  let red = false
  for (const entry of readLedger(root).items) {
    const dir = join(root, entry.path)
    if (!existsSync(join(dir, 'agentsws.json'))) continue
    const meta = JSON.parse(readFileSync(join(dir, 'agentsws.json'), 'utf8'))
    const tag = await latestReleaseTag(meta.upstream.repo, process.env.GITHUB_TOKEN)
    if (tag === undefined || tag === meta.upstream.tag) {
      process.stdout.write(`${entry.id}：上游没有新 release（锁的是 ${meta.upstream.tag}）\n`)
      continue
    }
    const got = await fetchOfficial(dir, tag)
    const p = renderProposal({
      id: entry.id,
      fromDir: dir,
      toDir: got.dir,
      skills,
      upstream: { repo: got.repo, tag, commit: tag },
    })
    mkdirSync(outDir, { recursive: true })
    const file = join(
      outDir,
      `${new Date().toISOString().slice(0, 10)}-${entry.id.replace(':', '-')}-${tag}.md`,
    )
    writeFileSync(
      file,
      `${p.markdown}\n## 旁注要改的 sha256（\`agentsws.json\`）\n\n\`\`\`json\n${JSON.stringify(got.sha, null, 2)}\n\`\`\`\n`,
    )
    process.stdout.write(`${entry.id}：${meta.upstream.tag} → ${tag}，提案写到 ${file}\n`)
    red ||= p.hits.length > 0 || p.licenseChanged || p.boundaryProblem !== undefined
  }
  return red ? 3 : 0
}

export async function run(argv = process.argv.slice(2), root = REPO_ROOT) {
  if (argv.includes('--all-official')) return allOfficial(argv, root)
  const id = arg(argv, '--item', '')
  const ledger = readLedger(root)
  const entry = ledger.items.find((i) => i.id === id)
  if (entry === undefined) throw new Error(`登记表里没有 ${id}（content-reviews.json）`)
  const fromDir = resolve(root, arg(argv, '--from', entry.path))
  const skills = await loadSkills()
  let toDir = arg(argv, '--to', '')
  let repo = arg(argv, '--repo', '')
  let extra = ''
  if (argv.includes('--fetch')) {
    const ref = arg(argv, '--ref', '')
    if (ref === '') throw new Error('--fetch 要配 --ref <tag 或提交>')
    if (!existsSync(join(fromDir, 'agentsws.json')))
      throw new Error(`${entry.path} 不是官方原样收录的技能（没有 agentsws.json）`)
    const got = await fetchOfficial(fromDir, ref)
    toDir = got.dir
    repo = got.repo
    extra = `\n## 旁注要改的 sha256（\`agentsws.json\`）\n\n\`\`\`json\n${JSON.stringify(got.sha, null, 2)}\n\`\`\`\n`
  }
  if (toDir === '') throw new Error('要给 --to <候选新版目录>，或 --fetch --ref <tag>')
  const ref = arg(argv, '--ref', '')
  const proposal = renderProposal({
    id,
    fromDir,
    toDir: resolve(toDir),
    skills,
    upstream: {
      repo: repo === '' ? undefined : repo,
      tag: ref === '' ? undefined : ref,
      commit: arg(argv, '--commit', ref === '' ? undefined : ref),
      published_at: arg(argv, '--published-at', undefined),
    },
  })
  const text = proposal.markdown + extra
  const out = arg(argv, '--out', '')
  if (out === '') process.stdout.write(text)
  else {
    mkdirSync(dirname(resolve(root, out)), { recursive: true })
    writeFileSync(resolve(root, out), text)
    process.stdout.write(`提案写到 ${out}\n`)
  }
  const red =
    proposal.hits.length > 0 || proposal.licenseChanged || proposal.boundaryProblem !== undefined
  if (red)
    process.stderr.write('【标红】有扫描命中 / 许可证变化 / 不该有的文件：不自动通过，要人逐条看\n')
  return red ? 3 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`)
      process.exit(1)
    },
  )
}
