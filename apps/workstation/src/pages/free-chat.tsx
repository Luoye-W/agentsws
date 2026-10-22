/**
 * WP188「随便聊」（Luoye 09-29：「得留一个入口，用户可以随便问一些问题，就像 DeepSeek 网页版一样」）。
 *
 * 左边会话列表，中间对话流，底部输入框。
 *
 * WP343（决策 334 / 859，Luoye 10-15）：改名「我的助理」，与「我的代理」合成一个入口（地址 `/assistant`，
 * 老的 `/free-chat`、`/secretary` 跳过来）。像 ChatGPT / Claude 网页那个对话框：
 * - 空状态一个标题 + 一行小字（可以随便聊，也可以直接交代事情）+ 最多 4 个快捷问题（按状态生成，开始对话后收起）；
 * - 问全局、派活都在对话里：交出去的事回复下面一行「已交给 X」，有结果 / 要拍板时这段对话里再报一句；
 * - 输入框里 `@` 选岗位 / 职责，直接交给它；
 * - 右上角「记忆」（助理这一层记的）与「替我答同事」（同事互联 / 公司模式才有）。
 *
 * WP350（决策 900）：能附会议记录 / 文档；助理拆出的「我打算这样分」方案卡就在回复里点（就这样 / 改一下 / 不用了），
 * 点完回复下面一张汇总；同一批派出去的事回来报的那几句聚在一起（标「来自「…」」）。
 *
 * WP352（决策 931，Luoye 10-16）：去掉左边会话列表，助理只有**一条连续对话**（老的多条会话第一次打开时按时间拼进来）。
 * 往上滚是完整历史：换了一天中间一行日期，换了话题一条淡线 + 上一个话题的一行小结；顶部搜索（搜以前聊过的原话与小结，
 * 点了跳到那里）；「换个话题」手动切段（说一句「换个话题…」也行）。上下文怎么管在服务端（四层，见 `assistant-thread.ts`）。
 *
 * WP456-T8（WP456 §3.7）：只改样子——输入框换成岗位页那一个完整对话框（贴在中栏底部居中），首屏只留
 * 「有什么要我做的？」（那一整句并进占位字），右上那几颗换成顶栏图标钮。上下文装配（WP470 的缓存顺序）一点没动。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import { GenuiHostProvider } from '@/components/answer/genui/genui-host'
import { BrandMark } from '@/components/design'
import { MemoryButton, PeersButton, Suggestions } from '@/components/free-chat/assistant-bits'
import { Composer, type ComposerToggles } from '@/components/free-chat/composer'
import { AssistantMessage, UserBubble } from '@/components/free-chat/message'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import { takePendingAsk } from '@/components/free-chat/pending-ask'
import {
  DayDivider,
  dayOf,
  HistorySearch,
  ModelSwitchDivider,
  modelSwitches,
  NewTopicButton,
  RecalledRefs,
  TopicDivider,
} from '@/components/free-chat/thread-bits'
import { ComposerDock } from '@/components/shell/composer-dock'
import { TopBarAction } from '@/components/shell/top-bar-slots'
import { useApp } from '@/lib/app-context'
import {
  type AssistantHistoryHit,
  type AssistantTarget,
  type AssistantThread,
  confirmFanout,
  createFreeChatSession,
  type FreeChatFanoutEdit,
  type FreeChatFile,
  type FreeChatFrame,
  type FreeChatImage,
  type FreeChatMessage,
  getAssistantState,
  getAssistantThread,
  getFreeChatModels,
  listFreeChatMessages,
  newAssistantTopic,
  type ReasoningEffort,
  stopFreeChat,
  streamFreeChat,
  undoFanoutNotes,
} from '@/lib/free-chat'
import { useMode } from '@/lib/mode'

const KEY = ['free-chat'] as const
/** WP343：「我的助理」的地址（老的 `/free-chat` 跳过来）。 */
export const ASSISTANT_PATH = '/assistant'
/** WP343：交出去的事还没回报完时，多久问一次这段对话（回报在服务端读会话时补上）。 */
export const REPORT_POLL_MS = 5000

