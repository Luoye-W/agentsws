/**
 * 事项页（37 §2.2b）：**唯一的上下文容器**。
 *
 * WP264（决策 177–184，设计稿 docs/design/matter/）改成像 Claude 的对话页：
 * - 页头一行：AI 起的短标题（点了改）+ 一行灰字（职责 · 状态 · 参与者 · 最近活动 · 有才出的待办），「⋯」收其余；吸顶。
 * - 对话式时间线：你说的在右、AI 在左；结果 / 审批 / 选择 / 卡住是能直接点的卡；过程事件缩成居中一行灰字（默认收起）；
 *   正在跑的那次在最底下「正在做…」+ 当前一步。
 * - 底部输入卡：卡内圆形发送（运行中变「停」）、「私聊 AI」开关（替代原来那块「问 AI」）、Tab 收建议。
 *
 * 底部这个输入框是**对话入口的第四处**，也是唯一有边界的一处：作用域是这个事项、角色是这个岗位的 Agent。
 * 私聊 AI 只是问一句给自己看，不产生任何动作，关掉就没了（决策 178）。
 */
import type { MatterEvent } from '@agentsws/contracts'
import { type DeckAction, type DeckCard, projectCard } from '@agentsws/deck'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, CircleCheck } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { openExternal } from '@/components/connections/bridge'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { MatterComposer, PrivatePair } from '@/components/matter/matter-composer'
import { type DutyOption, MatterHeader } from '@/components/matter/matter-header'
import { buildItems, dayKey, matterState, suggestionFor } from '@/components/matter/matter-model'
import {
  AiEntry,
  BlockedCard,
  ChoiceCard,
  cardWaiting,
  clockOf,
  DaySep,
  InlineCard,
  MeBubble,
  RunningEntry,
  SysLine,
} from '@/components/matter/matter-timeline'
import { RAIL_FETCH } from '@/components/sidebar/duty-threads'
import { archiveBlock } from '@/components/sidebar/matter-menu'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  askAi,
  closeMatter,
  completeTodo,
  decide,
  getApproval,
  getMatter,
  getMatterTimeline,
  getPosition,
  getPositionByTemplate,
  postMatterMessage,
  rerouteMatter,
  retitleMatter,
  stopMatterRuns,
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

/** 在跑 / 刚发出去时多久拉一次（「正在做…」的当前一步跟着走）。 */
const POLL_MS = 1500

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

interface PrivateAsk {
  id: number
  question: string
  answer?: string
  error?: string
}

