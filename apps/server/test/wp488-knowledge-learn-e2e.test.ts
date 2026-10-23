/**
 * WP488（决策 1680 / 1681 / 1682 / 1686）端到端：**真服务进程**里「学一遍」。
 *
 * 跑的是真装配线：真路由（预估 / 开跑 / 进度 / 改范围 / 检索）→ 真知识库 → 真审批总线（真决定路由）→ 真事项。
 * 替身只有三样：一批模拟往来邮件（读邮箱那一口）、一个本地假站点（读页那一口）、一个假模型（只看提示词里的线索回 JSON）。
 * 全是现编的假往来与假页面，不放任何真实客户数据。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  ApprovalItem,
  KnowledgeLearnEstimate,
  KnowledgeLearnedPayload,
  KnowledgeLearnJob,
  KnowledgeStalePayload,
} from '@agentsws/contracts'
import type { HistoryMail } from '@agentsws/support-core'
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { type LearnMail, type LearnModel, retrievalStage } from '../src/knowledge-learn.js'

const T0 = '2026-10-23T09:00:00.000Z'
const OURS = 'support@lamp.test'

let server: Server | undefined
let dir: string | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/** 一批模拟往来：退货 4 段、问价 3 段（售前）、物流 3 段；外加 AI 发的、群发、没人回的各一段。 */
function mails(): HistoryMail[] {
  const out: HistoryMail[] = []
  let n = 0
  const day = (d: number) => new Date(Date.parse(T0) - d * 86_400_000).toISOString()
  const pair = (q: string, a: string, extra: Partial<HistoryMail> = {}, replyId?: string) => {
    n += 1
    const thread_id = `thr_${n}`
    out.push({
      id: `in_${n}`,
      thread_id,
      message_id: `<in${n}@cust.test>`,
      from: { email: `buyer${n}@cust.test` },
      subject: q.slice(0, 30),
      text: q,
      date: day(40 + n),
      ...extra,
    })
    out.push({
      id: `out_${n}`,
      thread_id,
      message_id: replyId ?? `<out${n}@lamp.test>`,
      from: { email: OURS },
      subject: `Re: ${q.slice(0, 30)}`,
      text: `${a}\n\nOn Tue, buyer wrote:\n> ${q}`,
      date: day(39 + n),
    })
  }
  for (let i = 0; i < 4; i++)
    pair(
      'I want to return this lamp, how do refunds work?',
      'Refunds go back to the card within 5 business days after we receive the return.',
    )
  for (let i = 0; i < 3; i++)
    pair(
      'How much is the 2-pack bundle and is there a discount?',
      'The 2-pack is on the product page; bundles are 10% off automatically.',
    )
  for (let i = 0; i < 3; i++)
    pair(
      'Where is my package? The tracking has not moved.',
      'Tracking can pause for 48 hours at customs; it usually moves again after that.',
    )
  pair('Where is my package? still nothing', 'auto reply from the workshop', {}, '<ai@lamp.test>')
  pair('Big summer sale newsletter', 'unsubscribe', {
    headers: { 'list-unsubscribe': '<mailto:u@x>' },
  })
  n += 1
  out.push({
    id: `in_${n}`,
    thread_id: `thr_${n}`,
    from: { email: 'lonely@cust.test' },
    subject: 'Question',
    text: 'Do you ship to Iceland? Nobody answered me.',
    date: day(5),
  })
  return out
}

