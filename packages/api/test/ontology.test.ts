/**
 * 47 J1 数据地图的读面：`GET /v1/positions/:id/ontology`。
 *
 * 四条断言，对着 47 的四条纪律：
 * 1. **按岗位裁剪**：只回这条岗位有 read 权限的对象；
 * 2. **只读**：没有写口，回的是目录不是数据（没有任何 id 级的记录）；
 * 3. **权限照旧**：看别人那条要策略层读权限，不存在的分配是 404；
 * 4. **不是新的存储**：两次请求一模一样（登记表是生成物，不随请求变）。
 */
import type { TailoredOntology } from '@agentsws/ontology/view'
import { describe, expect, it } from 'vitest'
import { harness } from './helpers.js'

const json = async <T>(res: Response): Promise<T> =>
  ((await res.json()) as { data: T; trace_id: string }).data

describe('47 J1 GET /v1/positions/:id/ontology', () => {
  it('按岗位裁剪：列出看得到的对象，带真源 / 新鲜度 / 范围', async () => {
    const h = await harness()
    const map = await json<TailoredOntology>(
      await h.get(`/v1/positions/${h.assignment.id}/ontology`),
    )
    expect(map.assignment_id).toBe(h.assignment.id)
    const ids = map.objects.map((o) => o.id)
    // helpers 里这条岗位有 order（assigned）与 knowledge（workspace）的读权限
    expect(ids).toContain('order')
    expect(ids).toContain('fact_card')
    const order = map.objects.find((o) => o.id === 'order')
    expect(order?.source_of_truth).toBe('platform_api')
    expect(order?.read_range).toBe('assigned')
    expect(order?.freshness).toMatch(/^cached:\d+$/)
    expect(map.objects.find((o) => o.id === 'fact_card')?.read_range).toBe('workspace')
  })

  it('看不到的对象一条都不出（裁剪只做减法）', async () => {
    const h = await harness()
    const map = await json<TailoredOntology>(
      await h.get(`/v1/positions/${h.assignment.id}/ontology`),
    )
    for (const o of map.objects) expect(o.read_range).toBeDefined()
    // 链接两端都必须是他看得见的对象
    const visible = new Set(map.objects.map((o) => o.id))
    for (const l of map.links) {
      expect(visible.has(l.from)).toBe(true)
      expect(visible.has(l.to)).toBe(true)
    }
  })

  it('是目录不是数据：一条业务记录都不带', async () => {
    const h = await harness()
    const res = await h.get(`/v1/positions/${h.assignment.id}/ontology`)
    const text = await res.text()
    // 登记表里只有对象类型与动作 id，不该出现任何具体记录的 id
    expect(text).not.toContain('ord_')
    expect(text).not.toContain('ap_')
  })

  it('不存在的分配是 404', async () => {
    const h = await harness()
    const res = await h.get('/v1/positions/asg_nope/ontology')
    expect(res.status).toBe(404)
  })

  it('登记表是生成物：同一条岗位两次请求一模一样', async () => {
    const h = await harness()
    const a = await json<TailoredOntology>(await h.get(`/v1/positions/${h.assignment.id}/ontology`))
    const b = await json<TailoredOntology>(await h.get(`/v1/positions/${h.assignment.id}/ontology`))
    expect(b).toEqual(a)
  })
})
