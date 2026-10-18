/**
 * WP424（Luoye 10-19 真机）：主窗口顶栏学 Claude——系统标题栏藏起来，窗口按钮嵌进工作台顶栏；
 * Mac 上显示名「Agents 工坊」，但包名 / appId / userData / Windows 安装目录 / 更新 feed 都不动。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  infoPlistStrings,
  MAC_DISPLAY_LPROJ,
  MAC_DISPLAY_NAME,
  writeMacDisplayName,
} from '../scripts/after-pack.mjs'
import {
  parseChromeTheme,
  TITLE_BAR_COLORS,
  TITLE_BAR_HEIGHT,
  titleBarOverlay,
  titleBarStyleOf,
  windowChromeOptions,
} from '../src/window-chrome.js'

const desktop = join(import.meta.dirname, '..')
const read = (rel: string): string => readFileSync(join(desktop, rel), 'utf8')

describe('WP424 · 藏起系统标题栏', () => {
  it('Mac：hidden + 红绿灯落在 44px 顶栏中线上；Windows：hidden + 叠加按钮；Linux 照旧', () => {
    expect(titleBarStyleOf('darwin')).toBe('inset')
    expect(titleBarStyleOf('win32')).toBe('overlay')
    expect(titleBarStyleOf('linux')).toBeUndefined()

    const mac = windowChromeOptions('darwin')
    expect(mac.titleBarStyle).toBe('hidden')
    expect(mac.titleBarOverlay).toBeUndefined()
    // 按钮约 12px 高：(44 − 12) / 2 = 16
    expect(mac.trafficLightPosition).toEqual({ x: 16, y: (TITLE_BAR_HEIGHT - 12) / 2 })

    const win = windowChromeOptions('win32', 'dark')
    expect(win.titleBarStyle).toBe('hidden')
    expect(win.titleBarOverlay).toEqual({ ...TITLE_BAR_COLORS.dark, height: TITLE_BAR_HEIGHT })
    expect(windowChromeOptions('linux')).toEqual({})
  })

  it('叠加按钮的底色与工作台顶栏（--ws-paper / --ws-ink）同值，深浅两套', () => {
    const css = readFileSync(join(desktop, '..', 'workstation', 'src', 'index.css'), 'utf8')
    const light = css.slice(css.indexOf('\n:root {'), css.indexOf('\n.dark {'))
    const dark = css.slice(css.indexOf('\n.dark {'))
    expect(light).toContain(`--ws-paper: ${TITLE_BAR_COLORS.light.color};`)
    expect(light).toContain(`--ws-ink: ${TITLE_BAR_COLORS.light.symbolColor};`)
    expect(dark).toContain(`--ws-paper: ${TITLE_BAR_COLORS.dark.color};`)
    expect(dark).toContain(`--ws-ink: ${TITLE_BAR_COLORS.dark.symbolColor};`)
    expect(titleBarOverlay('light').height).toBe(44)
  })

  it('页面发来的主题只认 light / dark', () => {
    expect(parseChromeTheme('dark')).toBe('dark')
    expect(parseChromeTheme('light')).toBe('light')
    expect(parseChromeTheme('blue')).toBeUndefined()
    expect(parseChromeTheme({ theme: 'dark' })).toBeUndefined()
  })

  it('主窗口用上它；桥只在主窗口报 title_bar，preload 据此才给 titleBar', () => {
    const main = read('src/main.ts')
    expect(main).toContain('...windowChromeOptions(process.platform)')
    expect(main).toMatch(/title_bar: chrome/)
    expect(main).toContain('BRIDGE_CHANNELS.titleBarTheme')
    const preload = read('src/preload.cts')
    expect(preload).toMatch(/info\.title_bar === undefined[\s\S]*titleBar: \{/)
  })
})

describe('WP424 · Mac 显示名「Agents 工坊」（决策 1281）', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentsws-wp424-'))
  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('afterPack 在 Electron 自带的两个语言目录写 InfoPlist.strings（不多建语言目录）', () => {
    expect(MAC_DISPLAY_NAME).toBe('Agents 工坊')
    expect(MAC_DISPLAY_LPROJ).toEqual(['en.lproj', 'zh_CN.lproj'])
    const written = writeMacDisplayName(root)
    expect(written).toEqual(MAC_DISPLAY_LPROJ)
    for (const dir of written) {
      const text = readFileSync(join(root, dir, 'InfoPlist.strings'), 'utf8')
      expect(text).toBe('CFBundleDisplayName = "Agents 工坊";\nCFBundleName = "Agents 工坊";\n')
    }
    expect(infoPlistStrings('a "b" \\ c')).toContain('"a \\"b\\" \\\\ c"')
  })

  it('只改显示名：包名 / appId / 安装目录 / 更新 feed 不动；Info.plist 的显示名仍等于包名', () => {
    const yml = read('electron-builder.yml')
    expect(yml).toMatch(/^appId: com\.agentsws\.desktop$/m)
    expect(yml).toMatch(/^productName: agentsws$/m)
    // 不等于包名的话系统当成「用户改过文件名」，本地化名就不出来（10-19 本机实测）
    expect(yml).toMatch(
      /extendInfo:\n\s+CFBundleDisplayName: agentsws\n\s+LSHasLocalizedDisplayName: true/,
    )
    expect(yml).toMatch(/publish:\n\s+provider: generic\n\s+url: https:\/\/dl\.agentsws\.com\/beta/)
    // userData 跟着 package.json 的 name 走，这里不许冒出 productName
    const pkg = JSON.parse(read('package.json')) as { name: string; productName?: string }
    expect(pkg.name).toBe('@agentsws/desktop')
    expect(pkg.productName).toBeUndefined()
    // afterPack 在自签之前写
    const after = read('scripts/after-pack.mjs')
    expect(after.indexOf('writeMacDisplayName(resources)')).toBeGreaterThan(0)
    expect(after.indexOf('writeMacDisplayName(resources)')).toBeLessThan(
      after.indexOf('adhocSignMacApp(join('),
    )
  })
})
