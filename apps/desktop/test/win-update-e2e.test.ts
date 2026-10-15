/** WP225：「两个版本之间点更新」端到端脚本里的纯函数（真跑只在 CI 的 windows-latest 上）。 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  countIn,
  defaultUserData,
  describeBeat,
  feedFileFor,
  readBeat,
  versionOfLatestYml,
} from '../scripts/win-update-e2e.mjs'

describe('win-update-e2e 纯函数', () => {
  it('latest.yml 的版本号', () => {
    const yml =
      "version: 0.0.1-ci.7\nfiles:\n  - url: Agents-Workshop-Setup-0.0.1-ci.7-x64.exe\npath: x\nreleaseDate: '2026-10-05'\n"
    expect(versionOfLatestYml(yml)).toBe('0.0.1-ci.7')
    expect(versionOfLatestYml("version: '1.2.3'\n")).toBe('1.2.3')
    expect(versionOfLatestYml('files: []\n')).toBeUndefined()
  })

  it('本机更新源只发 /<渠道>/<目录里有的文件>，别的一律 404（不许带路径跑出去）', () => {
    const files = ['latest.yml', 'Agents-Workshop-Setup-0.0.1-ci.7-x64.exe']
    expect(feedFileFor('/beta/latest.yml', '/r', files)).toBe(join('/r', 'latest.yml'))
    expect(feedFileFor('/stable/latest.yml?noCache=1', '/r', files)).toBe(join('/r', 'latest.yml'))
    expect(feedFileFor('/beta/Agents-Workshop-Setup-0.0.1-ci.7-x64.exe', '/r', files)).toBe(
      join('/r', 'Agents-Workshop-Setup-0.0.1-ci.7-x64.exe'),
    )
    expect(feedFileFor('/beta/../secret', '/r', files)).toBeUndefined()
    expect(feedFileFor('/beta/%2E%2E%2Fsecret', '/r', files)).toBeUndefined()
    expect(feedFileFor('/nightly/latest.yml', '/r', files)).toBeUndefined()
    expect(feedFileFor('/beta/other.yml', '/r', files)).toBeUndefined()
    expect(feedFileFor('/beta/%E0%A4%A', '/r', files)).toBeUndefined()
  })

  it('Windows 默认用户数据目录：带 scope 的包名是两层（%APPDATA%\\@agentsws\\desktop）', () => {
    expect(defaultUserData('/appdata', '@agentsws/desktop')).toBe(
      join('/appdata', '@agentsws', 'desktop'),
    )
    expect(defaultUserData('/appdata', 'agentsws')).toBe(join('/appdata', 'agentsws'))
  })

  it('WP325：小窗心跳（带 BOM 也认；没有 / 坏的回 undefined）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp325-beat-'))
    try {
      const f = join(dir, 'update-splash.json')
      expect(readBeat(f)).toBeUndefined()
      writeFileSync(
        f,
        '\uFEFF{"pid":42,"state":"headless","error":"not interactive","at":"2026-10-14T10:24:34.000Z"}',
      )
      const beat = readBeat(f)
      expect(beat).toMatchObject({ pid: 42, state: 'headless' })
      expect(describeBeat(beat)).toBe('没有交互桌面，后台在等：not interactive，pid 42')
      expect(describeBeat({ pid: 7, state: 'shown', at: 'x' })).toBe('窗口画出来了，pid 7')
      writeFileSync(f, '{坏')
      expect(readBeat(f)).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('WP337：服务进程日志里某句出现了几次（「接着做」只许一次）', () => {
    const log = 'a 更新好了，暂停的接着做 b\nc 更新好了，暂停的接着做\n'
    expect(countIn(log, '更新好了，暂停的接着做')).toBe(2)
    expect(countIn('', 'x')).toBe(0)
  })
})
