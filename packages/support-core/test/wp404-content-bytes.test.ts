/**
 * WP404：客服两个垂直包（实物 / 数字）的提示原文、规则、意图表从 .ts 挪成数据文件前后，**一个字节不变**。
 *
 * 整包（`goodsPack` / `digitalPack`，含 persona、聊天 / 邮件规则、意图判据、计划、售前）序列化后取哈希，
 * 分块记，红了一眼看出是哪一块。真要改内容：`WP404_WRITE_FIXTURE=1` 重记，PR 里写明为什么。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { digitalPack, goodsPack, type VerticalPack } from '../src/index.js'

const FIXTURE = fileURLToPath(new URL('./fixtures/wp404-content-bytes.json', import.meta.url))
const hash = (v: unknown): string =>
  createHash('sha256')
    .update(
      JSON.stringify(v, (_k, x) =>
        x instanceof RegExp ? `/${x.source}/${x.flags}` : typeof x === 'function' ? String(x) : x,
      ),
      'utf8',
    )
    .digest('hex')
    .slice(0, 16)

function packHashes(pack: VerticalPack): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(pack)) out[k] = hash(v)
  return out
}

describe('WP404 客服垂直包外置前后逐字节相同', () => {
  it('goods / digital 每一块与外置前一致', () => {
    const now = { goods: packHashes(goodsPack), digital: packHashes(digitalPack) }
    if (process.env.WP404_WRITE_FIXTURE === '1' || !existsSync(FIXTURE))
      writeFileSync(FIXTURE, `${JSON.stringify(now, null, 2)}\n`, 'utf8')
    expect(now).toEqual(JSON.parse(readFileSync(FIXTURE, 'utf8')))
  })
})
