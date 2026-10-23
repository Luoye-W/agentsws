#!/usr/bin/env node
/**
 * WP477（决策 1617 / 1618）：autocapture 只认「源码里写死的」`data-testid`。
 *
 * 扫 `apps/workstation/src` 里所有写 testid 的地方，生成 `packages/contracts/src/telemetry-testids.ts`：
 * - 写死的字面量（`data-testid="matter-send"`、`testId="wallet"`……）原样进**静态表**；
 * - 带变量的模板（`` data-testid={`brand-row-${id}`} ``）只留写死的那几段，变量一律换成 `:x`（`brand-row-:x`）。
 *
 * 工作台点了一个元素，它的 testid 要么在静态表里（原样发），要么套得上某个模板（发模板本身，变量那段永远不出门），
 * 两样都不是就**整条不发**。于是 testid 里就算拼进了邮箱名、表头、工作表名，出门的也只是源码里写死的那几个字。
 *
 * 用法：`node scripts/gen-telemetry-testids.mjs`（写）/ `--check`（只比对，不一致退出码 1）。
 * `packages/contracts/test/telemetry.test.ts` 也会核对一遍，忘了重生成会红。
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'apps/workstation/src')
const OUT = join(ROOT, 'packages/contracts/src/telemetry-testids.ts')

/** testid 静态部分只许这些字符（源码里的 testid 都是这样）；别的样子不收。 */
const STATIC = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/
const KEY = `(?:data-testid|testId|testid|testID|dataTestId|'data-testid'|"data-testid")`
const LITERAL = new RegExp(
  String.raw`${KEY}\s*[=:]\s*(?:\{\s*)?(?:"([^"\n]+)"|'([^'\n]+)'|\x60([^\x60\n]+)\x60)`,
  'g',
)

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) yield p
  }
}

/** 模板串 → 只留写死的段、变量换成 `:x`；写死的部分太少（只剩连字符）就不要。 */
export function templateOf(raw) {
  const parts = []
  let rest = raw
  for (;;) {
    const at = rest.indexOf('${')
    if (at < 0) {
      parts.push(rest)
      break
    }
    parts.push(rest.slice(0, at))
    // 跳过 `${…}`（表达式里可能有成对的花括号）
    let depth = 0
    let i = at + 1
    for (; i < rest.length; i++) {
      if (rest[i] === '{') depth++
      else if (rest[i] === '}' && --depth === 0) break
    }
    parts.push(':x')
    rest = rest.slice(i + 1)
  }
  const out = parts.join('').replace(/(?::x)+/g, ':x')
  const fixed = out.replaceAll(':x', '')
  if (!/[A-Za-z]{2,}/.test(fixed)) return undefined
  if (!out.split(':x').every((s) => s === '' || STATIC.test(s) || /^[._:-]+$/.test(s)))
    return undefined
  return out
}

export function collectTestids(srcDir = SRC) {
  const statics = new Set()
  const templates = new Set()
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(LITERAL)) {
      const value = m[1] ?? m[2] ?? m[3]
      if (value === undefined) continue
      if (m[3] !== undefined && value.includes('${')) {
        const t = templateOf(value)
        if (t !== undefined) templates.add(t)
      } else if (STATIC.test(value)) statics.add(value)
    }
  }
  return {
    statics: [...statics].sort(),
    // 写死的字多的排前面：越具体越先套
    templates: [...templates].sort(
      (a, b) => b.replaceAll(':x', '').length - a.replaceAll(':x', '').length || (a < b ? -1 : 1),
    ),
  }
}

export function render({ statics, templates }) {
  // 值里只有字母数字与 ._:- （见 STATIC），单引号直接包，与 biome 的格式一致
  const list = (xs) => xs.map((x) => `  '${x}',`).join('\n')
  return `/**
 * 生成的文件，别手改：\`node scripts/gen-telemetry-testids.mjs\`（WP477，决策 1617 / 1618）。
 *
 * 工作台源码里写死的 \`data-testid\`（静态表）与带变量的 testid 模板（变量换成 \`:x\`）。
 * autocapture 只发这两张表里有的东西：静态的原样发，带变量的只发模板，变量那段永远不出门。
 */
export const TELEMETRY_TESTIDS: readonly string[] = [
${list(statics)}
]

export const TELEMETRY_TESTID_TEMPLATES: readonly string[] = [
${list(templates)}
]
`
}

const isMain =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const next = render(collectTestids())
  let current = ''
  try {
    current = readFileSync(OUT, 'utf8')
  } catch {
    current = ''
  }
  if (process.argv.includes('--check')) {
    if (current !== next) {
      console.error(
        'packages/contracts/src/telemetry-testids.ts 过期了：跑 node scripts/gen-telemetry-testids.mjs',
      )
      process.exit(1)
    }
  } else if (current !== next) {
    writeFileSync(OUT, next, 'utf8')
    console.log(`写了 ${OUT}`)
  }
}
