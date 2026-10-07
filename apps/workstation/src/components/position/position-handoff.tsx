/**
 * WP241 岗位页 v2「交给它」：一行输入 + 一排建议，点进去才展开成三行（带「职责：自动」）。
 *
 * 提交走的还是 54 §2 那三条路（`usePositionOpen`，与 WP237 同一份）：
 * 职责选「自动」= 岗位入口、岗位内路由；选了某条 = 「用这条职责开」（本人那条分配）。
 * 拿不准时出的候选照旧摆在框下面让人点。
 *
 * `hero`：新岗位、什么都还没有时（`position-v2-empty.html`），它放大当主角。
 */
import { Loader2, Send } from 'lucide-react'
import { useState } from 'react'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
import { Textarea } from '@/components/ui/textarea'
import { HandoffError } from '@/components/work/handoff-error'
import { usePositionOpen } from '@/components/work/use-position-open'
import type { PositionInstanceData } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { TASK_TEXT_MAX } from '@/lib/handoff'

const MAX_SUGGESTIONS = 4

export function PositionHandoff({
  id,
  view,
  hero = false,
}: {
  id: string
  view: PositionInstanceData
  hero?: boolean
}): React.ReactNode {
  const { t, lang } = useApp()
  const [text, setText] = useState('')
  const [focused, setFocused] = useState(false)
  const [duty, setDuty] = useState('')
  const { open, withRole, pick, choice, error, clearError } = usePositionOpen(id, () => {
    setText('')
  })

  const mine = view.roles.filter((r) => r.my_assignment_id !== undefined)
  // 建议只从本人那几条职责来（54 §1：拿别人那条去开就是借岗位扩权）
  const suggestions = mine.flatMap((r) => r.quick_prompts ?? []).slice(0, MAX_SUGGESTIONS)
  const example = suggestions[0]
  const exampleText =
    example === undefined ? '' : lang === 'en' ? example.label.en : example.label.zh
  const placeholder = hero
    ? exampleText === ''
      ? t('position.entry.placeholder.plain')
      : t('pos2.handoff.first.placeholder', { example: exampleText })
    : exampleText === ''
      ? t('pos2.handoff.placeholder.plain')
      : t('pos2.handoff.placeholder.example', { example: exampleText })
  const expanded = hero || focused || text !== ''
  const busy = open.isPending || withRole.isPending

  const submit = (): void => {
    const title = text.trim()
    if (title === '' || busy) return
    clearError()
    const assignment = mine.find((r) => r.role_id === duty)?.my_assignment_id
    if (assignment !== undefined) withRole.mutate({ assignment, title })
    else open.mutate({ title })
  }

  return (
    <section
      data-testid="position-handoff"
      data-hero={hero ? 'true' : 'false'}
      data-expanded={expanded ? 'true' : 'false'}
      className={
        hero
          ? 'flex flex-col gap-3 rounded-2xl border bg-card p-6 shadow-sm'
          : `flex flex-col gap-2 rounded-2xl border bg-card px-3 py-2.5 shadow-sm transition-shadow ${focused ? 'ring-2 ring-ws-brand/30' : ''}`
      }
    >
      {hero ? (
        <h2 className="ws-display flex items-center gap-2 text-[19px]">
          <Send className="size-4 text-ws-brand" aria-hidden />
          {t('pos2.handoff.first')}
        </h2>
      ) : null}
      <div className={hero ? 'relative' : 'flex items-start gap-2'}>
        {hero ? null : <Send className="mt-2 size-4 shrink-0 text-ws-muted-fg" aria-hidden />}
        <Textarea
          aria-label={t('position.entry.title')}
          rows={expanded ? 3 : 1}
          value={text}
          maxLength={TASK_TEXT_MAX}
          placeholder={placeholder}
          data-testid="position-entry-input"
          className={
            hero
              ? 'min-h-[88px] resize-none pr-28'
              : `min-h-0 resize-none border-0 px-0 shadow-none focus-visible:ring-0 ${expanded ? '' : 'h-8 py-1.5'}`
          }
          onFocus={() => {
            setFocused(true)
          }}
          onBlur={() => {
            setFocused(false)
          }}
          onChange={(e) => {
            setText(e.target.value)
            clearError()
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <Button
          size="sm"
          className={hero ? 'absolute right-2 bottom-2' : 'shrink-0'}
          disabled={text.trim() === '' || busy}
          data-testid="position-entry-submit"
          data-busy={busy ? 'true' : undefined}
          onClick={submit}
        >
          {busy ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Send className="size-3.5" aria-hidden />
          )}
          {busy ? t('handoff.sending') : t('position.entry.submit')}
        </Button>
      </div>
      {/* WP259：没交出去就在框下说一句（含服务端那句话），不再静默 */}
      <HandoffError error={error} />
      <div className="flex flex-wrap items-center gap-1.5">
        {suggestions.map((q) => (
          <button
            key={q.id}
            type="button"
            className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            data-testid="entry-suggestion"
            data-prompt={q.id}
            title={q.prompt}
            onMouseDown={(e) => {
              // 不让输入框先失焦再收起，点一下就填进去
              e.preventDefault()
            }}
            onClick={() => {
              setText(q.prompt)
            }}
          >
            {lang === 'en' ? q.label.en : q.label.zh}
          </button>
        ))}
        {expanded && mine.length > 1 ? (
          <label className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
            <span>{t('pos2.handoff.duty', { name: '' }).trim()}</span>
            <select
              className="rounded-md border bg-transparent px-1.5 py-0.5 text-xs text-foreground"
              value={duty}
              data-testid="position-handoff-duty"
              onMouseDown={(e) => {
                e.stopPropagation()
              }}
              onChange={(e) => {
                setDuty(e.target.value)
              }}
            >
              <option value="">{t('pos2.handoff.duty.auto')}</option>
              {mine.map((r) => (
                <option key={r.role_id} value={r.role_id}>
                  {r.role_name}
                </option>
              ))}
            </select>
            <Hint text={t('pos2.handoff.duty.hint')} />
          </label>
        ) : null}
      </div>
      {hero ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('pos2.handoff.first.note')}
          <Hint text={t('position.entry.hint')} />
        </p>
      ) : null}

      {/* 拿不准：这件事像 A 也像 B，你定（54 §2） */}
      {choice === undefined ? null : (
        <fieldset className="rounded-md border p-3" data-testid="route-choice">
          <p className="flex items-center gap-1 text-sm" data-slot="status">
            {choice.reason}
            <Hint text={t('position.choice.hint')} />
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {choice.candidates.map((c) => (
              <Button
                key={c.role_id}
                size="xs"
                variant="outline"
                data-testid="route-choice-option"
                disabled={pick.isPending}
                onClick={() => {
                  pick.mutate({ matter_id: choice.matter.id, role_id: c.role_id })
                }}
              >
                <DutyIcon role_id={c.role_id} size={14} />
                {c.role_name}
              </Button>
            ))}
          </div>
        </fieldset>
      )}
    </section>
  )
}
