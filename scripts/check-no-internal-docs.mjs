#!/usr/bin/env node
/**
 * WP383（Luoye 10-18）：**公开仓只放代码**。内部讨论、决策、派工单与报告、开发日志、
 * 编号的设计 / 调研文档、审稿截图都在私有仓 `agentsws-internal`，这里不许再出现。
 *
 * 查的是 git 索引里的路径（`git ls-files`：已提交的 + 已 `git add` 的），所以
 * 「误 add 了一份报告」在合并前就会红。历史不改写——只管从现在起不再发布。
 *
 * `docs/` 是**白名单**：只有下面 `PUBLIC_DOCS` 里的能进；其余一律算内部。
 * 要新加一份对外文档（给贡献者的规范、帮助文章），先确认里面没有业务讨论、客户名、
 * 价目、决策过程，再把路径加进白名单。拿不准就放私有仓。
 *
 * 第二道：**客户名**。真实客户 / 品牌名不许出现在公开仓的任何文件里（测试夹具用虚构品牌）。
 * 名单本身也不能公开，所以不写在这里：按下面的顺序找，找不到就跳过这一道（只提示一句）——
 *   1. 环境变量 `AGENTSWS_FORBIDDEN_NAMES`（CI 里从仓库 secret 注入，一行一条）；
 *   2. 环境变量 `AGENTSWS_FORBIDDEN_NAMES_FILE` 指的文件；
 *   3. 维护者本机的私有仓 `~/Documents/agentsws-internal/guards/forbidden-names.txt`。
 * 名单一行一条正则（`#` 开头是注释）；默认区分大小写，行首写 `(?i)` 就不分。
 * 命中时只报「文件:行 · 名单第几条」，**不回显名单内容**（CI 日志是公开的）。
 *
 * 用法：node scripts/check-no-internal-docs.mjs        （有违规退出码 1）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `docs/` 下允许公开的路径（正则，整条路径匹配）。 */
export const PUBLIC_DOCS = [
  /^docs\/README\.md$/u, // 公开文档索引
  /^docs\/ARCHITECTURE\.md$/u, // 给外部贡献者的英文架构说明
  /^docs\/telemetry-events\.md$/u, // WP476：匿名使用数据的事件清单（给贡献者与想核对的用户；测试核它与代码对得上）
  /^docs\/help\/[^/]+\.md$/u, // 用户帮助：工作台右栏与官网 /docs 在构建 / 运行时读
  /^docs\/assets\/brand\/[^/]+$/u, // 品牌标记：README 门面用，packages/brand 的测试逐字节核
  /^docs\/assets\/架构图-0[1-3]-[^/]+\.png$/u, // README 与 ARCHITECTURE 引用的三张架构图
]

/** 整个仓库任何位置都不许出现的（不只 docs/）。 */
const FORBIDDEN_ANYWHERE = [
  { re: /(^|\/)DECISIONS\.md$/u, why: '决策总表在私有仓' },
  { re: /(^|\/)REPORT\.md$/u, why: '实现报告写进私有仓 docs/briefs/reports/' },
]

/** 给出路径清单，返回违规项 `{ path, why }[]`。纯函数，测试直接调。 */
export function findInternalDocPaths(paths) {
  const out = []
  for (const path of paths) {
    const hit = FORBIDDEN_ANYWHERE.find((f) => f.re.test(path))
    if (hit) {
      out.push({ path, why: hit.why })
      continue
    }
    if (!path.startsWith('docs/')) continue
    if (PUBLIC_DOCS.some((re) => re.test(path))) continue
    out.push({ path, why: whyInternal(path) })
  }
  return out
}

function whyInternal(path) {
  if (path.startsWith('docs/briefs/')) return '派工单与报告在私有仓'
  if (/^docs\/35[^/]*$/u.test(path)) return '开发日志在私有仓'
  if (/^docs\/\d+[^/]*$/u.test(path)) return '编号的讨论 / 设计文档在私有仓（要公开须加进白名单）'
  if (path.startsWith('docs/assets/')) return '报告与内部文档的截图在私有仓'
  return 'docs/ 下不在公开白名单里'
}

