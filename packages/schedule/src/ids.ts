/** 前缀 id：时间在前、序号在中、随机在后，字典序即建立顺序。随机经注入的 seed。 */
import type { Iso8601 } from '@agentsws/contracts'

export type IdFactory = (prefix: string) => string

export function makeIdFactory(random: () => number, now: () => Iso8601): IdFactory {
  let seq = 0
  return (prefix: string): string => {
    seq += 1
    const t = Date.parse(now()).toString(36).padStart(9, '0')
    const s = seq.toString(36).padStart(3, '0')
    const r = Math.floor(random() * 36 ** 6)
      .toString(36)
      .padStart(6, '0')
    return `${prefix}_${t}${s}${r}`
  }
}

/** 没给 seed 时的兜底：仍然是确定性的（同一进程内单调），不用 `Math.random()`。 */
export function counterRandom(seed = 1): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}
