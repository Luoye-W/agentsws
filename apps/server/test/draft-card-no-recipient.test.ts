/**
 * WP232（10-05 Fable 本机 dev-real，真模型 deepseek-chat，红人营销 → kol.youtube）：
 * 「一位 YouTube 红人用英文回信 …… 帮我起草一封回复，先别发，给我看稿。」
 *
 * 模型调了 `draft_reply`（正文是完整英文草稿），工具回「draft_reply 未获批准（fail-closed）」，
 * 模型对用户说「答案位没人应答，系统按 fail-closed 拒了」。根因不是有人没在线：审批 seam 的应答者
 * 就是门禁自己（同步建卡），是服务端 `createDraft` 找不到收件人（任务是人打的字、事项上没有
 * 来信人、任务说明那一段 `participants: []`）就回了 `undefined`，草稿被丢掉。
 *
 * 端到端（真 `createServer` → `POST /v1/matters` → `POST /v1/matters/:id/messages` → 真运行时 →
 * 真审批总线；上游模型是本机替身，不联网、不花钱；**没有任何人在线**）：
 * - dsh 档（红人职责挂了网页工具，服务端按 WP179 分到 dsh）与 direct 档各跑一次：
 *   `draft_reply` 当场出一张「收件人待定」的卡（pending、卡上是那份英文草稿），回合正常结束；
 * - 没接模型（stub）：同样出卡；
 * - 卡人批得下来；批了也不会发出去（施行记 `manual_send`、渠道一个字不碰）由
 *   `packages/txn/test/manual-send.test.ts` 钉住。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalItem, EventEnvelope } from '@agentsws/contracts'
import type { FetchLike } from '@agentsws/model-gateway'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MANUAL_SEND_SUMMARY } from '../src/runtime.js'
import { SECRETS_KEY_ENV } from '../src/secret-store.js'
import { createServer, type Server } from '../src/server.js'

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const BODY =
  "Hi,\n\nThanks for getting back to me — glad you're up for trying the earbuds.\n\n" +
  'Could you send over your rate card for a dedicated YouTube video? On Canada: let me confirm ' +
  'shipping to your address and come back to you.\n\nBest,\nCreator Partnerships'
const SUBJECT = 'Re: Earbuds collab — compensation and shipping to Canada'

let server: Server | undefined
let dir: string | undefined
afterEach(async () => {
  await server?.close()
  server = undefined
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

/**
 * 本机替身的 OpenAI 兼容口：带着 `draft_reply` 工具来的对话，第一轮调它，
 * 看到它的结果之后说一句话收尾。别的用途的请求（体检 / 摘要）回一句空话。
 */
