/**
 * WP297（决策 140 / 376）：`scripts/fetch-theme-base.mjs`——安装包随带的起底主题兜底包。
 *
 * 不联网：下载换成假的。钉住四件事——校验不对当场失败（不重试、不落盘）、网络失败重试、
 * 已有且对得上就不再下、安装包里那一份在不在 / 对不对（afterPack 与 Windows 装包冒烟都靠它）。
 * 再核一遍文件名与服务端 `site-theme.ts` 认的那个名字是同一套、钉子就是服务端那一份。
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import {
  bundledThemeBaseProblem,
  fetchThemeBase,
  PIN_FILE,
  readPin,
  sha256,
  THEME_BASE_RESOURCE_DIR,
  themeBaseFileName,
  themeBaseProblem,
  themeBaseUrl,
} from '../scripts/fetch-theme-base.mjs'

const root = mkdtempSync(join(tmpdir(), 'agentsws-theme-base-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})
let seq = 0
const scratch = (): string => {
  seq += 1
  const dir = join(root, String(seq))
  mkdirSync(dir, { recursive: true })
  return dir
}

const BYTES = Buffer.from('pretend this is the agentsws-theme tarball')
const PIN = {
  repo: 'Luoye-W/agentsws-theme',
  commit: 'a'.repeat(40),
  sha256: sha256(BYTES),
  bytes: BYTES.length,
}
const ok = (bytes: Buffer) => async () => ({
  ok: true,
  status: 200,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
})
const quiet = { sleep: async () => undefined, log: () => undefined }

describe('fetch-theme-base', () => {
  it('钉子就是服务端那一份；文件名与服务端 localBaseFile 同一套；按 commit 从 codeload 下', () => {
    const pin = readPin()
    expect(PIN_FILE.replace(/\\/g, '/')).toMatch(/apps\/server\/src\/theme-base-pin\.json$/)
    expect(themeBaseFileName(pin)).toBe(`agentsws-theme-${pin.commit}.tgz`)
    expect(themeBaseUrl(pin)).toBe(
      `https://codeload.github.com/Luoye-W/agentsws-theme/tar.gz/${pin.commit}`,
    )
  })

  it('钉子缺项 / 写错就失败', () => {
    const dir = scratch()
    const file = join(dir, 'pin.json')
    writeFileSync(file, JSON.stringify({ ...PIN, sha256: 'x', bytes: 0 }))
    expect(() => readPin(file)).toThrow(/sha256、bytes/)
  })

  it('下来的字节数或 sha256 不对：当场失败、不重试、一个字节都不落盘', async () => {
    const dir = scratch()
    let calls = 0
    const tampered = Buffer.from('pretend this is the agentsws-theme tarbalL')
    await expect(
      fetchThemeBase({
        pin: PIN,
        dir,
        ...quiet,
        fetch: async (url: string) => {
          calls += 1
          return ok(tampered)(url)
        },
      }),
    ).rejects.toThrow(/sha256 对不上/)
    expect(calls).toBe(1)
    expect(readdirSync(dir)).toEqual([])
    await expect(
      fetchThemeBase({ pin: PIN, dir, ...quiet, fetch: ok(Buffer.from('short')) }),
    ).rejects.toThrow(/字节数对不上/)
    expect(themeBaseProblem(BYTES, PIN)).toBeUndefined()
  })

  it('网络失败重试（间隔加倍），之后下好就落盘；一直下不来就失败并说清楚', async () => {
    const dir = scratch()
    const waits: number[] = []
    let calls = 0
    const r = await fetchThemeBase({
      pin: PIN,
      dir,
      log: () => undefined,
      sleep: async (ms: number) => {
        waits.push(ms)
      },
      fetch: async (url: string) => {
        calls += 1
        if (calls === 1) throw new Error('getaddrinfo ENOTFOUND codeload.github.com')
        if (calls === 2)
          return { ok: false, status: 502, arrayBuffer: async () => new ArrayBuffer(0) }
        return ok(BYTES)(url)
      },
    })
    expect(r).toMatchObject({ cached: false, attempts: 3 })
    expect(waits).toEqual([2000, 4000])
    expect(existsSync(join(dir, themeBaseFileName(PIN)))).toBe(true)
    expect(readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false)

    await expect(
      fetchThemeBase({
        pin: PIN,
        dir: scratch(),
        attempts: 2,
        ...quiet,
        fetch: async () => {
          throw new Error('timeout')
        },
      }),
    ).rejects.toThrow(/下了 2 次都没下下来.*timeout/)
  })

  it('已有且对得上就不再下（CI 缓存）；已有但不对就重下；换了钉子删掉旧 commit 那一份', async () => {
    const dir = scratch()
    writeFileSync(join(dir, themeBaseFileName(PIN)), BYTES)
    const old = `agentsws-theme-${'b'.repeat(40)}.tgz`
    writeFileSync(join(dir, old), 'old pin')
    writeFileSync(join(dir, 'README.txt'), 'not ours')
    const never = async (): Promise<never> => {
      throw new Error('不该联网')
    }
    expect(await fetchThemeBase({ pin: PIN, dir, ...quiet, fetch: never })).toMatchObject({
      cached: true,
      attempts: 0,
    })
    expect(readdirSync(dir).sort()).toEqual(['README.txt', themeBaseFileName(PIN)])

    writeFileSync(join(dir, themeBaseFileName(PIN)), 'half a file')
    expect(await fetchThemeBase({ pin: PIN, dir, ...quiet, fetch: ok(BYTES) })).toMatchObject({
      cached: false,
    })
    expect(themeBaseProblem(readFileSync(join(dir, themeBaseFileName(PIN))), PIN)).toBeUndefined()
  })

  it('安装包里那一份：不在 / 不对 → 说清楚；对 → 空', () => {
    const resources = scratch()
    expect(bundledThemeBaseProblem(resources, PIN)).toMatch(/安装包里没有随带的起底包/)
    mkdirSync(join(resources, THEME_BASE_RESOURCE_DIR))
    const file = join(resources, THEME_BASE_RESOURCE_DIR, themeBaseFileName(PIN))
    writeFileSync(file, 'x'.repeat(BYTES.length))
    expect(bundledThemeBaseProblem(resources, PIN)).toMatch(/起底包不对[\s\S]*sha256/)
    writeFileSync(file, BYTES)
    expect(bundledThemeBaseProblem(resources, PIN)).toBeUndefined()
  })

  it('接上了：extraResources 带 vendor/theme-base → theme-base；dist.mjs 打包前取；afterPack 核', () => {
    const desktop = join(dirname(fileURLToPath(import.meta.url)), '..')
    const yml = readFileSync(join(desktop, 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/- from: vendor\/theme-base\n\s+to: theme-base\n\s+filter:\n\s+- '\*\.tgz'/)
    const dist = readFileSync(join(desktop, 'scripts', 'dist.mjs'), 'utf8')
    expect(dist).toMatch(/await fetchThemeBase\(\)\n\s+const version/)
    const afterPack = readFileSync(join(desktop, 'scripts', 'after-pack.mjs'), 'utf8')
    expect(afterPack).toMatch(/bundledThemeBaseProblem\(resources, themePin\)/)
    expect(afterPack).toMatch(/if \(themeProblem !== undefined\) throw new Error\(themeProblem\)/)
  })
})
