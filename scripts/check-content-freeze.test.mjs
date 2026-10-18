/**
 * WP404：冻结内容守卫——哪些路径算冻结、yml 只数内容字段、超过 20 行要 content-fix（只在 --strict 时拦）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  changedLineNumbers,
  checkContentFreeze,
  contentLinesOfYml,
  FREEZE_LINE_LIMIT,
  frozenKindOf,
  frozenLinesChanged,
} from './check-content-freeze.mjs'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-content-freeze.mjs')

const ROLE_YML = [
  '# 头注释',
  'id: kol.youtube',
  'version: 1.0.0',
  'name: { zh: YouTube 红人, en: YouTube Creators }',
  'description: 找人与打分',
  'scopes:',
  '  - { domain: creator, ops: [read], range: assigned, max_sensitivity: internal }',
  'grounding:',
  '  - {',
  '      name: youtube_intent,',
  '      intent_terms: [频道, 视频],',
  '      cue_terms: [粉丝],',
  '      tool: search_creators,',
  '      prefetch: false,',
  '    }',
  'quick_prompts:',
  '  - id: find_creators',
  '    # 注释不算',
  '    prompt: "找 20 个"',
  '',
  'persona:',
  '  zh: |',
  '    你是谁：红人。',
].join('\n')

describe('check-content-freeze', () => {
  it('冻结范围按路径判', () => {
    expect(frozenKindOf('packages/roles/roles/kol/youtube.yml')).toBe('role')
    expect(frozenKindOf('packages/roles/positions/kol-marketing.yml')).toBe('position')
    expect(frozenKindOf('packages/skills/bundled/shopify/SKILL.md')).toBe('all')
    expect(frozenKindOf('packages/seo-core/src/claim-rules.content.json')).toBe('all')
    expect(frozenKindOf('packages/support-core/src/verticals/goods/rules.content.json')).toBe('all')
    expect(frozenKindOf('packages/seo-core/src/amazon-listing-rules.json')).toBe('all')
    expect(frozenKindOf('packages/roles/persona-en.generated.json')).toBe('all')
    expect(frozenKindOf('packages/seo-core/src/claim-rules.ts')).toBeUndefined()
    expect(frozenKindOf('packages/roles/src/load.ts')).toBeUndefined()
  })

  it('yml 只数内容字段：名字、说明、快捷问题、persona、grounding 的两张词表；骨架、注释、空行不算', () => {
    const lines = contentLinesOfYml(ROLE_YML, 'role')
    expect([...lines].sort((a, b) => a - b)).toEqual([4, 5, 11, 12, 16, 17, 19, 21, 22, 23])
    const pos = contentLinesOfYml(
      'id: x\nversion: 1.0.0\nname: { zh: a, en: a }\nicon: x\nroles:\n  - { role: a, default: true }\n',
      'position',
    )
    expect([...pos]).toEqual([3, 5, 6])
  })

  it('改骨架不算、改内容算', () => {
    const skeleton = ROLE_YML.replace('tool: search_creators', 'tool: other_tool')
    const diff = '@@ -13 +13 @@\n-      tool: search_creators,\n+      tool: other_tool,\n'
    expect(frozenLinesChanged({ kind: 'role', diff, baseText: ROLE_YML, headText: skeleton })).toBe(
      0,
    )
    const content = ROLE_YML.replace('description: 找人与打分', 'description: 找人')
    const diff2 = '@@ -5 +5 @@\n-description: 找人与打分\n+description: 找人\n'
    expect(
      frozenLinesChanged({ kind: 'role', diff: diff2, baseText: ROLE_YML, headText: content }),
    ).toBe(2)
    expect(changedLineNumbers('@@ -3,2 +3,0 @@\n@@ -10,0 +9,3 @@')).toEqual({
      removed: [3, 4],
      added: [9, 10, 11],
    })
  })

  it('真仓库：超过上限只提醒（退出码 0）；--strict 且没标 content-fix 才退出码 1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp404-freeze-'))
    const run = (args, env = {}) => {
      try {
        execFileSync('node', [SCRIPT, ...args], {
          cwd: dir,
          env: { ...process.env, ...env, GITHUB_ACTIONS: '' },
          encoding: 'utf8',
          stdio: 'pipe',
        })
        return 0
      } catch (error) {
        return error.status
      }
    }
    try {
      const sh = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' })
      sh('init', '-q', '-b', 'main')
      sh('config', 'user.email', 't@example.com')
      sh('config', 'user.name', 't')
      mkdirSync(join(dir, 'scripts'))
      writeFileSync(join(dir, 'scripts', 'check-content-freeze.mjs'), '')
      mkdirSync(join(dir, 'packages/seo-core/src'), { recursive: true })
      writeFileSync(join(dir, 'packages/seo-core/src/claim-rules.content.json'), '{}\n')
      sh('add', '.')
      sh('commit', '-qm', 'base')
      expect(checkContentFreeze(dir, 'main').total).toBe(0)
      const many = Array.from({ length: FREEZE_LINE_LIMIT + 5 }, (_, i) => `"r${i}"`).join(',\n')
      writeFileSync(join(dir, 'packages/seo-core/src/claim-rules.content.json'), `[\n${many}\n]\n`)
      expect(checkContentFreeze(dir, 'main').total).toBeGreaterThan(FREEZE_LINE_LIMIT)
      // 子进程里的脚本按自己的位置找仓库根：拿真脚本跑在临时仓库上，要用临时仓库里的那一份路径
      writeFileSync(join(dir, 'scripts', 'check-content-freeze.mjs'), execFileSync('cat', [SCRIPT]))
      const local = join(dir, 'scripts', 'check-content-freeze.mjs')
      const runLocal = (args, env = {}) => {
        try {
          execFileSync('node', [local, ...args], {
            cwd: dir,
            env: { ...process.env, ...env, GITHUB_ACTIONS: '' },
            stdio: 'pipe',
          })
          return 0
        } catch (error) {
          return error.status
        }
      }
      expect(runLocal([])).toBe(0)
      expect(runLocal(['--strict'])).toBe(1)
      expect(runLocal(['--strict'], { CONTENT_FIX_LABEL: 'true' })).toBe(0)
      expect(run(['--base', 'no-such-ref'])).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
