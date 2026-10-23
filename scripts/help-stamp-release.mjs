#!/usr/bin/env node
/**
 * 教程上官网（私有 docs/113 §4.4）：发版前把教程头上的 `requires: next` 换成这一版的版本号。
 *
 * 开发单写「还没发版的功能」的教程时，头上写 `requires: next`：官网先不换（用上一个正式版时的文字），
 * 软件也知道「这台还没有」。打 tag 之前跑一次：
 *
 *   node scripts/help-stamp-release.mjs 0.2.1-beta.9
 *
 * 只改 `docs/help/*.md` 里那一行，别的一个字不动；回改了哪些文件。忘了跑也不坏事：官网会把 `next`
 * 当成「最新正式版起有」，只是版本号可能偏新一点。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/u
const NEXT_LINE = /^(---\r?\n(?:[\s\S]*?\r?\n)?)requires:[ \t]*['"]?next['"]?[ \t]*(\r?\n)/u

/** 一篇的原文 → 换好的原文（没有 `requires: next` 原样回）。 */
export function stampText(text, version) {
  const fm = /^---\r?\n[\s\S]*?\r?\n---/u.exec(text)
  if (fm === null) return text
  const head = fm[0]
  const stamped = `${head}\n`.replace(NEXT_LINE, `$1requires: ${version}$2`).slice(0, -1)
  return stamped === head ? text : stamped + text.slice(head.length)
}

/** 改 `dir` 下全部 `.md`；回改了的文件名。 */
export function stampDir(dir, version) {
  if (!VERSION.test(version)) throw new Error(`版本号不像 主.次.修订[-预发布]：${version}`)
  const changed = []
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.md'))
    .sort()) {
    const path = join(dir, f)
    const text = readFileSync(path, 'utf8')
    const next = stampText(text, version)
    if (next !== text) {
      writeFileSync(path, next)
      changed.push(f)
    }
  }
  return changed
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const version = (process.argv[2] ?? '').replace(/^v/u, '')
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'help')
  try {
    const changed = stampDir(dir, version)
    console.log(
      changed.length === 0
        ? '没有写着 requires: next 的教程'
        : `改成 requires: ${version}：\n${changed.map((f) => `  docs/help/${f}`).join('\n')}`,
    )
  } catch (e) {
    console.error(e instanceof Error ? e.message : e)
    process.exit(1)
  }
}
