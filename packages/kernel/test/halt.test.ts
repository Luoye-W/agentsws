import { describe, expect, it } from 'vitest'
import { HALT_SCOPES, MemoryHalt, parseHaltEnv } from '../src/index.js'

describe('MemoryHalt（28 §1 急停一个变量）', () => {
  it('默认全部不停', () => {
    const halt = new MemoryHalt()
    for (const scope of HALT_SCOPES) expect(halt.isHalted(scope)).toBe(false)
    expect(halt.state()).toEqual({
      all: { on: false },
      model: { on: false },
      outbound: { on: false },
      learning: { on: false },
    })
  })

  it('AGENTSWS_HALT 设初始态，支持逗号分隔', () => {
    const halt = new MemoryHalt({ AGENTSWS_HALT: 'outbound, learning' })
    expect(halt.isHalted('outbound')).toBe(true)
    expect(halt.isHalted('learning')).toBe(true)
    expect(halt.isHalted('model')).toBe(false)
    expect(halt.state().outbound).toEqual({ on: true, reason: 'AGENTSWS_HALT env' })
  })

  it('AGENTSWS_HALT=all → 所有档位都视为已停（28 §4 用例 3）', () => {
    const halt = new MemoryHalt({ AGENTSWS_HALT: 'all' })
    for (const scope of HALT_SCOPES) expect(halt.isHalted(scope)).toBe(true)
  })

  it('AGENTSWS_MODEL_HALT=1 等价 model（22 §5）', () => {
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: '1' }).isHalted('model')).toBe(true)
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: 'true' }).isHalted('model')).toBe(true)
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: 'ON' }).isHalted('model')).toBe(true)
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: '0' }).isHalted('model')).toBe(false)
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: '1' }).isHalted('outbound')).toBe(false)
    expect(new MemoryHalt({ AGENTSWS_OUTBOUND_HALT: 'yes' }).isHalted('outbound')).toBe(true)
    expect(new MemoryHalt({ AGENTSWS_MODEL_HALT: '1' }).state().model.reason).toBe(
      'AGENTSWS_MODEL_HALT env',
    )
  })

  it('非法环境变量宁可起不来，也不假装停住了', () => {
    expect(() => new MemoryHalt({ AGENTSWS_HALT: 'everything' })).toThrow(/unknown scope/)
    expect(() => new MemoryHalt({ AGENTSWS_MODEL_HALT: 'maybe' })).toThrow(/boolean flag/)
    expect(parseHaltEnv({})).toEqual([])
    expect(parseHaltEnv({ AGENTSWS_HALT: '  ' })).toEqual([])
    expect(parseHaltEnv({ AGENTSWS_HALT: 'model,,outbound' })).toEqual(['model', 'outbound'])
  })

  it('set / isHalted / state 往返，关掉时清掉理由', () => {
    const halt = new MemoryHalt()
    halt.set('model', true, 'budget exhausted')
    expect(halt.isHalted('model')).toBe(true)
    expect(halt.state().model).toEqual({ on: true, reason: 'budget exhausted' })
    halt.set('model', false)
    expect(halt.state().model).toEqual({ on: false })
    halt.set('all', true)
    expect(halt.state().all).toEqual({ on: true })
    expect(halt.isHalted('outbound')).toBe(true)
    halt.set('outbound', true, 'incident')
    halt.set('all', false)
    expect(halt.isHalted('outbound')).toBe(true)
    expect(halt.isHalted('learning')).toBe(false)
  })

  it('未知档位被拒', () => {
    const halt = new MemoryHalt()
    expect(() => halt.set('nope' as 'model', true)).toThrow(/unknown halt scope/)
    expect(() => halt.isHalted('nope' as 'model')).toThrow(/unknown halt scope/)
  })
})