/** 假模型：历史归纳按提示词里的主题回一条；网站按页面网址回问答。 */
function fakeModel(calls: string[]): LearnModel {
  return {
    complete: async (prompt) => {
      calls.push(prompt)
      if (prompt.includes('主题是「returns_refunds」'))
        return '{"question":"How do refunds work?","answer":"Refunds go back to the original card within 5 business days after the return arrives.","stage":"postsales","confidence":0.8}'
      if (prompt.includes('主题是「pre_sales」'))
        return '{"question":"Is there a discount on the 2-pack?","answer":"Bundles are 10% off automatically at checkout.","stage":"presales","confidence":0.8}'
      if (prompt.includes('主题是「order_tracking」'))
        return '{"question":"Why has my tracking not moved?","answer":"Tracking can pause up to 48 hours at customs, then moves again.","confidence":0.7}'
      if (prompt.includes('/policies/refund-policy')) {
        const days = /within (\d+) days/.exec(prompt)?.[1] ?? '30'
        return JSON.stringify({
          items: [
            {
              question: 'How long do I have to return an item?',
              answer: `Returns are accepted within ${days} days of delivery.`,
              stage: 'both',
              confidence: 0.9,
            },
          ],
        })
      }
      if (prompt.includes('/pages/faq'))
        return JSON.stringify({
          items: [
            {
              question: 'Which lamp is best for camping?',
              answer: 'The Trail model is waterproof and lighter.',
              stage: 'presales',
            },
          ],
        })
      if (prompt.includes('help.lamp.test/hc/articles/1'))
        return JSON.stringify({
          items: [
            {
              question: 'My lamp arrived broken, what now?',
              answer: 'Send a photo and we ship a replacement.',
              stage: 'postsales',
            },
          ],
        })
      return '{"items":[]}'
    },
    estimate: (calls) => calls * 0.01,
    budget: async () => undefined,
  }
}

const PAD = '<p>We are a small lamp company and answer every email within one business day.</p>'

async function boot(opts: { connected?: boolean } = {}) {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp488-'))
  const calls: string[] = []
  const refundDays = { value: 30 }
  const pages = (): Record<string, string> => ({
    'https://www.lamp.test/': `<html><body><a href="/pages/faq">FAQ</a><a href="/policies/refund-policy">Refunds</a><h1>Lamp</h1>${PAD}</body></html>`,
    'https://www.lamp.test/pages/faq': `<html><body><h1>FAQ</h1><p>Which lamp for camping? The Trail model.</p>${PAD}</body></html>`,
    'https://www.lamp.test/policies/refund-policy': `<html><body><h1>Refund policy</h1><p>Returns are accepted within ${refundDays.value} days of delivery.</p>${PAD}</body></html>`,
    'https://help.lamp.test/': `<html><body><a href="/hc/articles/1">Broken on arrival</a>${PAD}</body></html>`,
    'https://help.lamp.test/hc/articles/1': `<html><body><h1>Broken on arrival</h1><p>Send a photo and we ship a replacement.</p>${PAD}</body></html>`,
  })
  const siteFetch = async (url: string | URL | Request): Promise<Response> => {
    const u = String(url)
    const html = pages()[u]
    return html === undefined
      ? new Response('not found', { status: 404 })
      : new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })
  }
  const mail: LearnMail = {
    accounts: () => (opts.connected === false ? [] : [OURS]),
    stored: async () => mails(),
    history: async () => ({ records: [], supported: true }),
    machineSent: async () => new Set(['<ai@lamp.test>']),
  }
  const s = await createServer({
    clock: { now: () => T0 },
    random: () => 0.42,
    quiet: true,
    startRun: false,
    scheduleIntervalMs: 0,
    tokenRefreshIntervalMs: 0,
    dbDir: dir,
    env: { AGENTSWS_OWNER_EMAIL: 'owner@localhost' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
    knowledgeLearnMail: async () => mail,
    knowledgeLearnModel: async () => fakeModel(calls),
    knowledgeSiteFetch: siteFetch as never,
  })
  server = s
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await s.gateway.fetch(
      new Request(`http://127.0.0.1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${s.bootstrap.internalToken}`,
          'X-Assignment': s.bootstrap.ownerAssignment.id,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    )
    const text = await res.text()
    return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) }
  }
  const data = <T>(r: { json: unknown }): T => ((r.json as { data?: T }).data ?? (r.json as T)) as T
  const queue = async (form: string): Promise<ApprovalItem[]> =>
    (
      await s.txn.approvals.queue({
        workspace_id: s.bootstrap.workspace.id,
        person_id: s.bootstrap.person.id,
        lane: 'mine',
      })
    ).filter((i) => (i.payload as { form?: string }).form === form)
  const decide = async (item: ApprovalItem, body: Record<string, unknown>) => {
    const fresh = await s.txn.approvals.get(item.id)
    const token = [...(fresh?.deliveries ?? [])]
      .reverse()
      .find((d) => d.status === 'sent')?.decision_token
    const res = await call('POST', `/v1/approvals/${item.id}/decide`, {
      decision_token: token,
      ...body,
    })
    expect(res.status).toBe(200)
    await s.knowledgeLearn.settled()
  }
  return { s, call, data, queue, decide, calls, refundDays }
}

