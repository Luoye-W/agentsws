/**
 * WP111：第一次打开时自动把工作台端出来（之后就不再自动开）。
 */
import { describe, expect, it } from 'vitest'
import { type FirstRunInput, shouldOpenOnFirstRun } from '../src/first-run.js'

const at = (patch: Partial<FirstRunInput> = {}): boolean =>
  shouldOpenOnFirstRun({
    firstRun: true,
    healthy: true,
    alreadyOpened: false,
    remote: false,
    ...patch,
  })

describe('shouldOpenOnFirstRun', () => {
  it('第一次 + 服务健康 → 开', () => {
    expect(at()).toBe(true)
  })

  it('服务还没起来就不开 —— 开一个白屏窗口比不开更糟', () => {
    expect(at({ healthy: false })).toBe(false)
  })

  it('只开一次：第二次轮询到健康不再开（那就成骚扰了）', () => {
    expect(at({ alreadyOpened: true })).toBe(false)
  })

  it('Luoye 10-19：不是第一次、人自己打开的 → 也开（Mac 从「应用程序」打开不能什么都不出来）', () => {
    expect(at({ firstRun: false })).toBe(true)
  })

  it('开机自动启动的那一次不开窗；第一次装完哪怕是登录项拉起的也开', () => {
    expect(at({ firstRun: false, launchedAtLogin: true })).toBe(false)
    expect(at({ firstRun: true, launchedAtLogin: true })).toBe(true)
  })

  it('连公司服务器那一档不自动开：那边要先登录，自动开只会落到登录页', () => {
    expect(at({ remote: true })).toBe(false)
  })
})
