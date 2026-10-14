/**
 * WP319 ③（Luoye 10-14 Windows 真机）：独立站岗位「店铺管理」下「查询店铺当前在售产品」一直挂在「进行中」，
 * 旁边是原始错误「dsh 组合装配失败：…unsupported …」——10-09 热修之前跑的那一轮，当时的版本只记了「跑完了」。
 *
 * 开机自检（`repairStuckRuns`）：最近一轮没收尾的事项按本机事件日志补一句「没跑成」+ 重试；
 * 摘要里的原始错误换成人话；跑到一半被关 / 被更新的也补；说不清的不动；幂等。
 */
import type { MatterEvent, RunId } from '@agentsws/contracts'
import { createWork, type Work } from '@agentsws/work'
import { beforeEach, describe, expect, it } from 'vitest'
import { matterRunStateOf, openMatterPhase } from '../src/position-work.js'
import { INTERNAL_FAILURE_TEXT } from '../src/run-failure.js'
import { INTERRUPTED_FAILURE_TEXT, type RunRepairPort, repairStuckRuns } from '../src/run-repair.js'

const T0 = '2026-10-09T02:00:00.000Z'
const RAW = 'dsh 组合装配失败：tools[3].input_schema: unsupported keyword "minimum"'

let work: Work
let runLog: Map<string, { type: string; payload: unknown }[]>

const portOf = (): RunRepairPort => ({
  openMatters: () => work.listMatters({ status: ['open', 'waiting'], archived: false }),
  timeline: (id) => work.store.listMatterEvents(id, { limit: 40 }),
  runEvents: (run_id) => runLog.get(run_id) ?? [],
  append: (id, e) => {
    work.appendEvent(id, e)
  },
  setSummary: (m, summary) => {
    work.store.putMatter({ ...m, context: { ...m.context, summary } })
  },
})

/** 一件事项 + 一轮运行，时间线照老版本（10-09 之前）记的那样：「开始跑了」「跑完了」，摘要是原文。 */
function legacyRun(title: string, run_id: string, summary = RAW) {
  const m = work.createMatter({ kind: 'project', title })
  const actor: MatterEvent['actor'] = { kind: 'agent', id: 'asg_store' }
  work.appendEvent(m.id, { kind: 'run', text: '开始跑了', actor, run_id: run_id as RunId })
  work.appendEvent(m.id, { kind: 'status', text: '跑完了', actor, run_id: run_id as RunId })
  work.updateSummary(m.id, { run_summary: summary, run_id: run_id as RunId })
  return m
}

const stateOf = (id: string) =>
  matterRunStateOf(work.store.listMatterEvents(id as never, { limit: 40 }), false)

beforeEach(() => {
  work = createWork({ workspace_id: 'ws_wp319' as never, clock: { now: () => T0 } })
  runLog = new Map()
})

