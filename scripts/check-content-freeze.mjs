#!/usr/bin/env node
/**
 * WP404（docs/107 §11，Luoye 10-19 定）：**冻结内容守卫**。
 *
 * 10-19 起，开源仓里的岗位内容冻结成「基础版」：只收修错和社群改进，新内容进私有内容仓。
 * 这个脚本数一数这次改动里「冻结范围」动了多少行，超过 20 行就要求 PR 标 `content-fix`
 * （说明这是修错 / 社群改进，不是在开源仓里写新内容）。
 *
 * 冻结范围（照 `check-no-internal-docs.mjs` 的写法，按路径判）：
 *   - 职责 / 岗位 yml 里**内容字段**那几行（name、description、persona、quick_prompts、task_examples、
 *     grounding 的 intent_terms / cue_terms；岗位的 name、persona、roles）——骨架字段、注释、空行不算；
 *   - `packages/skills/bundled/` 下全部文件；
 *   - 外置的规则表 `packages/<包>/src/**\/*.content.json`、`packages/seo-core/src/amazon-listing-rules.json`；
 *   - 生成的英文 persona `packages/roles/persona-en.generated.json`。
 *
 * **只提醒、不拦主线修错**：默认只打印提醒、退出码 0（`verify-changed.sh` 与推到 main 的 CI 用这个）；
 * `--strict`（PR 的 CI 用）且 PR 没有 `content-fix` 标签（环境变量 `CONTENT_FIX_LABEL` 不是 `true`）时退出码 1。
 *
 * 用法：node scripts/check-content-freeze.mjs [--base <git 引用，默认 main>] [--strict]
 *   比的是「基准 → 现在的工作区」（已提交 + 未提交）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 超过这么多行就要标 `content-fix`。 */
export const FREEZE_LINE_LIMIT = 20

/** 职责 / 岗位 yml 里算内容的顶层字段（与契约 `ROLE_CONTENT_FIELDS` / `POSITION_CONTENT_FIELDS` 同一份）。 */
const ROLE_CONTENT_KEYS = ['name', 'description', 'persona', 'quick_prompts', 'task_examples']
const POSITION_CONTENT_KEYS = ['name', 'persona', 'roles']
/** `grounding` 里只有这两张词表算内容（`tool` / `prefetch` 是骨架）。 */
const GROUNDING_CONTENT_LINE = /^\s*-?\s*\{?\s*(intent_terms|cue_terms)\s*:/u

/** 一个路径属于冻结范围的哪一类：`role` / `position`（只数内容字段）、`all`（整份都数）；不在范围 → `undefined`。 */
export function frozenKindOf(path) {
  if (/^packages\/roles\/roles\/.+\.ya?ml$/u.test(path)) return 'role'
  if (/^packages\/roles\/positions\/[^/]+\.ya?ml$/u.test(path)) return 'position'
  if (path.startsWith('packages/skills/bundled/')) return 'all'
  if (/^packages\/[^/]+\/src\/.+\.content\.json$/u.test(path)) return 'all'
  if (path === 'packages/seo-core/src/amazon-listing-rules.json') return 'all'
  if (path === 'packages/roles/persona-en.generated.json') return 'all'
  return undefined
}

/**
 * yml 文本里哪几行是内容字段（行号从 1 数）。按顶层键分块：一行属于它上面最近的那个顶层键；
 * 注释与空行不算。`grounding` 块里只算 `intent_terms` / `cue_terms` 那几行。
 */
export function contentLinesOfYml(text, kind) {
  const keys = kind === 'position' ? POSITION_CONTENT_KEYS : ROLE_CONTENT_KEYS
  const out = new Set()
  let current
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const top = /^([A-Za-z_][\w-]*)\s*:/u.exec(line)
    if (top) current = top[1]
    if (line.trim() === '' || line.trim().startsWith('#')) continue
    if (current !== undefined && keys.includes(current)) out.add(i + 1)
    else if (current === 'grounding' && kind === 'role' && GROUNDING_CONTENT_LINE.test(line))
      out.add(i + 1)
  }
  return out
}

