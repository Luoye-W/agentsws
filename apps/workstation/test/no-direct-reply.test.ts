/**
 * WP124（修订第 1 条）的可 grep 验收：**「人工直接回复客户」的入口数 = 0**。
 *
 * KefuAgent 在 2026-08-05 把这条路整条拆掉了（`SC-001`），理由是两条：
 * 语言（商家教 AI 用中文，客户多半是外语——接管 = 中文原话直接上客户屏幕）与
 * 学习（接管说的每一句都不产生沉淀）。Luoye 09-19 的修订采了同一刀：
 * 界面上只有「教 AI」，没有「我来接手」的回复框。
 *
 * 这条守卫扫工作台的**界面代码**（pages/ 与 components/）：
 * - 不许出现把商家文本直接当消息发给访客的 API 调用（`setChatTakeover`）；
 * - 不许出现「我来接手 / 人工接管 / 接管回复」这类入口文案。
 * 指导原文的泄漏由 `support-core` 的守卫与测试钉（WP125 + WP124 客户端测试）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..', 'src')
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /setChatTakeover/, why: '接管开关 / 接管 API 不许出现在界面代码里' },
  { pattern: /我来接手/, why: '「我来接手」按钮是被拆掉的路' },
  { pattern: /人工接管/, why: '「人工接管」入口是被拆掉的路' },
  { pattern: /接管回复/, why: '接管式回复框不许出现' },
]

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      yield* walk(full)
      continue
    }
    if (name.endsWith('.tsx') || name.endsWith('.ts')) yield full
  }
}

describe('对客直发入口数 = 0（WP124 修订第 1 条，可 grep 验收）', () => {
  it('工作台界面代码里没有人工直发 / 接管入口', () => {
    const offenders: string[] = []
    for (const dir of ['pages', 'components']) {
      for (const file of walk(join(ROOT, dir))) {
        const text = readFileSync(file, 'utf8')
        // 只扫代码不扫注释：文档里讨论"为什么拆掉接管"是正当的，
        // 入口指的是会出现在界面上的字符串与调用。
        const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
        for (const { pattern, why } of FORBIDDEN) {
          if (pattern.test(code)) offenders.push(`${file}: ${why}`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
