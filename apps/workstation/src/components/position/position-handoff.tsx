/**
 * 岗位页的输入框（WP241「交给它」→ WP287 Luoye 10-09 真机后重做）。
 *
 * - **和事项页 / 随便聊同一个输入框**（`MatterComposer`：发送是框内的箭头，不写「交给它」；
 *   有合适的建议时浅灰字 + Tab 收下；「+」「@」同一套）。岗位页没有「私聊 AI」——这里发出去就是开一段会话。
 * - **发出去就进这件事的会话线程**（`usePositionOpen` → `detach`）：回答在线程里流式出现；
 *   问一句是会话、不进「工作」，要动手的才是任务——由服务端判，判不准先当会话答。
 * - 不让人选职责（WP287 第 2 条）：原来那个「职责：自动」下拉去掉了，岗位自己按分 / 先后取，线程里能「换一条」。
 * - 下面一排快捷建议照旧，点一下填进框。
 *
 * `hero`：新岗位、什么都还没有时（`position-v2-empty.html`），它放大当主角。
 */
import { Send } from 'lucide-react'
import { useState } from 'react'
import { MatterComposer } from '@/components/matter/matter-composer'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { Button } from '@/components/ui/button'
import { Hint } from '@/components/ui/hint'
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
  const { open, pick, choice, error, clearError } = usePositionOpen(id, () => {
    setText('')
  })

  const mine = view.roles.filter((r) => r.my_assignment_id !== undefined)
  // 建议只从本人那几条职责来（54 §1：拿别人那条去开就是借岗位扩权）
  const suggestions = mine.flatMap((r) => r.quick_prompts ?? []).slice(0, MAX_SUGGESTIONS)
  const busy = open.isPending

  const submit = (): void => {
    const title = text.trim().slice(0, TASK_TEXT_MAX)
    if (title === '' || busy) return
    clearError()
    open.mutate({ title })
  }

  return (
    <section
      data-testid="position-handoff"
      data-hero={hero ? 'true' : 'false'}
      className={
        hero
          ? 'flex flex-col gap-3 rounded-2xl border bg-card p-6 shadow-sm'
          : 'flex flex-col gap-2'
      }
    >
      {hero ? (
        <h2 className="ws-display flex items-center gap-2 text-[19px]">
          <Send className="size-4 text-ws-brand" aria-hidden />
          {t('pos2.handoff.first')}
        </h2>
      ) : null}
      <MatterComposer
        value={text}
        onChange={(v) => {
          setText(v.slice(0, TASK_TEXT_MAX))
          clearError()
        }}
        onSend={submit}
        onStop={() => undefined}
        running={false}
        closed={false}
        privateMode={false}
        onTogglePrivate={() => undefined}
        sending={busy}
        docked={false}
        showPrivate={false}
        placeholderText={t(hero ? 'pos2.handoff.first.ask' : 'pos2.handoff.ask')}
        label={t('position.entry.title')}
        testId="position-entry-input"
      />
      {/* WP259：没发出去就在框下说一句（含服务端那句话），不再静默 */}
      <HandoffError error={error} />
      {suggestions.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {suggestions.map((q) => (
            <button
              key={q.id}
              type="button"
              className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
              data-testid="entry-suggestion"
              data-prompt={q.id}
              title={q.prompt}
              onClick={() => {
                setText(q.prompt)
              }}
            >
              {lang === 'en' ? q.label.en : q.label.zh}
            </button>
          ))}
        </div>
      )}
      {hero ? (
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          {t('pos2.handoff.first.note')}
          <Hint text={t('position.entry.hint')} />
        </p>
      ) : null}

      {/* 老服务端还可能回一张「走哪条职责」——那时把候选摆出来（新服务端不再出） */}
      {choice === undefined ? null : (
        <fieldset className="rounded-md border p-3" data-testid="route-choice">
          <p className="flex items-center gap-1 text-sm" data-slot="status">
            {choice.reason}
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
