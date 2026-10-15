// @vitest-environment jsdom
/**
 * WP316（docs/101 §5.1② ③，决策 600 C）：接线要的几种新走法，在本地假后台上走一遍（不联网、不碰真站）。
 *
 * - 上传表的「读回」版：提交后当场核「已应用 / 已发布」，再导出一份 `result` 给本机逐行比；
 * - 止损：停前停后各导出一份；截不到图也先停住，结果里记「没截到」；不等人去点插件图标；
 * - 只导出改前表（读操作，不要审批编号）；
 * - Google 撤销上一次上传（只能一次）；Meta 没有这一按钮，拼计划时就说清楚。
 */
import { describe, expect, it } from 'vitest'
import {
  type ActionJob,
  type AdsAction,
  buildAdsJob,
  type EvidenceTag,
  type RunHooks,
  runAction,
  sheetFingerprint,
  validateJob,
} from '../src/index.js'
import { FakePage, type FakeState, fakeState } from './fake-site.js'

const BYTES = new TextEncoder().encode('Campaign,Status\nSpring,Paused\n')
const google = { platform: 'google_ads' as const, id: '123-456-7890', ocid: '42' }
const meta = { platform: 'meta_ads' as const, id: 'act_999' }

function job(account: typeof google | typeof meta, action: AdsAction): ActionJob {
  return buildAdsJob({
    id: 'j',
    workspace_id: 'ws_1',
    account,
    action,
    approval_id: 'ap_1',
    approval_level: 'L1',
    created_at: '2026-10-15T09:00:00.000Z',
  })
}

async function run(j: ActionJob, state: FakeState) {
  const page = new FakePage(state)
  const evidence: EvidenceTag[] = []
  const downloads: string[] = []
  const h: RunHooks = {
    sheet: async () => ({ name: 'upload.csv', mime: 'text/csv', bytes: BYTES }),
    progress: async () => ({ stop: false }),
    stopped: () => false,
    confirm: async () => 'yes',
    evidence: async (tag) => {
      evidence.push(tag)
    },
    downloaded: async (tag) => {
      downloads.push(tag)
    },
    sleep: async () => undefined,
  }
  const result = await runAction(j, page, h)
  return { result, page, evidence, downloads }
}

const sheet = async (name = 'upload.csv', mime = 'text/csv') => ({
  name,
  mime,
  fingerprint: await sheetFingerprint(BYTES),
  bytes: BYTES.length,
})

describe('上传表的读回版', () => {
  it('Google：提交后当场核「已应用」，再导出一份改后表（result）', async () => {
    const j = job(google, { kind: 'upload_sheet', sheet: await sheet(), readback: true })
    expect(validateJob(j, { zones: {} as never }).ok).toBe(true)
    const out = await run(j, fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.downloads).toEqual(['snapshot', 'result'])
    expect(out.evidence).toEqual(['preview', 'after'])
  })

  it('Google：点了应用平台却没生效 → 当场等不到「已应用」，停下交给人，不往下导出', async () => {
    const j = job(google, { kind: 'upload_sheet', sheet: await sheet(), readback: true })
    const out = await run(j, fakeState({ applyNoop: true }))
    expect(out.result.outcome).toBe('handover')
    expect(out.downloads).toEqual(['snapshot'])
  })

  it('Meta：粘贴 → 发布 → 当场核「已发布」→ 导出 result', async () => {
    const j = job(meta, { kind: 'upload_sheet', sheet: await sheet(), readback: true })
    const out = await run(j, fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.downloads).toEqual(['snapshot', 'result'])
  })

  it('不开读回的老走法一步没变', async () => {
    const j = job(google, { kind: 'upload_sheet', sheet: await sheet() })
    expect(j.plan.steps.some((s) => s.op === 'download' && s.tag === 'result')).toBe(false)
    expect(j.plan.verify.op).toBe('present')
  })
})

describe('止损（决策 600 C）', () => {
  for (const [label, account, id] of [
    ['Google', google, '111'],
    ['Meta', meta, '222'],
  ] as const) {
    it(`${label}：停前停后各导出一份；截得到就截`, async () => {
      const j = job(account, {
        kind: 'pause',
        entity: { level: 'campaign', id, name: '春季' },
        stop_loss: true,
      })
      const out = await run(j, fakeState({ status: { [id]: 'Enabled' } }))
      expect(out.result.outcome).toBe('done')
      expect(out.downloads).toEqual(['snapshot', 'result'])
      expect(out.evidence).toEqual(['before', 'after'])
      expect(out.result.reads.evidence_missing).toBeUndefined()
      expect(out.page.state.status[id]).toBe('Paused')
      // 可选截图不等人去点插件图标授权
      expect(out.page.captureOpts.every((o) => o?.quick === true)).toBe(true)
    })

    it(`${label}：截不到图也先停住，记「没截到」，前后导出照样有`, async () => {
      const j = job(account, {
        kind: 'pause',
        entity: { level: 'campaign', id },
        stop_loss: true,
      })
      const out = await run(j, fakeState({ status: { [id]: 'Enabled' }, captureFails: true }))
      expect(out.result.outcome).toBe('done')
      expect(out.page.state.status[id]).toBe('Paused')
      expect(out.result.reads.evidence_missing).toBe('before,after')
      expect(out.downloads).toEqual(['snapshot', 'result'])
    })
  }

  it('不是止损的暂停：截不到图就停下交给人（老规矩不变）', async () => {
    const j = job(google, { kind: 'pause', entity: { level: 'campaign', id: '111' } })
    const out = await run(j, fakeState({ captureFails: true }))
    expect(out.result.outcome).toBe('handover')
    expect(out.page.state.status['111']).toBe('Enabled')
  })
})

describe('只导出改前表 / 撤销', () => {
  it('只导出改前表是读操作：不带审批编号也进得了队', () => {
    const j = buildAdsJob({
      id: 'x',
      workspace_id: 'ws_1',
      account: meta,
      action: { kind: 'export_snapshot' },
      created_at: '2026-10-15T09:00:00.000Z',
    })
    expect(j.plan.pace).toBe('read')
    expect(validateJob(j, { zones: {} as never }).ok).toBe(true)
  })

  it('Google 撤销上一次上传：点那一行的「撤销」、确认、读回「已撤销」', async () => {
    const j = job(google, { kind: 'undo_upload', upload_name: 'agentsws-campaigns.csv' })
    const state = fakeState({
      history: { 'agentsws-campaigns.csv': 'Applied', 'other.csv': 'Applied' },
    })
    const out = await run(j, state)
    expect(out.result.outcome).toBe('done')
    expect(state.history).toEqual({ 'agentsws-campaigns.csv': 'Undone', 'other.csv': 'Applied' })
    expect(out.evidence).toEqual(['before', 'after'])
  })

  it('Google 撤销：那一行已经撤过 / 找不到 → 停下交给人', async () => {
    const j = job(google, { kind: 'undo_upload', upload_name: 'agentsws-campaigns.csv' })
    const out = await run(j, fakeState({ history: {} }))
    expect(out.result.outcome).toBe('handover')
  })

  it('文件名里有引号这类字 → 拼计划时就拒（它要拼进选择器）', () => {
    expect(() => job(google, { kind: 'undo_upload', upload_name: 'a"] b' })).toThrow()
  })

  it('Meta 没有一键撤销导入：拼计划时说清楚', () => {
    expect(() => job(meta, { kind: 'undo_upload', upload_name: 'x.csv' })).toThrow(/反向导入/)
  })
})
