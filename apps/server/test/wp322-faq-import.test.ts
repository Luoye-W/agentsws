/**
 * WP322（docs/102 §5.4，决策 670）：FAQ 表导入器——认列 → 定规矩卡 → 一行一张知识卡。
 *
 * 这一组用一条内存审批总线（替身）钉导入器自己的几条路：① 当场生效、只加新的、表里删行只提示 /
 * 撤下、③ 交负责人整批批 / 作废、规则认不出时问 AI、人改过的映射。
 * 端到端（真上传路由 → 真总线 → 真卡）在 `wp322-faq-import-e2e.test.ts`。
 *
 * 表格全是现编的假问答，不放任何真实客户数据。
 */
import { Buffer } from 'node:buffer'
import type {
  ApprovalBus,
  ApprovalItem,
  CreateApprovalInput,
  FaqBatchPayload,
  FaqImportPayload,
  KnowledgeSource,
} from '@agentsws/contracts'
import { createKnowledge, type Knowledge } from '@agentsws/knowledge'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createFaqImporter, type FaqImportDeps, faqCardsOf } from '../src/faq-import.js'

const WS = 'ws_faq'
const UP = 'p_uploader'
const OWNER = 'p_owner'
const T0 = '2026-10-14T09:00:00.000Z'
const actor = (person_id = UP) => ({
  person_id,
  workspace_id: WS,
  assignment_id: 'asg_up',
  role_id: 'common.member',
})

/** 最小的内存审批总线：建卡、按 id 取、记决定（选项 / 改过的载荷）。 */
function fakeBus(): ApprovalBus & { items: ApprovalItem[] } {
  const items: ApprovalItem[] = []
  const bus = {
    items,
    async create<P>(input: CreateApprovalInput<P>) {
      const open = items.find(
        (i) =>
          i.dedupe_key === input.dedupe_key && (i.state === 'pending' || i.state === 'proposed'),
      )
      if (open !== undefined) return open as ApprovalItem<P>
      const item = {
        ...input,
        id: `apv_${items.length + 1}`,
        revision: 1,
        state: 'pending',
        deliveries: [],
        links: { children: [], ...(input.links ?? {}) },
        created_at: T0,
        updated_at: T0,
        automation: {
          auto_approved: false,
          mandate_check: { within: false, caps_hit: [] },
          sampling: { selected: false },
          ...input.automation,
        },
      } as unknown as ApprovalItem<P>
      items.push(item as ApprovalItem)
      return item
    },
    async get(id: string) {
      return items.find((i) => i.id === id)
    },
    async recordApply(id: string, state: string) {
      const item = items.find((i) => i.id === id)
      if (item !== undefined) item.state = state as ApprovalItem['state']
    },
  }
  return bus as unknown as ApprovalBus & { items: ApprovalItem[] }
}

function decided(
  item: ApprovalItem,
  by: string,
  input: { option?: string; reject?: boolean; edited?: unknown },
): ApprovalItem {
  item.state =
    input.reject === true ? 'rejected' : input.edited === undefined ? 'approved' : 'approved_edited'
  item.decision = {
    by,
    at: T0,
    action: input.reject === true ? 'reject' : 'approve',
    via: 'workstation',
    ...(input.option === undefined ? {} : { selected_option_id: input.option }),
    ...(input.edited === undefined ? {} : { edited_payload: input.edited }),
  } as ApprovalItem['decision']
  return item
}

let knowledge: Knowledge
let bus: ReturnType<typeof fakeBus>
let files: Map<string, Uint8Array>
let flow: boolean
let mapperCalls: string[]
let mapperAnswer: string | undefined

const deps = (): FaqImportDeps => ({
  clock: { now: () => T0 },
  knowledge,
  approvals: bus,
  readSource: async (s) => files.get(s.id),
  approvalFlow: async () => flow,
  approverOf: async () => OWNER,
  mapper: async (_a, prompt) => {
    mapperCalls.push(prompt)
    return mapperAnswer
  },
})

function addCsv(name: string, text: string): KnowledgeSource {
  const bytes = new Uint8Array(Buffer.from(text, 'utf8'))
  const source = knowledge.intake.addSource({
    workspace_id: WS,
    kind: 'upload',
    ref: `blob://knowledge/${WS}/f${files.size + 1}.csv`,
    parser: 'anydoc',
    acl_inherit: false,
    upload: {
      filename: name,
      uploaded_by: UP,
      uploaded_at: T0,
      content_sha256: `${text.length}`,
      size: bytes.length,
    },
  })
  files.set(source.id, bytes)
  return source
}

const V1 =
  '问题,答案,分类\n几天到？,3–5 天。,配送\n保修多久？,一年。,保修\n能退吗？,七天无理由。,售后\n'
const V2 =
  '问题,答案,分类\n几天到？,3–5 天。,配送\n保修多久？,两年。,保修\n支持快充吗？,支持。,续航\n'

