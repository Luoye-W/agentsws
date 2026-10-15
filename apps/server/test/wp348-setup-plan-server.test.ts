/**
 * WP348（决策 887）端到端：真服务进程（落盘档 + 真网关 + stub 运行时）+ 联网搜索替身，一行网都不出。
 *
 * AI 在任务里发现要先设好公司档案 → `request_setup` → 这一轮收尾时**先查**（品牌档案里的目标市场与官网、
 * 替身搜索搜到的官网联系页）→ 出「我打算这样设」的方案卡：币种按目标市场、客服邮箱来自搜到的网页（带链接），
 * 一句话介绍查不到就标「需要你填」；时间线上留了查的那几行。人「改一下」填上介绍 → 存进档案、按原话接着做。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, SetupRequestPayload } from '@agentsws/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'

let server: Server | undefined
const dirs: string[] = []

afterEach(async () => {
  await server?.close()
  server = undefined
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const waitFor = async (fn: () => Promise<boolean> | boolean, what: string): Promise<void> => {
  for (let i = 0; i < 300; i++) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`等不到：${what}`)
}

describe('WP348 方案卡（stub，公司档案）', () => {
  it('出卡前先查：档案 + 替身搜索进了方案；时间线记下查了什么；改一下 → 存好接着做', async () => {
    const dbDir = mkdtempSync(join(tmpdir(), 'wp348-plan-'))
    dirs.push(dbDir)
    const search = vi.fn(async (query: string) => ({
      sources: [
        {
          url: 'https://nordvolt.example/contact',
          title: 'Contact NordVolt',
          snippet: `${query} — write to help@nordvolt.example`,
        },
      ],
    }))
    server = await createServer({
      dbDir,
      quiet: true,
      env: { [SECRETS_KEY_ENV]: 'c'.repeat(64) },
      tokenRefreshIntervalMs: 0,
      scheduleIntervalMs: 0,
      liveDataIntervalMs: 0,
      mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
      freeChatWebSearch: search,
    })
    const s = server
    const owner = s.bootstrap.ownerAssignment.id
    const ws = s.bootstrap.workspace.id
    await s.onboarding.port.setProfile(
      { workspace_id: ws, person_id: s.bootstrap.person.id, assignment_id: '', role_id: '' },
      { legal_name: 'NordVolt GmbH', domain: 'nordvolt.example', markets: ['de'] } as never,
    )
    const call = async (method: string, path: string, body?: unknown) =>
      s.gateway.fetch(
        new Request(`http://127.0.0.1${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${s.bootstrap.internalToken}`,
            'X-Assignment': owner,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      )
    const dataOf = async <T>(res: Response): Promise<T> => ((await res.json()) as { data: T }).data
    type Tl = { kind: string; text: string; approval_item_id?: string }[]
    const timeline = async (m: string): Promise<Tl> =>
      (await dataOf<{ timeline: Tl }>(await call('GET', `/v1/matters/${m}`))).timeline
    const queue = async (): Promise<ApprovalItem[]> =>
      s.txn.approvals.queue({ workspace_id: ws, person_id: s.bootstrap.person.id, lane: 'mine' })

    const m = await dataOf<{ matter: { id: string } }>(
      await call('POST', `/v1/positions/${owner}/matters`, {
        title: '先填好公司档案，再写一段品牌介绍',
        role_id: 'common.owner',
      }),
    )
    await waitFor(async () => (await queue()).some((c) => c.kind === 'setup_request'), '方案卡')
    const card = (await queue()).find(
      (c) => c.kind === 'setup_request',
    ) as ApprovalItem<SetupRequestPayload>
    expect(card.title).toBe('公司档案：我打算这样设')
    expect(card.payload.mode).toBe('plan')
    const by = (k: string) => card.payload.fields.find((f) => f.key === k)
    expect(by('currency')).toMatchObject({ suggested: 'EUR', sources: [{ kind: 'profile' }] })
    expect(by('support_email')).toMatchObject({
      suggested: 'help@nordvolt.example',
      sources: [{ kind: 'web', url: 'https://nordvolt.example/contact' }],
    })
    // stub 没有真模型：一句话介绍查不到 → 需要你填（必填）
    expect(by('one_liner')).toMatchObject({ needs_you: true, required: true })
    expect(search).toHaveBeenCalledTimes(1)
    const steps = card.payload.steps?.map((x) => x.text) ?? []
    expect(steps.some((t) => t.startsWith('联网搜了官网'))).toBe(true)
    const tl = await timeline(m.matter.id)
    expect(tl.some((e) => e.text.startsWith('联网搜了官网'))).toBe(true)
    expect(tl.some((e) => e.kind === 'card' && e.approval_item_id === card.id)).toBe(true)

    // 改一下：人填上介绍（方案里别的格子照方案存）
    const res = await call('POST', `/v1/approvals/${card.id}/decide`, {
      action: 'approve',
      version: card.revision,
      via: 'workstation',
      edited_payload: {
        ...card.payload,
        values: {
          one_liner: '给通勤族的电动滑板车',
          support_email: 'help@nordvolt.example',
          currency: 'EUR',
        },
      },
    })
    expect(res.status).toBeLessThan(300)
    await waitFor(
      async () =>
        (await timeline(m.matter.id)).some((e) => e.kind === 'run' && e.text === '设好了，接着做'),
      '接着做',
    )
    expect(s.onboarding.brandProfile(ws)).toMatchObject({
      one_liner: '给通勤族的电动滑板车',
      support_email: 'help@nordvolt.example',
      currency: 'EUR',
    })
  })
})