/** 这段对话里还有交出去、还没报「做完 / 没做成」的事（要接着问）。 */
export function awaitingReport(rows: readonly FreeChatMessage[]): boolean {
  const closed = new Set(
    rows.flatMap((m) =>
      m.report !== undefined && m.report.kind !== 'decide' ? [m.report.matter_id] : [],
    ),
  )
  return rows.some((m) => (m.dispatches ?? []).some((d) => !closed.has(d.matter_id)))
}

/**
 * WP350：同一批派出去的事回来报的那几句聚在一起——把连着的、同一个批次的回报收成一段。
 * 其余的话一条一段。
 */
export function segmentsOf(
  rows: readonly FreeChatMessage[],
): { batch?: { id: string; title: string }; rows: FreeChatMessage[] }[] {
  const out: { batch?: { id: string; title: string }; rows: FreeChatMessage[] }[] = []
  for (const m of rows) {
    const batch = m.report?.batch_id
    const last = out.at(-1)
    if (batch !== undefined && last?.batch?.id === batch) last.rows.push(m)
    else if (batch !== undefined)
      out.push({ batch: { id: batch, title: m.report?.batch_title ?? '' }, rows: [m] })
    else out.push({ rows: [m] })
  }
  return out
}

interface Live {
  session_id: string
  user?: FreeChatMessage
  reply: FreeChatMessage
  status?: string
}

export function FreeChatPage(): React.ReactNode {
  const { id: legacyId } = useParams<{ id?: string }>()
  const { search } = useLocation()
  // WP352：只有一条对话——带会话 id 的老地址都回到 `/assistant`
  if (legacyId !== undefined) return <Navigate replace to={`${ASSISTANT_PATH}${search}`} />
  return <AssistantThreadPage />
}

function AssistantThreadPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [params, setParams] = useSearchParams()
  const { solo, known } = useMode()
  /** WP342（决策 853）：这条对话用的 AI（输入框左下角那个钮）；没选过就用上一条回答用的，再没有就是品牌默认。 */
  const [pick, setPick] = useState<string | undefined>(undefined)
  /** WP370：这段对话选的思考程度（换模型就清掉 = 回到那个模型的默认档）。 */
  const [effort, setEffort] = useState<ReasoningEffort | undefined>(undefined)
  const [toggles, setToggles] = useState<ComposerToggles>({ web_search: false, knowledge: false })
  const [live, setLive] = useState<Live | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  /** WP352：搜索 / 出处跳过来时亮一下的那条。 */
  const [lit, setLit] = useState<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | undefined>(undefined)

  const models = useQuery({ queryKey: [...KEY, 'models'], queryFn: getFreeChatModels })
  // WP352：那一条长对话（老服务进程没有就退回「第一句话时开一段会话」）
  const thread = useQuery({
    queryKey: [...KEY, 'thread'],
    queryFn: getAssistantThread,
    retry: false,
  })
  const [fallbackId, setFallbackId] = useState<string | undefined>(undefined)
  const id = thread.data?.session.id ?? fallbackId
  // WP343：快捷问题与 `@` 能选的岗位（老服务进程没有就当没有）
  const assistant = useQuery({
    queryKey: [...KEY, 'assistant'],
    queryFn: getAssistantState,
    retry: false,
  })
  const messages = useQuery({
    queryKey: [...KEY, 'messages', id],
    queryFn: () => listFreeChatMessages(id ?? ''),
    enabled: id !== undefined,
    // WP343：交出去的事还没回报完就隔几秒问一次（回报落在这段对话里）
    refetchInterval: (q) =>
      live === undefined && awaitingReport(q.state.data ?? []) ? REPORT_POLL_MS : false,
  })

  const choices = models.data?.choices ?? []
  const rows = id === undefined ? [] : (messages.data ?? [])
  const segs = thread.data?.segments ?? []
  // WP430：切过来源的那一轮按原来选的算（下一轮先试原选，不跟着切过去的那一条走）
  const lastMessage = [...rows].reverse().find((m) => m.model !== undefined)
  const lastUsed = lastMessage?.chosen_model ?? lastMessage?.model?.id
  const picked =
    pick ??
    (lastUsed !== undefined && choices.some((c) => c.id === lastUsed) ? lastUsed : undefined) ??
    models.data?.default ??
    choices[0]?.id
  const choice = choices.find((c) => c.id === picked)

  // 新的字进来就滚到底（跳到搜索命中时不滚）
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按"内容变了"滚
  useEffect(() => {
    const el = scroller.current
    if (el !== null && lit === undefined) el.scrollTop = el.scrollHeight
  }, [rows.length, live?.reply.text, live?.status])

  const refresh = (session_id: string): void => {
    void client.invalidateQueries({ queryKey: [...KEY, 'messages', session_id] })
    void client.invalidateQueries({ queryKey: [...KEY, 'thread'] })
  }

  /** WP352：换个话题（这段收起来，下一句开新的一段）。 */
  const topic = useMutation({
    mutationFn: newAssistantTopic,
    onSuccess: (view: AssistantThread) => {
      client.setQueryData([...KEY, 'thread'], view)
    },
  })
  // ⌘K「换个话题」进来（`?new=1`）：这段说过话就切一下，然后把参数拿掉
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在拿到对话后看一次
  useEffect(() => {
    if (params.get('new') !== '1' || thread.data === undefined || messages.data === undefined)
      return
    const current = segs.at(-1)
    if (current !== undefined && rows.some((m) => m.segment_id === current.id)) topic.mutate()
    const next = new URLSearchParams(params)
    next.delete('new')
    setParams(next, { replace: true })
  }, [thread.data === undefined, messages.data === undefined])

  /** WP352：跳到一条话（搜索命中 / 出处）；命中的是小结就跳到那段开头。 */
  const jump = (hit: AssistantHistoryHit): void => {
    const target =
      hit.message_id ?? rows.find((m) => (m.segment_id ?? segs[0]?.id) === hit.segment_id)?.id
    if (target === undefined) return
    setLit(target)
    requestAnimationFrame(() => {
      for (const el of document.querySelectorAll<HTMLElement>('[data-msg]'))
        if (el.dataset.msg === target) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
    setTimeout(() => setLit((cur) => (cur === target ? undefined : cur)), 2400)
  }

  const run = async (
    session_id: string,
    input:
      | { text: string; images: FreeChatImage[]; target?: AssistantTarget; files?: FreeChatFile[] }
      | { regenerate: true },
  ): Promise<void> => {
    setError(undefined)
    const controller = new AbortController()
    abort.current = controller
    const blank: FreeChatMessage = { id: 'live', session_id, role: 'assistant', text: '', at: '' }
    setLive({ session_id, reply: blank })
    const onFrame = (f: FreeChatFrame): void => {
      setLive((prev) => {
        if (prev === undefined) return prev
        if (f.type === 'start')
          return { ...prev, ...(f.user === undefined ? {} : { user: f.user }) }
        if (f.type === 'delta')
          return { ...prev, reply: { ...prev.reply, text: prev.reply.text + f.text } }
        if (f.type === 'searching')
          return { ...prev, status: t('free_chat.searching', { q: f.query }) }
        if (f.type === 'sources') return { ...prev, reply: { ...prev.reply, sources: f.sources } }
        // WP207：找回的候选卡（边答边出现；人点了才恢复）
        if (f.type === 'archived_candidates')
          return { ...prev, reply: { ...prev.reply, archived_candidates: f.candidates } }
        if (f.type === 'notice') return { ...prev, status: f.text }
        // WP343：交给了一个岗位（回复下面马上出那一行）
        if (f.type === 'dispatched')
          return {
            ...prev,
            reply: { ...prev.reply, dispatches: [...(prev.reply.dispatches ?? []), f.dispatch] },
          }
        // WP350：方案卡（边答边出现；点「就这样」要等这一轮答完）
        if (f.type === 'fanout') return { ...prev, reply: { ...prev.reply, fanout: f.fanout } }
        if (f.type === 'error') return { ...prev, reply: { ...prev.reply, error: f.message } }
        return prev
      })
      if (f.type === 'done') {
        client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', session_id], (old) => {
          const kept = (old ?? []).filter((m) => m.id !== f.message.id)
          return [...kept, f.message]
        })
      }
    }
    const opts = {
      ...(picked === undefined ? {} : { model: picked }),
      ...(picked === undefined || effort === undefined ? {} : { effort }),
      web_search: toggles.web_search,
      knowledge: toggles.knowledge,
    }
    try {
      if ('regenerate' in input) {
        // 先把上一条回复从屏上拿掉（服务端同样会删它）
        client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', session_id], (old) =>
          (old ?? []).filter((m, i, all) => !(i === all.length - 1 && m.role === 'assistant')),
        )
        await streamFreeChat(session_id, { regenerate: true, ...opts }, onFrame, controller.signal)
      } else {
        client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', session_id], (old) => [
          ...(old ?? []),
          {
            id: 'pending',
            session_id,
            role: 'user',
            text: input.text,
            at: '',
            images: input.images,
            ...(input.target === undefined ? {} : { to: input.target.label }),
            ...(input.files === undefined
              ? {}
              : { attachments: input.files.map((f) => ({ name: f.name, chars: 0 })) }),
          },
        ])
        await streamFreeChat(
          session_id,
          {
            text: input.text,
            ...(input.images.length === 0 ? {} : { images: input.images }),
            ...(input.target === undefined ? {} : { target: input.target }),
            ...(input.files === undefined
              ? {}
              : { files: input.files.map((f) => ({ name: f.name, data: f.data })) }),
            ...opts,
          },
          (f) => {
            if (f.type === 'start' && f.user !== undefined) {
              const user = f.user
              client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', session_id], (old) =>
                (old ?? []).map((m) => (m.id === 'pending' ? user : m)),
              )
            }
            onFrame(f)
          },
          controller.signal,
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      abort.current = undefined
      setLive(undefined)
      refresh(session_id)
      // 交了事 / 处理了卡之后快捷问题跟着变
      void client.invalidateQueries({ queryKey: [...KEY, 'assistant'] })
    }
  }

  const send = useMutation({
    mutationFn: async (input: {
      text: string
      images: FreeChatImage[]
      target?: AssistantTarget
      files?: FreeChatFile[]
    }) => {
      let session_id = id
      if (session_id === undefined) {
        // WP352：那条长对话还没拿到就再要一次；老服务进程没有长对话才退回开一段会话
        const made = await getAssistantThread()
          .then((v) => {
            client.setQueryData([...KEY, 'thread'], v)
            return v.session
          })
          .catch(() => createFreeChatSession())
        session_id = made.id
        if (thread.data === undefined) setFallbackId(made.id)
        client.setQueryData([...KEY, 'messages', made.id], [])
      }
      await run(session_id, input)
    },
  })

  /*
   * WP437：首页简易对话框交过来的那一句（和附上的资料）——拿到这条对话就发出去，只发一次。
   * 之后照助理原来的逻辑：能答就答，要做的事交给岗位（「已交给 X」）。
   */
  const askReady = thread.isFetched && (id === undefined || messages.data !== undefined)
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只在对话拿到的那一下看一次
  useEffect(() => {
    if (!askReady) return
    const ask = takePendingAsk()
    if (ask === undefined) return
    send.mutate({
      text: ask.text,
      images: [],
      ...(ask.files.length === 0 ? {} : { files: ask.files }),
    })
  }, [askReady])

  const stop = (): void => {
    const session_id = live?.session_id
    if (session_id === undefined) return
    // 先请服务端停（它会把已经答出来的部分存好、再推一帧 done）；请不动就直接断开
    stopFreeChat(session_id).catch(() => abort.current?.abort())
  }

  const busy = live !== undefined

  /** WP350：方案卡上点了「就这样」/「不用了」→ 换上点过的那张、接上汇总。 */
  const fanout = async (
    batch_id: string,
    body: { items?: FreeChatFanoutEdit[]; dismiss?: boolean },
  ): Promise<void> => {
    if (id === undefined) return
    setError(undefined)
    try {
      const out = await confirmFanout(id, batch_id, body)
      client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', id], (old) => {
        const next = (old ?? []).map((m) => (m.id === out.plan.id ? out.plan : m))
        return out.summary === undefined ? next : [...next, out.summary]
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      refresh(id)
      void client.invalidateQueries({ queryKey: [...KEY, 'assistant'] })
    }
  }
  /** WP357（决策 902）：汇总卡上「撤销」→ 换上撤过的那条汇总、知识库刷新。 */
  const undoNotes = async (batch_id: string): Promise<void> => {
    if (id === undefined) return
    setError(undefined)
    try {
      const out = await undoFanoutNotes(id, batch_id)
      client.setQueryData<FreeChatMessage[]>([...KEY, 'messages', id], (old) =>
        (old ?? []).map((m) => (m.id === out.summary.id ? out.summary : m)),
      )
      void client.invalidateQueries({ queryKey: ['knowledge', 'cards'] })
      void client.invalidateQueries({ queryKey: ['knowledge-cards'] })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const lastAssistant = [...rows].reverse().find((m) => m.role === 'assistant')

  const composer = (
    <Composer
      busy={busy}
      canSeeImages={choice?.vision !== 'no'}
      toggles={toggles}
      {...(models.data?.web_search.available === false &&
      models.data.web_search.reason !== undefined
        ? { webReason: models.data.web_search.reason }
        : {})}
      knowledgeAvailable={models.data?.knowledge.available ?? false}
      onToggles={setToggles}
      onSend={(text, images, target, files) => {
        send.mutate({
          text,
          images,
          ...(target === undefined ? {} : { target }),
          ...(files === undefined ? {} : { files }),
        })
      }}
      onStop={stop}
      placeholder={t('assistant.placeholder')}
      {...(assistant.data === undefined ? {} : { targets: assistant.data.targets })}
      modelSlot={
        <ComposerModelPicker
          value={picked}
          onChange={(next) => {
            setPick(next)
            setEffort(undefined)
          }}
          effort={effort}
          onEffortChange={(next, model) => {
            setPick(model)
            setEffort(next)
          }}
          testId="free-chat-model"
        />
      }
    />
  )
  const memoryLit = (params.get('memory') ?? '').split(',').filter((x) => x !== '')
  const segById = new Map(segs.map((g) => [g.id, g]))
  // WP373（决策 978）：真换了模型的那几处插一句「上面是 X 答的，接下来用 Y」
  const switches = modelSwitches(rows)
  const segOf = (m: FreeChatMessage): string | undefined => m.segment_id ?? segs[0]?.id
  /** 这段话题说过话了（「换个话题」才出）。 */
  const current = segs.at(-1)
  const currentHasTalk = current?.current && rows.some((m) => segOf(m) === current.id)
  const empty = rows.length === 0 && live === undefined

  /** WP352：一条话前面要不要先画日期 / 话题分隔（和上一条比）。 */
  const dividers = (m: FreeChatMessage, prev: FreeChatMessage | undefined): React.ReactNode => {
    const day = prev === undefined || (m.at !== '' && dayOf(m.at) !== dayOf(prev.at))
    const seg = segOf(m)
    const prevSeg = prev === undefined ? undefined : segOf(prev)
    const topic =
      prev !== undefined && seg !== undefined && prevSeg !== undefined && seg !== prevSeg
    const switched = switches.get(m.id)
    return (
      <>
        {topic ? <TopicDivider previous={segById.get(prevSeg)} /> : null}
        {day && m.at !== '' ? <DayDivider at={m.at} /> : null}
        {switched === undefined ? null : (
          <ModelSwitchDivider from={switched.from} to={switched.to} />
        )}
      </>
    )
  }
  const bubble = (m: FreeChatMessage): React.ReactNode => (
    <div
      key={m.id}
      data-msg={m.id}
      className={lit === m.id ? 'rounded-xl ring-2 ring-ws-brand/50 transition-shadow' : undefined}
    >
      {m.role === 'user' ? (
        <UserBubble message={m} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <AssistantMessage
            message={m}
            last={m.id === lastAssistant?.id && !busy}
            onRegenerate={() => {
              if (id !== undefined) void run(id, { regenerate: true })
            }}
            onFanout={fanout}
            // WP357（决策 902）：汇总卡上「撤销」挂在这条长对话里
            onUndoNotes={undoNotes}
          />
          {/* WP352：翻了以前聊过的，出处一排（点了跳过去） */}
          <RecalledRefs hits={m.recalled ?? []} onJump={jump} />
        </div>
      )}
    </div>
  )
  // 刚点了「换个话题」、新段还空着：末尾先画一条线
  const lastRow = rows.at(-1)
  const trailingTopic =
    current?.current && lastRow !== undefined && segOf(lastRow) !== current.id && live === undefined

  const suggestions = (
    <Suggestions
      items={assistant.data?.suggestions ?? []}
      onPick={(text) => {
        send.mutate({ text, images: [] })
      }}
    />
  )

  /*
   * WP456-T8（WP456 §3.7）：和岗位页一个样——对话框是 WP437 那一个完整对话框，贴在中栏底部居中（`ComposerDock`），
   * 对话在它后面往上滚；首屏只有品牌标 + 「有什么要我做的？」，快捷问题贴在框上面（和岗位页的快捷按钮同一种）。
   * 顶部那几颗（搜以前聊过的 · 换个话题 · 记忆 · 替我答同事）进顶栏右边那排图标（没有外壳时就地画）。
   */
  return (
    <div className="-m-4 flex h-[calc(100vh-2.75rem)] md:-m-7" data-testid="free-chat-page">
      <TopBarAction>
        {rows.length === 0 ? null : <HistorySearch onJump={jump} />}
        {currentHasTalk ? (
          <NewTopicButton
            disabled={busy || topic.isPending}
            onClick={() => {
              topic.mutate()
            }}
          />
        ) : null}
        <MemoryButton highlight={memoryLit} />
        {known && !solo ? <PeersButton defaultOpen={params.get('peers') === '1'} /> : null}
      </TopBarAction>
      <section ref={scroller} className="flex min-w-0 flex-1 flex-col overflow-y-auto px-4 md:px-7">
        {empty ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-4 pb-8"
            data-testid="free-chat-empty"
          >
            <BrandMark size={40} motion="idle" />
            <h1 className="text-ws-page font-semibold text-ws-ink">{t('assistant.empty.title')}</h1>
          </div>
        ) : (
          // WP341（决策 847）：回话里的按钮 / 表单点了、交了，就是在这里说了一句（结构化回话也是一句）
          <GenuiHostProvider
            value={{
              say: (text) => {
                send.mutate({ text, images: [] })
              },
              busy,
            }}
          >
            <div
              className="mx-auto flex w-full max-w-[760px] flex-col gap-5 pt-6 pb-2"
              data-testid="free-chat-messages"
            >
              {segmentsOf(rows).map((seg) => {
                const first = seg.rows[0]
                const prev = first === undefined ? undefined : rows[rows.indexOf(first) - 1]
                const head = first === undefined ? null : dividers(first, prev)
                const items = seg.rows.map((m, i) => (
                  <Fragment key={m.id}>
                    {i === 0 ? null : dividers(m, seg.rows[i - 1])}
                    {bubble(m)}
                  </Fragment>
                ))
                // WP350：同一批派出去的事回来报的几句聚在一起
                return (
                  <Fragment key={`seg:${first?.id}`}>
                    {head}
                    {seg.batch === undefined ? (
                      items
                    ) : (
                      <div
                        className="flex flex-col gap-1.5 border-l-2 border-ws-line pl-2"
                        data-testid="assistant-report-batch"
                        data-batch={seg.batch.id}
                      >
                        {seg.batch.title === '' ? null : (
                          <p className="text-xs text-muted-foreground">
                            {t('fanout.batch', { title: seg.batch.title })}
                          </p>
                        )}
                        {items}
                      </div>
                    )}
                  </Fragment>
                )
              })}
              {trailingTopic ? (
                <TopicDivider
                  previous={lastRow === undefined ? undefined : segById.get(segOf(lastRow) ?? '')}
                />
              ) : null}
              {live === undefined ? null : (
                <AssistantMessage
                  message={live.reply}
                  live
                  {...(live.status === undefined ? {} : { status: live.status })}
                  last={false}
                  onRegenerate={() => undefined}
                />
              )}
              {error === undefined ? null : <p className="text-sm text-destructive">{error}</p>}
            </div>
          </GenuiHostProvider>
        )}
        <ComposerDock
          testId="composer-dock"
          data={{ 'data-page': 'assistant' }}
          above={empty ? suggestions : undefined}
        >
          {composer}
        </ComposerDock>
      </section>
    </div>
  )
}

/**
 * WP343：老地址 `/free-chat[/:id]` → `/assistant`（书签、⌘K 老链接照样打得开）。
 * WP352：只有一条对话，会话 id 不再带。
 */
export function LegacyFreeChatRedirect(): React.ReactNode {
  const { search } = useLocation()
  return <Navigate replace to={`${ASSISTANT_PATH}${search}`} />
}
