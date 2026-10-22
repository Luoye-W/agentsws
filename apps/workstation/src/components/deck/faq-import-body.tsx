/**
 * WP322（docs/102 §5.4，决策 670）：**FAQ 表导入**两张卡的主体。
 *
 * - 「定规矩」卡（`policy_change` + `form: 'faq_import'`）：每张表一行「问题 ← 某列」的对照、
 *   一两行预览、新 / 改 / 没变几条；答案变了的给一条改前改后；表里删掉的一行灰字。
 *   按钮就是卡上的选项（记下 / 只加新的 / 不用，或 撤下 / 留着），不在这里画。
 * - ③ 给负责人的整批卡（`knowledge_update` + `form: 'faq_batch'`）：几条 + 一两行预览。
 *
 * 界面少字：没有的格子不出；数都是服务端算好的，这里只排版。
 */
import type { FaqBatchPayload, FaqImportPayload } from '@agentsws/contracts'
import { ArrowRight } from 'lucide-react'
import { useApp } from '@/lib/app-context'

export const isFaqImportPayload = (p: unknown): p is FaqImportPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'faq_import' &&
  Array.isArray((p as { sheets?: unknown }).sheets)

export const isFaqBatchPayload = (p: unknown): p is FaqBatchPayload =>
  typeof p === 'object' &&
  p !== null &&
  (p as { form?: unknown }).form === 'faq_batch' &&
  Array.isArray((p as { card_ids?: unknown }).card_ids)

const Chip = ({ children, testId }: { children: React.ReactNode; testId?: string }) => (
  <span
    {...(testId === undefined ? {} : { 'data-testid': testId })}
    className="rounded-full bg-ws-tint px-2 py-px text-xs text-ws-muted-fg"
  >
    {children}
  </span>
)

/** 一两行问答预览（Q 一行、A 一行）。 */
function Preview({ rows }: { rows: { question: string; answer: string }[] }): React.ReactNode {
  if (rows.length === 0) return null
  return (
    <div
      className="flex flex-col gap-1.5 rounded-lg bg-ws-surface p-3 text-[13px] leading-5"
      data-testid="faq-preview"
    >
      {rows.map((r) => (
        <div key={r.question} className="min-w-0">
          <p className="truncate font-medium text-ws-ink">{r.question}</p>
          <p className="line-clamp-2 text-ws-body">{r.answer}</p>
        </div>
      ))}
    </div>
  )
}

/** 新 / 改 / 没变 / 少了 / 缺答案：只出不为 0 的。 */
function Counts({
  counts,
}: {
  counts: Partial<Record<'new' | 'changed' | 'same' | 'removed' | 'skipped', number>>
}): React.ReactNode {
  const { t } = useApp()
  const keys = (['new', 'changed', 'same', 'removed', 'skipped'] as const).filter(
    (k) => (counts[k] ?? 0) > 0,
  )
  if (keys.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="faq-counts">
      {keys.map((k) => (
        <Chip key={k} testId={`faq-count-${k}`}>
          {t(`faq.count.${k}`, { n: counts[k] ?? 0 })}
        </Chip>
      ))}
    </div>
  )
}

export function FaqImportBody({ payload }: { payload: FaqImportPayload }): React.ReactNode {
  const { t } = useApp()
  const change = payload.changes[0]
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-faq-import">
      {payload.sheets.map((s) => (
        <div
          key={s.sheet}
          className="flex flex-wrap items-center gap-1.5 text-xs"
          data-testid="faq-mapping"
        >
          {s.sheet === '' ? null : <span className="text-ws-muted-fg">{s.sheet}</span>}
          {s.columns.map((c) => (
            <span
              key={c.field}
              data-field={c.field}
              className="rounded-md border border-ws-line px-1.5 py-px text-ws-body"
            >
              {t(`faq.field.${c.field}`)} ← {c.header}
            </span>
          ))}
          {s.by === 'ai' ? <Chip>{t('faq.by_ai')}</Chip> : null}
        </div>
      ))}
      <Preview rows={payload.preview} />
      {change === undefined ? null : (
        <div
          className="flex flex-col gap-1 rounded-lg bg-ws-surface p-3 text-[13px] leading-5"
          data-testid="faq-change"
        >
          <p className="truncate font-medium text-ws-ink">{change.question}</p>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-ws-muted-fg line-through">
              {change.before}
            </span>
            <ArrowRight aria-hidden className="size-3.5 flex-none text-ws-muted-fg" />
            <span className="min-w-0 flex-1 truncate text-ws-ink">{change.after}</span>
          </div>
        </div>
      )}
      <Counts counts={payload.counts} />
      {payload.removed.length === 0 ? null : (
        <p className="truncate text-xs text-ws-muted-fg" data-testid="faq-removed">
          {t('faq.removed', { list: payload.removed.join('、') })}
        </p>
      )}
    </div>
  )
}

export function FaqBatchBody({ payload }: { payload: FaqBatchPayload }): React.ReactNode {
  return (
    <div className="mt-2.5 flex flex-col gap-2" data-testid="deck-layout-faq-batch">
      <Preview rows={payload.preview} />
      <Counts counts={payload.counts} />
    </div>
  )
}
