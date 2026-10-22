/**
 * 教程上官网（私有 docs/113 §5）：「查工坊帮助」——在本机帮助库里搜（用仓库里真的教程），
 * 中文问查中文、英文问查英文；查不到照实说；执行器只认这一个工具、不收空问题。
 */
import type { RunRequest } from '@agentsws/contracts'
import { describe, expect, it } from 'vitest'
import { createHelpLibrary } from '../src/help-library.js'
import {
  createWorkshopHelpTool,
  helpTokens,
  searchHelpDocs,
  searchWorkshopHelp,
} from '../src/workshop-help-tool.js'

const lib = createHelpLibrary({ appVersion: '0.2.1-beta.8', online: false })

describe('切词', () => {
  it('英文按词、中文按相邻两字', () => {
    expect(helpTokens('连 Shopify 店铺')).toEqual(['shopify', '连', '店铺'])
    expect(helpTokens('发信域名')).toEqual(['发信', '信域', '域名'])
  })
})

describe('在真教程里搜', () => {
  it('中文问题查中文那份，最相关的排第一，带官网链接与那一节原文', () => {
    const r = searchWorkshopHelp(lib, '怎么把 Shopify 店连进来')
    expect(r.results[0]?.title).toBe('连 Shopify 店铺')
    expect(r.results[0]?.url).toBe('https://agentsws.com/docs/conn-shopify/')
    expect(r.results[0]?.excerpt.length).toBeGreaterThan(20)
    expect(r.results.length).toBeLessThanOrEqual(3)
  })

  it('英文问题查英文那份', () => {
    const r = searchWorkshopHelp(lib, 'sending domain SPF DKIM for cold email')
    expect(r.results[0]?.url).toBe('https://agentsws.com/en/docs/b2b-sending-domain/')
  })

  it('几个常见问法都找得到对的那篇', () => {
    const top = (q: string) => searchWorkshopHelp(lib, q).results[0]?.url ?? ''
    expect(top('积分怎么算，1 美元多少积分')).toContain('/docs/agentsws-credits/')
    expect(top('飞书机器人怎么建')).toContain('/docs/im-feishu/')
    expect(top('网站聊天窗嵌入代码放哪')).toContain('/docs/chat-window/')
  })

  it('查不到：结果为空，message 说照实说、别编', () => {
    const r = searchWorkshopHelp(lib, 'zzqx qqzz')
    expect(r.results).toEqual([])
    expect(r.message).toContain('没找到')
  })

  it('只查某一种：随包里只有教程，查笔记就没有', () => {
    expect(searchWorkshopHelp(lib, '积分', 'note').results).toEqual([])
    expect(searchWorkshopHelp(lib, '积分', 'guide').results.length).toBeGreaterThan(0)
  })

  it('新版才有的那篇带上 needs_newer_app 与 requires', () => {
    const hits = searchHelpDocs(
      [
        {
          kind: 'guide',
          slug: 'x',
          lang: 'zh',
          title: '日历与待办',
          description: '排期',
          positions: [],
          roles: [],
          source: 'online',
          needs_newer_app: true,
          requires: '0.2.1-beta.9',
          markdown: '# 日历与待办\n\n## 怎么排\n\n拖到日历上。\n',
        },
      ],
      '日历怎么排',
    )
    expect(hits[0]).toMatchObject({
      needs_newer_app: true,
      requires: '0.2.1-beta.9',
      section: '怎么排',
    })
  })
})

describe('执行器', () => {
  const run = createWorkshopHelpTool(() => lib)
  const request = {} as RunRequest
  it('回 ok + 结果；空问题、别的工具名回错', async () => {
    const ok = await run({ name: 'search_workshop_help', input: { query: '连邮箱' }, request })
    expect(ok.status).toBe('ok')
    expect((ok.data as { results: unknown[] }).results.length).toBeGreaterThan(0)
    expect((await run({ name: 'search_workshop_help', input: {}, request })).status).toBe('error')
    expect((await run({ name: 'find_service', input: { query: 'x' }, request })).status).toBe(
      'error',
    )
  })
})

describe('助理也有这个工具', () => {
  it('给了 help 才挂；调了回查到的结果（JSON）', async () => {
    const { createAssistant } = await import('../src/assistant.js')
    const base = {
      clock: { now: () => '2026-10-22T08:00:00.000Z' },
      positions: async () => [],
      cards: async () => [],
      matters: () => [],
      timeline: () => [],
      cardPending: async () => false,
      open: async () => ({ matter_id: 'm', title: 't' }),
    } as unknown as Parameters<typeof createAssistant>[0]
    const without = createAssistant(base)
    expect(without.tools().map((t) => t.name)).not.toContain('search_workshop_help')
    expect(without.handles?.('search_workshop_help')).toBe(false)
    const withHelp = createAssistant({
      ...base,
      help: { search: (q, kind) => searchWorkshopHelp(lib, q, kind) },
    })
    expect(withHelp.tools().map((t) => t.name)).toContain('search_workshop_help')
    const actor = { workspace_id: 'ws_1', person_id: 'p_1', assignment_id: 'asg_owner' }
    const out = await withHelp.call(
      actor as never,
      { id: 'c1', name: 'search_workshop_help', input: { query: '怎么连 Shopify' } } as never,
      {} as never,
    )
    const data = JSON.parse(out.content) as { results: { title: string }[] }
    expect(data.results[0]?.title).toBe('连 Shopify 店铺')
  })
})
