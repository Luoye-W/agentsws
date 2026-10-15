#!/usr/bin/env node
/**
 * WP344：上线前最后一道（先 build 再跑）。查 `dist/` 里有没有还没填的占位（`{{EFFECTIVE_DATE}}` 等），
 * 以及条款三页、价格页、页脚该有的东西在不在。只读本地文件，不打网、不部署。
 *
 *   pnpm -F @agentsws/site build && pnpm -F @agentsws/site launch:check
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIST = fileURLToPath(new URL('../dist/', import.meta.url))
const problems = []

function* html(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* html(p)
    else if (name.endsWith('.html')) yield p
  }
}

for (const f of html(DIST)) {
  const text = readFileSync(f, 'utf8')
  for (const m of text.matchAll(/\{\{([A-Z_]+)\}\}/gu))
    problems.push(`${relative(DIST, f)}：还有占位 {{${m[1]}}}`)
}

const must = {
  'terms/index.html': ['contact@agentsws.com'],
  'privacy/index.html': ['contact@agentsws.com'],
  'refund/index.html': ['contact@agentsws.com', '不退款'],
  'en/refund/index.html': ['contact@agentsws.com'],
  'index.html': ['/terms/', '/privacy/', '/refund/', 'mailto:contact@agentsws.com'],
  'en/index.html': ['/en/terms/', '/en/privacy/', '/en/refund/'],
  'pricing/index.html': ['$20', '1 积分 = ¥1'],
}
for (const [page, needles] of Object.entries(must)) {
  let text = ''
  try {
    text = readFileSync(join(DIST, page), 'utf8')
  } catch {
    problems.push(`${page}：没有这一页`)
    continue
  }
  for (const n of needles) if (!text.includes(n)) problems.push(`${page}：找不到「${n}」`)
}

if (problems.length > 0) {
  console.error(`上线检查没过（${problems.length} 处）：`)
  for (const p of [...new Set(problems)]) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('上线检查通过：没有占位，条款 / 隐私 / 退款 / 联系邮箱 / 价格都在。')
