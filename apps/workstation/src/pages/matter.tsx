/**
 * 事项页（37 §2.2b）：**唯一的上下文容器**。
 *
 * 一屏的顺序就是文档里那句话：顶部摘要 + 固定记录 + 待办列表 + 时间线 + 底部对话输入。
 * 进入时只加载 `context.summary` + `pinned` 的展示名 + 最近 20 条时间线（重的东西点进去才来）。
 *
 * 底部这个输入框是**对话入口的第四处**，也是唯一有边界的一处：作用域是这个事项、
 * 角色是这个岗位的 Agent。仍然没有全局聊天框。
 */
import type { MatterEvent } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bot, CheckSquare, CreditCard, FileText, MessageSquare, Pin, User } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { AskAiPanel } from '@/components/deck/ask-ai-panel'
import { StatusPill } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { LinkedText } from '@/components/ui/linked-text'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  closeMatter,
  completeTodo,
  getMatter,
  getMatterTimeline,
  getPosition,
  postMatterMessage,
  rerouteMatter,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'

const EVENT_ICON = {
  human_message: MessageSquare,
  agent_message: Bot,
  run: Bot,
  card: CreditCard,
  todo: CheckSquare,
  meeting: User,
  note: FileText,
  status: FileText,
} as const

/**
 * WP69（54 §2）：**这件事现在归哪条职责做，以及怎么换**。
 *
 * 一行字，排在标题下面：「路由到 店铺管理 · 换」。点「换」展开的是**这个岗位下**
 * 的职责清单——换职责不是扩权的口子，能换到的只有这个岗位里、而且本人名下有的那些
 * （服务端还会再判一次）。换完只影响之后起的 Run，旧 Run 一条都不动。
 */
