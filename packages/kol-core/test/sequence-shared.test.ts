/**
 * WP173（docs/84 §2.1）：序列 / 配额提到 `@agentsws/core` 之后，红人这边 re-export 的
 * **就是那一份**（同一个引用，不是复制）——红人与 B2B 不会各自演化出两套节奏。
 */
import * as core from '@agentsws/core'
import { describe, expect, it } from 'vitest'
import { nextInSequence, outreachQuota, SEQUENCE_DAYS, SEQUENCE_ORDER } from '../src/index.js'

describe('序列与配额只有一份', () => {
  it('kol-core 拿到的是 core 那一个', () => {
    expect(nextInSequence).toBe(core.nextInSequence)
    expect(outreachQuota).toBe(core.outreachQuota)
    expect(SEQUENCE_DAYS).toBe(core.SEQUENCE_DAYS)
    expect(SEQUENCE_ORDER).toBe(core.SEQUENCE_ORDER)
  })
})
