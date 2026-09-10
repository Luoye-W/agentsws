/**
 * 「约时间」（41 §1.2 第二行）。
 *
 * 挑一天一个点，发给对方秘书。**约不上不是一句"失败"**——服务端回的是撞在哪、
 * 加几个替代时段，这里把替代时段做成可点的按钮，点一下就换过去再发一次。
 *
 * 发出去只是一张卡：**对方点头才进双方日历**，所以这一步之后日历上什么都不会多。
 */
import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ApiClientError, type MeetSlot, type PersonCard, proposeMeet } from '@/lib/api'
import { useApp } from '@/lib/app-context'

/** 本地 `YYYY-MM-DD` + `HH:MM` → ISO。 */
function slotOf(day: string, time: string, minutes: number): MeetSlot | undefined {
  const start = new Date(`${day}T${time}`)
  if (Number.isNaN(start.getTime())) return undefined
  const end = new Date(start.getTime() + minutes * 60_000)
  return { start: start.toISOString(), end: end.toISOString() }
}

const localDay = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

const localTime = (iso: string): string => {
  const d = new Date(iso)
  return `${`${d.getHours()}`.padStart(2, '0')}:${`${d.getMinutes()}`.padStart(2, '0')}`
}

export function MeetDialog({
  people,
  fixedPerson,
  defaultDay,
  onSent,
}: {
  people?: PersonCard[]
  fixedPerson?: { person_id: string; name: string }
  /** 从日历点进来时带上那一天 */
  defaultDay?: string
  onSent?: () => void
}): React.ReactNode {
  const { t } = useApp()
  const options = people ?? []
  const [who, setWho] = useState(fixedPerson?.person_id ?? options[0]?.person_id ?? '')
  const [title, setTitle] = useState('')
  const [day, setDay] = useState(defaultDay ?? localDay(new Date().toISOString()))
  const [time, setTime] = useState('14:00')
  const [minutes, setMinutes] = useState('30')
  const [sent, setSent] = useState<string | null>(null)
  const [alternatives, setAlternatives] = useState<MeetSlot[]>([])
  const [conflict, setConflict] = useState<string | null>(null)

  const target = fixedPerson?.person_id ?? who

  const send = useMutation({
    mutationFn: (slot: MeetSlot) =>
      proposeMeet(target, {
        title: title.trim() === '' ? t('secretary.meet.title') : title.trim(),
        candidates: [slot],
        duration: Number(minutes) || 30,
      }),
    onSuccess: (out) => {
      setSent(out.id)
      setConflict(null)
      setAlternatives([])
      onSent?.()
    },
    onError: (err) => {
      setSent(null)
      if (!(err instanceof ApiClientError)) return
      setConflict(err.message)
      const alts = err.details?.alternatives
      setAlternatives(Array.isArray(alts) ? (alts as MeetSlot[]) : [])
    },
  })

  const submit = (): void => {
    const slot = slotOf(day, time, Number(minutes) || 30)
    if (slot === undefined || target === '') return
    send.mutate(slot)
  }

  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="meet-dialog">
      <div className="grid gap-3 sm:grid-cols-2">
        {fixedPerson === undefined ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="meet-who">{t('secretary.meet.who')}</Label>
            <select
              id="meet-who"
              data-testid="meet-who"
              className="h-9 rounded-md border bg-background px-2 text-sm"
              value={who}
              onChange={(e) => {
                setWho(e.target.value)
              }}
            >
              {options.map((p) => (
                <option key={p.person_id} value={p.person_id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meet-subject">{t('secretary.meet.subject')}</Label>
          <Input
            id="meet-subject"
            data-testid="meet-subject"
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meet-day">{t('secretary.meet.day')}</Label>
          <Input
            id="meet-day"
            data-testid="meet-day"
            type="date"
            value={day}
            onChange={(e) => {
              setDay(e.target.value)
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meet-time">{t('secretary.meet.time')}</Label>
          <Input
            id="meet-time"
            data-testid="meet-time"
            type="time"
            value={time}
            onChange={(e) => {
              setTime(e.target.value)
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="meet-duration">{t('secretary.meet.duration')}</Label>
          <Input
            id="meet-duration"
            data-testid="meet-duration"
            type="number"
            value={minutes}
            onChange={(e) => {
              setMinutes(e.target.value)
            }}
          />
        </div>
      </div>

      <div>
        <Button size="sm" data-testid="meet-submit" disabled={send.isPending} onClick={submit}>
          {t('secretary.meet.submit')}
        </Button>
      </div>

      {sent === null ? null : (
        <p className="text-muted-foreground text-xs" data-testid="meet-sent">
          {t('secretary.meet.sent')}
        </p>
      )}

      {conflict === null ? null : (
        <div className="flex flex-col gap-2" data-testid="meet-conflict">
          <p role="alert" className="text-destructive text-sm">
            {t('secretary.meet.conflict')}：{conflict}
          </p>
          {alternatives.length === 0 ? null : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-xs">{t('secretary.meet.try')}</span>
              {alternatives.map((slot) => (
                <Button
                  key={slot.start}
                  size="xs"
                  variant="secondary"
                  data-testid="meet-alternative"
                  onClick={() => {
                    setDay(localDay(slot.start))
                    setTime(localTime(slot.start))
                    setConflict(null)
                    setAlternatives([])
                  }}
                >
                  {localDay(slot.start)} {localTime(slot.start)}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
