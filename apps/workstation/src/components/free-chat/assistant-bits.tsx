/**
 * WP343（决策 334 / 859）：「我的助理」这一页多出来的几样小东西。
 *
 * - {@link DispatchLine}：回复下面一行「已交给 Reddit 运营 · 官方版块 →」（点了进那件事）；
 * - {@link ReportNote}：交出去的事回来报的那一句（做完 / 要你拍板 / 没做成）+ 一个「去看 / 去拍板」；
 * - {@link Suggestions}：输入框下面最多 4 个快捷问题（服务端按状态生成；开始对话后收起）；
 * - {@link MentionMenu}：输入框里打 `@` 弹出的岗位 / 职责清单（选了就直接交给它）；
 * - {@link MemoryButton}：右上角「记忆」（助理这一层记的几条，能删）；
 * - {@link PeersButton}：右上角「替我答同事」（谁问过我 / 约时间 / 我的公开资料；个人模式不出）。
 *
 * 出现规则写在各自头上（docs/96 §4：组件有出现 / 不出现规则）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, AtSign, Brain, CheckCircle2, CircleAlert, Gavel, Users, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { SafeMarkdown } from '@/components/ui/safe-markdown'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { useApp } from '@/lib/app-context'
import {
  type AssistantState,
  type AssistantTarget,
  type FreeChatDispatch,
  type FreeChatMessage,
  forgetAssistantMemory,
  listAssistantMemory,
} from '@/lib/free-chat'
import { cn } from '@/lib/utils'
import { SecretaryPage } from '@/pages/profile'

const whoOf = (x: { position_name: string; duty_name?: string }): string =>
  `${x.position_name}${x.duty_name === undefined ? '' : ` · ${x.duty_name}`}`

/** 出现：这一轮真交出去了。不出现：没交 / 拿不准（那时助理用一句话问你）。 */
export function DispatchLine({ dispatches }: { dispatches: FreeChatDispatch[] }): React.ReactNode {
  const { t } = useApp()
  if (dispatches.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5" data-testid="assistant-dispatch">
      {dispatches.map((d) => (
        <Link
          key={d.matter_id}
          to={`/matters/${encodeURIComponent(d.matter_id)}`}
          className="inline-flex items-center gap-1.5 rounded-full border border-ws-brand/40 bg-ws-tint px-2.5 py-1 text-xs text-ws-brand-ink hover:border-ws-brand"
          data-testid="assistant-dispatch-link"
        >
          <ArrowRight aria-hidden className="size-3.5" />
          {t('assistant.dispatched', { who: whoOf(d) })}
        </Link>
      ))}
    </div>
  )
}

/** 交出去的事回来报的一句。出现：那件事做完 / 出了要你拍板的卡 / 没做成（同一步只一次）。 */
export function ReportNote({ message }: { message: FreeChatMessage }): React.ReactNode {
  const { t } = useApp()
  const r = message.report
  if (r === undefined) return null
  const Icon = r.kind === 'done' ? CheckCircle2 : r.kind === 'decide' ? Gavel : CircleAlert
  const href =
    r.kind === 'decide' && r.approval_item_id !== undefined
      ? `/cards/${encodeURIComponent(r.approval_item_id)}`
      : `/matters/${encodeURIComponent(r.matter_id)}`
  return (
    <div
      className="flex items-start gap-2 rounded-xl border bg-ws-card px-3 py-2 text-[13px]"
      data-testid="assistant-report"
      data-kind={r.kind}
      {...(r.batch_id === undefined ? {} : { 'data-batch': r.batch_id })}
    >
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          r.kind === 'done'
            ? 'text-ws-brand'
            : r.kind === 'decide'
              ? 'text-ws-warn'
              : 'text-destructive',
        )}
      />
      <SafeMarkdown text={message.text} className="min-w-0 flex-1 leading-6" />
      <Link
        to={href}
        className="shrink-0 text-xs text-ws-brand-ink underline-offset-2 hover:underline"
        data-testid="assistant-report-open"
      >
        {r.kind === 'decide' ? t('assistant.report.decide') : t('assistant.report.open')}
      </Link>
    </div>
  )
}

