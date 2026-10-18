/**
 * WP383：公开仓不收内部文档的守卫。纯函数用例 + 对当前仓库真跑一遍。
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  findForbiddenNames,
  findInternalDocPaths,
  loadNameList,
  parseNameList,
} from './check-no-internal-docs.mjs'

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

  // WP400：客户名名单（这里只用虚构名；真名单在私有仓 / CI secret，不进公开仓）
  it('名单解析：跳过空行与注释，(?i) 不分大小写，默认区分', () => {
    const [a, b, c] = parseNameList('# 注释\n\nZORB\n(?i)glim ?tek\n(?<![a-z])zorb\n')
    expect(a.test('ZORB Air')).toBe(true)
    expect(a.test('zorb')).toBe(false)
    expect(b.test('GlimTek store')).toBe(true)
    expect(b.test('glim tek')).toBe(true)
    expect(c.test('ws_zorb')).toBe(true)
    expect(c.test('rhezorbile')).toBe(false)
  })

  it('命中只报文件、行号与名单第几条（不回显名单内容）', () => {
    const patterns = parseNameList('ZORB\n(?i)glimtek')
    const hits = findForbiddenNames(
      [
        { path: 'a.ts', text: 'const x = 1\nconst brand = "ZORB"\n' },
        { path: 'b.md', text: 'hello GLIMTEK\nZORB and glimtek\n' },
        { path: 'c.ts', text: 'nothing here' },
      ],
      patterns,
    )
    expect(hits).toEqual([
      { path: 'a.ts', line: 2, entry: 1 },
      { path: 'b.md', line: 1, entry: 2 },
      { path: 'b.md', line: 2, entry: 1 },
    ])
  })

  it('名单来源：环境变量优先，其次环境变量指的文件，再其次本机私有仓；都没有就跳过', () => {
    expect(
      loadNameList({ AGENTSWS_FORBIDDEN_NAMES: 'ZORB\nGLIM' }, '/nowhere')?.patterns,
    ).toHaveLength(2)
    expect(loadNameList({ AGENTSWS_FORBIDDEN_NAMES: '  ' }, '/nowhere')).toBeNull()
    expect(loadNameList({ AGENTSWS_FORBIDDEN_NAMES_FILE: '/nowhere/x.txt' }, '/nowhere')).toBeNull()
    const dir = mkdtempSync(join(tmpdir(), 'wp400-names-'))
    try {
      const file = join(dir, 'names.txt')
      writeFileSync(file, '# x\nZORB\n')
      const fromFile = loadNameList({ AGENTSWS_FORBIDDEN_NAMES_FILE: file }, '/nowhere')
      expect(fromFile?.source).toBe(file)
      expect(fromFile?.patterns).toHaveLength(1)
      // 本机私有仓那一档：home 下的固定路径
      const home = join(dir, 'home')
      const priv = join(home, 'Documents', 'agentsws-internal', 'guards')
      execFileSync('mkdir', ['-p', priv])
      writeFileSync(join(priv, 'forbidden-names.txt'), 'ZORB\nGLIM\nTEK\n')
      expect(loadNameList({}, home)?.patterns).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('名单里有坏正则：报第几行，不回显内容', () => {
    expect(() => parseNameList('ZORB\n(unclosed')).toThrow('第 2 行')
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
