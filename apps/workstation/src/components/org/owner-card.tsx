/**
 * WP234（docs/54 §6.5，Luoye 10-05）：**负责人是身份，不是岗位**。
 *
 * 以前「负责人」排在左栏「岗位」里，和客服、网站运营并排，看着像一摊每天要去做的活。
 * 现在它在「公司」页顶上这一块：谁是负责人、「公司设置与授权」的入口（就是原来那一页，地址不变）、
 * 一个「转交给…」。审批默认收件、授权、额度照样归持有 `common.owner` 的人——机制一行没动。
 *
 * 转交第一版**不收回自己那一条**（理由见 docs/54 §6.5）：转完两个人都是负责人，
 * 原来那位要卸下，去「成员」里撤掉自己那条。
 */
import { ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { useApp } from '@/lib/app-context'

export function OwnerCard({
  title,
  holders,
  candidates,
  settingsHref,
  busy,
  transferred,
  onTransfer,
}: {
  /** 这个身份叫什么（WP196 可以改名：「负责人」「CEO」「海外业务总监」…）。 */
  title: string
  holders: { person_id: string; name: string }[]
  /** 能转交给谁（工作区里还在、还不是负责人的人）。 */
  candidates: { person_id: string; name: string }[]
  /** 「公司设置与授权」那一页（原来左栏那一页）。没有就不出入口。 */
  settingsHref?: string
  busy: boolean
  /** 刚转交给了谁（出一句回执）。 */
  transferred?: string
  onTransfer(person_id: string): void
}): React.ReactNode {
  const { t } = useApp()
  const [to, setTo] = useState('')
  return (
    <Card data-testid="org-owner">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <ShieldCheck aria-hidden className="size-4 text-ws-muted-fg" />
          {title}
          <Hint text={t('org.owner.hint')} />
        </CardTitle>
        <div className="flex flex-wrap items-center gap-1.5" data-testid="org-owner-holders">
          {holders.map((h) => (
            <span
              key={h.person_id}
              className="inline-flex items-center gap-1.5 rounded-full border py-0.5 pr-2 pl-0.5 text-xs"
            >
              <span
                aria-hidden
                className="flex size-5 items-center justify-center rounded-full bg-muted font-medium text-[11px]"
              >
                {h.name.slice(0, 1)}
              </span>
              {h.name}
            </span>
          ))}
        </div>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-2 text-sm">
        {settingsHref === undefined ? null : (
          <Button asChild size="sm" variant="outline" data-testid="org-owner-settings">
            <Link to={settingsHref}>{t('org.owner.settings')}</Link>
          </Button>
        )}
        {candidates.length === 0 ? null : (
          <span className="flex items-center gap-2">
            <select
              aria-label={t('org.owner.transfer')}
              data-testid="org-owner-transfer-to"
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={to}
              onChange={(e) => {
                setTo(e.target.value)
              }}
            >
              <option value="">{t('org.owner.transfer')}</option>
              {candidates.map((c) => (
                <option key={c.person_id} value={c.person_id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="ghost"
              data-testid="org-owner-transfer-go"
              disabled={busy || to === ''}
              onClick={() => {
                onTransfer(to)
                setTo('')
              }}
            >
              {t('org.owner.transfer.go')}
            </Button>
          </span>
        )}
        {transferred === undefined ? null : (
          <p className="w-full text-xs text-muted-foreground" data-testid="org-owner-transferred">
            {t('org.owner.transferred', { name: transferred })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}
