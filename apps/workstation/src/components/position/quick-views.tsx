/**
 * WP241：职责专属快捷视图（docs/54 §7.5）——放在「工作」视图栏后面，一点就开。
 *
 * 里面**原样复用**已有的那几块（社媒内容日历、群发向导、红人工作台、B2B 开发信 / 业务面板、
 * 在线客服的两个入口），不重画；要拍板的照旧出卡，在上面卡片流里定。
 * 请求挂的是**那条职责本人那条分配**（额度与权限从它来，同职责页）。
 */
import { ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { B2bOutboundPanel } from '@/components/b2b/outbound-panel'
import { B2bSalesPanel } from '@/components/b2b/sales-panel'
import { KOL_LIBRARY } from '@/components/kol/kol-library-status'
import { channelOfRole } from '@/components/kol/kol-panel'
import { openLibrary } from '@/components/library/library-intent'
import { SITE_CHAT_HREF, SITE_CHAT_SETTINGS_HREF } from '@/components/messages/site-chat'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { OwnSubQueue } from '@/components/social/own-sub-queue'
import { RedditWatch } from '@/components/social/reddit-watch'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { SocialCalendar, socialChannelOfRole } from '@/components/social/social-calendar'
import { SocialThreads } from '@/components/social/social-threads'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import type { QuickView } from '@/lib/position-work'

/**
 * WP57（48 §3 L1）：网站在线客服的入口——它的产出在对话里，不在图表里。
 * （WP241 从 `pages/position.tsx` 挪来。）WP351：原「聊天窗」页拆成两半，这里两个钮各去一半：
 * 访客对话（「消息 → 网站聊天」）、挂件设置（「消息渠道 → 网站聊天窗」）。
 */
export function ChatWindowEntry(): ReactNode {
  const { t } = useApp()
  return (
    <Card data-testid="chat-window-entry">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t('chat.window.entry.title')}
          <Hint text={t('chat.window.entry.subtitle')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild>
            <Link to={SITE_CHAT_HREF} data-testid="chat-window-entry-chat">
              {t('chat.window.entry.open')}
            </Link>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <Link to={SITE_CHAT_SETTINGS_HREF} data-testid="chat-window-entry-settings">
              {t('chat.window.entry.settings')}
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/** WP504：「快捷视图 · 红人」→ 在第三栏开红人库（那条渠道）。 */
function KolLibraryEntry({ channel }: { channel: string }): ReactNode {
  const { t } = useApp()
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="kol-library-entry">
      <span className="text-ws-muted-fg">{t('kol.lib.moved')}</span>
      <Button
        size="sm"
        variant="outline"
        data-testid="kol-library-entry-open"
        onClick={() => {
          openLibrary(KOL_LIBRARY, { tab: 'creators', params: { channel } })
        }}
      >
        {t('kol.lib.open')}
      </Button>
    </div>
  )
}

export function ChatSandboxEntry(): ReactNode {
  const { t } = useApp()
  return (
    <Card data-testid="chat-sandbox-entry">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5 text-sm">
          {t('chat.title')}
          <Hint text={t('chat.subtitle')} />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 text-sm text-muted-foreground">
        <div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/chat">{t('chat.entry.open')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * 页签上的字。同一种视图有好几条职责时（红人营销五条渠道各一个「红人工作台」），
 * WP295：页签只写职责名——以前写「红人工作台 · YouTube 红人」，五个挤成两行；前面的职责图标
 * 已经说明是哪种视图，全称进悬停提示（{@link quickTitle}）。
 */
export function quickLabel(t: (k: string) => string, view: QuickView, withDuty: boolean): string {
  return withDuty ? view.role_name : t(`pos2.quick.${view.kind}`)
}

/** 页签的悬停提示：视图名 · 职责名。 */
export function quickTitle(t: (k: string) => string, view: QuickView): string {
  return `${t(`pos2.quick.${view.kind}`)} · ${view.role_name}`
}

function QuickBody({ view }: { view: QuickView }): ReactNode {
  const social = socialChannelOfRole(view.role_id)
  switch (view.kind) {
    case 'schedule':
      return social === undefined ? null : (
        <SocialCalendar assignment={view.assignment_id} channel={social} />
      )
    case 'broadcast':
      return social === undefined ? null : (
        <SocialBroadcast assignment={view.assignment_id} channel={social} />
      )
    case 'kol': {
      // WP504（决策 1765 / 1778 A）：红人工作台搬进了红人库（第三栏）——这里只留一个进去的口子
      const channel = channelOfRole(view.role_id)
      return channel === undefined ? null : <KolLibraryEntry channel={channel} />
    }
    case 'reddit_watch':
      return <RedditWatch assignment={view.assignment_id} />
    case 'modqueue':
      return <OwnSubQueue assignment={view.assignment_id} />
    case 'threads':
      return social === undefined ? null : (
        <SocialThreads assignment={view.assignment_id} channel={social} />
      )
    case 'outbound':
      return <B2bOutboundPanel assignment={view.assignment_id} />
    case 'sales':
      return <B2bSalesPanel assignment={view.assignment_id} />
    default:
      return (
        <div className="flex flex-col gap-4">
          <ChatWindowEntry />
          <ChatSandboxEntry />
        </div>
      )
  }
}

export function QuickViewPanel({ view }: { view: QuickView }): ReactNode {
  const { t } = useApp()
  return (
    <section
      className="flex flex-col gap-3 rounded-xl border bg-card p-3"
      data-testid="work-quick-view"
      data-kind={view.kind}
      data-role={view.role_id}
    >
      <header className="flex flex-wrap items-center gap-2 px-1">
        <DutyIcon role_id={view.role_id} size={16} />
        {/*
          WP295（docs/96 P6 页面零说明）：标题后面那句「职责「X」的专属工具」与面板底下那一行
          「要你拍板的都出成卡……」收进问号；标题只写「视图 · 职责」。
        */}
        <h4 className="text-sm font-medium">{quickTitle(t, view)}</h4>
        <Hint text={t('pos2.quick.note')} testId="work-quick-note" />
        <Link
          className="ws-link-muted ml-auto inline-flex items-center gap-0.5 text-xs"
          to={`/positions/${encodeURIComponent(view.assignment_id)}/duties/${encodeURIComponent(view.role_id)}`}
          data-testid="work-quick-open-duty"
        >
          {t('pos2.quick.open_duty')}
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </header>
      <QuickBody view={view} />
    </section>
  )
}
