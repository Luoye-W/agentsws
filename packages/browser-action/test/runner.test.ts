// @vitest-environment jsdom
/**
 * 执行器在本地假后台上走一遍（不联网、不碰真站）。
 * 守的是 docs/101 §4.3 那几条硬规矩：白名单、指纹、被拦就停、不碰的区域、读回自证、随时能停。
 */
import { describe, expect, it } from 'vitest'
import {
  type ActionJob,
  type ActionResult,
  buildAdsJob,
  type ConfirmAnswer,
  type EvidenceTag,
  type RunHooks,
  runAction,
  type SheetRef,
  STEP_GAP_MS,
  sheetFingerprint,
} from '../src/index.js'
import { FakePage, type FakeState, fakeState } from './fake-site.js'

const SHEET_TEXT = 'Campaign,Status\nSpring,Paused\n'
const BYTES = new TextEncoder().encode(SHEET_TEXT)

async function sheetRef(name = 'upload.csv', mime = 'text/csv'): Promise<SheetRef> {
  return { name, mime, fingerprint: await sheetFingerprint(BYTES), bytes: BYTES.length }
}

const google = { platform: 'google_ads' as const, id: '123-456-7890', ocid: '42' }
const meta = { platform: 'meta_ads' as const, id: 'act_999' }

function hooks(options: {
  answer?: ConfirmAnswer
  sheet?: Uint8Array
  stopAt?: number
  remoteStopAt?: number
}) {
  const evidence: EvidenceTag[] = []
  const downloads: string[] = []
  const sleeps: number[] = []
  const progress: { step: number; label: string; waiting_confirm?: boolean }[] = []
  let step = 0
  const h: RunHooks = {
    sheet: async () => ({ name: 'upload.csv', mime: 'text/csv', bytes: options.sheet ?? BYTES }),
    progress: async (p) => {
      progress.push(p)
      step = p.step
      return { stop: options.remoteStopAt !== undefined && p.step >= options.remoteStopAt }
    },
    stopped: () => options.stopAt !== undefined && step >= options.stopAt,
    confirm: async () => options.answer ?? 'yes',
    evidence: async (tag) => {
      evidence.push(tag)
    },
    downloaded: async (tag) => {
      downloads.push(tag)
    },
    sleep: async (ms) => {
      sleeps.push(ms)
    },
  }
  return { h, evidence, downloads, sleeps, progress }
}

async function run(
  job: ActionJob,
  state: FakeState,
  opts: Parameters<typeof hooks>[0] = {},
): Promise<{ result: ActionResult; page: FakePage } & ReturnType<typeof hooks>> {
  const page = new FakePage(state)
  const hk = hooks(opts)
  const result = await runAction(job, page, hk.h)
  return { result, page, ...hk }
}

async function uploadJob(account = google, mime = 'text/csv'): Promise<ActionJob> {
  return buildAdsJob({
    id: 'job_1',
    workspace_id: 'ws_1',
    account,
    action: {
      kind: 'upload_sheet',
      sheet: await sheetRef(mime === 'text/csv' ? 'upload.csv' : 'upload.xlsx', mime),
    },
    approval_id: 'ap_1',
    approval_level: 'L1',
    created_at: '2026-10-14T09:00:00.000Z',
  })
}

describe('Google 上传表：上传 → 预览 → 再确认 → 应用 → 读回', () => {
  it('一路做完：改前快照、预览截图、提交后截图都留了，读回对上', async () => {
    const out = await run(await uploadJob(), fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.downloads).toEqual(['snapshot'])
    expect(out.evidence).toEqual(['preview', 'after'])
    expect(out.result.reads.preview_summary).toBe('3 changes')
    expect(out.page.state.applied).toBe(true)
    // 等确认那一步告诉了工坊（横条 / 卡上显示「等你确认」）
    expect(out.progress.some((p) => p.waiting_confirm === true)).toBe(true)
  })

  it('两步之间只等固定时长，没有随机抖动（只限速不伪装）', async () => {
    const a = await run(await uploadJob(), fakeState())
    const b = await run(await uploadJob(), fakeState())
    expect(new Set(a.sleeps)).toEqual(new Set([STEP_GAP_MS]))
    expect(a.sleeps).toEqual(b.sleeps)
  })

  it('平台预览报了错 → 不提交，退回去改', async () => {
    const out = await run(await uploadJob(), fakeState({ previewErrors: 2 }))
    expect(out.result.outcome).toBe('rejected')
    expect(out.result.message).toContain('2 处')
    expect(out.page.state.applied).toBe(false)
  })

  it('人在再确认时没点头 → 退回，不点应用', async () => {
    const out = await run(await uploadJob(), fakeState(), { answer: 'no' })
    expect(out.result.outcome).toBe('rejected')
    expect(out.page.state.applied).toBe(false)
  })

  it('等确认等超时 → 停下交给人', async () => {
    const out = await run(await uploadJob(), fakeState(), { answer: 'timeout' })
    expect(out.result.outcome).toBe('handover')
  })

  it('表被改过（指纹对不上）→ 拒绝上传，一个字节都没放进上传框', async () => {
    const tampered = new TextEncoder().encode(`${SHEET_TEXT}Evil,Enabled\n`)
    const out = await run(await uploadJob(), fakeState(), { sheet: tampered })
    expect(out.result.outcome).toBe('failed')
    expect(out.result.message).toContain('被改过')
    expect(out.page.state.uploaded).toBeUndefined()
  })

  it('点了应用平台却没生效 → 读回对不上，照实说没做成', async () => {
    const out = await run(await uploadJob(), fakeState({ applyNoop: true }))
    expect(out.result.outcome).toBe('handover')
  })
})

