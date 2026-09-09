import type { Clock } from '@agentsws/contracts'

/**
 * id 生成器。时间经注入的 `Clock`、随机经注入的 seed（35 §2：不用裸 `Date.now()` / `Math.random()`），
 * 因此同一 (clock, seed) 下 id 序列可复现——合成样本与快照测试都指着这一条。
 */
export type IdFactory = (prefix: string) => string

export function createIdFactory(opts: { clock: Clock; random?: () => number }): IdFactory {
  let seq = 0
  return (prefix) => {
    seq += 1
    const t = Date.parse(opts.clock.now())
    const stamp = Number.isNaN(t) ? '0' : t.toString(36)
    const rand = Math.floor((opts.random?.() ?? 0) * 0xffff)
      .toString(36)
      .padStart(4, '0')
    return `${prefix}_${stamp}${seq.toString(36).padStart(2, '0')}${rand}`
  }
}
