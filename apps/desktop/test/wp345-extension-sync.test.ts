/**
 * WP345：安装包里的插件 → 数据目录下的固定文件夹（`src/extension-sync.ts`）。
 * 真临时目录：第一次放进去、一样就不动、变了整体换、换到一半失败保留旧版、抄出来对不上不换、清上次的残留。
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
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  bundledExtensionDir,
  type ExtensionSyncFs,
  extensionFolder,
  extensionStateFile,
  leftovers,
  manifestVersion,
  nodeExtensionSyncFs,
  syncBundledExtension,
  treeDigest,
} from '../src/extension-sync.js'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wp345-sync-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const now = (): Date => new Date('2026-10-15T08:00:00.000Z')

/** 造一份插件：manifest + 一个脚本 + 子目录里一个文件。 */
function bundle(name: string, version: string, extra = ''): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'chunks'), { recursive: true })
  writeFileSync(
    join(dir, 'manifest.json'),
    JSON.stringify({ version: version.split('-')[0], version_name: version }),
  )
  writeFileSync(join(dir, 'background.js'), `// ${version}${extra}`)
  writeFileSync(join(dir, 'chunks', 'a.js'), 'chunk')
  return dir
}

const target = (): string => extensionFolder(join(root, 'userData'))
const state = (): Record<string, unknown> =>
  JSON.parse(readFileSync(extensionStateFile(target()), 'utf8')) as Record<string, unknown>
const fs = nodeExtensionSyncFs()

