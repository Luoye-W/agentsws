/**
 * 52 O1 / O2（WP65）：同一家公司的两个品牌互相看不见。
 *
 * 场景那一条（`org/two-brands-cannot-see-each-other`）保证它跑得通、不变量全绿；
 * 这一条钉的是**数字本身**——站在甲品牌看，乙品牌的卡 / 事实卡 / 店铺连接 /
 * 模型设置一条都不出，而且这是在五个**不同的真库**上同时成立的。
 *
 * WP66 加的是后两样：连接的凭据与模型设置在这一版之前是"一台机器一份"，
 * 所以那时候这一格没得验；现在它们按 `workspace_id` 存了，才轮得到这条题。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadPack } from '../src/pack.js'
import { createWorld } from '../src/world.js'
import { REPO_ROOT } from './helpers.js'

const PACK_15 = join(REPO_ROOT, 'packs', 'dtc-15p')

describe('52 O2 两个品牌互相看不见', () => {
  it('五个库（分配 / 卡 / 事实卡 / 店铺连接 / 模型设置）各自按 workspace_id 切', async () => {
    const world = await createWorld({
      pack: loadPack(PACK_15),
      seed: 42,
      start: '2026-09-15T09:00:00.000Z',
    })
    try {
      const a = await world.org.brand({
        id: 'ws_brand_a',
        name: '诺伏特户外',
        who: 'p_li',
        role: 'dtc.store',
        seed: {
          card: '甲品牌的一封回信',
          fact: '甲品牌退货 14 天',
          connection: '甲的店',
          model: '甲的 DeepSeek',
        },
      })
      const b = await world.org.brand({
        id: 'ws_brand_b',
        name: '诺伏特课程',
        who: 'p_li',
        role: 'dtc.support',
        seed: {
          card: '乙品牌的一封回信',
          fact: '乙品牌七天无理由',
          connection: '乙的店',
          model: '乙的 Kimi',
        },
      })

      // 同一个人两边都有岗位，但各是各的那一条
      expect(a.positions).toEqual(['dtc.store'])
      expect(b.positions).toEqual(['dtc.support'])

      // 甲品牌里只有甲的那一套
      expect(a.cards).toEqual(['甲品牌的一封回信'])
      expect(a.facts).toEqual(['甲品牌退货 14 天'])
      expect(a.connections).toEqual(['conn_ws_brand_a'])
      // WP66：模型设置也是这个品牌自己的一份
      expect(a.models).toEqual(['甲的 DeepSeek'])
      // 凭据在库里的名字带着品牌前缀（只有名字，没有值）
      expect(a.credential_keys).toEqual([
        'ws:ws_brand_a/conn:conn_ws_brand_a',
        'ws:ws_brand_a/model_provider:mp_ws_brand_a',
      ])

      // 建完乙之后再看一眼甲：一条都没多出来（**不是"排在后面"，是不存在**）
      const againA = await world.org.brandVisible('ws_brand_a', 'p_li')
      expect(againA).toEqual(a)

      // 乙品牌里只有乙的那一套
      expect(b.cards).toEqual(['乙品牌的一封回信'])
      expect(b.facts).toEqual(['乙品牌七天无理由'])
      expect(b.connections).toEqual(['conn_ws_brand_b'])
      expect(b.models).toEqual(['乙的 Kimi'])

      // 两边的内容没有一个字重叠（凭据的 key 名也一样）
      for (const key of ['cards', 'facts', 'connections', 'models', 'credential_keys'] as const) {
        expect(a[key].filter((x) => b[key].includes(x))).toEqual([])
      }

      // 公司那个工作区也看不见这两个品牌里的任何东西
      const company = await world.org.brandVisible(world.workspace_id, 'p_li')
      expect(company.cards.filter((c) => c.includes('品牌的一封回信'))).toEqual([])
      expect(company.connections).toEqual([])
      expect(company.models).toEqual([])
      expect(company.credential_keys).toEqual([])
    } finally {
      await world.close()
    }
  })
})
