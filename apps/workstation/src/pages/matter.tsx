/**
 * 事项页（37 §2.2b）：**唯一的上下文容器**。
 *
 * WP264（决策 177–184，设计稿 docs/design/matter/）改成像 Claude 的对话页：
 * - 页头一行：AI 起的短标题（点了改）+ 一行灰字（职责 · 状态 · 参与者 · 最近活动 · 有才出的待办），「⋯」收其余；吸顶。
 * - 对话式时间线：你说的在右、AI 在左；结果 / 审批 / 选择 / 卡住是能直接点的卡；过程事件缩成居中一行灰字（默认收起）；
 *   正在跑的那次在最底下「正在做…」+ 当前一步。
 * - 底部输入卡：卡内圆形发送（运行中变「停」）、Tab 收建议。WP412（决策 1221）：「私聊 AI」开关去掉。
 *
 * 底部这个输入框是**对话入口的第四处**，也是唯一有边界的一处：作用域是这个事项、角色是这个岗位的 Agent。
 */
import { isConnectRequestPayload } from '@agentsws/contracts'
import { type DeckAction, type DeckCard, projectCard } from '@agentsws/deck'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, CircleCheck } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { GenuiHostProvider } from '@/components/answer/genui/genui-host'
import { AskSuggestions, useComposerRefs } from '@/components/ask-ai/composer-refs'
import { openExternal } from '@/components/connections/bridge'
import { deckActionLabel } from '@/components/deck/deck-action-bar'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import { ModelSwitchDivider } from '@/components/free-chat/thread-bits'
import { ImageCard, isImageCard } from '@/components/matter/image-pick-card'
import { MaskDialog } from '@/components/matter/mask-dialog'
import { MatterComposer } from '@/components/matter/matter-composer'
import { type DutyOption, MatterHeader } from '@/components/matter/matter-header'
import {
  awaitingReply,
  buildItems,
  dayKey,
  matterState,
  resumableOf,
  retryableFailure,
  suggestionFor,
  waitingOnOf,
} from '@/components/matter/matter-model'
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
import { useAttachedDocs } from '@/components/matter/use-attached-docs'
import { HandoffDialog } from '@/components/peers/handoff-dialog'
import { MatterHandoffBar } from '@/components/peers/handoff-strip'
import { isSetupCard } from '@/components/setup/setup-deck-body'
import { useOpenConnect } from '@/components/setup/use-open-connect'
import { ComposerDock, DOCK_PAGE } from '@/components/shell/composer-dock'
import { RAIL_FETCH } from '@/components/sidebar/duty-threads'
import { archiveBlock } from '@/components/sidebar/matter-menu'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { isServiceCard } from '@/components/workshop-services/service-card-body'
import {
  BRAND_ASSET_MAX_BYTES,
  type ContextRefInput,
  closeMatter,
  completeTodo,
  decide,
  ensureSession,
  getApproval,
  getMatter,
  getMatterTimeline,
  getPosition,
  getPositionByTemplate,
  getPositions,
  postMatterMessage,
  promoteAskMatter,
  rerouteMatter,
  retitleMatter,
  retryMatterRun,
  setMatterModel,
  stopMatterRuns,
  uploadBrandAsset,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { formatDateTime } from '@/lib/format'
import type { FreeChatFile, ReasoningEffort } from '@/lib/free-chat'
import { useMode } from '@/lib/mode'
import { assignmentForPosition, myAssignments } from '@/lib/positions'
import { useTelemetryContext } from '@/lib/telemetry/context'
import { cn } from '@/lib/utils'
import {
  archiveMatter,
  getWorkRail,
  markMatterSeen,
  RAIL_KEY,
  unarchiveMatter,
} from '@/lib/work-archive'

/** 在跑 / 刚发出去时多久拉一次（「正在做…」的当前一步跟着走）。 */
const POLL_MS = 1500

/** WP357：说的一句（带不带附上的资料）。 */
type Said =
  | string
  | { text: string; files: FreeChatFile[]; context?: ContextRefInput[] | undefined }
const names = (files: readonly { name: string }[]): string =>
  files.map((f) => `「${f.name}」`).join('')

export function MatterPage(): ReactNode {
  const { t, lang, selectPosition, position: current } = useApp()
  const client = useQueryClient()
  const openConnect = useOpenConnect()
  const params = useParams()
  const id = params.id ?? ''
  const [text, setText] = useState('')
  /** WP504（决策 1775 A）：第三栏点 ✦ 的卡落在这个框里（引用小卡、建议问题、`@`、拖进来）。 */
  const askArea = useRef<HTMLTextAreaElement>(null)
  const asked = useComposerRefs({ area: askArea, onChange: setText })
  const [limit, setLimit] = useState(20)
  const [closing, setClosing] = useState(false)
  // WP276：「交给同事」（⋯ 菜单或 ⌘K 带 `?handoff=1` 进来时打开）
  const [search, setSearch] = useSearchParams()
  const [handingOff, setHandingOff] = useState(search.get('handoff') === '1')
  // 已经在这件事里时从 ⌘K 选「交给同事…」：同一页只换了查询串
  const wantsHandoff = search.get('handoff') === '1'
  useEffect(() => {
    if (wantsHandoff) setHandingOff(true)
  }, [wantsHandoff])
  const { mode } = useMode()
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  const me = session.data?.person.id
  // WP268：事项里加进来的图（已进素材库，发话时带上 id）
  const [attached, setAttached] = useState<
    { id: string; url: string; mask?: string | undefined }[]
  >([])
  const [attaching, setAttaching] = useState(false)
  // WP283（决策 300）：现在的改图型号认遮罩才给「圈区域」（传图时服务端顺带回 `edit_mask`）
  const [canMask, setCanMask] = useState(false)
  const [masking, setMasking] = useState<string | undefined>(undefined)
  const [savingMask, setSavingMask] = useState(false)
  const [queued, setQueued] = useState<string | undefined>(undefined)
  /** WP357：排队那句附上的资料（这一轮跑完一起发）。 */
  const [queuedFiles, setQueuedFiles] = useState<FreeChatFile[]>([])
  /** WP357：这一句要附上的资料。 */
  const docs = useAttachedDocs()
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
  // WP477：这件事挂在哪个岗位、哪条职责
  useTelemetryContext(
    view === undefined
      ? undefined
      : {
          ...(templateId === undefined ? {} : { position_template: templateId }),
          role_id: view.matter.role_id,
        },
  )
  /*
   * WP456-T3：直接打开一件事项（链接、搜索、刷新）时，把当前岗位切到这件事所在的岗位——看板（对话 / 计划 / 报表 /
   * 清单卡）跟着当前岗位走，不切就是一列「先选一个岗位」。只认本人在那个岗位里有分配的；同一个岗位里已经对了就不动。
   */
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  useEffect(() => {
    const instances = mine.data?.instances
    if (positionId === undefined || instances === undefined) return
    if (!instances.some((p) => myAssignments(p).includes(positionId))) return
    const next = assignmentForPosition(instances, positionId, current)
    if (next !== current) selectPosition(next)
  }, [positionId, mine.data?.instances, current, selectPosition])
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

  /** WP342（决策 853）：换这件事用的 AI（只这一件；之后接着跑仍用它）。 */
  const pickModel = useMutation({
    mutationFn: (model: string) => setMatterModel(id, model),
    onSuccess: invalidate,
  })
  /** WP370：调思考程度（连同当前模型一起存在这件事上）。 */
  const pickEffort = useMutation({
    mutationFn: (input: { model: string; effort: ReasoningEffort }) =>
      setMatterModel(id, input.model, input.effort),
    onSuccess: invalidate,
  })

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
    // WP357：可以带着附上的资料（base64；服务端按助理那套读成文字）
    mutationFn: (value: Said) =>
      typeof value === 'string'
        ? postMatterMessage(id, value)
        : postMatterMessage(
            id,
            value.text,
            value.files.map((f) => ({ name: f.name, data: f.data })),
            value.context,
          ),
    // 发出去就清空（一次运行可能要跑几分钟，请求一直挂着）；没发成再放回框里
    onMutate: () => {
      setText('')
      setTimeout(invalidate, 300)
    },
    onError: (_err, value) => {
      const back = typeof value === 'string' ? value : value.text
      setText((now) => (now === '' ? back : now))
      if (typeof value !== 'string') docs.restore(value.files)
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
  // WP287：「没跑成」下面的「重试」——按原话再跑一次
  const retry = useMutation({
    mutationFn: () => retryMatterRun(id),
    onMutate: () => {
      setTimeout(invalidate, 300)
    },
    onSettled: invalidate,
  })
  // WP287：会话「转成任务」（进岗位「工作」）
  const promote = useMutation({
    mutationFn: () => promoteAskMatter(id),
    onSettled: () => {
      invalidate()
      void client.invalidateQueries({ queryKey: ['position-work'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
    },
  })

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
      /** WP268：「都不要 / 不出了」也是一次驳回，原因就是按钮上那句。 */
      reason?: string | undefined
    }) =>
      decide(
        input.card.id,
        {
          action: input.action,
          version: input.card.version,
          ...(input.option === undefined ? {} : { selected_option_id: input.option }),
          ...(input.reason === undefined ? {} : { reason: input.reason }),
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
  const running = live !== undefined || say.isPending || retry.isPending
  // WP287：刚从岗位输入框发过来、运行还没登记上——接着拉，回答在线程里出现
  polling.current = running || awaitingReply(timeline, Date.now())
  const closed = view?.matter.status === 'closed'
  /** WP276：能交给同事——不是一个人用、事项是我的（参与者第一位）、没关、没在交。 */
  const canHandOff =
    mode !== 'solo' &&
    !closed &&
    me !== undefined &&
    view?.matter.context.participants[0] === me &&
    view.matter.handoff?.state !== 'offered'

  const items = useMemo(
    () =>
      buildItems(timeline, {
        live,
        roleId: view?.matter.role_id,
        closed,
        ask: view?.matter.ask !== undefined,
      }),
    [timeline, live, view?.matter.role_id, closed, view?.matter.ask],
  )
  const waitingCards = [...cards.values()]
    .map((c) => c.card)
    .filter((c): c is DeckCard => cardWaiting(c))

  // 排队的那句：这一轮跑完就发（设计稿：运行中发出去排在这一轮后面）
  useEffect(() => {
    if (queued === undefined || running) return
    setQueued(undefined)
    // WP357：排队的那句带着资料的，资料一起发
    // WP504：排队时框里还挂着引用的卡，一起发
    const context = asked.payload()
    if (queuedFiles.length > 0 || context !== undefined) {
      setQueuedFiles([])
      asked.clear()
      say.mutate({ text: queued, files: queuedFiles, context })
      return
    }
    say.mutate(queued)
  }, [queued, queuedFiles, running, say, asked])

  if (matter.isPending) return <Skeleton className="h-64 w-full" />
  if (matter.error !== null || view === undefined)
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{matter.error?.message}
      </p>
    )

  const hasMore = more.data?.has_more ?? view.has_more
  const resumable = closed ? undefined : resumableOf(timeline)
  const retryId = closed ? undefined : retryableFailure(timeline)
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
    // WP423：只差连插件 / 填设置时不写「等你批」
    waitingOn: waitingOnOf(
      waitingCards.map((c) => ({
        connect: isConnectRequestPayload(c.detail.payload),
        setup: isSetupCard(c) && !isConnectRequestPayload(c.detail.payload),
      })),
      view.open_card_ids.length,
    ),
  })
  const firstWaiting = waitingCards[waitingCards.length - 1]
  const suggestion = suggestionFor({
    items,
    busy: running || queued !== undefined,
    blockedSay: t('matter.blocked.say'),
    // WP268：挑图卡要点一张图，不是说一句「就这张」——不给建议
    // WP324：连接卡 / 配置卡要在卡上连 / 填，说一句「接着做」没用——也不给
    // WP390：工坊服务卡（下单 / 验收 / 联系方式）只在卡上点——花钱的事不靠说一句
    cardAction:
      firstWaiting === undefined ||
      isImageCard(firstWaiting) ||
      isSetupCard(firstWaiting) ||
      isServiceCard(firstWaiting)
        ? undefined
        : deckActionLabel(firstWaiting, 'approve', t),
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
    const typed = text.trim()
    // WP268：加进来的图已经在素材库里了，话里带上它们的 id（AI 用 list_brand_assets / edit_image 拿得到）
    const note =
      attached.length === 0
        ? ''
        : [
            t('matter.cmp.attach.note', {
              n: attached.length,
              ids: attached.map((a) => a.id).join('、'),
            }),
            // WP283：圈了区域的那几张，告诉 AI 改图时带上遮罩
            ...attached.flatMap((a) =>
              a.mask === undefined
                ? []
                : [t('matter.cmp.attach.mask_note', { id: a.id, mask: a.mask })],
            ),
          ].join('')
    const value = [typed, note].filter((x) => x !== '').join('\n\n')
    // WP357：附上的资料
    const files = docs.docs
    if (value === '' && files.length === 0) return
    setAttached([])
    // WP504（决策 1775 A）：第三栏「问 AI」引用的卡随这句话交出去（运行中先排着，跟排队那句一起发）
    const context = running ? undefined : asked.payload()
    if (context !== undefined) {
      asked.clear()
      say.mutate({ text: value, files: files.length > 0 ? docs.take() : [], context })
      return
    }
    if (files.length > 0) {
      const said: Said = { text: value, files: docs.take() }
      if (running) {
        setQueuedFiles(said.files)
        setQueued(value === '' ? t('matter.file.only', { names: names(said.files) }) : value)
        setText('')
        return
      }
      say.mutate(said)
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
    eventId !== undefined && eventId === resumable?.id
      ? {
          onResume: () => {
            say.mutate(t('matter.resume.brief'))
          },
          resuming: say.isPending,
          // WP423：预算停的那次写「接着做」
          ...(resumable.budget ? { resumeLabel: t('matter.resume.go') } : {}),
        }
      : {}

  const renderItem = (item: (typeof items)[number]): ReactNode => {
    switch (item.kind) {
      case 'day':
        return <DaySep key={item.key} at={item.at} />
      // WP373（决策 978）：真换了模型那一句
      case 'switch':
        return <ModelSwitchDivider key={item.key} from={{ id: item.from }} to={{ id: item.to }} />
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
            {...(item.event.id === retryId
              ? {
                  onRetry: () => {
                    retry.mutate()
                  },
                  retrying: retry.isPending || running,
                }
              : {})}
          />
        )
      case 'card': {
        const hit = cards.get(item.event.approval_item_id ?? '')
        // WP268：挑图卡 / 生图超额卡（图并排、选一张 / 再来一版 / 都不要）
        if (hit?.card !== undefined && isImageCard(hit.card))
          return (
            <ImageCard
              key={item.key}
              at={item.event.at}
              eventId={item.event.id}
              card={hit.card}
              roleId={roleId}
              roleName={roleName}
              deciding={decideCard.isPending}
              onDecide={(card, action, option, reason) => {
                decideCard.mutate({ card, action, option, reason })
              }}
            />
          )
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
              // WP324：在第三栏就地连（认得出缺哪几样时）；认不出才去连接页
              openConnect(item.event.blocked?.services)
            }}
            onGo={() => {
              say.mutate(t('matter.blocked.say'))
            }}
          />
        )
    }
  }

  /**
   * WP341（决策 847）：回话里的按钮 / 表单点了、交了 = 在这里说了一句（正在跑就排在后面）；工具按钮走工具执行器，
   * 出的卡挂进这条时间线（下面就地批，卡片流里同一张）。事项关了就只看不点。
   */
  const genuiHost = {
    ...(closed
      ? {}
      : {
          say: (value: string) => {
            if (running) setQueued(value)
            else say.mutate(value)
          },
        }),
    matterId: id,
    onToolDone: () => {
      invalidate()
      void client.invalidateQueries({ queryKey: ['approval'] })
      void client.invalidateQueries({ queryKey: ['deck'] })
      void client.invalidateQueries({ queryKey: RAIL_KEY })
    },
  }

  return (
    <GenuiHostProvider value={genuiHost}>
      <div
        className={cn(DOCK_PAGE, 'mx-auto w-full max-w-[760px]')}
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
          onHandOff={
            canHandOff
              ? () => {
                  setHandingOff(true)
                }
              : undefined
          }
          /*
           * WP287：岗位里问的一句是一段会话（不进「工作」）；要接着跟进就转成任务。
           * WP288：会话页头不出状态与职责；「转成任务」在「⋯」里（不再单独一排「会话 · 转成任务」）。
           */
          ask={view.matter.ask !== undefined}
          onPromote={
            view.matter.ask === undefined
              ? undefined
              : () => {
                  promote.mutate()
                }
          }
          promoting={promote.isPending}
        />
        {/* WP276：等 Y 接 · 撤回 / X 想把这件事交给你 · 接下 · 不接（一个人用时没有） */}
        {mode === 'solo' ? null : <MatterHandoffBar matterId={view.matter.id} me={me} />}
        {canHandOff ? (
          <HandoffDialog
            kind="matter"
            id={view.matter.id}
            title={view.matter.title}
            open={handingOff}
            onOpenChange={(open) => {
              setHandingOff(open)
              if (!open && search.get('handoff') !== null) {
                const next = new URLSearchParams(search)
                next.delete('handoff')
                setSearch(next, { replace: true })
              }
            }}
          />
        ) : null}

        {/* WP207：归档的事照样能看；一句话 + 一个「放回左栏」 */}
        {view.matter.archived_at === undefined ? null : (
          <div
            className="mt-3 flex flex-wrap items-center gap-2 rounded-lg bg-ws-tint/60 px-3 py-2 text-[13px]"
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
          {closed ? (
            <div
              className="flex items-center justify-center gap-2 text-[13px] text-ws-muted-fg"
              data-testid="matter-closed-line"
            >
              <CircleCheck aria-hidden className="size-3.5 text-ws-good" />
              {t('matter.closed')}
            </div>
          ) : null}
        </section>

        {/* WP437：完整对话框在中栏底部居中、悬浮在内容之上（与岗位 / 职责页同一个底座） */}
        <ComposerDock
          testId="matter-dock"
          above={
            <>
              {/* WP504：有引用时框上面出按这几张卡的建议问题（点了直接问） */}
              <AskSuggestions
                items={asked.suggestions}
                onPick={(q) => {
                  const context = asked.payload()
                  asked.clear()
                  say.mutate({ text: q, files: [], context })
                }}
              />
              {say.error === null ? null : (
                <p role="alert" className="text-center text-[13px] text-destructive">
                  {say.error.message}
                </p>
              )}
            </>
          }
        >
          <MatterComposer
            docked={false}
            value={text}
            onChange={asked.onChange}
            askTarget
            areaRef={askArea}
            chips={asked.chips}
            overlay={asked.overlay}
            onKeyDownFirst={asked.onKeyDownFirst}
            onRefDrop={asked.onRefDrop}
            onSend={send}
            onStop={() => {
              stop.mutate()
            }}
            running={running}
            closed={closed}
            suggestion={suggestion}
            sending={false}
            modelSlot={
              <ComposerModelPicker
                value={
                  (pickEffort.isPending ? pickEffort.variables?.model : undefined) ??
                  (pickModel.isError ? undefined : pickModel.variables) ??
                  view?.matter.model
                }
                onChange={(next) => {
                  pickModel.mutate(next)
                }}
                effort={
                  (pickEffort.isPending ? pickEffort.variables?.effort : undefined) ??
                  (pickModel.isPending ? undefined : view?.matter.model_effort)
                }
                onEffortChange={(effort, model) => {
                  pickEffort.mutate({ model, effort })
                }}
              />
            }
            attachments={attached.map((a) => ({
              id: a.id,
              url: a.url,
              masked: a.mask !== undefined,
            }))}
            attaching={attaching}
            onAttach={(files) => {
              setAttaching(true)
              void Promise.all(
                files
                  .filter((f) => f.size <= BRAND_ASSET_MAX_BYTES)
                  .map((f) => uploadBrandAsset(f, { matter_id: id })),
              )
                .then((rows) => {
                  setAttached((xs) => [
                    ...xs,
                    ...rows.map((r) => ({ id: r.asset.id, url: r.asset.file_url })),
                  ])
                  if (rows.length > 0) setCanMask(rows.every((r) => r.edit_mask === true))
                })
                .catch(() => undefined)
                .finally(() => {
                  setAttaching(false)
                })
            }}
            onDetach={(aid) => {
              setAttached((xs) => xs.filter((x) => x.id !== aid))
            }}
            {...(canMask ? { onMask: setMasking } : {})}
            // WP357：附资料（拖进来 / 「+」/ 粘贴文件），与助理同一套
            docs={docs.docs}
            onAttachDocs={docs.add}
            onDetachDoc={docs.remove}
            docProblem={docs.problem}
          />
        </ComposerDock>
        <MaskDialog
          src={attached.find((a) => a.id === masking)?.url}
          busy={savingMask}
          onClose={() => {
            setMasking(undefined)
          }}
          onSave={(file) => {
            const target = masking
            if (target === undefined) return
            setSavingMask(true)
            uploadBrandAsset(file, { matter_id: id, tags: ['mask'] })
              .then((r) => {
                setAttached((xs) =>
                  xs.map((x) => (x.id === target ? { ...x, mask: r.asset.id } : x)),
                )
                setMasking(undefined)
              })
              .catch(() => undefined)
              .finally(() => {
                setSavingMask(false)
              })
          }}
        />
      </div>
    </GenuiHostProvider>
  )
}
