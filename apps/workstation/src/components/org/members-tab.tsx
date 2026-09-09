/**
 * 成员页：谁在这个工作区、各拿着什么岗位、管哪几个店，以及邀请与撤销。
 *
 * 邀请在本地档是**一条链接**：这台机器没有邮箱通道时不假装"已发送"，
 * 而是把链接摆出来让你自己转发给同事（20 §5）。链接里那把 token 只出现这一次。
 */
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgInvitationView, OrgMemberView, OrgPositionView } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function MembersTab({
  members,
  invitations,
  positions,
  freshInvite,
  busy,
  error,
  onInvite,
  onRevoke,
  onRemove,
}: {
  members: OrgMemberView[]
  invitations: OrgInvitationView[]
  positions: OrgPositionView[]
  freshInvite?: OrgInvitationView
  busy: boolean
  error?: string
  onInvite(input: { email: string; name?: string; position_id?: string }): void
  onRevoke(assignment_id: string): void
  onRemove(person_id: string): void
}): React.ReactNode {
  const { t } = useApp()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [position, setPosition] = useState('')

  const pending = invitations.filter((i) => !i.used)

  return (
    <div className="flex flex-col gap-3">
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-destructive" data-testid="members-error">
          {error}
        </p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('org.members.invite')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-email">{t('org.members.email')}</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                placeholder="colleague@company.com"
                onChange={(e) => {
                  setEmail(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-name">{t('org.members.name')}</Label>
              <Input
                id="invite-name"
                value={name}
                onChange={(e) => {
                  setName(e.target.value)
                }}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="invite-position">{t('org.members.position')}</Label>
              <select
                id="invite-position"
                className="h-9 rounded-md border bg-background px-2 text-sm"
                value={position}
                onChange={(e) => {
                  setPosition(e.target.value)
                }}
              >
                <option value="">{t('org.members.position.none')}</option>
                {positions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Button
              size="sm"
              data-testid="invite-submit"
              disabled={email.trim() === '' || busy}
              onClick={() => {
                onInvite({
                  email: email.trim(),
                  ...(name.trim() === '' ? {} : { name: name.trim() }),
                  ...(position === '' ? {} : { position_id: position }),
                })
                setEmail('')
                setName('')
              }}
            >
              {t('org.members.invite.send')}
            </Button>
          </div>
          {freshInvite?.url === undefined ? null : (
            <div className="flex flex-col gap-1 rounded-md border bg-muted/40 p-2">
              <span className="text-xs text-muted-foreground">{t('org.members.invite.link')}</span>
              <code className="break-all text-xs" data-testid="invite-link">
                {freshInvite.url}
              </code>
            </div>
          )}
          {pending.length === 0 ? null : (
            <div className="flex flex-col gap-1 text-xs text-muted-foreground">
              <span>{t('org.members.invite.pending')}</span>
              {pending.map((i) => (
                <span key={i.id} data-testid="invite-pending">
                  {i.email}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <div className="flex flex-col gap-3">
        {members
          .filter((m) => m.left_at === undefined)
          .map((m) => (
            <Card key={m.person_id} data-testid="member-row" data-person={m.person_id}>
              <CardHeader className="flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm">
                  {m.name}
                  <span className="ml-2 font-normal text-muted-foreground text-xs">{m.email}</span>
                </CardTitle>
                <div className="flex items-center gap-2">
                  {m.positions.map((p) => (
                    <Badge key={p.id} variant="secondary">
                      {p.name}
                    </Badge>
                  ))}
                  {m.role === 'owner' ? null : (
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="member-remove"
                      disabled={busy}
                      onClick={() => {
                        onRemove(m.person_id)
                      }}
                    >
                      {t('org.members.remove')}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2 text-sm">
                {m.assignments.length === 0 ? (
                  <span className="text-muted-foreground">{t('org.members.no_position')}</span>
                ) : (
                  m.assignments.map((a) => (
                    <div
                      key={a.assignment_id}
                      className="flex items-center justify-between gap-2 rounded-md border px-2 py-1"
                      data-testid="member-assignment"
                    >
                      <span>
                        {a.role_name}
                        <span className="ml-2 text-muted-foreground text-xs">
                          {a.ranges.length === 0
                            ? t('org.assign.range.none')
                            : a.ranges.map((r) => r.id).join('、')}
                        </span>
                        {a.unassigned_range ? (
                          <Badge variant="destructive" className="ml-2">
                            {t('org.members.unassigned_range')}
                          </Badge>
                        ) : null}
                      </span>
                      <Button
                        size="sm"
                        variant="ghost"
                        data-testid="assignment-revoke"
                        disabled={busy}
                        onClick={() => {
                          onRevoke(a.assignment_id)
                        }}
                      >
                        {t('org.members.revoke')}
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  )
}
