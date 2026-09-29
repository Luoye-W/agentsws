/**
 * WP188「随便聊」（Luoye 09-29：「得留一个入口，用户可以随便问一些问题，就像 DeepSeek 网页版一样」）。
 *
 * 左边会话列表，中间对话流，底部输入框。不开事项、不起岗位运行、没有任何对外动作；
 * 想让岗位去做，每条回复旁边有「交给岗位去做」（带着这段对话打开 ⌘K 的岗位列表）。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { BrandMark } from '@/components/design'
import { Composer, type ComposerToggles } from '@/components/free-chat/composer'
import { AssistantMessage, UserBubble } from '@/components/free-chat/message'
import { ModelPicker } from '@/components/free-chat/model-picker'
import { SessionList } from '@/components/free-chat/session-list'
import { usePalette } from '@/components/palette-context'
import { useApp } from '@/lib/app-context'
import {
  createFreeChatSession,
  deleteFreeChatSession,
  type FreeChatFrame,
  type FreeChatImage,
  type FreeChatMessage,
  getFreeChatModels,
  listFreeChatMessages,
  listFreeChatSessions,
  renameFreeChatSession,
  stopFreeChat,
  streamFreeChat,
} from '@/lib/free-chat'

const KEY = ['free-chat'] as const

interface Live {
  session_id: string
  user?: FreeChatMessage
  reply: FreeChatMessage
  status?: string
}

/** 「交给岗位去做」带过去的那件事：标题是用户那句话，上下文是这一问一答。 */
export function handoffOf(user: FreeChatMessage | undefined, reply: FreeChatMessage) {
  const ask = (user?.text ?? '').replace(/\s+/g, ' ').trim()
  const title =
    (ask === '' ? reply.text.replace(/\s+/g, ' ').trim() : ask).slice(0, 120) || '随便聊里的一件事'
  const summary = `从随便聊带过来的：\n问：${user?.text ?? ''}\n答：${reply.text}`.slice(0, 2000)
  return { title, summary }
}

export function FreeChatPage(): React.ReactNode {
  const { t } = useApp()
  const { id } = useParams<{ id?: string }>()
  const navigate = useNavigate()
  const client = useQueryClient()
  const palette = usePalette()
  const [model, setModel] = useState<string | undefined>(undefined)
  const [toggles, setToggles] = useState<ComposerToggles>({ web_search: false, knowledge: false })
  const [live, setLive] = useState<Live | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const scroller = useRef<HTMLDivElement>(null)
  const abort = useRef<AbortController | undefined>(undefined)

  const models = useQuery({ queryKey: [...KEY, 'models'], queryFn: getFreeChatModels })
  const sessions = useQuery({ queryKey: [...KEY, 'sessions'], queryFn: listFreeChatSessions })
  const messages = useQuery({
    queryKey: [...KEY, 'messages', id],
    queryFn: () => listFreeChatMessages(id ?? ''),
    enabled: id !== undefined,
  })

  const choices = models.data?.choices ?? []
  const picked = model ?? models.data?.default ?? choices[0]?.id
  const choice = choices.find((c) => c.id === picked)
  const rows = id === undefined ? [] : (messages.data ?? [])

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
    input: { text: string; images: FreeChatImage[] } | { regenerate: true },
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
        if (f.type === 'notice') return { ...prev, status: f.text }
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
          },
        ])
        await streamFreeChat(
          session_id,
          {
            text: input.text,
            ...(input.images.length === 0 ? {} : { images: input.images }),
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
    }
  }

  const send = useMutation({
    mutationFn: async (input: { text: string; images: FreeChatImage[] }) => {
      let session_id = id
      if (session_id === undefined) {
        const made = await createFreeChatSession()
        session_id = made.id
        client.setQueryData([...KEY, 'messages', made.id], [])
        navigate(`/free-chat/${made.id}`)
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
  const userBefore = (i: number): FreeChatMessage | undefined =>
    [...rows.slice(0, i)].reverse().find((m) => m.role === 'user')

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
      onSend={(text, images) => {
        send.mutate({ text, images })
      }}
      onStop={stop}
    />
  )

  return (
    <div className="-m-4 flex h-[calc(100vh-57px)] md:-m-7" data-testid="free-chat-page">
      <aside className="hidden w-56 shrink-0 border-r border-ws-line p-3 md:block">
        <SessionList
          sessions={sessions.data ?? []}
          current={id}
          onNew={() => {
            navigate('/free-chat')
          }}
          onPick={(next) => {
            navigate(`/free-chat/${next}`)
          }}
          onRename={(sid, title) => {
            void renameFreeChatSession(sid, title).then(() => refresh(sid))
          }}
          onDelete={(sid) => {
            void deleteFreeChatSession(sid).then(() => {
              refresh(sid)
              if (sid === id) navigate('/free-chat')
            })
          }}
        />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 px-4 py-2">
          {/* 清单回来之前不画（不然会先闪一下「还没接模型」） */}
          {models.data === undefined ? (
            <span className="h-7" />
          ) : (
            <ModelPicker choices={choices} value={picked} onChange={setModel} />
          )}
        </header>
        {id === undefined && live === undefined ? (
          <div
            className="flex flex-1 flex-col items-center justify-center gap-5 px-4"
            data-testid="free-chat-empty"
          >
            <BrandMark size={40} />
            <h2 className="ws-display text-xl">{t('free_chat.empty')}</h2>
            <div className="w-full max-w-2xl">{composer}</div>
          </div>
        ) : (
          <>
            <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4">
              <div
                className="mx-auto flex max-w-3xl flex-col gap-5 py-4"
                data-testid="free-chat-messages"
              >
                {rows.map((m, i) =>
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
                      onHandoff={() => {
                        palette.open(handoffOf(userBefore(i), m))
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
                    onHandoff={() => undefined}
                  />
                )}
                {error === undefined ? null : <p className="text-sm text-destructive">{error}</p>}
              </div>
            </div>
            <div className="mx-auto w-full max-w-3xl px-4 pb-4">{composer}</div>
          </>
        )}
      </section>
    </div>
  )
}
