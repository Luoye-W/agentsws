/**
 * 「聊天窗」页（WP124；48 §4 L3 #11 访客那一面的商家视角）。
 *
 * 一个页面回答商家四件事：
 * 1. **长什么样**：外观（主色 / 欢迎语 / 位置 / 语言）——全部是预设单选与
 *    单行输入，没有调色盘、没有自由画布、没有增删改排表单（docs/36 原则 16；
 *    KefuAgent 原则 16 的判据原样继承）。
 * 2. **怎么装**：一段可复制的嵌入代码 + 实时预览（iframe srcdoc，同一段脚本）。
 * 3. **走哪条路**：官方托管（免费 200 / 月）/ 自建转发 / 客服增值服务——
 *    两档同一个挂件、同一段嵌入代码，切档 = 换转发器地址与密钥，商家网站不用改。
 * 4. **谁在聊**：进行中的对话 + 对话界面。底部唯一的输入框是「教 AI」——
 *    **没有接管式回复框**（修订第 1 条：对客直发入口数 = 0，有 grep 守卫测试）。
 *
 * WP139（docs/78 阻断 #2）：这一页不属于任何岗位，**两种请求用两条自己的分配**——
 * 外观 / 转发器是工作区级配置（`store_config` / `policy`），用所有者那条；
 * 对话列表与教 AI 是 `customer.*`，用网站在线客服那条（`lib/pick-assignment.ts`）。
 * 都不改全局当前岗位。挑不到在线客服就在「进行中的对话」里说清楚去哪加，不发必 403 的请求。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { DutyNeeded } from '@/components/duty-needed'
import { TutorialLink } from '@/components/help/tutorial-link'
import { PageError } from '@/components/page-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import {
  type ChatRelayTestView,
  getChatMessages,
  getChatRelaySettings,
  getChatRelayStatus,
  getChatWidgetSettings,
  listChatSessions,
  setChatRelaySettings,
  setChatWidgetSettings,
  teachChatSession,
  testChatRelay,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { LIVE_CHAT_NEED, LIVE_CHAT_TEACH_NEED, OWNER_NEED } from '@/lib/pick-assignment'
import { assignmentOf, canRequest, useDutyAssignment } from '@/lib/use-duty-assignment'
import { cn } from '@/lib/utils'
import { HostedRelayOption } from './chat-window-hosted'

/** 嵌入代码：商家贴到网站 `</body>` 前的那一行。 */
function embedCode(endpoint: string | undefined): string {
  const base = endpoint ?? 'https://cloud.agentsws.com/relay/<你的工作区号>' // 官方托管没连时也给出形状
  return `<script src="${base.replace(/\/$/, '')}/widget.js" async></script>`
}

/** 预览：同一段脚本跑在 iframe 里（srcdoc，无外部请求时脚本安静退出）。 */
function previewDoc(code: string): string {
  return `<!doctype html><html><body style="margin:0;font-family:sans-serif;background:#f6f7f8">
  <p style="padding:16px;color:#9aa0a6;font-size:13px">你的网页</p>
  ${code.replace('<script', '<script data-preview="1"')}
  </body></html>`
}

const STATUS_KEYS: Record<string, string> = {
  open: 'chat.session.open',
  assist_requested: 'chat.session.assist_requested',
  assist_answered: 'chat.session.assist_answered',
  human_takeover: 'chat.session.human_takeover',
  email_follow_up: 'chat.session.email_follow_up',
  closed: 'chat.session.closed',
}

