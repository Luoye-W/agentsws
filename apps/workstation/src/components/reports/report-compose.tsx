/**
 * WP438（WP434 设计 §3.4，决策 1336 甲）：**跟 AI 说想看什么，做一份新的**——挂在第三栏。
 *
 * 1. 输入框里先带「做一份报表：」，下面五个例子（AI 先给建议，用户不用从零想）；
 * 2. 发出去：先列读了哪些数，一句结论，然后出一份小报表（3 个数 + 1 张图）；
 * 3. 「固定到面板」弹小框：固定到哪（AI 预选岗位 / 职责）+ 多久更新一次（每天 / 每周一 / 打开时）；
 * 4. 固定以后：顶上一句「已固定到『网站运营 · 报表』，每周一更新 · 撤销」，看板那张卡最上面多这一份、亮一下。
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, Send } from 'lucide-react'
import { type ReactNode, useRef, useState } from 'react'
import { MiniReport } from '@/components/reports/kit/mini-report'
import { markPinned, openRightPane } from '@/components/reports/right-pane'
import { usePositionInfo } from '@/components/reports/use-position-info'
import { useApp } from '@/lib/app-context'
import {
  type ComposeResult,
  composeReport,
  pinReport,
  REPORTS_QUERY,
  type ReportRefresh,
  type ReportSummary,
  unpinReport,
} from '@/lib/reports-api'
import { cn } from '@/lib/utils'

const PREFIX = '做一份报表：'

/** 「做一份报表：」下面那五个例子（同服务端 `REPORT_EXAMPLES`）。 */
export const EXAMPLES: readonly string[] = [
  '近 8 周邮件活动对复购有没有用，按周看',
  '哪几个商品卖得最好，和上个月比',
  '订单都从哪来，AI 回答里点进来的有多少',
  '新客和老客各占多少，按周看',
  '这个月退款多不多',
]

const REFRESH: ReportRefresh[] = ['daily', 'weekly', 'on_open']

function PinPopover({
  result,
  onCancel,
  onPinned,
}: {
  result: ComposeResult
  onCancel: () => void
  onPinned: (s: ReportSummary, where: string) => void
}): ReactNode {
  const { t } = useApp()
  const info = usePositionInfo(result.suggest.position)
  const duty = info.duties.find((d) => d.role_id === result.suggest.duty)
  const [target, setTarget] = useState<'position' | 'duty'>('position')
  const [refresh, setRefresh] = useState<ReportRefresh>(result.suggest.refresh)
  const pin = useMutation({
    mutationFn: () =>
      pinReport({
        id: result.draft.id,
        position: result.suggest.position,
        ...(target === 'duty' && duty !== undefined ? { duty: duty.role_id } : {}),
        refresh,
      }),
    onSuccess: (s) => {
      onPinned(s, target === 'duty' && duty !== undefined ? duty.role_name : (info.name ?? ''))
    },
  })
  const option = (key: 'position' | 'duty', name: string, sub: string): ReactNode => (
    <label
      className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2 py-[7px] text-[13px] hover:bg-ws-surface',
      )}
      data-testid={`pin-target-${key}`}
    >
      <input
        type="radio"
        name="pin-target"
        className="sr-only"
        checked={target === key}
        onChange={() => {
          setTarget(key)
        }}
      />
      <span
        aria-hidden
        className={cn(
          'size-4 shrink-0 rounded-full',
          target === key
            ? 'shadow-[inset_0_0_0_5px_var(--ws-brand)]'
            : 'shadow-[inset_0_0_0_1.5px_var(--ws-faint)]',
        )}
      />
      <span className="min-w-0">
        <span className="block text-ws-ink">{name}</span>
        <span className="block text-xs text-ws-muted-fg">{sub}</span>
      </span>
    </label>
  )
  return (
    <div
      role="dialog"
      aria-label={t('report.pin.where')}
      className="absolute bottom-[52px] left-3 z-10 w-[300px] rounded-[14px] bg-ws-card p-3.5 shadow-[0_16px_34px_rgba(20,40,30,0.14),0_0_0_1px_var(--ws-line)]"
      data-testid="pin-popover"
    >
      <h4 className="mb-2.5 text-[13.5px] font-semibold">{t('report.pin.where')}</h4>
      {option('position', info.name ?? result.suggest.position, t('report.pin.position_panel'))}
      {duty === undefined ? null : option('duty', duty.role_name, t('report.pin.duty_panel'))}
      <p className="mt-2.5 mb-1 text-xs text-ws-muted-fg">{t('report.pin.how_often')}</p>
      <div className="inline-flex rounded-[9px] bg-ws-secondary p-0.5">
        {REFRESH.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={refresh === r}
            data-testid={`pin-refresh-${r}`}
            className={cn(
              'rounded-[7px] px-2.5 py-[3px] text-[12px]',
              refresh === r
                ? 'bg-ws-card font-semibold text-ws-ink shadow-[0_1px_2px_rgba(0,0,0,0.08)]'
                : 'text-ws-muted-fg',
            )}
            onClick={() => {
              setRefresh(r)
            }}
          >
            {t(`report.pin.refresh.${r}`)}
          </button>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <button
          type="button"
          className="h-[26px] rounded-[7px] px-2.5 text-[12px] text-ws-muted-fg hover:bg-ws-secondary"
          onClick={onCancel}
        >
          {t('report.pin.cancel')}
        </button>
        <button
          type="button"
          data-testid="pin-confirm"
          disabled={pin.isPending}
          className="h-[26px] rounded-[7px] bg-ws-brand px-2.5 text-[12px] font-medium text-ws-brand-fg disabled:opacity-60"
          onClick={() => {
            pin.mutate()
          }}
        >
          {t('report.pin.confirm')}
        </button>
      </div>
      {pin.error === null ? null : (
        <p className="mt-2 text-[12px] text-ws-bad" role="alert">
          {pin.error.message}
        </p>
      )}
    </div>
  )
}