describe('被拦就停、不碰的区域', () => {
  it('打开页面撞上验证码 → 停下交给人', async () => {
    const out = await run(await uploadJob(), fakeState({ captchaOn: /bulk\/uploads/u }))
    expect(out.result.outcome).toBe('handover')
    expect(out.result.message).toContain('验证')
    // 改前快照那一下点过「下载」，上传页上一下都没点
    expect(out.page.clicks).toEqual(['[aria-label="Download"]'])
  })

  it('页面被跳进了账单 → 默认不碰，停下', async () => {
    const out = await run(
      await uploadJob(),
      fakeState({
        redirect: { from: /bulk\/uploads/u, to: 'https://ads.google.com/aw/billing/summary' },
      }),
    )
    expect(out.result.outcome).toBe('handover')
    expect(out.result.message).toContain('余额')
  })

  it('跳去白名单外的站 → 停', async () => {
    const out = await run(
      await uploadJob(),
      fakeState({ redirect: { from: /bulk\/uploads/u, to: 'https://evil.example.com/' } }),
    )
    expect(out.result.outcome).toBe('handover')
    expect(out.result.message).toContain('白名单外')
  })

  it('步骤表被人塞了一下白名单外的点击 → 拦下', async () => {
    const job = await uploadJob()
    job.plan.steps.splice(3, 0, { op: 'click', selector: '[aria-label="Delete account"]' })
    const out = await run(job, fakeState())
    expect(out.result.outcome).toBe('failed')
    expect(out.result.message).toContain('白名单')
    expect(out.page.clicks).not.toContain('[aria-label="Delete account"]')
  })

  it('要填的字和卡上不一样 → 拦下', async () => {
    const job = buildAdsJob({
      id: 'b',
      workspace_id: 'ws_1',
      account: google,
      action: { kind: 'set_budget', entity: { level: 'campaign', id: '111' }, amount: '230' },
      approval_id: 'ap_2',
      created_at: '2026-10-14T09:00:00.000Z',
    })
    const fill = job.plan.steps.find((s) => s.op === 'fill')
    if (fill?.op === 'fill') fill.value = '99999'
    const out = await run(job, fakeState())
    expect(out.result.outcome).toBe('failed')
    expect(out.page.state.budget['111']).toBe('200')
  })
})

describe('随时能停', () => {
  it('横条上点了停止 → 下一步之前停', async () => {
    const out = await run(await uploadJob(), fakeState(), { stopAt: 4 })
    expect(out.result.outcome).toBe('stopped')
    expect(out.page.state.applied).toBe(false)
  })

  it('工作台点了停止（进度回执里带回来）→ 停', async () => {
    const out = await run(await uploadJob(), fakeState(), { remoteStopAt: 2 })
    expect(out.result.outcome).toBe('stopped')
    expect(out.result.step).toBe(2)
  })
})

describe('小改动：暂停 / 改预算', () => {
  it('Google 暂停：前后截图、读回状态', async () => {
    const job = buildAdsJob({
      id: 'p',
      workspace_id: 'ws_1',
      account: google,
      action: { kind: 'pause', entity: { level: 'campaign', id: '111', name: '春季' } },
      approval_id: 'ap_3',
      created_at: '2026-10-14T09:00:00.000Z',
    })
    expect(job.title).toBe('暂停「春季」')
    const out = await run(job, fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.evidence).toEqual(['before', 'after'])
    expect(out.page.state.status['111']).toBe('Paused')
  })

  it('Google 改预算：只填卡上那个数', async () => {
    const job = buildAdsJob({
      id: 'b',
      workspace_id: 'ws_1',
      account: google,
      action: { kind: 'set_budget', entity: { level: 'campaign', id: '111' }, amount: '230' },
      approval_id: 'ap_2',
      created_at: '2026-10-14T09:00:00.000Z',
    })
    const out = await run(job, fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.page.state.budget['111']).toBe('230')
  })

  it('Meta 暂停：开关已经是关的就等不到「开着」，停下不点', async () => {
    const job = buildAdsJob({
      id: 'm',
      workspace_id: 'ws_1',
      account: meta,
      action: { kind: 'pause', entity: { level: 'campaign', id: '222' } },
      approval_id: 'ap_4',
      created_at: '2026-10-14T09:00:00.000Z',
    })
    const ok = await run(job, fakeState({ status: { '222': 'Enabled' } }))
    expect(ok.result.outcome).toBe('done')
    expect(ok.page.state.status['222']).toBe('Paused')
    const already = await run(job, fakeState({ status: { '222': 'Paused' } }))
    expect(already.result.outcome).toBe('handover')
    expect(already.page.state.status['222']).toBe('Paused')
  })
})

describe('Meta 上传表：粘贴文字 → 草稿摘要 → 再确认 → 发布', () => {
  it('文字表走粘贴，粘进去的就是批过的那一份', async () => {
    const out = await run(await uploadJob(meta), fakeState())
    expect(out.result.outcome).toBe('done')
    expect(out.page.state.pasted).toBe(SHEET_TEXT)
    expect(out.evidence).toEqual(['preview', 'after'])
  })

  it('Excel 表走上传框', async () => {
    const job = await uploadJob(
      meta,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    )
    expect(job.plan.steps.some((s) => s.op === 'upload')).toBe(true)
    expect(job.plan.steps.some((s) => s.op === 'paste')).toBe(false)
  })
})
