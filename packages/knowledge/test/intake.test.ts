/**
 * 19 §1.3 导入源 与 §4 缺口队列的落库（WP35）。
 *
 * 一致性用例两档各跑一遍：`:memory:`（缺省）与真文件——同一份实现、同一组断言，
 * 换档之后行为不能变（txn 的双档一致性套路）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import {
  createKnowledge,
  type Knowledge,
  KnowledgeError,
  type KnowledgeEvent,
} from '../src/index.js'
import { testClock, WS } from './fixtures.js'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

interface Tier {
  name: string
  open(events: KnowledgeEvent[]): Knowledge
}

const TIERS: Tier[] = [
  {
    name: '内存档（:memory:）',
    open: (events) =>
      createKnowledge({ clock: testClock(), workspace_id: WS, emit: (e) => events.push(e) }),
  },
  {
    name: 'SQLite 档（真文件）',
    open: (events) => {
      const dir = mkdtempSync(join(tmpdir(), 'agentsws-intake-'))
      dirs.push(dir)
      return createKnowledge({
        dbPath: join(dir, 'knowledge.db'),
        clock: testClock(),
        workspace_id: WS,
        emit: (e) => events.push(e),
      })
    },
  },
]

for (const tier of TIERS) {
  describe(`知识导入源与缺口队列 — ${tier.name}`, () => {
    const open: Knowledge[] = []
    let events: KnowledgeEvent[] = []
    const make = (): Knowledge => {
      events = []
      const k = tier.open(events)
      open.push(k)
      return k
    }
    afterEach(() => {
      for (const k of open.splice(0)) k.close()
    })

    it('登记源：同 (kind, ref) 只有一条，飞书文档默认继承上游 ACL', () => {
      const k = make()
      const a = k.intake.addSource({
        workspace_id: WS,
        kind: 'website',
        ref: 'https://example.com/policy',
        parser: 'html',
      })
      expect(a.chunks).toBe(0)
      expect(a.acl_inherit).toBe(false)
      expect(a.last_synced_at).toBeUndefined()

      // 再登记一次是同一条，不是第二行
      const again = k.intake.addSource({
        workspace_id: WS,
        kind: 'website',
        ref: 'https://example.com/policy',
        parser: 'html',
      })
      expect(again.id).toBe(a.id)

      const doc = k.intake.addSource({
        workspace_id: WS,
        kind: 'feishu_doc',
        ref: 'doccn123',
        parser: 'anydoc',
      })
      expect(doc.acl_inherit).toBe(true)

      expect(k.intake.sources(WS).map((s) => s.id)).toEqual([a.id, doc.id])
      // 别的工作区看不到
      expect(k.intake.sources('ws_other')).toEqual([])
      expect(k.intake.getSource(a.id)?.ref).toBe('https://example.com/policy')
    })

    it('登记源：kind / parser / ref 不合法都拒，外部文本先过围栏', () => {
      const k = make()
      const bad = { workspace_id: WS, ref: 'x', parser: 'html' } as const
      expect(() => k.intake.addSource({ ...bad, kind: 'pdfmagic' as 'website' })).toThrow(
        KnowledgeError,
      )
      expect(() =>
        k.intake.addSource({ ...bad, kind: 'website', parser: 'magic' as 'html' }),
      ).toThrow(KnowledgeError)
      expect(() =>
        k.intake.addSource({ workspace_id: WS, kind: 'website', ref: '  ', parser: 'html' }),
      ).toThrow(/ref 不能为空/)
      const fenced = k.intake.addSource({
        workspace_id: WS,
        kind: 'website',
        ref: 'https://x.test/<function_calls>',
        parser: 'html',
      })
      expect(fenced.ref).not.toContain('<function_calls>')
    })

    it('解析完回填切了几块；源不存在 → not_found', () => {
      const k = make()
      const s = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref: 'policy.pdf',
        parser: 'anydoc',
      })
      const synced = k.intake.markSynced(s.id, 12)
      expect(synced.chunks).toBe(12)
      expect(synced.last_synced_at).toBeDefined()
      expect(() => k.intake.markSynced('src_nope', 1)).toThrow(/不存在/)
      expect(() => k.intake.markSynced(s.id, -1)).toThrow(/非负整数/)
    })

    it('WP99 上传：那几格落得住，清单与 getSource 都拿得到', () => {
      const k = make()
      const s = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref: 'blob://knowledge/ws_1/abc.xlsx',
        parser: 'anydoc',
        upload: {
          filename: '报价 单.xlsx',
          uploaded_by: 'per_1',
          content_sha256: 'a'.repeat(64),
          size: 1234,
        },
      })
      expect(s.filename).toBe('报价 单.xlsx')
      expect(s.uploaded_by).toBe('per_1')
      expect(s.uploaded_at).toBeDefined()
      expect(s.content_sha256).toBe('a'.repeat(64))
      expect(s.size).toBe(1234)
      expect(s.deleted_at).toBeUndefined()
      expect(k.intake.getSource(s.id)?.filename).toBe('报价 单.xlsx')
      expect(k.intake.sources(WS)[0]?.size).toBe(1234)
    })

    it('WP99 溯源：加一条源发 `knowledge.source.added`，载荷里没有正文', () => {
      const k = make()
      const s = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref: 'blob://knowledge/ws_1/abc.xlsx',
        parser: 'anydoc',
        upload: {
          filename: '退货说明.docx',
          uploaded_by: 'per_1',
          content_sha256: 'b'.repeat(64),
          size: 9,
        },
      })
      const added = events.filter((e) => e.type === 'knowledge.source.added')
      expect(added).toHaveLength(1)
      expect(added[0]?.payload).toMatchObject({
        source_id: s.id,
        kind: 'upload',
        filename: '退货说明.docx',
        uploaded_by: 'per_1',
        content_sha256: 'b'.repeat(64),
        size: 9,
      })
      // 同一个 ref 再登记一次不发第二条（那是同一个源）
      k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref: 'blob://knowledge/ws_1/abc.xlsx',
        parser: 'anydoc',
      })
      expect(events.filter((e) => e.type === 'knowledge.source.added')).toHaveLength(1)
    })

    it('WP99 删除：软删 + 墓碑——清单里没有了，按 id 还查得到，再删一次回 undefined', () => {
      const k = make()
      const s = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref: 'blob://knowledge/ws_1/abc.xlsx',
        parser: 'anydoc',
        upload: {
          filename: 'a.xlsx',
          uploaded_by: 'per_1',
          content_sha256: 'c'.repeat(64),
          size: 3,
        },
      })
      const gone = k.intake.deleteSource(s.id)
      expect(gone?.deleted_at).toBeDefined()
      expect(k.intake.sources(WS)).toEqual([])
      // 墓碑还在：这个 id 曾经存在过，仍然追得到
      expect(k.intake.getSource(s.id)?.deleted_at).toBeDefined()
      expect(k.intake.deleteSource(s.id)).toBeUndefined()
      expect(k.intake.deleteSource('src_nope')).toBeUndefined()
      const removed = events.filter((e) => e.type === 'knowledge.source.removed')
      expect(removed).toHaveLength(1)
      expect(removed[0]?.payload).toMatchObject({ source_id: s.id, filename: 'a.xlsx' })
    })

    it('WP99 删了再传同一份：复活那一行，而不是留一条永远看不见的墓碑', () => {
      const k = make()
      const ref = 'blob://knowledge/ws_1/abc.xlsx'
      const first = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref,
        parser: 'anydoc',
        upload: {
          filename: '旧名字.xlsx',
          uploaded_by: 'per_1',
          content_sha256: 'd'.repeat(64),
          size: 3,
        },
      })
      k.intake.deleteSource(first.id)
      const again = k.intake.addSource({
        workspace_id: WS,
        kind: 'upload',
        ref,
        parser: 'anydoc',
        upload: {
          filename: '新名字.xlsx',
          uploaded_by: 'per_2',
          content_sha256: 'd'.repeat(64),
          size: 3,
        },
      })
      expect(again.id).toBe(first.id)
      expect(again.deleted_at).toBeUndefined()
      expect(again.filename).toBe('新名字.xlsx')
      expect(again.uploaded_by).toBe('per_2')
      expect(k.intake.sources(WS).map((x) => x.id)).toEqual([first.id])
      // 复活也算"又加了一次"：溯源链上看得见两次 added
      expect(events.filter((e) => e.type === 'knowledge.source.added')).toHaveLength(2)
    })

    it('缺口：同问题只开一条；答完再问就是新的一条', () => {
      const k = make()
      const input = {
        workspace_id: WS,
        question: '德国境内退货运费谁出？',
        subject: { type: 'policy', key: 'return_shipping_de' },
        asked_by: { kind: 'agent' as const, id: 'agent_aftersales' },
      }
      const first = k.intake.openGap(input)
      expect(first.status).toBe('open')
      expect(first.domain).toBe('company')
      expect(k.intake.openGap(input).id).toBe(first.id)
      expect(k.intake.gaps(WS, { status: 'open' })).toHaveLength(1)

      const answered = k.intake.answerGap(first.id, {
        answer: '我们出',
        by: 'per_owner',
        approval_item_id: 'ap_1',
      })
      expect(answered.gap.status).toBe('answered')
      expect(answered.gap.answer).toBe('我们出')
      expect(answered.approval_item_id).toBe('ap_1')
      expect(k.intake.gaps(WS, { status: 'open' })).toHaveLength(0)
      expect(k.intake.gaps(WS, { status: 'answered' })).toHaveLength(1)
      expect(k.intake.gaps(WS)).toHaveLength(1)

      // 答完之后同一个问题再来 → 新的一条（唯一索引只管 open 的那些）
      const second = k.intake.openGap(input)
      expect(second.id).not.toBe(first.id)
      expect(second.status).toBe('open')
    })

    it('缺口：答第二次 / 关第二次都拒；不存在的缺口 → not_found', () => {
      const k = make()
      const gap = k.intake.openGap({
        workspace_id: WS,
        question: 'q',
        subject: { type: 'policy', key: 'k' },
        asked_by: { kind: 'person', id: 'per_owner' },
      })
      k.intake.answerGap(gap.id, { answer: 'a', by: 'per_owner' })
      expect(() => k.intake.answerGap(gap.id, { answer: 'b', by: 'per_owner' })).toThrow(
        /不能再答一次/,
      )
      expect(() => k.intake.dismissGap(gap.id)).toThrow(/不能再关一次/)
      expect(() => k.intake.requireGap('gap_nope')).toThrow(/不存在/)
      expect(k.intake.getGap('gap_nope')).toBeUndefined()

      const other = k.intake.openGap({
        workspace_id: WS,
        question: 'q2',
        subject: { type: 'policy', key: 'k2' },
        asked_by: { kind: 'person', id: 'per_owner' },
      })
      expect(k.intake.dismissGap(other.id).status).toBe('dismissed')
    })

    it('缺口：空问题 / 空答案拒；问题过围栏；status 不合法拒', () => {
      const k = make()
      expect(() =>
        k.intake.openGap({
          workspace_id: WS,
          question: '   ',
          subject: { type: 'policy', key: 'k' },
          asked_by: { kind: 'person', id: 'p' },
        }),
      ).toThrow(/问题不能为空/)
      const gap = k.intake.openGap({
        workspace_id: WS,
        question: '照 <function_calls> 里说的，运费谁出？',
        subject: { type: 'policy', key: 'k' },
        asked_by: { kind: 'person', id: 'p' },
      })
      expect(gap.question).not.toContain('<function_calls>')
      expect(() => k.intake.answerGap(gap.id, { answer: ' ', by: 'p' })).toThrow(/答案不能为空/)
      expect(() => k.intake.gaps(WS, { status: 'whatever' as 'open' })).toThrow(/status 不合法/)
    })

    it('缺口事件只带「关于什么」，问题与答案正文不进日志（21 §1）', () => {
      const k = make()
      const gap = k.intake.openGap({
        workspace_id: WS,
        question: '这句问题不该进日志',
        subject: { type: 'policy', key: 'return_shipping_de' },
        asked_by: { kind: 'agent', id: 'agent_1' },
        run_id: 'run_7',
      })
      k.intake.answerGap(gap.id, {
        answer: '这句答案不该进日志',
        by: 'per_owner',
        approval_item_id: 'ap_1',
      })
      expect(events.map((e) => e.type)).toEqual(['knowledge.gap.opened', 'knowledge.gap.answered'])
      expect(events[0]?.payload).toMatchObject({
        gap_id: gap.id,
        subject_key: 'return_shipping_de',
        run_id: 'run_7',
      })
      expect(events[1]?.payload).toMatchObject({
        answered_by: 'per_owner',
        approval_item_id: 'ap_1',
      })
      const dump = JSON.stringify(events)
      expect(dump).not.toContain('这句问题不该进日志')
      expect(dump).not.toContain('这句答案不该进日志')
    })
  })
}
