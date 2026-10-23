/**
 * 教程上官网（私有 docs/113 §4.4）：发版前把 `requires: next` 换成版本号。
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stampDir, stampText } from './help-stamp-release.mjs'

describe('help-stamp-release', () => {
  it('只换头上那一行；正文里的 requires: next 不动', () => {
    const text = '---\ngroup: tools\nrequires: next\norder: 10\n---\n# A\n\nrequires: next\n'
    expect(stampText(text, '0.2.1-beta.9')).toBe(
      '---\ngroup: tools\nrequires: 0.2.1-beta.9\norder: 10\n---\n# A\n\nrequires: next\n',
    )
  })

  it('头上第一行就是它、带引号的也认；没写的、已经是版本号的原样回', () => {
    expect(stampText("---\nrequires: 'next'\n---\n# A\n", '0.3.0')).toBe(
      '---\nrequires: 0.3.0\n---\n# A\n',
    )
    expect(stampText('---\nrequires: 0.2.0\n---\n# A\n', '0.3.0')).toBe(
      '---\nrequires: 0.2.0\n---\n# A\n',
    )
    expect(stampText('# 没有元数据\n', '0.3.0')).toBe('# 没有元数据\n')
  })

  it('整个目录：回改了哪些；版本号不对就不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'help-stamp-'))
    writeFileSync(join(dir, 'a.md'), '---\nrequires: next\n---\n# A\n')
    writeFileSync(join(dir, 'b.md'), '---\ngroup: tools\n---\n# B\n')
    expect(() => stampDir(dir, 'next')).toThrow()
    expect(stampDir(dir, '0.2.1-beta.9')).toEqual(['a.md'])
    expect(readFileSync(join(dir, 'a.md'), 'utf8')).toBe('---\nrequires: 0.2.1-beta.9\n---\n# A\n')
  })
})
