/**
 * WP468（决策 1478）：第三栏「浏览器」——分配上没有 `event_log.read` 的（YouTube 红人这类职责），
 * 也能看**自己这条分配发起的那次运行**的浏览器汇总；别的分配发起的照旧 403，不放宽到整个工作区。
 */
import type { RunBrowserView } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import type { BrowserPort } from '../src/routes/browser.js'
import { harness } from './helpers.js'

const VIEW = (run_id: string): RunBrowserView => ({
  run_id,
  executor: 'ego',
  running: false,
  navigations: 0,
  blocked: 0,
})

/** 三次运行：`run_weak` 是 `asg_weak` 发起的，`run_ok` 是 `asg_ok` 的，`run_unknown` 认不出是谁的。 */
const OWNERS: Record<string, string | undefined> = {
  run_weak: 'asg_weak',
  run_ok: 'asg_ok',
  run_unknown: undefined,
}

function port(withOwner = true): { port: BrowserPort; reads: string[] } {
  const reads: string[] = []
  const p: BrowserPort = {
    settings: () => {
      throw new Error('not used')
    },
    setSettings: () => {
      throw new Error('not used')
    },
    probe: () => {
      throw new Error('not used')
    },
    runBrowser: (_actor, run_id) => {
      reads.push(run_id)
      return VIEW(run_id)
    },
    ...(withOwner ? { runAssignment: (_actor, run_id) => OWNERS[run_id] } : {}),
  }
  return { port: p, reads }
}

describe('GET /v1/runs/:id/browser：没有读运行记录的分配只看自己发起的那次', () => {
  it('自己这条分配发起的 → 200，拿到汇总', async () => {
    const h = await harness()
    const { port: p, reads } = port()
    h.deps.browser = p
    const res = await h.get('/v1/runs/run_weak/browser', { assignment: h.weakAssignment.id })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: RunBrowserView }
    expect(body.data.run_id).toBe('run_weak')
    expect(reads).toEqual(['run_weak'])
  })

  it('别的分配发起的 / 认不出是谁的 → 403，汇总一格都不读', async () => {
    const h = await harness()
    const { port: p, reads } = port()
    h.deps.browser = p
    for (const run of ['run_ok', 'run_unknown', 'run_missing']) {
      const res = await h.get(`/v1/runs/${run}/browser`, { assignment: h.weakAssignment.id })
      expect(res.status, run).toBe(403)
      const body = (await res.json()) as { code: string }
      expect(body.code, run).toBe('forbidden')
    }
    expect(reads).toEqual([])
  })

  it('有 event_log.read 的分配照旧：谁发起的都能看（老行为不变）', async () => {
    const h = await harness()
    const { port: p, reads } = port()
    h.deps.browser = p
    for (const run of ['run_ok', 'run_weak', 'run_unknown']) {
      const res = await h.get(`/v1/runs/${run}/browser`)
      expect(res.status, run).toBe(200)
    }
    expect(reads).toEqual(['run_ok', 'run_weak', 'run_unknown'])
  })

  it('服务进程没装配「运行是谁发起的」→ 不放行（老行为）', async () => {
    const h = await harness()
    const { port: p, reads } = port(false)
    h.deps.browser = p
    const res = await h.get('/v1/runs/run_weak/browser', { assignment: h.weakAssignment.id })
    expect(res.status).toBe(403)
    expect(reads).toEqual([])
  })

  it('X-Assignment 不是本人的（拿别人的分配来冒充）→ 照旧在绑定那一层就 403', async () => {
    const h = await harness()
    const { port: p, reads } = port()
    h.deps.browser = p
    const res = await h.get('/v1/runs/run_weak/browser', { assignment: 'asg_foreign' })
    expect(res.status).toBe(403)
    expect(reads).toEqual([])
  })
})