describe('插件文件夹同步（WP345）', () => {
  it('路径：数据目录下的 chrome-extension；状态文件在旁边；打包 / 开发各取各的', () => {
    expect(extensionFolder('/ud')).toBe(join('/ud', 'chrome-extension'))
    expect(extensionStateFile('/ud/chrome-extension')).toBe('/ud/chrome-extension.json')
    expect(bundledExtensionDir('/res', '/dev')).toBe(join('/res', 'chrome-extension'))
    expect(bundledExtensionDir(undefined, '/dev')).toBe('/dev')
  })

  it('版本：version_name 优先，没有就 version；读不到回 undefined', () => {
    const a = bundle('a', '0.2.0-beta.8')
    expect(manifestVersion(a, fs)).toBe('0.2.0-beta.8')
    writeFileSync(join(a, 'manifest.json'), JSON.stringify({ version: '1.0.0' }))
    expect(manifestVersion(a, fs)).toBe('1.0.0')
    writeFileSync(join(a, 'manifest.json'), JSON.stringify({ version: '' }))
    expect(manifestVersion(a, fs)).toBeUndefined()
    expect(manifestVersion(join(root, 'nope'), fs)).toBeUndefined()
  })

  it('摘要：同内容同摘要，改一个字节就变；目录不在回 undefined', () => {
    const a = bundle('a', '1.0.0')
    const b = bundle('b', '1.0.0')
    expect(treeDigest(a, fs)).toBe(treeDigest(b, fs))
    writeFileSync(join(b, 'chunks', 'a.js'), 'chunk!')
    expect(treeDigest(a, fs)).not.toBe(treeDigest(b, fs))
    expect(treeDigest(join(root, 'nope'), fs)).toBeUndefined()
  })

  it('第一次：放进去，状态 installed', async () => {
    const src = bundle('res', '0.2.0-beta.8')
    const out = await syncBundledExtension({ source: src, target: target(), now })
    expect(out).toMatchObject({ status: 'installed', bundled_version: '0.2.0-beta.8' })
    expect(manifestVersion(target(), fs)).toBe('0.2.0-beta.8')
    expect(treeDigest(target(), fs)).toBe(treeDigest(src, fs))
    expect(state()).toMatchObject({ status: 'installed', folder_version: '0.2.0-beta.8' })
  })

  it('一样就不动（unchanged）', async () => {
    const src = bundle('res', '0.2.0-beta.8')
    await syncBundledExtension({ source: src, target: target(), now })
    const out = await syncBundledExtension({ source: src, target: target(), now })
    expect(out.status).toBe('unchanged')
  })

  it('变了：整体换成新版、记下旧版本号、旁边不留临时目录', async () => {
    await syncBundledExtension({ source: bundle('v1', '0.2.0-beta.7'), target: target(), now })
    writeFileSync(join(target(), 'stale-only-in-old.js'), 'x')
    const out = await syncBundledExtension({
      source: bundle('v2', '0.2.0-beta.8'),
      target: target(),
      now,
    })
    expect(out).toMatchObject({
      status: 'updated',
      previous_version: '0.2.0-beta.7',
      folder_version: '0.2.0-beta.8',
    })
    expect(existsSync(join(target(), 'stale-only-in-old.js'))).toBe(false)
    expect(readdirSync(join(root, 'userData')).sort()).toEqual([
      'chrome-extension',
      'chrome-extension.json',
    ])
  })

  it('旧版挪不开（被占用）：保留旧版、记 failed + 原因，重试过 3 次', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    let tries = 0
    const locked: ExtensionSyncFs = {
      ...fs,
      rename: (from, to) => {
        if (from === target()) {
          tries += 1
          throw new Error('EBUSY: resource busy or locked')
        }
        fs.rename(from, to)
      },
    }
    const out = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: locked,
      now,
      sleep: async () => {},
    })
    expect(tries).toBe(3)
    expect(out).toMatchObject({
      status: 'failed',
      folder_version: '1.0.0',
      bundled_version: '1.0.1',
    })
    expect(out.error).toMatch(/挪不开.*EBUSY/)
    expect(manifestVersion(target(), fs)).toBe('1.0.0')
    expect(leftovers(target(), fs)).toEqual([])
  })

  it('新版放不进去：旧版改回来、照旧可用', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    const broken: ExtensionSyncFs = {
      ...fs,
      rename: (from, to) => {
        if (from.includes('.new-')) throw new Error('EPERM')
        fs.rename(from, to)
      },
    }
    const out = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: broken,
      now,
      attempts: 1,
    })
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/新版放不进去/)
    expect(manifestVersion(target(), fs)).toBe('1.0.0')
    expect(leftovers(target(), fs)).toEqual([])
  })

  it('新版放不进去、旧版也改不回来：照实说旧版在哪', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    let moved = false
    const broken: ExtensionSyncFs = {
      ...fs,
      rename: (from, to) => {
        if (!moved && from === target()) {
          moved = true
          fs.rename(from, to)
          return
        }
        throw new Error('EPERM')
      },
    }
    const out = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: broken,
      now,
      attempts: 1,
      random: () => 'abc',
    })
    expect(out.error).toMatch(/旧版也没改回来.*chrome-extension\.old-abc/)
  })

  it('第一次就放不进去：failed，文件夹不存在', async () => {
    const out = await syncBundledExtension({
      source: bundle('v1', '1.0.0'),
      target: target(),
      fs: {
        ...fs,
        rename: () => {
          throw new Error('EACCES')
        },
      },
      now,
      attempts: 1,
    })
    expect(out.status).toBe('failed')
    expect(out.folder_version).toBeUndefined()
    expect(existsSync(target())).toBe(false)
  })

  it('抄出来对不上 / 抄失败：不换、不留临时目录', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    const corrupt: ExtensionSyncFs = {
      ...fs,
      copyDir: (from, to) => {
        fs.copyDir(from, to)
        writeFileSync(join(to, 'background.js'), 'half written')
      },
    }
    const a = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: corrupt,
      now,
    })
    expect(a.error).toMatch(/对不上/)
    const b = await syncBundledExtension({
      source: bundle('v3', '1.0.2'),
      target: target(),
      fs: {
        ...fs,
        copyDir: () => {
          throw new Error('ENOSPC')
        },
      },
      now,
    })
    expect(b.error).toMatch(/抄插件文件失败.*ENOSPC/)
    expect(manifestVersion(target(), fs)).toBe('1.0.0')
    expect(leftovers(target(), fs)).toEqual([])
  })

  it('读不了插件文件：failed', async () => {
    const src = bundle('v1', '1.0.0')
    let reads = 0
    const out = await syncBundledExtension({
      source: src,
      target: target(),
      fs: {
        ...fs,
        read: (p) => {
          reads += 1
          if (reads > 1) throw new Error('EIO')
          return fs.read(p)
        },
      },
      now,
    })
    expect(out.error).toMatch(/读不了插件文件.*EIO/)
  })

  it('安装包里没带插件：文件夹不动（no_bundle）', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    const out = await syncBundledExtension({ source: join(root, 'nope'), target: target(), now })
    expect(out).toMatchObject({ status: 'no_bundle', folder_version: '1.0.0' })
    rmSync(target(), { recursive: true })
    const empty = await syncBundledExtension({ source: join(root, 'nope'), target: target(), now })
    expect(empty).toEqual({ status: 'no_bundle', at: now().toISOString() })
  })

  it('上次被打断留下的 .new- / .old- 先清掉；别的东西不碰', async () => {
    mkdirSync(join(root, 'userData', 'chrome-extension.new-zzz'), { recursive: true })
    mkdirSync(join(root, 'userData', 'chrome-extension.old-yyy'), { recursive: true })
    mkdirSync(join(root, 'userData', 'data'), { recursive: true })
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    expect(readdirSync(join(root, 'userData')).sort()).toEqual([
      'chrome-extension',
      'chrome-extension.json',
      'data',
    ])
  })

  it('残留删不掉、旧版删不掉、状态写不了：都不挡同步', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    mkdirSync(join(root, 'userData', 'chrome-extension.new-zzz'), { recursive: true })
    const sticky: ExtensionSyncFs = {
      ...fs,
      removeDir: () => {
        throw new Error('EPERM')
      },
      writeText: () => {
        throw new Error('EROFS')
      },
    }
    const out = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: sticky,
      now,
    })
    expect(out.status).toBe('updated')
    expect(manifestVersion(target(), fs)).toBe('1.0.1')
    // 新的抄坏了、临时目录也删不掉：照样 failed，不抛
    const out2 = await syncBundledExtension({
      source: bundle('v3', '1.0.2'),
      target: target(),
      fs: {
        ...sticky,
        copyDir: () => {
          throw new Error('ENOSPC')
        },
      },
      now,
    })
    expect(out2.status).toBe('failed')
  })

  it('真的那份文件系统：读不了的目录列出来是空', () => {
    expect(fs.list(join(root, 'nope'))).toEqual([])
  })

  it('默认的随机名与等待（不注入）：照常工作', async () => {
    await syncBundledExtension({ source: bundle('v1', '1.0.0'), target: target(), now })
    let first = true
    const flaky: ExtensionSyncFs = {
      ...fs,
      rename: (from, to) => {
        if (first) {
          first = false
          throw new Error('EBUSY')
        }
        fs.rename(from, to)
      },
    }
    const out = await syncBundledExtension({
      source: bundle('v2', '1.0.1'),
      target: target(),
      fs: flaky,
      now,
    })
    expect(out.status).toBe('updated')
  })
})