function scriptedModel(): { fetch: FetchLike; toolResults: string[] } {
  const toolResults: string[] = []
  const fetch: FetchLike = async (url, init) => {
    const raw = typeof init.body === 'string' ? init.body : ''
    let json: unknown
    if (url.endsWith('/models')) json = { object: 'list', data: [{ id: 'deepseek-flash' }] }
    else {
      const body = (raw === '' ? {} : JSON.parse(raw)) as {
        tools?: { function?: { name?: string } }[]
        messages?: { role: string; content?: unknown }[]
      }
      const hasDraft = (body.tools ?? []).some((t) => t.function?.name === 'draft_reply')
      const tool = (body.messages ?? []).filter((m) => m.role === 'tool')
      for (const m of tool) if (typeof m.content === 'string') toolResults.push(m.content)
      const message =
        hasDraft && tool.length === 0
          ? {
              content: '我先把回信起草好，放进待批。',
              tool_calls: [
                {
                  id: 'call_draft_1',
                  type: 'function',
                  function: {
                    name: 'draft_reply',
                    arguments: JSON.stringify({ subject: SUBJECT, body: BODY }),
                  },
                },
              ],
            }
          : { content: '稿子放进待批了，你看一眼。' }
      json = {
        choices: [{ message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 9, completion_tokens: 3 },
      }
    }
    return { ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }
  }
  return { fetch, toolResults }
}

async function boot(withModel: boolean): Promise<{ s: Server; toolResults: string[] }> {
  dir = mkdtempSync(join(tmpdir(), 'agentsws-wp232-'))
  const model = scriptedModel()
  server = await createServer({
    dbDir: dir,
    quiet: true,
    env: { [SECRETS_KEY_ENV]: 'c'.repeat(64), AGENTSWS_OWNER_EMAIL: 'owner@example.com' },
    modelFetch: model.fetch,
    tokenRefreshIntervalMs: 0,
    scheduleIntervalMs: 0,
  })
  const s = server
  if (withModel) {
    const saved = await call(
      s,
      'PUT',
      '/v1/models/providers/deepseek',
      { kind: 'deepseek', model: 'deepseek-flash', api_key: 'sk-wp232-test-0001' },
      s.bootstrap.ownerAssignment.id,
    )
    expect(saved.status).toBe(200)
  }
  return { s, toolResults: model.toolResults }
}

function call(s: Server, method: string, path: string, body: unknown, assignment: string) {
  const headers = new Headers()
  headers.set('Authorization', `Bearer ${s.bootstrap.internalToken}`)
  headers.set('X-Assignment', assignment)
  if (body !== undefined) headers.set('content-type', 'application/json')
  return s.gateway.fetch(
    new Request(`http://127.0.0.1${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  )
}

/** 以红人岗位开一件事、说一句话，等这次运行收尾；回这次运行的事件。 */
async function runTask(s: Server, role_id: string): Promise<EventEnvelope[]> {
  const asg = s.roles.assignments.create({
    person_id: s.bootstrap.person.id,
    workspace_id: s.bootstrap.workspace.id,
    role_id,
    granted_by: s.bootstrap.person.id,
    ranges: [{ kind: 'brand', id: s.bootstrap.workspace.id }],
  })
  const res = await call(
    s,
    'POST',
    '/v1/matters',
    { kind: 'adhoc', title: '红人英文回信，起草回复', role_id },
    asg.id,
  )
  const matter = ((await res.json()) as { data: { matter: { id: string } } }).data.matter
  const msg = await call(
    s,
    'POST',
    `/v1/matters/${matter.id}/messages`,
    {
      text:
        '一位 YouTube 红人用英文回信：「Thanks! Happy to try the earbuds. What compensation do you offer ' +
        'for a dedicated video, and do you ship to Canada?」帮我起草一封回复，先别发，给我看稿。',
    },
    asg.id,
  )
  const run_id = ((await msg.json()) as { data?: { run_id?: string } }).data?.run_id
  expect(run_id).toBeDefined()
  const ofRun = () =>
    s.kernel.eventLog
      .readSync({ workspace_id: s.bootstrap.workspace.id })
      .filter((e) => e.correlation?.run_id === run_id)
  for (let i = 0; i < 400; i++) {
    if (ofRun().some((e) => ['run.completed', 'run.failed'].includes(e.type))) break
    await new Promise((r) => setTimeout(r, 25))
  }
  return ofRun()
}

const draftsOf = (s: Server): ApprovalItem[] =>
  s.txn.runtime.store.listApprovals({ kind: 'outbound_draft' })

describe('WP232：起草回复没人在线、没有收件地址，也出一张待批卡', () => {
  it('dsh 档（红人职责挂网页工具）：当场出「收件人待定」的卡，卡里是那份英文草稿', async () => {
    const { s, toolResults } = await boot(true)
    const events = await runTask(s, 'kol.youtube')
    expect(events.find((e) => e.type === 'run.started')?.payload).toMatchObject({ runtime: 'dsh' })
    expect(events.map((e) => e.type)).toContain('run.completed')
    const result = events.find((e) => e.type === 'tool.result')?.payload as { status?: string }
    expect(result.status).toBe('ok')
    expect(JSON.stringify(toolResults)).not.toContain('fail-closed')
    const [card] = draftsOf(s)
    expect(card?.state).toBe('pending')
    expect(card?.title).toBe(`回复草稿（收件人待定）：${SUBJECT}`)
    expect(card?.summary).toBe(MANUAL_SEND_SUMMARY)
    expect(card?.payload).toMatchObject({ manual_send: true, body: { text: BODY } })
    expect((card?.payload as { to?: unknown } | undefined)?.to).toBeUndefined()
    const proposals = events.filter((e) => e.type === 'proposal.created')
    expect(proposals.map((e) => (e.payload as { kind: string }).kind)).toEqual(['outbound_draft'])
  })

  it('direct 档：同一件事同样出卡（模型没给收件人也不报错）', async () => {
    const { s } = await boot(true)
    const events = await runTask(s, 'dtc.support')
    expect(events.find((e) => e.type === 'run.started')?.payload).toMatchObject({
      runtime: 'direct-llm',
    })
    expect(events.map((e) => e.type)).toContain('run.completed')
    const [card] = draftsOf(s)
    expect(card?.state).toBe('pending')
    expect(card?.payload).toMatchObject({ manual_send: true, body: { text: BODY } })
  })

  it('没接模型（stub）：同样出卡，人批得下来（施行不碰渠道由 txn 的 manual-send 测试钉住）', async () => {
    const { s } = await boot(false)
    const events = await runTask(s, 'dtc.support')
    expect(events.find((e) => e.type === 'run.started')?.payload).toMatchObject({ runtime: 'stub' })
    const [card] = draftsOf(s)
    expect(card?.state).toBe('pending')
    expect(card?.payload).toMatchObject({ manual_send: true })
    const token = card?.deliveries[0]?.decision_token
    expect(token).toBeDefined()
    const approved = await s.txn.approvals.decide(card?.id as string, s.bootstrap.person.id, {
      decision_token: token as string,
      action: 'approve',
      via: 'workstation',
    })
    expect(approved.state).toBe('approved')
  })
})
