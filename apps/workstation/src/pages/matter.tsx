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
import {
  Archive,
  Bot,
  CheckSquare,
  CreditCard,
  ExternalLink,
  FileText,
  MessageSquare,
  Pin,
  User,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { AskAiPanel } from '@/components/deck/ask-ai-panel'
import { StatusPill } from '@/components/design'
import { RAIL_FETCH } from '@/components/sidebar/duty-threads'
import { archiveBlock } from '@/components/sidebar/matter-menu'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { LinkedText } from '@/components/ui/linked-text'
import { ReplyMarkdown } from '@/components/ui/reply-markdown'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  closeMatter,
  completeTodo,
  getMatter,
  getMatterTimeline,
  getPosition,
  getPositionByTemplate,
  postMatterMessage,
  rerouteMatter,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import {
  archiveMatter,
  getWorkRail,
  markMatterSeen,
  RAIL_KEY,
  unarchiveMatter,
} from '@/lib/work-archive'

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
  templateId,
  roleId,
}: {
  matterId: string
  /** 事项钉着的那条分配（定了职责才有） */
  positionId?: string
  /** WP237：事项所属的岗位模板（还没定职责时只有它） */
  templateId?: string
  roleId?: string
}): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [picking, setPicking] = useState(false)
  /*
   * WP153：一进来就取岗位（不等点「换」）——「路由到 …」要写职责的**名字**。以前只在点「换」
   * 之后才取，于是那一行先显示的是职责 id（`common.owner`），内部值上了屏。
   */
  const position = useQuery({
    queryKey: ['position-instance', positionId ?? templateId ?? ''],
    queryFn: () =>
      positionId === undefined ? getPositionByTemplate(templateId ?? '') : getPosition(positionId),
    enabled: (positionId ?? templateId ?? '') !== '',
  })
  const reroute = useMutation({
    mutationFn: (next: string) => rerouteMatter(matterId, next),
    onSettled: () => {
      setPicking(false)
      void client.invalidateQueries({ queryKey: ['matter', matterId] })
    },
  })
  // WP237：还没定职责 → 本人在这个岗位下的那几条直接摆成按钮，点了就钉到它并开跑
  const choose = useMutation({
    mutationFn: (next: string) => rerouteMatter(matterId, next, { run: true }),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['matter', matterId] })
    },
  })
  const current = position.data?.roles.find((r) => r.role_id === roleId)
  if (roleId === undefined)
    return (
      <div
        className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground"
        data-testid="matter-routed"
        data-role=""
      >
        <span>{t('matter.routed.none')}</span>
        {(position.data?.roles ?? [])
          .filter((r) => r.my_assignment_id !== undefined)
          .map((r) => (
            <Button
              key={r.role_id}
              size="xs"
              variant="outline"
              data-testid="matter-route-go"
              data-role={r.role_id}
              disabled={choose.isPending}
              onClick={() => {
                choose.mutate(r.role_id)
              }}
            >
              {t('matter.route.go', { role: r.role_name })}
            </Button>
          ))}
      </div>
    )
  return (
    <div className="flex flex-col gap-1" data-testid="matter-routed" data-role={roleId ?? ''}>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          {roleId === undefined
            ? t('matter.routed.none')
            : current === undefined
              ? null
              : t('matter.routed', { role: current.role_name })}
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

/**
 * WP236：最近那次「被停下来」的运行之后，还没有人接着做（没有新的人话 / 新的运行），
 * 就在那一条下面出「接着跑」。只给最近那一条——更早的停下来已经被后面的运行接上了。
 */
function resumableOf(timeline: readonly MatterEvent[]): string | undefined {
  const stopped = timeline
    .filter((e) => e.stopped !== undefined)
    .reduce<MatterEvent | undefined>((a, e) => (a === undefined || e.at >= a.at ? e : a), undefined)
  if (stopped === undefined) return undefined
  const later = timeline.some(
    (e) => e.at > stopped.at && (e.kind === 'human_message' || e.kind === 'run'),
  )
  return later ? undefined : stopped.id
}

function TimelineEvent({
  event,
  onResume,
  resuming,
  onRoute,
  routing,
  currentRole,
}: {
  event: MatterEvent
  /** WP236：这一条是被停下来的运行，点了接着跑同一件事。 */
  onResume?: () => void
  resuming?: boolean
  /** WP237：路由那一条下面的「走 X / 换成 X」——钉到那条职责并开跑。 */
  onRoute?: (role_id: string) => void
  routing?: boolean
  /** 事项现在走的那条职责（已经是它的按钮不再出） */
  currentRole?: string
}): React.ReactNode {
  const { lang, t } = useApp()
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
        {/*
          WP153：Agent 的回话按 markdown 安全地画（粗体、列表、编号、行内代码、链接；不认 HTML、
          不加载图片）。WP142 的站内链接照旧可点。别的条目（人说的话、状态）仍是纯文字。
        */}
        {event.kind === 'agent_message' ? (
          <ReplyMarkdown text={event.text} />
        ) : (
          <p className="whitespace-pre-wrap break-words">
            <LinkedText text={event.text} />
          </p>
        )}
        {(() => {
          const route = event.route
          if (route === undefined || onRoute === undefined) return null
          // 还没定的那一条：定了之后就不再出（选择已经做过了）
          if (route.picked === undefined && currentRole !== undefined) return null
          const options = route.options.filter((o) => o.role_id !== currentRole)
          if (options.length === 0) return null
          return (
            <div className="mt-1 flex flex-wrap gap-1.5" data-testid="matter-route-options">
              {options.map((o) => (
                <Button
                  key={o.role_id}
                  size="xs"
                  variant="outline"
                  data-role={o.role_id}
                  disabled={routing === true}
                  onClick={() => {
                    onRoute(o.role_id)
                  }}
                >
                  {t(route.picked === undefined ? 'matter.route.go' : 'matter.route.switch', {
                    role: o.role_name,
                  })}
                </Button>
              ))}
            </div>
          )
        })()}
        {/* WP253：「预览好了」那一条——未发布主题的预览链接（线上没动） */}
        {event.preview === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            className="mt-1 gap-1"
            data-testid="matter-preview-open"
            onClick={() => {
              if (event.preview !== undefined) openExternal(event.preview.url)
            }}
          >
            <ExternalLink className="size-3" aria-hidden />
            {t('matter.preview.open')}
          </Button>
        )}
        {onResume === undefined ? null : (
          <Button
            size="xs"
            variant="outline"
            className="mt-1"
            data-testid="matter-resume"
            disabled={resuming === true}
            onClick={onResume}
          >
            {t('matter.resume')}
          </Button>
        )}
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

  /*
   * WP207：点开看过了——左栏这件事「做完待看」的小点灭掉。页面开着时 Agent 又答了一句
   * （事项数据刷新），也算看过。失败不打扰人（它只管一个小点）。
   */
  const seenAt = matter.dataUpdatedAt
  useEffect(() => {
    if (id === '' || seenAt === 0) return
    void markMatterSeen(id).then(() => client.invalidateQueries({ queryKey: RAIL_KEY }))
  }, [id, seenAt, client])

  /*
   * Fable 09-30：事项页顶上也能手动归档。在跑的、有卡等你批的置灰（问号里说为什么）——
   * 状态取左栏那一份（同一个查询键，不多打一次）；这件事不在左栏里时按本页的未决卡判。
   */
  const rail = useQuery({
    queryKey: RAIL_KEY,
    queryFn: () => getWorkRail(RAIL_FETCH),
    retry: false,
    staleTime: 30_000,
  })
  const railState = rail.data?.positions
    .flatMap((p) => p.duties.flatMap((d) => d.matters))
    .find((m) => m.id === id)?.state
  const archive = useMutation({
    mutationFn: () => archiveMatter(id),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
  })

  const restore = useMutation({
    mutationFn: () => unarchiveMatter(id, 'user'),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['matter'] })
    },
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

  // WP237：时间线上「走 X / 换成 X」——改派并重跑
  const route = useMutation({
    mutationFn: (role_id: string) => rerouteMatter(id, role_id, { run: true }),
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
  const resumableId = view.matter.status === 'closed' ? undefined : resumableOf(timeline)

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
            {view.matter.status === 'closed' || view.matter.archived_at !== undefined
              ? null
              : (() => {
                  const blocked = archiveBlock(
                    railState ?? (view.open_card_ids.length > 0 ? 'awaiting' : undefined),
                  )
                  return (
                    <span className="flex items-center gap-1">
                      <Button
                        size="xs"
                        variant="ghost"
                        data-testid="matter-archive"
                        disabled={blocked !== undefined || archive.isPending}
                        onClick={() => {
                          archive.mutate()
                        }}
                      >
                        <Archive aria-hidden />
                        {t('archive.action')}
                      </Button>
                      {blocked === undefined ? null : (
                        <Hint text={t(blocked)} testId="matter-archive-why" />
                      )}
                    </span>
                  )
                })()}
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
        {view.matter.position_id === undefined &&
        view.matter.position_template_id === undefined ? null : (
          <RoutedLine
            matterId={view.matter.id}
            {...(view.matter.position_id === undefined
              ? {}
              : { positionId: view.matter.position_id })}
            {...(view.matter.position_template_id === undefined
              ? {}
              : { templateId: view.matter.position_template_id })}
            {...(view.matter.role_id === undefined ? {} : { roleId: view.matter.role_id })}
          />
        )}
        {/* WP207：归档的事照样能看；一句话 + 一个「放回左栏」 */}
        {view.matter.archived_at === undefined ? null : (
          <div
            className="flex flex-wrap items-center gap-2 rounded-[10px] bg-ws-tint/60 px-3 py-2 text-[13px]"
            data-testid="matter-archived"
          >
            <Archive aria-hidden className="size-3.5 text-ws-muted-fg" />
            <span className="flex-1">{t('matter.archived')}</span>
            <Button
              size="xs"
              variant="outline"
              data-testid="matter-unarchive"
              disabled={restore.isPending}
              onClick={() => {
                restore.mutate()
              }}
            >
              {t('matter.unarchive')}
            </Button>
          </div>
        )}
        {/*
          WP259：「交给它」的一大段原文也存在描述里——时间线第一条就是它的全文，
          这里最多三行（保留换行），整段悬停看。
        */}
        <p
          className="line-clamp-3 whitespace-pre-line text-sm text-muted-foreground"
          data-testid="matter-summary"
          title={view.matter.context.summary === '' ? undefined : view.matter.context.summary}
        >
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
              <TimelineEvent
                key={event.id}
                event={event}
                {...(view.matter.status === 'closed'
                  ? {}
                  : {
                      onRoute: (role_id: string) => {
                        route.mutate(role_id)
                      },
                      routing: route.isPending,
                    })}
                {...(view.matter.role_id === undefined ? {} : { currentRole: view.matter.role_id })}
                {...(event.id === resumableId
                  ? {
                      onResume: () => {
                        say.mutate(t('matter.resume.brief'))
                      },
                      resuming: say.isPending,
                    }
                  : {})}
              />
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
