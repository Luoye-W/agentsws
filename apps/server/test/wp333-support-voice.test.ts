/**
 * WP333：客服回信起草带上品牌语气（10-14 盘点发现的老问题）。
 *
 * 1. 单元：挂了 `customer-care`、没挂 `brand-voice` 的职责才补注；只有随软件带的基础版 = 没写过（不注）；
 *    写过 = 与社媒同一个 `voicePrompt`，正文原样引用。
 * 2. 真服务进程：客服职责跑一次——品牌没写过话术时提示词里没有这一段（照旧）；
 *    公司层写了 `brand-voice` 之后下一次运行就带上；社群客服（本来就挂了 brand-voice）不重复注。
 */
import type { Assignment, RunRequest } from '@agentsws/contracts'
import { resolveVoice, voicePrompt } from '@agentsws/social-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from '../src/index.js'
import { brandVoiceCard, needsSupportVoice, supportVoiceSection } from '../src/support-voice.js'

const GUIDANCE = '## 口吻\n\n像老朋友聊天：先说结论，不用感叹号。'

describe('WP333 客服话术（单元）', () => {
  it('哪些职责补注：挂了 customer-care、没挂 brand-voice', () => {
    expect(needsSupportVoice([{ name: 'customer-care' }])).toBe(true)
    expect(needsSupportVoice([{ name: 'customer-care' }, { name: 'brand-voice' }])).toBe(false)
    expect(needsSupportVoice([{ name: 'seo-judgment' }])).toBe(false)
  })

  it('只有基础版 = 没写过；写过 = 一张卡（去掉文件头，正文原样）', () => {
    expect(brandVoiceCard(undefined)).toBeUndefined()
    expect(
      brandVoiceCard({
        markdown: '---\nname: brand-voice\n---\n默认口吻',
        layers_applied: ['package'],
      }),
    ).toBeUndefined()
    const card = brandVoiceCard({
      markdown: `---\nname: brand-voice\n---\n\n${GUIDANCE}\n`,
      layers_applied: ['package', 'company'],
    })
    expect(card).toEqual({ id: 'brand-voice', scope: 'org', guidance: GUIDANCE })
  })

  it('拼出来的那一段与社媒同一个 voicePrompt；没卡不出', () => {
    const card = { id: 'brand-voice', scope: 'org' as const, guidance: GUIDANCE }
    const section = supportVoiceSection('dtc.support', card)
    expect(section?.text).toBe(voicePrompt(resolveVoice([card], 'email')))
    expect(section?.text).toContain('不用感叹号')
    expect(supportVoiceSection('dtc.support', undefined)).toBeUndefined()
  })
})

let server: Server
const requests: RunRequest[] = []
const ws = (): string => server.bootstrap.workspace.id
const owner = (): string => server.bootstrap.person.id

async function runOnce(assignment: Assignment): Promise<RunRequest> {
  const runtime = server.runtime
  if (runtime === undefined) throw new Error('这个进程该有运行时')
  const before = requests.length
  const matter = server.work.createMatter({ kind: 'conversation', title: '回一封信' })
  await runtime.startRun({
    matter,
    brief: '回一下 Anna 的退货',
    actor: { person_id: owner(), assignment_id: assignment.id },
  })
  const req = requests[before]
  if (req === undefined) throw new Error('这次运行没到适配器')
  return req
}

const voiceOf = (req: RunRequest): string | undefined =>
  req.persona.sections.find((s) => s.id === 'brand_voice')?.text

beforeEach(async () => {
  requests.length = 0
  let now = Date.parse('2026-10-15T02:00:00.000Z')
  server = await createServer({
    clock: { now: () => new Date(now++).toISOString() },
    random: () => 0.42,
    quiet: true,
    tokenRefreshIntervalMs: 0,
    env: { AGENTSWS_OWNER_EMAIL: 'wang@example.com' },
    mdns: () => ({ mdns: { publish() {}, browse() {}, stop() {} } }),
  })
  const runtime = server.runtime
  if (runtime !== undefined) {
    const real = runtime.adapter.run.bind(runtime.adapter)
    runtime.adapter.run = (req, sink, signal) => {
      requests.push(req)
      return real(req, sink, signal)
    }
  }
})

afterEach(async () => {
  await server.close()
})

describe('WP333 客服运行带上品牌话术（真服务进程）', () => {
  const assign = (role_id: string): Assignment =>
    server.roles.assignments.create({
      person_id: owner(),
      workspace_id: ws(),
      role_id,
      granted_by: owner(),
      ranges: [{ kind: 'store', id: 'store_main' }],
    })

  it('没写过话术 → 照旧不注；公司层写了 → 下一次运行就带上；社群客服不重复注', async () => {
    const support = assign('dtc.support')
    expect(voiceOf(await runOnce(support))).toBeUndefined()

    await server.skills.registry.putFromMarkdown({
      markdown: `---\nname: brand-voice\n---\n\n${GUIDANCE}\n`,
      tier: 'company',
      owner: owner() as never,
      version: '1.0.1',
      workspace_id: ws(),
    })
    const text = voiceOf(await runOnce(support))
    expect(text).toContain('【品牌话术｜brand-voice】')
    expect(text).toContain('先说结论，不用感叹号。')

    const community = assign('dtc.community-support')
    expect(voiceOf(await runOnce(community))).toBeUndefined()
  })
})
