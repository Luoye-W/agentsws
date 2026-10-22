/**
 * WP323：{@link OutboundLog} 的实现（说明见 `log.ts`）。
 */
import type {
  ApprovalItem,
  OutboundRecord,
  RecordSink,
  RecordSinkView,
  SinkFilter,
  WorkspaceId,
} from '@agentsws/contracts'
import { OUTBOUND_FIELDS } from '@agentsws/contracts'
import {
  isRecordSinkCard,
  type OutboundLog,
  type OutboundLogOptions,
  type ProposeResult,
  SINK_BACKOFF_MS,
  type SinkActor,
} from './log.js'
import { buildMapping, matchesFilter, renderRow, sourceLabel } from './mapping.js'

/** 导出 CSV 的列（固定口径；要别的列让用户配记录去处）。 */
const EXPORT_COLUMNS: [string, (r: OutboundRecord) => string][] = [
  ['时间', (r) => r.sent_at],
  ['渠道', (r) => r.channel],
  ['动作', (r) => r.action],
  ['发到哪', (r) => r.destination ?? ''],
  ['原帖标题', (r) => r.thread_title ?? ''],
  ['原帖链接', (r) => r.thread_url ?? ''],
  ['对方', (r) => r.counterpart ?? ''],
  [
    '对方原话',
    (r) => (r.counterpart_deleted === true ? '（对方已删）' : (r.counterpart_text ?? '')),
  ],
  ['主题', (r) => r.subject ?? ''],
  ['我们发的', (r) => r.content],
  ['链接', (r) => r.link ?? ''],
  ['状态', (r) => r.status],
  ['谁批的', (r) => r.approved_by ?? ''],
  ['对方回了几条', (r) => String(r.follow_ups.filter((f) => f.from === 'them').length)],
  ['记录编号', (r) => r.id],
]

const csvCell = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** 卡上预览没有真实记录时用的示例（标「示例」，不冒充真数据）。 */
function sampleRecord(ws: WorkspaceId, now: string): OutboundRecord {
  return {
    id: 'ob_示例',
    workspace_id: ws,
    source_key: 'sample',
    sent_at: now,
    channel: 'reddit',
    action: 'reply',
    kind: 'outbound_draft',
    destination: 'r/example',
    thread_title: '示例帖子标题',
    thread_url: 'https://www.reddit.com/r/example/comments/abc123/',
    counterpart: 'u/example',
    counterpart_text: '示例：对方的原话',
    content: '示例：我们回复的内容',
    link: 'https://www.reddit.com/r/example/comments/abc123/_/def456/',
    approved_by: '你',
    approved_at: now,
    status: 'sent',
    follow_ups: [],
  }
}

const APPROVED = new Set(['approved', 'approved_edited', 'applying', 'applied'])

function cleanFilter(raw: SinkFilter | undefined): SinkFilter {
  const list = (v: unknown): string[] | undefined => {
    if (!Array.isArray(v)) return undefined
    const out = v.filter((x): x is string => typeof x === 'string' && x.length <= 40).slice(0, 20)
    return out.length === 0 ? undefined : out
  }
  const channels = list(raw?.channels)
  const actions = list(raw?.actions)
  const kinds = list(raw?.kinds)
  return {
    ...(channels === undefined ? {} : { channels }),
    ...(actions === undefined ? {} : { actions }),
    ...(kinds === undefined ? {} : { kinds }),
  }
}

