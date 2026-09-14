/**
 * WP56 第 4 件：知识包 `kefu-knowledge-pack/v1` 的双向转换（48 §4 #9 / §5.1）。
 */
import { Buffer } from 'node:buffer'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canActivatePackEntry,
  cardsToPack,
  createKnowledge,
  type Knowledge,
  PACK_MAX_ENTRY_CHARS,
  packEntryToCard,
  packFileOf,
  parseKnowledgePack,
  splitMarkdownSections,
  unzipFiles,
  zipFiles,
} from '../src/index.js'
import { activated, cardInput, testClock, WS } from './fixtures.js'

const open: Knowledge[] = []
afterEach(() => {
  for (const k of open.splice(0)) k.close()
})
const make = () => {
  const k = createKnowledge({ clock: testClock(), workspace_id: WS })
  open.push(k)
  return k
}

const MANIFEST = `name: Acme 客服包
version: 1.2.0
product: Acme Widget
generatedAt: 2026-09-01
generator: some-ai
languages: [zh, en]
`

const POLICIES = `---
title: 政策
category: 08-policies
audience: customer
source_paths:
  - https://acme.example/policy
last_verified: 2026-09-01
confidence: high
stage_scope: postsales
---

# 政策

## 退款窗口

德国站退货窗口 30 天，退货运费由客户承担。

## 保修

保修 24 个月。
`

const FEATURES = `---
title: Webhook
category: 02-features
audience: internal
confidence: medium
---

## Webhook 重试

失败后重试 3 次，间隔 5 分钟。
`

const pack = () => [
  { path: 'pack.yaml', content: MANIFEST },
  { path: '08-policies.md', content: POLICIES },
  { path: '02-features/webhooks.md', content: FEATURES },
]

describe('知识包解析', () => {
  it('读得出清单与条目，按标题切分', () => {
    const r = parseKnowledgePack(pack())
    if (!r.ok) throw new Error(r.message)
    expect(r.manifest.name).toBe('Acme 客服包')
    expect(r.manifest.languages).toEqual(['zh', 'en'])
    expect(r.entries.map((e) => e.title)).toEqual(['Webhook 重试', '退款窗口', '保修'])
  })

  it('承诺类按**文件名**判，front matter 推翻不了', () => {
    const r = parseKnowledgePack([
      { path: 'pack.yaml', content: MANIFEST },
      {
        path: '08-policies.md',
        content: POLICIES.replace('category: 08-policies', 'category: 06-troubleshooting'),
      },
    ])
    if (!r.ok) throw new Error(r.message)
    expect(r.entries.every((e) => e.commitment)).toBe(true)
  })

  it('顶层目录会被剥掉（否则文件键全错位）', () => {
    const r = parseKnowledgePack(
      pack().map((f) => ({ ...f, path: `kefu-knowledge-pack/${f.path}` })),
    )
    if (!r.ok) throw new Error(r.message)
    expect(r.entries.some((e) => e.file_key === '08-policies')).toBe(true)
  })

  it('缺 pack.yaml / 空包 / 超上限都有明确的错误码', () => {
    expect(parseKnowledgePack([{ path: 'a.md', content: '# x\n\n正文' }])).toMatchObject({
      ok: false,
      code: 'PACK_MANIFEST_MISSING',
    })
    expect(parseKnowledgePack([])).toMatchObject({ ok: false, code: 'PACK_EMPTY' })
    expect(
      parseKnowledgePack([
        { path: 'pack.yaml', content: MANIFEST },
        { path: 'big.md', content: 'x'.repeat(3 * 1024 * 1024) },
      ]),
    ).toMatchObject({ ok: false, code: 'PACK_TOO_LARGE' })
    expect(
      parseKnowledgePack(
        Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.md`, content: '# a\n\nb' })),
      ),
    ).toMatchObject({ ok: false, code: 'PACK_TOO_MANY_FILES' })
  })

  it('单条正文超 2 万字截断，不丢条目', () => {
    const r = parseKnowledgePack([
      { path: 'pack.yaml', content: MANIFEST },
      { path: '07-faq.md', content: `## 长条\n\n${'字'.repeat(30_000)}` },
    ])
    if (!r.ok) throw new Error(r.message)
    expect(r.entries).toHaveLength(1)
    expect(r.entries[0]?.body.length).toBe(PACK_MAX_ENTRY_CHARS)
  })

  it('超出 YAML 子集的行只告警不报错', () => {
    const r = parseKnowledgePack([
      { path: 'pack.yaml', content: `${MANIFEST}nested:\n  deep:\n    x: 1\n` },
      { path: '07-faq.md', content: '## 问\n\n答' },
    ])
    if (!r.ok) throw new Error(r.message)
    expect(r.warnings.length).toBeGreaterThan(0)
  })

  it('围栏代码块里的 # 不当标题', () => {
    const sections = splitMarkdownSections(
      '## 装一下\n\n```sh\n# 这是注释\nnpm i\n```\n\n## 跑一下\n\nnpm start',
      'x',
    )
    expect(sections.map((s) => s.title)).toEqual(['装一下', '跑一下'])
  })
})

