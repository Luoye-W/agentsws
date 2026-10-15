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
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { GenuiHostProvider } from '@/components/answer/genui/genui-host'
import { BrandMark } from '@/components/design'
import { MemoryButton, PeersButton, Suggestions } from '@/components/free-chat/assistant-bits'
import { Composer, type ComposerToggles } from '@/components/free-chat/composer'
import { AssistantMessage, UserBubble } from '@/components/free-chat/message'
import { ComposerModelPicker } from '@/components/free-chat/model-picker'
import { SessionList } from '@/components/free-chat/session-list'
import { useApp } from '@/lib/app-context'
import {
  type AssistantTarget,
  createFreeChatSession,
  deleteFreeChatSession,
  type FreeChatFrame,
  type FreeChatImage,
  type FreeChatMessage,
  getAssistantState,
  getFreeChatModels,
  listFreeChatMessages,
  listFreeChatSessions,
  renameFreeChatSession,
  stopFreeChat,
  streamFreeChat,
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

interface Live {
  session_id: string
  user?: FreeChatMessage
  reply: FreeChatMessage
  status?: string
}

export function FreeChatPage(): React.ReactNode {
  const { t } = useApp()
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [params] = useSearchParams()
  const { solo, known } = useMode()
  /**
   * WP342（决策 853）：每段对话自己的 AI（输入框左下角那个钮）。键是会话 id，新对话还没 id 时是 ''。
   * 没在这次选过：用这段对话上一条回答用的那个（= 存在会话上），再没有就是品牌默认。
   */
  const [picks, setPicks] = useState<Record<string, string>>({})
  const [toggles, setToggles] = useState<ComposerToggles>({ web_search: false, knowledge: false })
  const [live, setLive] = useState<Live | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | undefined>(undefined)

  const models = useQuery({ queryKey: [...KEY, 'models'], queryFn: getFreeChatModels })
  const sessions = useQuery({ queryKey: [...KEY, 'sessions'], queryFn: listFreeChatSessions })
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
  const lastUsed = [...rows].reverse().find((m) => m.model !== undefined)?.model?.id
  const picked =
    picks[id ?? ''] ??
    (lastUsed !== undefined && choices.some((c) => c.id === lastUsed) ? lastUsed : undefined) ??
    models.data?.default ??
    choices[0]?.id
  const choice = choices.find((c) => c.id === picked)

  // 新的字进来就滚到底
  // biome-ignore lint/correctness/useExhaustiveDependencies: 只按"内容变了"滚
  useEffect(() => {
    const el = scroller.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [rows.length, live?.reply.text, live?.status])

  const refresh = (session_id: string): void => {
    void client.invalidateQueries({ queryKey: [...KEY, 'messages', session_id] })
    void client.invalidateQueries({ queryKey: [...KEY, 'sessions'] })
  }

  const run = async (
    session_id: string,
    input:
      | { text: string; images: FreeChatImage[]; target?: AssistantTarget }
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
          },
        ])
        await streamFreeChat(
          session_id,
          {
            text: input.text,
            ...(input.images.length === 0 ? {} : { images: input.images }),
            ...(input.target === undefined ? {} : { target: input.target }),
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
    }) => {
      let session_id = id
      if (session_id === undefined) {
        const made = await createFreeChatSession()
        session_id = made.id
        // 新对话里先选的 AI 跟着这段对话走
        setPicks((prev) => {
          const first = prev['']
          if (first === undefined) return prev
          const { '': _drop, ...rest } = prev
          return { ...rest, [made.id]: first }
        })
        client.setQueryData([...KEY, 'messages', made.id], [])
        navigate(`${ASSISTANT_PATH}/${made.id}`)
      }
      await run(session_id, input)
    },
  })

  const stop = (): void => {
    const session_id = live?.session_id
    if (session_id === undefined) return
    // 先请服务端停（它会把已经答出来的部分存好、再推一帧 done）；请不动就直接断开
    stopFreeChat(session_id).catch(() => abort.current?.abort())
  }

  const busy = live !== undefined
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
      onSend={(text, images, target) => {
        send.mutate({ text, images, ...(target === undefined ? {} : { target }) })
      }}
      onStop={stop}
      placeholder={t('assistant.placeholder')}
      {...(assistant.data === undefined ? {} : { targets: assistant.data.targets })}
      modelSlot={
        <ComposerModelPicker
          value={picked}
          onChange={(next) => {
            setPicks((prev) => ({ ...prev, [id ?? '']: next }))
          }}
          testId="free-chat-model"
        />
      }
    />
  )
  const lit = (params.get('memory') ?? '').split(',').filter((x) => x !== '')

  return (
    <div className="-m-4 flex h-[calc(100vh-57px)] md:-m-7" data-testid="free-chat-page">
      <aside className="hidden w-56 shrink-0 border-r border-ws-line p-3 md:block">
        <SessionList
          sessions={sessions.data ?? []}
          current={id}
          onNew={() => {
            navigate(ASSISTANT_PATH)
          }}
          onPick={(next) => {
            navigate(`${ASSISTANT_PATH}/${next}`)
          }}
          onRename={(sid, title) => {
            void renameFreeChatSession(sid, title).then(() => refresh(sid))
          }}
          onDelete={(sid) => {
            void deleteFreeChatSession(sid).then(() => {
              refresh(sid)
              if (sid === id) navigate(ASSISTANT_PATH)
            })
          }}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        {/* WP343：右上角——助理记的几条；同事互联 / 公司模式多一个「替我答同事」（原「我的代理」）。模型钮在输入框里（WP342） */}
        <header className="flex items-center gap-2 px-4 py-2">
          <span className="ml-auto flex items-center gap-1.5">
            <MemoryButton highlight={lit} />
            {known && !solo ? <PeersButton defaultOpen={params.get('peers') === '1'} /> : null}
          </span>
        </header>
        {id === undefined && live === undefined ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-5 px-4"
            data-testid="free-chat-empty"
          >
            <BrandMark size={40} motion="idle" />
            <div className="flex flex-col items-center gap-1.5 text-center">
              <h2 className="ws-display text-xl">{t('assistant.empty.title')}</h2>
              <p
                className="max-w-xl text-[13px] text-muted-foreground"
                data-testid="assistant-intro"
              >
                {t('assistant.empty.sub')}
              </p>
            </div>
            <div className="w-full max-w-2xl">{composer}</div>
            <Suggestions
              items={assistant.data?.suggestions ?? []}
              onPick={(text) => {
                send.mutate({ text, images: [] })
              }}
            />
          </div>
        ) : (
          <>
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4">
              {/* WP341（决策 847）：回话里的按钮 / 表单点了、交了，就是在这里说了一句（结构化回话也是一句） */}
              <GenuiHostProvider
                value={{
                  say: (text) => {
                    send.mutate({ text, images: [] })
                  },
                  busy,
                }}
              >
                <div
                  className="mx-auto flex max-w-3xl flex-col gap-5 py-4"
                  data-testid="free-chat-messages"
                >
                  {rows.map((m) =>
                    m.role === 'user' ? (
                      <UserBubble key={m.id} message={m} />
                    ) : (
                      <AssistantMessage
                        key={m.id}
                        message={m}
                        last={m.id === lastAssistant?.id && !busy}
                        onRegenerate={() => {
                          if (id !== undefined) void run(id, { regenerate: true })
                        }}
                      />
                    ),
                  )}
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
            </div>
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
          </>
        )}
      </section>
    </div>
  )
}

/** WP343：老地址 `/free-chat[/:id]` → `/assistant[/:id]`（书签、⌘K 老链接照样打得开）。 */
export function LegacyFreeChatRedirect(): React.ReactNode {
  const { id } = useParams<{ id?: string }>()
  const { search } = useLocation()
  return <Navigate replace to={`${ASSISTANT_PATH}${id === undefined ? '' : `/${id}`}${search}`} />
}
