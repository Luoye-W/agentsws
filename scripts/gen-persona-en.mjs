#!/usr/bin/env node
/**
 * WP226（docs/69 §1.1）：**英文 persona 由中文翻译生成**，产物签进仓库。
 *
 * Luoye 10-05 定：岗位 / 职责的 persona 只手写中文；英文用翻译自动生成，不再手工维护
 * （两份手工维护出过事：docs/91 §3.3，14 条英文 persona 混着中文）。
 *
 * 产物：`packages/roles/persona-en.generated.json`，每条带**翻译时那份中文的哈希**。
 * 读职责时哈希对得上才用这份英文（`packages/roles/src/persona-en.ts`）。
 *
 * 用法（先 `pnpm exec tsc -b`，要读 `packages/roles/dist` 与 `packages/simulation/dist`）：
 *
 *   node scripts/gen-persona-en.mjs              缺的、过期的、不合格的逐条调模型翻，多出来的删掉
 *   node scripts/gen-persona-en.mjs --all        全部重翻
 *   node scripts/gen-persona-en.mjs --check      只比哈希、不调模型；有问题打警告（退出码 0）
 *   node scripts/gen-persona-en.mjs --check --strict   同上，有问题退出码 1
 *   node scripts/gen-persona-en.mjs --export out.json [--all]   把要翻的中文导出成 { key: 中文 }
 *   node scripts/gen-persona-en.mjs --import in.json            把 { key: 英文 } 写进产物（逐条校验）
 *
 * **key 只从环境变量来**，与 realistic 档模拟同一套（`resolveSimModel`）：`DEEPSEEK_API_KEY`，
 * 或 `AGENTSWS_SIM_MODEL_PROVIDER` / `AGENTSWS_SIM_MODEL_API_KEY`（百炼等）。脚本**不读任何
 * `.env*` 文件**、不打印 key、不把 key 写进任何地方。
 *
 * `--export` / `--import` 给没有 key 的时候用（换一个翻译工具翻好再导回来）：导回时一样逐条查
 * 「没有汉字、六个英文小标题都在」，哈希按**导入那一刻**的中文算——所以导出之后中文又改了，
 * 导回来的那条照样会被 `--check` 判成过期。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const argOf = (flag) => {
  const i = args.indexOf(flag)
  return i < 0 ? undefined : args[i + 1]
}

const need = (p) => {
  if (existsSync(join(ROOT, p))) return pathToFileURL(join(ROOT, p)).href
  process.stderr.write(`gen-persona-en: 先跑 \`pnpm exec tsc -b\`（要读 ${p}）\n`)
  process.exit(70)
}

const roles = await import(need('packages/roles/dist/index.js'))
const {
  checkGeneratedPersonaEn,
  checkPersonaEn,
  loadBundledPositions,
  loadBundledRoles,
  loadGeneratedPersonaEn,
  PERSONA_EN_FILE,
  PERSONA_SECTIONS_EN,
  PERSONA_SECTIONS_ZH,
  personaKey,
  personaZhHash,
  personaZhSource,
} = roles

/** 包里全部岗位与职责（按 key 排序）。 */
const positions = loadBundledPositions()
const allRoles = loadBundledRoles()
const subjects = [
  ...positions.map((p) => ({ subject: { kind: 'position', id: p.id }, persona: p.persona })),
  ...allRoles.map((r) => ({ subject: { kind: 'role', id: r.id }, persona: r.persona })),
]
const zhByKey = new Map()
for (const s of subjects) {
  const zh = personaZhSource(s.persona)
  if (zh !== '') zhByKey.set(personaKey(s.subject), zh)
}

const generated = loadGeneratedPersonaEn(PERSONA_EN_FILE)
const problems = checkPersonaEn({ subjects, generated })

/** 写产物：键排序、两格缩进、末尾换行（diff 稳定）。 */
const writeEntries = (entries) => {
  const sorted = Object.fromEntries([...entries.entries()].sort(([a], [b]) => a.localeCompare(b)))
  const file = {
    _: '由 scripts/gen-persona-en.mjs 从岗位 / 职责 yml 的中文 persona 翻译生成，别手改。中文改了就重跑（docs/69 §1.1）；--check 只比哈希。',
    entries: sorted,
  }
  writeFileSync(PERSONA_EN_FILE, `${JSON.stringify(file, null, 2)}\n`, 'utf8')
}

/* ── --check ─────────────────────────────────────────────────────────────── */
if (has('--check')) {
  if (problems.length === 0) {
    process.stdout.write(`gen-persona-en: ${zhByKey.size} 条英文 persona 都与中文对得上\n`)
    process.exit(0)
  }
  const gh = process.env.GITHUB_ACTIONS === 'true'
  process.stdout.write(
    `gen-persona-en: ${problems.length} 条英文 persona 要重出（跑 \`node scripts/gen-persona-en.mjs\`）：\n`,
  )
  for (const p of problems) {
    const line = `${p.key}：${p.message}`
    process.stdout.write(gh ? `::warning title=persona 英文过期::${line}\n` : `  - ${line}\n`)
  }
  process.exit(has('--strict') ? 1 : 0)
}

/** 这一次要翻的那几条。 */
const todo = has('--all')
  ? [...zhByKey.keys()]
  : problems.filter((p) => p.kind !== 'orphan').map((p) => p.key)