/** 名单文本 → 正则数组。空行与 `#` 开头的行跳过；行首 `(?i)` = 不分大小写。 */
export function parseNameList(text) {
  const out = []
  const lines = text.split(/\r?\n/u)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '' || line.startsWith('#')) continue
    const ci = line.startsWith('(?i)')
    try {
      out.push(new RegExp(ci ? line.slice(4) : line, ci ? 'iu' : 'u'))
    } catch {
      // 不回显那一行（名单不公开），只说第几行
      throw new Error(`客户名名单第 ${i + 1} 行不是合法的正则`)
    }
  }
  return out
}

/** 按「环境变量 → 环境变量指的文件 → 本机私有仓」的顺序找名单；都没有回 `null`。 */
export function loadNameList(env = process.env, home = homedir()) {
  if (env.AGENTSWS_FORBIDDEN_NAMES?.trim()) {
    return {
      source: '环境变量 AGENTSWS_FORBIDDEN_NAMES',
      patterns: parseNameList(env.AGENTSWS_FORBIDDEN_NAMES),
    }
  }
  const candidates = [
    env.AGENTSWS_FORBIDDEN_NAMES_FILE,
    join(home, 'Documents', 'agentsws-internal', 'guards', 'forbidden-names.txt'),
  ].filter(Boolean)
  for (const file of candidates) {
    if (existsSync(file))
      return { source: file, patterns: parseNameList(readFileSync(file, 'utf8')) }
  }
  return null
}

/**
 * 给出 `{ path, text }[]` 与名单，返回命中 `{ path, line, entry }[]`（`entry` 从 1 数）。
 * 纯函数，测试直接调。一行命中多条只记第一条。
 */
export function findForbiddenNames(files, patterns) {
  const out = []
  for (const { path, text } of files) {
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const at = patterns.findIndex((re) => re.test(lines[i]))
      if (at >= 0) out.push({ path, line: i + 1, entry: at + 1 })
    }
  }
  return out
}

/** 名单检查不看的文件：锁文件（全是哈希）、太大的、二进制的。 */
const NAME_SCAN_SKIP = [/(^|\/)pnpm-lock\.yaml$/u]
const NAME_SCAN_MAX_BYTES = 2 * 1024 * 1024

function readTextFiles(root, paths) {
  const out = []
  for (const path of paths) {
    if (NAME_SCAN_SKIP.some((re) => re.test(path))) continue
    const abs = join(root, path)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue // 索引里有、工作区里删了
    }
    if (!st.isFile() || st.size > NAME_SCAN_MAX_BYTES) continue
    const buf = readFileSync(abs)
    if (buf.subarray(0, 8000).includes(0)) continue // 二进制
    out.push({ path, text: buf.toString('utf8') })
  }
  return out
}

function trackedPaths(cwd) {
  return execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((p) => p !== '')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const bad = findInternalDocPaths(trackedPaths(root))
  if (bad.length === 0) {
    console.log('✓ 公开仓里没有内部文档（docs/ 白名单之外、DECISIONS.md、REPORT.md）')
  } else {
    console.error(`✗ 公开仓里出现了 ${bad.length} 个内部文档路径（应放私有仓 agentsws-internal）：`)
    for (const b of bad.slice(0, 50)) console.error(`  ${b.path} — ${b.why}`)
    if (bad.length > 50) console.error(`  …另有 ${bad.length - 50} 个`)
    console.error(
      '  处理：git rm --cached <路径>，内容拷到 ~/Documents/agentsws-internal 的同一路径后在那边提交。',
    )
    process.exit(1)
  }

  const list = loadNameList()
  if (!list) {
    console.log('· 客户名检查跳过：没有名单（CI 里由 secret AGENTSWS_FORBIDDEN_NAMES 提供）')
  } else {
    const hits = findForbiddenNames(readTextFiles(root, trackedPaths(root)), list.patterns)
    if (hits.length === 0) {
      console.log(`✓ 公开仓里没有名单上的客户名（${list.patterns.length} 条）`)
    } else {
      console.error(
        `✗ 公开仓里出现了 ${hits.length} 处名单上的客户名（真实客户 / 品牌名一律换成虚构品牌）：`,
      )
      for (const h of hits.slice(0, 50))
        console.error(`  ${h.path}:${h.line} — 名单第 ${h.entry} 条`)
      if (hits.length > 50) console.error(`  …另有 ${hits.length - 50} 处`)
      process.exit(1)
    }
  }
}
