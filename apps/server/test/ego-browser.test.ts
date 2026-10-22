/**
 * WP463（docs/111 §3）：**找 ego**——存过的路径 → PATH → 常见安装位置，`ego-browser skill` 跑得通才算。
 *
 * 钉四件事：
 * 1. PATH 上有就用 PATH 上那个；
 * 2. **PATH 上没有也找得到**（服务进程看不到用户级 PATH——Windows 远程实测）：Mac 的
 *    `~/.local/bin`、Windows 的 `active_version_dir` 联接（只认经联接的那条路径，不缓存版本目录）；
 * 3. `skill` 退出码非 0、首行格式不对 → 不算能用，说清为什么；
 * 4. 一个都没有 → 说「没找到」。
 *
 * 一条用真的子进程（假 `ego-browser` 脚本）把「同步探测 + 判首行」整条走一遍。
 */
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  detectEgoBrowser,
  type EgoSkillRun,
  egoCandidates,
  runEgoSkillSync,
} from '../src/ego-browser.js'

const GUIDE = '[ego-browser:skill] ego-browser usage guide v2.1.0\n\n# ego-browser\n'
const ok: EgoSkillRun = { exit_code: 0, stdout: GUIDE, stderr: '' }

/** 只有 `files` 里的路径存在；`runs` 给每个路径的 `skill` 结果（缺省能用）。 */
function fakeFs(files: string[], runs: Record<string, EgoSkillRun> = {}) {
  const ran: string[] = []
  return {
    ran,
    exists: (p: string) => files.includes(p),
    runSkill: (p: string) => {
      ran.push(p)
      return runs[p] ?? ok
    },
  }
}

describe('找的顺序', () => {
  it('PATH 上有：用 PATH 上那个', () => {
    const fs = fakeFs(['/opt/ego/bin/ego-browser', '/Users/a/.local/bin/ego-browser'])
    const found = detectEgoBrowser({
      platform: 'darwin',
      homedir: '/Users/a',
      env: { PATH: '/usr/bin:/opt/ego/bin' },
      ...fs,
    })
    expect(found).toEqual({ ok: true, path: '/opt/ego/bin/ego-browser', version: '2.1.0' })
  })

  it('PATH 上没有（服务进程看不到用户级 PATH）：Mac 落到 ~/.local/bin', () => {
    const fs = fakeFs(['/Users/a/.local/bin/ego-browser'])
    const found = detectEgoBrowser({
      platform: 'darwin',
      homedir: '/Users/a',
      env: { PATH: '/usr/bin:/bin' },
      ...fs,
    })
    expect(found).toMatchObject({ ok: true, path: '/Users/a/.local/bin/ego-browser' })
  })

  it('Windows：PATH 上没有就按 active_version_dir 联接找（不解析成版本目录）', () => {
    const link = 'C:\\Users\\admin\\.local\\share\\ego\\active_version_dir\\ego-browser.exe'
    const fs = fakeFs([link])
    const found = detectEgoBrowser({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\admin', Path: 'C:\\Windows\\system32;C:\\Windows' },
      ...fs,
    })
    expect(found).toMatchObject({ ok: true, path: link, version: '2.1.0' })
    expect(found.path).not.toContain('Program Files')
  })

  it('存过的路径排第一；跑不通就接着往下找', () => {
    const fs = fakeFs(['/custom/ego-browser', '/Users/a/.local/bin/ego-browser'], {
      '/custom/ego-browser': { exit_code: 1, stdout: '', stderr: 'boom' },
    })
    const found = detectEgoBrowser({
      savedPath: '/custom/ego-browser',
      platform: 'darwin',
      homedir: '/Users/a',
      env: { PATH: '' },
      ...fs,
    })
    expect(fs.ran[0]).toBe('/custom/ego-browser')
    expect(found).toMatchObject({ ok: true, path: '/Users/a/.local/bin/ego-browser' })
  })

  it('候选列表去重、按平台拼路径', () => {
    expect(
      egoCandidates({
        platform: 'darwin',
        homedir: '/Users/a',
        env: { PATH: '/Users/a/.local/bin:/usr/bin' },
      }),
    ).toEqual([
      '/Users/a/.local/bin/ego-browser',
      '/usr/bin/ego-browser',
      '/Users/a/.local/share/ego/active_version_dir/Helpers/ego-browser',
    ])
  })
})

describe('「能用」的判法', () => {
  it('skill 退出码非 0：不算能用，说出退出码', () => {
    const fs = fakeFs(['/Users/a/.local/bin/ego-browser'], {
      '/Users/a/.local/bin/ego-browser': { exit_code: 3, stdout: GUIDE, stderr: 'crash\nmore' },
    })
    const found = detectEgoBrowser({ platform: 'darwin', homedir: '/Users/a', env: {}, ...fs })
    expect(found.ok).toBe(false)
    expect(found.path).toBe('/Users/a/.local/bin/ego-browser')
    expect(found.detail).toContain('退出码 3')
    expect(found.detail).toContain('crash')
  })

  it('首行格式不对：不算能用', () => {
    const fs = fakeFs(['/Users/a/.local/bin/ego-browser'], {
      '/Users/a/.local/bin/ego-browser': {
        exit_code: 0,
        stdout: 'usage: ego-browser …',
        stderr: '',
      },
    })
    const found = detectEgoBrowser({ platform: 'darwin', homedir: '/Users/a', env: {}, ...fs })
    expect(found).toMatchObject({ ok: false })
    expect(found.detail).toContain('首行对不上')
  })

  it('一个都没有：说没找到', () => {
    const found = detectEgoBrowser({
      platform: 'darwin',
      homedir: '/Users/a',
      env: { PATH: '/usr/bin' },
      ...fakeFs([]),
    })
    expect(found).toMatchObject({ ok: false })
    expect(found.detail).toContain('没找到')
  })

  it('真子进程：同步跑一次假 ego-browser 的 skill，取到版本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentsws-ego-detect-'))
    const bin = join(dir, 'ego-browser')
    writeFileSync(
      bin,
      `#!${process.execPath}\nif (process.argv[2] === 'skill') process.stdout.write(${JSON.stringify(GUIDE)})\nelse process.exit(4)\n`,
      'utf8',
    )
    chmodSync(bin, 0o755)
    expect(runEgoSkillSync(bin)).toMatchObject({ exit_code: 0 })
    expect(detectEgoBrowser({ savedPath: bin, env: { PATH: '' }, homedir: dir })).toEqual({
      ok: true,
      path: bin,
      version: '2.1.0',
    })
    expect(runEgoSkillSync(join(dir, 'missing'))).toMatchObject({ exit_code: null })
  })
})
