import { describe, expect, it } from 'vitest'
import {
  createConfigStore,
  DEFAULT_CONFIG,
  DEFAULT_PORT,
  LANGUAGES,
  parseConfig,
  serializeConfig,
} from '../src/config.js'
import { memoryFileStore } from '../src/node-files.js'

describe('parseConfig', () => {
  it('非对象退回默认值', () => {
    expect(parseConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(parseConfig(null)).toEqual(DEFAULT_CONFIG)
    expect(parseConfig('nope')).toEqual(DEFAULT_CONFIG)
  })

  it('逐字段宽容：坏的退回默认，好的留下', () => {
    expect(
      parseConfig({ port: 'x', openInBrowser: 1, launchAtLogin: true, language: 'fr' }),
    ).toEqual({
      port: DEFAULT_PORT,
      openInBrowser: false,
      launchAtLogin: true,
      language: 'zh-CN',
    })
  })

  it('端口必须是 0..65535 的整数', () => {
    expect(parseConfig({ port: 0 }).port).toBe(0)
    expect(parseConfig({ port: 65535 }).port).toBe(65535)
    expect(parseConfig({ port: -1 }).port).toBe(DEFAULT_PORT)
    expect(parseConfig({ port: 70000 }).port).toBe(DEFAULT_PORT)
    expect(parseConfig({ port: 1.5 }).port).toBe(DEFAULT_PORT)
  })

  it('语言只认白名单', () => {
    for (const language of LANGUAGES) expect(parseConfig({ language }).language).toBe(language)
  })
})

describe('serializeConfig', () => {
  it('只写四个已知字段——配置里不可能夹带密钥', () => {
    const raw = { ...DEFAULT_CONFIG, adminToken: 'oct_secret' } as never
    const text = serializeConfig(raw)
    expect(text).not.toContain('adminToken')
    expect(text).not.toContain('oct_secret')
    expect(JSON.parse(text)).toEqual(DEFAULT_CONFIG)
    expect(text.endsWith('\n')).toBe(true)
  })
})

describe('createConfigStore', () => {
  it('文件不存在时给默认值', () => {
    const store = createConfigStore(memoryFileStore(), '/cfg.json')
    expect(store.load()).toEqual(DEFAULT_CONFIG)
    expect(store.current()).toEqual(DEFAULT_CONFIG)
  })

  it('坏 JSON 也不炸', () => {
    const files = memoryFileStore({ '/cfg.json': '{ not json' })
    expect(createConfigStore(files, '/cfg.json').load()).toEqual(DEFAULT_CONFIG)
  })

  it('读回已存的配置', () => {
    const files = memoryFileStore({
      '/cfg.json': JSON.stringify({ port: 5000, language: 'en-US' }),
    })
    const store = createConfigStore(files, '/cfg.json')
    expect(store.load()).toMatchObject({ port: 5000, language: 'en-US' })
  })

  it('save / update 落盘并更新缓存', () => {
    const files = memoryFileStore()
    const store = createConfigStore(files, '/cfg.json')
    store.save({ ...DEFAULT_CONFIG, port: 4400 })
    expect(JSON.parse(files.readText('/cfg.json') ?? '')).toMatchObject({ port: 4400 })
    const updated = store.update({ launchAtLogin: true })
    expect(updated.launchAtLogin).toBe(true)
    expect(updated.port).toBe(4400)
    expect(store.current().launchAtLogin).toBe(true)
  })

  it('update 在没 load 过时先 load', () => {
    const files = memoryFileStore({ '/cfg.json': JSON.stringify({ port: 6000 }) })
    const store = createConfigStore(files, '/cfg.json')
    expect(store.update({ openInBrowser: true })).toMatchObject({ port: 6000, openInBrowser: true })
  })

  it('current 在没 load 过时先 load', () => {
    const files = memoryFileStore({ '/cfg.json': JSON.stringify({ port: 6001 }) })
    expect(createConfigStore(files, '/cfg.json').current().port).toBe(6001)
  })
})
