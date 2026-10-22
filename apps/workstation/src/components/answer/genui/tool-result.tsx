/**
 * WP341（决策 847）：对话里点了「调工具」的按钮之后，就地画结果——
 * 只读的：工具读回来的数据照原样摆成表格 / 键值（数字不经模型手）；会改外部的：一行「出了 N 张卡，批了才做」
 * （卡本身挂在这件事的时间线上、卡片流里同一张）；不收的 / 没做成的：一句为什么。
 */
import { filterGenuiSpec, type GenuiSpecLite, type GenuiToolOutcome } from '@agentsws/contracts'
import { GenuiBlock, processGenuiSpec } from '@changfenhuang/dsh-genui/embed'
import { type ReactNode, useMemo } from 'react'
import { useApp } from '@/lib/app-context'
import { wrapGenuiTables } from './table-filter-node'

const isRecord = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === 'object' && !Array.isArray(x)
const cell = (v: unknown): string | number =>
  typeof v === 'number' && Number.isFinite(v)
    ? v
    : typeof v === 'string'
      ? v
      : typeof v === 'boolean'
        ? v
          ? '是'
          : '否'
        : ''
const plain = (v: unknown): boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

/** 工具数据 → 一块 genui：一串记录成表格（前 6 个简单字段、前 50 行）；一条记录成键值；别的不画。 */
export function toolDataSpec(data: unknown): GenuiSpecLite | undefined {
  const list = Array.isArray(data)
    ? data
    : isRecord(data)
      ? Object.values(data).find((v) => Array.isArray(v) && v.some(isRecord))
      : undefined
  let node: Record<string, unknown> | undefined
  if (Array.isArray(list) && list.some(isRecord)) {
    const rows = list.filter(isRecord)
    const columns = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => plain(r[k]))))]
      .filter((k) => !/^(?:_|gid$)/u.test(k))
      .slice(0, 6)
    node = {
      type: 'table',
      columns,
      rows: rows.slice(0, 50).map((r) => columns.map((c) => cell(r[c]))),
    }
  } else if (isRecord(data)) {
    const pairs = Object.entries(data)
      .filter(([k, v]) => plain(v) && !k.startsWith('_'))
      .slice(0, 12)
      .map(([key, value]) => ({ key, value: String(cell(value)) }))
    node = pairs.length === 0 ? undefined : { type: 'keyvalue', pairs }
  }
  return node === undefined ? undefined : filterGenuiSpec({ items: [node] }).spec
}

export function ToolResult({
  label,
  outcome,
  error,
}: {
  label: string
  outcome?: GenuiToolOutcome | undefined
  error?: string | undefined
}): ReactNode {
  const { t } = useApp()
  const spec = useMemo(
    () => (outcome?.effect === 'read' ? toolDataSpec(outcome.data) : undefined),
    [outcome],
  )
  const processed = useMemo(() => (spec === undefined ? undefined : processGenuiSpec(spec)), [spec])
  // WP401：工具读回来的表也带筛选
  const shown = useMemo(
    () => (processed?.spec == null ? undefined : wrapGenuiTables(processed.spec)),
    [processed],
  )
  const line = (text: string, tone = 'text-ws-muted-fg'): ReactNode => (
    <p className={`mt-2 text-xs ${tone}`} data-testid="genui-tool-result">
      {text}
    </p>
  )
  if (error !== undefined) return line(t('genui.tool.failed', { why: error }), 'text-ws-bad')
  if (outcome === undefined)
    // WP456-T2（规范 §2.6 第 9 条）：在跑用流光字，不用转圈图标
    return (
      <p className="ws-shimmer mt-2 text-xs" data-testid="genui-tool-result" role="status">
        {t('genui.tool.running', { label })}
      </p>
    )
  if (outcome.effect === 'staged')
    return line(t('genui.tool.staged', { n: outcome.approval_item_ids?.length ?? 0 }))
  if (outcome.effect === 'refused' || outcome.status !== 'ok')
    return line(t('genui.tool.failed', { why: outcome.message ?? '' }), 'text-ws-warn')
  if (shown === undefined) return null
  return (
    <div className="mt-2" data-testid="genui-tool-result" data-effect="read">
      <GenuiBlock spec={shown} animateEntrance={false} />
    </div>
  )
}
