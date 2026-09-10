/**
 * 本机 / 公司服务器（WP36 交付 4；40 §1.3、41 §2.1、13 §5 三档部署）。
 *
 * 判定全在 `mode.ts` 里，所以这一组用例就是那一档的规格书：
 * 环境变量赢过配置、坏地址退回本机、装过老版本的机器升级之后不被拦一道问卷。
 */
import { describe, expect, it } from 'vitest'
import {
  companyLabel,
  configPatchOf,
  needsWizard,
  normalizeServerUrl,
  resolveMode,
  SERVER_URL_ENV,
  serverUrlFrom,
} from '../src/mode.js'

describe('normalizeServerUrl', () => {
  it('只认 http / https，取源（去掉路径与尾斜杠）', () => {
    expect(normalizeServerUrl('https://nas.company.lan:4317/')).toBe('https://nas.company.lan:4317')
    expect(normalizeServerUrl('  http://10.0.0.5:4317/app  ')).toBe('http://10.0.0.5:4317')
    expect(normalizeServerUrl('http://127.0.0.1:4317')).toBe('http://127.0.0.1:4317')
  })

  it('空 / 坏 / 别的协议 → undefined（宁可退回本机，也不要一个连不上的窗口）', () => {
    expect(normalizeServerUrl(undefined)).toBeUndefined()
    expect(normalizeServerUrl('   ')).toBeUndefined()
    expect(normalizeServerUrl('nas.company.lan')).toBeUndefined()
    expect(normalizeServerUrl('file:///etc/passwd')).toBeUndefined()
    expect(normalizeServerUrl('javascript:alert(1)')).toBeUndefined()
  })
})

describe('resolveMode', () => {
  it('环境变量给了地址 = 直接 remote，不看配置', () => {
    const out = resolveMode(
      { mode: 'local', serverUrl: '' },
      { [SERVER_URL_ENV]: 'https://nas.company.lan:4317/' },
    )
    expect(out).toEqual({ mode: 'remote', serverUrl: 'https://nas.company.lan:4317', from: 'env' })
  })

  it('配置里写了 remote 且地址能用 → remote', () => {
    expect(resolveMode({ mode: 'remote', serverUrl: 'http://10.0.0.5:4317' })).toEqual({
      mode: 'remote',
      serverUrl: 'http://10.0.0.5:4317',
      from: 'config',
    })
  })

  it('配置里写了 remote 但地址是坏的 → 退回本机（不留一个连不上任何地方的壳）', () => {
    expect(resolveMode({ mode: 'remote', serverUrl: 'not-a-url' })).toEqual({
      mode: 'local',
      from: 'config',
    })
    expect(resolveMode({ mode: 'remote' })).toEqual({ mode: 'local', from: 'config' })
  })

  it('什么都没写 → 本机（默认）', () => {
    expect(resolveMode({})).toEqual({ mode: 'local', from: 'default' })
    expect(resolveMode({ mode: 'local' })).toEqual({ mode: 'local', from: 'config' })
  })

  it('serverUrlFrom：空串当没设', () => {
    expect(serverUrlFrom({ [SERVER_URL_ENV]: '  ' })).toBeUndefined()
    expect(serverUrlFrom({})).toBeUndefined()
    expect(serverUrlFrom({ [SERVER_URL_ENV]: 'https://a.lan' })).toBe('https://a.lan')
  })
})

describe('needsWizard', () => {
  it('配置文件还不存在、环境变量也没替它选 → 问一句', () => {
    expect(needsWizard({ configExists: false })).toBe(true)
    expect(needsWizard({ configExists: false, env: {} })).toBe(true)
  })

  it('已经有配置文件 → 不问（升级不该被拦一道问卷）', () => {
    expect(needsWizard({ configExists: true })).toBe(false)
  })

  it('环境变量已经指到公司服务器 → 不问', () => {
    expect(needsWizard({ configExists: false, env: { [SERVER_URL_ENV]: 'https://nas.lan' } })).toBe(
      false,
    )
  })
})

describe('configPatchOf', () => {
  it('选本机 → 写 local + 清空地址', () => {
    expect(configPatchOf({ mode: 'local' })).toEqual({ mode: 'local', serverUrl: '' })
  })

  it('选公司服务器 → 写规范化后的地址', () => {
    expect(configPatchOf({ mode: 'remote', serverUrl: 'https://nas.lan:4317/x' })).toEqual({
      mode: 'remote',
      serverUrl: 'https://nas.lan:4317',
    })
  })

  it('关掉窗口 / 地址填坏了 → 什么都不写，下次再问', () => {
    expect(configPatchOf({ mode: 'cancelled' })).toBeUndefined()
    expect(configPatchOf({ mode: 'remote', serverUrl: 'nope' })).toBeUndefined()
  })
})

describe('companyLabel', () => {
  it('有公司名用公司名；还没登录就退到主机名', () => {
    expect(companyLabel({ workspaceName: '洛叶跨境', serverUrl: 'https://nas.lan' })).toBe(
      '洛叶跨境',
    )
    expect(companyLabel({ serverUrl: 'https://nas.company.lan:4317' })).toBe('nas.company.lan:4317')
    expect(companyLabel({ workspaceName: '  ', serverUrl: 'http://10.0.0.5:4317' })).toBe(
      '10.0.0.5:4317',
    )
    expect(companyLabel({})).toBe('')
  })
})
