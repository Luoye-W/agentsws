/**
 * 成员页：谁在这个工作区、各拿着什么岗位、管哪几个店，以及邀请与撤销。
 *
 * 邀请在本地档是**一条链接**：这台机器没有邮箱通道时不假装"已发送"，
 * 而是把链接摆出来让你自己转发给同事（20 §5）。链接里那把 token 只出现这一次。
 */
import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Hint } from '@/components/ui/hint'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  OffboardReportView,
  OrgInvitationView,
  OrgMemberView,
  OrgPositionView,
} from '@/lib/api'
import { ensureSession, getPositions, offboardMember } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function MembersTab({
  members,
  invitations,
  positions,
  freshInvite,
  busy,
  error,
  workspaceId,
  onInvite,
  onRevoke,
  onRemove,
  onOffboarded,
}: {
  members: OrgMemberView[]
  invitations: OrgInvitationView[]
  positions: OrgPositionView[]
  freshInvite?: OrgInvitationView
  busy: boolean
  error?: string
  /** 40 §1.2 离职动作要用；不给就从成员里推（工作台单工作区）。 */
  workspaceId?: string
  onInvite(input: { email: string; name?: string; position_id?: string }): void
  onRevoke(assignment_id: string): void
  onRemove(person_id: string): void
  /** 离职跑完之后让上层重取成员与邀请（不给也行，报告卡照样出）。 */
  onOffboarded?(report: OffboardReportView): void
}): React.ReactNode {
  const { t } = useApp()
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [position, setPosition] = useState('')

  // 40 §1.2：离职是一个正式动作，不是「移出工作区」的别名。
  // 这张表单只问三件事——谁接手、他的个人层怎么办、他的个人记忆怎么办；
  // 三个选项对应的正是 owner 仅有的那三个动作（迁移 / 归档 / 销毁），没有第四条路。
  const [leaving, setLeaving] = useState<OrgMemberView | null>(null)
  const [successor, setSuccessor] = useState('')
  const [personalLayer, setPersonalLayer] = useState<'archive' | 'erase'>('archive')
  const [memoryPolicy, setMemoryPolicy] = useState<'migrate_work' | 'erase'>('migrate_work')
  const [report, setReport] = useState<OffboardReportView | null>(null)

  // 工作区 id 与 owner 那条岗位都已经在 query 缓存里（org.tsx 取过），
  // 这里同 key 再问一次是命中缓存，不多发一次请求——所以离职这块不用往上层加 props。
  const session = useQuery({ queryKey: ['session'], queryFn: ensureSession })
  const mine = useQuery({ queryKey: ['positions'], queryFn: getPositions })
  const ownerAssignment = mine.data?.positions.find(
    (p) => p.role_id === 'common.owner',
  )?.position_id
  const ws = workspaceId ?? session.data?.workspace.id ?? ''
  const offboard = useMutation({
    mutationFn: (input: { person_id: string }) =>
      offboardMember(
        ws,
        input.person_id,
        {
          ...(successor === '' ? {} : { handover_to: successor }),
          personal_layer: personalLayer,
          memory: memoryPolicy,
        },
        ownerAssignment,
      ),
    onSuccess: (out) => {
      setReport(out)
      setLeaving(null)
      setSuccessor('')
      onOffboarded?.(out)
    },
  })

  const pending = invitations.filter((i) => !i.used)
  const active = members.filter((m) => m.left_at === undefined)

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

      {report === null ? null : (
        <Card data-testid="offboard-report">
          <CardHeader>
            <CardTitle className="text-sm">
              {t('org.members.offboard.report')}
              <Badge variant="secondary" className="ml-2">
                {report.status === 'done'
                  ? t('org.members.offboard.done')
                  : report.status === 'pending_approval'
                    ? t('org.members.offboard.pending')
                    : t('org.members.offboard.partial')}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p>{report.summary}</p>
            {report.manual.length === 0 ? null : (
              <div className="text-muted-foreground text-xs">
                <span>{t('org.members.offboard.manual')}</span>
                <ul className="list-disc pl-4">
                  {report.manual.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {leaving === null ? null : (
        <Card data-testid="offboard-form">
          <CardHeader>
            <CardTitle className="flex items-center gap-1 text-sm">
              {t('org.members.offboard.title', { name: leaving.name })}
              <Hint text={t('org.members.offboard.intro')} />
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offboard-successor">{t('org.members.offboard.handover')}</Label>
                <select
                  id="offboard-successor"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={successor}
                  onChange={(e) => {
                    setSuccessor(e.target.value)
                  }}
                >
                  <option value="">{t('org.members.offboard.handover.fallback')}</option>
                  {active
                    .filter((m) => m.person_id !== leaving.person_id)
                    .map((m) => (
                      <option key={m.person_id} value={m.person_id}>
                        {m.name}
                      </option>
                    ))}
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offboard-layer">{t('org.members.offboard.personal_layer')}</Label>
                <select
                  id="offboard-layer"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={personalLayer}
                  onChange={(e) => {
                    setPersonalLayer(e.target.value as 'archive' | 'erase')
                  }}
                >
                  <option value="archive">
                    {t('org.members.offboard.personal_layer.archive')}
                  </option>
                  <option value="erase">{t('org.members.offboard.personal_layer.erase')}</option>
                </select>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="offboard-memory">{t('org.members.offboard.memory')}</Label>
                <select
                  id="offboard-memory"
                  className="h-9 rounded-md border bg-background px-2 text-sm"
                  value={memoryPolicy}
                  onChange={(e) => {
                    setMemoryPolicy(e.target.value as 'migrate_work' | 'erase')
                  }}
                >
                  <option value="migrate_work">
                    {t('org.members.offboard.memory.migrate_work')}
                  </option>
                  <option value="erase">{t('org.members.offboard.memory.erase')}</option>
                </select>
              </div>
            </div>
            {offboard.error === null || offboard.error === undefined ? null : (
              <p role="alert" className="text-destructive text-sm" data-testid="offboard-error">
                {offboard.error instanceof Error ? offboard.error.message : String(offboard.error)}
              </p>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                data-testid="offboard-submit"
                disabled={offboard.isPending}
                onClick={() => {
                  offboard.mutate({ person_id: leaving.person_id })
                }}
              >
                {t('org.members.offboard.submit')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLeaving(null)
                }}
              >
                {t('org.members.offboard.cancel')}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="flex flex-col gap-3">
        {active.map((m) => (
          <Card key={m.person_id} data-testid="member-row" data-person={m.person_id}>
            <CardHeader className="flex-row items-center justify-between gap-2">
              <CardTitle className="text-sm">
                {/* 41 §1：点人 → 他的 profile 页（能问他的代理、能约时间） */}
                <Link
                  to={`/people/${encodeURIComponent(m.person_id)}`}
                  className="hover:underline"
                  data-testid="member-profile-link"
                >
                  {m.name}
                </Link>
                <span className="ml-2 font-normal text-muted-foreground text-xs">{m.email}</span>
              </CardTitle>
              <div className="flex items-center gap-2">
                {m.positions.map((p) => (
                  <Badge key={p.id} variant="secondary">
                    {p.name}
                  </Badge>
                ))}
                {m.role === 'owner' ? null : (
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      data-testid="member-offboard"
                      disabled={busy || offboard.isPending}
                      onClick={() => {
                        setReport(null)
                        setLeaving(m)
                      }}
                    >
                      {t('org.members.offboard')}
                    </Button>
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
                  </>
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
