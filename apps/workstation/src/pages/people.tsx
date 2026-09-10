/**
 * 同事名单与别人的 profile 页（41 §1.2 / §1.3）。
 *
 * `/people` 是名单（公司页成员点进来的落点），`/people/:id` 是一个人的 profile。
 *
 * 一条纪律：**藏起来的字段照实说藏了**。服务端回的 `hidden_fields` 里有哪一格，
 * 界面上就在那一格写"这个要问本人"，而不是假装那个字段不存在——后者会让人以为
 * "他没有岗位"，而真相是"他不想让你看"。
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { AskSecretary } from '@/components/secretary/ask-secretary'
import { MeetDialog } from '@/components/secretary/meet-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { getPersonProfile, listPeople, type ProfileFieldName } from '@/lib/api'
import { useApp } from '@/lib/app-context'

export function PeoplePage(): React.ReactNode {
  const { t } = useApp()
  const people = useQuery({ queryKey: ['secretary', 'people'], queryFn: listPeople })

  if (people.data === undefined) return <Skeleton className="h-64 w-full" />

  return (
    <div className="flex flex-col gap-4" data-testid="people-page">
      <h1 className="font-semibold text-base">{t('people.title')}</h1>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {people.data.map((p) => (
          <Card key={p.person_id} data-testid="person-card" data-person={p.person_id}>
            <CardHeader>
              <CardTitle className="text-sm">
                <Link to={`/people/${encodeURIComponent(p.person_id)}`} className="hover:underline">
                  {p.name}
                </Link>
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <div className="flex flex-wrap gap-1.5">
                {p.positions.map((r) => (
                  <Badge key={r.role_id} variant="secondary">
                    {r.role_name}
                  </Badge>
                ))}
              </div>
              {p.in_progress === undefined ? null : (
                <span className="text-muted-foreground text-xs">
                  {t('people.in_progress', { n: p.in_progress })}
                </span>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}

function Hidden(): React.ReactNode {
  const { t } = useApp()
  return (
    <span className="text-muted-foreground text-xs" data-testid="person-hidden">
      {t('people.hidden')}
    </span>
  )
}

export function PersonPage(): React.ReactNode {
  const { t } = useApp()
  const { id = '' } = useParams()
  const [meeting, setMeeting] = useState(false)

  const profile = useQuery({
    queryKey: ['secretary', 'person', id],
    enabled: id !== '',
    queryFn: () => getPersonProfile(id),
  })

  if (profile.isPending) return <Skeleton className="h-64 w-full" />
  if (profile.data === undefined)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-sm">{t('people.missing')}</p>
        <Link to="/people" className="text-sm underline">
          {t('people.back')}
        </Link>
      </div>
    )

  const p = profile.data
  const hidden = new Set<ProfileFieldName>(p.hidden_fields)

  return (
    <div className="flex flex-col gap-4" data-testid="person-page" data-person={p.person_id}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="font-semibold text-base">{p.name}</h1>
        <div className="flex items-center gap-2">
          <Link to="/people" className="text-muted-foreground text-xs underline">
            {t('people.back')}
          </Link>
          <Button
            size="sm"
            variant="secondary"
            data-testid="person-meet"
            onClick={() => {
              setMeeting(!meeting)
            }}
          >
            {t('secretary.meet.title')}
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('secretary.profile.positions')}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            {hidden.has('positions') ? (
              <Hidden />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {(p.positions ?? []).map((x) => (
                  <Badge key={x.position_id} variant="secondary">
                    {x.role_name}
                  </Badge>
                ))}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('secretary.profile.ranges')}</span>
            {hidden.has('ranges') ? (
              <Hidden />
            ) : (
              <span>
                {(p.ranges ?? []).length === 0
                  ? '—'
                  : (p.ranges ?? []).map((r) => `${r.kind} ${r.id}`).join('、')}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('secretary.profile.skills')}</span>
            {hidden.has('skills') ? (
              <Hidden />
            ) : (
              <span>
                {(p.skills ?? []).length === 0
                  ? '—'
                  : (p.skills ?? []).map((s) => s.name).join('、')}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">
              {t('secretary.field.availability')}
            </span>
            {hidden.has('availability') ? (
              <Hidden />
            ) : (
              <span>
                {(p.availability?.rules ?? []).map((r) => `${r.from}–${r.to}`).join('、') || '—'}
              </span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-muted-foreground text-xs">{t('secretary.profile.contact')}</span>
            {hidden.has('contact') ? (
              <Hidden />
            ) : (
              <span>
                {p.contact_policy?.prefer === 'direct'
                  ? t('secretary.profile.contact.direct')
                  : t('secretary.profile.contact.secretary')}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {meeting ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('secretary.meet.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <MeetDialog fixedPerson={{ person_id: p.person_id, name: p.name }} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">{t('people.ask')}</CardTitle>
        </CardHeader>
        <CardContent>
          <AskSecretary fixedPerson={{ person_id: p.person_id, name: p.name }} />
        </CardContent>
      </Card>
    </div>
  )
}