function RoutedLine({
  matterId,
  positionId,
  roleId,
}: {
  matterId: string
  positionId: string
  roleId?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [picking, setPicking] = useState(false)
  const position = useQuery({
    queryKey: ['position-instance', positionId],
    queryFn: () => getPosition(positionId),
    enabled: positionId !== '' && picking,
  })
  const reroute = useMutation({
    mutationFn: (next: string) => rerouteMatter(matterId, next),
    onSettled: () => {
      setPicking(false)
      void client.invalidateQueries({ queryKey: ['matter', matterId] })
    },
  })
  const current = position.data?.roles.find((r) => r.role_id === roleId)
  return (
    <div className="flex flex-col gap-1" data-testid="matter-routed" data-role={roleId ?? ''}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {roleId === undefined
            ? t('matter.routed.none')
            : t('matter.routed', { role: current?.role_name ?? roleId })}
        </span>
        <Button
          size="xs"
          variant="ghost"
          data-testid="matter-reroute"
          onClick={() => {
            setPicking((v) => !v)
          }}
        >
          {t('matter.routed.change')}
        </Button>
      </div>
      {picking ? (
        <div className="flex flex-wrap gap-2" data-testid="reroute-options">
          {(position.data?.roles ?? []).map((r) => (
            <Button
              key={r.role_id}
              size="xs"
              variant={r.role_id === roleId ? 'secondary' : 'outline'}
              disabled={r.assignment_ids.length === 0 || reroute.isPending}
              onClick={() => {
                reroute.mutate(r.role_id)
              }}
            >
              {r.role_name}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TimelineEvent({ event }: { event: MatterEvent }): React.ReactNode {
  const { lang } = useApp()
  const Icon = EVENT_ICON[event.kind]
  return (
    <li
      id={event.id}
      data-testid="timeline-event"
      data-kind={event.kind}
      className="flex items-start gap-2 text-sm target:rounded-md target:bg-primary/10"
    >
      <Icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        {/* WP142：回话里的站内链接（「去候选池看全部」）画成可点的 */}
        <p className="whitespace-pre-wrap break-words">
          <LinkedText text={event.text} />
        </p>
        <p className="text-[11px] text-muted-foreground">{formatDateTime(event.at, lang)}</p>
      </div>
    </li>
  )
}

export function MatterPage(): React.ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const params = useParams()
  const id = params.id ?? ''
  const [text, setText] = useState('')
  const [limit, setLimit] = useState(20)
  const [closing, setClosing] = useState(false)

  const matter = useQuery({
    queryKey: ['matter', id],
    queryFn: () => getMatter(id),
    enabled: id !== '',
  })
  // 「看更早的」才多拉一页；默认那 20 条已经在 matterView 里了
  const more = useQuery({
    queryKey: ['matter', id, 'timeline', limit],
    queryFn: () => getMatterTimeline(id, limit),
    enabled: id !== '' && limit > 20,
  })

  // 锚点：从待办 / 卡片点进来时滚到那一条
  useEffect(() => {
    const hash = globalThis.location?.hash?.slice(1)
    if (hash === undefined || hash === '') return
    globalThis.document?.getElementById(hash)?.scrollIntoView({ block: 'center' })
  }, [])

  const say = useMutation({
    mutationFn: (value: string) => postMatterMessage(id, value),
    onSuccess: () => {
      setText('')
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['matter', id] })
    },
  })

  const close = useMutation({
    mutationFn: (unfinished: 'close_all' | 'keep') => closeMatter(id, unfinished),
    onSettled: () => {
      setClosing(false)
      void client.invalidateQueries({ queryKey: ['matter', id] })
      void client.invalidateQueries({ queryKey: ['todos'] })
    },
  })

  const check = useMutation({
    mutationFn: (todoId: string) => completeTodo(todoId),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['matter', id] })
      void client.invalidateQueries({ queryKey: ['todos'] })
    },
  })

  if (matter.isPending) return <Skeleton className="h-64 w-full" />
  if (matter.error !== null)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{matter.error.message}
      </p>
    )

  const view = matter.data
  const timeline = more.data?.events ?? view.timeline
  const hasMore = more.data?.has_more ?? view.has_more

  return (
    <div
      className="flex max-w-3xl flex-col gap-4"
      data-testid="matter"
      data-matter={view.matter.id}
    >
      {/*
        顶部：标题 + 摘要。
        WP96 画布《事项页 · 新风格》：标题是 26px 的 Outfit，下面一行胶囊
        （待审几张 / 岗位路由 / 范围），右边是"收尾"。胶囊行的顺序不变，只换皮。
      */}
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="ws-display text-[26px]">{view.matter.title}</h1>
          <div className="flex items-center gap-2">
            {view.open_card_ids.length === 0 ? null : (
              <StatusPill tone="good">
                {t('matter.cards', { count: view.open_card_ids.length })}
              </StatusPill>
            )}
            {view.matter.status === 'closed' ? (
              <span className="text-xs text-ws-muted-fg">{t('matter.closed')}</span>
            ) : (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => {
                  setClosing(true)
                }}
              >
                {t('matter.close')}
              </Button>
            )}
          </div>
        </div>
        {/* WP69（54 §2）：这件事归哪条职责做，可以换 */}
        {view.matter.position_id === undefined ? null : (
          <RoutedLine
            matterId={view.matter.id}
            positionId={view.matter.position_id}
            {...(view.matter.role_id === undefined ? {} : { roleId: view.matter.role_id })}
          />
        )}
        <p className="text-sm text-muted-foreground" data-testid="matter-summary">
          {view.matter.context.summary}
        </p>
      </header>

      {closing ? (
        <div className="rounded-md border p-3 text-sm" role="dialog" data-testid="close-dialog">
          <p>{t('matter.close.question')}</p>
          <div className="mt-2 flex gap-2">
            <Button
              size="xs"
              onClick={() => {
                close.mutate('close_all')
              }}
            >
              {t('matter.close.all')}
            </Button>
            <Button
              size="xs"
              variant="secondary"
              onClick={() => {
                close.mutate('keep')
              }}
            >
              {t('matter.close.keep')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* 固定记录 */}
      {view.pinned_labels.length === 0 ? null : (
        <section data-testid="matter-pinned">
          <h2 className="ws-display mb-1.5 text-[15px]">{t('matter.pinned')}</h2>
          <div className="flex flex-wrap gap-1.5">
            {view.pinned_labels.map((p) => (
              <span
                key={`${p.ref.type}:${p.ref.id}`}
                className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs"
              >
                <Pin className="size-3" aria-hidden />
                {p.label}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* 参与者与最近活动（40 §3.3：一件事看得见谁在做） */}
      <section data-testid="matter-participants">
        <h2 className="ws-display mb-1.5 text-[15px]">{t('matter.participants')}</h2>
        <div className="flex flex-wrap items-center gap-1.5">
          {view.participant_labels.length === 0 ? (
            <span className="text-sm text-muted-foreground">{t('matter.participants.empty')}</span>
          ) : (
            view.participant_labels.map((p) => (
              <span
                key={p.person_id}
                className="inline-flex items-center gap-1 rounded border bg-muted/50 px-1.5 py-0.5 text-xs"
                data-testid="matter-participant"
                data-person={p.person_id}
              >
                <User className="size-3" aria-hidden />
                {p.label}
              </span>
            ))
          )}
          <span className="text-xs text-muted-foreground">
            {t('matter.last_activity', {
              at: formatDateTime(view.matter.context.last_activity, lang),
            })}
          </span>
        </div>
      </section>

      {/* 这里的待办 */}
      <section data-testid="matter-todos">
        <h2 className="ws-display mb-1.5 text-[15px]">{t('matter.todos')}</h2>
        {view.todos.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('todos.empty')}</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {view.todos.map((todo) => (
              <li key={todo.id} className="flex items-center gap-2 text-sm" data-todo={todo.id}>
                <input
                  type="checkbox"
                  aria-label={t('todos.done')}
                  className="size-4 accent-primary"
                  checked={todo.status === 'done'}
                  onChange={() => {
                    check.mutate(todo.id)
                  }}
                />
                <span
                  className={
                    todo.status === 'done' ? 'truncate line-through opacity-60' : 'truncate'
                  }
                >
                  {todo.title}
                </span>
                {todo.cards.length === 0 ? null : (
                  <span className="rounded border bg-muted px-1.5 py-0.5 text-[11px]">
                    {t('todos.cards', { count: todo.cards.length })}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* 时间线 */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t('matter.timeline')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {hasMore ? (
            <Button
              size="xs"
              variant="ghost"
              className="self-start"
              onClick={() => {
                setLimit((v) => v + 20)
              }}
            >
              {t('matter.more')}
            </Button>
          ) : null}
          <ul className="flex flex-col gap-2">
            {timeline.map((event) => (
              <TimelineEvent key={event.id} event={event} />
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* 底部对话输入：第四处入口，作用域是这个事项 */}
      <form
        className="flex flex-col gap-2"
        data-testid="matter-say"
        onSubmit={(e) => {
          e.preventDefault()
          if (text.trim() === '') return
          say.mutate(text.trim())
        }}
      >
        <Textarea
          rows={2}
          value={text}
          aria-label={t('matter.say')}
          placeholder={t('matter.say')}
          disabled={view.matter.status === 'closed'}
          onChange={(e) => {
            setText(e.target.value)
          }}
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={text.trim() === '' || view.matter.status === 'closed' || say.isPending}
          >
            {t('matter.send')}
          </Button>
        </div>
        {say.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {say.error.message}
          </p>
        )}
      </form>

      {/*
        36 §3 问 AI：与上面那个框语义相反——说一句会让 Agent 去做事、可能变成对客户说的话，
        问 AI 只是问一句给自己看，不产生任何动作，作用域同样是这个事项。
      */}
      <AskAiPanel scope={{ matter_id: view.matter.id }} />
    </div>
  )
}
