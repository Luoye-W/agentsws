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
 * 用法：node scripts/check-no-internal-docs.mjs        （有违规退出码 1）
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** `docs/` 下允许公开的路径（正则，整条路径匹配）。 */
export const PUBLIC_DOCS = [
  /^docs\/README\.md$/u, // 公开文档索引
  /^docs\/ARCHITECTURE\.md$/u, // 给外部贡献者的英文架构说明
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
}
