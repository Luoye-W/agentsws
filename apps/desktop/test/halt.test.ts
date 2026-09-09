import { describe, expect, it } from 'vitest'
import {
  createHaltControl,
  HALT_SCOPES,
  haltEnv,
  isHaltScope,
  parseHaltFile,
  serializeHaltFile,
} from '../src/halt.js'
import { memoryFileStore } from '../src/node-files.js'

describe('isHaltScope', () => {
  it('只认内核那四档（kernel/halt.ts）', () => {
    for (const scope of HALT_SCOPES) expect(isHaltScope(scope)).toBe(true)
    expect(isHaltScope('everything')).toBe(false)
    expect(isHaltScope(7)).toBe(false)
  })
})

describe('parseHaltFile', () => {
  it('没文件 / 坏 JSON / 形状不对，一律当"没停"', () => {
    expect(parseHaltFile(undefined)).toEqual([])
    expect(parseHaltFile('{ nope')).toEqual([])
    expect(parseHaltFile('null')).toEqual([])
    expect(parseHaltFile('{"scopes":"all"}')).toEqual([])
  })

  it('过滤未知档位并去重', () => {
    expect(parseHaltFile('{"scopes":["all","all","nope","model"]}')).toEqual(['all', 'model'])
  })
})

describe('serializeHaltFile / haltEnv', () => {
  it('往返一致', () => {
    expect(parseHaltFile(serializeHaltFile(['outbound']))).toEqual(['outbound'])
  })

  it('没停就不设变量；停了按逗号拼（内核 parseHaltEnv 的格式）', () => {
    expect(haltEnv([])).toEqual({})
    expect(haltEnv(['all'])).toEqual({ AGENTSWS_HALT: 'all' })
    expect(haltEnv(['model', 'outbound'])).toEqual({ AGENTSWS_HALT: 'model,outbound' })
  })
})

describe('createHaltControl', () => {
  it('默认没停', () => {
    const halt = createHaltControl(memoryFileStore(), '/halt.json')
    expect(halt.read()).toEqual([])
    expect(halt.isPaused()).toBe(false)
    expect(halt.env()).toEqual({})
  })

  it('toggle 在"停 / 不停"之间来回，并落盘', () => {
    const files = memoryFileStore()
    const halt = createHaltControl(files, '/halt.json')
    expect(halt.toggle()).toEqual(['all'])
    expect(halt.isPaused()).toBe(true)
    expect(halt.env()).toEqual({ AGENTSWS_HALT: 'all' })
    expect(parseHaltFile(files.readText('/halt.json'))).toEqual(['all'])
    expect(halt.toggle()).toEqual([])
    expect(halt.isPaused()).toBe(false)
  })

  it('重启后仍然是停的（从文件读回）', () => {
    const files = memoryFileStore()
    createHaltControl(files, '/halt.json').set(['all', 'all', 'model'])
    expect(createHaltControl(files, '/halt.json').read()).toEqual(['all', 'model'])
  })

  it('read 返回副本，改不动内部状态', () => {
    const halt = createHaltControl(memoryFileStore(), '/halt.json')
    halt.set(['model'])
    const scopes = halt.read()
    scopes.push('all')
    expect(halt.read()).toEqual(['model'])
  })
})

describe('WP31：reload（急停真源在文件里，服务进程会写它）', () => {
  it('服务进程改了文件之后，reload 看得见；read 因为有缓存看不见', () => {
    const files = memoryFileStore()
    const control = createHaltControl(files, '/halt.json')
    expect(control.isPaused()).toBe(false)

    // 服务进程（`AGENTSWS_HALT_FILE`）把档位写回同一个文件
    files.writeText('/halt.json', serializeHaltFile(['all']))
    expect(control.read()).toEqual([])
    expect(control.reload()).toEqual(['all'])
    expect(control.isPaused()).toBe(true)

    files.writeText('/halt.json', serializeHaltFile([]))
    expect(control.reload()).toEqual([])
    expect(control.isPaused()).toBe(false)
  })
})