describe('从过往邮件学', () => {
  it('预估 → 开跑 → 待确认卡（带依据）→ 卡上改范围 / 去掉一条 → 采纳生效', async () => {
    const { s, call, data, queue, decide, calls } = await boot()
    const est = data<KnowledgeLearnEstimate>(
      await call('POST', '/v1/knowledge/learn/estimate', { source: 'email' }),
    )
    expect(est).toMatchObject({ source: 'email', months: 12, pairs: 10, calls: 3, connected: true })
    expect(est.cost).toBeCloseTo(0.03)
    expect(calls).toHaveLength(0)

    const job = data<KnowledgeLearnJob>(
      await call('POST', '/v1/knowledge/learn', { source: 'email' }),
    )
    expect(job.state).toBe('running')
    expect(job.matter_id).toBeDefined()
    await s.knowledgeLearn.settled()
    const [done] = data<KnowledgeLearnJob[]>(await call('GET', '/v1/knowledge/learn/jobs'))
    expect(done).toMatchObject({ state: 'done', learned: 3, progress: { done: 3, total: 3 } })
    expect(calls).toHaveLength(3)

    const [card] = await queue('knowledge_learned')
    expect(card?.subject.matter_id).toBe(job.matter_id)
    const p = card?.payload as KnowledgeLearnedPayload
    // 归纳没判范围的那条（物流）按问法规则判成售后
    expect(p.items.map((i) => i.stage).sort()).toEqual(['postsales', 'postsales', 'presales'])
    expect(p.items.every((i) => /段往来/.test(i.basis))).toBe(true)

    // 学到的先是待确认：带依据（出处指着那几段往来），检索不到
    const learned = (
      s.knowledge.db
        .prepare("SELECT id FROM fact_cards WHERE subject_type = 'learned_qa'")
        .all() as { id: string }[]
    )
      .map((r) => s.knowledge.store.getUnchecked(r.id))
      .filter((c) => c !== undefined)
    expect(learned).toHaveLength(3)
    expect(learned.every((c) => c.status === 'proposed')).toBe(true)
    expect(learned.find((c) => c.stage === 'postsales')?.provenance[0]?.ref).toMatch(
      /^history:thr_/,
    )

    const tracking = p.items.find((i) => i.question.startsWith('Why has my tracking'))
    const discount = p.items.find((i) => i.question.startsWith('Is there a discount'))
    await decide(card as ApprovalItem, {
      action: 'approve',
      edited_payload: {
        ...p,
        stages: { [tracking?.card_id ?? '']: 'both' },
        drop: [discount?.card_id],
      },
    })
    const after = (id: string | undefined) => s.knowledge.store.getUnchecked(id ?? '')
    expect(after(tracking?.card_id)).toMatchObject({ status: 'active', stage: 'both' })
    expect(after(discount?.card_id)?.status).toBe('retired')
  })

  it('没接邮箱 → 这件事里出一张连接卡，不问模型', async () => {
    const { s, call, data, calls } = await boot({ connected: false })
    await call('POST', '/v1/knowledge/learn', { source: 'email' })
    await s.knowledgeLearn.settled()
    const [job] = data<KnowledgeLearnJob[]>(await call('GET', '/v1/knowledge/learn/jobs'))
    expect(job?.state).toBe('needs_connection')
    expect(job?.connect_card_id).toBeDefined()
    expect(calls).toHaveLength(0)
  })
})

