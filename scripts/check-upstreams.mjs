#!/usr/bin/env node
/**
 * 校验 `upstreams.yml`（WP91，docs/10 §3.2）。
 *
 *   node scripts/check-upstreams.mjs            # 列出登记的上游 + 校验
 *   node scripts/check-upstreams.mjs --check    # 只报问题，有问题退 1（CI 用这个）
 *
 * 校验三件事：
 *   ① 形状：字段名、枚举值、必填、id 不重复、watch 与 npm / repo / wishlist 对得上
 *   ② 锁的版本：`locked_in` 里的 package.json、pnpm-lock.yaml 的唯一解析版本、
 *      pnpm-workspace.yaml 的 minimumReleaseAgeExclude —— 三处都要和登记表逐字一致
 *   ③ 路径：`locked_in` / `covered_by` 指到的东西真的存在
 *   ④ 镜像（WP146）：`image_in` 里每个文件对镜像的每一处引用都逐字等于
 *      `image:image_tag@image_digest`（compose 里 digest 改坏一位就红）
 *   ⑤ 二进制（WP146）：`bin_lock_file` 里钉的 cli / 插件版本与登记表一致
 *
 * 退出码：0 没问题；1 有问题；2 文件读不了 / 解析不了。
 */

import process from 'node:process'
import { checkPins, loadUpstreams, REPO_ROOT, validateShape } from './upstreams-lib.mjs'

const out = (s) => process.stdout.write(`${s}\n`)
const err = (s) => process.stderr.write(`${s}\n`)

export function run(argv = [], root = REPO_ROOT) {
  const checkOnly = argv.includes('--check')
  let items
  try {
    items = loadUpstreams(root)
  } catch (e) {
    err(`check-upstreams: 读不了 upstreams.yml —— ${e.message}`)
    return 2
  }

  const problems = [...validateShape(items), ...checkPins(items, root)]

  if (!checkOnly) {
    const byKind = new Map()
    for (const it of items) byKind.set(it.kind, [...(byKind.get(it.kind) ?? []), it])
    out(`upstreams.yml：${items.length} 个上游`)
    for (const [kind, list] of byKind) {
      out(`\n## ${kind}（${list.length}）`)
      for (const it of list) {
        const pin = it.locked_version ?? it.pinned_commit ?? '—'
        out(`  - ${it.id}  ${pin}  watch: ${(it.watch ?? []).join(',')}`)
        out(`      ${it.why}`)
      }
    }
    out('')
  }

  if (problems.length > 0) {
    err(`check-upstreams: ${problems.length} 个问题`)
    for (const p of problems) err(`  - ${p}`)
    return 1
  }
  out('check-upstreams: 登记表与仓库一致')
  return 0
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(run(process.argv.slice(2)))
}
