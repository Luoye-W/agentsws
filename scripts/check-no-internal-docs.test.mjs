/**
 * WP383：公开仓不收内部文档的守卫。纯函数用例 + 对当前仓库真跑一遍。
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { findInternalDocPaths } from './check-no-internal-docs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const inGit = (() => {
  try {
    execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
})()
const paths = (list) => findInternalDocPaths(list).map((b) => b.path)

describe('check-no-internal-docs', () => {
  it('公开白名单里的放行', () => {
    expect(
      paths([
        'docs/README.md',
        'docs/ARCHITECTURE.md',
        'docs/help/conn-shopify.md',
        'docs/help/conn-shopify.en.md',
        'docs/assets/brand/mark-dark.svg',
        'docs/assets/brand/README.md',
        'docs/assets/架构图-01-分层总图.png',
        'README.md',
        'CHANGELOG.md',
        'apps/site/src/assets/onboarding-roles.png',
        'packages/dsh-adapter/README.md',
      ]),
    ).toEqual([])
  })

  it('派工单、报告、决策表、开发日志、编号文档、审稿截图都拦', () => {
    const bad = [
      'docs/briefs/WP384-x.md',
      'docs/briefs/_common.md',
      'docs/briefs/reports/WP384.md',
      'docs/briefs/DECISIONS.md',
      'DECISIONS.md',
      'docs/35-开发任务拆分与派工.md',
      'docs/106-新讨论-v1.md',
      'docs/09-底层框架拆解.md',
      'docs/upstream/2026-W43.md',
      'docs/design/site/home.html',
      'docs/assets/wp384/a.png',
      'docs/assets/workstation/home.png',
      'docs/assets/walkthrough/07-ob-roles.png',
      'docs/help/sub/dir.md',
      'docs/notes.md',
      'REPORT.md',
      'apps/server/REPORT.md',
    ]
    expect(paths(bad)).toEqual(bad)
  })

  it.skipIf(!inGit)('当前仓库干净（脚本退出码 0）', () => {
    expect(() =>
      execFileSync('node', [join(ROOT, 'scripts/check-no-internal-docs.mjs')], {
        cwd: ROOT,
        stdio: 'pipe',
      }),
    ).not.toThrow()
  })
})
