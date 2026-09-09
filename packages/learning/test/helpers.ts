import type { Clock, Iso8601 } from '@agentsws/contracts'
import { createSkills, type Skills } from '@agentsws/skills'
import type { ExtractInput } from '../src/extract.js'
import type { SkillReader } from '../src/proposals.js'

export class TestClock implements Clock {
  #ms: number
  constructor(start: Iso8601 = '2026-09-07T09:00:00.000Z') {
    this.#ms = Date.parse(start)
  }
  now(): Iso8601 {
    return new Date(this.#ms).toISOString()
  }
  advance(ms: number): void {
    this.#ms += ms
  }
}

/** seed 化的 id 工厂：测试里 id 必须可预期。 */
export function counterIds(prefix = 'les'): () => string {
  let n = 0
  return () => {
    n += 1
    return `${prefix}_${String(n).padStart(4, '0')}`
  }
}

export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export const SKILL_MD = `---
name: customer-care
description: 售后客服技能
---

## 退货窗口计算

收到退货请求先算窗口：以送达日为起点，14 天内可退。

## 回信语气

先确认收到，再讲条款，最后给下一步。
`

export interface Fixture {
  skills: Skills
  clock: TestClock
  reader: SkillReader
  sections: { id: string; heading: string; body: string }[]
}

export async function fixture(): Promise<Fixture> {
  const clock = new TestClock()
  const skills = createSkills({ clock, random: seeded(42) })
  await skills.registry.putFromMarkdown({
    markdown: SKILL_MD,
    tier: 'company',
    owner: 'p_owner',
    version: '1.4',
    workspace_id: 'ws_1',
  })
  const sections = skills.registry.listSections('customer-care')
  return {
    skills,
    clock,
    sections: sections.map((s) => ({ id: s.id, heading: s.heading, body: s.body })),
    reader: { sections: (name) => skills.registry.listSections(name) },
  }
}

export function extractInput(over: Partial<ExtractInput> = {}): ExtractInput {
  return {
    workspace_id: 'ws_1',
    assignment_id: 'asg_1',
    run_id: 'run_0001',
    at: '2026-09-07T10:00:00.000Z',
    applies_to: { skill: 'customer-care' },
    ...over,
  }
}
