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
import { channelOfRole, KolPanel } from '@/components/kol/kol-panel'
import { DutyIcon } from '@/components/role-icons/role-icon'
import { SocialBroadcast } from '@/components/social/social-broadcast'
import { SocialCalendar, socialChannelOfRole } from '@/components/social/social-calendar'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'
import type { QuickView } from '@/lib/position-work'

/**
 * WP57（48 §3 L1）：网站在线客服的入口——它的产出在对话里，不在图表里。
 * （WP241 从 `pages/position.tsx` 挪来，长相不变。）
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
        <div>
          <Button size="sm" variant="outline" asChild>
            <Link to="/chat-window">{t('chat.window.entry.open')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
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

export function quickLabel(t: (k: string) => string, view: QuickView, withDuty: boolean): string {
  const base = t(`pos2.quick.${view.kind}`)
  return withDuty ? `${base} · ${view.role_name}` : base
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
      const channel = channelOfRole(view.role_id)
      return channel === undefined ? null : (
        <KolPanel assignment={view.assignment_id} channel={channel} />
      )
    }
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
        <h4 className="text-sm font-medium">{t(`pos2.quick.${view.kind}`)}</h4>
        <span className="text-xs text-ws-muted-fg">
          {t('pos2.quick.of', { duty: view.role_name })}
        </span>
        <Link
          className="ml-auto inline-flex items-center gap-0.5 text-xs text-ws-muted-fg hover:text-foreground"
          to={`/positions/${encodeURIComponent(view.assignment_id)}/duties/${encodeURIComponent(view.role_id)}`}
          data-testid="work-quick-open-duty"
        >
          {t('pos2.quick.open_duty')}
          <ArrowUpRight className="size-3" aria-hidden />
        </Link>
      </header>
      <QuickBody view={view} />
      <p className="border-t px-1 pt-2 text-xs text-ws-muted-fg">{t('pos2.quick.note')}</p>
    </section>
  )
}
