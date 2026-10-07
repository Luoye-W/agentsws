/**
 * WP260：要产出东西的运行（`RunRequest.produce`）在 direct 这一档——
 * 「说了要做却停下」会被续跑（有上限、只对 produce 生效）；压缩按工作类型（先压过时的、最近几条不压、换成摘要）。
 */
import type { ChatMessage, RunProduce, RunRequest } from '@agentsws/contracts'
import { COMPACTED_MARK, compactSummary, fileTouch, UNFINISHED_STEP } from '@agentsws/stand-ins'
import { describe, expect, it } from 'vitest'
import { COMPACT_PLACEHOLDER, compactHistoryFor, historyTokens } from '../src/index.js'
import { eventsOf, harness, makeRequest } from './helpers.js'

const PRODUCE: RunProduce = {
  deliver_tools: ['theme_push_unpublished', 'theme_publish'],
  max_nudges: 3,
  compact_at_tokens: 48_000,
  keep_recent_results: 6,
}

const THEME_TOOLS = {
  theme_read_file: (input: Record<string, unknown>) => ({
    status: 'ok' as const,
    data: { path: String(input.path), content: `content of ${String(input.path)}` },
  }),
  theme_write_file: (input: Record<string, unknown>) => ({
    status: 'ok' as const,
    data: { path: String(input.path), bytes: 10, created: false },
  }),
  theme_push_unpublished: () => ({
    status: 'ok' as const,
    data: {
      theme_id: '200001',
      theme_name: 'Rollout 首页 v1',
      preview_url: 'https://x.myshopify.com/?preview_theme_id=200001',
      changed_files: ['templates/index.json'],
    },
  }),
}

const themeRequest = (produce?: RunProduce): RunRequest => {
  const base = makeRequest({ grounding: [] })
  return {
    ...base,
    actor: { ...base.actor, role_id: 'site.shopify-theme' },
    tools: { ...base.tools, allow: Object.keys(THEME_TOOLS).sort() },
    expectations: { outputs: ['draft', 'answer'], must_stage_if_change_requested: false },
    budget: { ...base.budget, max_tool_calls: 60, max_tokens: 400_000 },
    ...(produce === undefined ? {} : { produce }),
  }
}

const CI16 = '现在读首页模板、FAQ/容器分区、标题块的 schema，并顺手看店里有没有可引用的商品。'

describe('WP260 说了要做却停下 → 续跑（direct）', () => {
  it('ci.16 那句「现在读…」不收工：续一回合，接着写 → 推 → 交代结果', async () => {
    let n = 0
    const h = harness({
      tools: THEME_TOOLS,
      script: () => {
        n += 1
        if (n === 1)
          return { tool_calls: [{ name: 'theme_read_file', input: { path: 'AGENTS.md' } }] }
        if (n === 2) return { text: CI16 }
        if (n === 3)
          return {
            tool_calls: [
              { name: 'theme_write_file', input: { path: 'templates/index.json', content: '{}' } },
              { name: 'theme_push_unpublished', input: { name: 'Rollout 首页 v1' } },
            ],
          }
        return { text: '预览好了：推成了一份未发布主题「Rollout 首页 v1」。' }
      },
    })
    const result = await h.run(themeRequest(PRODUCE))
    expect(result.status).toBe('completed')
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === UNFINISHED_STEP)).toEqual([
      { type: 'progress', step: UNFINISHED_STEP, note: '1/3' },
    ])
    expect(h.toolCalls.map((c) => c.name)).toEqual([
      'theme_read_file',
      'theme_write_file',
      'theme_push_unpublished',
    ])
    expect(result.outputs).toEqual([
      { kind: 'answer', text: '预览好了：推成了一份未发布主题「Rollout 首页 v1」。' },
    ])
  })

  it('普通运行（没有 produce）同一句照旧收工——不影响问答', async () => {
    const h = harness({ tools: THEME_TOOLS, script: [{ text: CI16 }] })
    const result = await h.run(themeRequest())
    expect(result.status).toBe('completed')
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === UNFINISHED_STEP)).toEqual([])
    expect(result.outputs).toEqual([{ kind: 'answer', text: CI16 }])
  })

  it('produce 的运行回的是答案（不是「我接下来要…」）不续', async () => {
    const answer = '首页加载慢主要在三处：首屏大图没压缩、第三方脚本、字体。按影响从大到小……'
    const h = harness({ tools: THEME_TOOLS, script: [{ text: answer }] })
    const result = await h.run(themeRequest(PRODUCE))
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === UNFINISHED_STEP)).toEqual([])
    expect(result.outputs).toEqual([{ kind: 'answer', text: answer }])
  })

  it('一直只说不做：最多续 3 次就收', async () => {
    const h = harness({ tools: THEME_TOOLS, script: () => ({ text: '接下来我去改首页模板。' }) })
    const result = await h.run(themeRequest(PRODUCE))
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === UNFINISHED_STEP)).toHaveLength(3)
    expect(result.status).toBe('completed')
  })

  it('已经推过预览，再说「接下来…」不续（产出了）', async () => {
    let n = 0
    const h = harness({
      tools: THEME_TOOLS,
      script: () => {
        n += 1
        return n === 1
          ? { tool_calls: [{ name: 'theme_push_unpublished', input: { name: 'v1' } }] }
          : { text: '接下来你可以打开预览看看，满意了跟我说发布。' }
      },
    })
    await h.run(themeRequest(PRODUCE))
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === UNFINISHED_STEP)).toEqual([])
  })
})

