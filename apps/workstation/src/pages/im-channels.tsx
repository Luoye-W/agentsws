/**
 * 消息渠道页（WP85；54 §5）。
 *
 * 两格，说的是两件不一样的事：
 *
 * 1. **微信（我自己的）**——这不是客服渠道。扫完码之后，它只是「你和你自己的
 *    代理的私聊」：同事加不了这个号，也拉不进群，它不会替你回任何人。
 *    这一段文案必须在界面上说清楚，因为微信这个入口太容易被当成客服入口用，
 *    而条款 6.1 / 6.4 违规是**牵连主微信账号**的——被封的是用户本人的号。
 * 2. **企业微信机器人（公司的）**——这一格才是团队用的：群里 @ 它，它按提问人的
 *    身份去问那个人自己的代理。
 *
 * 两格共同的一条：**审批动作不在 IM 里做**。卡片在微信 / 企业微信里只有一段
 * 文字摘要 + 一条「去工作台处理」的链接，按钮一个都没有（凭据与决策不经 IM）。
 *
 * WP210（Luoye 09-30 减字）：每张渠道卡只留名字 + 问号（一句话与来龙去脉）+ 状态 + 主按钮；
 * 例外是微信的条款风险（牵连主微信号），一行留在卡上（Fable 09-30 定）；「只存本机、不经 AI」这类安全承诺和底部那句「只投摘要 + 链接」统一进页头
 * 的问号，说一次。
 *
 * WP211：再加飞书 / 钉钉两张团队卡（`components/im/team-bot-card.tsx`，同一套少字样式，图标用官网
 * favicon）。三条团队渠道的公司应用凭据只给负责人与公司管理员填 / 改 / 断开（Fable 09-30），别人只看
 * 状态；每人自己的「绑定我的账号」人人可用。
 *
 * WP351（Luoye 10-16）：最下面多一个渠道「网站聊天窗」——装在商家网站上给访客用的挂件
 * （外观、嵌入代码、转发方式 / 托管档；原「聊天窗」页的设置那一半）。访客的对话在「消息 → 网站聊天」。
 * 名下有网站在线客服才出；锚点 `#site-chat`（⌘K、客服岗位页、网站聊天列表顶上的齿轮都跳到这里）。
 */
import { useQuery } from '@tanstack/react-query'
import { MessageCircle, Users } from 'lucide-react'
import { type ReactNode, useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { ChatWidgetSettings } from '@/components/chat-window/widget-settings'
import { MailboxAutoReply } from '@/components/connections/mailbox-auto-reply'
import { StatusIcons } from '@/components/design'
import { TutorialLink } from '@/components/help/tutorial-link'
import { BindRow, TeamBotCard } from '@/components/im/team-bot-card'
import { WechatBind } from '@/components/im/wechat-bind'
import { WecomBotForm } from '@/components/im/wecom-bot-form'
import { useHoldsSiteChat } from '@/components/messages/site-chat'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint, SafetyNote } from '@/components/ui/hint'
import { Skeleton } from '@/components/ui/skeleton'
import { getImStatus, listConnections } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** WP351：「网站聊天窗」这个渠道（挂件设置）。 */
function SiteChatChannel({ bare = false }: { bare?: boolean }): ReactNode {
  const { t } = useApp()
  const { hash } = useLocation()
  // ⌘K / 客服岗位页带着 `#site-chat` 过来：滚到这一块
  useEffect(() => {
    if (hash === '#site-chat')
      globalThis.document?.getElementById('site-chat')?.scrollIntoView?.({ block: 'start' })
  }, [hash])
  return (
    <section id="site-chat" className="flex scroll-mt-4 flex-col gap-3" data-testid="im-site-chat">
      <h2 className="flex items-center gap-1.5 text-base font-semibold" hidden={bare}>
        {t('nav.chat_window')}
        <Hint text={t('im.site_chat.hint')} testId="im-site-chat-what" />
      </h2>
      <ChatWidgetSettings />
    </section>
  )
}

/**
 * WP440（docs/108 M9）：「消息渠道 → 每只邮箱」——客服信「有把握就直接回」+ 档位，一只邮箱一行。
 * 没连邮箱就一个字都不出（连邮箱在「账号连接」）。
 */
