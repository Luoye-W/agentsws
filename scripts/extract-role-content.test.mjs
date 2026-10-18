/**
 * WP404：抽取脚本——抽出来的内容文件只含白名单字段，套回去与原 yml 加载结果逐字段相等；命令行真跑一遍。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { extractRoleContent } from './extract-role-content.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROLE_FIELDS = [
  'name',
  'description',
  'persona',
  'quick_prompts',
  'task_examples',
  'grounding',
]
const built = existsSync(join(ROOT, 'packages/roles/dist/index.js'))

describe.skipIf(!built)('extract-role-content', () => {
  it('51 条职责 + 全部岗位，只含白名单字段，往返无差', async () => {
    const { files, problems } = await extractRoleContent()
    expect(problems).toEqual([])
    const roles = files.filter((f) => f.path.startsWith('roles/'))
    expect(roles).toHaveLength(51)
    expect(files.length - roles.length).toBeGreaterThanOrEqual(11)
    for (const f of roles) {
      expect(f.data.schema).toBe('agentsws.role-content/1')
      for (const k of Object.keys(f.data.content)) expect(ROLE_FIELDS).toContain(k)
      for (const g of f.data.content.grounding ?? [])
        expect(Object.keys(g).sort()).toEqual(
          Object.keys(g)
            .filter((k) => ['name', 'intent_terms', 'cue_terms'].includes(k))
            .sort(),
        )
    }
    for (const f of files.filter((x) => x.path.startsWith('positions/')))
      for (const k of Object.keys(f.data.content)) expect(['name', 'persona', 'roles']).toContain(k)
  })

  it('命令行：--out 写盘、--check 只自检', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp404-extract-'))
    try {
      const out = execFileSync('node', ['scripts/extract-role-content.mjs', '--out', dir], {
        cwd: ROOT,
        encoding: 'utf8',
      })
      expect(out).toMatch(/51 条职责/)
      const yt = JSON.parse(readFileSync(join(dir, 'roles/kol.youtube/content.json'), 'utf8'))
      expect(yt.id).toBe('kol.youtube')
      expect(yt.content.persona.zh).toMatch(/^你是谁：/)
      expect(yt.content.persona.en).toBeUndefined()
      expect(yt.content.scopes).toBeUndefined()
      expect(existsSync(join(dir, 'positions/amazon-ops/content.json'))).toBe(true)
      expect(
        execFileSync('node', ['scripts/extract-role-content.mjs', '--check'], {
          cwd: ROOT,
          encoding: 'utf8',
        }),
      ).toMatch(/往返自检通过/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