describe('WP319 ③ 开机自检：挂在「进行中」的没跑成', () => {
  it('老版本没跑成（事件日志有 run.failed）→ 补「没跑成：人话」+ 重试，摘要换成人话，分组从进行中变卡住', () => {
    const m = legacyRun('查询店铺当前在售产品', 'run_old')
    runLog.set('run_old', [
      { type: 'run.started', payload: {} },
      { type: 'run.failed', payload: { error: { code: 'internal', message: RAW } } },
    ])
    // 修之前：分组是「进行中」
    expect(openMatterPhase(stateOf(m.id), 0).group).toBe('doing')

    const fixed = repairStuckRuns(portOf())
    expect(fixed).toEqual([{ matter_id: m.id, run_id: 'run_old', why: 'failed' }])
    const last = work.store.listMatterEvents(m.id).at(-1)
    expect(last).toMatchObject({
      kind: 'status',
      text: `没跑成：${INTERNAL_FAILURE_TEXT}`,
      run_id: 'run_old',
      failed: { code: 'internal', retryable: true },
    })
    // 原始错误不进时间线、不留在摘要里
    expect(work.getMatter(m.id)?.context.summary).toBe(INTERNAL_FAILURE_TEXT)
    expect(JSON.stringify(work.store.listMatterEvents(m.id))).not.toContain('input_schema')
    expect(stateOf(m.id).last?.outcome).toBe('failed')
    expect(openMatterPhase(stateOf(m.id), 0).group).toBe('stuck')

    // 幂等：再扫一遍一条都不补
    expect(repairStuckRuns(portOf())).toEqual([])
    expect(work.store.listMatterEvents(m.id).filter((e) => e.failed !== undefined)).toHaveLength(1)
  })

  it('跑到一半应用被关 / 被更新重启（只有开跑、没有收尾）→ 补「没跑成：上次没跑完…」', () => {
    const m = work.createMatter({ kind: 'project', title: '把首页改一版' })
    work.appendEvent(m.id, {
      kind: 'run',
      text: '开始跑了',
      actor: { kind: 'agent', id: 'asg_site' },
      run_id: 'run_cut' as RunId,
    })
    runLog.set('run_cut', [
      { type: 'run.started', payload: {} },
      { type: 'tool.call', payload: {} },
    ])
    expect(repairStuckRuns(portOf())).toEqual([
      { matter_id: m.id, run_id: 'run_cut', why: 'interrupted' },
    ])
    expect(work.store.listMatterEvents(m.id).at(-1)).toMatchObject({
      text: `没跑成：${INTERRUPTED_FAILURE_TEXT}`,
      failed: { code: 'interrupted', retryable: true },
    })
    expect(openMatterPhase(stateOf(m.id), 0).group).toBe('stuck')
  })

  it('说不清的不动：跑完了只是没说话 / 事件日志里查不到 / 已经收了尾', () => {
    const done = legacyRun('出了一张卡就收了', 'run_done', '出了一张卡')
    runLog.set('run_done', [{ type: 'run.completed', payload: {} }])
    legacyRun('日志里查不到', 'run_gone')
    const answered = work.createMatter({ kind: 'project', title: '答完了' })
    work.appendEvent(answered.id, {
      kind: 'agent_message',
      text: '查完了。',
      actor: { kind: 'agent', id: 'asg_store' },
      run_id: 'run_ok' as RunId,
    })
    runLog.set('run_ok', [{ type: 'run.started', payload: {} }])
    expect(repairStuckRuns(portOf())).toEqual([])
    expect(work.getMatter(done.id)?.context.summary).toBe('出了一张卡')
  })

  it('关了的事项不扫', () => {
    const m = legacyRun('已经关了', 'run_closed')
    runLog.set('run_closed', [{ type: 'run.failed', payload: { error: { code: 'internal' } } }])
    work.closeMatter(m.id, { unfinished: 'close_all' })
    expect(repairStuckRuns(portOf())).toEqual([])
  })
})

describe('WP319 ③ 真装配线：重开应用时自检补上', () => {
  it('上一次开着时留下的老事项 → 重开后时间线有「没跑成」、分组不再是进行中', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createServer } = await import('../src/index.js')
    const dbDir = mkdtempSync(join(tmpdir(), 'agentsws-wp319-'))
    const opts = {
      clock: { now: () => T0 },
      quiet: true,
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      dbDir,
    }
    try {
      const first = await createServer(opts)
      const ws = first.bootstrap.workspace.id
      const m = first.work.createMatter({ kind: 'project', title: '查询店铺当前在售产品' })
      const actor: MatterEvent['actor'] = { kind: 'agent', id: 'asg_store' }
      first.work.appendEvent(m.id, {
        kind: 'run',
        text: '开始跑了',
        actor,
        run_id: 'run_legacy' as RunId,
      })
      first.work.appendEvent(m.id, {
        kind: 'status',
        text: '跑完了',
        actor,
        run_id: 'run_legacy' as RunId,
      })
      first.work.updateSummary(m.id, { run_summary: RAW, run_id: 'run_legacy' as RunId })
      first.kernel.eventLog.appendSync({
        schema_version: 1,
        workspace_id: ws,
        type: 'run.failed',
        actor: { kind: 'agent', id: 'asg_store', run_id: 'run_legacy' as RunId },
        correlation: { trace_id: 'trc_run_legacy', run_id: 'run_legacy' as RunId },
        payload: { error: { code: 'internal', message: RAW, retryable: false } },
      })
      await first.close()

      const again = await createServer(opts)
      const events = again.work.store.listMatterEvents(m.id)
      expect(events.at(-1)).toMatchObject({ text: `没跑成：${INTERNAL_FAILURE_TEXT}` })
      expect(again.work.getMatter(m.id)?.context.summary).toBe(INTERNAL_FAILURE_TEXT)
      await again.close()
    } finally {
      rmSync(dbDir, { recursive: true, force: true })
    }
  })
})