function MailboxChannels(): ReactNode {
  const { t } = useApp()
  const list = useQuery({ queryKey: ['connections'], queryFn: () => listConnections() })
  const boxes = (list.data?.connections ?? []).filter((c) => c.service === 'imap_smtp')
  if (boxes.length === 0) return null
  return (
    <section className="flex flex-col gap-3" data-testid="im-mailboxes">
      <h2 className="flex items-center gap-1.5 text-base font-semibold">
        {t('im.mailboxes.title')}
        <Hint text={t('im.mailboxes.hint')} testId="im-mailboxes-what" />
      </h2>
      <Card>
        <CardContent className="flex flex-col divide-y py-1">
          {boxes.map((c) => (
            <div
              key={c.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2"
              data-testid="im-mailbox-row"
            >
              <span className="min-w-0 truncate text-[13px] font-medium">
                {c.identity?.account_id ?? c.alias}
              </span>
              <MailboxAutoReply connectionId={c.id} />
            </div>
          ))}
        </CardContent>
      </Card>
    </section>
  )
}

/**
 * WP356（决策 923）：设置弹窗里只要其中一块——`mine` 你自己的微信（个人 → 通知）、`team` 三条团队机器人、
 * `site` 网站聊天窗（品牌 → 消息渠道）。给了 `part` 就不画页头（说明进弹窗那一项的一句话与问号）。
 */
export type ImChannelsPart = 'mine' | 'team' | 'site'

export function ImChannelsPage({ part }: { part?: ImChannelsPart } = {}): ReactNode {
  const { t } = useApp()
  const holdsSiteChat = useHoldsSiteChat()
  const status = useQuery({
    queryKey: ['im', 'status'],
    queryFn: getImStatus,
    // WP211：飞书 / 钉钉存好之后在后台连，连上 / 连不上之前隔一会儿问一次
    refetchInterval: (q) => {
      const d = q.state.data
      // WP308：企业微信也有连接状态了（老服务端没有 state，就当连上 / 连接中）
      const wecomBot =
        d?.wecom === undefined
          ? undefined
          : {
              configured: d.wecom.configured,
              state: d.wecom.state ?? (d.wecom.connected ? 'connected' : 'connecting'),
            }
      const bots = [d?.feishu, d?.dingtalk, wecomBot].filter((b) => b?.configured === true)
      const busy = bots.some((b) => b?.state === 'connecting' || b?.state === 'reconnecting')
      // WP306：连上之后也慢慢问着——长连接断了卡片要如实变，不能一直绿勾
      return busy ? 1500 : bots.length > 0 ? 30_000 : false
    },
  })
  if (status.isPending) return <Skeleton className="h-96 w-full" />
  if (status.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('error.generic')}：{status.error.message}
      </p>
    )
  }

  const wechat = status.data?.wechat
  const wecom = status.data?.wecom
  // WP211（Fable 09-30）：公司的应用凭据只给负责人与公司管理员；别人只看状态
  const canManage = status.data?.can_manage === true

  const show = (p: ImChannelsPart): boolean => part === undefined || part === p
  return (
    <div className="flex flex-col gap-6" data-im-part={part}>
      <div hidden={part !== undefined}>
        <h1 className="flex items-center gap-3 text-[22px] font-semibold">
          {t('im.title')}
          <TutorialLink slug="im-channels" className="font-normal" />
        </h1>
        {/*
          WP157：页头一句；WP210：「两条通道是两件事」+ 安全承诺（凭据只存本机、不经 AI）+
          「只投摘要 + 链接」都在这一个问号里说一次，卡上不再各说一遍
        */}
        <p className="mt-1 flex max-w-3xl items-center gap-1 text-sm text-muted-foreground">
          {t('im.intro')}
          <Hint
            text={[
              t('im.intro.hint'),
              t('im.wechat.local'),
              t('im.wecom.safety'),
              t('im.cards.note'),
            ].join(' ')}
            testId="im-header-hint"
          />
        </p>
      </div>

      {/* ── 微信：我和我自己的代理 ─────────────────────────────── */}
      {show('mine') ? (
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-1.5 text-base">
              {t('im.wechat.title')}
              {/* WP210：一句话 + 来龙去脉 + 它不做的三件事，都在这一个问号里 */}
              <Hint
                text={[
                  t('im.wechat.line'),
                  t('im.wechat.what'),
                  t('im.wechat.not.colleagues'),
                  t('im.wechat.not.group'),
                  t('im.wechat.not.approve'),
                ].join(' ')}
                testId="im-wechat-what"
              />
            </CardTitle>
            {/*
            WP214（36 §7 第四档）：在收信 / 要重连 / 没绑 → 一个状态小图标，连的是哪个微信账号在 tooltip 里
          */}
            <StatusIcons
              testId="im-wechat-state"
              items={[
                {
                  key: 'wechat',
                  label: t('im.wechat.title'),
                  state: wechat?.bound !== true ? 'unknown' : wechat.live ? 'ok' : 'fail',
                  stateText:
                    wechat?.bound !== true
                      ? t('im.state.unbound')
                      : wechat.live
                        ? t('im.state.live')
                        : t('im.state.paused'),
                  icon: MessageCircle,
                  ...(wechat?.bound === true && wechat.account_id !== undefined
                    ? { detail: t('im.wechat.account', { account: wechat.account_id }) }
                    : {}),
                },
              ]}
            />
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {/*
            WP210 例外（Fable 09-30 定）：条款风险关系到用户的主微信号会不会被封，不能只藏在问号里——
            原话一行留在卡上，条款出处在它旁边的问号里。
          */}
            <SafetyNote text={t('im.wechat.terms.short')} hint={t('im.wechat.terms')} />
            {/* WP334：扫码那一块与连接卡共用一个件 */}
            <WechatBind wechat={wechat} />
          </CardContent>
        </Card>
      ) : null}

      {/* ── 企业微信：团队那一条 ───────────────────────────────── */}
      {show('team') ? (
        <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="flex items-center gap-1.5 text-base">
                {t('im.wecom.title')}
                <Hint text={`${t('im.wecom.line')} ${t('im.wecom.what')}`} testId="im-wecom-what" />
              </CardTitle>
              {/* WP214：在收信 / 连接中 / 没配 → 一个状态小图标；BotID 在 tooltip 里 */}
              <StatusIcons
                testId="im-wecom-state"
                items={[
                  {
                    key: 'wecom',
                    label: t('im.wecom.title'),
                    state:
                      wecom?.configured !== true
                        ? 'unknown'
                        : wecom.connected
                          ? 'ok'
                          : wecom.state === 'failed'
                            ? 'fail'
                            : 'pending',
                    stateText:
                      wecom?.configured !== true
                        ? t('im.state.unconfigured')
                        : wecom.connected
                          ? t('im.state.live')
                          : wecom.state === 'failed'
                            ? t('im.state.failed')
                            : wecom.state === 'reconnecting'
                              ? t('im.state.reconnecting')
                              : t('im.state.connecting'),
                    icon: Users,
                    ...(wecom?.configured === true
                      ? {
                          detail: wecom.error ?? t('im.wecom.saved', { bot: wecom.bot_id ?? '' }),
                        }
                      : {}),
                  },
                ]}
              />
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {/* WP334：原生表单与连接卡共用一个件（13 §4.3；只有负责人 / 公司管理员能填） */}
              <WecomBotForm canManage={canManage} />
              {/* WP211：企业微信也走同一套「绑定我的账号」 */}
              {wecom?.configured === true ? (
                <BindRow channel="wecom" bound={wecom.me_bound === true} />
              ) : null}
            </CardContent>
          </Card>

          {/* ── WP211：飞书 / 钉钉（团队的）──────────────────────────── */}
          <TeamBotCard
            channel="feishu"
            view={status.data?.feishu}
            accountId={status.data?.feishu?.app_id}
            canManage={canManage}
          />
          <TeamBotCard
            channel="dingtalk"
            view={status.data?.dingtalk}
            accountId={status.data?.dingtalk?.client_id}
            canManage={canManage}
          />
        </>
      ) : null}

      {/* ── WP351：网站聊天窗（挂件设置；对话在「消息 → 网站聊天」）──────── */}
      {holdsSiteChat && show('site') ? <SiteChatChannel bare={part !== undefined} /> : null}
      {/* WP440：每只邮箱的「有把握就直接回」（品牌 → 消息渠道里同一块） */}
      {show('site') ? <MailboxChannels /> : null}
    </div>
  )
}