export function MatterPage(): ReactNode {
  const { t, lang } = useApp()
  const client = useQueryClient()
  const navigate = useNavigate()
  const params = useParams()
  const id = params.id ?? ''
  const [text, setText] = useState('')
  const [limit, setLimit] = useState(20)
  const [closing, setClosing] = useState(false)
  const [privateMode, setPrivateMode] = useState(false)
  const [asks, setAsks] = useState<PrivateAsk[]>([])
  const [queued, setQueued] = useState<string | undefined>(undefined)
  const askSeq = useRef(0)
  /** 在跑或刚发出去：页面隔一会儿拉一次（运行中的步骤、AI 新说的话）。 */
  const polling = useRef(false)

  const matter = useQuery({
    queryKey: ['matter', id],
    queryFn: () => getMatter(id),
    enabled: id !== '',
    refetchInterval: () => (polling.current ? POLL_MS : false),
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

  // 在跑的、有卡等你批的不许归档——状态取左栏那一份（同一个查询键，不多打一次）
  const rail = useQuery({
    queryKey: RAIL_KEY,
    queryFn: () => getWorkRail(RAIL_FETCH),
    retry: false,
    staleTime: 30_000,
  })
  const railState = rail.data?.positions
    .flatMap((p) => p.duties.flatMap((d) => d.matters))
    .find((m) => m.id === id)?.state

  const view = matter.data
  const positionId = view?.matter.position_id
  const templateId = view?.matter.position_template_id
  // 职责的人话名与「换职责」清单（WP153：一进来就取，标签写名字不写 id）
  const position = useQuery({
    queryKey: ['position-instance', positionId ?? templateId ?? ''],
    queryFn: () =>
      positionId === undefined ? getPositionByTemplate(templateId ?? '') : getPosition(positionId),
    enabled: (positionId ?? templateId ?? '') !== '',
  })

  const invalidate = (): void => {
    void client.invalidateQueries({ queryKey: ['matter', id] })
  }

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
    // 发出去就清空（一次运行可能要跑几分钟，请求一直挂着）；没发成再放回框里
    onMutate: () => {
      setText('')
      setTimeout(invalidate, 300)
    },
    onError: (_err, value) => {
      setText((now) => (now === '' ? value : now))
    },
    onSettled: () => {
      invalidate()
      void client.invalidateQueries({ queryKey: RAIL_KEY })
    },
  })
  const retitle = useMutation({
    mutationFn: (title: string) => retitleMatter(id, title),
    onSettled: () => {
      invalidate()
      void client.invalidateQueries({ queryKey: RAIL_KEY })
    },
  })
  // 页头换职责：只换，不重跑（之后起的运行走新职责）
  const reroute = useMutation({
    mutationFn: (role_id: string) => rerouteMatter(id, role_id),
    onSettled: invalidate,
  })
  // WP237：时间线上「走 X / 换成 X」——改派并重跑
  const route = useMutation({
    mutationFn: (role_id: string) => rerouteMatter(id, role_id, { run: true }),
    onSettled: invalidate,
  })
  const close = useMutation({
    mutationFn: (unfinished: 'close_all' | 'keep') => closeMatter(id, unfinished),
    onSettled: () => {
      setClosing(false)
      invalidate()
      void client.invalidateQueries({ queryKey: ['todos'] })
    },
  })
  const check = useMutation({
    mutationFn: (todoId: string) => completeTodo(todoId),
    onSettled: () => {
      invalidate()
      void client.invalidateQueries({ queryKey: ['todos'] })
    },
  })
  const stop = useMutation({ mutationFn: () => stopMatterRuns(id), onSettled: invalidate })

  // 时间线上内嵌的卡（审批 / 选择）：按这件事那条分配取，批也用它
  const timeline = more.data?.events ?? view?.timeline ?? []
  const cardIds = [
    ...new Set(
      timeline.flatMap((e) =>
        e.kind === 'card' && e.approval_item_id !== undefined ? [e.approval_item_id] : [],
      ),
    ),
  ]
  const cardQueries = useQueries({
    queries: cardIds.map((cid) => ({
      queryKey: ['approval', cid, positionId ?? ''],
      queryFn: () => getApproval(cid, positionId),
      retry: false,
      enabled: view !== undefined,
    })),
  })
  const cards = new Map<string, { card?: DeckCard; loading: boolean }>()
  cardIds.forEach((cid, i) => {
    const q = cardQueries[i]
    const item = q?.data
    cards.set(cid, {
      loading: q?.isPending === true && q.fetchStatus !== 'idle',
      ...(item === undefined
        ? {}
        : {
            card: projectCard(item, {
              now: new Date().toISOString(),
              position_id: positionId ?? '',
            }),
          }),
    })
  })
  const decideCard = useMutation({
    mutationFn: (input: {
      card: DeckCard
      action: Exclude<DeckAction, 'open'>
      option?: string | undefined
    }) =>
      decide(
        input.card.id,
        {
          action: input.action,
          version: input.card.version,
          ...(input.option === undefined ? {} : { selected_option_id: input.option }),
        },
        positionId ?? input.card.position_id,
      ),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
      invalidate()
    },
  })

  const live = view?.live
  const running = live !== undefined || say.isPending
  polling.current = running
  const closed = view?.matter.status === 'closed'

  const items = useMemo(
    () => buildItems(timeline, { live, roleId: view?.matter.role_id, closed }),
    [timeline, live, view?.matter.role_id, closed],
  )
  const waitingCards = [...cards.values()]
    .map((c) => c.card)
    .filter((c): c is DeckCard => cardWaiting(c))

  // 排队的那句：这一轮跑完就发（设计稿：运行中发出去排在这一轮后面）
  useEffect(() => {
    if (queued === undefined || running) return
    setQueued(undefined)
    say.mutate(queued)
  }, [queued, running, say])

  if (matter.isPending) return <Skeleton className="h-64 w-full" />
  if (matter.error !== null || view === undefined)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{matter.error?.message}
      </p>
    )

  const hasMore = more.data?.has_more ?? view.has_more
  const resumableId = closed ? undefined : resumableOf(timeline)
  const roles = position.data?.roles ?? []
  const roleNameOf = (role_id: string): string | undefined =>
    roles.find((r) => r.role_id === role_id)?.role_name
  const roleId = view.matter.role_id
  const roleName = (roleId === undefined ? undefined : roleNameOf(roleId)) ?? 'AI'
  const duties: DutyOption[] = roles.map((r) => ({
    role_id: r.role_id,
    role_name: r.role_name,
    mine: r.my_assignment_id !== undefined || r.assignment_ids.length > 0,
  }))
  const awaiting =
    railState === 'awaiting' || view.open_card_ids.length > 0 || waitingCards.length > 0
  const state = matterState({
    closed,
    running: running || railState === 'running',
    awaiting,
    timeline,
  })
  const firstWaiting = waitingCards[waitingCards.length - 1]
  const suggestion = suggestionFor({
    items,
    busy: running || queued !== undefined,
    blockedSay: t('matter.blocked.say'),
    cardAction:
      firstWaiting === undefined ? undefined : deckActionLabel(firstWaiting, 'approve', t),
  })
  const blockedArchive = archiveBlock(
    running || railState === 'running' ? 'running' : awaiting ? 'awaiting' : undefined,
  )
  const last = view.matter.context.last_activity
  const lastActivity =
    dayKey(last) === dayKey(new Date().toISOString())
      ? clockOf(last, lang)
      : formatDateTime(last, lang)

  const send = (): void => {
    const value = text.trim()
    if (value === '') return
    if (privateMode) {
      askSeq.current += 1
      const ask: PrivateAsk = { id: askSeq.current, question: value }
      setAsks((xs) => [...xs, ask])
      setText('')
      askAi({ scope: { matter_id: id }, question: value })
        .then((res) => {
          setAsks((xs) => xs.map((x) => (x.id === ask.id ? { ...x, answer: res.answer } : x)))
        })
        .catch((err: unknown) => {
          const error = err instanceof Error ? err.message : String(err)
          setAsks((xs) => xs.map((x) => (x.id === ask.id ? { ...x, error } : x)))
        })
      return
    }
    if (running) {
      setQueued(value)
      setText('')
      return
    }
    say.mutate(value)
  }

  const resumeProps = (eventId: string | undefined) =>
    eventId !== undefined && eventId === resumableId
      ? {
          onResume: () => {
            say.mutate(t('matter.resume.brief'))
          },
          resuming: say.isPending,
        }
      : {}

  const renderItem = (item: (typeof items)[number]): ReactNode => {
    switch (item.kind) {
      case 'day':
        return <DaySep key={item.key} at={item.at} />
      case 'me':
        return <MeBubble key={item.key} event={item.event} />
      case 'ai':
        return (
          <AiEntry
            key={item.key}
            item={item}
            roleId={roleId}
            roleName={roleName}
            onOpenPreview={openExternal}
            {...(closed || running
              ? {}
              : {
                  onPublish: () => {
                    say.mutate(t('matter.preview.publish'))
                  },
                  publishing: say.isPending,
                })}
            {...resumeProps(item.event?.id)}
          />
        )
      case 'sys':
        return (
          <SysLine
            key={item.key}
            item={item}
            roleName={roleNameOf}
            currentRole={roleId}
            {...(closed
              ? {}
              : {
                  onRoute: (role_id: string) => {
                    route.mutate(role_id)
                  },
                  routing: route.isPending,
                })}
            {...resumeProps(item.event.id)}
          />
        )
      case 'card': {
        const hit = cards.get(item.event.approval_item_id ?? '')
        return (
          <InlineCard
            key={item.key}
            event={item.event}
            card={hit?.card}
            loading={hit?.loading ?? false}
            roleId={roleId}
            roleName={roleName}
            deciding={decideCard.isPending}
            onDecide={(card, action, option) => {
              decideCard.mutate({ card, action, option })
            }}
          />
        )
      }
      case 'choice':
        return (
          <ChoiceCard
            key={item.key}
            event={item.event}
            routing={route.isPending}
            onRoute={(role_id) => {
              route.mutate(role_id)
            }}
          />
        )
      case 'blocked':
        return (
          <BlockedCard
            key={item.key}
            event={item.event}
            roleId={roleId}
            roleName={roleName}
            going={say.isPending}
            onConnect={() => {
              void navigate('/connections')
            }}
            onGo={() => {
              say.mutate(t('matter.blocked.say'))
            }}
          />
        )
    }
  }

  return (
    <div
      className="mx-auto flex min-h-full w-full max-w-[760px] flex-col"
      data-testid="matter"
      data-matter={view.matter.id}
    >
      <MatterHeader
        title={view.matter.title}
        roleId={roleId}
        roleName={roleId === undefined ? undefined : roleNameOf(roleId)}
        duties={duties}
        rerouting={reroute.isPending}
        onReroute={(role_id) => {
          reroute.mutate(role_id)
        }}
        state={state}
        people={view.participant_labels}
        lastActivity={lastActivity}
        todos={view.todos}
        onCheckTodo={(todoId) => {
          check.mutate(todoId)
        }}
        pinned={view.pinned_labels.map((p) => ({
          key: `${p.ref.type}:${p.ref.id}`,
          label: p.label,
        }))}
        canArchive={!closed && view.matter.archived_at === undefined}
        archiveWhy={blockedArchive}
        onArchive={() => {
          archive.mutate()
        }}
        canClose={!closed}
        onClose={() => {
          const unfinished = view.todos.some((x) => x.status !== 'done' && x.status !== 'dropped')
          if (unfinished) setClosing(true)
          else close.mutate('keep')
        }}
        onRetitle={(title) => {
          retitle.mutate(title)
        }}
      />

      {/* WP207：归档的事照样能看；一句话 + 一个「放回左栏」 */}
      {view.matter.archived_at === undefined ? null : (
        <div
          className="mt-3 flex flex-wrap items-center gap-2 rounded-[10px] bg-ws-tint/60 px-3 py-2 text-[13px]"
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

      {closing ? (
        <div
          className="mt-3 rounded-xl border border-ws-line bg-ws-card p-3 text-sm"
          role="dialog"
          aria-label={t('matter.close')}
          data-testid="close-dialog"
        >
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

      <section className="flex flex-1 flex-col gap-5 pt-5 pb-7" aria-label={t('matter.timeline')}>
        {hasMore ? (
          <Button
            size="xs"
            variant="ghost"
            className="self-center"
            onClick={() => {
              setLimit((v) => v + 20)
            }}
          >
            {t('matter.more')}
          </Button>
        ) : null}
        {items.map(renderItem)}
        {queued === undefined ? null : (
          <MeBubble
            queued
            event={{
              id: 'queued',
              matter_id: id,
              at: new Date().toISOString(),
              kind: 'human_message',
              text: queued,
              actor: { kind: 'person', id: 'me' },
            }}
          />
        )}
        {running ? <RunningEntry live={live} roleId={roleId} roleName={roleName} /> : null}
        {asks.map((a) => (
          <PrivatePair
            key={a.id}
            question={a.question}
            answer={a.answer}
            error={a.error}
            onClose={() => {
              setAsks((xs) => xs.filter((x) => x.id !== a.id))
            }}
            onForward={() => {
              setAsks((xs) => xs.filter((x) => x.id !== a.id))
              setPrivateMode(false)
              if (running) setQueued(a.question)
              else say.mutate(a.question)
            }}
          />
        ))}
        {closed ? (
          <div
            className="flex items-center justify-center gap-2 text-[12.5px] text-ws-muted-fg"
            data-testid="matter-closed-line"
          >
            <CircleCheck aria-hidden className="size-3.5 text-ws-good" />
            {t('matter.closed')}
          </div>
        ) : null}
      </section>

      <MatterComposer
        value={text}
        onChange={setText}
        onSend={send}
        onStop={() => {
          stop.mutate()
        }}
        running={running}
        closed={closed}
        privateMode={privateMode}
        onTogglePrivate={() => {
          setPrivateMode((v) => !v)
        }}
        suggestion={suggestion}
        sending={false}
      />
      {say.error === null ? null : (
        <p role="alert" className="text-center text-[12.5px] text-destructive">
          {say.error.message}
        </p>
      )}
    </div>
  )
}
