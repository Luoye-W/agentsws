/**
 * WP509：把红人同步到用户自己的在线表——认列、认行、阶段词对选项、这一批写什么。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SYNC_WHAT,
  mapStagesToOptions,
  pickKeyColumn,
  planSync,
  proposeSyncColumns,
  type SyncCreatorRow,
  type SyncRowState,
  type SyncTableColumn,
  syncCellText,
  syncKeyOf,
} from '../src/sheet-sync.js'

const COLS: SyncTableColumn[] = [
  { name: '红人', type: 'text' },
  { name: '平台', type: 'select', options: ['YouTube', 'TikTok'] },
  { name: '主页链接', type: 'url' },
  { name: '粉丝', type: 'number' },
  {
    name: '合作状态',
    type: 'select',
    options: ['待联系', '已联系', '谈价中', '寄样中', '已发布', '拒绝'],
  },
  { name: '快递单号', type: 'text' },
  { name: '编号', type: 'readonly' },
  { name: '我也不知道', type: 'text' },
]

const row = (over: Partial<SyncCreatorRow> & { creator_id: string }): SyncCreatorRow => ({
  values: {
    name: 'Desk Fixture',
    channel: 'YouTube',
    url: 'https://www.youtube.com/@deskfixture',
    followers: '48000',
  },
  stage: 'contacted',
  new_since_on: false,
  in_pipeline: true,
  ...over,
})

describe('认列', () => {
  it('规则认（与导入同一张别名表 + 寄样单号这类同步才有的），只读列不写，AI 只能补规则认不出的', () => {
    const cols = proposeSyncColumns(
      COLS,
      [],
      [
        { column: '我也不知道', field: 'tags' },
        // 规则已经认成「名字」的列，AI 改不了
        { column: '红人', field: 'email' },
        { column: '编号', field: 'progress' },
      ],
    )
    const by = Object.fromEntries(cols.map((c) => [c.name, c.field]))
    expect(by).toEqual({
      红人: 'name',
      平台: 'channel',
      主页链接: 'url',
      粉丝: 'followers',
      合作状态: 'stage',
      快递单号: 'sample_tracking',
      编号: null,
      我也不知道: 'tags',
    })
    expect(cols.find((c) => c.name === '我也不知道')?.by).toBe('ai')
    expect(pickKeyColumn(cols)?.name).toBe('主页链接')
  })

  it('没有链接列时按账号 / 邮箱 / 名字认行；一列都没有就只能追加', () => {
    const only = proposeSyncColumns([
      { name: '名字', type: 'text' },
      { name: '邮箱', type: 'text' },
    ])
    expect(pickKeyColumn(only)?.name).toBe('邮箱')
    expect(pickKeyColumn(proposeSyncColumns([{ name: '备注', type: 'text' }]))).toBeUndefined()
  })
})

describe('阶段词对选项', () => {
  it('先一字不差，再按导入的状态词表；对不上的留空（不新建）', () => {
    const map = mapStagesToOptions(['待联系', '已联系', '谈价中', '寄样中', '已发布', '拒绝'])
    expect(map.sourced).toBe('待联系')
    expect(map.contacted).toBe('已联系')
    expect(map.negotiating).toBe('谈价中')
    expect(map.sample_sent).toBe('寄样中')
    expect(map.declined).toBe('拒绝')
    expect(map.closed).toBeNull()
    expect(mapStagesToOptions(['已寄样', 'sample_sent']).sample_sent).toBe('已寄样')
  })
})

describe('认行的值', () => {
  it('主页链接按渠道 + 账号归一；账号去 @；邮箱小写', () => {
    expect(syncKeyOf('url', 'https://www.youtube.com/@DeskFixture/videos')).toBe(
      syncKeyOf('url', 'youtube.com/@deskfixture'),
    )
    expect(syncKeyOf('handle', '@Desk ')).toBe('desk')
    expect(syncKeyOf('email', ' A@B.com')).toBe('a@b.com')
    expect(syncCellText('a\tb\nc')).toBe('a b c')
  })
})

describe('这一批写什么', () => {
  const columns = proposeSyncColumns(COLS)
  const base = {
    columns,
    key_column: '主页链接',
    what: DEFAULT_SYNC_WHAT,
    stage_map: mapStagesToOptions(COLS[4]?.options ?? []),
    allow_new_options: false,
    now_text: '2026-10-24 10:30',
  }

  it('表里没有的追加一行（只写对得上的格子）；表里已有的第一次对上、只改阶段', () => {
    const plan = planSync({
      ...base,
      rows: [
        row({ creator_id: 'c1' }),
        row({
          creator_id: 'c2',
          values: {
            name: 'Gadget Jonas',
            url: 'https://youtube.com/@gadgetjonas',
            channel: 'Bilibili',
          },
          stage: 'sample_sent',
        }),
      ],
      state: new Map(),
      snapshot: {
        header: COLS.map((c) => c.name),
        rows: [
          [
            'Gadget Jonas',
            'YouTube',
            'https://www.youtube.com/@GadgetJonas',
            '9000',
            '谈价中',
            '',
            '7',
            '',
          ],
        ],
      },
    })
    expect(plan.matched.map((m) => m.creator_id)).toEqual(['c2'])
    const append = plan.ops.find((o) => o.creator_id === 'c1')
    expect(append).toMatchObject({
      op: 'append',
      cells: {
        红人: 'Desk Fixture',
        平台: 'YouTube',
        主页链接: 'https://www.youtube.com/@deskfixture',
        粉丝: '48000',
        合作状态: '已联系',
      },
    })
    const update = plan.ops.find((o) => o.creator_id === 'c2')
    // 平台列没有 Bilibili 这个选项：不写（不擅自新建选项）；只改阶段
    expect(update).toMatchObject({
      op: 'update',
      key_text: 'https://www.youtube.com/@GadgetJonas',
      cells: { 合作状态: '寄样中' },
    })
    expect(update?.op === 'update' ? update.fallback.红人 : undefined).toBe('Gadget Jonas')
  })

  it('没变不写；只开了「阶段」时合作记录变了也不写；阶段对不上选项时那一格不写并报出来', () => {
    const state = new Map<string, SyncRowState>([
      [
        'c1',
        {
          key_text: 'https://www.youtube.com/@deskfixture',
          cells: { 合作状态: '已联系', 快递单号: '' },
        },
      ],
    ])
    const same = planSync({
      ...base,
      what: { new_creators: false, stages: true, collab_records: false },
      rows: [
        row({
          creator_id: 'c1',
          values: { ...row({ creator_id: 'x' }).values, sample_tracking: 'SF123' },
        }),
      ],
      state,
    })
    expect(same.ops).toEqual([])
    const closed = planSync({ ...base, rows: [row({ creator_id: 'c1', stage: 'closed' })], state })
    expect(closed.ops).toEqual([])
    expect(closed.unmapped_stages).toEqual(['closed'])
    const allowed = planSync({
      ...base,
      allow_new_options: true,
      rows: [row({ creator_id: 'c1', stage: 'closed' })],
      state,
    })
    expect(allowed.ops[0]).toMatchObject({ op: 'update', cells: { 合作状态: '已结案' } })
  })

  it('只开「新进的人」时，在走合作的老人不写；新进的人追加', () => {
    const plan = planSync({
      ...base,
      what: { new_creators: true, stages: false, collab_records: false },
      rows: [
        row({ creator_id: 'old' }),
        row({ creator_id: 'new', in_pipeline: false, new_since_on: true }),
      ],
      state: new Map(),
    })
    expect(plan.ops.map((o) => o.creator_id)).toEqual(['new'])
  })

  it('没有认行列：追加过的人变了就追加一行进展记录（不覆盖）', () => {
    const cols = proposeSyncColumns([
      { name: '红人', type: 'text' },
      { name: '状态', type: 'text' },
      { name: '最新进展', type: 'text' },
    ]).map((c) => (c.field === 'name' ? { ...c, field: null } : c))
    const plan = planSync({
      ...base,
      columns: cols,
      key_column: undefined,
      rows: [row({ creator_id: 'c1', stage: 'agreed' })],
      state: new Map([['c1', { appended: true, cells: { 状态: '已建联' } }]]),
    })
    expect(plan.ops).toHaveLength(1)
    expect(plan.ops[0]).toMatchObject({ op: 'append', progress: true, cells: { 状态: '已签定' } })
    expect(plan.ops[0]?.cells.最新进展).toContain('2026-10-24 10:30')
  })

  it('一批最多几件，其余记下留到下一批', () => {
    const plan = planSync({
      ...base,
      max_ops: 2,
      rows: ['a', 'b', 'c'].map((id) =>
        row({ creator_id: id, values: { name: id, url: `https://youtube.com/@${id}` } }),
      ),
      state: new Map(),
    })
    expect(plan.ops).toHaveLength(2)
    expect(plan.deferred).toBe(1)
  })
})
