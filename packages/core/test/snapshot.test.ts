import { describe, expect, it } from 'vitest'
import { canonicalJson } from '../src/snapshot.js'

describe('canonicalJson 与 JSON.stringify 同一套取舍', () => {
  it('对象里 undefined 的键跳过、数组里的 undefined 变 null，产物永远能 JSON.parse', () => {
    const input = {
      label: undefined,
      id: 'x',
      list: [1, undefined, 'a'],
      nested: { b: undefined, a: 1 },
    }
    const out = canonicalJson(input)
    expect(out).toBe('{"id":"x","list":[1,null,"a"],"nested":{"a":1}}')
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(input)))
  })

  it('键按字典序排、同样的输入永远出同一串（回放才是恒等变换）', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson('s')).toBe('"s"')
  })
})
