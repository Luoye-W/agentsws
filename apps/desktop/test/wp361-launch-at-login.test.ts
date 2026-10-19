/**
 * WP361（决策 927）：开机自启——托盘那一项和设置弹窗里的开关是同一份。
 *
 * - 一份真源（配置）：两处改的都是它，改完托盘重画、工作台窗口收到一声；
 * - 交给系统的那一份：Mac / 老布局只给开 / 关，Windows 版本目录布局指 `current\<exe>`；
 * - preload 把这一项挂上了桥（get / set / onChange），main 两个通道都接了、托盘也走同一个。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRIDGE_CHANNELS } from '../src/bridge-types.js'
import { createLaunchAtLogin, loginItemSettings } from '../src/launch-at-login.js'

function harness(start = false) {
  let config = start
  const log: string[] = []
  const ctl = createLaunchAtLogin({
    read: () => config,
    save: (on) => {
      config = on
      log.push(`save:${on}`)
    },
    apply: (on) => {
      log.push(`apply:${on}`)
    },
    changed: (on) => {
      log.push(`changed:${on}`)
    },
  })
  return { ctl, log, config: () => config }
}

describe('WP361 开机自启一份真源', () => {
  it('设置弹窗那边 set：写配置 → 交给系统 → 托盘与窗口跟着变（按这个顺序）', () => {
    const h = harness(false)
    expect(h.ctl.get()).toBe(false)
    expect(h.ctl.set(true)).toBe(true)
    expect(h.config()).toBe(true)
    expect(h.ctl.get()).toBe(true)
    expect(h.log).toEqual(['save:true', 'apply:true', 'changed:true'])
  })

  it('托盘那边 toggle：翻的是同一份，弹窗读到的就是翻过的', () => {
    const h = harness(true)
    expect(h.ctl.toggle()).toBe(false)
    expect(h.ctl.get()).toBe(false)
    expect(h.ctl.toggle()).toBe(true)
    expect(h.log.filter((l) => l.startsWith('changed'))).toEqual(['changed:false', 'changed:true'])
  })

  it('和现在一样也照样交给系统一次（系统设置里可能被人改过）', () => {
    const h = harness(true)
    h.ctl.set(true)
    expect(h.log).toEqual(['save:true', 'apply:true', 'changed:true'])
  })
})

describe('WP361 交给系统的登录项（Mac / Windows）', () => {
  it('Mac 与老布局：只给开 / 关', () => {
    expect(
      loginItemSettings(true, undefined, '/Applications/Agents 工坊.app/Contents/MacOS/x'),
    ).toEqual({ openAtLogin: true })
    expect(loginItemSettings(false, undefined, 'x')).toEqual({ openAtLogin: false })
  })

  it('Windows 版本目录布局：指 current 下面那个 exe（版本目录会被清理）', () => {
    const current = join('C:', 'Users', 'u', 'AppData', 'Local', 'agentsws', 'current')
    const exe = join('C:', 'Users', 'u', 'AppData', 'Local', 'agentsws', '0.9.1', 'agentsws.exe')
    expect(loginItemSettings(true, current, exe)).toEqual({
      openAtLogin: true,
      path: join(current, 'agentsws.exe'),
    })
  })
})

describe('WP361 桥与托盘接的是同一个', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const preload = readFileSync(new URL('../src/preload.cts', import.meta.url), 'utf8')

  it('preload 挂了 launchAtLogin（get / set / onChange）', () => {
    expect(preload).toMatch(/launchAtLogin: \{[\s\S]*get:[\s\S]*set:[\s\S]*onChange:/)
    for (const c of ['launchAtLoginGet', 'launchAtLoginSet', 'launchAtLoginChanged'] as const)
      expect(preload).toContain(`'${BRIDGE_CHANNELS[c]}'`)
  })

  it('main：两个通道都接了、只认本地源窗口；托盘那一项走同一个 toggle；改完通知窗口', () => {
    expect(main).toContain('ipcMain.handle(BRIDGE_CHANNELS.launchAtLoginGet')
    expect(main).toContain('ipcMain.handle(BRIDGE_CHANNELS.launchAtLoginSet')
    expect(main).toMatch(
      /case 'toggle-launch-at-login':\s*\/\/[^\n]*\n\s*launchAtLogin\.toggle\(\)/,
    )
    expect(main).toContain('webContents.send(BRIDGE_CHANNELS.launchAtLoginChanged, on)')
    expect(main).toMatch(
      /launchAtLoginSet, \(event, raw: unknown\) => \{\s*if \(!fromLocalWindow\(event\)/,
    )
  })
})

describe('wasLaunchedAtLogin（Luoye 10-19：开机自动启动那次不开窗）', () => {
  it('Mac 问系统；Windows 看参数', async () => {
    const { wasLaunchedAtLogin, LAUNCHED_AT_LOGIN_ARG } = await import('../src/launch-at-login.js')
    expect(wasLaunchedAtLogin('darwin', [], () => true)).toBe(true)
    expect(wasLaunchedAtLogin('darwin', [], () => false)).toBe(false)
    expect(
      wasLaunchedAtLogin('darwin', [], () => {
        throw new Error('x')
      }),
    ).toBe(false)
    expect(wasLaunchedAtLogin('win32', ['app.exe', LAUNCHED_AT_LOGIN_ARG], () => false)).toBe(true)
    expect(wasLaunchedAtLogin('win32', ['app.exe'], () => true)).toBe(false)
  })
})
