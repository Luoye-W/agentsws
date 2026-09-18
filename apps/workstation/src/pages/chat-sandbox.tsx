/**
 * 聊天沙盒（WP57；48 §4 L3 #11 的本地部分）。
 *
 * 网站聊天窗本身要等托管档（widget 脚本 + 公网端点，B 期）。在那之前商家怎么知道
 * 他的在线客服会怎么答？**自己坐到访客那一边试一遍。**
 *
 * 左边：扮演访客发消息。右边：这一轮 AI 判成了哪种动作、为什么、缺什么、
 * 走没走模型、出没出卡，还有人工接管开关。
 *
 * 一个刻意的差别：发完一句之后页面**自己点一下「判完这一轮」**，不等服务进程里
 * 那个 2 秒定时器。真访客那一路照常由定时器驱动——这里是试用场，不是仿真场，
 * 让商家每发一句干等两秒，他试两句就走了。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ChatPlanPanel } from '@/components/chat/plan-panel'
import { ChatTranscript } from '@/components/chat/transcript'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  advanceChatTurn,
  type ChatTurnView,
  getChatMessages,
  openChatSession,
  sendChatMessage,
  setChatTakeover,
  teachChatSession,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function ChatSandboxPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [draft, setDraft] = useState('')
  const [instruction, setInstruction] = useState('')
  const [turn, setTurn] = useState<ChatTurnView | undefined>(undefined)

  // 同一个人重复开只拿回同一条会话（唯一键在服务端）
  const session = useQuery({ queryKey: ['chat', 'session'], queryFn: openChatSession })
  const id = session.data?.id
  const thread = useQuery({
    queryKey: ['chat', 'messages', id],
    enabled: id !== undefined,
    queryFn: () => getChatMessages(id as string),
  })

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['chat'] })
    // 出了卡就该在首页看得见：让队列也重取一次
    await client.invalidateQueries({ queryKey: ['home'] })
  }

  const send = useMutation({
    mutationFn: async (text: string) => {
      const first = await sendChatMessage(id as string, text)
      // 静默窗口：沙盒里立刻推进，不等真定时器（见文件抬头）
      return first.plan === undefined ? advanceChatTurn(id as string) : first
    },
    onSuccess: async (out) => {
      setTurn(out)
      setDraft('')
      await refresh()
    },
  })

  const takeover = useMutation({
    mutationFn: (on: boolean) => setChatTakeover(id as string, on),
    onSuccess: async () => {
      setTurn(undefined)
      await refresh()
    },
  })

  const teach = useMutation({
    mutationFn: (text: string) =>
      teachChatSession(id as string, { instruction: text, scope: 'similar_cases' }),
    onSuccess: async () => {
      setInstruction('')
      await refresh()
    },
  })

  if (session.isPending) return <Skeleton className="h-96 w-full" />
  if (session.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('chat.unavailable')}
      </p>
    )
  }

  const takenOver = thread.data?.session.takeover ?? false
  const status = thread.data?.session.status ?? 'open'

  return (
    <div className="flex flex-col gap-4" data-testid="chat-sandbox">
      <header className="flex flex-col gap-1">
        <h2 className="flex items-center gap-1.5 text-base font-medium">
          {t('chat.title')}
          <Hint text={t('chat.intro')} testId="chat-intro" />
        </h2>
        <p className="text-sm text-muted-foreground">{t('chat.subtitle')}</p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── 左：扮演访客 ─────────────────────────────────────── */}
        <Card>
          <CardHeader className="gap-1">
            <CardTitle className="flex items-center gap-1.5 text-sm">
              {t('chat.visitor.title')}
              <Hint text={t('chat.visitor.why')} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {thread.isPending ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              // WP112：这一轮交出去了、还没回来——线程末尾那个呼吸的标记
              <ChatTranscript messages={thread.data?.messages ?? []} busy={send.isPending} />
            )}
            <div className="flex flex-col gap-2">
              <Textarea
                aria-label={t('chat.visitor.placeholder')}
                placeholder={t('chat.visitor.placeholder')}
                data-testid="chat-visitor-input"
                rows={2}
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value)
                }}
              />
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  data-testid="chat-visitor-send"
                  disabled={draft.trim() === '' || send.isPending || id === undefined}
                  onClick={() => {
                    send.mutate(draft.trim())
                  }}
                >
                  {t('chat.visitor.send')}
                </Button>
                <span className="text-xs text-muted-foreground" data-testid="chat-status">
                  {t(`chat.status.${status}`)}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── 右：AI 的计划、接管开关、教 AI ───────────────────── */}
        <div className="flex flex-col gap-4">
          <ChatPlanPanel turn={turn} />

          <Card>
            <CardHeader className="gap-1">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                {t('chat.takeover.title')}
                <Hint text={t('chat.takeover.why')} testId="chat-takeover-why" />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex items-center gap-3">
              <Switch
                checked={takenOver}
                aria-label={t('chat.takeover.title')}
                data-testid="chat-takeover"
                disabled={takeover.isPending || id === undefined}
                onCheckedChange={(on) => {
                  takeover.mutate(on)
                }}
              />
              <span className="text-sm text-muted-foreground">
                {takenOver ? t('chat.takeover.on') : t('chat.takeover.off')}
              </span>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="gap-1">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                {t('chat.teach.title')}
                <Hint text={t('chat.teach.why')} testId="chat-teach-why" />
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <Textarea
                aria-label={t('chat.teach.placeholder')}
                placeholder={t('chat.teach.placeholder')}
                data-testid="chat-teach-input"
                rows={2}
                value={instruction}
                onChange={(e) => {
                  setInstruction(e.target.value)
                }}
              />
              <div>
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="chat-teach-send"
                  disabled={instruction.trim() === '' || teach.isPending || id === undefined}
                  onClick={() => {
                    teach.mutate(instruction.trim())
                  }}
                >
                  {t('chat.teach.send')}
                </Button>
              </div>
              {teach.data === undefined ? null : (
                <p className="text-xs text-muted-foreground" data-testid="chat-teach-outcome">
                  {t(`chat.teach.outcome.${teach.data.outcome}`)}
                </p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}
