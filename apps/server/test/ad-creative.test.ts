/**
 * WP317（docs/101 §5.1④，决策 559）：素材流水线的服务层（替身模型、假设计岗、假记忆）。
 *
 * 钉的是：导出表 → 挑差的 → 两个子 Agent（字数 / 条数 / 禁用词）→ 上传表（新建暂停）→
 * 批量出图单（≤ 30 版）→ 实验记录（按品牌存、同步进岗位记忆、下一轮带进上下文）。
 */
import type { CopyComplete } from '@agentsws/ads-core'
import type { AdsActor } from '@agentsws/api'
import type { WorkspaceId } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createAdCreativeService } from '../src/ad-creative.js'
import { createAdsStore } from '../src/ads.js'

const WS = 'ws_1' as WorkspaceId
const actor: AdsActor = {
  workspace_id: WS,
  person_id: 'p_1' as never,
  assignment_id: 'as_1' as never,
  role_id: 'ads.google' as never,
}

const CSV = [
  'Campaign,Ad group,Ad ID,Headline 1,Headline 2,Description 1,Final URL,Impr.,Clicks',
  'PB,Commute,101,Magnetic Power Bank,Stays put,Snaps on.,https://s.example/a,10000,300',
  'PB,Commute,102,Power on the go,,Light.,https://s.example/a,8000,80',
  'PB,Gift,103,Gift idea,,Nice.,https://s.example/b,9000,250',
].join('\n')

function setup(over: { complete?: CopyComplete | undefined; noPosition?: boolean } = {}) {
  let t = Date.parse('2026-10-14T09:00:00Z')
  const clock = { now: () => new Date(t).toISOString() }
  const store = createAdsStore({ workspace_id: WS })
  const prompts: { agent: string; system: string; user: string }[] = []
  const designCalls: { title: string; need: string; spec_ids: string[]; variants: number }[] = []
  const memory = new Map<string, { heading: string; body: string }>()
  let mseq = 0
  const complete: CopyComplete =
    over.complete ??
    (async (req) => {
      prompts.push(req)
      return JSON.stringify({
        lines:
          req.agent === 'headline'
            ? [
                { text: '出门一整天不找插座', angle: '结果', source: '事实卡：续航' },
                { text: '全 网 最 低 的充电宝' },
                { text: 'Snaps on, stays put' },
                { text: 'Charges while you walk' },
              ]
            : [
                { text: 'Fits any pocket. Charges your phone twice.' },
                { text: 'Light enough for daily carry.' },
              ],
      })
    })
  const svc = createAdCreativeService({
    workspace_id: WS,
    clock,
    random: () => 0.42,
    store,
    appendEvent: () => undefined,
    ...('complete' in over && over.complete === undefined ? {} : { complete: () => complete }),
    skillText: async (_a, name) => `# ${name} 技能正文`,
    requestDesign: async (_a, input) => {
      designCalls.push(input)
      return { request_id: 'dreq_1', staged: { staged: true, level: 'L3' } }
    },
    designGeneratedToday: () => 0,
    memory: {
      list: () =>
        over.noPosition === true
          ? undefined
          : [...memory.entries()].map(([id, m]) => ({ id, heading: m.heading, body: m.body })),
      add: async (_a, entry) => {
        mseq += 1
        const id = `m:position:pos_ads:ad-copywriting:${mseq}`
        memory.set(id, { heading: entry.heading, body: entry.text })
        return id
      },
      update: async (_a, id, entry) => {
        memory.set(id, { heading: entry.heading, body: entry.text })
      },
    },
  })
  return {
    port: svc.port,
    store,
    prompts,
    designCalls,
    memory,
    advance: (ms: number) => {
      t += ms
    },
  }
}