export function createOutboundLog(options: OutboundLogOptions): OutboundLog {
  const { store } = options
  const emit = (ws: WorkspaceId, type: string, payload: Record<string, unknown>): void => {
    try {
      options.emit?.(ws, type, payload)
    } catch {
      // 记事件失败不挡记录本身
    }
  }
  const tz = (ws: WorkspaceId): number => options.tzOffsetMinutes?.(ws) ?? 0
  const nowMs = (): number => Date.parse(options.now())
  let timer: ReturnType<typeof setInterval> | undefined
  let flushing: Promise<number> | undefined

  const view = (s: RecordSink): RecordSinkView => ({ ...s, ...store.counts(s.id) })

  /** 这一条命中的去处各排一笔写入（停了的、等确认的不排）。 */
  const enqueue = (record: OutboundRecord): void => {
    for (const s of store.sinks(record.workspace_id)) {
      if (s.state !== 'active' && s.state !== 'broken') continue
      // WP441：消息规则点名了去处——只写那几个，不看各去处的筛选
      if (record.only_sinks !== undefined) {
        if (!record.only_sinks.includes(s.id)) continue
      } else if (!matchesFilter(record, s.filter)) continue
      store.addWrite({
        sink_id: s.id,
        record_id: record.id,
        status: 'pending',
        attempts: 0,
        next_at: record.sent_at,
      })
    }
  }

  const kick = (): void => {
    void flush().catch(() => undefined)
  }

  /** 最近的记录里，后续带这个平台 id 的那一行（我们又回了对方的回复时挂回去）。 */
  const recordWithFollowUp = (ws: WorkspaceId, ext: string): OutboundRecord | undefined =>
    store.list(ws, { limit: 1000 }).find((r) => r.follow_ups.some((f) => f.external_id === ext))

  const record: OutboundLog['record'] = (ws, input) => {
    const existing = store.bySource(ws, input.source_key)
    if (existing !== undefined) return existing
    const row: OutboundRecord = {
      ...input,
      id: options.newId('ob_'),
      workspace_id: ws,
      sent_at: input.sent_at ?? options.now(),
      status: input.status ?? 'sent',
      follow_ups: [],
    }
    store.put(row)
    emit(ws, 'outbound.recorded', {
      record_id: row.id,
      channel: row.channel,
      action: row.action,
      kind: row.kind,
    })
    // 我们回的是对方的一条后续 → 挂回原来那一行（整段来回在一行里看得到）
    if (row.parent_external_id !== undefined) {
      const parent = recordWithFollowUp(ws, row.parent_external_id)
      if (parent !== undefined && parent.id !== row.id) {
        store.put({
          ...parent,
          follow_ups: [
            ...parent.follow_ups,
            {
              id: options.newId('obf_'),
              at: row.sent_at,
              from: 'us',
              record_id: row.id,
              ...(row.link === undefined ? {} : { url: row.link }),
              ...(row.external_id === undefined ? {} : { external_id: row.external_id }),
            },
          ],
        })
      }
    }
    if (row.status === 'sent') {
      enqueue(row)
      kick()
    }
    return row
  }

  const addFollowUp: OutboundLog['addFollowUp'] = (ws, input) => {
    const parent = store.byExternal(ws, input.parent_external_id)
    if (parent === undefined) return undefined
    if (
      input.external_id !== undefined &&
      parent.follow_ups.some((f) => f.external_id === input.external_id)
    )
      return parent
    const next: OutboundRecord = {
      ...parent,
      follow_ups: [
        ...parent.follow_ups,
        {
          id: options.newId('obf_'),
          at: input.at ?? options.now(),
          from: 'them',
          ...(input.author === undefined ? {} : { author: input.author }),
          ...(input.text === undefined ? {} : { text: input.text.slice(0, 4000) }),
          ...(input.url === undefined ? {} : { url: input.url }),
          ...(input.external_id === undefined ? {} : { external_id: input.external_id }),
          ...(input.approval_item_id === undefined
            ? {}
            : { approval_item_id: input.approval_item_id }),
        },
      ],
    }
    store.put(next)
    emit(ws, 'outbound.follow_up', { record_id: parent.id })
    return next
  }

  const counterpartDeleted: OutboundLog['counterpartDeleted'] = (ws, ext) => {
    let changed = 0
    for (const r of store.list(ws, { limit: 5000 })) {
      let next = r
      if (r.parent_external_id === ext && r.counterpart_deleted !== true) {
        const { counterpart_text: _drop, ...rest } = next
        next = { ...rest, counterpart_deleted: true }
      }
      if (
        r.follow_ups.some((f) => f.external_id === ext && f.from === 'them' && f.deleted !== true)
      )
        next = {
          ...next,
          follow_ups: next.follow_ups.map((f) => {
            if (f.external_id !== ext || f.from !== 'them') return f
            const { text: _t, ...rest } = f
            return { ...rest, deleted: true }
          }),
        }
      if (next !== r) {
        store.put(next)
        changed += 1
      }
    }
    if (changed > 0) emit(ws, 'outbound.counterpart_deleted', { rows: changed })
    return changed
  }

  const setScores: NonNullable<OutboundLog['setScores']> = (ws, scores, at) => {
    let changed = 0
    for (const s of scores) {
      const row = store.byExternal(ws, s.external_id)
      if (row === undefined || row.score === s.score) continue
      store.put({ ...row, score: s.score, score_at: at ?? options.now() })
      changed += 1
    }
    if (changed > 0) emit(ws, 'outbound.scores', { rows: changed })
    return changed
  }

  const exportRecords: OutboundLog['export'] = (ws, format, query) => {
    const rows = store.list(ws, { ...query, limit: query?.limit ?? 5000 })
    const day = options.now().slice(0, 10)
    if (format === 'json')
      return {
        filename: `发出记录-${day}.json`,
        content: JSON.stringify(rows, null, 2),
        count: rows.length,
      }
    const lines = [
      EXPORT_COLUMNS.map(([h]) => h).join(','),
      ...rows.map((r) => EXPORT_COLUMNS.map(([, f]) => csvCell(f(r))).join(',')),
    ]
    // 带 BOM：Excel 直接双击打开不乱码
    return {
      filename: `发出记录-${day}.csv`,
      content: `﻿${lines.join('\r\n')}\r\n`,
      count: rows.length,
    }
  }

  /* 记录去处的那一半接在下面（sinks / inspect / propose / onDecided / 写入）。 */
  const sinkSide = createSinkSide({ options, view, emit, tz, nowMs, kick })

  async function flush(): Promise<number> {
    if (flushing !== undefined) return flushing
    flushing = sinkSide.flushAll().finally(() => {
      flushing = undefined
    })
    return flushing
  }

  return {
    record,
    get: (ws, id) => store.get(ws, id),
    list: (ws, q) => store.list(ws, q),
    export: exportRecords,
    addFollowUp,
    counterpartDeleted,
    setScores,
    ...sinkSide.api,
    flush,
    start(intervalMs = 60_000) {
      if (timer !== undefined) return
      timer = setInterval(kick, intervalMs)
      timer.unref?.()
    },
    close() {
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
    },
  }
}