/**
 * 输入框下面的快捷问题。出现：还没开始对话（空状态）且服务端给了。不出现：开始对话之后、或者一条都没有。
 * 「帮我建一个岗位」那种带 `href` 的点了直接去那一页，不发话。
 */
export function Suggestions({
  items,
  onPick,
}: {
  items: AssistantState['suggestions']
  onPick: (text: string) => void
}): React.ReactNode {
  const navigate = useNavigate()
  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap justify-center gap-2" data-testid="assistant-suggestions">
      {items.slice(0, 4).map((s) => (
        <button
          key={s.text}
          type="button"
          data-kind={s.kind}
          data-testid="assistant-suggestion"
          className="rounded-full border bg-ws-card px-3 py-1.5 text-[13px] text-muted-foreground shadow-ws transition-colors hover:text-foreground"
          onClick={() => {
            if (s.href === undefined) onPick(s.text)
            else navigate(s.href)
          }}
        >
          {s.text}
        </button>
      ))}
    </div>
  )
}

/** 一个 `@` 选项（岗位，或岗位里的一条职责）。 */
export interface MentionOption extends AssistantTarget {
  key: string
}

/** 岗位 → 选项：先岗位本身（岗位自己分职责），再它下面的每条职责。 */
export function mentionOptions(targets: AssistantState['targets'], query: string): MentionOption[] {
  const q = query.trim().toLowerCase()
  const out: MentionOption[] = []
  for (const p of targets) {
    out.push({ key: p.position_id, position_id: p.position_id, label: p.name })
    for (const d of p.duties)
      out.push({
        key: `${p.position_id}/${d.role_id}`,
        position_id: p.position_id,
        role_id: d.role_id,
        label: `${p.name} · ${d.name}`,
      })
  }
  return q === '' ? out : out.filter((o) => o.label.toLowerCase().includes(q))
}

/**
 * 正在打的 `@…`：光标前最后一个 `@`（行首或空白之后）到光标之间没有空白 → 回那段查询词。
 * 不是就回 `undefined`（菜单不出）。
 */
export function mentionQuery(text: string, caret: number): string | undefined {
  const before = text.slice(0, caret)
  const at = before.lastIndexOf('@')
  if (at < 0) return undefined
  if (at > 0 && !/\s/u.test(before[at - 1] ?? '')) return undefined
  const q = before.slice(at + 1)
  return /\s/u.test(q) ? undefined : q
}

/** `@` 菜单。出现：正在打 `@…`。不出现：别的时候。选了 = 这句话直接交给它（不经模型挑）。 */
export function MentionMenu({
  options,
  active,
  onPick,
}: {
  options: MentionOption[]
  active: number
  onPick: (o: MentionOption) => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <div
      className="max-h-56 overflow-y-auto rounded-xl border bg-popover p-1 text-[13px] shadow-lg"
      role="listbox"
      aria-label={t('assistant.mention.title')}
      data-testid="assistant-mention-menu"
    >
      <p className="px-2 py-1 text-xs text-muted-foreground">{t('assistant.mention.title')}</p>
      {options.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground">{t('assistant.mention.none')}</p>
      ) : (
        options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            role="option"
            aria-selected={i === active}
            data-testid="assistant-mention-option"
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left',
              i === active ? 'bg-ws-tint text-foreground' : 'text-muted-foreground',
              o.role_id === undefined ? 'font-medium' : 'pl-5',
            )}
            onMouseDown={(e) => {
              // 不抢输入框的焦点
              e.preventDefault()
              onPick(o)
            }}
          >
            {o.label}
          </button>
        ))
      )}
    </div>
  )
}