describe('WP317 素材流水线（服务层）', () => {
  it('导出表 → 挑出表现差的 → 两个子 Agent 各读各的技能写新文案；禁用词拆字的被挡下', async () => {
    const { port, prompts } = setup()
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    expect(imp.rows).toBe(3)
    expect(imp.weak.filter((w) => w.verdict === 'weak').map((w) => w.ad_id)).toEqual(['102'])

    const round = await port.rewrite(actor, { import_id: imp.id })
    expect(round.rewrites).toHaveLength(1)
    const r = round.rewrites[0]
    expect(r?.headlines.map((h) => h.text)).toEqual([
      '出门一整天不找插座',
      'Snaps on, stays put',
      'Charges while you walk',
    ])
    expect(r?.headlines[0]).toMatchObject({ chars: 18, limit: 30, source: '事实卡：续航' })
    expect(r?.rejected.find((x) => x.rule === 'evasion')?.text).toBe('全 网 最 低 的充电宝')
    expect(r?.descriptions).toHaveLength(2)
    expect(prompts.find((p) => p.agent === 'headline')?.system).toContain('# ad-headlines 技能正文')
    expect(prompts.find((p) => p.agent === 'description')?.system).toContain(
      '# ad-descriptions 技能正文',
    )
  })

  it('上传表：走 WP314 生成器，只出收下的文案，新建一律 Paused，带上原来的最终到达网址', async () => {
    const { port } = setup()
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    const sheet = await port.sheet(actor, round.id)
    expect(sheet.ok).toBe(true)
    expect(sheet.ads).toBe(1)
    const ads = sheet.files.find((f) => f.text?.includes('Headline 1'))?.text ?? ''
    expect(ads).toContain('Paused')
    expect(ads).toContain('https://s.example/a')
    expect(ads).toContain('出门一整天不找插座')
    expect(ads).not.toContain('全 网 最 低')
  })

  it('导出表按字节传：UTF-16（Excel CSV）也认', async () => {
    const { port } = setup()
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(CSV, 'utf16le')])
    const imp = await port.importExport(actor, {
      platform: 'google',
      base64: bytes.toString('base64'),
    })
    expect(imp.rows).toBe(3)
  })

  it('没接真模型：不编文案，整轮写一句「没接上」；出不了上传表', async () => {
    const { port } = setup({ complete: undefined })
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    expect(round.notes.join(' ')).toContain('没接上能写文案的模型')
    expect(round.rewrites[0]?.headlines).toEqual([])
    expect(() => port.sheet(actor, round.id)).toThrow(/一条收下的文案都没有/)
  })

  it('批量出图单：标题轮着上图，版数 = 标题条数；超 30 截；交给设计岗（L3）', async () => {
    const { port, designCalls } = setup()
    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    const view = await port.requestDesign(actor, round.id, {})
    expect(view).toMatchObject({ requested: true, request_id: 'dreq_1', variants: 3 })
    expect(view.staged?.level).toBe('L3')
    expect(designCalls[0]?.need).toContain('「出门一整天不找插座」')
    const big = await port.requestDesign(actor, round.id, { variants: 45 })
    expect(big.variants).toBe(30)
    expect(designCalls[1]?.variants).toBe(30)
  })

  it('实验记录以岗位记忆为准：前两格不能空；记进记忆；下一轮带进两个子 Agent 的上下文', async () => {
    const { port, prompts, memory } = setup()
    await expect(port.addExperiment(actor, { hypothesis: '', change: 'x' })).rejects.toThrow(/假设/)
    const e1 = await port.addExperiment(actor, {
      hypothesis: '标题带价格点击率更高',
      change: '6 条标题带价格',
      platform: 'google',
    })
    expect(e1.round).toBe(1)
    expect(e1.id).toBe(e1.memory_id)
    expect(memory.get(e1.id)?.heading).toContain('第 1 轮')
    const done = await port.updateExperiment(actor, e1.id, { result: '带价格 CTR 2.1% vs 1.4%' })
    expect(done.result).toBe('带价格 CTR 2.1% vs 1.4%')
    expect(memory.get(e1.id)?.body).toContain('结果：带价格 CTR 2.1% vs 1.4%')

    const imp = await port.importExport(actor, { platform: 'google', text: CSV })
    const round = await port.rewrite(actor, { import_id: imp.id })
    expect(round.experiments_used).toBe(1)
    expect(prompts.every((p) => p.user.includes('标题带价格点击率更高'))).toBe(true)
  })

  it('人在记忆面板里改了 / 删了那条：流水线读到的跟着变', async () => {
    const { port, memory } = setup()
    const e = await port.addExperiment(actor, { hypothesis: '短标题更好', change: '全写 15 字内' })
    const m = memory.get(e.id)
    memory.set(e.id, {
      heading: m?.heading ?? '',
      body: (m?.body ?? '').replace('短标题更好', '短标题更好（面板里改的）'),
    })
    expect((await port.experiments(actor)).rows[0]?.hypothesis).toBe('短标题更好（面板里改的）')
    memory.delete(e.id)
    expect((await port.experiments(actor)).rows).toEqual([])
  })

  it('没有岗位那一层（记忆面不在）：退回广告库', async () => {
    const { port, store } = setup({ noPosition: true })
    const e = await port.addExperiment(actor, { hypothesis: '带价格', change: '6 条' })
    expect(e.memory_id).toBeUndefined()
    expect(store.experiments()).toHaveLength(1)
    expect((await port.experiments(actor)).rows).toHaveLength(1)
  })

  it('不是投放职责：一律 403；一轮最多写 20 条', async () => {
    const { port } = setup()
    await expect(
      Promise.resolve().then(() =>
        port.importExport(
          { ...actor, role_id: 'dtc.support' as never },
          { platform: 'google', text: CSV },
        ),
      ),
    ).rejects.toThrow(/不是一条投放职责/)
    const rows = Array.from(
      { length: 25 },
      (_, i) => `PB,G,${200 + i},Old ${i},,Old.,https://s.example/x,${5000 + i},10`,
    )
    const imp = await port.importExport(actor, {
      platform: 'google',
      text: [
        'Campaign,Ad group,Ad ID,Headline 1,Headline 2,Description 1,Final URL,Impr.,Clicks',
        ...rows,
      ].join('\n'),
    })
    const round = await port.rewrite(actor, {
      import_id: imp.id,
      ad_ids: rows.map((_, i) => String(200 + i)),
    })
    expect(round.rewrites).toHaveLength(20)
    expect(round.notes.join(' ')).toContain('一轮最多写 20 条')
  })
})