/** `git diff -U0` 的输出 → 删掉的行号（旧文件里）与加上的行号（新文件里）。 */
export function changedLineNumbers(diff) {
  const removed = []
  const added = []
  for (const line of diff.split('\n')) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line)
    if (!m) continue
    const oldStart = Number(m[1])
    const oldCount = m[2] === undefined ? 1 : Number(m[2])
    const newStart = Number(m[3])
    const newCount = m[4] === undefined ? 1 : Number(m[4])
    for (let k = 0; k < oldCount; k++) removed.push(oldStart + k)
    for (let k = 0; k < newCount; k++) added.push(newStart + k)
  }
  return { removed, added }
}

/** 一个文件这次动了多少行冻结内容。 */
export function frozenLinesChanged({ kind, diff, baseText, headText }) {
  const { removed, added } = changedLineNumbers(diff)
  if (kind === 'all') return removed.length + added.length
  const before = contentLinesOfYml(baseText ?? '', kind)
  const after = contentLinesOfYml(headText ?? '', kind)
  return removed.filter((n) => before.has(n)).length + added.filter((n) => after.has(n)).length
}

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 跑一遍：回 `{ total, files: [{ path, lines }] }`。 */
export function checkContentFreeze(root, base) {
  const changed = git(root, ['diff', '--name-only', base, '--']).split('\n').filter(Boolean)
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean)
  const files = []
  for (const path of [...new Set([...changed, ...untracked])].sort()) {
    const kind = frozenKindOf(path)
    if (kind === undefined) continue
    const abs = join(root, path)
    const headText = existsSync(abs) ? readFileSync(abs, 'utf8') : ''
    let baseText = ''
    try {
      baseText = git(root, ['show', `${base}:${path}`])
    } catch {
      baseText = '' // 新文件
    }
    const diff = changed.includes(path)
      ? git(root, ['diff', '-U0', '--no-color', base, '--', path])
      : `@@ -0,0 +1,${headText.split('\n').length - (headText.endsWith('\n') ? 1 : 0)} @@`
    const lines = frozenLinesChanged({ kind, diff, baseText, headText })
    if (lines > 0) files.push({ path, lines })
  }
  return { total: files.reduce((n, f) => n + f.lines, 0), files }
}

function main() {
  const args = process.argv.slice(2)
  const at = args.indexOf('--base')
  const base = at < 0 ? 'main' : args[at + 1]
  const strict = args.includes('--strict')
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
  let result
  try {
    result = checkContentFreeze(root, base)
  } catch (error) {
    // 基准拿不到（浅克隆、没有 main）：守卫只是提醒，不因为它让流水线红
    process.stdout.write(
      `冻结内容守卫：拿不到基准 ${base}，跳过（${error.message.split('\n')[0]}）\n`,
    )
    return
  }
  if (result.total <= FREEZE_LINE_LIMIT) {
    process.stdout.write(`✓ 冻结内容动了 ${result.total} 行（上限 ${FREEZE_LINE_LIMIT}）\n`)
    return
  }
  const labelled = process.env.CONTENT_FIX_LABEL === 'true'
  const lines = [
    `冻结内容动了 ${result.total} 行（超过 ${FREEZE_LINE_LIMIT}）：岗位内容 10-19 起只收修错和社群改进，新内容进私有内容仓。`,
    ...result.files.map((f) => `  ${f.path}：${f.lines} 行`),
    labelled
      ? '这个 PR 标了 content-fix，放行。'
      : '是修错 / 社群改进的话，给 PR 标上 content-fix；是新内容的话，挪到私有内容仓。',
  ]
  const text = lines.join('\n')
  if (process.env.GITHUB_ACTIONS === 'true')
    process.stdout.write(`::warning title=冻结内容::${text.replace(/\n/gu, '%0A')}\n`)
  process.stdout.write(`${text}\n`)
  if (strict && !labelled) process.exitCode = 1
}

if (
  process.argv[1] !== undefined &&
  realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))
)
  main()
