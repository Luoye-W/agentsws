/**
 * WP113（63 §8）：第三栏的 **`mail-assistant`** 面板。
 *
 * 四段：本封摘要 · 回复建议 · 发件人是谁 · 相关待办（外加一个"转成待办"）。
 *
 * 三条纪律：
 *
 * 1. **注册走公开路**（`registerPanelType` + `registerPanelBody(lazy)`，WP95 #4）。
 *    `registry.ts` 一个字没改——内置不走后门这条纪律，这一版仍然守着。
 * 2. **按需生成**：这个面板挂载时才去打 `/v1/messages/:id/assistant`，
 *    而服务端也是那一刻才生成回复建议并缓存 30 分钟。对全量来信预生成是最贵的错法。
 * 3. **点建议 = 进编辑框**，不是发送。这个面板里没有任何一条路通向"发出去"——
 *    非岗位信件永不自动发（63 §6）。
 *
 * "当前打开的是哪封信"走 {@link useOpenMessage} 那份内存真源（同 WP100 的
 * `deck-focus.ts`）：**不往注册接口上加一格**——那份接口是所有面板共用的。
 */
import { useQuery } from '@tanstack/react-query'
import { ListPlus, Mail } from 'lucide-react'
import { type ReactNode, useSyncExternalStore } from 'react'
import { StatusPill, WsAvatar, WsTag } from '@/components/design'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { getMailAssistant, messageToTodo } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/* ── 内存真源：现在打开的是哪封信 ─────────────────────────────────────── */

let openId: string | undefined
const listeners = new Set<() => void>()

/** 阅读区打开一封信时调它（不落本机：刷新之后这一格回到空，面板照实说）。 */
export function focusMessage(id: string | undefined): void {
  if (openId === id) return
  openId = id
  for (const l of listeners) l()
}

export function useOpenMessage(): string | undefined {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    () => openId,
    () => undefined,
  )
}

/** 只给测试用。 */
export function resetMessageFocus(): void {
  openId = undefined
  for (const l of listeners) l()
}

/* ── 面板 ─────────────────────────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-[11px] font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

/**
 * 点了建议之后**进编辑框**（不是发送）。
 *
 * 面板与消息页之间隔着第三栏的注册表，拿不到彼此的回调，所以走一个
 * `CustomEvent`——与往注册接口上加一格相比，这条路只影响这两个文件。
 */
export const USE_SUGGESTION_EVENT = 'agentsws:use-suggestion'

export function MailAssistantPanel(): ReactNode {
  const { t } = useApp()
  const id = useOpenMessage()
  const view = useQuery({
    queryKey: ['messages', 'assistant', id],
    enabled: id !== undefined,
    queryFn: () => getMailAssistant(id as string),
  })

  if (id === undefined)
    return (
      <p className="text-[13px] text-muted-foreground" data-testid="rail-mail-empty">
        {t('rail.mail.empty')}
      </p>
    )
  if (view.isPending) return <Skeleton className="h-40 w-full" />
  if (view.error !== null)
    return (
      <p role="alert" className="text-[13px] text-destructive">
        {t('error.generic')}：{view.error.message}
      </p>
    )

  const data = view.data
  return (
    <div className="flex flex-col gap-4" data-testid="rail-mail-assistant">
      {data.summary === '' ? null : (
        <Section title={t('rail.mail.summary')}>
          <p className="text-[13px] leading-relaxed">{data.summary}</p>
        </Section>
      )}

      <Section title={t('rail.mail.suggestions')}>
        {!data.model_available ? (
          <p className="text-[12px] text-muted-foreground" data-testid="rail-mail-no-model">
            {t('rail.mail.no_model')}
          </p>
        ) : data.suggestions.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('rail.mail.no_reply_needed')}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.suggestions.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  data-testid="rail-mail-suggestion"
                  data-kind={s.kind}
                  className="w-full rounded-[10px] border border-ws-line bg-ws-card p-2.5 text-left hover:shadow-ws"
                  onClick={() => {
                    // 点了进编辑框成草稿——**人改完自己点发送**
                    window.dispatchEvent(new CustomEvent(USE_SUGGESTION_EVENT, { detail: s.text }))
                  }}
                >
                  <span className="text-[12px] font-medium">{s.title}</span>
                  <span className="mt-1 line-clamp-3 block text-[12px] text-ws-muted-fg">
                    {s.text}
                  </span>
                  {s.citations.length === 0 ? null : (
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      {s.citations.map((c) => (
                        <WsTag key={c.source_id}>{c.title}</WsTag>
                      ))}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={t('rail.mail.sender')}>
        <div className="flex items-center gap-2" data-testid="rail-mail-sender">
          <WsAvatar name={data.sender.name ?? data.sender.address} id={data.sender.address} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px]">{data.sender.name ?? data.sender.address}</div>
            <div className="truncate text-[11px] text-muted-foreground">{data.sender.address}</div>
          </div>
          <StatusPill tone="neutral">
            {t('rail.mail.history', { count: data.sender.history_count })}
          </StatusPill>
        </div>
        {data.sender.linked.length === 0 ? null : (
          <div className="flex flex-wrap gap-1">
            {data.sender.linked.map((l) => (
              <WsTag key={`${l.type}:${l.id}`}>{l.label}</WsTag>
            ))}
          </div>
        )}
      </Section>

      <Section title={t('rail.mail.todos')}>
        {data.todos.length === 0 ? (
          <p className="text-[12px] text-muted-foreground">{t('rail.mail.no_todos')}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {data.todos.map((td) => (
              <li key={td.id} className="truncate text-[12px]">
                {td.title}
              </li>
            ))}
          </ul>
        )}
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          data-testid="rail-mail-to-todo"
          onClick={() => {
            void messageToTodo(id)
          }}
        >
          <ListPlus aria-hidden className="mr-1 size-3.5" />
          {t('rail.mail.to_todo')}
        </Button>
      </Section>

      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <Mail aria-hidden className="size-3" />
        {t('rail.mail.footnote')}
      </p>
    </div>
  )
}