beforeEach(() => {
  knowledge = createKnowledge({ workspace_id: WS, clock: { now: () => T0 } })
  bus = fakeBus()
  files = new Map()
  flow = false
  mapperCalls = []
  mapperAnswer = undefined
})
afterEach(() => {
  knowledge.close()
})

const active = () => faqCardsOf(knowledge, WS).filter((c) => c.status === 'active')
const answers = () =>
  Object.fromEntries(
    active().map((c) => [String(c.structured?.question), String(c.structured?.answer)]),
  )

describe('WP322 ① 个人：一张定规矩卡，记下当场生效', () => {
  it('认出问答表 → 一张卡（映射 + 预览）→ 记下 → 一行一张卡、带出处、当场生效', async () => {
    const imp = createFaqImporter(deps())
    const card = await imp.detect(actor(), addCsv('售后FAQ.csv', V1))
    expect(card?.kind).toBe('policy_change')
    const p = card?.payload as FaqImportPayload
    expect(card?.title).toBe('「售后FAQ.csv」导入 3 条问答')
    expect(card?.summary).toBe('记下后当场生效，知识库里能改、能删。')
    expect(p.sheets[0]?.columns.map((c) => [c.field, c.header])).toEqual([
      ['question', '问题'],
      ['answer', '答案'],
      ['category', '分类'],
    ])
    expect(p.preview).toEqual([
      { question: '几天到？', answer: '3–5 天。' },
      { question: '保修多久？', answer: '一年。' },
    ])
    expect(p.options.map((o) => o.label)).toEqual(['记下', '不用'])
    expect(mapperCalls).toEqual([]) // 规则认得出就不问 AI

    await imp.onDecided(decided(card as ApprovalItem, UP, { option: 'all' }))
    expect(answers()).toEqual({
      '几天到？': '3–5 天。',
      '保修多久？': '一年。',
      '能退吗？': '七天无理由。',
    })
    const one = active().find((c) => c.structured?.question === '几天到？')
    expect(one?.provenance[0]).toMatchObject({
      source: 'document',
      locator: '售后FAQ.csv › 第 2 行',
    })
    expect(card?.state).toBe('applied')
  })

  it('「不用」什么都不建；再传一份一模一样的表不出卡', async () => {
    const imp = createFaqImporter(deps())
    const card = await imp.detect(actor(), addCsv('a.csv', V1))
    await imp.onDecided(decided(card as ApprovalItem, UP, { option: 'skip' }))
    expect(faqCardsOf(knowledge, WS)).toHaveLength(0)

    const again = await imp.detect(actor(), addCsv('a.csv', V1))
    await imp.onDecided(decided(again as ApprovalItem, UP, { option: 'all' }))
    expect(active()).toHaveLength(3)
    expect(await imp.detect(actor(), addCsv('a 副本.csv', V1))).toBeUndefined()
  })

  it('重复导入：按问题去重；答案变了出更新（新卡顶掉旧卡、冲突收掉）；删掉的行不删卡只提示', async () => {
    const imp = createFaqImporter(deps())
    const first = await imp.detect(actor(), addCsv('售后FAQ.csv', V1))
    await imp.onDecided(decided(first as ApprovalItem, UP, { option: 'all' }))
    const old = active().find((c) => c.structured?.question === '保修多久？')

    const second = await imp.detect(actor(), addCsv('售后FAQ.csv', V2))
    const p = second?.payload as FaqImportPayload
    expect(p.counts).toEqual({ new: 1, changed: 1, same: 1, removed: 1, skipped: 0 })
    expect(p.changes).toEqual([{ question: '保修多久？', before: '一年。', after: '两年。' }])
    expect(p.removed).toEqual(['能退吗？'])
    expect(p.options.map((o) => o.id)).toEqual(['all', 'new_only', 'skip'])

    await imp.onDecided(decided(second as ApprovalItem, UP, { option: 'all' }))
    expect(answers()).toEqual({
      '几天到？': '3–5 天。',
      '保修多久？': '两年。',
      '能退吗？': '七天无理由。', // 表里删了，卡还在
      '支持快充吗？': '支持。',
    })
    expect(knowledge.store.getUnchecked(old?.id as string)?.status).toBe('retired')
    const fresh = active().find((c) => c.structured?.question === '保修多久？')
    expect(fresh?.conflicts).toBeUndefined()
  })

  it('「只加新的」：答案变了的那条不动', async () => {
    const imp = createFaqImporter(deps())
    const first = await imp.detect(actor(), addCsv('f.csv', V1))
    await imp.onDecided(decided(first as ApprovalItem, UP, { option: 'all' }))
    const second = await imp.detect(actor(), addCsv('f.csv', V2))
    await imp.onDecided(decided(second as ApprovalItem, UP, { option: 'new_only' }))
    expect(answers()['保修多久？']).toBe('一年。')
    expect(answers()['支持快充吗？']).toBe('支持。')
  })

  it('只删了行：卡上是「撤下 / 留着」；撤下才退役', async () => {
    const imp = createFaqImporter(deps())
    const first = await imp.detect(actor(), addCsv('f.csv', V1))
    await imp.onDecided(decided(first as ApprovalItem, UP, { option: 'all' }))
    const fewer = await imp.detect(
      actor(),
      addCsv('f.csv', '问题,答案\n几天到？,3–5 天。\n保修多久？,一年。\n'),
    )
    expect(fewer?.title).toBe('「f.csv」里删了 1 条问答')
    expect(
      ((fewer as ApprovalItem).payload as FaqImportPayload).options.map((o) => o.label),
    ).toEqual(['撤下', '留着'])
    await imp.onDecided(decided(fewer as ApprovalItem, UP, { option: 'retire' }))
    expect(Object.keys(answers()).sort()).toEqual(['保修多久？', '几天到？'])
  })
})