interface SinkSideDeps {
  options: OutboundLogOptions
  view(s: RecordSink): RecordSinkView
  emit(ws: WorkspaceId, type: string, payload: Record<string, unknown>): void
  tz(ws: WorkspaceId): number
  nowMs(): number
  kick(): void
}

type SinkApi = Pick<
  OutboundLog,
  'sinks' | 'inspect' | 'propose' | 'onDecided' | 'pause' | 'resume' | 'remove' | 'retry'
> &
  Required<Pick<OutboundLog, 'writesOf'>>

/** 记录去处那一半：去处的增删改、读表头、出卡、写入与补写。 */
function createSinkSide(deps: SinkSideDeps): { api: SinkApi; flushAll(): Promise<number> } {
  const { options, view, emit, tz, nowMs, kick } = deps
  const { store, adapters } = options

  const mine = (ws: WorkspaceId, id: string): RecordSink | undefined => {
    const s = store.sink(id)
    return s === undefined || s.workspace_id !== ws ? undefined : s
  }

  const save = (s: RecordSink): RecordSink => {
    const next = { ...s, updated_at: options.now() }
    store.putSink(next)
    return next
  }

  /** 卡上那一行预览：最近一条命中筛选的真实记录；还没有就用示例（卡上标明）。 */
  const previewOf = (
    ws: WorkspaceId,
    columns: RecordSink['columns'],
    filter: SinkFilter,
  ): { preview: [string, string][]; sample: boolean } => {
    const real = store.list(ws, { limit: 50 }).find((r) => matchesFilter(r, filter))
    const rec = real ?? sampleRecord(ws, options.now())
    return {
      preview: renderRow(rec, columns, tz(ws)).map((c) => [c.column, c.text]),
      sample: real === undefined,
    }
  }

  const inspect: SinkApi['inspect'] = async (ws, url) => {
    const adapter = adapters.forUrl(url)
    if (adapter === undefined)
      return {
        ok: false,
        code: 'unknown_link',
        message: '认不出这个链接是哪种表格。请贴表格本身的链接（打开表格后地址栏里那一条）。',
      }
    const info = await adapter.inspect(ws, url)
    if (!info.ok)
      return {
        ok: false,
        code: info.code,
        message: info.message,
        hint: adapter.setupHint(info.code),
      }
    return {
      ok: true,
      adapter: info.data.adapter,
      ...(info.data.title === undefined ? {} : { title: info.data.title }),
      columns: info.data.columns,
      samples: info.data.samples.slice(0, 3),
      fields: OUTBOUND_FIELDS.map((f) => ({ id: f.id, zh: f.zh })),
    }
  }

  /** 出卡（宿主建）；没出成照样留着去处（等确认），人可以再说一次。 */
  const stage = async (
    ws: WorkspaceId,
    sink: RecordSink,
    actor: SinkActor,
    revision: boolean,
    reason?: 'columns_changed',
  ): Promise<{ card_id?: string; preview: [string, string][]; sample: boolean }> => {
    const columns = revision ? (sink.draft?.columns ?? sink.columns) : sink.columns
    const filter = revision ? (sink.draft?.filter ?? sink.filter) : sink.filter
    const { preview, sample } = previewOf(ws, columns, filter)
    const card_id = await options
      .stageCard?.({
        workspace_id: ws,
        sink,
        actor,
        preview,
        sample,
        revision,
        ...(reason === undefined ? {} : { reason }),
      })
      .catch(() => undefined)
    return { ...(card_id === undefined ? {} : { card_id }), preview, sample }
  }

  const propose: SinkApi['propose'] = async (ws, input): Promise<ProposeResult> => {
    const url = input.url.trim()
    const adapter = adapters.forUrl(url)
    if (adapter === undefined)
      return {
        ok: false,
        code: 'unknown_link',
        message: '认不出这个链接是哪种表格。请贴表格本身的链接。',
      }
    const info = await adapter.inspect(ws, url)
    if (!info.ok)
      return {
        ok: false,
        code: info.code,
        message: info.message,
        hint: adapter.setupHint(info.code),
      }
    const mapping = buildMapping(info.data.columns, input.columns)
    if (mapping.columns.length === 0)
      return {
        ok: false,
        code: 'no_columns',
        message:
          '这张表还没有表头，也没说要记哪些列。请告诉我列名（例如：日期 / 版块 / 帖子链接 / 回复内容）。',
      }
    const filter = cleanFilter(input.filter)
    const existing =
      (input.sink_id === undefined ? undefined : mine(ws, input.sink_id)) ??
      store.sinks(ws).find((s) => s.url === url)
    const name = (input.name?.trim() || existing?.name || info.data.title || '记录表').slice(0, 40)
    const now = options.now()
    const created_by = {
      person_id: input.actor.person_id,
      ...(input.actor.assignment_id === undefined
        ? {}
        : { assignment_id: input.actor.assignment_id }),
      ...(input.actor.role_id === undefined ? {} : { role_id: input.actor.role_id }),
    }
    // 还在等确认的那个去处（第一次交代、没点过「记下」）：直接换成新的这一版
    const revision = existing !== undefined && existing.state !== 'pending_confirm'
    let sink: RecordSink
    if (existing === undefined || !revision) {
      sink = {
        id: existing?.id ?? options.newId('sink_'),
        workspace_id: ws,
        name,
        instruction: input.instruction.slice(0, 2000),
        adapter: info.data.adapter,
        url,
        ref: info.data.ref,
        columns: mapping.columns,
        filter,
        state: 'pending_confirm',
        created_at: existing?.created_at ?? now,
        updated_at: now,
        created_by,
      }
    } else {
      sink = {
        ...existing,
        instruction: input.instruction.slice(0, 2000),
        adapter: info.data.adapter,
        ref: { ...info.data.ref },
        draft: { columns: mapping.columns, filter, name },
        updated_at: now,
      }
    }
    // 上一张还没定的卡撤掉（同一个去处只留最新那一张）
    const stale = revision ? existing?.draft?.card_id : existing?.card_id
    if (stale !== undefined) await options.withdrawCard?.(stale).catch(() => undefined)
    store.putSink(sink)
    const staged = await stage(ws, sink, input.actor, revision)
    if (staged.card_id !== undefined)
      store.putSink(
        revision
          ? {
              ...sink,
              draft: {
                ...(sink.draft as NonNullable<RecordSink['draft']>),
                card_id: staged.card_id,
              },
            }
          : { ...sink, card_id: staged.card_id },
      )
    emit(ws, 'outbound.sink_proposed', { sink_id: sink.id, revision, adapter: sink.adapter })
    return {
      ok: true,
      sink_id: sink.id,
      name,
      revision,
      ...(staged.card_id === undefined ? {} : { card_id: staged.card_id }),
      columns: mapping.columns.map((c) => ({ column: c.column, fill: sourceLabel(c.source) })),
      unknown: mapping.unknown,
      empty: mapping.empty,
      preview: staged.preview,
      sample: staged.sample,
    }
  }

  /** 列对不上了：重读表头，沿用能对上的那几列，重出一张「定规矩」卡。 */
  const remap = async (sink: RecordSink): Promise<void> => {
    if (sink.created_by === undefined || sink.draft !== undefined) return
    const adapter = adapters.byKind(sink.adapter)
    if (adapter === undefined) return
    const info = await adapter.inspect(sink.workspace_id, sink.url)
    if (!info.ok) return
    const mapping = buildMapping(
      info.data.columns,
      sink.columns.map((c) => ({ column: c.column, source: c.source })),
    )
    const next: RecordSink = {
      ...sink,
      ref: { ...sink.ref, ...info.data.ref },
      draft: { columns: mapping.columns, filter: sink.filter, name: sink.name },
    }
    store.putSink(next)
    const staged = await stage(sink.workspace_id, next, sink.created_by, true, 'columns_changed')
    if (staged.card_id !== undefined)
      store.putSink({
        ...next,
        draft: { ...(next.draft as NonNullable<RecordSink['draft']>), card_id: staged.card_id },
      })
  }

  const onDecided: SinkApi['onDecided'] = async (item: ApprovalItem) => {
    if (!isRecordSinkCard(item)) return
    const p = item.payload as Record<string, unknown>
    const sink = typeof p.sink_id === 'string' ? store.sink(p.sink_id) : undefined
    if (sink === undefined || sink.workspace_id !== item.workspace_id) return
    const forThisCard = sink.card_id === item.id || sink.draft?.card_id === item.id
    if (!forThisCard) return
    const picked = item.decision?.selected_option_id
    const yes = APPROVED.has(item.state) && picked !== 'before'
    const now = options.now()
    if (sink.draft?.card_id === item.id) {
      const { draft, ...rest } = sink
      if (yes && draft !== undefined) {
        save({
          ...rest,
          name: draft.name,
          columns: draft.columns,
          filter: draft.filter,
          state: sink.state === 'paused' ? 'paused' : 'active',
          confirmed_at: now,
        })
        emit(sink.workspace_id, 'outbound.sink_confirmed', { sink_id: sink.id, revision: true })
        if (sink.state === 'broken') await retry(sink.workspace_id, sink.id)
      } else save(rest)
      return
    }
    if (!yes) {
      // 第一次交代就说「不用」：这个去处不留
      store.removeSink(sink.id)
      emit(sink.workspace_id, 'outbound.sink_removed', { sink_id: sink.id })
      return
    }
    const { card_id: _c, ...rest } = sink
    save({ ...rest, state: 'active', confirmed_at: now })
    emit(sink.workspace_id, 'outbound.sink_confirmed', { sink_id: sink.id, revision: false })
  }

  const setState = (ws: WorkspaceId, id: string, state: RecordSink['state']) => {
    const s = mine(ws, id)
    if (s === undefined || s.state === 'pending_confirm')
      return s === undefined ? undefined : view(s)
    return view(save({ ...s, state }))
  }

  const remove: SinkApi['remove'] = async (ws, id) => {
    const s = mine(ws, id)
    if (s === undefined) return false
    for (const card of [s.card_id, s.draft?.card_id])
      if (card !== undefined) await options.withdrawCard?.(card).catch(() => undefined)
    const removed = store.removeSink(id)
    if (removed) emit(ws, 'outbound.sink_removed', { sink_id: id })
    return removed
  }

  /** 写一个去处到点了的那几笔；遇到停下来的错就停在这个去处。 */
  const flushSink = async (sink: RecordSink, force: boolean): Promise<number> => {
    if (sink.state !== 'active') return 0
    const adapter = adapters.byKind(sink.adapter)
    let current = sink
    let written = 0
    for (const w of store.pending(sink.id)) {
      if (!force && w.next_at !== undefined && Date.parse(w.next_at) > nowMs()) continue
      const rec = store.get(sink.workspace_id, w.record_id)
      if (rec === undefined) continue
      const res =
        adapter === undefined
          ? ({ ok: false, code: 'not_supported', message: '这种去处这一版写不进去。' } as const)
          : await adapter.append({
              workspace_id: sink.workspace_id,
              url: current.url,
              ref: current.ref,
              cells: renderRow(rec, current.columns, tz(sink.workspace_id)),
              key: `${sink.id}:${rec.id}`,
            })
      if (res.ok) {
        store.putWrite({
          sink_id: sink.id,
          record_id: rec.id,
          status: 'written',
          attempts: w.attempts + 1,
          written_at: options.now(),
          ...(res.data.row_ref === undefined ? {} : { row_ref: res.data.row_ref }),
        })
        written += 1
        const patch: Record<string, string> | undefined = res.data.ref_patch
        if (patch !== undefined) {
          const ref = { ...current.ref }
          for (const [k, v] of Object.entries(patch))
            if (v === '') delete ref[k]
            else ref[k] = v
          current = save({ ...current, ref })
        }
        continue
      }
      const attempts = w.attempts + 1
      const last_error = { code: res.code, message: res.message }
      if (res.code === 'transient') {
        const wait = SINK_BACKOFF_MS[Math.min(attempts - 1, SINK_BACKOFF_MS.length - 1)] as number
        store.putWrite({
          ...w,
          attempts,
          last_error,
          next_at: new Date(nowMs() + wait).toISOString(),
        })
        break
      }
      // 停下来的错：去处标「写不进去」，这一笔留着待补写
      const { next_at: _n, ...rest } = w
      store.putWrite({ ...rest, attempts, last_error })
      current = save({
        ...current,
        state: 'broken',
        last_error: { ...last_error, at: options.now() },
      })
      emit(sink.workspace_id, 'outbound.sink_failed', { sink_id: sink.id, code: res.code })
      if (res.code === 'columns_changed') await remap(current).catch(() => undefined)
      break
    }
    if (written > 0)
      emit(sink.workspace_id, 'outbound.sink_written', { sink_id: sink.id, rows: written })
    return written
  }

  const retry: SinkApi['retry'] = async (ws, id) => {
    const s = mine(ws, id)
    if (s === undefined || s.state === 'pending_confirm' || s.state === 'paused') return 0
    const { last_error: _e, ...rest } = s
    const active = save({ ...rest, state: 'active' })
    for (const w of store.pending(id)) store.putWrite({ ...w, next_at: options.now() })
    return flushSink(active, true)
  }

  const flushAll = async (): Promise<number> => {
    let n = 0
    const seen = new Set<string>()
    for (const s of store.allActiveSinks()) {
      if (seen.has(s.id)) continue
      seen.add(s.id)
      n += await flushSink(s, false)
    }
    return n
  }

  return {
    api: {
      sinks: (ws) => store.sinks(ws).map(view),
      // WP413：这一行写进各去处的状态（插件侧边栏「记录」那一块）
      writesOf: (ws, record_id) =>
        store
          .sinks(ws)
          .map((s) => store.write(s.id, record_id))
          .filter((w): w is NonNullable<typeof w> => w !== undefined),
      inspect,
      propose,
      onDecided,
      pause: (ws, id) => setState(ws, id, 'paused'),
      resume: (ws, id) => {
        const v = setState(ws, id, 'active')
        kick()
        return v
      },
      remove,
      retry,
    },
    flushAll,
  }
}