describe('从官网 + 售后网站学，每周复查', () => {
  it('多页假站点 → 待确认卡（记来源页）→ 采纳 → 改政策页 → 复查出「可能过期」卡', async () => {
    const { s, call, data, queue, decide, refundDays } = await boot()
    await call('POST', '/v1/knowledge/learn', {
      source: 'website',
      urls: ['https://www.lamp.test/', 'help.lamp.test'],
    })
    await s.knowledgeLearn.settled()
    const [job] = data<KnowledgeLearnJob[]>(await call('GET', '/v1/knowledge/learn/jobs'))
    expect(job).toMatchObject({ state: 'done', learned: 3 })
    const [card] = await queue('knowledge_learned')
    const p = card?.payload as KnowledgeLearnedPayload
    const refund = p.items.find((i) => i.question.startsWith('How long'))
    expect(refund?.basis).toBe('lamp.test/policies/refund-policy')
    expect(s.knowledge.store.getUnchecked(refund?.card_id ?? '')?.provenance[0]).toMatchObject({
      source: 'web',
      ref: 'https://www.lamp.test/policies/refund-policy',
    })
    await decide(card as ApprovalItem, { action: 'approve' })
    expect(s.knowledge.store.getUnchecked(refund?.card_id ?? '')?.status).toBe('active')

    // 没变：复查不惊动人
    expect(await s.knowledgeLearn.recheckSites(s.bootstrap.workspace.id, { force: true })).toBe(0)
    // 政策页把退货天数从 30 改成 14
    refundDays.value = 14
    expect(await s.knowledgeLearn.recheckSites(s.bootstrap.workspace.id, { force: true })).toBe(1)
    expect(s.knowledge.store.getUnchecked(refund?.card_id ?? '')?.verification_state).toBe('stale')
    const [stale] = await queue('knowledge_stale')
    const sp = stale?.payload as KnowledgeStalePayload
    expect(sp.items[0]?.url).toBe('https://www.lamp.test/policies/refund-policy')
    // 再查一遍不重复出卡
    expect(await s.knowledgeLearn.recheckSites(s.bootstrap.workspace.id, { force: true })).toBe(0)

    // 「按网站重学」：旧的撤下，这一页重新读出新的待确认
    await decide(stale as ApprovalItem, {
      action: 'approve',
      edited_payload: { ...sp, resolution: 'relearn' },
    })
    await s.knowledgeLearn.settled()
    expect(s.knowledge.store.getUnchecked(refund?.card_id ?? '')?.status).toBe('retired')
    const again = (await queue('knowledge_learned')).map(
      (i) => i.payload as KnowledgeLearnedPayload,
    )
    expect(again.some((x) => x.items.some((i) => i.answer.includes('14 days')))).toBe(true)
  })
})

describe('三份：回复前先判售前 / 售后', () => {
  it('售前问题取不到只售后的卡，反之亦然；公共两边都取；卡上能改范围', async () => {
    const { s, call, data, queue, decide } = await boot()
    await call('POST', '/v1/knowledge/learn', {
      source: 'website',
      urls: ['https://www.lamp.test/', 'https://help.lamp.test/'],
    })
    await s.knowledgeLearn.settled()
    const [card] = await queue('knowledge_learned')
    await decide(card as ApprovalItem, { action: 'approve' })

    const search = async (text: string) =>
      data<{ hits: { statement_redacted: string; stage?: string; fact_card_id: string }[] }>(
        await call('POST', '/v1/knowledge/search', { text, ...retrievalStage(text) }),
      ).hits
    const pre = await search('Which lamp is best for camping, and how much is it?')
    expect(retrievalStage('Which lamp is best for camping, and how much is it?')).toEqual({
      stage: 'presales',
    })
    expect(pre.some((h) => h.statement_redacted.includes('Trail'))).toBe(true)
    expect(pre.some((h) => h.statement_redacted.includes('replacement'))).toBe(false)
    expect(pre.some((h) => h.statement_redacted.includes('Returns are accepted'))).toBe(true)

    const post = await search('My order #10234 arrived broken, what now?')
    expect(post.some((h) => h.statement_redacted.includes('replacement'))).toBe(true)
    expect(post.some((h) => h.statement_redacted.includes('Trail'))).toBe(false)
    expect(post.some((h) => h.statement_redacted.includes('Returns are accepted'))).toBe(true)

    // 改范围：把「换货」那条改成公共 → 售前也取得到
    const broken = post.find((h) => h.statement_redacted.includes('replacement'))
    const res = await call('POST', `/v1/knowledge/cards/${broken?.fact_card_id}/stage`, {
      stage: 'both',
    })
    expect(res.status).toBe(200)
    const pre2 = await search('Which lamp is best for camping, and how much is it?')
    expect(pre2.some((h) => h.statement_redacted.includes('replacement'))).toBe(true)
  })
})
