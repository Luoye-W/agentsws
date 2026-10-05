import { describe, expect, it } from 'vitest'
import { systemTar } from '../src/system-tools.js'

describe('systemTar（WP218）', () => {
  it('Windows 用 System32 里那一份，不靠 PATH', () => {
    expect(systemTar({ SystemRoot: 'D:\\Win' }, 'win32')).toBe('D:\\Win\\System32\\tar.exe')
    expect(systemTar({ windir: 'E:\\W' }, 'win32')).toBe('E:\\W\\System32\\tar.exe')
    expect(systemTar({}, 'win32')).toBe('C:\\Windows\\System32\\tar.exe')
  })
  it('其他平台照旧', () => {
    expect(systemTar({}, 'darwin')).toBe('tar')
    expect(typeof systemTar()).toBe('string')
  })
})
