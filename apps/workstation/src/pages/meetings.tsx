/**
 * 会议列表 + 新建（37 §4）。
 *
 * 列表只给一句话就能认出这个会：标题、时间、与会者、有几份记录、有没有外部人。
 * 新建表单只问必须问的四样：标题、开始、结束、与会者；其余在会议页里改。
 */
import type { Meeting } from '@agentsws/contracts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { type FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { createMeeting, getMeetings } from '@/lib/api'
import { useApp } from '@/lib/app-context'

function localInput(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function participantsOf(raw: string): { name: string; external: boolean }[] {
  return raw
    .split(/[,，、\n]/)
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((s) => ({
      name: s.replace(/\s*[（(]外部[）)]\s*$/, ''),
      external: /[（(]外部[）)]\s*$/.test(s),
    }))
}

function MeetingRow({ meeting, onOpen }: { meeting: Meeting; onOpen(): void }): React.ReactNode {
  const { t } = useApp()
  const external = meeting.participants.some((p) => p.external === true)
  const names = meeting.participants
    .map((p) => p.name ?? p.email ?? p.person_id ?? '')
    .filter((n) => n !== '')
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full flex-col gap-1 rounded-md border p-3 text-left transition-colors hover:bg-accent/40"
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{meeting.title}</span>
        {external ? (
          <Badge variant="outline" className="text-[11px]">
            {t('meeting.external')}
          </Badge>
        ) : null}
        <Badge variant="secondary" className="text-[11px]">
          {t(`meeting.status.${meeting.status}`)}
        </Badge>
      </div>
      <div className="text-xs text-muted-foreground">
        {meeting.start.replace('T', ' ').slice(0, 16)} ·{' '}
        {t('meeting.records.count', {
          n: meeting.records.length,
        })}
        {names.length === 0 ? '' : ` · ${names.join('、')}`}
      </div>
    </button>
  )
}

export function MeetingsPage(): React.ReactNode {
  const { t } = useApp()
  const navigate = useNavigate()
  const client = useQueryClient()
  const [open, setOpen] = useState(false)
  const now = new Date()
  const [title, setTitle] = useState('')
  const [start, setStart] = useState(localInput(now))
  const [end, setEnd] = useState(localInput(new Date(now.getTime() + 3_600_000)))
  const [people, setPeople] = useState('')

  const meetings = useQuery({ queryKey: ['meetings'], queryFn: getMeetings })

  const create = useMutation({
    mutationFn: () =>
      createMeeting({
        title: title.trim(),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        participants: participantsOf(people),
      }),
    onSuccess: (meeting) => {
      setOpen(false)
      setTitle('')
      setPeople('')
      void client.invalidateQueries({ queryKey: ['meetings'] })
      navigate(`/meetings/${meeting.id}`)
    },
  })

  const submit = (e: FormEvent): void => {
    e.preventDefault()
    if (title.trim() === '') return
    create.mutate()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-semibold">{t('meetings.title')}</h1>
        <Button
          size="sm"
          onClick={() => {
            setOpen((v) => !v)
          }}
        >
          <Plus aria-hidden />
          {t('meetings.new')}
        </Button>
      </div>

      {open ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t('meetings.new')}</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="flex flex-col gap-3" onSubmit={submit}>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-title">{t('meetings.form.title')}</Label>
                <Input
                  id="m-title"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value)
                  }}
                />
              </div>
              <div className="flex flex-wrap gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="m-start">{t('meetings.form.start')}</Label>
                  <Input
                    id="m-start"
                    type="datetime-local"
                    value={start}
                    onChange={(e) => {
                      setStart(e.target.value)
                    }}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="m-end">{t('meetings.form.end')}</Label>
                  <Input
                    id="m-end"
                    type="datetime-local"
                    value={end}
                    onChange={(e) => {
                      setEnd(e.target.value)
                    }}
                  />
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="m-people">{t('meetings.form.participants')}</Label>
                <Input
                  id="m-people"
                  placeholder={t('meetings.form.participants.hint')}
                  value={people}
                  onChange={(e) => {
                    setPeople(e.target.value)
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <Button type="submit" size="sm" disabled={create.isPending || title.trim() === ''}>
                  {t('meetings.form.submit')}
                </Button>
                {create.error === null ? null : (
                  <span role="alert" className="text-xs text-destructive">
                    {create.error.message}
                  </span>
                )}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      {meetings.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : (meetings.data ?? []).length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('meetings.empty')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          {(meetings.data ?? []).map((m) => (
            <MeetingRow
              key={m.id}
              meeting={m}
              onOpen={() => {
                navigate(`/meetings/${m.id}`)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
