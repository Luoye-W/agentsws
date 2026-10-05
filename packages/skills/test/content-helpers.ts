/** WP219：内容更新测试共用的小工具（密钥对现生成、目录建在系统临时目录）。 */
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ContentItemMeta } from '../src/index.js'

export function testKey(): string {
  return generateKeyPairSync('ed25519')
    .privateKey.export({ format: 'pem', type: 'pkcs8' })
    .toString()
}

export function meta(
  name: string,
  version: string,
  extra: Partial<ContentItemMeta> = {},
): ContentItemMeta {
  return {
    id: `skill:${name}`,
    kind: 'skill',
    name,
    version,
    title: { zh: `${name} 技能`, en: `${name} skill` },
    summary: { zh: '补了一段', en: 'Added a section' },
    upstream: {
      id: 'demo-upstream',
      repo: 'example/skills',
      commit: 'a'.repeat(40),
      published_at: '2026-10-01',
      license: 'MIT',
    },
    review: {
      reviewer: 'Fable',
      reviewed_at: '2026-10-04',
      license_before: 'MIT',
      license_after: 'MIT',
      scan_hits: 0,
      scan_rules: [],
      notes_ok: true,
      tests_ok: true,
    },
    ...extra,
  }
}

export function skillDir(root: string, name: string, body: string, version = '1.1.0'): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: 测试技能\nversion: ${version}\n---\n\n## 你做什么\n\n${body}\n\n## 规矩\n\n出卡等人批。\n`,
  )
  writeFileSync(join(dir, 'references', 'notes.md'), '# 参考\n\n一段参考。\n')
  writeFileSync(join(dir, 'LICENSE'), 'MIT License\n')
  return dir
}
