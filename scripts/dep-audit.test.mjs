/**
 * 周报「依赖安全公告」那一节的用例（WP368）。不出网：`pnpm audit` 的两份 JSON 全是手写的替身。
 */

import { describe, expect, it } from 'vitest'

import {
  alarming,
  auditHints,
  classifyAudit,
  observeDepAudit,
  renderAuditSection,
} from './dep-audit.mjs'
import { parseArgs, renderReport } from './upstream-watch.mjs'

const adv = (module, severity, paths, extra = {}) => ({
  module_name: module,
  severity,
  github_advisory_id: `GHSA-${module}`,
  title: `${module} 出事了`,
  vulnerable_versions: '<9.0.0',
  patched_versions: '>=9.0.0',
  findings: [{ version: '1.0.0', paths }],
  ...extra,
})
const audit = (...list) => ({ advisories: Object.fromEntries(list.map((a, i) => [i + 1, a])) })

// 运行时的、只在静态官网构建里的、只在开发依赖里的，各一条
const prod = audit(
  adv('compression', 'high', ['packages__dsh-adapter>@deepseek-ai/dsh>compression']),
  adv('sharp', 'high', ['apps__site>astro>sharp']),
)
const all = audit(
  adv('compression', 'high', [
    'packages__dsh-adapter>@deepseek-ai/dsh>compression',
    '.>vitest>compression',
  ]),
  adv('sharp', 'high', ['apps__site>astro>sharp']),
  adv('tinypool', 'critical', ['.>vitest>tinypool']),
)

describe('分组', () => {
  it('运行时 / 构建期 / 开发期各归各的，同一条只出现一次', () => {
    const r = classifyAudit(prod, all)
    expect(r.runtime.map((a) => a.module)).toEqual(['compression'])
    expect(r.build.map((a) => a.module)).toEqual(['sharp'])
    expect(r.dev.map((a) => a.module)).toEqual(['tinypool'])
  })

  it('运行时那条只留运行时的路径（开发依赖那条不算）', () => {
    expect(classifyAudit(prod, all).runtime[0].paths).toEqual([
      'packages__dsh-adapter>@deepseek-ai/dsh>compression',
    ])
  })

  it('同一个包的一条公告，只要有一条路径不在构建期名单里就算运行时', () => {
    const p = audit(
      adv('braces', 'high', ['apps__workstation>shadcn>braces', 'packages__data>x>braces']),
    )
    const r = classifyAudit(p, p)
    expect(r.runtime.map((a) => a.module)).toEqual(['braces'])
    expect(r.runtime[0].paths).toEqual(['packages__data>x>braces'])
  })

  it('同一个 GHSA 分几段受影响范围（brace-expansion 那种）分开算', () => {
    const a = adv('brace-expansion', 'high', ['packages__data>m>brace-expansion'])
    const b = {
      ...a,
      vulnerable_versions: '<2.1.6',
      findings: [{ version: '2.1.4', paths: a.findings[0].paths }],
    }
    expect(classifyAudit(audit(a, b), audit(a, b)).runtime).toHaveLength(2)
  })

  it('按严重程度排：严重在前', () => {
    const p = audit(
      adv('a', 'moderate', ['apps__server>a']),
      adv('b', 'critical', ['apps__server>b']),
    )
    expect(classifyAudit(p, p).runtime.map((a) => a.severity)).toEqual(['critical', 'moderate'])
  })

  it('只有运行时的严重 / 高危才报警', () => {
    const p = audit(adv('a', 'moderate', ['apps__server>a']), adv('b', 'high', ['apps__server>b']))
    expect(alarming(classifyAudit(p, all)).map((a) => a.module)).toEqual(['b'])
  })
})

describe('取数', () => {
  it('两次 audit 都成才分组；任一次查不到整节写查不到', () => {
    const ok = observeDepAudit(({ prod: p }) => ({ json: p ? prod : all }))
    expect(ok.errors).toEqual([])
    expect(ok.runtime).toHaveLength(1)
    const bad = observeDepAudit(({ prod: p }) => (p ? { json: prod } : { error: 'registry 403' }))
    expect(bad.errors).toEqual(['registry 403'])
    expect(renderAuditSection(bad).join('\n')).toContain('查不到 ≠ 没有')
  })
})

describe('周报里的那一节', () => {
  const opts = { scope: 'weekly', windowDays: 7, now: new Date('2026-10-16T00:00:00Z') }
  const obs = () => ({ id: 'dsh', item: { id: 'dsh', kind: 'runtime-dep' }, errors: [] })
  const depAudit = { errors: [], ...classifyAudit(prod, all) }

  it('运行时的进表、报警；构建期 / 开发期收在折叠里', () => {
    const md = renderAuditSection(depAudit).join('\n')
    expect(md).toContain('**运行时**（会跟着软件跑到用户机器上的）：高危 1')
    expect(md).toMatch(/<details><summary>构建期 1 条 · 开发期 1 条（碰不到用户，不报警）/)
    expect(md.indexOf('compression')).toBeLessThan(md.indexOf('<details>'))
    expect(md.indexOf('tinypool')).toBeGreaterThan(md.indexOf('<details>'))
  })

  it('提示里同一个包合成一行，只为运行时的出声', () => {
    const hints = auditHints(depAudit)
    expect(hints.filter((l) => l.includes('compression@'))).toHaveLength(1)
    expect(hints.join('\n')).not.toContain('tinypool')
    expect(auditHints({ errors: [], runtime: [], build: [], dev: [] })).toEqual([])
  })

  it('renderReport 带上它：摘要表一行 + 一节 + 提示', () => {
    const md = renderReport([obs()], { ...opts, depAudit })
    expect(md).toContain('| 运行时依赖安全公告（严重 / 高危） | `compression` |')
    expect(md).toContain('## 依赖安全公告')
    expect(md).toContain('运行时依赖 `compression@1.0.0` 有高危公告')
  })

  it('摘要表里同一个包只写一次', () => {
    const a = adv('brace-expansion', 'high', ['packages__data>m>brace-expansion'])
    const b = { ...a, github_advisory_id: 'GHSA-other' }
    const twice = { errors: [], ...classifyAudit(audit(a, b), audit(a, b)) }
    const md = renderReport([obs()], { ...opts, depAudit: twice })
    expect(md).toContain('| 运行时依赖安全公告（严重 / 高危） | `brace-expansion` |')
  })

  it('没带（daily / --no-audit）就一个字都不出', () => {
    const md = renderReport([obs()], opts)
    expect(md).not.toContain('依赖安全公告')
    expect(parseArgs(['--no-audit']).noAudit).toBe(true)
    expect(parseArgs([]).noAudit).toBe(false)
  })
})