describe('包 → 事实卡（48 §5.1 对照表）', () => {
  const ctx = {
    workspace_id: WS,
    owner: 'per_owner',
    scope: [],
    created_by_id: 'agent_1',
    at: '2026-09-09T09:00:00.000Z',
  }

  it('body → statement、stage_scope → stage、internal → 内部层、source_paths → 出处', () => {
    const r = parseKnowledgePack(pack())
    if (!r.ok) throw new Error(r.message)
    const refund = r.entries.find((e) => e.title === '退款窗口')
    const card = packEntryToCard(refund as never, ctx)
    expect(card.statement).toContain('30 天')
    expect(card.stage).toBe('postsales')
    expect(card.sensitivity).toBe('public')
    expect(card.provenance[0]?.ref).toBe('https://acme.example/policy')
    expect(card.last_verified_at).toBe('2026-09-01T00:00:00.000Z')
    expect(card.valid.from).toBe('2026-09-01T00:00:00.000Z')
    expect(card.source_content_hash).toBe(refund?.content_hash)
    expect(Object.keys(card.fact_fingerprint ?? {})).toContain('duration:day:30')
    expect(card.layer).toBe('policy')

    const webhook = r.entries.find((e) => e.title === 'Webhook 重试')
    expect(packEntryToCard(webhook as never, ctx).sensitivity).toBe('internal')
  })

  it('没写 last_verified 就是没写——绝不伪造成今天', () => {
    const r = parseKnowledgePack(pack())
    if (!r.ok) throw new Error(r.message)
    const webhook = r.entries.find((e) => e.title === 'Webhook 重试')
    expect(webhook?.last_verified).toBe(null)
    expect('last_verified_at' in packEntryToCard(webhook as never, ctx)).toBe(false)
  })

  it('承诺类文件的条目一律落候选（永不自动激活）', () => {
    const r = parseKnowledgePack(pack())
    if (!r.ok) throw new Error(r.message)
    const refund = r.entries.find((e) => e.title === '退款窗口')
    // confidence: high 且有核实日期，可它是 08-policies 里的
    expect(refund?.confidence).toBe('high')
    expect(canActivatePackEntry(refund as never)).toBe(false)
  })

  it('stale 的条目进来就是 stale', () => {
    const r = parseKnowledgePack([
      { path: 'pack.yaml', content: MANIFEST },
      { path: '07-faq.md', content: '---\nverification: stale\n---\n\n## 问\n\n答' },
    ])
    if (!r.ok) throw new Error(r.message)
    expect(packEntryToCard(r.entries[0] as never, ctx).verification_state).toBe('stale')
  })
})

describe('事实卡 → 包 → 事实卡（双向）', () => {
  it('往返之后适用范围 / 出处 / 核实日期 / 正文都还在', async () => {
    const k = make()
    await activated(
      k,
      cardInput({
        layer: 'policy',
        stage: 'postsales',
        statement: '德国站退货窗口 30 天',
        last_verified_at: '2026-09-01T00:00:00.000Z',
        provenance: [
          { source: 'web', ref: 'https://acme.example/policy', at: '2026-09-01T00:00:00.000Z' },
        ],
      }),
    )
    const cards = await k.store.list(
      { workspace_id: WS },
      {
        person_id: 'per_owner',
        assignment_id: 'asg_owner',
        role_id: 'common.owner',
        workspace_id: WS,
        grants: [
          { domain: 'knowledge', ops: ['read'], range: 'workspace', max_sensitivity: 'restricted' },
        ],
      },
    )
    const files = cardsToPack(cards, {
      name: 'ws_1',
      version: '1',
      generated_at: '2026-09-09T09:00:00.000Z',
    })
    expect(files.some((f) => f.path === 'pack.yaml')).toBe(true)
    expect(files.some((f) => f.path === '08-policies.md')).toBe(true)

    const back = parseKnowledgePack(files)
    if (!back.ok) throw new Error(back.message)
    const entry = back.entries[0]
    expect(entry?.stage).toBe('postsales')
    expect(entry?.body).toContain('30 天')
    expect(entry?.last_verified).toBe('2026-09-01')
    expect(entry?.source_paths).toContain('https://acme.example/policy')
    expect(entry?.commitment).toBe(true)
  })

  it('层决定进哪个文件（读回来承诺类判定才对得上）', async () => {
    const k = make()
    const policy = await activated(k, cardInput({ layer: 'policy' }))
    const fact = await activated(
      k,
      cardInput({ subject: { type: 'fact_card', key: 'x' }, statement: '随便一条' }),
    )
    expect(packFileOf(policy)).toBe('08-policies.md')
    expect(packFileOf(fact)).toBe('01-product-overview.md')
  })
})

describe('zip', () => {
  it('打包再解包，带一层目录也不丢', () => {
    const files = pack()
    const back = unzipFiles(zipFiles(files))
    expect(back.map((f) => f.path).sort()).toEqual(files.map((f) => f.path).sort())
    expect(back.find((f) => f.path === 'pack.yaml')?.content).toBe(MANIFEST)
  })

  it('路径穿越与绝对路径一律拒', () => {
    const evil = zipFiles([{ path: '../../etc/passwd', content: 'x' }])
    expect(() => unzipFiles(evil)).toThrow(/路径穿越/)
    expect(() => unzipFiles(zipFiles([{ path: '/etc/passwd', content: 'x' }]))).toThrow(/绝对路径/)
  })

  it('__MACOSX 与 .DS_Store 静默跳过', () => {
    const back = unzipFiles(
      zipFiles([
        { path: 'pack.yaml', content: MANIFEST },
        { path: '__MACOSX/._pack.yaml', content: 'junk' },
        { path: '.DS_Store', content: 'junk' },
      ]),
    )
    expect(back.map((f) => f.path)).toEqual(['pack.yaml'])
  })

  it('不是 zip 就报错，不静默吞', () => {
    expect(() => unzipFiles(Buffer.from('hello world'))).toThrow(/zip/)
  })
})