export function ReportCompose({
  position,
  duty,
  prompt,
}: {
  position?: string
  duty?: string
  prompt?: string
}): ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const input = useRef<HTMLTextAreaElement | null>(null)
  const [text, setText] = useState(prompt ?? PREFIX)
  const [asked, setAsked] = useState<string | undefined>(undefined)
  const [result, setResult] = useState<ComposeResult | undefined>(undefined)
  const [picking, setPicking] = useState(false)
  const [pinned, setPinned] = useState<
    { id: string; where: string; refresh: ReportRefresh } | undefined
  >(undefined)
  const compose = useMutation({
    mutationFn: (q: string) =>
      composeReport({
        prompt: q.startsWith(PREFIX) ? q.slice(PREFIX.length).trim() || q : q,
        ...(position === undefined ? {} : { position }),
        ...(duty === undefined ? {} : { duty }),
      }),
    onSuccess: (out) => {
      setResult(out)
      setPinned(undefined)
    },
  })
  const undo = useMutation({
    mutationFn: (id: string) => unpinReport(id),
    onSuccess: () => {
      setPinned(undefined)
      markPinned(null)
      void client.invalidateQueries({ queryKey: REPORTS_QUERY })
    },
  })
  const send = (): void => {
    const q = text.trim()
    if (q === '' || q === PREFIX.trim()) return
    setAsked(q)
    compose.mutate(q)
    setText('')
  }
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="report-compose">
      {/* int/1024：标题与 × 用第三栏宿主头上那一行（WP437「做一份报表」），这里不再另画一行 */}
      {pinned === undefined ? null : (
        <div
          role="status"
          data-testid="pin-toast"
          className="mx-auto mt-3 flex items-center gap-2.5 rounded-[10px] bg-ws-ink px-3.5 py-2 text-[13px] text-ws-paper shadow-[0_16px_34px_rgba(20,40,30,0.14)]"
        >
          <Check aria-hidden className="size-4" />
          {t('report.pin.toast', {
            where: pinned.where,
            when: t(`report.pin.refresh.long.${pinned.refresh}`),
          })}
          <button
            type="button"
            className="font-semibold text-ws-brand-soft underline-offset-2 hover:underline dark:text-ws-brand"
            onClick={() => {
              undo.mutate(pinned.id)
            }}
          >
            {t('report.pin.undo')}
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[780px] flex-col gap-[18px] px-6 pt-5 pb-8">
          {asked === undefined ? (
            <p className="text-[13px] text-ws-muted-fg">{t('report.compose.lead')}</p>
          ) : (
            <p
              className="max-w-[560px] self-end rounded-[14px_14px_4px_14px] bg-ws-secondary px-3.5 py-2.5 text-[14px]"
              data-testid="compose-question"
            >
              {asked}
            </p>
          )}
          {compose.isPending ? (
            <p className="text-[13px] text-ws-muted-fg">{t('report.compose.working')}</p>
          ) : null}
          {compose.error === null ? null : (
            <p className="text-[13px] text-ws-bad" role="alert">
              {compose.error.message}
            </p>
          )}
          {result === undefined ? null : (
            <div
              className="flex flex-col gap-2.5 text-[14px] text-ws-body"
              data-testid="compose-answer"
            >
              <ul className="flex flex-col gap-1 text-[12.5px] text-ws-muted-fg">
                {result.reads.map((r) => (
                  <li key={r} className="flex items-center gap-1.5">
                    <Check aria-hidden className="size-3.5" />
                    {r}
                  </li>
                ))}
              </ul>
              <p>
                {result.answer.replace(/\*\*/g, '')}
                {result.matched ? t('report.compose.below') : ''}
              </p>
              <MiniReport
                data={result.draft}
                pinned={pinned !== undefined}
                onPin={() => {
                  setPicking(true)
                }}
                onExpand={() => {
                  openRightPane({
                    kind: 'report',
                    id: result.draft.id,
                    position: result.suggest.position,
                  })
                }}
                onEdit={() => {
                  setText('改一改：')
                  input.current?.focus()
                }}
                pinSlot={
                  picking ? (
                    <PinPopover
                      result={result}
                      onCancel={() => {
                        setPicking(false)
                      }}
                      onPinned={(s, where) => {
                        setPicking(false)
                        setPinned({ id: s.id, where, refresh: s.refresh })
                        markPinned(s.id)
                        void client.invalidateQueries({ queryKey: REPORTS_QUERY })
                      }}
                    />
                  ) : null
                }
              />
            </div>
          )}
        </div>
      </div>
      <div className="shrink-0 px-6 pb-5">
        <div className="mx-auto max-w-[780px] rounded-[16px] bg-ws-card px-4 pt-3.5 pb-2.5 shadow-[var(--ws-shadow)]">
          <textarea
            ref={input}
            // biome-ignore lint/a11y/noAutofocus: 点「+」就是要说一句
            autoFocus
            rows={2}
            value={text}
            aria-label={t('report.compose.input')}
            placeholder={t('report.compose.placeholder')}
            data-testid="compose-input"
            className="w-full resize-none bg-transparent text-[14.5px] text-ws-ink outline-none placeholder:text-ws-faint"
            onChange={(e) => {
              setText(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="flex items-center">
            <button
              type="button"
              aria-label={t('report.ask.send')}
              data-testid="compose-send"
              disabled={compose.isPending}
              className="ml-auto grid size-[30px] place-items-center rounded-full bg-ws-brand text-ws-brand-fg disabled:bg-ws-secondary disabled:text-ws-muted-fg"
              onClick={send}
            >
              <Send aria-hidden className="size-3.5" />
            </button>
          </div>
        </div>
        {result === undefined ? (
          <div
            className="mx-auto mt-2.5 flex max-w-[780px] flex-wrap gap-1.5"
            data-testid="compose-examples"
          >
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                className="h-7 rounded-full px-[11px] text-[12.5px] text-ws-body shadow-[inset_0_0_0_1px_var(--ws-line)] hover:bg-ws-card hover:text-ws-ink"
                onClick={() => {
                  setText(`${PREFIX}${ex}`)
                  input.current?.focus()
                }}
              >
                {ex}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