/* ── --export ────────────────────────────────────────────────────────────── */
const exportTo = argOf('--export')
if (exportTo !== undefined) {
  const out = Object.fromEntries(todo.sort().map((k) => [k, zhByKey.get(k)]))
  writeFileSync(resolve(exportTo), `${JSON.stringify(out, null, 2)}\n`, 'utf8')
  process.stdout.write(`gen-persona-en: 导出 ${todo.length} 条中文到 ${exportTo}\n`)
  process.exit(0)
}

/** 收尾：留下包里还有的那几条（多出来的删掉），合并新翻的，写盘。 */
const finish = (fresh) => {
  const entries = new Map()
  for (const [key, row] of generated) if (zhByKey.has(key)) entries.set(key, row)
  for (const [key, en] of fresh) entries.set(key, { zh_hash: personaZhHash(zhByKey.get(key)), en })
  writeEntries(entries)
  const dropped = [...generated.keys()].filter((k) => !zhByKey.has(k))
  process.stdout.write(
    `gen-persona-en: 写入 ${fresh.size} 条${dropped.length > 0 ? `，删掉 ${dropped.length} 条多余的（${dropped.join('、')}）` : ''}\n`,
  )
}

/* ── --import ────────────────────────────────────────────────────────────── */
const importFrom = argOf('--import')
if (importFrom !== undefined) {
  const raw = JSON.parse(readFileSync(resolve(importFrom), 'utf8'))
  const fresh = new Map()
  const bad = []
  for (const [key, en] of Object.entries(raw)) {
    if (!zhByKey.has(key)) {
      bad.push(`${key}：包里没有这一条`)
      continue
    }
    const text = `${en ?? ''}`.trim()
    const problem = checkGeneratedPersonaEn(text)
    if (problem !== undefined) bad.push(`${key}：${problem}`)
    else fresh.set(key, text)
  }
  if (bad.length > 0) {
    process.stderr.write(
      `gen-persona-en: 导入被拒（一条都没写）：\n${bad.map((b) => `  - ${b}`).join('\n')}\n`,
    )
    process.exit(1)
  }
  finish(fresh)
  process.exit(0)
}

/* ── 生成：调模型翻 ─────────────────────────────────────────────────────── */
if (todo.length === 0) {
  finish(new Map())
  process.exit(0)
}

const { resolveSimModel } = await import(need('packages/simulation/dist/index.js'))
const model = resolveSimModel(process.env)
if (model === undefined) {
  process.stderr.write(
    'gen-persona-en: 没有模型 key。设 DEEPSEEK_API_KEY，或 AGENTSWS_SIM_MODEL_PROVIDER + AGENTSWS_SIM_MODEL_API_KEY（与 realistic 档模拟同一套）；\n' +
      '  没有 key 也可以 --export 导出中文、换个工具翻好再 --import 导回。\n',
  )
  process.exit(2)
}
process.stdout.write(`gen-persona-en: 用 ${model.describe} 翻 ${todo.length} 条\n`)

/** 岗位名与职责名的中英对照（yml 里 `name: { zh, en }` 本来就有）——翻译要照它叫。 */
const glossary = [...positions.map((p) => p.name), ...allRoles.map((r) => r.name)]
  .filter((n) => n?.zh && n?.en && n.zh !== n.en)
  .map((n) => `${n.zh} = ${n.en}`)
const uniqueGlossary = [...new Set(glossary)].join('\n')

const headings = PERSONA_SECTIONS_ZH.map((zh, i) => `${zh} → ${PERSONA_SECTIONS_EN[i]}`).join('\n')

const SYSTEM = [
  'You translate the role description ("persona") of an AI agent at an e-commerce company from Chinese into natural, concise English.',
  'Rules:',
  `1. The text has six sections. Start each one on its own line with the exact English heading followed by ": " — map them like this:\n${headings}`,
  '2. Keep every fact, every hand-off ("X → position"), every limit. Do not add, drop, soften or explain anything.',
  `3. Use these names for positions and duties exactly as given:\n${uniqueGlossary}`,
  '4. Output English only: no Chinese characters and no full-width punctuation (use ( ) : , ; instead). Keep "→" as is.',
  '5. Output only the translated text — no preamble, no quotes, no code fences.',
].join('\n')

const fresh = new Map()
const failed = []
for (const key of todo) {
  const zh = zhByKey.get(key)
  let last = ''
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const done = await model.provider.complete({
      messages: [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content:
            attempt === 1
              ? zh
              : `${zh}\n\n(Your previous answer was rejected: ${last}. Translate again following every rule.)`,
        },
      ],
      seed: 7,
    })
    const text = `${done.text ?? ''}`.replace(/^```\w*\n?|\n?```$/g, '').trim()
    const problem = checkGeneratedPersonaEn(text)
    if (problem === undefined) {
      fresh.set(key, text)
      process.stdout.write(`  ✓ ${key}\n`)
      break
    }
    last = problem
    if (attempt === 3) failed.push(`${key}：${problem}`)
  }
}
finish(fresh)
if (failed.length > 0) {
  process.stderr.write(
    `gen-persona-en: 这几条翻了三次都不合格，没写：\n${failed.map((f) => `  - ${f}`).join('\n')}\n`,
  )
  process.exit(1)
}