describe('WP260 压缩按工作类型（compactHistoryFor）', () => {
  const read = (id: string, path: string, body: string): ChatMessage[] => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name: 'theme_read_file', input: { path } }],
    },
    { role: 'tool', name: 'theme_read_file', tool_call_id: id, content: body },
  ]
  const write = (id: string, path: string): ChatMessage[] => [
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, name: 'theme_write_file', input: { path, content: '{}' } }],
    },
    { role: 'tool', name: 'theme_write_file', tool_call_id: id, content: 'ok' },
  ]
  const big = (c: string): string => c.repeat(8000)
  const lines = new Map<string, string>([
    ['r1', `${COMPACTED_MARK} 读过 AGENTS.md`],
    ['r2', `${COMPACTED_MARK} 读过 templates/index.json`],
    ['r3', `${COMPACTED_MARK} 读过 sections/hero.liquid`],
    ['r4', `${COMPACTED_MARK} 读过 templates/index.json（又一次）`],
  ])
  const policy = {
    keepRecent: 2,
    summaryOf: (id: string) => lines.get(id),
    touchOf: fileTouch,
    compactedMark: COMPACTED_MARK,
  }

  it('先压过时的（同一文件后来又读 / 写过），最近两条不压，换成摘要不换空占位', () => {
    const messages: ChatMessage[] = [
      { role: 'system', content: 'prefix' },
      ...read('r1', 'AGENTS.md', big('a')),
      ...read('r2', 'templates/index.json', big('b')),
      ...read('r3', 'sections/hero.liquid', big('c')),
      ...read('r4', 'templates/index.json', big('d')),
      ...write('w1', 'sections/custom-x.liquid'),
    ]
    const limit = Math.floor(historyTokens(messages, []) * 0.9)
    const out = compactHistoryFor(messages, [], limit, policy)
    const byId = (id: string) => out.messages.find((m) => m.tool_call_id === id)?.content
    // 过时的那次（r2）先压；之后按旧到新压 r1，压到阈值七成为止；r4（最近）不压
    expect(byId('r2')).toBe(lines.get('r2'))
    expect(byId('r1')).toBe(lines.get('r1'))
    expect(byId('r4')).toBe(big('d'))
    expect(byId('w1')).toBe('ok')
    expect(historyTokens(out.messages, [])).toBeLessThanOrEqual(Math.floor(limit * 0.7))
    expect(out.messages.some((m) => m.content === COMPACT_PLACEHOLDER)).toBe(false)
  })

  it('写过之后，之前那次读同一个文件的结果就过时了', () => {
    const messages: ChatMessage[] = [
      ...read('r1', 'AGENTS.md', big('a')),
      ...read('r2', 'templates/index.json', big('b')),
      ...write('w1', 'templates/index.json'),
      ...read('r3', 'sections/hero.liquid', 'small'),
    ]
    const limit = Math.floor(historyTokens(messages, []) * 0.9)
    const out = compactHistoryFor(messages, [], limit, { ...policy, keepRecent: 3 })
    expect(out.messages.find((m) => m.tool_call_id === 'r2')?.content).toBe(lines.get('r2'))
    expect(out.messages.find((m) => m.tool_call_id === 'r1')?.content).toBe(big('a'))
  })

  it('没超阈值的七成就一条都不动', () => {
    const messages = read('r1', 'AGENTS.md', 'short')
    const out = compactHistoryFor(messages, [], 1_000_000, policy)
    expect(out.compacted).toBe(0)
  })

  it('摘要写清读过哪个文件 + 要点（Liquid 的 schema 设置 id、模板的分区顺序）', () => {
    const liquid = compactSummary(
      'theme_read_file',
      { path: 'sections/hero.liquid' },
      {
        path: 'sections/hero.liquid',
        content:
          '<section></section>\n{% schema %}{"name":"Hero","settings":[{"id":"heading","type":"text"},{"id":"image","type":"image_picker"}],"blocks":[{"type":"@theme"}]}{% endschema %}',
      },
    )
    expect(liquid).toContain('读过 sections/hero.liquid')
    expect(liquid).toContain('设置 heading, image')
    expect(liquid).toContain('块 @theme')
    const tpl = compactSummary(
      'theme_read_file',
      { path: 'templates/index.json' },
      {
        path: 'templates/index.json',
        content:
          '{"sections":{"hero":{"type":"hero"},"faq_1":{"type":"faq"}},"order":["hero","faq_1"]}',
      },
    )
    expect(tpl).toContain('分区 hero, faq_1(faq)')
    expect(tpl).toContain('顺序 hero, faq_1')
  })

  it('运行里：produce 的阈值是请求给的（4.8 万），没到就一步都不压', async () => {
    let n = 0
    const h = harness({
      tools: THEME_TOOLS,
      script: () => {
        n += 1
        return n <= 3
          ? { tool_calls: [{ name: 'theme_read_file', input: { path: `f${n}.md` } }] }
          : { text: '首页结构是这样的……' }
      },
    })
    await h.run(themeRequest(PRODUCE))
    expect(eventsOf(h.events, 'progress').filter((e) => e.step === 'compact')).toEqual([])
  })
})
