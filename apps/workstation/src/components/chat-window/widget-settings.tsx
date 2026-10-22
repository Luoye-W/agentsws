/**
 * 「网站聊天窗」挂件设置（WP124 外观 / 嵌入代码 / 转发方式 / 托管档）。
 *
 * WP351（Luoye 10-16 追加）：原来的「聊天窗」页拆成两半——
 * - **这一半**（装在商家网站上给访客用的那个挂件长什么样、怎么装、走哪条路）挪进账号菜单「设置」组里的
 *   「消息渠道」页，当一个渠道，名叫「网站聊天窗」（`pages/im-channels.tsx`）；
 * - **另一半**（谁在聊、对话、教 AI）并进「消息」页，当和邮箱并列的一个来源「网站聊天」
 *   （`components/messages/site-chat.tsx`）。
 *
 * 外观全是预设单选与单行输入，没有调色盘、没有自由画布、没有增删改排表单（docs/36 原则 16；
 * KefuAgent 原则 16 的判据原样继承）。官方托管 / 自建转发 / 客服增值服务：同一个挂件、同一段嵌入代码，
 * 切档 = 换转发器地址与密钥，商家网站不用改。
 *
 * WP139：外观 / 转发器是工作区级配置（`store_config` / `policy`），用所有者那条分配发请求，
 * 不改全局当前岗位。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { TutorialLink } from '@/components/help/tutorial-link'
import { PageError } from '@/components/page-error'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import {
  type ChatAutoAnswerStrictnessView,
  type ChatRelayTestView,
  getChatRelaySettings,
  getChatRelayStatus,
  getChatWidgetSettings,
  setChatRelaySettings,
  setChatWidgetSettings,
  testChatRelay,
} from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { OWNER_NEED } from '@/lib/pick-assignment'
import { assignmentOf, useDutyAssignment } from '@/lib/use-duty-assignment'
import { HostedRelayOption } from '@/pages/chat-window-hosted'

/** 嵌入代码：商家贴到网站 `</body>` 前的那一行。 */
export function embedCode(endpoint: string | undefined): string {
  const base = endpoint ?? 'https://cloud.agentsws.com/relay/<你的工作区号>' // 官方托管没连时也给出形状
  return `<script src="${base.replace(/\/$/, '')}/widget.js" async></script>`
}

const escapeHtml = (t: string): string =>
  t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 预览：画出挂件在网页上的样子（右下角的按钮 + 欢迎语气泡），按现在的主色与欢迎语。
 * WP417（自查 C28 / U19）：以前把嵌入脚本塞进一个禁了脚本的 iframe，框里只剩「你的网页」四个字。
 */
export function previewDoc(accent: string, greeting: string): string {
  const color = /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : '#2563eb'
  return `<!doctype html><html><body style="margin:0;font-family:sans-serif;background:#f6f7f8;height:100vh;position:relative">
  <p style="padding:16px;color:#9aa0a6;font-size:13px">你的网页</p>
  <div style="position:absolute;right:16px;bottom:72px;max-width:70%;background:#fff;border-radius:12px;padding:10px 12px;font-size:13px;color:#202124;box-shadow:0 2px 8px rgba(0,0,0,.12)">${escapeHtml(greeting)}</div>
  <div style="position:absolute;right:16px;bottom:16px;width:44px;height:44px;border-radius:50%;background:${color};box-shadow:0 2px 8px rgba(0,0,0,.2)"></div>
  </body></html>`
}

export function ChatWidgetSettings(): React.ReactNode {
  const { t } = useApp()
  const client = useQueryClient()
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

  return (
    <div className="grid gap-3 lg:grid-cols-3" data-testid="chat-window-page">
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
              className="h-8 w-14 cursor-pointer rounded-sm border bg-transparent"
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
              value={cfg?.assist_wait_seconds ?? 180}
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
                  {/* WP417：60 秒以上按分钟说（以前 180 秒显示成「3 秒」） */}
                  {s < 60
                    ? t('chat.window.assist_wait.option', { n: String(s) })
                    : t('chat.window.assist_wait.option_min', { n: String(s / 60) })}
                </option>
              ))}
            </select>
          </div>
          {/* WP428（决策 1246 改）：按把握直接答（缺省开）+「严格 / 适中 / 宽松」，不让人填数字 */}
          <div className="flex flex-wrap items-center gap-2 text-[13px]">
            <Switch
              id="chat-auto-answer"
              checked={cfg?.auto_answer !== false}
              aria-label={t('chat.window.auto_answer')}
              data-testid="chat-auto-answer"
              onCheckedChange={(on) =>
                saveSettings.mutate({
                  allowed_origins: cfg?.allowed_origins ?? [],
                  ...(accent === undefined ? {} : { accent }),
                  ...(greeting === '' ? {} : { greeting }),
                  ...(cfg?.assist_wait_seconds === undefined
                    ? {}
                    : { assist_wait_seconds: cfg.assist_wait_seconds }),
                  auto_answer: on,
                })
              }
            />
            <label htmlFor="chat-auto-answer">{t('chat.window.auto_answer')}</label>
            <Hint text={t('chat.window.auto_answer.hint')} />
            {cfg?.auto_answer === false ? null : (
              <select
                aria-label={t('chat.window.auto_answer.strictness')}
                className="ml-auto h-8 rounded-md border bg-transparent px-2 text-[13px]"
                value={cfg?.auto_answer_strictness ?? 'balanced'}
                data-testid="chat-auto-answer-strictness"
                onChange={(e) =>
                  saveSettings.mutate({
                    allowed_origins: cfg?.allowed_origins ?? [],
                    ...(accent === undefined ? {} : { accent }),
                    ...(greeting === '' ? {} : { greeting }),
                    ...(cfg?.assist_wait_seconds === undefined
                      ? {}
                      : { assist_wait_seconds: cfg.assist_wait_seconds }),
                    auto_answer_strictness: e.target.value as ChatAutoAnswerStrictnessView,
                  })
                }
              >
                {(['strict', 'balanced', 'loose'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`chat.window.auto_answer.${k}`)}
                  </option>
                ))}
              </select>
            )}
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
                className={testResult.ok ? 'text-xs text-ws-good' : 'text-xs text-destructive'}
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
            srcDoc={previewDoc(
              accent,
              greeting === '' ? t('chat.window.greeting.placeholder') : greeting,
            )}
            sandbox=""
          />
        </CardContent>
      </Card>
    </div>
  )
}
