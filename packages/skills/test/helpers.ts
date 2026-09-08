import type { Clock, Iso8601 } from '@agentsws/contracts'
import { type CreateSkillsOptions, createSkills, type Skills } from '../src/index.js'

export class FakeClock implements Clock {
  #ms: number

  constructor(iso: Iso8601 = '2026-09-08T00:00:00.000Z') {
    this.#ms = Date.parse(iso)
  }

  now(): Iso8601 {
    return new Date(this.#ms).toISOString()
  }

  advance(ms: number): void {
    this.#ms += ms
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000)
  }

  set(iso: Iso8601): void {
    this.#ms = Date.parse(iso)
  }
}

/** 确定性伪随机（不用裸 Math.random）。 */
export function seededRandom(seed = 42): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1_664_525 + 1_013_904_223) >>> 0
    return s / 0x1_0000_0000
  }
}

export function makeSkills(overrides: Partial<CreateSkillsOptions> = {}): {
  skills: Skills
  clock: FakeClock
} {
  const clock = new FakeClock()
  const skills = createSkills({ clock, random: seededRandom(), ...overrides })
  return { skills, clock }
}

export const CUSTOMER_CARE_V1 = `---
name: customer-care
description: 售后客服说明书
---

## 回答顺序

先说记录显示什么，再说条款怎么说，最后说下一步。

## 退换货判定

按记录状态 + 送达日 + 今天 vs 条款窗口算。

## 额度与策略

单笔补偿不超过 50 元，超过要走审批。

## 禁止事项

不发明补偿，不写道歉段，不回显卡号。
`

/** 公司 v1.1：把"退换货判定"改名为"退换货规则"，正文不动。 */
export const CUSTOMER_CARE_V1_1 = `---
name: customer-care
description: 售后客服说明书
---

## 回答顺序

先说记录显示什么，再说条款怎么说，最后说下一步。

## 退换货规则

按记录状态 + 送达日 + 今天 vs 条款窗口算。

## 额度与策略

单笔补偿不超过 50 元，超过要走审批。

## 禁止事项

不发明补偿，不写道歉段，不回显卡号。
`

export function headingId(
  sections: readonly { id: string; heading: string }[],
  heading: string,
): string {
  const hit = sections.find((s) => s.heading === heading)
  if (hit === undefined) throw new Error(`测试夹具里没有段：${heading}`)
  return hit.id
}