/** 选好的 `@` 那一个（输入框上面一个小胶囊，× 去掉）。 */
export function MentionChip({
  target,
  onClear,
}: {
  target: AssistantTarget
  onClear: () => void
}): React.ReactNode {
  const { t } = useApp()
  return (
    <span
      className="inline-flex w-fit items-center gap-1 rounded-full bg-ws-tint px-2 py-0.5 text-xs text-ws-brand-ink"
      data-testid="assistant-mention-chip"
    >
      <AtSign aria-hidden className="size-3" />
      {target.label}
      <button
        type="button"
        aria-label={t('assistant.mention.remove')}
        className="rounded-full p-0.5 hover:bg-background"
        onClick={onClear}
      >
        <X aria-hidden className="size-3" />
      </button>
    </span>
  )
}

/**
 * 右上角「记忆」。出现：总在（点开是助理这一层记的几条，能删）。
 * `highlight` 是从「记住了」小提醒点过来时要亮的那几条（`?memory=`）——那时自动打开。
 */
export function MemoryButton({ highlight }: { highlight?: readonly string[] }): React.ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const lit = highlight ?? []
  useEffect(() => {
    if (lit.length > 0) setOpen(true)
  }, [lit.length])
  const memory = useQuery({
    queryKey: ['free-chat', 'memory'],
    queryFn: listAssistantMemory,
    enabled: open,
    retry: false,
  })
  const forget = useMutation({
    mutationFn: forgetAssistantMemory,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['free-chat', 'memory'] })
    },
  })
  const date = (at: string): string =>
    new Date(at).toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN', {
      month: 'short',
      day: 'numeric',
    })
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        size="xs"
        variant="ghost"
        data-testid="assistant-memory"
        onClick={() => setOpen(true)}
      >
        <Brain aria-hidden />
        {t('assistant.memory')}
      </Button>
      <SheetContent side="right" data-testid="assistant-memory-sheet">
        <SheetHeader>
          <SheetTitle>{t('assistant.memory')}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-2 px-4 pb-4">
          {(memory.data ?? []).length === 0 ? (
            <p className="text-muted-foreground">{t('assistant.memory.empty')}</p>
          ) : (
            (memory.data ?? []).map((m) => (
              <div
                key={m.id}
                data-testid="assistant-memory-row"
                data-lit={lit.includes(m.id)}
                className={cn(
                  'flex items-start gap-2 rounded-lg border px-3 py-2',
                  lit.includes(m.id) ? 'border-ws-brand bg-ws-tint' : '',
                )}
              >
                <div className="min-w-0 flex-1">
                  <p>{m.text}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(m.written_by === 'ai' ? 'assistant.memory.ai' : 'assistant.memory.mine', {
                      date: date(m.at),
                    })}
                  </p>
                </div>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={t('assistant.memory.forget')}
                  title={t('assistant.memory.forget')}
                  data-testid="assistant-memory-forget"
                  onClick={() => forget.mutate(m.id)}
                >
                  <X aria-hidden />
                </Button>
              </div>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/**
 * 右上角「替我答同事」（原「我的代理」：谁问过我、约时间、我的公开资料、问同事）。
 * 出现：同事互联 / 公司模式。不出现：个人模式（都是对同事的事，WP271）。
 */
export function PeersButton({ defaultOpen = false }: { defaultOpen?: boolean }): React.ReactNode {
  const { t } = useApp()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <Button
        size="xs"
        variant="outline"
        data-testid="assistant-peers"
        onClick={() => setOpen(true)}
      >
        <Users aria-hidden />
        {t('assistant.peers')}
      </Button>
      <SheetContent
        side="right"
        className="data-[side=right]:w-full data-[side=right]:sm:max-w-xl"
        data-testid="assistant-peers-sheet"
      >
        <SheetHeader>
          <SheetTitle>{t('assistant.peers')}</SheetTitle>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          {open ? <SecretaryPage embedded /> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
