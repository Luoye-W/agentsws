import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { listFiles, loadPack, synth } from '../src/index.js'
import { PACK_DIR } from './helpers.js'

const temps: string[] = []
const tempDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'agentsws-synth-'))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

describe('合成公司生成器（26 §2）', () => {
  it('固定 seed 可复现：两次生成逐字节相同', () => {
    const a = synth({ pack: 'dtc-3c', people: 3, orders: 50, seed: 42, out: tempDir() })
    const b = synth({ pack: 'dtc-3c', people: 3, orders: 50, seed: 42, out: tempDir() })
    expect([...b.files.keys()]).toEqual([...a.files.keys()])
    for (const [rel, content] of a.files) expect(b.files.get(rel), rel).toBe(content)
    // 落盘的也一样
    for (const rel of a.files.keys()) {
      expect(readFileSync(join(b.dir, rel), 'utf8'), rel).toBe(
        readFileSync(join(a.dir, rel), 'utf8'),
      )
    }
  })

  it('换 seed 换数据（否则"可复现"是废话）', () => {
    const a = synth({ seed: 42, out: tempDir() })
    const b = synth({ seed: 7, out: tempDir() })
    expect(b.files.get('store/orders.yml')).not.toBe(a.files.get('store/orders.yml'))
    // 场景要用的固定订单不受 seed 影响
    for (const id of ['ord_1001', 'ord_1002', 'ord_1003', 'ord_1004']) {
      expect(a.files.get('store/orders.yml')).toContain(id)
      expect(b.files.get('store/orders.yml')).toContain(id)
    }
  })

  it('规模参数化', () => {
    const small = synth({ orders: 10, out: tempDir() })
    const orders = small.files.get('store/orders.yml') ?? ''
    // `--orders N` = 生成 N 张 DTC 订单；WP55 的那张 Amazon 订单（`ord_1101`）是
    // **追加**上去的，不占 N 的名额——占了名额就得少生成一张，46 张既有订单的
    // 取样会整体前移，等于为了加一条题去改所有人的数据。
    expect(orders.match(/^- id: ord_/gm)?.length).toBe(10 + 1)
    expect(orders).toContain('ord_1101')
    expect(() => synth({ orders: 2, out: tempDir() })).toThrow()
    expect(() => synth({ people: 1, out: tempDir() })).toThrow()
    expect(() => synth({ pack: 'amz-10p', out: tempDir() })).toThrow(/dtc-3c/)
  })

  it('仓库里提交的 pack 就是 seed 42 / 50 单跑出来的那份', () => {
    const fresh = synth({ pack: 'dtc-3c', people: 3, orders: 50, seed: 42, out: tempDir() })
    for (const [rel, content] of fresh.files) {
      expect(readFileSync(join(PACK_DIR, rel), 'utf8'), rel).toBe(content)
    }
  })

  it('生成器不动 scenarios/ 与 baseline.json（人写的题与跑出来的基线）', () => {
    const fresh = synth({ out: tempDir() })
    expect([...fresh.files.keys()].some((f) => f.startsWith('scenarios/'))).toBe(false)
    expect(fresh.files.has('baseline.json')).toBe(false)
    // 而仓库里的 pack 两样都有
    // WP64 + WP63：22 + 邮件营销与订单履约各一条 + 店铺管理与内容三条；
    // WP67 加红人三条（30）；WP68 再加两条（campaign 不并集权限 / 公共库计费）；
    // WP72 再加三条（发布永远人审 / 回评论承诺词被拦 / 群里的客户问题转客服）；
    // WP78 再加三条（外部发帖过版规 / 负面提及分流 / 新闻稿数字只引事实卡）
    // WP89 再加一条（建站：改副本 → 推未发布 → 提议发布 → 卡）→ 51
    expect(listFiles(join(PACK_DIR, 'scenarios'), '.yml').length).toBe(51)
    expect(statSync(join(PACK_DIR, 'baseline.json')).isFile()).toBe(true)
  })

  it('pack 体积控制在 1MB 内', () => {
    const total = listFiles(PACK_DIR).reduce((n, f) => n + statSync(f).size, 0)
    expect(total).toBeLessThan(1024 * 1024)
  })

  it('毒样本必配 should-serve 对照，缺了就加载失败', () => {
    const dir = tempDir()
    synth({ out: dir })
    const pack = loadPack(dir)
    const poison = pack.threads.filter((t) => t.poison === true)
    expect(poison.length).toBeGreaterThan(0)
    for (const p of poison) {
      expect(
        pack.threads.some((t) => t.control_of === p.id),
        p.id,
      ).toBe(true)
    }
    rmSync(join(dir, 'threads', 'thr_control_1001.yml'))
    expect(() => loadPack(dir)).toThrow(/对照/)
  })

  it('生成的 pack 能被 loadPack 读成一家完整的公司', () => {
    const dir = tempDir()
    synth({ out: dir })
    const pack = loadPack(dir)
    expect(pack.workspace.id).toBe('ws_dtc3c')
    expect(pack.people).toHaveLength(3)
    expect(pack.assignments.filter((a) => a.primary === true)).toHaveLength(1)
    // 50 张生成订单 + WP55 追加的那张 Amazon 订单（见「规模参数化」那条的注释）
    expect(pack.orders).toHaveLength(51)
    expect(pack.customers.length).toBeGreaterThanOrEqual(20)
    // 三层知识都有（WP56 加了第二条 fact：源页派生的保修期，给复核场景用）
    expect(pack.knowledge.map((k) => k.layer).sort()).toEqual([
      'fact',
      'fact',
      'phrasing',
      'policy',
    ])
    expect(pack.knowledge.find((k) => k.layer === 'fact')?.body).toContain('14 days')
    expect(pack.knowledge.find((k) => k.layer === 'fact')?.body).toContain('14 天')
    // mock provider 的初始状态从 store/* 来
    const state = pack.mockState()
    expect(state.orders.find((o) => o.id === 'ord_1001')?.email).toBe('anna@example.com')
    expect(state.threads.length).toBe(pack.threads.length)
    // fixtures 可按 body_ref 取
    expect(pack.fixtures.get('fixtures/anna-return.txt')).toContain('#1001')
  })

  it('anchor 决定订单日期（时间不来自 Date.now）', () => {
    const a = synth({ out: tempDir(), anchor: '2030-01-01T00:00:00.000Z' })
    expect(a.files.get('store/orders.yml')).toContain('2029-12-29T00:00:00.000Z')
    expect(() => synth({ out: tempDir(), anchor: 'nope' })).toThrow()
  })
})
