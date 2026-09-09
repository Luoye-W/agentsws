/**
 * 分配向导（36 §3 的口吻）：选人 → 选岗位 → 选范围 → 确认。
 *
 * 三条：
 * - 一屏一件事，三步都在同一张卡里，做完哪一步下一步才亮；
 * - 说的是人话："管哪几个店"，不是 `ranges: [{kind:'store'}]`；
 * - 确认那一句把结果先说清楚："李默 会拿到 独立站售后客服，管 store_main。"
 */
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { OrgMemberView, OrgPositionView, RangeOption } from '@/lib/api'
import { useApp } from '@/lib/app-context'
import { cn } from '@/lib/utils'

export interface AssignChoice {
  person_id: string
  position_id: string
  ranges: { kind: string; id: string }[]
}

export function AssignWizard({
  members,
  positions,
  rangeOptions,
  presetPosition,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  members: OrgMemberView[]
  positions: OrgPositionView[]
  rangeOptions: RangeOption[]
  presetPosition?: string
  busy: boolean
  error?: string
  onCancel(): void
  onConfirm(choice: AssignChoice): void
}): React.ReactNode {
  const { t } = useApp()
  const [person, setPerson] = useState<string | null>(null)
  const [position, setPosition] = useState<string | null>(presetPosition ?? null)
  const [picked, setPicked] = useState<string[]>([])
  const [extra, setExtra] = useState('')

  const active = members.filter((m) => m.left_at === undefined)
  const chosenPerson = active.find((m) => m.person_id === person)
  const chosenPosition = positions.find((p) => p.id === position)
  const options: RangeOption[] = [
    ...rangeOptions,
    ...(extra.trim() === ''
      ? []
      : [{ kind: 'store' as const, id: extra.trim(), label: extra.trim() }]),
  ]
  const ranges = options
    .filter((o) => picked.includes(`${o.kind}:${o.id}`))
    .map((o) => ({ kind: o.kind, id: o.id }))

  const toggle = (key: string): void => {
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    )
  }

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="assign-wizard">
      <section className="flex flex-col gap-2">
        <p className="font-medium">{t('org.assign.step1')}</p>
        <div className="flex flex-wrap gap-2">
          {active.map((m) => (
            <button
              key={m.person_id}
              type="button"
              data-testid="assign-person"
              className={cn(
                'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                person === m.person_id && 'border-primary bg-primary/10',
              )}
              onClick={() => {
                setPerson(m.person_id)
              }}
            >
              {m.name}
            </button>
          ))}
          {active.length === 0 ? (
            <p className="text-muted-foreground">{t('org.members.empty')}</p>
          ) : null}
        </div>
      </section>

      <section className={cn('flex flex-col gap-2', person === null && 'opacity-40')}>
        <p className="font-medium">{t('org.assign.step2')}</p>
        <div className="flex flex-wrap gap-2">
          {positions.map((p) => (
            <button
              key={p.id}
              type="button"
              disabled={person === null}
              data-testid="assign-position"
              className={cn(
                'rounded-md border px-2 py-1 text-left transition-colors hover:bg-muted',
                position === p.id && 'border-primary bg-primary/10',
              )}
              onClick={() => {
                setPosition(p.id)
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      </section>

      <section className={cn('flex flex-col gap-2', position === null && 'opacity-40')}>
        <p className="font-medium">{t('org.assign.step3')}</p>
        <p className="text-xs text-muted-foreground">{t('org.assign.step3.hint')}</p>
        <div className="flex flex-wrap gap-2">
          {options.map((o) => {
            const key = `${o.kind}:${o.id}`
            return (
              <button
                key={key}
                type="button"
                disabled={position === null}
                data-testid="assign-range"
                className={cn(
                  'rounded-md border px-2 py-1 transition-colors hover:bg-muted',
                  picked.includes(key) && 'border-primary bg-primary/10',
                )}
                onClick={() => {
                  toggle(key)
                }}
              >
                {o.label}
              </button>
            )
          })}
        </div>
        <div className="flex items-end gap-2">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="assign-extra-range" className="text-xs text-muted-foreground">
              {t('org.assign.range.add')}
            </Label>
            <Input
              id="assign-extra-range"
              value={extra}
              placeholder="store_main"
              onChange={(e) => {
                setExtra(e.target.value)
              }}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={extra.trim() === ''}
            onClick={() => {
              toggle(`store:${extra.trim()}`)
            }}
          >
            {t('org.assign.range.use')}
          </Button>
        </div>
      </section>

      {chosenPerson === undefined || chosenPosition === undefined ? null : (
        <p className="rounded-md border bg-muted/40 p-2" data-testid="assign-summary">
          {t('org.assign.summary', {
            person: chosenPerson.name,
            position: chosenPosition.name,
            ranges:
              ranges.length === 0 ? t('org.assign.range.none') : ranges.map((r) => r.id).join('、'),
          })}
        </p>
      )}
      {error === undefined ? null : (
        <p role="alert" className="text-destructive" data-testid="assign-error">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          {t('org.cancel')}
        </Button>
        <Button
          size="sm"
          data-testid="assign-confirm"
          disabled={person === null || position === null || busy}
          onClick={() => {
            if (person === null || position === null) return
            onConfirm({ person_id: person, position_id: position, ranges })
          }}
        >
          {t('org.assign.confirm')}
        </Button>
      </div>
    </div>
  )
}