export function ChatWindowPage(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [instruction, setInstruction] = useState('')
  const [greetingDraft, setGreetingDraft] = useState('')
  const [relayForm, setRelayForm] = useState<{
    endpoint: string
    pairing: string
    messageKey: string
  }>({
    endpoint: '',
    pairing: '',
    messageKey: '',
  })
  const [testResult, setTestResult] = useState<ChatRelayTestView | undefined>(undefined)

  // 工作区级配置：所有者那条（不是所有者就退回当前岗位——被拒了照实说）
  const ownerPick = useDutyAssignment(OWNER_NEED)
  const cfgAsg = assignmentOf(ownerPick)
  const cfgReady = ownerPick.kind !== 'loading'
  // 会话与教 AI：网站在线客服那条
  const chatPick = useDutyAssignment(LIVE_CHAT_NEED)
  const chatAsg = assignmentOf(chatPick)
  const teachAsg = assignmentOf(useDutyAssignment(LIVE_CHAT_TEACH_NEED)) ?? chatAsg

  const settings = useQuery({
    queryKey: ['chat-widget', 'settings', cfgAsg],
    enabled: cfgReady,
    queryFn: () => getChatWidgetSettings(cfgAsg),
  })
  const relay = useQuery({
    queryKey: ['chat-widget', 'relay', cfgAsg],
    enabled: cfgReady,
    queryFn: () => getChatRelaySettings(cfgAsg),
  })
  const status = useQuery({
    queryKey: ['chat-widget', 'status', cfgAsg],
    enabled: cfgReady,
    queryFn: () => getChatRelayStatus(cfgAsg),
  })
  const sessions = useQuery({
    queryKey: ['chat-widget', 'sessions', chatAsg],
    enabled: canRequest(chatPick),
    queryFn: () => listChatSessions(30, chatAsg),
  })
  const detail = useQuery({
    queryKey: ['chat-widget', 'messages', selected],
    enabled: selected !== undefined,
    queryFn: () => getChatMessages(selected as string, chatAsg),
  })

  const refresh = async (): Promise<void> => {
    await client.invalidateQueries({ queryKey: ['chat-widget'] })
  }

  const saveSettings = useMutation({
    mutationFn: (input: Parameters<typeof setChatWidgetSettings>[0]) =>
      setChatWidgetSettings(input, cfgAsg),
    onSuccess: async () => {
      await refresh()
    },
  })
  const saveRelay = useMutation({
    mutationFn: (input: Parameters<typeof setChatRelaySettings>[0]) =>
      setChatRelaySettings(input, cfgAsg),
    onSuccess: async () => {
      setRelayForm({ endpoint: '', pairing: '', messageKey: '' })
      await refresh()
    },
  })
  const test = useMutation({
    mutationFn: () => testChatRelay(cfgAsg),
    onSuccess: (out) => {
      setTestResult(out)
      void refresh()
    },
  })
  const teach = useMutation({
    mutationFn: (input: { id: string; text: string }) =>
      teachChatSession(input.id, { instruction: input.text, scope: 'similar_cases' }, teachAsg),
    onSuccess: async () => {
      setInstruction('')
      await refresh()
    },
  })

  const cfgError = settings.error ?? relay.error
  if (cfgError !== null)
    return (
      <PageError
        error={cfgError}
        testid="chat-window-error"
        onRetry={() => {
          void settings.refetch()
          void relay.refetch()
        }}
      />
    )
  if (settings.isPending || relay.isPending) return <Skeleton className="h-96 w-full" />

  const cfg = settings.data
  const accent = cfg?.accent ?? '#2563eb'
  const greeting = cfg?.greeting ?? ''
  const code = embedCode(relay.data?.endpoint)

  const activeSessions = (sessions.data ?? []).filter((s) => s.status !== 'closed')

  return (
    <div className="grid gap-3 p-3 lg:grid-cols-3" data-testid="chat-window-page">
      {/* ── 外观 + 允许域名 + 等待时长（全是预设与单行，原则 16） ───────── */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="text-sm">{t('chat.window.appearance')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label className="flex items-center gap-2 text-[13px]">
            <span className="w-20 shrink-0">{t('chat.window.accent')}</span>
            <input
              type="color"
              value={accent}
              aria-label={t('chat.window.accent')}
              className="h-8 w-14 cursor-pointer rounded border bg-transparent"
              onChange={(e) =>
                saveSettings.mutate({
                  allowed_origins: cfg?.allowed_origins ?? [],
                  ...(e.target.value === undefined ? {} : { accent: e.target.value }),
                  ...(greeting === '' ? {} : { greeting }),
                  ...(cfg?.assist_wait_seconds === undefined
                    ? {}
                    : { assist_wait_seconds: cfg.assist_wait_seconds }),
                })
              }
            />
          </label>
          <div className="flex flex-col gap-1 text-[13px]">
            <span>{t('chat.window.greeting')}</span>
            <Input
              aria-label={t('chat.window.greeting')}
              value={greeting}
              placeholder={t('chat.window.greeting.placeholder')}
              onChange={(e) => setGreetingDraft(e.target.value)}
              data-testid="chat-greeting"
            />
          </div>
          {greetingDraft !== greeting ? (
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              data-testid="chat-save-greeting"
              onClick={() =>
                saveSettings.mutate({
                  allowed_origins: cfg?.allowed_origins ?? [],
                  ...(accent === undefined ? {} : { accent }),
                  greeting: greetingDraft,
                  ...(cfg?.assist_wait_seconds === undefined
                    ? {}
                    : { assist_wait_seconds: cfg.assist_wait_seconds }),
                })
              }
            >
              {t('chat.window.save')}
            </Button>
          ) : null}
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="flex items-center gap-1">
              {t('chat.window.origins')}
              <Hint text={t('chat.window.origins.hint')} />
            </span>
            <Input
              aria-label={t('chat.window.origins')}
              defaultValue={(cfg?.allowed_origins ?? []).join(', ')}
              placeholder="https://shop.example.com"
              data-testid="chat-origins"
              onBlur={(e) =>
                saveSettings.mutate({
                  allowed_origins: e.target.value
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s !== ''),
                  ...(accent === undefined ? {} : { accent }),
                  ...(greeting === '' ? {} : { greeting }),
                  ...(cfg?.assist_wait_seconds === undefined
                    ? {}
                    : { assist_wait_seconds: cfg.assist_wait_seconds }),
                })
              }
            />
          </div>
          <div className="flex flex-col gap-1 text-[13px]">
            <span className="flex items-center gap-1">
              {t('chat.window.assist_wait')}
              <Hint text={t('chat.window.assist_wait.hint')} />
            </span>
            <select
              aria-label={t('chat.window.assist_wait')}
              className="h-9 rounded-md border bg-transparent px-2 text-[13px]"
              value={cfg?.assist_wait_seconds ?? 30}
              data-testid="chat-assist-wait"
              onChange={(e) =>
                saveSettings.mutate({
                  allowed_origins: cfg?.allowed_origins ?? [],
                  ...(accent === undefined ? {} : { accent }),
                  ...(greeting === '' ? {} : { greeting }),
                  assist_wait_seconds: Number(e.target.value),
                })
              }
            >
              {[30, 60, 180, 300, 600].map((s) => (
                <option key={s} value={s}>
                  {t('chat.window.assist_wait.option', { n: s < 60 ? String(s) : `${s / 60}` })}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {/* ── 转发方式三选一 + 嵌入码 + 预览 + 测试连接 + 本月数 ─────────── */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            {t('chat.window.relay')}
            {/* WP157：三种方式怎么选、各自怎么接，在教程里 */}
            <TutorialLink slug="chat-window" className="ml-auto font-normal" />
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-[13px]">
          <div className="rounded-md border p-2" data-testid="relay-mode">
            <p className="flex items-center gap-1 font-medium" data-slot="title">
              {t('chat.window.relay.official')}
              <Hint text={t('chat.window.relay.official.hint')} />
            </p>
            {/* 额度是状态：一眼可见 */}
            <p className="text-xs text-muted-foreground" data-slot="status">
              {t('chat.window.relay.official.quota')}
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <p className="flex items-center gap-1 font-medium" data-slot="title">
              {t('chat.window.relay.self')}
              <Hint text={t('chat.window.relay.hosted.hint')} />
            </p>
            <span data-slot="title">{t('chat.window.relay.endpoint')}</span>
            <Input
              value={relayForm.endpoint || relay.data?.endpoint || ''}
              placeholder="https://…/relay/<工作区>"
              data-testid="relay-endpoint"
              onChange={(e) => setRelayForm((f) => ({ ...f, endpoint: e.target.value }))}
            />
            <Input
              type="password"
              value={relayForm.pairing}
              placeholder={t('chat.window.relay.pairing')}
              data-testid="relay-pairing"
              onChange={(e) => setRelayForm((f) => ({ ...f, pairing: e.target.value }))}
            />
            {/* WP137：留言密钥（自建转发器打印的 / 自建 Worker 的 MESSAGE_KEY）；没有它转发器不收留言 */}
            <Input
              type="password"
              value={relayForm.messageKey}
              placeholder={
                relay.data?.has_message_key === true
                  ? t('chat.window.relay.messageKey.saved')
                  : t('chat.window.relay.messageKey')
              }
              data-testid="relay-message-key"
              onChange={(e) => setRelayForm((f) => ({ ...f, messageKey: e.target.value }))}
            />
            <Button
              size="sm"
              variant="secondary"
              className="self-start"
              data-testid="relay-save"
              disabled={
                relayForm.endpoint === '' && relayForm.pairing === '' && relayForm.messageKey === ''
              }
              onClick={() =>
                saveRelay.mutate({
                  ...(relayForm.endpoint === '' ? {} : { endpoint: relayForm.endpoint }),
                  ...(relayForm.pairing === '' ? {} : { pairing_token: relayForm.pairing }),
                  ...(relayForm.messageKey === '' ? {} : { message_key: relayForm.messageKey }),
                })
              }
            >
              {t('chat.window.save')}
            </Button>
          </div>
          {/* WP128：第三项接真——订阅后「云端替你值守中」 */}
          <HostedRelayOption assignment={cfgAsg} />
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              data-testid="relay-test"
              onClick={() => test.mutate()}
            >
              {t('chat.window.relay.test')}
            </Button>
            {testResult !== undefined ? (
              <span
                className={testResult.ok ? 'text-xs text-green-700' : 'text-xs text-destructive'}
                data-slot="status"
              >
                {testResult.detail}
              </span>
            ) : null}
          </div>
          <div data-testid="relay-usage" data-slot="status">
            {status.data !== undefined ? (
              <span className="text-xs text-muted-foreground">
                {t('chat.window.relay.usage', {
                  count: String(status.data.conversations_this_month ?? '—'),
                  limit: status.data.unlimited === true ? '∞' : String(status.data.limit ?? '—'),
                })}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground" data-slot="title">
              {t('chat.window.embed')}
            </span>
            <code
              className="overflow-x-auto rounded-md bg-muted p-2 text-xs"
              data-testid="chat-embed-code"
              data-slot="data"
            >
              {code}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="self-start"
              data-testid="chat-embed-copy"
              onClick={() => {
                void navigator.clipboard.writeText(code)
              }}
            >
              {t('chat.window.embed.copy')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── 预览 ─────────────────────────────────────────────────────── */}
      <Card className="lg:col-span-1">
        <CardHeader>
          <CardTitle className="text-sm">{t('chat.window.preview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <iframe
            title={t('chat.window.preview')}
            data-testid="chat-preview"
            className="h-64 w-full rounded-md border bg-white"
            srcDoc={previewDoc(code)}
            sandbox=""
          />
        </CardContent>
      </Card>

      {/* ── 进行中的对话 + 对话界面（只有教 AI，没有接管回复框） ────────── */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-sm">{t('chat.window.conversations')}</CardTitle>
        </CardHeader>
        <CardContent>
          {chatPick.kind === 'none' || chatPick.kind === 'no_range' ? (
            <DutyNeeded need={LIVE_CHAT_NEED} kind={chatPick.kind} testid="chat-duty-needed" />
          ) : sessions.error !== null ? (
            <PageError
              error={sessions.error}
              testid="chat-sessions-error"
              overrides={{ forbidden: t('chat.forbidden') }}
              onRetry={() => {
                void sessions.refetch()
              }}
            />
          ) : activeSessions.length === 0 ? (
            <p className="text-[13px] text-muted-foreground" data-testid="chat-conversations-empty">
              {t('chat.window.conversations.empty')}
            </p>
          ) : (
            <ul className="flex flex-col gap-1" data-testid="chat-conversations">
              {activeSessions.map((s) => (
                <li key={s.id}>
                  <button
                    type="button"
                    className={cnSession(selected === s.id)}
                    data-testid="chat-conversation"
                    onClick={() => setSelected(s.id)}
                  >
                    <span>{s.visitor_display ?? s.external_session_id}</span>
                    <span className="ml-auto text-xs text-muted-foreground">
                      {t(STATUS_KEYS[s.status] ?? 'chat.session.open')}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {selected !== undefined && detail.data !== undefined ? (
            <div className="mt-3 flex flex-col gap-2" data-testid="chat-conversation-view">
              <ul className="max-h-64 overflow-y-auto">
                {detail.data.messages.map((m) => (
                  <li
                    key={m.id}
                    className={cn(
                      'py-0.5 text-[13px]',
                      m.role === 'visitor' ? '' : 'text-muted-foreground',
                    )}
                  >
                    <span className="mr-1 text-xs">{t(`chat.role.${m.role}`)}:</span>
                    {m.text}
                  </li>
                ))}
              </ul>
              {/* 唯一的输入框：教 AI。客户看不到这句话；AI 改写成客户语言后以 AI 口吻回。
                  这里**没有**「我来接手」的回复框——那是被 KA 与 Luoye 一起拆掉的路。 */}
              <div className="flex items-start gap-2">
                <Textarea
                  value={instruction}
                  placeholder={t('chat.window.teach.placeholder')}
                  data-testid="chat-teach-input"
                  rows={2}
                  onChange={(e) => setInstruction(e.target.value)}
                />
                <Button
                  size="sm"
                  data-testid="chat-teach-send"
                  disabled={instruction.trim() === '' || teach.isPending}
                  onClick={() => teach.mutate({ id: selected as string, text: instruction.trim() })}
                >
                  {t('chat.window.teach.send')}
                </Button>
                <Hint text={t('chat.window.teach.hint')} />
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

// 局部工具：会话行的高亮
const cnSession = (active: boolean): string =>
  cn(
    'flex w-full items-center gap-2 rounded-[10px] px-2.5 py-1.5 text-left text-[13px]',
    active ? 'bg-sidebar-accent font-medium' : 'hover:bg-sidebar-accent/60',
  )