describe('WP322 ③ 公司：内容交负责人一张整批卡', () => {
  it('员工记下 → 卡落 proposed + 一张整批「改东西」卡给负责人；通过 = 整批生效', async () => {
    flow = true
    const imp = createFaqImporter(deps())
    const card = await imp.detect(actor(), addCsv('f.csv', V1))
    expect(card?.summary).toBe('记下后交负责人批。')
    await imp.onDecided(decided(card as ApprovalItem, UP, { option: 'all' }))
    expect(active()).toHaveLength(0)
    expect(faqCardsOf(knowledge, WS).every((c) => c.status === 'proposed')).toBe(true)
    const batch = bus.items.find((i) => i.kind === 'knowledge_update')
    expect(batch?.routing.recipients.map((r) => r.person)).toEqual([OWNER])
    expect(((batch as ApprovalItem).payload as FaqBatchPayload).counts).toEqual({
      new: 3,
      changed: 0,
    })
    await imp.onDecided(decided(batch as ApprovalItem, OWNER, {}))
    expect(active()).toHaveLength(3)
  })

  it('负责人「不要」= 整批作废（退役留痕）；负责人自己传的不再多一张卡', async () => {
    flow = true
    const imp = createFaqImporter(deps())
    const card = await imp.detect(actor(), addCsv('f.csv', V1))
    await imp.onDecided(decided(card as ApprovalItem, UP, { option: 'all' }))
    const batch = bus.items.find((i) => i.kind === 'knowledge_update')
    await imp.onDecided(decided(batch as ApprovalItem, OWNER, { reject: true }))
    expect(faqCardsOf(knowledge, WS)).toHaveLength(0)

    const own = await imp.detect(actor(OWNER), addCsv('g.csv', V2))
    expect(own?.summary).toBe('记下后当场生效，知识库里能改、能删。')
    await imp.onDecided(decided(own as ApprovalItem, OWNER, { option: 'all' }))
    expect(active()).toHaveLength(3)
    expect(bus.items.filter((i) => i.kind === 'knowledge_update')).toHaveLength(1)
  })
})

describe('WP322 认不出时问 AI、人改映射', () => {
  const ODD =
    'Customer asks,We say,Owner\nDoes it float?,No - keep it dry.,Team A\nCan kids use it?,Yes with an adult.,Team B\n'

  it('规则认不出才问 AI；AI 认对了照样出卡（标「AI 判的」）；没接模型就不出卡', async () => {
    const imp = createFaqImporter(deps())
    expect(await imp.detect(actor(), addCsv('odd.csv', ODD))).toBeUndefined()
    expect(mapperCalls).toHaveLength(1)
    expect(mapperCalls[0]).toContain('A=Customer asks | B=We say | C=Owner')

    mapperAnswer = '{"sheets":[{"sheet":"","faq":true,"header_row":1,"question":"A","answer":"B"}]}'
    const card = await imp.detect(actor(), addCsv('odd2.csv', ODD))
    const p = card?.payload as FaqImportPayload
    expect(p.sheets[0]?.by).toBe('ai')
    expect(p.counts.new).toBe(2)
  })

  it('人在卡上改了映射（approve_edited）就按改过的读', async () => {
    const imp = createFaqImporter(deps())
    const card = await imp.detect(
      actor(),
      addCsv('f.csv', '问题,答案,英文答案\n几天到？,三到五天。,3-5 days.\n'),
    )
    const p = card?.payload as FaqImportPayload
    const sheets = p.sheets.map((s) => ({
      ...s,
      columns: s.columns.map((c) =>
        c.field === 'answer' ? { ...c, col: 2, header: '英文答案' } : c,
      ),
    }))
    await imp.onDecided(decided(card as ApprovalItem, UP, { option: 'all', edited: { sheets } }))
    expect(answers()).toEqual({ '几天到？': '3-5 days.' })
  })

  it('不是问答表、读不懂的文件、不是表格：一律不出卡', async () => {
    const imp = createFaqImporter(deps())
    expect(await imp.detect(actor(), addCsv('价目.csv', 'SKU,价格\nLB-1,99\n'))).toBeUndefined()
    const broken = addCsv('坏.csv', '')
    files.set(broken.id, new Uint8Array())
    expect(await imp.detect(actor(), broken)).toBeUndefined()
    expect(bus.items).toHaveLength(0)
  })
})
