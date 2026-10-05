/**
 * WP225：`autoUpdater` 在 ESM 里拿不到具名导出（CJS 惰性 getter）——WP218 安装包在 Windows 真机上
 * 「Cannot set properties of undefined (setting 'autoDownload')」就是这么来的。
 */
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { autoUpdaterHolder, loadAutoUpdater } from '../src/electron-updater-module.js'

const desktopRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 照 electron-updater 的 main.js：autoUpdater 是 getter，一读就 new（要 electron）。 */
function cjsLike(onRead: () => void): Record<string, unknown> {
  const exportsObj: Record<string, unknown> = { __esModule: true }
  Object.defineProperty(exportsObj, 'autoUpdater', {
    enumerable: true,
    get: () => {
      onRead()
      return { autoDownload: true }
    },
  })
  return exportsObj
}

describe('autoUpdaterHolder', () => {
  it('ESM 具名导出层没有、default 层有（打包后真实情况）：认 default 那层，且不触发 getter', () => {
    let reads = 0
    const cjs = cjsLike(() => {
      reads += 1
    })
    const ns = { default: cjs, NsisUpdater: class {} }
    expect(autoUpdaterHolder(ns)).toBe(cjs)
    expect(reads).toBe(0)
  })

  it('具名导出层有（打包器 / 将来版本认出了它）：用那一层', () => {
    const ns = { autoUpdater: { a: 1 }, default: {} }
    expect(autoUpdaterHolder(ns)).toBe(ns)
  })

  it('哪一层都没有 / 不是对象：undefined', () => {
    expect(autoUpdaterHolder({ default: {} })).toBeUndefined()
    expect(autoUpdaterHolder({ autoUpdater: undefined, default: null })).toBeUndefined()
    expect(autoUpdaterHolder(undefined)).toBeUndefined()
    expect(autoUpdaterHolder('x')).toBeUndefined()
  })

  it('真的 electron-updater（仓库里装的那一份），用真 Node 的 ESM import：具名层没有、default 层有', () => {
    // vitest 自己会改写 import 的互操作，所以开一个干净的 node 进程看真实情况
    const script = [
      "const m = await import('electron-updater')",
      "const named = 'autoUpdater' in m && m.autoUpdater !== undefined",
      "const onDefault = Object.getOwnPropertyDescriptor(m.default, 'autoUpdater') !== undefined",
      'process.stdout.write(JSON.stringify({ named, onDefault }))',
    ].join('\n')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: desktopRoot,
      encoding: 'utf8',
    })
    expect(JSON.parse(out)).toEqual({ named: false, onDefault: true })
  })
})

describe('loadAutoUpdater', () => {
  it('从 default 层取出 autoUpdater，能设属性', async () => {
    const updater = await loadAutoUpdater<{ autoDownload: boolean }>(async () => ({
      default: cjsLike(() => undefined),
    }))
    updater.autoDownload = false
    expect(updater.autoDownload).toBe(false)
  })

  it('取不到就抛一句说得清的错（而不是之后「Cannot set properties of undefined」）', async () => {
    await expect(loadAutoUpdater(async () => ({ default: {} }))).rejects.toThrow(
      /electron-updater 里没有 autoUpdater/,
    )
    await expect(loadAutoUpdater(async () => ({ default: { autoUpdater: null } }))).rejects.toThrow(
      /没有 autoUpdater/,
    )
  })
})
